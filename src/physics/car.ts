import { HANDLING as H } from '../config/handling';
import { SURFACES } from '../config/surfaces';
import { clamp, smoothstep } from '../core/math';
import { ColliderHits, makeGroundSample, type GroundSample, type Terrain } from '../world/terrain';
import { resolveCircleColliders } from './collisions';

export interface CarInput {
  steer: number; // -1 (left) .. 1 (right)
  throttle: number; // 0..1
  brake: number; // 0..1 (brake, then reverse)
  handbrake: boolean;
}

/** Ground interface the car needs (Terrain implements it; tests use a mock). */
export type Ground = Pick<Terrain, 'sample' | 'heightAt' | 'queryColliders'>;

/**
 * Arcade "bicycle" car model on a heightfield.
 *  - heading + world velocity; sideways velocity is decayed by surface grip (drift)
 *  - yaw rate follows a steering target (kinematic bicycle) with extra rotation while sliding
 *  - gravity is projected on the terrain normal (uphill slows, downhill speeds up)
 *  - vertical motion: snaps to ground unless the ballistic path is above it (airtime)
 * Conventions: forward = (sin h, cos h) on XZ, right = (-cos h, sin h). +steer = right.
 */
export class Car {
  x = 0;
  y = 0;
  z = 0;
  vx = 0;
  vy = 0;
  vz = 0;
  heading = 0;
  yawRate = 0;
  airborne = false;
  airTime = 0;
  // previous step (for render interpolation)
  px = 0;
  py = 0;
  pz = 0;
  pHeading = 0;
  // derived (read by audio/fx/hud)
  forwardSpeed = 0;
  lateralSpeed = 0;
  slide = 0; // 0..1 sliding amount
  wheelspin = 0; // 0..1
  surface = 0;
  throttle = 0;
  steerAngle = 0;
  edge = 1e9; // distance from road edge (<0 on road)
  readonly ground: GroundSample = makeGroundSample();
  // smoothed up vector for visuals
  upX = 0;
  upY = 1;
  upZ = 0;
  // visual suspension
  suspOffset = 0;
  suspVel = 0;
  roll = 0;
  pitch = 0;
  // events accumulated since last consume()
  impact = 0;
  landing = 0;
  private hits = new ColliderHits();
  private lastAF = 0;

  reset(x: number, z: number, heading: number, ground: Ground): void {
    this.x = this.px = x;
    this.z = this.pz = z;
    this.heading = this.pHeading = heading;
    this.y = this.py = ground.heightAt(x, z);
    this.vx = this.vy = this.vz = 0;
    this.yawRate = 0;
    this.airborne = false;
    this.airTime = 0;
    this.suspOffset = this.suspVel = 0;
    this.roll = this.pitch = 0;
    this.impact = this.landing = 0;
    this.slide = 0;
    this.forwardSpeed = 0;
    ground.sample(x, z, this.ground);
    this.upX = this.ground.nx;
    this.upY = this.ground.ny;
    this.upZ = this.ground.nz;
  }

  get speed(): number {
    return Math.sqrt(this.vx * this.vx + this.vz * this.vz);
  }

