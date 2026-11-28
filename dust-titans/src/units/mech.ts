import { clamp, wrapAngle } from '@engine/core/math';
import { resolveCircleColliders } from '@engine/physics/collisions';
import { ColliderHits, makeGroundSample } from '@engine/world/terrain';
import type { Ground, Muzzle, Unit, UnitInput, UnitSpec } from './unit';

/** Mech tuning. Units: metres, seconds, radians. */
export const MECH = {
  maxSpeed: 11,
  accel: 38,
  airControl: 0.45,
  turnRate: 7, // legs face where you walk
  torsoRate: 9, // the arm cannon aims on its own
  radius: 1.6,
  maxHp: 80,
  mass: 1500,
  reload: 0.2,
  shotSpeed: 85,
  muzzleHeight: 3.7,
  muzzleForward: 1.9,
  muzzleSide: 1.35, // right arm
  jumpSpeed: 11.5,
  gravity: 26,
  /** holding jump while falling fires the jets: much less gravity, uses energy */
  jetGravity: 0.28,
  jetDrain: 0.55,
  dashSpeed: 30,
  dashTime: 0.22,
  dashCost: 0.34,
  dashCooldown: 0.45,
  energyRegen: 0.32,
  /** a landing this hard (fall speed m/s) stomps the ground */
  stompSpeed: 9,
};

export const MECH_SPEC: UnitSpec = {
  kind: 'mech',
  name: 'Robot suit',
  blurb: 'Walks anywhere, jumps over rocks, dashes out of danger. Rapid arm cannon.',
  maxHp: MECH.maxHp,
  radius: MECH.radius,
  mass: MECH.mass,
  hitHeight: 2.6,
  shot: 'bolt',
  icon: '🤖',
  maxSpeed: MECH.maxSpeed,
  reload: MECH.reload,
  aimHeight: 2.6,
  hitR: 1.7,
  tagHeight: 6.4,
  bubble: [3.6, 2.8],
  chase: 1.9,
  upright: 0.35,
  push: 0.5,
  bars: { armour: 0.6, speed: 0.75, firepower: 0.6, agility: 0.95 },
  ability: '🦘 Jump-jets + 💨 dash',
};

/** A walking robot suit: strafes freely, jump-jets, dash, stomp on landing. */
export class Mech implements Unit {
  readonly kind = 'mech' as const;
  readonly spec = MECH_SPEC;
  x = 0;
  y = 0;
  z = 0;
  vx = 0;
  vy = 0;
  vz = 0;
  heading = 0;
  yawRate = 0;
  turret = 0;
  hp = MECH.maxHp;
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
  /** metres walked (leg animation phase) */
  stride = 0;
  /** jets firing this step (flames) */
  jets = false;
  private dashT = 0;
  private dashCd = 0;
  private dashX = 0;
  private dashZ = 0;
  private jumpHeld = false;
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
    this.vx = this.vy = this.vz = this.yawRate = 0;
    this.y = this.py = ground.heightAt(x, z);
    this.hp = MECH.maxHp;
    this.reload = this.dashT = this.dashCd = 0;
    this.energy = 1;
    this.airborne = false;
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
    this.landed = 0;
    this.jets = false;
    const alive = this.alive;

    // ---- dash ----
    this.dashCd = Math.max(0, this.dashCd - dt);
    if (alive && inp.dash && this.dashT <= 0 && this.dashCd <= 0 && this.energy >= MECH.dashCost) {
      let dx = inp.moveX,
        dz = inp.moveZ;
      if (inp.move < 0.1) {
        dx = Math.sin(this.heading);
        dz = Math.cos(this.heading);
      }
      const l = Math.hypot(dx, dz) || 1;
      this.dashX = dx / l;
      this.dashZ = dz / l;
      this.dashT = MECH.dashTime;
      this.dashCd = MECH.dashCooldown;
      this.energy -= MECH.dashCost;
    }
    this.dashing = this.dashT > 0;

