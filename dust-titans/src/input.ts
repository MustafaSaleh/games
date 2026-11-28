import * as THREE from 'three';
import { clamp } from '@engine/core/math';
import type { UnitInput, UnitKind } from './units/unit';

/**
 * Twin-stick controls for every device. Movement is screen-relative (push up = go up the
 * screen) and is turned into a world direction using the camera's yaw.
 *  - keyboard + mouse: WASD / arrows move, the mouse aims, click / F fires,
 *    Space jumps (mech), Shift dashes (mech) / turbo (tank)
 *  - gamepad: left stick move, right stick aim, RT / RB fire, A jump, B / LB dash
 *  - touch: left thumb = move joystick, right thumb = aim joystick (fires while pushed),
 *    JUMP / DASH buttons
 */
export class TitansInput {
  readonly unit: UnitInput = { moveX: 0, moveZ: 0, move: 0, aimYaw: null, fire: false, jump: false, dash: false, special: false };
  /** on-screen buttons (touch) */
  readonly buttons = { jump: false, dash: false, special: false };
  /** world point the player aims at (for the ground marker), or null */
  readonly aimPoint = new THREE.Vector3();
  aimVisible = false;
  enabled = true;
  private keys = new Set<string>();
  private edge = new Set<string>();
  private mouse = { x: 0, y: 0, down: false, active: false };
  private padEdge: boolean[] = [];
  private padPrev: boolean[] = [];
  private ray = new THREE.Raycaster();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private hitV = new THREE.Vector3();
  readonly sticks = { move: { x: 0, y: 0, on: false }, aim: { x: 0, y: 0, on: false } };

  constructor(private canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (!this.keys.has(e.code)) this.edge.add(e.code);
      this.keys.add(e.code);
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Enter'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouse.down = false;
    });
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
      this.mouse.active = true;
    });
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button === 0) this.mouse.down = true;
    });
    window.addEventListener('pointerup', (e) => {
      if (e.pointerType === 'mouse' && e.button === 0) this.mouse.down = false;
    });
  }

  pressed(code: string): boolean {
    return this.edge.has(code);
  }
  padPressed(b: number): boolean {
    return !!this.padEdge[b];
  }

  endFrame(): void {
    this.edge.clear();
    this.padEdge.length = 0;
  }

  /** read every device; `camYaw` maps screen directions to the world, `from` is the tank */
  update(camera: THREE.Camera, camYaw: number, from: { x: number; y: number; z: number }): void {
    const u = this.unit;
    const k = this.keys;
    // screen-space move: x = right, y = up
    let sx = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    let sy = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    let fire = k.has('KeyF') || k.has('KeyJ') || k.has('Enter') || this.mouse.down;
    let jump = k.has('Space') || this.buttons.jump;
    let dash = k.has('ShiftLeft') || k.has('ShiftRight') || k.has('KeyK') || this.buttons.dash;
    let special = k.has('KeyQ') || k.has('KeyE') || k.has('KeyL') || this.buttons.special;
    let aimSX = 0,
      aimSY = 0,
      stickAim = false;

    const pads = (navigator.getGamepads ? [...navigator.getGamepads()] : []).filter((p) => p && p.connected);
    const p = pads[0];
    if (p) {
      const dz = (v: number) => (Math.abs(v) > 0.15 ? v : 0);
      if (dz(p.axes[0]) || dz(p.axes[1])) {
        sx = dz(p.axes[0]);
        sy = -dz(p.axes[1]);
      }
      const ax = dz(p.axes[2] ?? 0),
        ay = -dz(p.axes[3] ?? 0);
      if (Math.hypot(ax, ay) > 0.3) {
        aimSX = ax;
        aimSY = ay;
        stickAim = true;
        this.mouse.active = false;
      }
      fire = fire || (p.buttons[7]?.value ?? 0) > 0.3 || !!p.buttons[5]?.pressed;
      jump = jump || !!p.buttons[0]?.pressed;
      dash = dash || !!p.buttons[1]?.pressed || !!p.buttons[4]?.pressed;
      special = special || !!p.buttons[3]?.pressed || !!p.buttons[2]?.pressed;
      for (let b = 0; b < p.buttons.length; b++) {
        const now = !!p.buttons[b]?.pressed;
        this.padEdge[b] = now && !this.padPrev[b];
        this.padPrev[b] = now;
      }
    }
    // touch sticks
    const ms = this.sticks.move,
      as = this.sticks.aim;
    if (ms.on) {
      sx = ms.x;
      sy = ms.y;
    }
    if (as.on && Math.hypot(as.x, as.y) > 0.25) {
      aimSX = as.x;
      aimSY = as.y;
      stickAim = true;
      this.mouse.active = false;
      if (Math.hypot(as.x, as.y) > 0.55) fire = true;
    }

    // screen -> world (camera yaw): up = (sin, cos), right = (-cos, sin)
    const fy = Math.sin(camYaw),
      fz = Math.cos(camYaw);
    const toWorld = (x: number, y: number): [number, number] => [fy * y - fz * x, fz * y + fy * x];
    const mag = clamp(Math.hypot(sx, sy), 0, 1);
    const [mx, mz] = toWorld(sx, sy);
    u.moveX = mx;
    u.moveZ = mz;
    u.move = mag;

    this.aimVisible = false;
    if (stickAim) {
      const [wx, wz] = toWorld(aimSX, aimSY);
      u.aimYaw = Math.atan2(wx, wz);
      const l = Math.hypot(wx, wz) || 1;
      this.aimPoint.set(from.x + (wx / l) * 22, from.y, from.z + (wz / l) * 22);
      this.aimVisible = true;
    } else if (this.mouse.active) {
      const r = this.canvas.getBoundingClientRect();
      this.ray.setFromCamera(new THREE.Vector2(((this.mouse.x - r.left) / r.width) * 2 - 1, -((this.mouse.y - r.top) / r.height) * 2 + 1), camera);
      this.plane.constant = -(from.y + 1);
      if (this.ray.ray.intersectPlane(this.plane, this.hitV)) {
        u.aimYaw = Math.atan2(this.hitV.x - from.x, this.hitV.z - from.z);
        this.aimPoint.copy(this.hitV);
        this.aimVisible = true;
      }
    } else if (mag > 0.1) u.aimYaw = Math.atan2(mx, mz); // no aim device: shoot where you drive
    u.fire = fire && this.enabled;
    u.jump = jump && this.enabled;
    u.dash = dash && this.enabled;
    u.special = special && this.enabled;
    if (!this.enabled) {
      u.move = 0;
      u.fire = u.jump = u.dash = u.special = false;
    }
  }
}

