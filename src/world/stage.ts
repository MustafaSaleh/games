import { BIOMES } from '../config/biomes';
import { BANK_FACTOR, BANK_MAX, STAGE_DEFAULTS } from '../config/game';
import type { TimeOfDay } from '../config/lighting';
import { SURFACE_INDEX, type SurfaceId } from '../config/surfaces';
import { clamp, smoothstep, wrapAngle } from '../core/math';
import { Simplex2 } from '../core/noise';
import { World, makeBiomeRuntime, type BiomeMix, type BiomeRuntime } from './world';

/** JSON format of a hand-designed stage (see src/tracks/*.json and README). */
export interface StageDef {
  id: string;
  name: string;
  description?: string;
  biome: string;
  timeOfDay: TimeOfDay;
  seed: number;
  width?: number;
  checkpoints?: number;
  rolls?: number;
  elevation?: number;
  bank?: number;
  propDensity?: number;
  points: [number, number][];
  surfaces?: { from: number; to: number; type: SurfaceId }[];
  jumps?: { at: number; height: number; length?: number }[];
}

export interface Gate {
  idx: number; // track sample index
  s: number;
  bonus: number; // endless: seconds added
  finish: boolean;
}

/** Kicker-style jump: concave ramp up to the lip, then a smooth landing slope. */
export function jumpWindow(rel: number, length: number): number {
  // 1 inside the jump (rolls suppressed so the landing is always a drop), fades at the edges
  return smoothstep(-length - 30, -length - 5, rel) * (1 - smoothstep(length, length + 25, rel));
}

export function jumpProfile(rel: number, height: number, length: number): number {
  if (rel < -length || rel > length * 0.85) return 0;
  if (rel <= 0) {
    const u = (rel + length) / length;
    return height * Math.pow(u, 2.4);
  }
  const u = rel / (length * 0.85);
  return height * (1 - u * u * (3 - 2 * u));
}

/** Centripetal Catmull-Rom through points -> dense polyline. */
function catmullRom(points: [number, number][], sub: number): [number, number][] {
  const out: [number, number][] = [];
  const n = points.length;
  const P = (i: number) => points[clamp(i, 0, n - 1)];
  for (let i = 0; i < n - 1; i++) {
    const p0 = P(i - 1),
      p1 = P(i),
      p2 = P(i + 1),
      p3 = P(i + 2);
    const d = (a: [number, number], b: [number, number]) => Math.max(1e-3, Math.pow(Math.hypot(b[0] - a[0], b[1] - a[1]), 0.5));
    const t0 = 0,
      t1 = t0 + d(p0, p1),
      t2 = t1 + d(p1, p2),
      t3 = t2 + d(p2, p3);
    for (let k = 0; k < sub; k++) {
      const t = t1 + ((t2 - t1) * k) / sub;
      const res: [number, number] = [0, 0];
      for (let c = 0; c < 2; c++) {
        const A1 = ((t1 - t) / (t1 - t0)) * p0[c] + ((t - t0) / (t1 - t0)) * p1[c];
        const A2 = ((t2 - t) / (t2 - t1)) * p1[c] + ((t - t1) / (t2 - t1)) * p2[c];
        const A3 = ((t3 - t) / (t3 - t2)) * p2[c] + ((t - t2) / (t3 - t2)) * p3[c];
        const B1 = ((t2 - t) / (t2 - t0)) * A1 + ((t - t0) / (t2 - t0)) * A2;
        const B2 = ((t3 - t) / (t3 - t1)) * A2 + ((t - t1) / (t3 - t1)) * A3;
        res[c] = ((t2 - t) / (t2 - t1)) * B1 + ((t - t1) / (t2 - t1)) * B2;
      }
      out.push(res);
    }
  }
  out.push([...points[n - 1]] as [number, number]);
  return out;
}

export class StageWorld extends World {
  readonly def: StageDef;
  readonly biome: BiomeRuntime;
  readonly gates: Gate[] = [];
  readonly startIdx = 6;

  constructor(def: StageDef, mono: boolean) {
    super(def.seed, mono);
    this.def = def;
    this.biome = makeBiomeRuntime(BIOMES[def.biome] ?? BIOMES.forest, mono);
    this.elevation = def.elevation ?? STAGE_DEFAULTS.elevation;
    this.propDensity = def.propDensity ?? STAGE_DEFAULTS.propDensity;
    this.build();
  }

