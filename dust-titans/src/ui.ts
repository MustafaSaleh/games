import type { CharacterView } from '@engine/render/character';
import { settings, updateSettings, isTouchDevice } from '@engine/core/settings';
import { load, save } from '@engine/core/storage';
import { MECH_SPEC } from './units/mech';
import { TANK_SPEC } from './units/tank';
import { SCOUT_SPEC } from './units/scout';
import { LIVERIES, UPGRADES, liveryById, unitKind, type UnitKind, type UnitSpec, type UpgradeId, type Upgrades } from './units/unit';
import * as THREE from 'three';
import { EMOTES, HOST_ID, MODES, type Mode, type Room, type Side } from './net/room';
import { ARENAS, arenaById } from './arena';
import { SPECIALS, SPECIAL_IDS, specialId, type SpecialId } from './specials';

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const hex = (n: number) => '#' + n.toString(16).padStart(6, '0');
export const SIDE_COLORS: Record<Side, string> = { blue: '#4fb3ff', red: '#ff5a4f' };

/** one row of the multiplayer results */
export interface ResultRow {
  name: string;
  me: boolean;
  score: number;
  ko: number;
  side?: Side;
}

export interface Loadout {
  unit: UnitKind;
  livery: string;
  special: SpecialId;
}

export const SPECS: Record<UnitKind, UnitSpec> = { tank: TANK_SPEC, mech: MECH_SPEC, scout: SCOUT_SPEC };

export function loadUpgrades(): Upgrades {
  const u = load<Partial<Upgrades>>('titans.upgrades', {});
  const c = (v: unknown) => Math.max(0, Math.min(3, Math.floor(Number(v) || 0)));
  return { armour: c(u.armour), reload: c(u.reload), energy: c(u.energy) };
}

export function loadLoadout(): Loadout {
  const l = load<Partial<Loadout>>('titans.loadout', {});
  return { unit: unitKind(l.unit), livery: liveryById(l.livery ?? '').id, special: specialId(l.special) };
}

/** Battle HUD: health, cannon reload, wave + score, buttons, banners, damage flash. */
export class BattleHud {
  readonly root: HTMLDivElement;
  private el: Record<string, HTMLElement> = {};
  private cache: Record<string, string> = {};
  onPause = () => {};
  onCamera = () => {};
  onMusic = () => {};

