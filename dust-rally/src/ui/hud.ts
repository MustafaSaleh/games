import { Minimap } from './minimap';
import { EMOTES } from '../net/session';

export function fmtTime(t: number, showMs = true): string {
  if (!Number.isFinite(t)) return '--:--';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  const ss = showMs ? s.toFixed(2).padStart(5, '0') : Math.floor(s).toString().padStart(2, '0');
  return `${m}:${ss}`;
}

export function fmtDelta(d: number): string {
  return (d >= 0 ? '+' : '−') + Math.abs(d).toFixed(2);
}

/** In-race HUD. Only touches the DOM when a value actually changes. */
/** length of the gauge's 270° arc (r = 50) */
const ARC = 2 * Math.PI * 50 * 0.75;

export class Hud {
  readonly root: HTMLDivElement;
  readonly minimap: Minimap;
  private el: Record<string, HTMLElement> = {};
  private cache: Record<string, string> = {};
  onPause: () => void = () => {};
  onReset: () => void = () => {};
  onCamera: () => void = () => {};
  onMusic: () => void = () => {};
  onEmote: (i: number) => void = () => {};
  /** spectating: -1 / +1 = previous / next player, 0 = back to results */
  onSpectate: (dir: number) => void = () => {};

  constructor(parent: HTMLElement) {
    const r = (this.root = document.createElement('div'));
    r.className = 'hud';
    r.innerHTML = `
      <div class="hud-top-left">
        <div class="hud-label" data-k="timeLabel">TIME</div>
        <div class="hud-time" data-k="time">0:00.00</div>
        <div class="hud-split" data-k="split"></div>
        <div class="hud-sub" data-k="sub"></div>
        <div class="hud-ammo" data-k="ammo"></div>
      </div>
      <div class="hud-top-right" data-k="mapHolder"></div>
      <div class="hud-top-center">
        <button class="icon-btn" data-k="pause" aria-label="Pause">❚❚</button>
        <button class="icon-btn" data-k="reset" aria-label="Reset car">↺</button>
        <button class="icon-btn" data-k="cam" aria-label="Switch camera" title="Switch camera (C)">🎥</button>
        <button class="icon-btn" data-k="music" aria-label="Music on/off" title="Music on/off (M)">🎵</button>
        <button class="icon-btn emo-btn" data-k="emo" aria-label="Send an emoji" title="Emoji (keys 1-8)">😀</button>
      </div>
      <div class="hud-emotes" data-k="emotes">${EMOTES.map((e, i) => `<button class="emote" data-i="${i}" title="${i + 1}">${e}</button>`).join('')}
      </div>
      <div class="hud-msg" data-k="msg"></div>
      <div class="spec-bar">
        <button class="icon-btn" data-k="specPrev" aria-label="Previous player">◀</button>
        <span data-k="specName"></span>
        <button class="icon-btn" data-k="specNext" aria-label="Next player">▶</button>
        <button class="btn tiny" data-k="specRes">Results</button>
      </div>
      <div class="hud-count" data-k="count"></div>
      <div class="hud-speed" data-k="gauge">
        <svg viewBox="0 0 120 120" aria-hidden="true">
          <defs>
            <linearGradient id="rpm-grad" x1="0" y1="1" x2="1" y2="0">
              <stop offset="0" stop-color="#ff6a3d" />
              <stop offset="0.6" stop-color="#ffa45c" />
              <stop offset="1" stop-color="#ffe7c4" />
            </linearGradient>
          </defs>
          <circle class="g-track" cx="60" cy="60" r="50" transform="rotate(135 60 60)" />
          <circle class="g-rpm" data-k="rpm" cx="60" cy="60" r="50" transform="rotate(135 60 60)" />
        </svg>
        <div class="g-gear" data-k="gear">N</div>
        <div class="g-speed" data-k="speed">0</div>
        <div class="g-unit" data-k="unit">km/h</div>
      </div>
      <div class="hud-fps" data-k="fps"></div>
    `;
    parent.appendChild(r);
    r.querySelectorAll<HTMLElement>('[data-k]').forEach((e) => (this.el[e.dataset.k!] = e));
    this.minimap = new Minimap(this.el.mapHolder);
    this.el.pause.addEventListener('click', () => this.onPause());
    this.el.reset.addEventListener('click', () => this.onReset());
    this.el.cam.addEventListener('click', () => this.onCamera());
    this.el.music.addEventListener('click', () => this.onMusic());
    this.el.emo.addEventListener('click', () => this.root.classList.toggle('emotes-open'));
    this.el.specPrev.addEventListener('click', () => this.onSpectate(-1));
    this.el.specNext.addEventListener('click', () => this.onSpectate(1));
    this.el.specRes.addEventListener('click', () => this.onSpectate(0));
    this.el.emotes.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
      if (b) this.onEmote(Number(b.dataset.i));
    });
  }

  set(key: string, text: string): void {
    if (this.cache[key] === text) return;
    this.cache[key] = text;
    this.el[key].textContent = text;
  }

  cls(key: string, cls: string, on: boolean): void {
    const k = key + '.' + cls;
    const v = on ? '1' : '0';
    if (this.cache[k] === v) return;
    this.cache[k] = v;
    this.el[key].classList.toggle(cls, on);
  }

  private rpmShown = -1;
  /** rev gauge: 0..1 of the arc; turns red near the limiter */
  setRpm(frac: number, red: boolean): void {
    const f = Math.round(Math.max(0, Math.min(1, frac)) * 200) / 200;
    if (f !== this.rpmShown) {
      this.rpmShown = f;
      this.el.rpm.style.strokeDasharray = `${(f * ARC).toFixed(1)} 400`;
    }
    this.cls('gauge', 'redline', red);
  }

  show(on: boolean): void {
    this.root.style.display = on ? '' : 'none';
  }
}
