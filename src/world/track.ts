/**
 * TrackPath: the road centre line as evenly spaced samples (every `spacing` m).
 * Used for terrain carving, surfaces, checkpoints, minimap, progress and ghost/autopilot.
 *
 * Indices are *absolute*: in Endless mode old samples are discarded from the front
 * (base grows) so memory stays constant while indices stay stable.
 */
export interface ProjectOut {
  idx: number; // segment start index (absolute)
  t: number; // 0..1 along the segment
  dist: number; // euclidean distance to the centre line
  lateral: number; // signed lateral offset (+ = right of travel direction)
  s: number; // distance along the track (m)
  h: number; // road surface height at this lateral offset (incl. banking)
  halfW: number;
  surface: number;
}

export function makeProject(): ProjectOut {
  return { idx: -1, t: 0, dist: 1e9, lateral: 0, s: 0, h: 0, halfW: 0, surface: 0 };
}

const CELL = 32;
const cellKey = (cx: number, cz: number): number => (cx + 32768) * 65536 + (cz + 32768);

export class TrackPath {
  readonly spacing: number;
  base = 0;
  xs: number[] = [];
  zs: number[] = [];
  hs: number[] = [];
  dxs: number[] = [];
  dzs: number[] = [];
  halfWs: number[] = [];
  banks: number[] = [];
  surfs: number[] = [];
  private grid = new Map<number, number[]>();
  private tmp = makeProject();

  constructor(spacing = 2) {
    this.spacing = spacing;
  }

  get start(): number {
    return this.base;
  }
  /** exclusive end index */
  get end(): number {
    return this.base + this.xs.length;
  }
  get lengthM(): number {
    return (this.end - 1) * this.spacing;
  }

  x(i: number): number {
    return this.xs[i - this.base];
  }
  z(i: number): number {
    return this.zs[i - this.base];
  }
  h(i: number): number {
    return this.hs[i - this.base];
  }
  dx(i: number): number {
    return this.dxs[i - this.base];
  }
  dz(i: number): number {
    return this.dzs[i - this.base];
  }
  halfW(i: number): number {
    return this.halfWs[i - this.base];
  }
  surf(i: number): number {
    return this.surfs[i - this.base];
  }
  clampIdx(i: number): number {
    return i < this.base ? this.base : i >= this.end ? this.end - 1 : i;
  }

  push(x: number, z: number, h: number, dx: number, dz: number, halfW: number, bank: number, surf: number): void {
    this.xs.push(x);
    this.zs.push(z);
    this.hs.push(h);
    this.dxs.push(dx);
    this.dzs.push(dz);
    this.halfWs.push(halfW);
    this.banks.push(bank);
    this.surfs.push(surf);
    const n = this.end;
    if (n >= 2) this.registerSegment(n - 2);
  }

  private registerSegment(i: number): void {
    const x0 = this.x(i),
      z0 = this.z(i),
      x1 = this.x(i + 1),
      z1 = this.z(i + 1);
    const cx0 = Math.floor(Math.min(x0, x1) / CELL),
      cx1 = Math.floor(Math.max(x0, x1) / CELL);
    const cz0 = Math.floor(Math.min(z0, z1) / CELL),
      cz1 = Math.floor(Math.max(z0, z1) / CELL);
    for (let cx = cx0; cx <= cx1; cx++)
      for (let cz = cz0; cz <= cz1; cz++) {
        const k = cellKey(cx, cz);
        let list = this.grid.get(k);
        if (!list) this.grid.set(k, (list = []));
        list.push(i);
      }
  }

  /** Discard samples before `absIdx` (Endless memory cap). */
  trimBefore(absIdx: number): void {
    const n = absIdx - this.base;
    if (n <= 0) return;
    for (const arr of [this.xs, this.zs, this.hs, this.dxs, this.dzs, this.halfWs, this.banks, this.surfs]) arr.splice(0, n);
    this.base = absIdx;
    for (const [k, list] of this.grid) {
      let w = 0;
      for (let r = 0; r < list.length; r++) if (list[r] >= absIdx) list[w++] = list[r];
      if (w === 0) this.grid.delete(k);
      else list.length = w;
    }
  }

