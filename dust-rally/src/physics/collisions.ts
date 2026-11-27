import { HANDLING as H } from '../config/handling';
import type { ColliderHits } from '../world/terrain';

interface Body {
  x: number;
  z: number;
  y: number;
  vx: number;
  vz: number;
  yawRate: number;
}

/**
 * Circle (car part) vs circle (tree/rock) collisions. Pushes the body out, reflects
 * the normal velocity with restitution, applies tangential friction and a bit of spin.
 * Returns the largest impact speed (m/s) for haptics / sound.
 */
export function resolveCircleColliders(b: Body, cx: number, cz: number, r: number, hits: ColliderHits): number {
  let maxImpact = 0;
  for (let i = 0; i < hits.count; i++) {
    if (hits.loose[i]) continue; // loose rocks are pushed around (physics/rocks.ts), not solid
    if (b.y > hits.top[i] - 0.25) continue; // flying over it
    const dx = cx - hits.x[i],
      dz = cz - hits.z[i];
    const minD = r + hits.r[i];
    const d2 = dx * dx + dz * dz;
    if (d2 >= minD * minD || d2 < 1e-8) continue;
    const d = Math.sqrt(d2);
    const nx = dx / d,
      nz = dz / d;
    const pen = minD - d;
    b.x += nx * pen;
    b.z += nz * pen;
    cx += nx * pen;
    cz += nz * pen;
    const vn = b.vx * nx + b.vz * nz;
    if (vn < 0) {
      const impact = -vn;
      b.vx -= (1 + H.restitution) * vn * nx;
      b.vz -= (1 + H.restitution) * vn * nz;
      const tx = -nz,
        tz = nx;
      const vt = b.vx * tx + b.vz * tz;
      b.vx -= tx * vt * H.collisionFriction;
      b.vz -= tz * vt * H.collisionFriction;
      // spin from off-centre hit: torque_y = rz*Jx - rx*Jz
      const rx = cx - b.x,
        rz = cz - b.z;
      b.yawRate += (rz * nx - rx * nz) * impact * H.collisionSpin;
      if (impact > maxImpact) maxImpact = impact;
    }
  }
  return maxImpact;
}

/** A car as seen by car-vs-car collisions (two circles along the heading). */
export interface CarBody extends Body {
  heading: number;
}

/** Where two cars touched, for sparks / sound. */
export interface CarContact {
  x: number;
  y: number;
  z: number;
  /** closing speed at the hit (m/s), 0 if they were already separating */
  impact: number;
  /** sideways speed between the cars while touching (scraping) */
  scrape: number;
  /** contact normal (from b toward a) */
  nx: number;
  nz: number;
}

export function makeContact(): CarContact {
  return { x: 0, y: 0, z: 0, impact: 0, scrape: 0, nx: 0, nz: 0 };
}

/**
 * Car vs car: circle pairs, equal masses. Both cars respond when `bMovable`
 * (split-screen); otherwise `b` is kinematic (an online player whose own device
 * simulates it) and only `a` is pushed — each device handles its own half of the hit.
 * Returns true when the cars touched.
 */
export function resolveCarCar(a: CarBody, b: CarBody, bMovable: boolean, out: CarContact): boolean {
  out.impact = 0;
  out.scrape = 0;
  if (Math.abs(a.y - b.y) > 1.6) return false; // one is flying over the other
  const dx0 = a.x - b.x,
    dz0 = a.z - b.z;
  const reach = 2 * (H.colliderOffset + H.colliderRadius);
  if (dx0 * dx0 + dz0 * dz0 > reach * reach) return false;
  let touched = false;
  const afx = Math.sin(a.heading),
    afz = Math.cos(a.heading);
  const bfx = Math.sin(b.heading),
    bfz = Math.cos(b.heading);
  const r2 = 2 * H.colliderRadius;
  for (let i = -1; i <= 1; i += 2)
    for (let j = -1; j <= 1; j += 2) {
      const ax = a.x + afx * H.colliderOffset * i,
        az = a.z + afz * H.colliderOffset * i;
      const bx = b.x + bfx * H.colliderOffset * j,
        bz = b.z + bfz * H.colliderOffset * j;
      const dx = ax - bx,
        dz = az - bz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r2 * r2) continue;
      const d = Math.sqrt(d2) || 1e-4;
      const nx = d2 > 1e-8 ? dx / d : 1,
        nz = d2 > 1e-8 ? dz / d : 0;
      const pen = r2 - d;
      touched = true;
      // push apart
      const share = bMovable ? 0.5 : 1;
      a.x += nx * pen * share;
      a.z += nz * pen * share;
      if (bMovable) {
        b.x -= nx * pen * 0.5;
        b.z -= nz * pen * 0.5;
      }
      const cx = (ax + bx) / 2,
        cz = (az + bz) / 2;
      // relative velocity along the normal / tangent
      const rvx = a.vx - b.vx,
        rvz = a.vz - b.vz;
      const vn = rvx * nx + rvz * nz;
      const tx = -nz,
        tz = nx;
      const vt = rvx * tx + rvz * tz;
      out.x = cx;
      out.z = cz;
      out.y = (a.y + b.y) / 2 + 0.55;
      out.nx = nx;
      out.nz = nz;
      out.scrape = Math.max(out.scrape, Math.abs(vt));
      if (vn < 0) {
        // equal-mass impulse (per car) and a little tangential friction
        const jn = (-(1 + H.carRestitution) * vn) / 2;
        const jt = -vt * H.carFriction * 0.5;
        const ix = nx * jn + tx * jt,
          iz = nz * jn + tz * jt;
        a.vx += ix;
        a.vz += iz;
        // spin from an off-centre hit (same convention as obstacle hits)
        a.yawRate += ((cz - a.z) * ix - (cx - a.x) * iz) * H.carSpin;
        if (bMovable) {
          b.vx -= ix;
          b.vz -= iz;
          b.yawRate += ((cz - b.z) * -ix - (cx - b.x) * -iz) * H.carSpin;
        }
        out.impact = Math.max(out.impact, -vn);
      }
    }
  return touched;
}
