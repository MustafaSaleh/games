import type { ShotKind } from '../combat';
import type { Boss } from '../enemies/boss';
import type { Enemy, EnemyKind } from '../enemies/enemy';
import type { Mech } from '../units/mech';
import type { Unit } from '../units/unit';

/** compact codes for the wire */
export const SHOT_CODES: ShotKind[] = ['shell', 'bolt', 'orb', 'laser', 'plasma', 'pellet', 'rocket', 'tomato'];
export const ENEMY_CODES: EnemyKind[] = ['drone', 'walker', 'alien', 'boss', 'beacon'];

const r2 = (v: number) => Math.round(v * 100) / 100;

/** a player's unit as sent ~20 times a second */
export interface PoseState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  heading: number;
  turret: number;
  hp: number;
  energy: number;
  stride: number;
  airborne: boolean;
  dashing: boolean;
  jets: boolean;
  shield: boolean;
}

export function encodePose(u: Unit, shield: boolean): number[] {
  const m = u as Partial<Mech>;
  const flags = (u.airborne ? 1 : 0) | (u.dashing ? 2 : 0) | (m.jets ? 4 : 0) | (shield ? 8 : 0);
  return [u.x, u.y, u.z, u.vx, u.vy, u.vz, u.heading, u.turret, u.hp, u.energy, m.stride ?? 0, flags].map(r2);
}

export function decodePose(a: unknown): PoseState | null {
  if (!Array.isArray(a) || a.length < 12 || a.some((v) => typeof v !== 'number' || !Number.isFinite(v))) return null;
  const f = a[11];
  return { x: a[0], y: a[1], z: a[2], vx: a[3], vy: a[4], vz: a[5], heading: a[6], turret: a[7], hp: a[8], energy: a[9], stride: a[10], airborne: !!(f & 1), dashing: !!(f & 2), jets: !!(f & 4), shield: !!(f & 8) };
}

/** shots: [kind, x, y, z, vx, vy, vz] per projectile, flattened */
export function encodeShot(kind: ShotKind, m: { x: number; y: number; z: number; vx: number; vy: number; vz: number }): number[] {
  return [SHOT_CODES.indexOf(kind), r2(m.x), r2(m.y), r2(m.z), r2(m.vx), r2(m.vy), r2(m.vz)];
}

export function decodeShots(a: unknown): { kind: ShotKind; x: number; y: number; z: number; vx: number; vy: number; vz: number }[] {
  if (!Array.isArray(a)) return [];
  const out = [];
  for (let i = 0; i + 6 < a.length; i += 7) {
    const kind = SHOT_CODES[a[i]];
    if (!kind || !a.slice(i, i + 7).every((v) => typeof v === 'number' && Number.isFinite(v))) continue;
    out.push({ kind, x: a[i + 1], y: a[i + 2], z: a[i + 3], vx: a[i + 4], vy: a[i + 5], vz: a[i + 6] });
  }
  return out;
}

/** enemy snapshot row: [idNum, kind, x, y, z, vx, vz, hp, heading, (boss: knee0, knee1, core, state)] */
export function encodeEnemy(e: Enemy): number[] {
  const id = +e.id.replace(/\D/g, '');
  const kind = ENEMY_CODES.indexOf(e.kind);
  const hp = (e as unknown as { hp?: number }).hp ?? 0;
  const heading = (e as unknown as { heading?: number }).heading ?? 0;
  const row = [id, kind, r2(e.x), r2(e.y), r2(e.z), r2(e.vx), r2(e.vz), r2(hp), r2(heading)];
  if (e.kind === 'boss') {
    const b = e as Boss;
    row.push(r2(b.knees[0]), r2(b.knees[1]), r2(b.core), b.stateCode);
  }
  return row;
}

export interface EnemyRow {
  id: string;
  kind: EnemyKind;
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
  hp: number;
  heading: number;
  boss?: { k0: number; k1: number; core: number; state: number };
}

export function decodeEnemies(a: unknown): EnemyRow[] {
  if (!Array.isArray(a)) return [];
  const out: EnemyRow[] = [];
  for (const row of a) {
    if (!Array.isArray(row) || row.length < 9 || !row.every((v) => typeof v === 'number' && Number.isFinite(v))) continue;
    const kind = ENEMY_CODES[row[1]];
    if (!kind) continue;
    const e: EnemyRow = { id: kind + row[0], kind, x: row[2], y: row[3], z: row[4], vx: row[5], vz: row[6], hp: row[7], heading: row[8] };
    if (kind === 'boss' && row.length >= 13) e.boss = { k0: row[9], k1: row[10], core: row[11], state: row[12] };
    out.push(e);
  }
  return out;
}
