import { wrapAngle } from '@engine/core/math';
import type { Enemy } from './enemies/enemy';
import type { Team } from './combat';
import type { Unit, UnitInput } from './units/unit';

/** what a bot can see */
export interface BotWorld {
  radius: number;
  players: readonly { unit: Unit; team: Team }[];
  enemies: readonly Enemy[];
  /** nearest crate to (x, z), or null */
  crate(x: number, z: number): { x: number; z: number } | null;
}

export const BOT_NAMES = ['Robo-Rex', 'Sparky', 'Captain Cog', 'Zippy', 'Bolt', 'Turbo Tia', 'Gizmo', 'Nova'];

const RANGE = { tank: 26, mech: 18, scout: 14 };
const SHOT_SPEED = { tank: 70, mech: 85, scout: 95 };

/**
 * A computer player for practice battles: picks the closest rival (or enemy robot), keeps a
 * good distance while circling, leads its shots, dodges, grabs crates when hurt and uses
 * its special. `skill` 0..1 makes it aim better and react faster.
 */
export class Bot {
  readonly inp: UnitInput = { moveX: 0, moveZ: 0, move: 0, aimYaw: null, fire: false, jump: false, dash: false, special: false };
  private target: { x: number; y: number; z: number; vx: number; vz: number } | null = null;
  private retarget = 0;
  private orbit: number;
  private orbitT: number;
  private dashT = 0;
  private jumpT = 0;
  private jumpCd: number;
  private lastHp = -1;
  private t: number;

  constructor(
    readonly skill = 0.5,
    seed = 1,
  ) {
    this.orbit = seed % 2 ? 1 : -1;
    this.orbitT = 2 + (seed % 5);
    this.jumpCd = 2 + (seed % 3);
    this.t = seed * 1.7;
  }

  think(dt: number, me: { unit: Unit; team: Team; specialCd: number }, w: BotWorld): UnitInput {
    const u = me.unit;
    const i = this.inp;
    this.t += dt;
    i.fire = i.jump = i.dash = i.special = false;
    i.move = 0;
    if (!u.alive) {
      this.lastHp = -1;
      return i;
    }

    // ---- choose a target (closest rival player or enemy robot) ----
    this.retarget -= dt;
    if (this.retarget <= 0 || !this.target) {
      this.retarget = 0.6 - this.skill * 0.3;
      let best: BotWorld['players'][number]['unit'] | Enemy | null = null,
        bd = Infinity;
      for (const p of w.players) {
        if (p.unit === u || p.team === me.team || !p.unit.alive) continue;
        const d = Math.hypot(p.unit.x - u.x, p.unit.z - u.z);
        if (d < bd) {
          bd = d;
          best = p.unit;
        }
      }
      for (const e of w.enemies) {
        if (!e.alive) continue;
        const d = Math.hypot(e.x - u.x, e.z - u.z) * 0.9; // robots first, a little
        if (d < bd) {
          bd = d;
          best = e;
        }
      }
      this.target = best ? { x: best.x, y: best.y + ('spec' in best ? best.spec.hitHeight : best.kind === 'walker' ? 2.3 : best.kind === 'boss' ? 6 : 1), z: best.z, vx: best.vx, vz: best.vz } : null;
      if (best) this.track = best;
      else this.track = null;
    }
    const tr = this.track;
    if (tr && this.target) {
      this.target.x = tr.x;
      this.target.z = tr.z;
      this.target.vx = tr.vx;
      this.target.vz = tr.vz;
    }

    // ---- move ----
    let mx = 0,
      mz = 0;
    const hurt = u.hp < u.spec.maxHp * 0.45;
    const crate = hurt ? w.crate(u.x, u.z) : null;
    this.orbitT -= dt;
    if (this.orbitT <= 0) {
      this.orbitT = 3 + Math.random() * 4;
      this.orbit *= -1;
    }
    if (crate && Math.hypot(crate.x - u.x, crate.z - u.z) < 55) {
      mx = crate.x - u.x;
      mz = crate.z - u.z;
    } else if (this.target) {
      const dx = this.target.x - u.x,
        dz = this.target.z - u.z;
      const d = Math.hypot(dx, dz) || 1;
      const want = RANGE[u.kind];
      const radial = d > want + 6 ? 1 : d < want - 6 ? -0.8 : 0;
      mx = (dx / d) * radial + (-dz / d) * this.orbit * 0.8;
      mz = (dz / d) * radial + (dx / d) * this.orbit * 0.8;
    } else {
      mx = -u.x;
      mz = -u.z; // nobody around: head for the middle
    }
    const fromC = Math.hypot(u.x, u.z);
    if (fromC > w.radius - 22) {
      mx += (-u.x / fromC) * 2;
      mz += (-u.z / fromC) * 2;
    }
    const ml = Math.hypot(mx, mz);
    if (ml > 0.01) {
      i.moveX = mx / ml;
      i.moveZ = mz / ml;
      i.move = 1;
    }

    // ---- aim + fire ----
    if (this.target) {
      const dx = this.target.x - u.x,
        dz = this.target.z - u.z;
      const d = Math.hypot(dx, dz);
      const lead = d / SHOT_SPEED[u.kind];
      const err = (1 - this.skill) * 0.16 * Math.sin(this.t * 1.9);
      i.aimYaw = Math.atan2(dx + this.target.vx * lead, dz + this.target.vz * lead) + err;
      const off = Math.abs(wrapAngle(i.aimYaw - u.turret));
      i.fire = d < 80 && off < 0.25;
      if (me.specialCd <= 0 && d < 38 && off < 0.3 && Math.random() < dt * (0.5 + this.skill)) i.special = true;
      // tanks turbo-ram when lined up; scouts nitro to close in
      if (u.kind !== 'mech' && u.energy > 0.6 && d > 40 && off < 0.4) i.dash = true;
    }

    // ---- dodge: when hit, dash / jump ----
    if (this.lastHp >= 0 && u.hp < this.lastHp - 4 && Math.random() < 0.4 + this.skill * 0.4) {
      if (u.kind === 'mech') this.jumpT = 0.45;
      this.dashT = 0.25;
    }
    this.lastHp = u.hp;
    if (u.kind === 'mech') {
      this.jumpCd -= dt;
      if (this.jumpCd <= 0) {
        this.jumpCd = 3 + Math.random() * 3;
        this.jumpT = 0.35;
      }
    }
    if (this.dashT > 0) {
      this.dashT -= dt;
      i.dash = u.energy > 0.35;
    }
    if (this.jumpT > 0) {
      this.jumpT -= dt;
      i.jump = true;
    }
    return i;
  }

  private track: { x: number; z: number; vx: number; vz: number } | null = null;
}