/** On-screen twin sticks (touch devices). */
export class TouchSticks {
  readonly root: HTMLDivElement;

  private btn: Record<'jump' | 'dash' | 'special', HTMLButtonElement>;

  constructor(parent: HTMLElement, input: TitansInput) {
    const root = (this.root = document.createElement('div'));
    root.className = 'tt-touch';
    parent.appendChild(root);
    const mk = (k: 'jump' | 'dash' | 'special', label: string) => {
      const b = document.createElement('button');
      b.className = `tt-btn ${k}`;
      b.textContent = label;
      const set = (on: boolean) => (e: PointerEvent) => {
        input.buttons[k] = on;
        b.classList.toggle('on', on);
        e.preventDefault();
        e.stopPropagation();
      };
      b.addEventListener('pointerdown', set(true));
      b.addEventListener('pointerup', set(false));
      b.addEventListener('pointercancel', set(false));
      b.addEventListener('pointerleave', set(false));
      return b;
    };
    this.btn = { jump: mk('jump', 'JUMP'), dash: mk('dash', 'DASH'), special: mk('special', '🚀') };
    for (const side of ['move', 'aim'] as const) {
      const zone = document.createElement('div');
      zone.className = `tt-zone ${side}`;
      const base = document.createElement('div');
      base.className = 'tt-base';
      const knob = document.createElement('div');
      knob.className = 'tt-knob';
      base.appendChild(knob);
      zone.appendChild(base);
      const label = document.createElement('span');
      label.className = 'tt-label';
      label.textContent = side === 'move' ? 'MOVE' : 'AIM + FIRE';
      zone.appendChild(label);
      root.appendChild(zone);
      const st = input.sticks[side];
      let id = -1,
        ox = 0,
        oy = 0;
      zone.addEventListener('pointerdown', (e) => {
        if (id !== -1) return;
        id = e.pointerId;
        zone.setPointerCapture(id);
        const r = zone.getBoundingClientRect();
        ox = e.clientX - r.left;
        oy = e.clientY - r.top;
        base.style.transform = `translate(${ox}px, ${oy}px)`;
        base.classList.add('on');
        st.on = true;
        st.x = st.y = 0;
        e.preventDefault();
      });
      zone.addEventListener('pointermove', (e) => {
        if (e.pointerId !== id) return;
        const r = zone.getBoundingClientRect();
        const dx = e.clientX - r.left - ox,
          dy = e.clientY - r.top - oy;
        const max = 56;
        const l = Math.hypot(dx, dy);
        const k = l > max ? max / l : 1;
        knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
        st.x = clamp(dx / max, -1, 1);
        st.y = clamp(-dy / max, -1, 1);
      });
      const end = (e: PointerEvent) => {
        if (e.pointerId !== id) return;
        id = -1;
        st.on = false;
        st.x = st.y = 0;
        base.classList.remove('on');
        knob.style.transform = '';
      };
      zone.addEventListener('pointerup', end);
      zone.addEventListener('pointercancel', end);
    }
    root.append(this.btn.jump, this.btn.dash, this.btn.special);
  }

  /** tank: TURBO only · mech: JUMP + DASH */
  setUnit(kind: UnitKind): void {
    this.btn.jump.style.display = kind === 'mech' ? '' : 'none';
    this.btn.dash.textContent = kind === 'mech' ? 'DASH' : kind === 'scout' ? 'NITRO' : 'TURBO';
  }

  /** special button: its icon, and how charged it is (0..1) */
  setSpecial(icon: string, charge: number): void {
    const b = this.btn.special;
    if (b.textContent !== icon) b.textContent = icon;
    b.style.setProperty('--charge', String(Math.round(charge * 100) / 100));
    b.classList.toggle('ready', charge >= 1);
  }

  show(on: boolean): void {
    this.root.style.display = on ? '' : 'none';
  }
}
