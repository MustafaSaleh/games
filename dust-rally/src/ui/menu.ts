import { settings, updateSettings, type Settings } from '../core/settings';
import { parseSeed, seedToString } from '../core/rng';
import type { StageDef } from '../world/stage';
import { fmtTime } from './hud';
import type { CharacterView, Gesture } from '../render/character';
import { CAR_LIVERIES, CAR_STYLES, getLivery, getStyle } from '../config/cars';
import { load } from '../core/storage';
import { isTouchDevice } from '../core/settings';
import { BUILD, EMOTES } from '../net/session';
import { TRACKS } from '../core/music';

export interface MenuHandlers {
  startStage(def: StageDef): void;
  startEndless(seed: number | null): void;
  startDaily(): void;
  resume(): void;
  restart(): void;
  quit(): void;
  next(): void;
  enableTilt(): Promise<boolean>;
  settingsChanged(s: Settings): void;
  unlockAudio(): void;
  toggleMusic(): void;
  startSplit(def: StageDef): void;
  createRoom(name: string): void;
  joinRoom(code: string, name: string): void;
  leaveRoom(): void;
  hostStage(stageId: string): void;
  hostStart(): void;
  toLobby(): void;
  emote(i: number): void;
}

/** one row of the multiplayer results table */
export interface Standing {
  /** player id (online), for emojis */
  id?: string;
  name: string;
  color: string;
  time: number | null;
  status: string;
  me: boolean;
  progress: number;
}

/** what the lobby screen shows (provided by the game while in a room) */
export interface LobbyInfo {
  code: string;
  isHost: boolean;
  racing: boolean;
  stageId: string;
  shareUrl: string;
  serverOnline: boolean;
  players: { id: string; name: string; color: string; car: string; me: boolean; host: boolean }[];
}

export interface StageInfo {
  def: StageDef;
  best: number | null;
}

export interface ResultInfo {
  title: string;
  big: string;
  lines: string[];
  seed?: number;
  shareUrl?: string;
  record: boolean;
  canNext: boolean;
  /** multiplayer */
  standings?: Standing[];
  online?: boolean;
  /** online guest: the host decides what happens next */
  waiting?: boolean;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** All full-screen menus. Plain DOM + event delegation via data-act. */
export class Menu {
  readonly root: HTMLDivElement;
  /** Mody, the driver character (main menu + results) */
  private hero: HTMLDivElement;
  private body: HTMLDivElement;
  private bubble: HTMLDivElement;
  private character: CharacterView | null = null;
  private heroIntroDone = false;
  private bubbleTimer = 0;
  private stack: string[] = [];
  stages: StageInfo[] = [];
  endlessBest = { score: 0, seed: 0 };
  dailyBest = 0;
  dailySeed = 0;
  result: ResultInfo | null = null;
  private returnTo = 'main';
  /* online */
  joinCode = '';
  netError = '';
  netBusy = '';
  mpInfo: () => LobbyInfo | null = () => null;
  /** recent emojis per player id (lobby / results) */
  readonly emotes = new Map<string, { text: string; until: number }>();
  private heroKey = '';

  constructor(
    parent: HTMLElement,
    private h: MenuHandlers,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'menu';
    parent.appendChild(this.root);
    this.hero = document.createElement('div');
    this.hero.className = 'hero';
    this.hero.innerHTML = `<div class="hero-bubble"></div><div class="hero-tag"><b>MODY</b><span>#08</span></div><div class="hero-hint">⟲ drag to spin 360°</div>`;
    this.bubble = this.hero.querySelector('.hero-bubble')!;
    this.body = document.createElement('div');
    this.body.className = 'menu-body';
    this.root.append(this.hero, this.body);
    this.hero.addEventListener('click', () => this.character?.play(Math.random() < 0.6 ? 'wave' : 'cheer'));
    // load three's GLTF bits + the model lazily so the menu appears instantly
    void import('../render/character').then(({ CharacterView }) => {
      this.character = new CharacterView(this.hero);
      this.character.onArrive = () => this.say("Hi! I'm Mody 👋");
      this.syncHero();
    });
    this.root.addEventListener('click', (e) => this.onClick(e));
    this.root.addEventListener('change', (e) => this.onChange(e));
    this.root.addEventListener('input', (e) => this.onChange(e));
    this.root.addEventListener('pointerdown', () => this.h.unlockAudio(), { capture: true });
  }