  constructor(parent: HTMLElement) {
    const r = (this.root = document.createElement('div'));
    r.className = 'tt-hud';
    r.innerHTML = `
      <div class="tt-hp">
        <div class="tt-hp-label">ARMOUR</div>
        <div class="tt-bar"><b data-k="hp"></b></div>
        <div class="tt-bar small"><b data-k="reload"></b></div>
        <div class="tt-bar small energy"><b data-k="energy"></b></div>
        <div class="tt-powers" data-k="powers"></div>
      </div>
      <div class="tt-boss" data-k="boss" hidden><span data-k="bossName">GIANT ROBOT</span><div class="tt-bar"><b data-k="bossHp"></b></div></div>
      <div class="tt-wave"><div data-k="wave">WAVE 1</div><small data-k="score">0</small></div>
      <div class="tt-buttons">
        <button class="icon-btn" data-k="pause" aria-label="Pause">❚❚</button>
        <button class="icon-btn" data-k="cam" aria-label="Camera" title="Camera (C)">🎥</button>
        <button class="icon-btn" data-k="music" aria-label="Music" title="Music (M)">🎵</button>
      </div>
      <div class="tt-special" data-k="special"><span data-k="specialIcon">🚀</span><small>Q</small></div>
      <div class="tt-splat" data-k="splat"></div>
      <div class="tt-board" data-k="board"></div>
      <div class="tt-banner" data-k="banner"></div>
      <div class="tt-emotes" data-k="emotes">${EMOTES.map((e, i) => `<button data-emote="${i}">${e}</button>`).join('')}</div>
      <div class="tt-hurt" data-k="hurt"></div>`;
    parent.appendChild(r);
    r.querySelectorAll<HTMLElement>('[data-k]').forEach((e) => (this.el[e.dataset.k!] = e));
    this.el.pause.addEventListener('click', () => this.onPause());
    this.el.cam.addEventListener('click', () => this.onCamera());
    this.el.music.addEventListener('click', () => this.onMusic());
    this.el.emotes.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-emote]');
      if (b) this.onEmote(+b.dataset.emote!);
    });
    this.el.special.addEventListener('click', () => this.onSpecial());
    if (isTouchDevice()) this.el.special.style.display = 'none'; // the touch SPECIAL button instead
    this.online(false);
  }

  onSpecial = () => {};

  /** special weapon icon + charge 0..1 */
  special(icon: string, charge: number): void {
    this.set('specialIcon', icon);
    const c = String(Math.round(charge * 50) / 50);
    if (this.cache.charge === c) return;
    this.cache.charge = c;
    this.el.special.style.setProperty('--charge', c);
    this.el.special.classList.toggle('ready', charge >= 1);
  }

  /** tomato in the face! */
  splat(): void {
    const s = this.el.splat;
    s.classList.remove('on');
    void s.offsetWidth;
    s.classList.add('on');
  }

  onEmote = (_i: number) => {};

  /** emoji bar + scoreboard only online */
  online(on: boolean): void {
    this.el.emotes.style.display = on ? '' : 'none';
    this.el.board.style.display = on ? '' : 'none';
  }

  /** scoreboard rows (already sorted) */
  board(html: string): void {
    if (this.cache.board === html) return;
    this.cache.board = html;
    this.el.board.innerHTML = html;
  }

  set(key: string, text: string): void {
    if (this.cache[key] === text) return;
    this.cache[key] = text;
    this.el[key].textContent = text;
  }

  bar(key: 'hp' | 'reload' | 'energy' | 'bossHp', frac: number): void {
    const w = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
    if (this.cache[key] === w) return;
    this.cache[key] = w;
    this.el[key].style.width = w;
    if (key === 'hp') this.el.hp.classList.toggle('low', frac < 0.3);
  }

  boss(on: boolean): void {
    if (this.cache.bossOn === String(on)) return;
    this.cache.bossOn = String(on);
    this.el.boss.hidden = !on;
  }

  hurt(): void {
    const h = this.el.hurt;
    h.classList.remove('on');
    void h.offsetWidth;
    h.classList.add('on');
  }

  show(on: boolean): void {
    this.root.style.display = on ? '' : 'none';
  }
}

export interface MenuHandlers {
  play(): void;
  createRoom(name: string): void;
  joinRoom(code: string, name: string): void;
  leaveRoom(): void;
  startRoom(): void;
  setMode(m: Mode): void;
  setSide(s: Side): void;
  toRoom(): void;
  pickArena(id: string): void;
  emote(i: number): void;
  loadoutChanged(l: Loadout): void;
  resume(): void;
  quit(): void;
  unlock(): void;
  settingsChanged(): void;
}

/** Title / pause / game-over screens, with Mody next to them. */
export class TitansMenu {
  readonly root: HTMLDivElement;
  private body: HTMLDivElement;
  private hero: HTMLDivElement;
  private character: CharacterView | null = null;
  current = '';
  result = { wave: 1, score: 0, best: 0, record: false, coins: 0 };
  coins = Math.max(0, Math.floor(load<number>('titans.coins', 0)));
  ups: Upgrades = loadUpgrades();
  loadout: Loadout = loadLoadout();
  /** online */
  room: Room | null = null;
  netBusy = '';
  netError = '';
  codeHint = '';
  shareUrl = '';
  mpResult: { title: string; sub: string; rows: ResultRow[]; teams?: { blue: number; red: number }; coins?: number } | null = null;
  private keep: Record<string, string> = {};
  /** solo battlefield */
  arena = load<string>('titans.arena', 'desert-bowl');

  constructor(
    parent: HTMLElement,
    private h: MenuHandlers,
  ) {
    const r = (this.root = document.createElement('div'));
    r.className = 'menu';
    this.hero = document.createElement('div');
    this.hero.className = 'hero';
    this.hero.innerHTML = `<div class="hero-tag"><b>MODY</b><span>#08</span></div>`;
    this.body = document.createElement('div');
    this.body.className = 'menu-body';
    r.append(this.hero, this.body);
    parent.appendChild(r);
    r.addEventListener('click', (e) => this.onClick(e));
    r.addEventListener('change', (e) => this.onChange(e));
    r.addEventListener('pointerdown', () => this.h.unlock(), { capture: true });
    this.hero.addEventListener('click', () => this.character?.play(Math.random() < 0.5 ? 'wave' : 'cheer'));
    void import('@engine/render/character').then(({ CharacterView }) => {
      this.character = new CharacterView(this.hero);
      this.character.setMode('results'); // standing (no car: he'll pilot a tank)
      this.syncHero();
    });
  }