  step(dt: number, inp: CarInput, ground: Ground): void {
    this.px = this.x;
    this.py = this.y;
    this.pz = this.z;
    this.pHeading = this.heading;
    const g = ground.sample(this.x, this.z, this.ground);
    const surf = SURFACES[g.surface];
    this.surface = g.surface;
    this.edge = g.edge;
    this.throttle = inp.throttle;

    let fx = Math.sin(this.heading),
      fz = Math.cos(this.heading);
    let vF = this.vx * fx + this.vz * fz;
    let vL = this.vx * -fz + this.vz * fx;
    const speed = Math.sqrt(this.vx * this.vx + this.vz * this.vz);
    const absF = Math.abs(vF);

    // ---------------- yaw ----------------
    this.steerAngle = (inp.steer * H.maxSteer) / (1 + absF * H.steerSpeedFalloff);
    if (!this.airborne) {
      const grip = surf.grip;
      const slip = speed > 2 ? Math.atan2(Math.abs(vL), absF) : 0;
      this.slide = smoothstep(H.slideAngle * 0.6, H.slideAngle * 1.5, slip);
      let target = -(vF / H.wheelBase) * Math.tan(this.steerAngle);
      target *= smoothstep(0, H.minYawSpeed, absF);
      // sliding: steering rotates the car further (power-slide feel)
      const fwd = vF >= 0 ? 1 : -1;
      target += -inp.steer * H.driftYawBoost * this.slide * Math.min(1, speed / 14) * fwd;
      // grip-limited rotation: at speed full lock gives a slide instead of a spin
      let cap = (H.maxLatAccel * grip) / Math.max(speed, 4) + H.yawCapBase;
      cap *= 1 + this.slide * H.slideYawCap;
      if (inp.handbrake && speed > 3) {
        target *= H.handbrakeYaw;
        cap *= H.handbrakeYaw;
      }
      target = clamp(target, -cap, cap);
      // counter-steer assist: without steering input, rotation settles toward the velocity
      if (Math.abs(inp.steer) < 0.15 && this.slide > 0 && vF > 0) {
        const velAngle = Math.atan2(vL, vF); // + = sliding right
        target += velAngle * -H.counterSteerAssist * 4 * (1 - Math.abs(inp.steer));
      }
      const resp = H.yawResponse * (0.35 + 0.65 * grip);
      this.yawRate += (target - this.yawRate) * Math.min(1, resp * dt);
    } else {
      this.yawRate *= 1 - Math.min(1, 1.2 * dt);
      this.yawRate += -inp.steer * H.airYawControl * dt;
    }
    this.heading += this.yawRate * dt;
    fx = Math.sin(this.heading);
    fz = Math.cos(this.heading);
    vF = this.vx * fx + this.vz * fz;
    vL = this.vx * -fz + this.vz * fx;

    // ---------------- forces ----------------
    let aF = 0;
    if (!this.airborne) {
      const trac = surf.traction;
      if (inp.throttle > 0 && vF < H.topSpeed) {
        const r = Math.max(vF, 0) / H.topSpeed;
        aF += H.engineAccel * trac * inp.throttle * (1 - r * r);
      }
      if (inp.brake > 0) {
        if (vF > 0.5) aF -= H.brakeDecel * trac * inp.brake;
        else if (vF > -H.reverseTopSpeed) aF -= H.reverseAccel * trac * inp.brake;
      }
      if (inp.throttle === 0 && inp.brake === 0) aF -= Math.sign(vF) * Math.min(H.engineBraking, Math.abs(vF) / dt);
      if (inp.handbrake) aF -= Math.sign(vF) * Math.min(H.handbrakeDecel, Math.abs(vF) / dt);
      let nF = vF + aF * dt;
      if (inp.brake > 0 && vF > 0.5 && nF < 0) nF = 0;
      nF *= 1 - surf.rollDrag * dt;
      // lateral grip
      let latGrip = H.lateralGrip * surf.grip * (1 + (H.slideGrip - 1) * this.slide);
      if (inp.handbrake) latGrip *= H.handbrakeGrip;
      const nL = vL * Math.exp(-latGrip * dt);
      const scrub = Math.abs(vL) - Math.abs(nL);
      if (nF > 1) nF += scrub * H.slideBoost;
      // wheelspin (loose surface, full throttle, low speed) -> dust + revs
      this.wheelspin = clamp(inp.throttle * (1 - trac * 0.9) * (1 - Math.min(1, Math.abs(nF) / 18)) * 2.2, 0, 1);
      this.vx = fx * nF - fz * nL;
      this.vz = fz * nF + fx * nL;
      // gravity along the slope
      const k = H.slopeGravity * g.ny * dt;
      this.vx += k * g.nx;
      this.vz += k * g.nz;
      // parked: don't creep
      if (speed < 0.4 && inp.throttle === 0 && inp.brake === 0) {
        this.vx *= 0.8;
        this.vz *= 0.8;
      }
      this.forwardSpeed = nF;
      this.lateralSpeed = nL;
    } else {
      const d = 1 - H.airDrag * dt;
      this.vx *= d;
      this.vz *= d;
      this.forwardSpeed = vF;
      this.lateralSpeed = vL;
      this.wheelspin = inp.throttle;
      this.slide = 0;
    }
    this.lastAF = this.airborne ? 0 : aF;

    // ---------------- integrate ----------------
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    this.collide(ground);
    this.vertical(dt, ground);
    this.visuals(dt);
  }

