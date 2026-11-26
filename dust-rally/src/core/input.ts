import type { CarInput } from '../physics/car';
import { clamp } from './math';
import { settings } from './settings';

/**
 * Merges keyboard, gamepad, touch and tilt into one CarInput.
 * Touch UI (ui/touch.ts) and tilt write into `touch` / `tiltSteer`.
 */
export class Input implements CarInput {
  steer = 0;
  throttle = 0;
  brake = 0;
  handbrake = false;
  readonly touch = { steer: 0, gas: 0, brake: 0, handbrake: false, active: false };
  tiltSteer = 0;
  tiltActive = false;
  private tiltZero = 0;
  private tiltRaw = 0;
  private keys = new Set<string>();
  private kbSteer = 0;
  private edge = new Set<string>();
  enabled = true;

  constructor() {
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (!this.keys.has(e.code)) this.edge.add(e.code);
      this.keys.add(e.code);
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  /** true once per key press */
  pressed(code: string): boolean {
    return this.edge.has(code);
  }

  private padPrev: boolean[] = [];
  private padEdge: boolean[] = [];
  padPressed(btn: number): boolean {
    return !!this.padEdge[btn];
  }

  update(dt: number): void {
    const k = this.keys;
    const left = k.has('KeyA') || k.has('ArrowLeft');
    const right = k.has('KeyD') || k.has('ArrowRight');
    const target = (right ? 1 : 0) - (left ? 1 : 0);
    // digital steering ramps in (and snaps back faster) for smoothness
    const rate = target === 0 ? 7 : Math.sign(target) !== Math.sign(this.kbSteer) && this.kbSteer !== 0 ? 9 : 4.5;
    this.kbSteer += clamp(target - this.kbSteer, -rate * dt, rate * dt);

    let steer = this.kbSteer;
    let throttle = k.has('KeyW') || k.has('ArrowUp') ? 1 : 0;
    let brake = k.has('KeyS') || k.has('ArrowDown') ? 1 : 0;
    let hb = k.has('Space');

    // gamepad
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p || !p.connected) continue;
      const ax = p.axes[0] ?? 0;
      const sx = Math.abs(ax) > 0.12 ? (ax - Math.sign(ax) * 0.12) / 0.88 : 0;
      if (Math.abs(sx) > Math.abs(steer)) steer = sx;
      const rt = p.buttons[7]?.value ?? 0,
        lt = p.buttons[6]?.value ?? 0;
      throttle = Math.max(throttle, rt, p.buttons[0]?.pressed ? 1 : 0);
      brake = Math.max(brake, lt, p.buttons[2]?.pressed ? 1 : 0);
      hb = hb || !!p.buttons[1]?.pressed || !!p.buttons[5]?.pressed;
      for (let b = 0; b < p.buttons.length; b++) {
        const now = !!p.buttons[b]?.pressed;
        this.padEdge[b] = now && !this.padPrev[b];
        this.padPrev[b] = now;
      }
      break;
    }

    // touch
    const t = this.touch;
    if (t.active) {
      if (settings.steer !== 'tilt' && Math.abs(t.steer) > Math.abs(steer)) steer = t.steer;
      throttle = Math.max(throttle, t.gas);
      brake = Math.max(brake, t.brake);
      hb = hb || t.handbrake;
      if (settings.autoGas && brake === 0 && !t.handbrake) throttle = 1;
    }
    if (settings.steer === 'tilt' && this.tiltActive && Math.abs(this.tiltSteer) > Math.abs(steer)) steer = this.tiltSteer;

    if (!this.enabled) {
      steer = 0;
      throttle = 0;
      brake = 0;
      hb = false;
    }
    this.steer = clamp(steer, -1, 1);
    this.throttle = clamp(throttle, 0, 1);
    this.brake = clamp(brake, 0, 1);
    this.handbrake = hb;
  }

  /** call at the end of a frame */
  endFrame(): void {
    this.edge.clear();
    this.padEdge.length = 0;
  }

  // ---------------- tilt ----------------
  private onOrient = (e: DeviceOrientationEvent): void => {
    const angle = (screen.orientation?.angle ?? (window as unknown as { orientation?: number }).orientation ?? 0) as number;
    const beta = e.beta ?? 0,
      gamma = e.gamma ?? 0;
    let a: number;
    if (angle === 90) a = beta;
    else if (angle === -90 || angle === 270) a = -beta;
    else a = gamma;
    this.tiltRaw = a;
    const d = a - this.tiltZero;
    const dead = 2;
    const v = Math.abs(d) < dead ? 0 : (d - Math.sign(d) * dead) / 22;
    this.tiltSteer = clamp(v * settings.tiltSensitivity, -1, 1);
    this.tiltActive = true;
  };

  /** Must be called from a user gesture on iOS. */
  async enableTilt(): Promise<boolean> {
    const DOE = window.DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
    try {
      if (DOE && typeof DOE.requestPermission === 'function') {
        const r = await DOE.requestPermission();
        if (r !== 'granted') return false;
      }
    } catch {
      return false;
    }
    window.addEventListener('deviceorientation', this.onOrient);
    return 'DeviceOrientationEvent' in window;
  }

  calibrateTilt(): void {
    this.tiltZero = 0; // flat-held phone in landscape ~ 0; keep simple: zero = level
    if (Math.abs(this.tiltRaw) < 25) this.tiltZero = this.tiltRaw;
  }
}