  show(screen: string, push = false): void {
    if (push && this.stack[this.stack.length - 1] !== screen) this.stack.push(screen);
    else this.stack = [screen];
    this.root.style.display = '';
    this.render();
  }

  hide(): void {
    this.root.style.display = 'none';
    this.body.innerHTML = '';
    this.syncHero();
  }

  /** Show a short speech bubble above Mody. */
  say(text: string, ms = 2600): void {
    this.bubble.textContent = text;
    this.bubble.classList.add('on');
    clearTimeout(this.bubbleTimer);
    this.bubbleTimer = window.setTimeout(() => this.bubble.classList.remove('on'), ms);
  }

  private heroScreen(): boolean {
    return this.visible && (this.current === 'main' || this.current === 'results' || this.current === 'garage');
  }

  private syncHero(): void {
    const on = this.heroScreen();
    this.root.classList.toggle('with-hero', on);
    const c = this.character;
    if (!on) this.bubble.classList.remove('on');
    const key = on ? this.current + ':' + (this.current === 'results' ? (this.result?.title ?? '') : '') : '';
    const changed = key !== this.heroKey;
    this.heroKey = key;
    this.root.classList.toggle('garage-mode', on && this.current === 'garage');
    if (!c) return;
    c.setActive(on);
    if (!on) return;
    c.setCar(settings.carStyle, settings.carLivery);
    c.setMode(this.current === 'garage' ? 'garage' : this.current === 'results' ? 'results' : 'home');
    if (!changed || this.current === 'garage') return;
    if (!this.heroIntroDone) {
      this.heroIntroDone = true;
      c.playIntro();
    } else if (this.current === 'results' && this.result) {
      const g: Gesture = this.result.record ? 'cheer' : 'wave';
      c.play(g);
      if (this.result.standings) this.say(this.result.record ? this.result.title : 'Great race! 🏁');
      else this.say(this.result.record ? 'New record! 🏆' : this.result.canNext ? 'Nice drive! 🏁' : "Let's go again! 💪");
    }
  }

  /** re-render the current screen (e.g. lobby or standings changed), keeping typed input */
  refresh(): void {
    if (!this.visible) return;
    const keep = ['mp-name', 'mp-code'].map((id) => [id, (this.root.querySelector('#' + id) as HTMLInputElement | null)?.value] as const);
    this.render();
    for (const [id, v] of keep) {
      const el = this.root.querySelector('#' + id) as HTMLInputElement | null;
      if (el && v != null) el.value = v;
    }
  }

  get visible(): boolean {
    return this.root.style.display !== 'none';
  }

  get current(): string {
    return this.stack[this.stack.length - 1];
  }

  back(): void {
    if (this.stack.length > 1) {
      this.stack.pop();
      this.render();
    } else this.show(this.returnTo);
  }

  private render(): void {
    const s = this.current;
    const html =
      s === 'main'
        ? this.mainHtml()
        : s === 'stages'
          ? this.stagesHtml()
          : s === 'endless'
            ? this.endlessHtml()
            : s === 'settings'
              ? this.settingsHtml()
              : s === 'garage'
                ? this.garageHtml()
              : s === 'multi'
                ? this.multiHtml()
              : s === 'split'
                ? this.splitHtml()
              : s === 'online'
                ? this.onlineHtml()
              : s === 'lobby'
                ? this.lobbyHtml()
              : s === 'pause'
                ? this.pauseHtml()
                : s === 'results'
                  ? this.resultsHtml()
                  : '';
    this.body.innerHTML = `<div class="panel panel-${s}">${html}</div>`;
    if (s === 'main' || s === 'pause') this.returnTo = s;
    this.syncHero();
  }

  private mainHtml(): string {
    return `
      <div class="logo"><span>DUST</span> RALLY</div>
      <div class="tagline">Top-down rally · drift · jump · survive</div>
      <div class="btn-col">
        <button class="btn primary" data-act="stages">Stages</button>
        <button class="btn" data-act="multi">Multiplayer<small>Split-screen · online with friends</small></button>
        <button class="btn" data-act="endless">Endless</button>
        <button class="btn" data-act="daily">Daily Challenge<small>Seed ${seedToString(this.dailySeed)} · Best ${this.dailyBest ? Math.floor(this.dailyBest) + ' m' : '—'}</small></button>
        <button class="btn" data-act="garage">Garage<small>${esc(getStyle(settings.carStyle).name)} · ${esc(getLivery(settings.carLivery).name)}</small></button>
        <button class="btn ghost" data-act="settings">Settings</button>
      </div>
      <div class="btn-row"><button class="btn tiny" data-act="music">${settings.music ? '🎵 Music on' : '🔇 Music off'}</button></div>
      <div class="hint">${'ontouchstart' in window ? 'Left thumb steers · right side: gas / brake / drift' : 'WASD / arrows · Space = handbrake · R = reset · C = camera · Esc = pause · gamepad supported'}</div>`;
  }

