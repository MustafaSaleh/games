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
