import { clamp, lerp, wrapAngle } from '@engine/core/math';
import { resolveCircleColliders } from '@engine/physics/collisions';
import { ColliderHits, makeGroundSample } from '@engine/world/terrain';
import { MECH } from './mech';
import type { Ground, Muzzle, Unit, UnitInput, UnitSpec } from './unit';

/** Warbot tuning: a big, slow, armoured walker. Units: metres, seconds, radians. */
export const WARBOT = {
  maxSpeed: 8,
  accel: 20,
  turnRate: 3.2, // heavy legs turn slowly
  torsoRate: 5,
  radius: 2.0,
  maxHp: 140,
  mass: 3200,
  /** gatling: reload shrinks from slow to fast while the trigger is held */
  reloadSlow: 0.2,
  reloadFast: 0.075,
  spinUp: 1.1, // s to full speed
  spinDown: 0.8,
  shotSpeed: 95,
  muzzleHeight: 4.2,
  muzzleForward: 3.3,
  muzzleSide: 2.0, // right arm
  /** a homing missile leaves the shoulder pod every few seconds at full spin */
  missileEvery: 2.4,
  gravity: 26,
  /** ground slam: wind up, then smash */
  slamWindup: 0.42,
  slamCost: 0.5,
  slamCooldown: 1.4,
  slamRadius: 9,
  energyRegen: 0.22,
};

export const WARBOT_SPEC: UnitSpec = {
  kind: 'warbot',
  name: 'Warbot',
  blurb: 'A giant armoured war robot. Slow but super tough, with a spinning gatling cannon and a missile pod.',
  maxHp: WARBOT.maxHp,
  radius: WARBOT.radius,
  mass: WARBOT.mass,
  hitHeight: 3.3,
  shot: 'pellet',
  icon: '🦾',
  maxSpeed: WARBOT.maxSpeed,
  reload: WARBOT.reloadSlow,
  aimHeight: 3.3,
  hitR: 2.2,
  tagHeight: 8,
  bubble: [4.6, 3.4],
  chase: 2.3,
  upright: 0.25,
  push: 0.3,
  bars: { armour: 1, speed: 0.45, firepower: 0.85, agility: 0.3 },
  ability: '💥 Ground slam + 🚀 missiles',
};