  private stagesHtml(): string {
    return `<h2>Stages</h2><div class="cards">${this.stageCards('stage')}</div>
      <div class="btn-row"><button class="btn ghost" data-act="back">Back</button></div>`;
  }

  private stageCards(act: string): string {
    return this.stages
      .map(
        (s, i) => `
      <button class="card biome-${esc(s.def.biome)}" data-act="${act}" data-i="${i}">
        <div class="card-title">${esc(s.def.name)}</div>
        <div class="card-sub">${esc(s.def.biome)} · ${esc(s.def.timeOfDay)}</div>
        <div class="card-desc">${esc(s.def.description ?? '')}</div>
        <div class="card-best">${s.best != null ? 'Best ' + fmtTime(s.best) : 'No time set'}</div>
      </button>`,
      )
      .join('');
  }

  /* ----------------------------- multiplayer ----------------------------- */

  private multiHtml(): string {
    return `<h2>Multiplayer</h2>
      <div class="btn-col">
        <button class="btn primary" data-act="split">Split-screen<small>2 players · one screen · keyboard or 2 gamepads</small></button>
        <button class="btn" data-act="online">Online with friends<small>2–4 players · each on their own device</small></button>
        <button class="btn ghost" data-act="back">Back</button>
      </div>`;
  }

  private splitHtml(): string {
    const touchOnly = isTouchDevice() && !matchMedia('(any-pointer: fine)').matches;
    return `<h2>Split-screen</h2>
      <div class="controls-help">
        <div><b class="p1">P1</b> W A S D · <kbd>Space</kbd> drift · <kbd>R</kbd> reset</div>
        <div><b class="p2">P2</b> Arrow keys · <kbd>Right Shift</kbd> drift · <kbd>Enter</kbd> reset</div>
        <div class="muted small">Gamepads: first pad = P1, second pad = P2.</div>
      </div>
      ${touchOnly ? '<p class="net-error">Split-screen needs a keyboard or two gamepads connected to this device.</p>' : ''}
      <p class="muted small">Pick a stage. First across the finish line wins!</p>
      <div class="cards">${this.stageCards('split-stage')}</div>
      <div class="btn-row"><button class="btn ghost" data-act="back">Back</button></div>`;
  }

  private onlineHtml(): string {
    const name = esc(load<string>('mp.name', ''));
    const busy = !!this.netBusy;
    return `<h2>Online race</h2>
      <p class="muted small">Race friends on their own phones or computers. Private rooms with a code — no chat.</p>
      <label class="field">Your racer name<input id="mp-name" type="text" maxlength="12" value="${name}" placeholder="Mody" autocomplete="off"></label>
      <div class="btn-col">
        <button class="btn primary" data-act="create-room" ${busy ? 'disabled' : ''}>Create a room</button>
      </div>
      <div class="or"><span>or join a friend's room</span></div>
      <label class="field">Room code<input id="mp-code" type="text" maxlength="12" value="${esc(this.joinCode)}" placeholder="TIGER-42" autocomplete="off" autocapitalize="characters"></label>
      <div class="btn-col">
        <button class="btn" data-act="join-room" ${busy ? 'disabled' : ''}>Join</button>
      </div>
      ${busy ? `<p class="net-busy">${esc(this.netBusy)}</p>` : ''}
      ${this.netError ? `<p class="net-error">${esc(this.netError)}</p>` : ''}
      <p class="muted small center">Game version <b>${esc(BUILD)}</b> — every player needs the same one.</p>
      <div class="btn-row"><button class="btn ghost" data-act="back">Back</button></div>`;
  }

  /** a recent emoji from a player (shown next to their name), or '' */
  private emoteOf(id: string): string {
    const e = this.emotes.get(id);
    return e && e.until > performance.now() ? e.text : '';
  }

