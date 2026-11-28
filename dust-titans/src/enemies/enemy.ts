import type * as THREE from 'three';
import type { ShotKind, Target } from '../combat';
import type { Ground } from '../units/unit';

export type EnemyKind = 'drone' | 'walker' | 'alien' | 'boss' | 'beacon';

/** what enemies can see of a player */
export interface PlayerRef {
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
  r: number;
  alive: boolean;
  airborne: boolean;
}

export type EnemyFx = 'stomp' | 'explode' | 'bigExplode' | 'sparks' | 'warn' | 'jelly' | 'roar';

/** the world an enemy acts in (the game provides it) */
export interface EnemyCtx {
  ground: Ground;
  players: PlayerRef[];
  enemies: readonly Enemy[];
  fire(kind: ShotKind, x: number, y: number, z: number, vx: number, vy: number, vz: number): void;
  /** contact / shockwave damage on player `i` */
  hurt(i: number, dmg: number, fromX: number, fromZ: number): void;
  fx(kind: EnemyFx, x: number, y: number, z: number, size?: number): void;
}

export type DamageResult = 'armor' | 'hit' | 'part' | 'killed';

export interface Enemy {
  readonly id: string;
  readonly kind: EnemyKind;
  readonly mesh: THREE.Object3D;
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
  /** body radius for spacing / bumping */
  readonly r: number;
  readonly alive: boolean;
  /** points for destroying it */
  readonly score: number;
  /** frozen by an EMP / stuck in tomato juice (s) */
  stunT?: number;
  update(dt: number, ctx: EnemyCtx): void;
  sync(dt: number, time: number, ctx: EnemyCtx): void;
  /** hit spheres for projectiles (weak points first) */
  targets(out: Target[]): void;
  damage(t: Target, dmg: number, ctx: EnemyCtx): DamageResult;
  dispose(): void;
}

/** closest living player, or null */
export function nearestPlayer(ctx: EnemyCtx, x: number, z: number): { p: PlayerRef; i: number; d: number } | null {
  let best: { p: PlayerRef; i: number; d: number } | null = null;
  ctx.players.forEach((p, i) => {
    if (!p.alive) return;
    const d = Math.hypot(p.x - x, p.z - z);
    if (!best || d < best.d) best = { p, i, d };
  });
  return best;
}

/** keep enemies apart: adds a push to (wx, wz) */
export function separate(self: Enemy, others: readonly Enemy[], gap: number): [number, number] {
  let sx = 0,
    sz = 0;
  for (const o of others) {
    if (o === self || !o.alive) continue;
    const ox = self.x - o.x,
      oz = self.z - o.z;
    const min = self.r + o.r + gap;
    const d2 = ox * ox + oz * oz;
    if (d2 < min * min && d2 > 1e-4) {
      const d = Math.sqrt(d2);
      sx += (ox / d) * (min - d) * 1.5;
      sz += (oz / d) * (min - d) * 1.5;
    }
  }
  return [sx, sz];
}

/** a ballistic launch velocity that reaches (tx,ty,tz) in time t under gravity g */
export function lob(x: number, y: number, z: number, tx: number, ty: number, tz: number, t: number, g: number): [number, number, number] {
  return [(tx - x) / t, (ty - y) / t + 0.5 * g * t, (tz - z) / t];
}
