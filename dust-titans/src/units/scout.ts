import { clamp, wrapAngle } from '@engine/core/math';
import { resolveCircleColliders } from '@engine/physics/collisions';
import { ColliderHits, makeGroundSample } from '@engine/world/terrain';
import { SURFACES } from '@engine/config/surfaces';
import type { Ground, Muzzle, Unit, UnitInput, UnitSpec } from './unit';

/** Scout tuning: a Dust Rally buggy with a mini turret. Fast, fragile, drifts. */
export const SCOUT = {
  accel: 22,
  maxSpeed: 24,
  reverseSpeed: 10,
  drag: 0.8,
  /** steering: rad/s at full lock, scaled by speed */
  steer: 2.6,
  lateralGrip: 5.5,
  radius: 1.6,
  turretRate: 7,
  maxHp: 55,
  mass: 1100,
  reload: 0.12,
  shotSpeed: 95,
  muzzle: 1.4,
  turretHeight: 1.75,
  nitroSpeed: 36,
  nitroAccel: 40,
  nitroDrain: 0.8,
  energyRegen: 0.28,
};

export const SCOUT_SPEC: UnitSpec = {
  kind: 'scout',
  name: 'Scout',
  blurb: 'A rally buggy with a mini-gun. The fastest unit: grab crates first, then zoom away.',
  maxHp: SCOUT.maxHp,
  radius: SCOUT.radius,
  mass: SCOUT.mass,
  hitHeight: 1.1,
  shot: 'pellet',
  icon: '🏎️',
  maxSpeed: SCOUT.maxSpeed,
  reload: SCOUT.reload,
  aimHeight: 0,
  hitR: 1.5,
  tagHeight: 3.4,
  bubble: [2.8, 1.1],
  chase: 1.1,
  upright: 1,
  push: 0.6,
  bars: { armour: 0.3, speed: 1, firepower: 0.45, agility: 0.85 },
  ability: '🔥 Nitro',
};

export class Scout implements Unit {
  readonly kind = 'scout' as const;
  readonly spec = SCOUT_SPEC;
  x = 0;
  y = 0;
  z = 0;
  vx = 0;
  vy = 0;
  vz = 0;
  heading = 0;
  yawRate = 0;
  turret = 0;
  hp = SCOUT.maxHp;
  reload = 0;
  energy = 1;
  drive = 0;
  airborne = false;
  landed = 0;
  dashing = false;
  px = 0;
  py = 0;
  pz = 0;
  pHeading = 0;
  pTurret = 0;
  upX = 0;
  upY = 1;
  upZ = 0;
  fired = false;
  impact = 0;
  reloadScale = 1;
  energyMul = 1;
  /** -1..1 steering (front wheels) */
  steerAngle = 0;
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
    this.y = this.py = ground.heightAt(x, z);
    this.hp = SCOUT.maxHp;
    this.reload = 0;
    this.energy = 1;
    this.reloadScale = 1;
  }

  step(dt: number, inp: UnitInput, ground: Ground): void {
    this.px = this.x;
    this.py = this.y;
    this.pz = this.z;
    this.pHeading = this.heading;
    this.pTurret = this.turret;
    this.fired = false;
    this.impact = 0;
    const g = ground.sample(this.x, this.z, this.g);
    const surf = SURFACES[g.surface];
    const fx = Math.sin(this.heading),
      fz = Math.cos(this.heading);
    let vF = this.vx * fx + this.vz * fz;
    let vL = this.vx * -fz + this.vz * fx;

    // steer toward where the player points (a car can't spin on the spot)
    let throttle = 0,
      steer = 0;
    if (inp.move > 0.08) {
      const want = Math.atan2(inp.moveX, inp.moveZ);
      let diff = wrapAngle(want - this.heading);
      let dir = 1;
      if (Math.abs(diff) > 2.5 && vF < 4) {
        diff = wrapAngle(diff + Math.PI); // reverse out
        dir = -1;
      }
      steer = clamp(diff * 2, -1, 1);
      throttle = dir * inp.move * (Math.abs(diff) > 1.6 ? 0.5 : 1);
    }
    this.steerAngle += (steer - this.steerAngle) * Math.min(1, 10 * dt);
    const grip = 0.55 + 0.45 * surf.grip;
    const speedK = clamp(Math.abs(vF) / 6, 0, 1) * (1 - clamp((Math.abs(vF) - 20) / 30, 0, 0.4));
    this.yawRate = this.steerAngle * SCOUT.steer * speedK * Math.sign(vF || 1) * grip;
    this.heading = wrapAngle(this.heading + this.yawRate * dt);

    // nitro
    this.dashing = !!inp.dash && this.energy > 0.05 && this.alive;
    this.energy = this.dashing ? Math.max(0, this.energy - SCOUT.nitroDrain * dt) : Math.min(1, this.energy + SCOUT.energyRegen * this.energyMul * dt);
    if (this.dashing && throttle >= 0) throttle = 1;
    const top = this.dashing ? SCOUT.nitroSpeed : SCOUT.maxSpeed;
    const acc = (this.dashing ? SCOUT.nitroAccel : SCOUT.accel) * (0.6 + 0.4 * surf.traction);
    if (throttle > 0 && vF < top) vF += acc * throttle * (1 - Math.max(0, vF) / top) * dt;
    else if (throttle < 0 && vF > -SCOUT.reverseSpeed) vF += SCOUT.accel * 0.8 * throttle * dt;
    else vF *= Math.exp(-SCOUT.drag * dt);
    vF *= 1 - surf.rollDrag * dt;
    vL *= Math.exp(-SCOUT.lateralGrip * grip * dt);
    const nfx = Math.sin(this.heading),
      nfz = Math.cos(this.heading);
    this.vx = nfx * vF - nfz * vL;
    this.vz = nfz * vF + nfx * vL;
    this.drive = clamp(vF / SCOUT.maxSpeed, -1, 1);

    this.x += this.vx * dt;
    this.z += this.vz * dt;
    ground.queryColliders(this.x, this.z, SCOUT.radius, this.hits);
    const before = this.speed;
    resolveCircleColliders(this, this.x, this.z, SCOUT.radius, this.hits);
    this.impact = Math.max(0, before - this.speed);
    this.y = ground.heightAt(this.x, this.z);
    const k = Math.min(1, 10 * dt);
    this.upX += (g.nx - this.upX) * k;
    this.upY += (g.ny - this.upY) * k;
    this.upZ += (g.nz - this.upZ) * k;

    if (inp.aimYaw != null) {
      const d = wrapAngle(inp.aimYaw - this.turret);
      const max = SCOUT.turretRate * dt;
      this.turret = wrapAngle(this.turret + clamp(d, -max, max));
    }
    this.reload = Math.max(0, this.reload - dt);
    if (inp.fire && this.reload <= 0 && this.alive) {
      this.reload = SCOUT.reload * this.reloadScale;
      this.fired = true;
    }
  }

  muzzle(out: Muzzle, spread = 0): void {
    const jitter = (Math.random() - 0.5) * 0.05;
    const s = Math.sin(this.turret + spread + jitter),
      c = Math.cos(this.turret + spread + jitter);
    out.x = this.x + s * SCOUT.muzzle;
    out.y = this.y + SCOUT.turretHeight;
    out.z = this.z + c * SCOUT.muzzle;
    out.vx = s * SCOUT.shotSpeed + this.vx;
    out.vy = 0.4;
    out.vz = c * SCOUT.shotSpeed + this.vz;
  }
}