  private emoteRow(): string {
    return `<div class="emote-row" aria-label="Send an emoji">${EMOTES.map((e, i) => `<button class="emote" data-act="emote" data-i="${i}" aria-label="Send ${e}">${e}</button>`).join('')}</div>`;
  }

  private lobbyHtml(): string {
    const L = this.mpInfo();
    if (!L) return `<h2>Room closed</h2><div class="btn-row"><button class="btn ghost" data-act="quit">Menu</button></div>`;
    const rows = [];
    for (let i = 0; i < 4; i++) {
      const p = L.players[i];
      const emo = p ? this.emoteOf(p.id) : '';
      rows.push(
        p
          ? `<li class="${p.me ? 'me' : ''}"><i style="background:${p.color}"></i><span class="who"><b>${esc(p.name)}</b><small>${esc(p.car)}</small></span>${emo ? `<span class="emo-pop">${emo}</span>` : ''}${p.me ? '<span class="tag">you</span>' : ''}${p.host ? '<span class="tag host">host</span>' : ''}</li>`
          : `<li class="empty"><i></i>waiting for a friend…</li>`,
      );
    }
    const st = getStyle(settings.carStyle);
    const lv = getLivery(settings.carLivery);
    const hex = (n: number) => '#' + n.toString(16).padStart(6, '0');
    const myCar = `<div class="my-car">
        <i class="car-chip" style="background:linear-gradient(135deg, ${hex(lv.body)} 0 60%, ${hex(lv.stripe)} 60% 76%, ${hex(lv.body)} 76%)"></i>
        <span class="who"><b>${esc(st.name)}</b><small>${esc(lv.name)}</small></span>
        <button class="btn tiny" data-act="garage">Change</button>
      </div>`;
    const tiles = this.stages
      .map((s) => {
        const on = s.def.id === L.stageId;
        return `<button class="stage-tile biome-${esc(s.def.biome)} ${on ? 'on' : ''}" ${L.isHost ? `data-act="pick-stage" data-id="${esc(s.def.id)}"` : 'disabled'}>
          <b>${esc(s.def.name)}</b><small>${esc(s.def.biome)} · ${esc(s.def.timeOfDay)}</small>${on ? '<span class="tick">✓</span>' : ''}</button>`;
      })
      .join('');
    return `<h2>Room</h2>
      <div class="room-code">${esc(L.code)}</div>
      <p class="muted small center">Tell your friends this code, or send them the link. · v ${esc(BUILD)}</p>
      ${L.isHost ? `<p class="host-note">${L.serverOnline ? '📱 Keep this game open on screen until everyone has joined. If you switch apps, friends can\'t connect.' : '⏳ Reconnecting to the room server… friends can join again in a moment.'}</p>` : ''}
      <div class="btn-row"><button class="btn tiny" data-act="copy-room">Copy invite link</button></div>
      <ul class="lobby-players">${rows.join('')}</ul>
      ${this.emoteRow()}
      <div class="set-group">Your car</div>
      ${myCar}
      <div class="set-group">Stage ${L.isHost ? '<span class="muted">· tap to choose</span>' : '<span class="muted">· the host chooses</span>'}</div>
      <div class="stage-tiles">${tiles}</div>
      <div class="btn-col">
        ${
          L.isHost
            ? `<button class="btn primary" data-act="host-start">${L.players.length < 2 ? 'Start (on your own)' : 'Start race!'}</button>`
            : `<p class="net-busy">${L.racing ? 'A race is on — you will join the next one.' : 'Waiting for the host to start…'}</p>`
        }
        <button class="btn ghost" data-act="leave-room">Leave room</button>
      </div>`;
  }

  private endlessHtml(): string {
    const b = this.endlessBest;
    return `<h2>Endless</h2>
      <p class="muted">Infinite procedural road. Gates add time; the clock never stops. Gets harder with distance.</p>
      <div class="stat">High score <b>${b.score ? Math.floor(b.score) + ' m' : '—'}</b>${b.seed ? ` <span class="muted">(seed ${seedToString(b.seed)})</span>` : ''}</div>
      <label class="field">Seed (optional)<input id="seed-input" type="text" maxlength="12" placeholder="random" autocomplete="off" autocapitalize="characters"></label>
      <div class="btn-col">
        <button class="btn primary" data-act="go-endless">Start</button>
        <button class="btn ghost" data-act="back">Back</button>
      </div>`;
  }