  private vertical(dt: number, ground: Ground): void {
    const G = H.airGravity;
    const gNew = ground.heightAt(this.x, this.z);
    if (!this.airborne) {
      const yB = this.y + this.vy * dt - 0.5 * G * dt * dt;
      if (yB > gNew + H.airborneGap && this.vy > 0.5) {
        this.airborne = true;
        this.airTime = 0;
        this.y = yB;
        this.vy -= G * dt;
      } else {
        this.vy = (gNew - this.y) / dt;
        // clamp absurd values caused by teleports/resets
        if (this.vy > 25) this.vy = 25;
        else if (this.vy < -25) this.vy = -25;
        this.y = gNew;
      }
    } else {
      this.vy -= G * dt;
      this.y += this.vy * dt;
      this.airTime += dt;
      if (this.y <= gNew) {
        const gPrev = ground.heightAt(this.px, this.pz);
        const groundRate = (gNew - gPrev) / dt;
        const impact = Math.max(0, groundRate - this.vy);
        this.y = gNew;
        this.vy = groundRate;
        this.airborne = false;
        this.landing = Math.max(this.landing, impact);
        const loss = 1 - Math.min(0.35, Math.max(0, impact - 3) * H.landingSpeedLoss);
        this.vx *= loss;
        this.vz *= loss;
        this.suspVel -= impact * 0.5;
        this.airTime = 0;
      }
    }
  }

  private collide(ground: Ground): void {
    const fx = Math.sin(this.heading),
      fz = Math.cos(this.heading);
    for (let c = -1; c <= 1; c += 2) {
      const cx = this.x + fx * H.colliderOffset * c;
      const cz = this.z + fz * H.colliderOffset * c;
      ground.queryColliders(cx, cz, H.colliderRadius, this.hits);
      const r = resolveCircleColliders(this, cx, cz, H.colliderRadius, this.hits);
      if (r > this.impact) this.impact = r;
    }
  }

  private visuals(dt: number): void {
    const g = this.ground;
    const k = this.airborne ? 1.5 : 12;
    const a = Math.min(1, k * dt);
    if (this.airborne) {
      // level out slowly, nose follows the trajectory a bit
      this.upX += (0 - this.upX) * a;
      this.upY += (1 - this.upY) * a;
      this.upZ += (0 - this.upZ) * a;
    } else {
      this.upX += (g.nx - this.upX) * a;
      this.upY += (g.ny - this.upY) * a;
      this.upZ += (g.nz - this.upZ) * a;
    }
    // suspension spring (visual)
    this.suspVel += (-H.suspStiffness * this.suspOffset - H.suspDamping * this.suspVel) * dt;
    this.suspOffset += this.suspVel * dt;
    this.suspOffset = clamp(this.suspOffset, -0.35, 0.25);
    const latAcc = this.airborne ? 0 : this.forwardSpeed * this.yawRate;
    const targetRoll = clamp(latAcc * H.bodyRoll, -0.12, 0.12);
    let targetPitch = clamp(-this.lastAF * H.bodyPitch, -0.08, 0.08);
    if (this.airborne) targetPitch = clamp(-this.vy * 0.02, -0.25, 0.25);
    this.roll += (targetRoll - this.roll) * Math.min(1, 8 * dt);
    this.pitch += (targetPitch - this.pitch) * Math.min(1, (this.airborne ? 3 : 8) * dt);
  }

  /** Returns and clears collision / landing events (m/s). */
  consumeEvents(out: { impact: number; landing: number }): void {
    out.impact = this.impact;
    out.landing = this.landing;
    this.impact = 0;
    this.landing = 0;
  }
}
