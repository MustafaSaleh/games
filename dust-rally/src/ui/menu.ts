import { settings, updateSettings, type Settings } from '../core/settings';
import { parseSeed, seedToString } from '../core/rng';
import type { StageDef } from '../world/stage';
import { fmtTime } from './hud';
import type { CharacterView, Gesture } from '../render/character';

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

  constructor(
    parent: HTMLElement,
    private h: MenuHandlers,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'menu';
    parent.appendChild(this.root);
    this.hero = document.createElement('div');
    this.hero.className = 'hero';
    this.hero.innerHTML = `<div class="hero-bubble"></div><div class="hero-tag"><b>MODY</b><span>#08</span></div>`;
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
    return this.visible && (this.current === 'main' || this.current === 'results');
  }

  private syncHero(): void {
    const on = this.heroScreen();
    this.root.classList.toggle('with-hero', on);
    const c = this.character;
    if (!on) this.bubble.classList.remove('on');
    if (!c) return;
    c.setActive(on);
    if (!on) return;
    if (!this.heroIntroDone) {
      this.heroIntroDone = true;
      c.playIntro();
    } else if (this.current === 'results' && this.result) {
      const g: Gesture = this.result.record ? 'cheer' : 'wave';
      c.play(g);
      this.say(this.result.record ? 'New record! 🏆' : this.result.canNext ? 'Nice drive! 🏁' : "Let's go again! 💪");
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
        <button class="btn" data-act="endless">Endless</button>
        <button class="btn" data-act="daily">Daily Challenge<small>Seed ${seedToString(this.dailySeed)} · Best ${this.dailyBest ? Math.floor(this.dailyBest) + ' m' : '—'}</small></button>
        <button class="btn ghost" data-act="settings">Settings</button>
      </div>
      <div class="hint">${'ontouchstart' in window ? 'Left thumb steers · right side: gas / brake / drift' : 'WASD / arrows · Space = handbrake · R = reset · Esc = pause · gamepad supported'}</div>`;
  }

  private stagesHtml(): string {
    const cards = this.stages
      .map(
        (s, i) => `
      <button class="card biome-${esc(s.def.biome)}" data-act="stage" data-i="${i}">
        <div class="card-title">${esc(s.def.name)}</div>
        <div class="card-sub">${esc(s.def.biome)} · ${esc(s.def.timeOfDay)}</div>
        <div class="card-desc">${esc(s.def.description ?? '')}</div>
        <div class="card-best">${s.best != null ? 'Best ' + fmtTime(s.best) : 'No time set'}</div>
      </button>`,
      )
      .join('');
    return `<h2>Stages</h2><div class="cards">${cards}</div>
      <div class="btn-row"><button class="btn ghost" data-act="back">Back</button></div>`;
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

  private settingsHtml(): string {
    const s = settings;
    const sel = (key: keyof Settings, opts: [string, string][]) =>
      `<select data-set="${key}">${opts.map(([v, l]) => `<option value="${v}" ${String(s[key]) === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
    const chk = (key: keyof Settings) => `<input type="checkbox" data-set="${key}" ${s[key] ? 'checked' : ''}>`;
    return `<h2>Settings</h2>
      <div class="settings">
        <div class="set-group">Controls</div>
        <label>Steering ${sel('steer', [
          ['joystick', 'Joystick'],
          ['buttons', '◀ ▶ zones'],
          ['tilt', 'Tilt'],
        ])}</label>
        <label>Tilt sensitivity <input type="range" min="0.5" max="2" step="0.1" data-set="tiltSensitivity" value="${s.tiltSensitivity}"></label>
        <label>Auto-accelerate ${chk('autoGas')}</label>
        <label>Haptics ${chk('haptics')}</label>
        <div class="set-group">Graphics</div>
        <label>Quality ${sel('quality', [
          ['auto', 'Auto'],
          ['low', 'Low'],
          ['medium', 'Medium'],
          ['high', 'High'],
        ])}</label>
        <label>Art style ${sel('artStyle', [
          ['color', 'Color'],
          ['mono', 'Monochrome'],
        ])}</label>
        <label>Time of day ${sel('timeOfDay', [
          ['auto', 'Track default'],
          ['day', 'Day'],
          ['dusk', 'Dusk'],
          ['night', 'Night'],
        ])}</label>
        <label>Camera follows rotation ${chk('cameraRotate')}</label>
        <label>Show FPS ${chk('showFps')}</label>
        <div class="set-group">Sound</div>
        <label>Sound ${chk('sound')}</label>
        <label>Volume <input type="range" min="0" max="1" step="0.05" data-set="volume" value="${s.volume}"></label>
      </div>
      <p class="muted small" id="set-note"></p>
      <div class="btn-row"><button class="btn primary" data-act="back">Done</button></div>`;
  }

  private pauseHtml(): string {
    return `<h2>Paused</h2><div class="btn-col">
      <button class="btn primary" data-act="resume">Resume</button>
      <button class="btn" data-act="restart">Restart</button>
      <button class="btn ghost" data-act="settings">Settings</button>
      <button class="btn ghost" data-act="quit">Quit to menu</button></div>`;
  }

  private resultsHtml(): string {
    const r = this.result;
    if (!r) return '';
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
        this.show(act, true);
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
    this.h.settingsChanged(settings);
  }
}