  /** Settings is split into tabs so it fits on one screen */
  private settingsTab: 'controls' | 'graphics' | 'audio' = 'controls';

  private settingsHtml(): string {
    const s = settings;
    const sel = (key: keyof Settings, opts: [string, string][]) =>
      `<select data-set="${key}">${opts.map(([v, l]) => `<option value="${v}" ${String(s[key]) === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
    const chk = (key: keyof Settings) => `<input type="checkbox" data-set="${key}" ${s[key] ? 'checked' : ''}>`;
    const range = (key: keyof Settings, min: number, max: number, step: number) =>
      `<input type="range" min="${min}" max="${max}" step="${step}" data-set="${key}" value="${s[key]}">`;
    const tab = this.settingsTab;
    const tabs = (
      [
        ['controls', '🎮', 'Controls'],
        ['graphics', '🖥️', 'Graphics'],
        ['audio', '🎵', 'Sound & Music'],
      ] as const
    )
      .map(([id, icon, label]) => `<button class="tab ${tab === id ? 'on' : ''}" data-act="set-tab" data-tab="${id}" role="tab" aria-selected="${tab === id}"><span>${icon}</span>${label}</button>`)
      .join('');
    let body = '';
    if (tab === 'controls') {
      const touch = isTouchDevice();
      body = `
        <label>Steering ${sel('steer', [
          ['joystick', 'Joystick'],
          ['buttons', '◀ ▶ zones'],
          ['tilt', 'Tilt'],
        ])}</label>
        ${s.steer === 'tilt' ? `<label>Tilt sensitivity ${range('tiltSensitivity', 0.5, 2, 0.1)}</label>` : ''}
        <label>Auto-accelerate ${chk('autoGas')}</label>
        <label>Haptics (vibration) ${chk('haptics')}</label>
        ${
          touch
            ? ''
            : `<div class="keys-help">
          <div><kbd>W A S D</kbd> / arrows drive</div><div><kbd>Space</kbd> handbrake</div>
          <div><kbd>R</kbd> reset car</div><div><kbd>C</kbd> camera</div>
          <div><kbd>M</kbd> music</div><div><kbd>F</kbd> throw 🍅</div>
          <div><kbd>1</kbd>–<kbd>8</kbd> emoji (online)</div><div><kbd>Esc</kbd> pause</div>
        </div>`
        }`;
    } else if (tab === 'graphics') {
      body = `
        <label>Camera ${sel('cameraView', [
          ['top', 'Top-down'],
          ['chase', 'Chase (3rd person)'],
        ])}</label>
        ${s.cameraView === 'top' ? `<label>Camera turns with the car ${chk('cameraRotate')}</label>` : ''}
        <label>Quality ${sel('quality', [
          ['auto', 'Auto'],
          ['low', 'Low'],
          ['medium', 'Medium'],
          ['high', 'High'],
        ])}</label>
        <label>Time of day ${sel('timeOfDay', [
          ['auto', 'Track default'],
          ['day', 'Day'],
          ['dusk', 'Dusk'],
          ['night', 'Night'],
        ])}</label>
        <label>Art style ${sel('artStyle', [
          ['color', 'Color'],
          ['mono', 'Monochrome'],
        ])}</label>
        <label>Show FPS ${chk('showFps')}</label>`;
    } else {
      body = `
        <div class="set-group">Sound effects</div>
        <label>Sound ${chk('sound')}</label>
        <label>Volume ${range('volume', 0, 1, 0.05)}</label>
        <div class="set-group">Music</div>
        <label>Music ${chk('music')}</label>
        <label>Volume ${range('musicVolume', 0, 1, 0.05)}</label>
        <label>Track ${sel('musicTrack', [['auto', 'Auto (menu / stage)'], ...TRACKS.map((t) => [t.id, t.name] as [string, string])])}</label>`;
    }
    return `<h2>Settings</h2>
      <div class="tabs" role="tablist">${tabs}</div>
      <div class="settings">${body}</div>
      <p class="muted small" id="set-note"></p>
      <div class="btn-row"><button class="btn primary" data-act="back">Done</button></div>`;
  }

  private garageHtml(): string {
    const st = getStyle(settings.carStyle);
    const lv = getLivery(settings.carLivery);
    const hex = (n: number) => '#' + n.toString(16).padStart(6, '0');
    const styles = CAR_STYLES.map(
      (c) => `<button class="chip ${c.id === st.id ? 'on' : ''}" data-act="car-style" data-id="${c.id}">${esc(c.name)}</button>`,
    ).join('');
    const swatches = CAR_LIVERIES.map(
      (l) =>
        `<button class="swatch ${l.id === lv.id ? 'on' : ''}" data-act="car-livery" data-id="${l.id}" title="${esc(l.name)}" aria-label="${esc(l.name)}"
          style="background:linear-gradient(135deg, ${hex(l.body)} 0 62%, ${hex(l.stripe)} 62% 78%, ${hex(l.body)} 78%)"></button>`,
    ).join('');
    return `<h2>Garage</h2>
      <div class="set-group">Car</div>
      <div class="chips">${styles}</div>
      <p class="muted small">${esc(st.description)}</p>
      <div class="set-group">Colour · <span class="livery-name">${esc(lv.name)}</span></div>
      <div class="swatches">${swatches}</div>
      <p class="muted small">Cosmetic only — every car handles the same.</p>
      <div class="btn-row"><button class="btn primary" data-act="back">Done</button></div>`;
  }

  private pauseHtml(): string {
    const online = !!this.mpInfo();
    return `<h2>${online ? 'Race menu' : 'Paused'}</h2>${online ? '<p class="muted small">The race keeps going for everyone else!</p>' : ''}<div class="btn-col">
      <button class="btn primary" data-act="resume">${online ? 'Back to the race' : 'Resume'}</button>
      ${online ? '' : '<button class="btn" data-act="restart">Restart</button>'}
      <button class="btn ghost" data-act="settings">Settings</button>
      <button class="btn ghost" data-act="quit">${online ? 'Leave race (back to room)' : 'Quit to menu'}</button></div>`;
  }

  private resultsHtml(): string {
    const r = this.result;
    if (!r) return '';
    if (r.standings) {
      const rows = r.standings
        .map(
          (s, i) =>
            `<li class="${s.me ? 'me' : ''}"><span class="place">${s.time != null ? i + 1 : '–'}</span><i style="background:${s.color}"></i><b>${esc(s.name)}</b>${s.id && this.emoteOf(s.id) ? `<span class="emo-pop">${this.emoteOf(s.id)}</span>` : ''}<span class="st">${esc(s.status)}</span></li>`,
        )
        .join('');
      return `<h2 class="${r.record ? 'record' : ''}">${esc(r.title)}</h2>
        ${r.lines.map((l) => `<div class="result-line">${esc(l)}</div>`).join('')}
        <ol class="standings">${rows}</ol>
        ${r.online ? this.emoteRow() : ''}
        <div class="btn-col">
          ${
            r.waiting
              ? '<p class="net-busy">Waiting for the host to start the next race…</p>'
              : `<button class="btn primary" data-act="restart">Race again</button>${r.canNext ? '<button class="btn" data-act="next">Next stage</button>' : ''}`
          }
          <button class="btn ghost" data-act="${r.online ? 'lobby' : 'quit'}">${r.online ? 'Back to room' : 'Menu'}</button>
        </div>`;
    }
    return `<h2 class="${r.record ? 'record' : ''}">${esc(r.title)}</h2>
      <div class="result-big">${esc(r.big)}</div>
      ${r.lines.map((l) => `<div class="result-line">${esc(l)}</div>`).join('')}
      ${r.seed != null ? `<div class="result-seed">Seed <b>${seedToString(r.seed)}</b> ${r.shareUrl ? `<button class="btn tiny" data-act="share">Copy link</button>` : ''}</div>` : ''}
      <div class="btn-col">
        <button class="btn primary" data-act="restart">${r.seed != null ? 'Replay seed' : 'Restart'}</button>
        ${r.canNext ? '<button class="btn" data-act="next">Next stage</button>' : ''}
        <button class="btn ghost" data-act="quit">Menu</button>
      </div>`;
  }

  private onClick(e: Event): void {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!t) return;
    const act = t.dataset.act!;
    switch (act) {
      case 'stages':
      case 'endless':
      case 'settings':
      case 'garage':
      case 'multi':
      case 'split':
        this.show(act, true);
        break;
      case 'online':
        this.netError = '';
        this.show(act, true);
        break;
      case 'split-stage':
        this.h.startSplit(this.stages[Number(t.dataset.i)].def);
        break;
      case 'create-room':
      case 'join-room': {
        const name = (this.root.querySelector('#mp-name') as HTMLInputElement | null)?.value ?? '';
        const code = (this.root.querySelector('#mp-code') as HTMLInputElement | null)?.value ?? '';
        if (!name.trim()) {
          this.netError = 'Type your racer name first.';
          this.refresh();
          (this.root.querySelector('#mp-name') as HTMLInputElement | null)?.focus();
        } else if (act === 'join-room' && !code.trim()) {
          this.netError = 'Type the room code your friend gave you.';
          this.refresh();
        } else if (act === 'create-room') this.h.createRoom(name);
        else {
          this.joinCode = code;
          this.h.joinRoom(code, name);
        }
        break;
      }
      case 'leave-room':
        this.h.leaveRoom();
        break;
      case 'host-start':
        this.h.hostStart();
        break;
      case 'lobby':
        this.h.toLobby();
        break;
      case 'music':
        this.h.toggleMusic();
        this.render();
        break;
      case 'emote':
        this.h.emote(Number(t.dataset.i));
        break;
      case 'pick-stage':
        this.h.hostStage(t.dataset.id!);
        break;
      case 'set-tab':
        this.settingsTab = t.dataset.tab as typeof this.settingsTab;
        this.render();
        break;
      case 'copy-room': {
        const L = this.mpInfo();
        if (L) {
          const text = `Race me in Dust Rally! Room code ${L.code}: ${L.shareUrl}`;
          const nav = navigator as Navigator & { share?: (d: { title: string; text: string; url: string }) => Promise<void> };
          if (isTouchDevice() && nav.share) void nav.share({ title: 'Dust Rally', text: `Race me in Dust Rally! Room code ${L.code}`, url: L.shareUrl }).catch(() => {});
          else
            void navigator.clipboard?.writeText(text).then(
              () => (t.textContent = 'Copied!'),
              () => (t.textContent = 'Copy failed'),
            );
        }
        break;
      }
      case 'car-style':
      case 'car-livery':
        updateSettings(act === 'car-style' ? { carStyle: t.dataset.id! } : { carLivery: t.dataset.id! });
        this.h.settingsChanged(settings);
        this.render();
        break;
      case 'daily':
        this.h.startDaily();
        break;
      case 'back':
        this.back();
        break;
      case 'stage':
        this.h.startStage(this.stages[Number(t.dataset.i)].def);
        break;
      case 'go-endless': {
        const v = (this.root.querySelector('#seed-input') as HTMLInputElement | null)?.value.trim() ?? '';
        this.h.startEndless(v ? parseSeed(v) : null);
        break;
      }
      case 'resume':
        this.h.resume();
        break;
      case 'restart':
        this.h.restart();
        break;
      case 'quit':
        this.h.quit();
        break;
      case 'next':
        this.h.next();
        break;
      case 'share':
        if (this.result?.shareUrl) {
          void navigator.clipboard?.writeText(this.result.shareUrl).then(
            () => (t.textContent = 'Copied!'),
            () => (t.textContent = 'Copy failed'),
          );
        }
        break;
    }
  }

