import type { Input } from '../core/input';
import { settings } from '../core/settings';
import { clamp } from '../core/math';

/**
 * On-screen controls (pointer events, multi-touch):
 *  left thumb  = floating joystick (or ◀ ▶ zones), or nothing when tilt steering
 *  right thumb = GAS (big), BRAKE/REV, HANDBRAKE
 */
export class TouchControls {
  readonly root: HTMLDivElement;
  private stickZone: HTMLDivElement;
  private stickBase: HTMLDivElement;
  private stickKnob: HTMLDivElement;
  private btnLeft: HTMLDivElement;
  private btnRight: HTMLDivElement;
  private stickId = -1;
  private stickX = 0;
  private stickY = 0;
  private held = { left: false, right: false };
  private tomato: HTMLDivElement;

  constructor(
    parent: HTMLElement,
    private input: Input,
  ) {
    const root = (this.root = div('touch'));
    parent.appendChild(root);
    this.stickZone = div('stick-zone', root);
    this.stickBase = div('stick-base', this.stickZone);
    this.stickKnob = div('stick-knob', this.stickBase);
    this.btnLeft = div('tbtn steer-btn left', root, '◀');
    this.btnRight = div('tbtn steer-btn right', root, '▶');
    const gas = div('tbtn gas', root, 'GAS');
    const brake = div('tbtn brake', root, 'BRAKE');
    const hb = div('tbtn hb', root, 'DRIFT');
    this.tomato = div('tbtn tomato', root, '🍅');
    this.tomato.addEventListener('pointerdown', (e) => {
      this.input.throwReq = true;
      e.preventDefault();
    });

    // joystick
    this.stickZone.addEventListener('pointerdown', (e) => {
      if (this.stickId !== -1) return;
      this.stickId = e.pointerId;
      this.stickZone.setPointerCapture(e.pointerId);
      const r = this.stickZone.getBoundingClientRect();
      this.stickX = e.clientX - r.left;
      this.stickY = e.clientY - r.top;
      this.stickBase.style.transform = `translate(${this.stickX}px, ${this.stickY}px)`;
      this.stickBase.classList.add('on');
      this.moveStick(e);
      e.preventDefault();
    });
    this.stickZone.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.stickId) this.moveStick(e);
    });
    const endStick = (e: PointerEvent) => {
      if (e.pointerId !== this.stickId) return;
      this.stickId = -1;
      this.input.touch.steer = 0;
      this.stickBase.classList.remove('on');
      this.stickKnob.style.transform = '';
    };
    this.stickZone.addEventListener('pointerup', endStick);
    this.stickZone.addEventListener('pointercancel', endStick);

    // buttons
    this.hold(this.btnLeft, (on) => {
      this.held.left = on;
      this.updateSteerButtons();
    });
    this.hold(this.btnRight, (on) => {
      this.held.right = on;
      this.updateSteerButtons();
    });
    this.hold(gas, (on) => (this.input.touch.gas = on ? 1 : 0));
    this.hold(brake, (on) => (this.input.touch.brake = on ? 1 : 0));
    this.hold(hb, (on) => (this.input.touch.handbrake = on));
    root.addEventListener('contextmenu', (e) => e.preventDefault());
    this.applyMode();
  }

  private moveStick(e: PointerEvent): void {
    const r = this.stickZone.getBoundingClientRect();
    const dx = e.clientX - r.left - this.stickX;
    const max = 56;
    const cx = clamp(dx, -max, max);
    this.stickKnob.style.transform = `translate(${cx}px, 0px)`;
    // small dead zone + slightly progressive response
    const v = clamp(dx / max, -1, 1);
    const dz = 0.06;
    const a = Math.abs(v) < dz ? 0 : (Math.abs(v) - dz) / (1 - dz);
    this.input.touch.steer = Math.sign(v) * Math.pow(a, 1.25);
  }

  private updateSteerButtons(): void {
    this.input.touch.steer = (this.held.right ? 1 : 0) - (this.held.left ? 1 : 0);
  }

  private hold(el: HTMLElement, cb: (on: boolean) => void): void {
    const ids = new Set<number>();
    el.addEventListener('pointerdown', (e) => {
      ids.add(e.pointerId);
      el.setPointerCapture(e.pointerId);
      el.classList.add('down');
      cb(true);
      e.preventDefault();
    });
    const up = (e: PointerEvent) => {
      if (!ids.delete(e.pointerId)) return;
      if (ids.size === 0) {
        el.classList.remove('down');
        cb(false);
      }
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
  }

  applyMode(): void {
    const m = settings.steer;
    this.stickZone.style.display = m === 'joystick' ? '' : 'none';
    this.btnLeft.style.display = this.btnRight.style.display = m === 'buttons' ? '' : 'none';
    this.root.classList.toggle('tilt', m === 'tilt');
    this.root.classList.toggle('autogas', settings.autoGas);
  }

  /** multiplayer: show the 🍅 throw button with the current ammo */
  setTomatoes(mp: boolean, ammo: number): void {
    this.root.classList.toggle('mp', mp);
    this.tomato.classList.toggle('empty', ammo <= 0);
    const t = ammo > 0 ? `🍅${ammo > 1 ? '×' + ammo : ''}` : '🍅';
    if (this.tomato.textContent !== t) this.tomato.textContent = t;
  }

  show(on: boolean): void {
    this.root.style.display = on ? '' : 'none';
    this.input.touch.active = on;
    if (!on) {
      const t = this.input.touch;
      t.steer = t.gas = t.brake = 0;
      t.handbrake = false;
    }
  }
}

function div(cls: string, parent?: HTMLElement, text?: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = cls;
  if (text) d.textContent = text;
  parent?.appendChild(d);
  return d;
}