  get visible(): boolean {
    return this.root.style.display !== 'none';
  }

  show(screen: string): void {
    this.current = screen;
    this.root.style.display = '';
    this.render();
  }

  hide(): void {
    this.root.style.display = 'none';
    this.current = '';
    this.syncHero();
  }

  private syncHero(): void {
    const on = this.visible && (this.current === 'main' || this.current === 'over');
    this.root.classList.toggle('tt-garage-open', this.visible && this.current === 'garage');
    this.root.classList.toggle('with-hero', on);
    this.character?.setActive(on);
    if (on && this.current === 'over') this.character?.play(this.result.record ? 'cheer' : 'wave');
  }

  private render(): void {
    const s = this.current;
    let html = '';
    if (s === 'main') {
      html = `<div class="logo"><span>DUST</span> TITANS</div>
        <div class="tagline">Tanks & robot suits · defend the arena · co-op and battles</div>
        <div class="btn-col">
          <button class="btn primary" data-act="play">▶ Play: ${arenaById(this.arena).name}<small>Survive the waves · Giant Robot every 5th wave</small></button>
          <button class="btn" data-act="arenas">🗺️ Battlefield<small>${arenaById(this.arena).icon} ${arenaById(this.arena).name}</small></button>
          <button class="btn" data-act="online">👥 Play with friends<small>Co-op, arena and alliance battles online</small></button>
          <button class="btn" data-act="garage">🛠️ Garage<small>${SPECS[this.loadout.unit].name} · ${liveryById(this.loadout.livery).name}</small></button>
          <button class="btn" data-act="how">How to play</button>
          <button class="btn ghost" data-act="settings">Settings</button>
          <a class="btn ghost" href="../dust-rally/">🏁 Dust Rally</a>
        </div>
        <div class="hint">Preview · city maps coming</div>`;
    } else if (s === 'how') {
      const touch = isTouchDevice();
      html = `<h2>How to play</h2>
        <div class="keys-help tt-how">
          ${
            touch
              ? `<div>👈 Left thumb: drive</div><div>👉 Right thumb: aim + fire</div>`
              : `<div><kbd>W A S D</kbd> move</div><div>🖱️ Mouse aims · click / <kbd>F</kbd> fires</div><div><kbd>Space</kbd> jump-jets (robot)</div><div><kbd>Shift</kbd> dash / turbo</div><div><kbd>C</kbd> camera · <kbd>M</kbd> music</div><div>🎮 Sticks move + aim · RT fire · A jump · B dash</div>`
          }
        </div>
        <p class="muted small">🛸 Drones glow pink before they shoot. 🤖 Walkers' visors turn red before a laser burst. 🟢 Jelly aliens hop at you: keep moving! Every 5th wave a <b>Giant Robot</b> comes: shoot its glowing knees, then its chest core. Jump over (robot suit) or outrun its stomp rings.</p>
        <p class="muted small">Crates: 🔧 green repair · 🛡️ blue shield · ⚡ yellow rapid fire · 🔱 orange triple shot.</p>
        <div class="btn-row"><button class="btn primary" data-act="back">Got it</button></div>`;
    } else if (s === 'settings') {
      const chk = (k: 'sound' | 'music', label: string) => `<label>${label} <input type="checkbox" data-set="${k}" ${settings[k] ? 'checked' : ''}></label>`;
      html = `<h2>Settings</h2><div class="settings">
          ${chk('sound', 'Sound')}
          ${chk('music', 'Music')}
          <label>Camera <select data-set="cameraView"><option value="top" ${settings.cameraView === 'top' ? 'selected' : ''}>Top-down</option><option value="chase" ${settings.cameraView === 'chase' ? 'selected' : ''}>Chase (3rd person)</option></select></label>
          <label>Quality <select data-set="quality">${['auto', 'low', 'medium', 'high'].map((q) => `<option value="${q}" ${settings.quality === q ? 'selected' : ''}>${q[0].toUpperCase() + q.slice(1)}</option>`).join('')}</select></label>
        </div>
        <p class="muted small">Shared with Dust Rally.</p>
        <div class="btn-row"><button class="btn primary" data-act="back">Done</button></div>`;
    } else if (s === 'garage') {
      const l = this.loadout;
      const bar = (label: string, v: number) => `<div class="tt-stat"><span>${label}</span><i><em style="width:${Math.round(v * 100)}%"></em></i></div>`;
      const card = (sp: UnitSpec) => `<button class="tt-unit ${l.unit === sp.kind ? 'sel' : ''}" data-unit="${sp.kind}">
          <b>${sp.icon} ${sp.name}</b><small>${sp.blurb}</small>
          ${bar('Armour', sp.bars.armour)}${bar('Speed', sp.bars.speed)}${bar('Firepower', sp.bars.firepower)}${bar('Agility', sp.bars.agility)}
          <div class="tt-ability">${sp.ability}</div></button>`;
      html = `<h2>Garage</h2>
        <div class="tt-units">${card(TANK_SPEC)}${card(MECH_SPEC)}${card(SCOUT_SPEC)}</div>
        <div class="muted small">Special weapon (Q)</div>
        <div class="tt-specials">${SPECIAL_IDS.map((id) => `<button class="tt-spec ${l.special === id ? 'sel' : ''}" data-special="${id}" title="${SPECIALS[id].blurb}">${SPECIALS[id].icon} ${SPECIALS[id].name}</button>`).join('')}</div>
        <div class="muted small tt-spec-blurb">${SPECIALS[l.special].blurb}</div>
        <div class="tt-upgrades"><div class="tt-coins">🪙 ${this.coins} coins</div>
          ${(Object.keys(UPGRADES) as UpgradeId[])
            .map((id) => {
              const u = UPGRADES[id],
                lv = this.ups[id],
                cost = u.costs[lv];
              return `<div class="tt-up"><span>${u.icon}</span><div><b>${u.name}</b> <i>${'●'.repeat(lv)}${'○'.repeat(3 - lv)}</i><small>${u.per}</small></div>${
                lv >= 3 ? '<em>MAX</em>' : `<button class="btn tiny" data-buy="${id}" ${this.coins >= cost ? '' : 'disabled'}>🪙 ${cost}</button>`
              }</div>`;
            })
            .join('')}
          <small class="muted">Earn coins in every battle. Upgrades work for both units.</small></div>
        <div class="muted small">Colours</div>
        <div class="tt-liveries">${LIVERIES.map((v) => `<button class="tt-livery ${v.id === l.livery ? 'sel' : ''}" data-livery="${v.id}" title="${v.name}" style="background:linear-gradient(135deg,#${v.body.toString(16).padStart(6, '0')} 55%,#${v.stripe.toString(16).padStart(6, '0')} 55%)"></button>`).join('')}</div>
        <div class="btn-row"><button class="btn primary" data-act="back">Done</button></div>`;
    } else if (s === 'arenas') {
      html = `<h2>Choose a battlefield</h2><div class="tt-arenas">${ARENAS.map((a) => `<button class="tt-arena ${a.id === this.arena ? 'sel' : ''}" data-arena="${a.id}"><span>${a.icon}</span><b>${a.name}</b><small>${a.description}</small></button>`).join('')}</div>
        <div class="btn-row"><button class="btn primary" data-act="back">Done</button></div>`;
    } else if (s === 'online') {
      const name = esc(this.keep['tt-name'] ?? load<string>('mp.name', ''));
      const code = esc(this.keep['tt-code'] ?? this.codeHint);
      html = `<h2>Play with friends</h2>
        <label class="tt-field">Your name <input id="tt-name" maxlength="12" value="${name}" placeholder="Mody" autocomplete="off"></label>
        <div class="btn-col">
          <button class="btn primary" data-act="create" ${this.netBusy ? 'disabled' : ''}>Create a room<small>Then share the code with friends</small></button>
        </div>
        <div class="tt-join"><input id="tt-code" maxlength="10" value="${code}" placeholder="ROOM CODE" autocomplete="off" autocapitalize="characters"><button class="btn" data-act="join" ${this.netBusy ? 'disabled' : ''}>Join</button></div>
        ${this.netBusy ? `<p class="tt-busy">${esc(this.netBusy)}</p>` : ''}
        ${this.netError ? `<p class="tt-error">${esc(this.netError)}</p>` : ''}
        <p class="muted small">Up to 4 players. No chat: just names and emojis.</p>
        <div class="btn-row"><button class="btn ghost" data-act="back">Back</button></div>`;
    } else if (s === 'room' && this.room) {
      const r = this.room;
      const host = r.isHost;
      const mode = MODES[r.mode];
      const rows = r.players
        .slice()
        .sort((a, b) => a.slot - b.slot)
        .map((p) => {
          const lv = liveryById(p.livery);
          const side = r.mode === 'alliance' ? `<i class="tt-side" style="background:${SIDE_COLORS[p.side]}"></i>` : '';
          return `<div class="tt-prow ${p.id === r.myId ? 'me' : ''}">${side}<span class="tt-chip" style="background:linear-gradient(135deg,${hex(lv.body)} 55%,${hex(lv.stripe)} 55%)"></span><b>${esc(p.name)}</b><span>${SPECS[unitKind(p.unit)].icon} ${SPECS[unitKind(p.unit)].name}</span>${p.id === HOST_ID ? '<em>host</em>' : ''}</div>`;
        })
        .join('');
      const modes = (Object.keys(MODES) as Mode[])
        .map((m) => `<button class="tt-mode ${r.mode === m ? 'sel' : ''}" data-mode="${m}" ${host ? '' : 'disabled'}><b>${MODES[m].name}</b><small>${MODES[m].blurb}</small></button>`)
        .join('');
      const me = r.me;
      const sides =
        r.mode === 'alliance' && me
          ? `<div class="tt-sides">${(['blue', 'red'] as Side[]).map((sd) => `<button class="btn ${me.side === sd ? 'primary' : 'ghost'}" data-side="${sd}" style="border-color:${SIDE_COLORS[sd]}">${sd === 'blue' ? '🔵 Blue team' : '🔴 Red team'}</button>`).join('')}</div>`
          : '';
      const enough = r.players.length >= mode.min;
      html = `<h2>Room <span class="tt-code">${esc(r.code)}</span></h2>
        <div class="tt-share"><button class="btn tiny" data-act="share">📤 Share invite</button>${host && !r.serverOnline ? '<span class="tt-error">Reconnecting to the room server…</span>' : ''}</div>
        <div class="tt-players">${rows}</div>
        <div class="tt-modes">${modes}</div>
        <label class="tt-field tt-arena-pick">Battlefield ${host ? `<select data-arena-select>${ARENAS.map((a) => `<option value="${a.id}" ${a.id === r.arena ? 'selected' : ''}>${a.icon} ${a.name}</option>`).join('')}</select>` : `<b>${arenaById(r.arena).icon} ${esc(arenaById(r.arena).name)}</b>`}</label>
        ${sides}
        <div class="tt-emote-row">${EMOTES.map((e, i) => `<button data-emote="${i}">${e}</button>`).join('')}</div>
        <div class="btn-col">
          ${host ? `<button class="btn primary" data-act="start" ${enough ? '' : 'disabled'}>▶ Start${enough ? '' : `<small>Needs ${mode.min} players</small>`}</button>` : `<div class="tt-wait">Waiting for the host to start…</div>`}
          <button class="btn" data-act="garage">🛠️ My unit<small>${SPECS[this.loadout.unit].name} · ${liveryById(this.loadout.livery).name}</small></button>
          <button class="btn ghost" data-act="leave">Leave room</button>
        </div>
        ${host ? '<p class="muted small">Keep the game open on screen while friends join.</p>' : ''}`;
    } else if (s === 'mpover' && this.mpResult) {
      const R = this.mpResult;
      const rows = R.rows
        .map((x, i) => `<div class="tt-prow ${x.me ? 'me' : ''}">${x.side ? `<i class="tt-side" style="background:${SIDE_COLORS[x.side]}"></i>` : `<span class="tt-rank">${i + 1}</span>`}<b>${esc(x.name)}</b><span>💥 ${x.ko} · ⭐ ${x.score}</span></div>`)
        .join('');
      html = `<h2 class="record">${esc(R.title)}</h2>
        <div class="result-line">${esc(R.sub)}</div>
        ${R.coins ? `<div class="tt-earned">+${R.coins} 🪙</div>` : ''}
        ${R.teams ? `<div class="tt-teams"><span style="color:${SIDE_COLORS.blue}">Blue ${R.teams.blue}</span> · <span style="color:${SIDE_COLORS.red}">Red ${R.teams.red}</span></div>` : ''}
        <div class="tt-players">${rows}</div>
        <div class="btn-col">
          <button class="btn primary" data-act="toroom">Back to the room</button>
          <button class="btn ghost" data-act="leave">Leave room</button>
        </div>`;
    } else if (s === 'pause') {
      html = `<h2>Paused</h2><div class="btn-col">
        <button class="btn primary" data-act="resume">Resume</button>
        <button class="btn ghost" data-act="${this.room ? 'leave' : 'quit'}">${this.room ? 'Leave room' : 'Quit to menu'}</button></div>
        ${this.room ? '<p class="muted small">Online: the battle keeps going while this menu is open.</p>' : ''}`;
    } else if (s === 'over') {
      const r = this.result;
      html = `<h2 class="${r.record ? 'record' : ''}">${r.record ? 'New best! 🏆' : 'Knocked out!'}</h2>
        <div class="result-big">${r.score}</div>
        <div class="result-line">You reached wave ${r.wave}</div>
        <div class="result-line">Best ${Math.max(r.best, r.score)}</div>
        ${r.coins ? `<div class="tt-earned">+${r.coins} 🪙</div>` : ''}
        <div class="btn-col">
          <button class="btn primary" data-act="play">Play again</button>
          <button class="btn ghost" data-act="quit">Menu</button>
        </div>`;
    }
    this.body.innerHTML = `<div class="panel panel-${s}">${html}</div>`;
    this.syncHero();
  }

