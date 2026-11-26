import * as THREE from 'three';
import { clamp, damp, lerpAngle } from '../core/math';

/** Camera tuning. */
export const CAMERA = {
  fov: 30, // narrow FOV perspective ~ near-orthographic look
  pitchDeg: 62, // angle from horizontal
  distance: 74, // m from target
  speedZoom: 0.2, // extra distance fraction at top speed
  lookAhead: 0.55, // seconds of velocity to look ahead
  lookAheadMax: 17, // m
  follow: 5, // position smoothing (1/s)
  lookAheadSmooth: 2.2,
  heightSmooth: 4,
  rotateSmooth: 2.5, // when "rotate with car" is enabled
  portraitBoost: 1.55, // max extra distance in portrait
};

export class FollowCamera {
  readonly camera: THREE.PerspectiveCamera;
  private tx = 0;
  private ty = 0;
  private tz = 0;
  private lax = 0;
  private laz = 0;
  yaw = 0;
  private shakeAmt = 0;
  private shakeT = 0;
  private aspect = 1;
  /** current distance camera -> focus point */
  dist = CAMERA.distance;

  constructor() {
    this.camera = new THREE.PerspectiveCamera(CAMERA.fov, 1, 5, 600);
  }

  resize(w: number, h: number): void {
    this.aspect = w / h;
    this.camera.aspect = this.aspect;
    this.camera.updateProjectionMatrix();
  }

  snap(x: number, y: number, z: number, heading: number): void {
    this.tx = x;
    this.ty = y;
    this.tz = z;
    this.lax = this.laz = 0;
    this.yaw = heading;
  }

  shake(amount: number): void {
    this.shakeAmt = Math.max(this.shakeAmt, Math.min(1.2, amount));
  }

  update(dt: number, x: number, y: number, z: number, vx: number, vz: number, heading: number, rotate: boolean): void {
    const speed = Math.hypot(vx, vz);
    let lx = vx * CAMERA.lookAhead,
      lz = vz * CAMERA.lookAhead;
    const ll = Math.hypot(lx, lz);
    if (ll > CAMERA.lookAheadMax) {
      lx *= CAMERA.lookAheadMax / ll;
      lz *= CAMERA.lookAheadMax / ll;
    }
    this.lax = damp(this.lax, lx, CAMERA.lookAheadSmooth, dt);
    this.laz = damp(this.laz, lz, CAMERA.lookAheadSmooth, dt);
    this.tx = damp(this.tx, x + this.lax, CAMERA.follow, dt);
    this.tz = damp(this.tz, z + this.laz, CAMERA.follow, dt);
    this.ty = damp(this.ty, y, CAMERA.heightSmooth, dt);
    if (rotate) this.yaw = lerpAngle(this.yaw, heading, 1 - Math.exp(-CAMERA.rotateSmooth * dt));
    else this.yaw = 0;

    const portrait = clamp(0.8 / this.aspect, 1, CAMERA.portraitBoost);
    const dist = CAMERA.distance * (1 + clamp(speed / 46, 0, 1) * CAMERA.speedZoom) * portrait;
    const pitch = (CAMERA.pitchDeg * Math.PI) / 180;
    this.dist = dist;
    const horiz = Math.cos(pitch) * dist,
      vert = Math.sin(pitch) * dist;
    let sx = 0,
      sz = 0;
    if (this.shakeAmt > 0.001) {
      this.shakeT += dt * 40;
      sx = Math.sin(this.shakeT * 1.3) * this.shakeAmt;
      sz = Math.cos(this.shakeT * 1.7) * this.shakeAmt;
      this.shakeAmt *= Math.exp(-6 * dt);
    }
    const c = this.camera;
    c.position.set(this.tx - Math.sin(this.yaw) * horiz + sx, this.ty + vert, this.tz - Math.cos(this.yaw) * horiz + sz);
    c.lookAt(this.tx + sx, this.ty, this.tz + sz);
    c.updateMatrixWorld();
  }
}
