import type { CharacterView } from '@engine/render/character';
import { settings, updateSettings, isTouchDevice } from '@engine/core/settings';

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
      </div>
      <div class="tt-wave"><div data-k="wave">WAVE 1</div><small data-k="score">0</small></div>
      <div class="tt-buttons">
        <button class="icon-btn" data-k="pause" aria-label="Pause">❚❚</button>
        <button class="icon-btn" data-k="cam" aria-label="Camera" title="Camera (C)">🎥</button>
        <button class="icon-btn" data-k="music" aria-label="Music" title="Music (M)">🎵</button>
      </div>
      <div class="tt-banner" data-k="banner"></div>
      <div class="tt-hurt" data-k="hurt"></div>`;
    parent.appendChild(r);
    r.querySelectorAll<HTMLElement>('[data-k]').forEach((e) => (this.el[e.dataset.k!] = e));
    this.el.pause.addEventListener('click', () => this.onPause());
    this.el.cam.addEventListener('click', () => this.onCamera());
    this.el.music.addEventListener('click', () => this.onMusic());
  }

  set(key: string, text: string): void {
    if (this.cache[key] === text) return;
    this.cache[key] = text;
    this.el[key].textContent = text;
  }

  bar(key: 'hp' | 'reload', frac: number): void {
    const w = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
    if (this.cache[key] === w) return;
    this.cache[key] = w;
    this.el[key].style.width = w;
    if (key === 'hp') this.el.hp.classList.toggle('low', frac < 0.3);
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
  result = { wave: 1, score: 0, best: 0, record: false };

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
          <button class="btn primary" data-act="play">▶ Play: Desert Bowl<small>Survive the drone waves</small></button>
          <button class="btn" data-act="how">How to play</button>
          <button class="btn ghost" data-act="settings">Settings</button>
          <a class="btn ghost" href="../dust-rally/">🏁 Dust Rally</a>
        </div>
        <div class="hint">Phase 1 preview · more units, enemies, cities and multiplayer coming</div>`;
    } else if (s === 'how') {
      const touch = isTouchDevice();
      html = `<h2>How to play</h2>
        <div class="keys-help tt-how">
          ${
            touch
              ? `<div>👈 Left thumb: drive</div><div>👉 Right thumb: aim + fire</div>`
              : `<div><kbd>W A S D</kbd> drive</div><div>🖱️ Mouse aims</div><div>Click / <kbd>Space</kbd> fire</div><div><kbd>C</kbd> camera · <kbd>M</kbd> music</div><div>🎮 Left stick drive</div><div>🎮 Right stick aim · RT fire</div>`
          }
        </div>
        <p class="muted small">Drones circle you and shoot glowing orbs. Their eye turns pink just before they fire: dodge! Destroyed drones sometimes drop a green repair kit. Every few waves there are more of them.</p>
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
    } else if (s === 'pause') {
      html = `<h2>Paused</h2><div class="btn-col">
        <button class="btn primary" data-act="resume">Resume</button>
        <button class="btn ghost" data-act="quit">Quit to menu</button></div>`;
    } else if (s === 'over') {
      const r = this.result;
      html = `<h2 class="${r.record ? 'record' : ''}">${r.record ? 'New best! 🏆' : 'Knocked out!'}</h2>
        <div class="result-big">${r.score}</div>
        <div class="result-line">You reached wave ${r.wave}</div>
        <div class="result-line">Best ${Math.max(r.best, r.score)}</div>
        <div class="btn-col">
          <button class="btn primary" data-act="play">Play again</button>
          <button class="btn ghost" data-act="quit">Menu</button>
        </div>`;
    }
    this.body.innerHTML = `<div class="panel panel-${s}">${html}</div>`;
    this.syncHero();
  }

  private onClick(e: Event): void {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!t) return;
    const act = t.dataset.act!;
    if (act === 'play') this.h.play();
    else if (act === 'resume') this.h.resume();
    else if (act === 'quit') this.h.quit();
    else if (act === 'back') this.show('main');
    else if (act === 'how' || act === 'settings') this.show(act);
  }

  private onChange(e: Event): void {
    const el = e.target as HTMLInputElement | HTMLSelectElement;
    const key = el.dataset?.set;
    if (!key) return;
    const v = el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : el.value;
    updateSettings({ [key]: v } as never);
    this.h.settingsChanged();
  }
}