/** The Warbot: walks like the robot suit but no jets; its dash key is a ground slam. */
export class Warbot implements Unit {
  readonly kind = 'warbot' as const;
  readonly spec = WARBOT_SPEC;
  x = 0;
  y = 0;
  z = 0;
  vx = 0;
  vy = 0;
  vz = 0;
  heading = 0;
  yawRate = 0;
  turret = 0;
  hp = WARBOT.maxHp;
  reload = 0;
  energy = 1;
  drive = 0;
  airborne = false;
  landed = 0;
  /** winding up a ground slam */
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
  /** metres walked (leg animation) */
  stride = 0;
  /** gatling barrel speed 0..1 */
  spin = 0;
  /** a missile left the pod this step */
  missile = false;
  /** the slam hit the ground this step */
  slammed = false;
  /** 0..1 slam wind-up progress */
  slam = 0;
  private slamT = 0;
  private slamCd = 0;
  private missileT = WARBOT.missileEvery;
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
    this.hp = WARBOT.maxHp;
    this.reload = this.slamT = this.slamCd = this.spin = this.slam = 0;
    this.missileT = WARBOT.missileEvery;
    this.energy = 1;
    this.airborne = this.dashing = false;
    this.reloadScale = 1;
  }

  step(dt: number, inp: UnitInput, ground: Ground): void {
    this.px = this.x;
    this.py = this.y;
    this.pz = this.z;
    this.pHeading = this.heading;
    this.pTurret = this.turret;
    this.fired = this.missile = this.slammed = false;
    this.impact = 0;
    this.landed = 0;
    const alive = this.alive;

    // ---- ground slam: crouch, then smash (the game's stomp does the damage) ----
    this.slamCd = Math.max(0, this.slamCd - dt);
    if (alive && inp.dash && this.slamT <= 0 && this.slamCd <= 0 && !this.airborne && this.energy >= WARBOT.slamCost) {
      this.slamT = WARBOT.slamWindup;
      this.slamCd = WARBOT.slamCooldown;
      this.energy -= WARBOT.slamCost;
    }
    if (this.slamT > 0) {
      this.slamT -= dt;
      if (this.slamT <= 0 || !alive) {
        this.slamT = 0;
        if (alive) {
          this.landed = MECH.stompSpeed * 1.8;
          this.slammed = true;
        }
      }
    }
    this.dashing = this.slamT > 0;
    this.slam = this.dashing ? 1 - this.slamT / WARBOT.slamWindup : 0;

    // ---- walking (stops to slam) ----
    const m = alive && !this.dashing ? clamp(inp.move, 0, 1) : 0;
    const ml = Math.hypot(inp.moveX, inp.moveZ);
    const k = m > 0.08 && ml > 1e-6 ? (WARBOT.maxSpeed * m) / ml : 0;
    const lim = WARBOT.accel * (this.airborne ? 0.3 : 1) * (this.dashing ? 2 : 1) * dt;
    let dvx = inp.moveX * k - this.vx,
      dvz = inp.moveZ * k - this.vz;
    const dl = Math.hypot(dvx, dvz);
    if (dl > lim) {
      dvx *= lim / dl;
      dvz *= lim / dl;
    }
    this.vx += dvx;
    this.vz += dvz;
    const sp = this.speed;
    if (sp > 1) {
      const d = wrapAngle(Math.atan2(this.vx, this.vz) - this.heading);
      this.yawRate = clamp(d * 6, -WARBOT.turnRate, WARBOT.turnRate);
    } else this.yawRate *= Math.exp(-10 * dt);
    this.heading = wrapAngle(this.heading + this.yawRate * dt);
    this.drive = clamp(sp / WARBOT.maxSpeed, 0, 1);

    // ---- move, props, ground ----
    if (this.airborne) this.vy -= WARBOT.gravity * dt;
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    this.y += this.vy * dt;
    ground.queryColliders(this.x, this.z, WARBOT.radius, this.hits);
    const before = this.speed;
    resolveCircleColliders(this, this.x, this.z, WARBOT.radius, this.hits);
    this.impact = Math.max(0, before - this.speed);
    const g = ground.sample(this.x, this.z, this.g);
    if (this.airborne) {
      if (this.y <= g.h) {
        this.landed = Math.max(this.landed, 0.01, -this.vy);
        this.y = g.h;
        this.vy = 0;
        this.airborne = false;
      }
    } else if (this.y - g.h > 1) {
      this.airborne = true; // stepped off a ledge
    } else {
      this.y = g.h;
      this.vy = 0;
    }
    if (!this.airborne) this.stride += sp * dt;
    if (!this.dashing) this.energy = Math.min(1, this.energy + WARBOT.energyRegen * this.energyMul * dt);
    const kk = Math.min(1, 5 * dt);
    this.upX += (g.nx * 0.25 - this.upX) * kk;
    this.upY += (1 - this.upY) * kk;
    this.upZ += (g.nz * 0.25 - this.upZ) * kk;

    // ---- gatling: spins up while the trigger is held ----
    if (inp.aimYaw != null) {
      const d = wrapAngle(inp.aimYaw - this.turret);
      const max = WARBOT.torsoRate * dt;
      this.turret = wrapAngle(this.turret + clamp(d, -max, max));
    }
    const firing = !!inp.fire && alive && !this.dashing;
    this.spin = clamp(this.spin + (firing ? dt / WARBOT.spinUp : -dt / WARBOT.spinDown), 0, 1);
    this.reload = Math.max(0, this.reload - dt);
    if (firing && this.reload <= 0) {
      this.reload = lerp(WARBOT.reloadSlow, WARBOT.reloadFast, this.spin) * this.reloadScale;
      this.fired = true;
    }
    if (firing && this.spin >= 1) {
      this.missileT -= dt;
      if (this.missileT <= 0) {
        this.missileT = WARBOT.missileEvery;
        this.missile = true;
      }
    } else this.missileT = Math.min(WARBOT.missileEvery, this.missileT + dt);
  }

  /** bullets leave the right-arm gatling, with a little jitter at full spin */
  muzzle(out: Muzzle, spread = 0): void {
    const a = this.turret + spread + (Math.random() - 0.5) * 0.03 * this.spin;
    const s = Math.sin(a),
      c = Math.cos(a);
    const rs = Math.sin(this.turret),
      rc = Math.cos(this.turret);
    out.x = this.x + s * WARBOT.muzzleForward - rc * WARBOT.muzzleSide;
    out.y = this.y + WARBOT.muzzleHeight;
    out.z = this.z + c * WARBOT.muzzleForward + rs * WARBOT.muzzleSide;
    out.vx = s * WARBOT.shotSpeed + this.vx;
    out.vy = 0.4;
    out.vz = c * WARBOT.shotSpeed + this.vz;
  }
}