  private onClick(e: Event): void {
    const buy = (e.target as HTMLElement).closest<HTMLElement>('[data-buy]');
    if (buy) {
      const id = buy.dataset.buy as UpgradeId;
      const cost = UPGRADES[id]?.costs[this.ups[id]];
      if (cost != null && this.coins >= cost) {
        this.coins -= cost;
        this.ups[id]++;
        save('titans.coins', this.coins);
        save('titans.upgrades', this.ups);
      }
      return this.render();
    }
    const em = (e.target as HTMLElement).closest<HTMLElement>('[data-emote]');
    if (em) return this.h.emote(+em.dataset.emote!);
    const ar = (e.target as HTMLElement).closest<HTMLElement>('[data-arena]');
    if (ar) {
      this.arena = ar.dataset.arena!;
      this.h.pickArena(this.arena);
      return this.render();
    }
    const md = (e.target as HTMLElement).closest<HTMLElement>('[data-mode]');
    if (md) return this.h.setMode(md.dataset.mode as Mode);
    const sd = (e.target as HTMLElement).closest<HTMLElement>('[data-side]');
    if (sd) return this.h.setSide(sd.dataset.side as Side);
    const u = (e.target as HTMLElement).closest<HTMLElement>('[data-unit],[data-livery],[data-special]');
    if (u) {
      if (u.dataset.special) this.loadout.special = specialId(u.dataset.special);
      if (u.dataset.unit) this.loadout.unit = u.dataset.unit as UnitKind;
      if (u.dataset.livery) this.loadout.livery = u.dataset.livery;
      save('titans.loadout', this.loadout);
      this.h.loadoutChanged(this.loadout);
      this.render();
      return;
    }
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!t) return;
    const act = t.dataset.act!;
    if (act === 'play') this.h.play();
    else if (act === 'resume') this.h.resume();
    else if (act === 'quit') this.h.quit();
    else if (act === 'back') this.show(this.room ? 'room' : 'main');
    else if (act === 'online') {
      this.netError = '';
      this.show('online');
    } else if (act === 'create' || act === 'join') {
      const name = (this.root.querySelector('#tt-name') as HTMLInputElement | null)?.value ?? '';
      const code = (this.root.querySelector('#tt-code') as HTMLInputElement | null)?.value ?? '';
      if (act === 'join' && !code.trim()) {
        this.netError = 'Type the room code your friend shared.';
        this.refresh();
      } else if (act === 'create') this.h.createRoom(name);
      else this.h.joinRoom(code, name);
    } else if (act === 'leave') this.h.leaveRoom();
    else if (act === 'start') this.h.startRoom();
    else if (act === 'toroom') this.h.toRoom();
    else if (act === 'share') this.share();
    else if (act === 'how' || act === 'settings' || act === 'garage' || act === 'arenas') this.show(act);
  }

  /** add coins earned in a battle; returns them */
  earn(n: number): number {
    n = Math.max(0, Math.floor(n));
    this.coins += n;
    save('titans.coins', this.coins);
    return n;
  }

  /** re-render the current screen, keeping what was typed */
  refresh(): void {
    for (const id of ['tt-name', 'tt-code']) {
      const el = this.root.querySelector('#' + id) as HTMLInputElement | null;
      if (el) this.keep[id] = el.value;
    }
    if (this.visible && this.current) this.render();
  }

  private share(): void {
    const r = this.room;
    if (!r) return;
    const text = `Battle with me in Dust Titans! Room code ${r.code}`;
    const nav = navigator as Navigator & { share?: (d: { title: string; text: string; url: string }) => Promise<void> };
    if (isTouchDevice() && nav.share) void nav.share({ title: 'Dust Titans', text, url: this.shareUrl }).catch(() => {});
    else void navigator.clipboard?.writeText(`${text}: ${this.shareUrl}`).then(() => this.flashHint('Link copied!'));
  }

  private flashHint(t: string): void {
    const b = this.root.querySelector('[data-act=share]');
    if (b) b.textContent = t;
  }

  private onChange(e: Event): void {
    const el = e.target as HTMLInputElement | HTMLSelectElement;
    if (el.dataset?.arenaSelect !== undefined) return this.h.pickArena(el.value);
    const key = el.dataset?.set;
    if (!key) return;
    const v = el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : el.value;
    updateSettings({ [key]: v } as never);
    this.h.settingsChanged();
  }
}