  /** Segment start indices whose cells overlap the rect (may contain duplicates). */
  queryRect(minX: number, minZ: number, maxX: number, maxZ: number, out: number[]): number[] {
    out.length = 0;
    const cx0 = Math.floor(minX / CELL),
      cx1 = Math.floor(maxX / CELL);
    const cz0 = Math.floor(minZ / CELL),
      cz1 = Math.floor(maxZ / CELL);
    const last = this.end - 2;
    for (let cx = cx0; cx <= cx1; cx++)
      for (let cz = cz0; cz <= cz1; cz++) {
        const list = this.grid.get(cellKey(cx, cz));
        if (!list) continue;
        for (let j = 0; j < list.length; j++) {
          const i = list[j];
          if (i >= this.base && i <= last) out.push(i);
        }
      }
    return out;
  }

  /** Project (x,z) on segment i -> fills out, returns distance. */
  projectSegment(i: number, x: number, z: number, out: ProjectOut): number {
    const b = this.base;
    const ax = this.xs[i - b],
      az = this.zs[i - b];
    const ex = this.xs[i - b + 1] - ax,
      ez = this.zs[i - b + 1] - az;
    const len2 = ex * ex + ez * ez || 1;
    let t = ((x - ax) * ex + (z - az) * ez) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + ex * t,
      pz = az + ez * t;
    const ox = x - px,
      oz = z - pz;
    const dist = Math.sqrt(ox * ox + oz * oz);
    const k = i - b;
    const dx = this.dxs[k] + (this.dxs[k + 1] - this.dxs[k]) * t;
    const dz = this.dzs[k] + (this.dzs[k + 1] - this.dzs[k]) * t;
    // right vector = (-dz, dx)
    const lateral = ox * -dz + oz * dx;
    out.idx = i;
    out.t = t;
    out.dist = dist;
    out.lateral = lateral;
    out.s = (i + t) * this.spacing;
    const bank = this.banks[k] + (this.banks[k + 1] - this.banks[k]) * t;
    out.halfW = this.halfWs[k] + (this.halfWs[k + 1] - this.halfWs[k]) * t;
    out.h = this.hs[k] + (this.hs[k + 1] - this.hs[k]) * t + bank * clampLat(lateral, out.halfW + 3);
    out.surface = this.surfs[t < 0.5 ? k : k + 1];
    return dist;
  }

  /** Closest point among a list of candidate segments. */
  nearestOf(cands: number[], count: number, x: number, z: number, out: ProjectOut): boolean {
    let best = 1e9;
    const tmp = this.tmp;
    for (let j = 0; j < count; j++) {
      const d = this.projectSegment(cands[j], x, z, tmp);
      if (d < best) {
        best = d;
        copyProject(tmp, out);
      }
    }
    if (best === 1e9) out.dist = 1e9;
    return best < 1e9;
  }

  /**
   * Closest point on the track. With a valid hint only a window around it is searched
   * (cheap, used every physics step); otherwise the grid is used.
   */
  nearest(x: number, z: number, hint: number, window: number, out: ProjectOut): boolean {
    if (this.end - this.base < 2) return false;
    const last = this.end - 2;
    if (hint >= this.base && hint <= last) {
      const i0 = Math.max(this.base, hint - window),
        i1 = Math.min(last, hint + window);
      let best = 1e9;
      const tmp = this.tmp;
      for (let i = i0; i <= i1; i++) {
        const d = this.projectSegment(i, x, z, tmp);
        if (d < best) {
          best = d;
          copyProject(tmp, out);
        }
      }
      return true;
    }
    const cands = this.scratch;
    for (let r = 48; r <= 1024; r *= 4) {
      this.queryRect(x - r, z - r, x + r, z + r, cands);
      if (cands.length) return this.nearestOf(cands, cands.length, x, z, out);
    }
    // brute force fallback
    let best = 1e9;
    for (let i = this.base; i <= last; i++) {
      const d = this.projectSegment(i, x, z, this.tmp);
      if (d < best) {
        best = d;
        copyProject(this.tmp, out);
      }
    }
    return true;
  }
  private scratch: number[] = [];
}

function clampLat(l: number, m: number): number {
  return l < -m ? -m : l > m ? m : l;
}

export function copyProject(a: ProjectOut, b: ProjectOut): void {
  b.idx = a.idx;
  b.t = a.t;
  b.dist = a.dist;
  b.lateral = a.lateral;
  b.s = a.s;
  b.h = a.h;
  b.halfW = a.halfW;
  b.surface = a.surface;
}
