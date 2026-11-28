import { SURFACES } from '@engine/config/surfaces';
import { clamp, wrapAngle } from '@engine/core/math';
import { resolveCircleColliders } from '@engine/physics/collisions';
import { ColliderHits, makeGroundSample, type Terrain } from '@engine/world/terrain';

/** Ground interface a unit needs (Terrain implements it; tests use a mock). */
export type Ground = Pick<Terrain, 'sample' | 'heightAt' | 'queryColliders'>;

/** Tank tuning. Units: metres, seconds, radians. */
export const TANK = {
  accel: 13,
  maxSpeed: 15,
  reverseSpeed: 7,
  drag: 1.2, // 1/s when coasting
  turnRate: 1.9, // hull pivot (rad/s)
  lateralGrip: 10, // tracks hardly slide
  radius: 2.2,
  turretRate: 3.4, // rad/s
  maxHp: 100,
  mass: 4000,
  reload: 0.55, // s between shells
  shellSpeed: 70,
  muzzle: 3.4, // barrel length from the turret pivot
  turretHeight: 2.0,
};

/**
 * What a unit is asked to do this step. Movement is "screen-relative": the player points
 * where they want to go (a world direction); the tank turns its hull toward it and drives.
 */
export interface UnitInput {
  /** desired move direction (world x/z) and strength 0..1 */
  moveX: number;
  moveZ: number;
  move: number;
  /** turret aim: world yaw, or null to keep the current aim */
  aimYaw: number | null;
  fire: boolean;
}

export const NO_UNIT_INPUT: UnitInput = { moveX: 0, moveZ: 0, move: 0, aimYaw: null, fire: false };

/** A tracked tank: pivot turning, no drifting, an independent turret. */
export class Tank {
  x = 0;
  y = 0;
  z = 0;
  vx = 0;
  vz = 0;
  heading = 0;
  yawRate = 0;
  /** turret yaw in world space */
  turret = 0;
  hp = TANK.maxHp;
  reload = 0;
  /** -1..1 forward speed fraction, for the engine sound and track animation */
  drive = 0;
  // previous step (render interpolation)
  px = 0;
  pz = 0;
  pHeading = 0;
  pTurret = 0;
  // smoothed ground normal (visual tilt)
  upX = 0;
  upY = 1;
  upZ = 0;
  /** set when the cannon fired this step (the game spawns the shell) */
  fired = false;
  /** strongest bump into something solid this step (m/s) */
  impact = 0;
  private hits = new ColliderHits();
  private g = makeGroundSample();

  get speed(): number {
    return Math.hypot(this.vx, this.vz);
  }

  get alive(): boolean {
    return this.hp > 0;
  }

  reset(x: number, z: number, heading: number, ground: Ground): void {
    this.x = this.px = x;
    this.z = this.pz = z;
    this.heading = this.pHeading = this.turret = this.pTurret = heading;
    this.vx = this.vz = this.yawRate = 0;
    this.y = ground.heightAt(x, z);
    this.hp = TANK.maxHp;
    this.reload = 0;
  }

  step(dt: number, inp: UnitInput, ground: Ground): void {
    this.px = this.x;
    this.pz = this.z;
    this.pHeading = this.heading;
    this.pTurret = this.turret;
    this.fired = false;
    this.impact = 0;
    const g = ground.sample(this.x, this.z, this.g);
    const surf = SURFACES[g.surface];
    const trac = 0.75 + 0.25 * surf.traction; // tracks care less about the surface

    // ---- hull: turn toward where the player points, drive when roughly facing it ----
    let throttle = 0;
    if (inp.move > 0.08) {
      const want = Math.atan2(inp.moveX, inp.moveZ);
      let diff = wrapAngle(want - this.heading);
      // pointing backwards: back up instead of a slow 180° turn
      let dir = 1;
      if (Math.abs(diff) > 2.2) {
        diff = wrapAngle(diff + Math.PI);
        dir = -1;
      }
      this.yawRate = clamp(diff * 4, -TANK.turnRate, TANK.turnRate);
      throttle = dir * inp.move * Math.max(0, Math.cos(diff)) ** 2;
    } else this.yawRate *= Math.exp(-10 * dt);
    this.heading = wrapAngle(this.heading + this.yawRate * dt);

    const fx = Math.sin(this.heading),
      fz = Math.cos(this.heading);
    let vF = this.vx * fx + this.vz * fz;
    let vL = this.vx * -fz + this.vz * fx;
    if (throttle > 0 && vF < TANK.maxSpeed) vF += TANK.accel * trac * throttle * (1 - Math.max(0, vF) / TANK.maxSpeed) * dt;
    else if (throttle < 0 && vF > -TANK.reverseSpeed) vF += TANK.accel * 0.7 * trac * throttle * dt;
    else vF *= Math.exp(-TANK.drag * dt);
    vF *= 1 - surf.rollDrag * 0.5 * dt;
    vL *= Math.exp(-TANK.lateralGrip * dt);
    this.vx = fx * vF - fz * vL;
    this.vz = fz * vF + fx * vL;
    this.drive = clamp(vF / TANK.maxSpeed, -1, 1);

    // ---- move, bump into solid props ----
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    ground.queryColliders(this.x, this.z, TANK.radius, this.hits);
    const before = this.speed;
    resolveCircleColliders(this, this.x, this.z, TANK.radius, this.hits);
    this.impact = Math.max(0, before - this.speed);
    this.y = ground.heightAt(this.x, this.z);
    const k = Math.min(1, 8 * dt);
    this.upX += (g.nx - this.upX) * k;
    this.upY += (g.ny - this.upY) * k;
    this.upZ += (g.nz - this.upZ) * k;

    // ---- turret + cannon ----
    if (inp.aimYaw != null) {
      const d = wrapAngle(inp.aimYaw - this.turret);
      const max = TANK.turretRate * dt;
      this.turret = wrapAngle(this.turret + clamp(d, -max, max));
    }
    this.reload = Math.max(0, this.reload - dt);
    if (inp.fire && this.reload <= 0 && this.alive) {
      this.reload = TANK.reload;
      this.fired = true;
    }
  }

  /** where a shell leaves the barrel, and its velocity */
  muzzle(out: { x: number; y: number; z: number; vx: number; vy: number; vz: number }): void {
    const s = Math.sin(this.turret),
      c = Math.cos(this.turret);
    out.x = this.x + s * TANK.muzzle;
    out.y = this.y + TANK.turretHeight;
    out.z = this.z + c * TANK.muzzle;
    out.vx = s * TANK.shellSpeed + this.vx;
    out.vy = 1.2;
    out.vz = c * TANK.shellSpeed + this.vz;
  }
}