/** Name tags (and emoji pop-ups) above the other players. */
export class Tags {
  readonly root = document.createElement('div');
  private tags = new Map<string, { el: HTMLDivElement; emo: HTMLSpanElement; emoT: number }>();
  private v = new THREE.Vector3();

  constructor(parent: HTMLElement) {
    this.root.className = 'tt-tags';
    parent.appendChild(this.root);
  }

  private get(id: string, name: string, color: string) {
    let t = this.tags.get(id);
    if (!t) {
      const el = document.createElement('div');
      el.className = 'tt-tag';
      const n = document.createElement('b');
      const emo = document.createElement('span');
      emo.className = 'tt-tag-emo';
      el.append(emo, n);
      this.root.appendChild(el);
      t = { el, emo, emoT: 0 };
      this.tags.set(id, t);
    }
    const b = t.el.querySelector('b')!;
    if (b.textContent !== name) b.textContent = name;
    if (t.el.style.borderColor !== color) t.el.style.borderColor = color;
    return t;
  }

  emote(id: string, e: string): void {
    const t = this.tags.get(id);
    if (!t) return;
    t.emo.textContent = e;
    t.emoT = 2.5;
    t.emo.classList.remove('pop');
    void t.emo.offsetWidth;
    t.emo.classList.add('pop');
  }

