import { Minimap } from './minimap';

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
export class Hud {
  readonly root: HTMLDivElement;
  readonly minimap: Minimap;
  private el: Record<string, HTMLElement> = {};
  private cache: Record<string, string> = {};
  onPause: () => void = () => {};
  onReset: () => void = () => {};
  onCamera: () => void = () => {};

  constructor(parent: HTMLElement) {
    const r = (this.root = document.createElement('div'));
    r.className = 'hud';
    r.innerHTML = `
      <div class="hud-top-left">
        <div class="hud-label" data-k="timeLabel">TIME</div>
        <div class="hud-time" data-k="time">0:00.00</div>
        <div class="hud-split" data-k="split"></div>
        <div class="hud-sub" data-k="sub"></div>
      </div>
      <div class="hud-top-right" data-k="mapHolder"></div>
      <div class="hud-top-center">
        <button class="icon-btn" data-k="pause" aria-label="Pause">❚❚</button>
        <button class="icon-btn" data-k="reset" aria-label="Reset car">↺</button>
        <button class="icon-btn" data-k="cam" aria-label="Switch camera" title="Switch camera (C)">🎥</button>
      </div>
      <div class="hud-msg" data-k="msg"></div>
      <div class="hud-count" data-k="count"></div>
      <div class="hud-speed"><span data-k="speed">0</span><small>km/h</small></div>
      <div class="hud-fps" data-k="fps"></div>
    `;
    parent.appendChild(r);
    r.querySelectorAll<HTMLElement>('[data-k]').forEach((e) => (this.el[e.dataset.k!] = e));
    this.minimap = new Minimap(this.el.mapHolder);
    this.el.pause.addEventListener('click', () => this.onPause());
    this.el.reset.addEventListener('click', () => this.onReset());
    this.el.cam.addEventListener('click', () => this.onCamera());
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

  show(on: boolean): void {
    this.root.style.display = on ? '' : 'none';
  }
}