  biomeAt(_x: number, _z: number, out: BiomeMix): BiomeMix {
    out.a = this.biome;
    out.b = this.biome;
    out.t = 0;
    return out;
  }

  private build(): void {
    const def = this.def;
    const sp = this.track.spacing;
    const dense = catmullRom(def.points, 24);
    // resample by arc length
    const xs: number[] = [dense[0][0]],
      zs: number[] = [dense[0][1]];
    let carry = 0;
    for (let i = 1; i < dense.length; i++) {
      let ax = dense[i - 1][0],
        az = dense[i - 1][1];
      const bx = dense[i][0],
        bz = dense[i][1];
      let segLen = Math.hypot(bx - ax, bz - az);
      while (carry + segLen >= sp) {
        const need = sp - carry;
        const t = need / segLen;
        ax = ax + (bx - ax) * t;
        az = az + (bz - az) * t;
        xs.push(ax);
        zs.push(az);
        segLen -= need;
        carry = 0;
      }
      carry += segLen;
    }
    const n = xs.length;
    const heading: number[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1),
        b = Math.min(n - 1, i + 1);
      heading[i] = Math.atan2(xs[b] - xs[a], zs[b] - zs[a]);
    }
    // signed curvature (heading change per metre, + = left turn), smoothed
    const curv: number[] = new Array(n).fill(0);
    for (let i = 1; i < n - 1; i++) curv[i] = wrapAngle(heading[i + 1] - heading[i - 1]) / (2 * sp);
    const sm = smooth(curv, 6);

    const mix: BiomeMix = { a: this.biome, b: this.biome, t: 0 };
    const base: number[] = xs.map((x, i) => this.roadBase(x, zs[i], mix));
    const baseS = smooth(base, 25);
    const rollsN = new Simplex2(def.seed + 77);
    const rolls = def.rolls ?? STAGE_DEFAULTS.rolls;
    const bankMul = def.bank ?? STAGE_DEFAULTS.bank;
    const halfW = (def.width ?? STAGE_DEFAULTS.width) / 2;
    const defaultSurf = SURFACE_INDEX[this.biome.def.roadSurfaces[0]];
    const zones = (def.surfaces ?? []).map((z) => ({ from: z.from, to: z.to, surf: SURFACE_INDEX[z.type] }));
    const jumps = def.jumps ?? [];

    for (let i = 0; i < n; i++) {
      const s = i * sp;
      let h = baseS[i];
      let calm = 1;
      for (const j of jumps) calm *= 1 - jumpWindow(s - j.at, j.length ?? 24);
      h += calm * rolls * rollsN.noise1(s / 70) * (0.55 + 0.45 * rollsN.noise1(s / 400 + 9));
      for (const j of jumps) h += jumpProfile(s - j.at, j.height, j.length ?? 24);
      let surf = defaultSurf;
      for (const z of zones) if (s >= z.from && s < z.to) surf = z.surf;
      const bank = clamp(sm[i] * BANK_FACTOR * bankMul, -BANK_MAX, BANK_MAX);
      this.track.push(xs[i], zs[i], h, Math.sin(heading[i]), Math.cos(heading[i]), halfW, bank, surf);
    }

    // gates: N checkpoints evenly spaced + finish
    const cps = def.checkpoints ?? STAGE_DEFAULTS.checkpoints;
    const first = this.startIdx + 40;
    const finish = n - 12;
    for (let k = 1; k <= cps; k++) {
      const idx = Math.round(first + ((finish - first) * k) / (cps + 1));
      this.gates.push({ idx, s: idx * sp, bonus: 0, finish: false });
    }
    this.gates.push({ idx: finish, s: finish * sp, bonus: 0, finish: true });
  }
}

export function smooth(a: number[], r: number): number[] {
  const n = a.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0,
      w = 0;
    for (let k = -r; k <= r; k++) {
      const j = i + k;
      if (j < 0 || j >= n) continue;
      const wk = r + 1 - Math.abs(k);
      sum += a[j] * wk;
      w += wk;
    }
    out[i] = sum / w;
  }
  return out;
}