  private onChange(e: Event): void {
    const el = e.target as HTMLInputElement | HTMLSelectElement;
    if (el instanceof HTMLSelectElement && el.hasAttribute('data-host-stage')) {
      if (e.type === 'change') this.h.hostStage(el.value);
      return;
    }
    const key = el.dataset?.set as keyof Settings | undefined;
    if (!key) return;
    let v: unknown;
    if (el instanceof HTMLInputElement && el.type === 'checkbox') v = el.checked;
    else if (el instanceof HTMLInputElement && el.type === 'range') v = parseFloat(el.value);
    else v = el.value;
    if (e.type === 'input' && !(el instanceof HTMLInputElement && el.type === 'range')) return;
    updateSettings({ [key]: v } as Partial<Settings>);
    const note = this.root.querySelector('#set-note');
    if (key === 'steer' && v === 'tilt') {
      void this.h.enableTilt().then((ok) => {
        if (!ok && note) note.textContent = 'Tilt not available / permission denied on this device.';
      });
    }
    if ((key === 'quality' || key === 'artStyle') && note) note.textContent = 'Graphics changes apply when the next race starts.';
    if ((key === 'steer' || key === 'cameraView') && e.type === 'change') setTimeout(() => this.current === 'settings' && this.render(), 0);
    this.h.settingsChanged(settings);
  }
}
