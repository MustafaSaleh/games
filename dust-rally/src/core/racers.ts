import * as THREE from 'three';
import { Car } from '../physics/car';
import { FollowCamera } from '../render/camera';
import { BlobShadow, Headlights } from '../render/effects';
import { buildCar, disposeCar, type CarModel } from '../render/models';
import { CAR_LIVERIES, getLivery, getStyle, type Livery } from '../config/cars';
import type { TrackPath } from '../world/track';
import type { Race } from './race';
import { Input } from './input';
import type { MpPlayer, PoseArr } from '../net/session';

/** Grid slots: side by side, then a second row. */
export function gridSlot(tr: TrackPath, startIdx: number, slot: number, solo: boolean): { x: number; z: number; heading: number } {
  const x = tr.x(startIdx),
    z = tr.z(startIdx);
  const heading = Math.atan2(tr.dx(startIdx), tr.dz(startIdx));
  if (solo) return { x, z, heading };
  const fx = Math.sin(heading),
    fz = Math.cos(heading);
  const side = slot % 2 === 0 ? -2.1 : 2.1;
  const back = Math.floor(slot / 2) * 7;
  return { x: x + fz * side - fx * back, z: z - fx * side - fz * back, heading };
}

/** A livery different from `taken`, for the second split-screen player. */
export function otherLivery(taken: string): Livery {
  const prefer = ['blue', 'red', 'yellow', 'green'];
  return getLivery(prefer.find((id) => id !== taken) ?? CAR_LIVERIES[1].id);
}

export function liveryCss(id: string): string {
  return '#' + getLivery(id).body.toString(16).padStart(6, '0');
}

/** Split-screen player 2: own car, camera, race, controls and effects. */
export class LocalRacer {
  readonly car = new Car();
  readonly cam = new FollowCamera();
  readonly input = new Input();
  readonly shadow = new BlobShadow();
  readonly headlights = new Headlights();
  readonly model: CarModel;
  race!: Race;
  finishTime: number | null = null;
  readonly ev = { impact: 0, landing: 0 };
  /** tomatoes to throw (multiplayer fun) */
  ammo = 0;

  constructor(
    readonly name: string,
    readonly livery: Livery,
    style: string,
    private scene: THREE.Scene,
  ) {
    this.input.scheme = 'p2';
    this.model = buildCar(getStyle(style).id, livery);
    scene.add(this.model.root, this.shadow.mesh, this.headlights.group);
  }

  dispose(): void {
    disposeCar(this.model);
    this.scene.remove(this.shadow.mesh, this.headlights.group);
  }
}

interface Sample {
  at: number; // local receive time (ms)
  p: PoseArr;
}

const DELAY = 140; // ms of interpolation delay

/** Another online player's car: interpolated from network poses, with a name tag. */
export class RemoteCar {
  readonly model: CarModel;
  readonly label: HTMLDivElement;
  private samples: Sample[] = [];
  finishTime: number | null = null;
  gone = false;
  /** latest progress along the track (m) and pose, for the minimap / positions */
  progress = 0;
  x = 0;
  z = 0;
  heading = 0;
  vx = 0;
  vz = 0;
  visible = false;
  private v = new THREE.Vector3();

  constructor(
    readonly player: MpPlayer,
    scene: THREE.Scene,
    labelLayer: HTMLElement,
  ) {
    this.model = buildCar(getStyle(player.style).id, getLivery(player.livery));
    this.model.root.visible = false;
    scene.add(this.model.root);
    this.label = document.createElement('div');
    this.label.className = 'name-tag';
    this.label.textContent = player.name;
    this.label.style.setProperty('--c', liveryCss(player.livery));
    labelLayer.appendChild(this.label);
  }

  push(p: PoseArr): void {
    if (!Array.isArray(p) || p.length < 9 || !p.every(Number.isFinite)) return;
    this.samples.push({ at: performance.now(), p });
    if (this.samples.length > 30) this.samples.shift();
    this.progress = p[7];
  }

  /** returns [x,y,z,heading,upX,upZ] at render time, or null when there is nothing yet */
  sample(now: number, out: number[]): boolean {
    const s = this.samples;
    if (!s.length) return false;
    const t = now - DELAY;
    let a = s[0],
      b = s[0];
    for (let i = s.length - 1; i >= 0; i--)
      if (s[i].at <= t) {
        a = s[i];
        b = s[Math.min(i + 1, s.length - 1)];
        break;
      }
    const k = b.at > a.at ? Math.min(1, Math.max(0, (t - a.at) / (b.at - a.at))) : 1;
    // velocity at this moment, from how far the car moved between the two samples (race time p[0])
    const dt = b.p[0] - a.p[0];
    if (dt > 0.01) {
      this.vx = (b.p[1] - a.p[1]) / dt;
      this.vz = (b.p[3] - a.p[3]) / dt;
    } else if (b === s[s.length - 1] && t > b.at + 300) this.vx = this.vz = 0;
    for (let i = 0; i < 6; i++) {
      const j = i + 1;
      if (j === 4) {
        let d = b.p[j] - a.p[j];
        d = Math.atan2(Math.sin(d), Math.cos(d));
        out[i] = a.p[j] + d * k;
      } else out[i] = a.p[j] + (b.p[j] - a.p[j]) * k;
    }
    this.x = out[0];
    this.z = out[2];
    this.heading = out[3];
    return true;
  }

  private tmp = [0, 0, 0, 0, 0, 0];
  /** collision body at render time (kinematic: velocity measured from the interpolated samples) */
  body(now: number, out: { x: number; y: number; z: number; vx: number; vz: number; heading: number; yawRate: number }): boolean {
    if (!this.sample(now, this.tmp)) return false;
    const b = this.tmp;
    out.x = b[0];
    out.y = b[1];
    out.z = b[2];
    out.heading = b[3];
    out.vx = this.vx;
    out.vz = this.vz;
    out.yawRate = 0;
    return true;
  }

  /** place the HTML name tag over the car */
  placeLabel(camera: THREE.Camera, w: number, h: number, y: number): void {
    const v = this.v.set(this.x, y + 2.6, this.z).project(camera);
    const on = this.visible && v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
    this.label.style.display = on ? '' : 'none';
    if (on) this.label.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -100%)`;
  }

  dispose(): void {
    disposeCar(this.model);
    this.label.remove();
  }
}