    // ---- walking ----
    if (this.dashing) {
      this.dashT -= dt;
      this.vx = this.dashX * MECH.dashSpeed;
      this.vz = this.dashZ * MECH.dashSpeed;
    } else {
      const m = alive ? clamp(inp.move, 0, 1) : 0;
      const ml = Math.hypot(inp.moveX, inp.moveZ);
      const k = m > 0.08 && ml > 1e-6 ? (MECH.maxSpeed * m) / ml : 0;
      const wx = inp.moveX * k,
        wz = inp.moveZ * k;
      const lim = MECH.accel * (this.airborne ? MECH.airControl : 1) * dt;
      let dvx = wx - this.vx,
        dvz = wz - this.vz;
      const dl = Math.hypot(dvx, dvz);
      if (dl > lim) {
        dvx *= lim / dl;
        dvz *= lim / dl;
      }
      this.vx += dvx;
      this.vz += dvz;
    }
    const sp = this.speed;
    if (sp > 1.2) {
      const want = Math.atan2(this.vx, this.vz);
      const d = wrapAngle(want - this.heading);
      this.yawRate = clamp(d * 10, -MECH.turnRate, MECH.turnRate);
    } else this.yawRate *= Math.exp(-12 * dt);
    this.heading = wrapAngle(this.heading + this.yawRate * dt);
    this.drive = clamp(sp / MECH.maxSpeed, 0, 1);

    // ---- jump-jets + gravity ----
    const jumpEdge = !!inp.jump && !this.jumpHeld;
    this.jumpHeld = !!inp.jump;
    if (alive && jumpEdge && !this.airborne) {
      this.vy = MECH.jumpSpeed;
      this.airborne = true;
      this.jets = true;
    }
    if (this.airborne) {
      let gScale = 1;
      if (alive && inp.jump && this.vy < 3 && this.energy > 0.02) {
        gScale = MECH.jetGravity;
        this.energy = Math.max(0, this.energy - MECH.jetDrain * dt);
        this.jets = true;
      }
      this.vy -= MECH.gravity * gScale * dt;
    }

    // ---- move, props (jump over them), ground ----
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    this.y += this.vy * dt;
    ground.queryColliders(this.x, this.z, MECH.radius, this.hits);
    const before = this.speed;
    resolveCircleColliders(this, this.x, this.z, MECH.radius, this.hits);
    this.impact = Math.max(0, before - this.speed);
    const g = ground.sample(this.x, this.z, this.g);
    const gh = g.h;
    if (this.airborne) {
      if (this.y <= gh) {
        this.landed = Math.max(0.01, -this.vy);
        this.y = gh;
        this.vy = 0;
        this.airborne = false;
      }
    } else if (this.y - gh > 0.8) {
      this.airborne = true; // walked off a ledge
    } else {
      this.y = gh; // legs climb any slope
      this.vy = 0;
    }
    if (!this.airborne) this.stride += sp * dt;
    if (!this.jets && !this.dashing) this.energy = Math.min(1, this.energy + MECH.energyRegen * this.energyMul * (this.airborne ? 0.3 : 1) * dt);
    const k = Math.min(1, 6 * dt);
    this.upX += (g.nx * 0.35 - this.upX) * k; // mechs stay mostly upright
    this.upY += (1 - this.upY) * k;
    this.upZ += (g.nz * 0.35 - this.upZ) * k;

    // ---- arm cannon ----
    if (inp.aimYaw != null) {
      const d = wrapAngle(inp.aimYaw - this.turret);
      const max = MECH.torsoRate * dt;
      this.turret = wrapAngle(this.turret + clamp(d, -max, max));
    }
    this.reload = Math.max(0, this.reload - dt);
    if (inp.fire && this.reload <= 0 && alive) {
      this.reload = MECH.reload * this.reloadScale;
      this.fired = true;
    }
  }

  /** bolts leave the right-arm cannon */
  muzzle(out: Muzzle, spread = 0): void {
    const a = this.turret + spread;
    const s = Math.sin(a),
      c = Math.cos(a);
    const rs = Math.sin(this.turret),
      rc = Math.cos(this.turret);
    // right of the aim direction is (-cos, sin) in this world (x = sin, z = cos)
    out.x = this.x + s * MECH.muzzleForward - rc * MECH.muzzleSide;
    out.y = this.y + MECH.muzzleHeight;
    out.z = this.z + c * MECH.muzzleForward + rs * MECH.muzzleSide;
    out.vx = s * MECH.shotSpeed + this.vx;
    out.vy = 0.6;
    out.vz = c * MECH.shotSpeed + this.vz;
  }
}