  /** place every tag; `items` = players to label this frame */
  update(cam: THREE.Camera, dt: number, items: { id: string; name: string; color: string; x: number; y: number; z: number; visible: boolean; showName: boolean }[]): void {
    const seen = new Set<string>();
    const w = window.innerWidth,
      h = window.innerHeight;
    for (const it of items) {
      const t = this.get(it.id, it.name, it.color);
      seen.add(it.id);
      t.emoT = Math.max(0, t.emoT - dt);
      if (t.emoT <= 0 && t.emo.textContent) t.emo.textContent = '';
      this.v.set(it.x, it.y, it.z).project(cam);
      const on = it.visible && this.v.z < 1 && Math.abs(this.v.x) < 1.2 && Math.abs(this.v.y) < 1.2 && (it.showName || t.emoT > 0);
      t.el.style.display = on ? '' : 'none';
      t.el.classList.toggle('noname', !it.showName);
      if (on) t.el.style.transform = `translate(${((this.v.x + 1) / 2) * w}px, ${((1 - this.v.y) / 2) * h}px) translate(-50%, -100%)`;
    }
    for (const [id, t] of this.tags)
      if (!seen.has(id)) {
        t.el.remove();
        this.tags.delete(id);
      }
  }

  clear(): void {
    for (const t of this.tags.values()) t.el.remove();
    this.tags.clear();
  }
}
