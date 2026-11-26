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

/** Third-person chase camera tuning. */
export const CHASE = {
  fov: 62,
  distance: 7.2, // m behind the car
  speedPull: 2.6, // extra distance at top speed
  height: 2.9, // m above the car
  lookAhead: 7, // look at a point this far ahead of the car
  lookHeight: 1.1,
  yawSmooth: 5.5, // how quickly the camera swings behind the car (1/s)
  velocityBlend: 0.35, // 0 = follow the nose, 1 = follow the direction of travel (drifts)
  heightSmooth: 6,
  minClearance: 1.3, // keep at least this far above the ground
};

export type CameraMode = 'top' | 'chase';

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
  /** distance multiplier (garage close-up), smoothed toward zoomTarget */
  zoom = 1;
  zoomTarget = 1;
  /** 0..1: push the car toward the top of the screen (garage preview above the panel) */
  shift = 0;
  shiftTarget = 0;
  /** current distance camera -> focus point */
  dist = CAMERA.distance;
  /** 'top' = high top-down view (default), 'chase' = third person behind the car */
  mode: CameraMode = 'top';
  private appliedMode: CameraMode | '' = '';
  /** terrain height, so the chase camera never dips into a hill */
  ground: ((x: number, z: number) => number) | null = null;

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
    if (this.mode !== this.appliedMode) {
      const c = this.camera;
      const chase = this.mode === 'chase';
      c.fov = chase ? CHASE.fov : CAMERA.fov;
      c.near = chase ? 0.3 : 5;
      c.far = chase ? 900 : 600;
      c.updateProjectionMatrix();
      if (chase) {
        this.yaw = heading;
        this.ty = y;
      }
      this.appliedMode = this.mode;
    }
    if (this.mode === 'chase') return this.updateChase(dt, x, y, z, vx, vz, heading, speed);
    let lx = vx * CAMERA.lookAhead,
      lz = vz * CAMERA.lookAhead;
    const ll = Math.hypot(lx, lz);
    if (ll > CAMERA.lookAheadMax) {
      lx *= CAMERA.lookAheadMax / ll;
      lz *= CAMERA.lookAheadMax / ll;
    }
    this.shift = damp(this.shift, this.shiftTarget, 3, dt);
    lx *= 1 - this.shift;
    lz *= 1 - this.shift;
    this.lax = damp(this.lax, lx, CAMERA.lookAheadSmooth, dt);
    this.laz = damp(this.laz, lz, CAMERA.lookAheadSmooth, dt);
    this.tx = damp(this.tx, x + this.lax, CAMERA.follow, dt);
    this.tz = damp(this.tz, z + this.laz, CAMERA.follow, dt);
    this.ty = damp(this.ty, y, CAMERA.heightSmooth, dt);
    if (rotate) this.yaw = lerpAngle(this.yaw, heading, 1 - Math.exp(-CAMERA.rotateSmooth * dt));
    else this.yaw = 0;

    const portrait = clamp(0.8 / this.aspect, 1, CAMERA.portraitBoost);
    this.zoom = damp(this.zoom, this.zoomTarget, 3, dt);
    const dist = CAMERA.distance * (1 + clamp(speed / 46, 0, 1) * CAMERA.speedZoom) * portrait * this.zoom;
    const pitch = (CAMERA.pitchDeg * Math.PI) / 180;
    this.dist = dist;
    // screen-up is +z (fixed camera): focusing below the car moves it up the screen
    const shiftM = this.shift * dist * 0.085 * portrait;
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
    const fx = this.tx - Math.sin(this.yaw) * shiftM,
      fz = this.tz - Math.cos(this.yaw) * shiftM;
    c.position.set(fx - Math.sin(this.yaw) * horiz + sx, this.ty + vert, fz - Math.cos(this.yaw) * horiz + sz);
    c.lookAt(fx + sx, this.ty, fz + sz);
    c.updateMatrixWorld();
  }

  private updateChase(dt: number, x: number, y: number, z: number, vx: number, vz: number, heading: number, speed: number): void {
    // swing behind the car; while drifting partly follow the direction of travel
    let target = heading;
    if (speed > 4) target = lerpAngle(heading, Math.atan2(vx, vz), CHASE.velocityBlend * clamp((speed - 4) / 10, 0, 1));
    this.yaw = lerpAngle(this.yaw, target, 1 - Math.exp(-CHASE.yawSmooth * dt));
    this.ty = damp(this.ty, y, CHASE.heightSmooth, dt);
    this.tx = x;
    this.tz = z;
    const dist = CHASE.distance + clamp(speed / 46, 0, 1) * CHASE.speedPull;
    this.dist = dist;
    const fx = Math.sin(this.yaw),
      fz = Math.cos(this.yaw);
    const px = x - fx * dist,
      pz = z - fz * dist;
    let py = this.ty + CHASE.height;
    if (this.ground) py = Math.max(py, this.ground(px, pz) + CHASE.minClearance);
    let sx = 0,
      sy = 0;
    if (this.shakeAmt > 0.001) {
      this.shakeT += dt * 40;
      sx = Math.sin(this.shakeT * 1.3) * this.shakeAmt * 0.25;
      sy = Math.cos(this.shakeT * 1.7) * this.shakeAmt * 0.2;
      this.shakeAmt *= Math.exp(-6 * dt);
    }
    const c = this.camera;
    c.position.set(px + sx * fz, py + sy, pz - sx * fx);
    c.lookAt(x + fx * CHASE.lookAhead, this.ty + CHASE.lookHeight, z + fz * CHASE.lookAhead);
    c.updateMatrixWorld();
  }
}
