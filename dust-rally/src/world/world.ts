import type { PropType } from '../config/biomes';
import * as THREE from 'three';
import { BIOMES, MONOCHROME_PALETTE, type BiomeDef, type BiomePalette, type TerrainParams } from '../config/biomes';
import { SURFACES, SURFACE_INDEX, type SurfaceId } from '../config/surfaces';
import { TERRAIN } from '../config/quality';
import { Simplex2 } from '../core/noise';
import { clamp, smoothstep } from '../core/math';
import { TrackPath, makeProject, type ProjectOut } from './track';

/* ------------------------------------------------------------------ */
/* Palettes in linear RGB (vertex colours are linear)                   */
/* ------------------------------------------------------------------ */
export type RGB = [number, number, number];
export interface LinPalette {
  ground: RGB;
  groundAlt: RGB;
  groundLow: RGB;
  groundHigh: RGB;
  steep: RGB;
  surfaces: RGB[]; // by surface index
  foliage: RGB;
  foliageAlt: RGB;
  trunk: RGB;
  rock: RGB;
  bush: RGB;
  fog: RGB;
}

const tmpColor = new THREE.Color();
export function lin(hex: number): RGB {
  tmpColor.setHex(hex);
  return [tmpColor.r, tmpColor.g, tmpColor.b];
}

export function toLinPalette(p: BiomePalette): LinPalette {
  return {
    ground: lin(p.ground),
    groundAlt: lin(p.groundAlt),
    groundLow: lin(p.groundLow),
    groundHigh: lin(p.groundHigh),
    steep: lin(p.steep),
    surfaces: SURFACES.map((s) => lin(p.surfaces[s.id])),
    foliage: lin(p.foliage),
    foliageAlt: lin(p.foliageAlt),
    trunk: lin(p.trunk),
    rock: lin(p.rock),
    bush: lin(p.bush),
    fog: lin(p.fog),
  };
}

export interface BiomeRuntime {
  def: BiomeDef;
  pal: LinPalette;
  offroad: number;
  patch: number;
}

export function makeBiomeRuntime(def: BiomeDef, mono: boolean): BiomeRuntime {
  return {
    def,
    pal: toLinPalette(mono ? MONOCHROME_PALETTE : def.palette),
    offroad: SURFACE_INDEX[def.offroad],
    patch: SURFACE_INDEX[def.patch],
  };
}

export interface BiomeMix {
  a: BiomeRuntime;
  b: BiomeRuntime;
  t: number; // 0 = all a, 1 = all b
}

export function mixRGB(a: RGB, b: RGB, t: number, out: RGB): RGB {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

/* ------------------------------------------------------------------ */
/* Natural terrain shape (no road)                                     */
/* ------------------------------------------------------------------ */
export class TerrainShape {
  private lf: Simplex2;
  private mf: Simplex2;
  private hf: Simplex2;
  private dn: Simplex2;
  readonly aux: Simplex2;
  /** low-frequency component of the last height() call, roughly -1..1 */
  lastLf = 0;

  constructor(seed: number) {
    this.lf = new Simplex2(seed);
    this.mf = new Simplex2(seed + 101);
    this.hf = new Simplex2(seed + 202);
    this.dn = new Simplex2(seed + 303);
    this.aux = new Simplex2(seed + 404);
  }

  height(x: number, z: number, p: TerrainParams): number {
    const lf = this.lf.noise(x * 0.0045, z * 0.0045) * 0.75 + this.lf.noise(x * 0.009 + 40, z * 0.009) * 0.25;
    this.lastLf = lf;
    let h = lf * p.hillAmp;
    h += this.mf.noise(x * 0.014, z * 0.014) * p.midAmp;
    h += this.hf.noise(x * 0.055, z * 0.055) * p.roughAmp;
    if (p.duneAmp > 0) {
      // ridged, wind-elongated dunes
      const d = 1 - Math.abs(this.dn.noise(x * 0.006 + z * 0.002, z * 0.016));
      h += d * d * d * p.duneAmp;
    }
    return h;
  }

  /** Smooth base height for the road (no small bumps). */
  roadBase(x: number, z: number, p: TerrainParams): number {
    const lf = this.lf.noise(x * 0.0045, z * 0.0045) * 0.75 + this.lf.noise(x * 0.009 + 40, z * 0.009) * 0.25;
    return lf * p.hillAmp * 0.6 + p.duneAmp * 0.25;
  }

  /** 0..1 clustering mask for props. */
  cluster(x: number, z: number): number {
    return this.aux.noise(x * 0.018, z * 0.018) * 0.5 + 0.5;
  }

  /** -1..1 patch noise (off-road surface patches & ground colour variation) */
  patch(x: number, z: number): number {
    return this.aux.noise(x * 0.035 + 100, z * 0.035) * 0.7 + this.aux.noise(x * 0.11, z * 0.11 + 50) * 0.3;
  }
}

/* ------------------------------------------------------------------ */
/* World: terrain shape + track + biomes. Stage and Endless subclass it. */
/* ------------------------------------------------------------------ */
export interface PointOut {
  h: number; // final height
  base: number; // natural height
  lf: number; // low freq noise (for colour)
  edge: number; // distance from road edge (negative = on road, 1e9 = far)
  lateral: number; // |lateral| / halfWidth (0 centre .. 1 edge)
  roadSurf: number;
  patch: number; // patch noise
  surface: number; // final surface index
}

export function makePoint(): PointOut {
  return { h: 0, base: 0, lf: 0, edge: 1e9, lateral: 9, roadSurf: 0, patch: 0, surface: 0 };
}

export abstract class World {
  readonly shape: TerrainShape;
  readonly track = new TrackPath(2);
  readonly mono: boolean;
  /** global prop density multiplier (stage json * quality) */
  propDensity = 1;
  private proj: ProjectOut = makeProject();
  private params: TerrainParams = { hillAmp: 0, midAmp: 0, roughAmp: 0, duneAmp: 0 };
  private fbCands: number[] = [];
  private fbMix: BiomeMix;
  private fbPoint = makePoint();

  constructor(readonly seed: number, mono: boolean) {
    this.shape = new TerrainShape(seed);
    this.mono = mono;
    const b = makeBiomeRuntime(BIOMES.forest, mono);
    this.fbMix = { a: b, b, t: 0 };
  }

  /** Biome blend at world z (biomes progress along the road direction). */
  abstract biomeAt(x: number, z: number, out: BiomeMix): BiomeMix;
  /** extra rocks near the road (endless difficulty) */
  obstacleBoost(_z: number): number {
    return 0;
  }
  /** called every frame with the car position (endless streams the track) */
  update(_x: number, _z: number, _progressIdx: number): void {}

  /* ---- special stage features (bridge over a bay); defaults = none ---- */
  /** water surface height; -Infinity = no water in this world */
  waterLevel = -Infinity;
  /** 0 = normal road, 1 = bridge deck (no embankment beside it), 2 = gap (no road at all) */
  roadKind(_idx: number): number {
    return 0;
  }
  /** reshape the natural terrain (e.g. lower a bay) */
  adjustBase(_x: number, _z: number, h: number): number {
    return h;
  }
  /** where to put a car back on the road after a reset / falling in the water */
  safeRespawn(idx: number): number {
    return idx;
  }
  /** loose rocks that were knocked away this run (rockKey of their original spot) */
  readonly knockedRocks = new Set<number>();
  /** fixed obstacles on/near the road (wrecks, barriers) */
  readonly obstacles: { x: number; z: number; rot: number; type: PropType }[] = [];

  blendParams(mix: BiomeMix, out: TerrainParams): TerrainParams {
    const a = mix.a.def.terrain,
      b = mix.b.def.terrain,
      t = mix.t;
    const elev = this.elevation;
    out.hillAmp = (a.hillAmp + (b.hillAmp - a.hillAmp) * t) * elev;
    out.midAmp = (a.midAmp + (b.midAmp - a.midAmp) * t) * elev;
    out.roughAmp = a.roughAmp + (b.roughAmp - a.roughAmp) * t;
    out.duneAmp = (a.duneAmp + (b.duneAmp - a.duneAmp) * t) * elev;
    return out;
  }
  elevation = 1;

  /** Road centre height before rolls/jumps. */
  roadBase(x: number, z: number, mix: BiomeMix): number {
    return this.shape.roadBase(x, z, this.blendParams(mix, this.params));
  }

  /**
   * Full height/surface evaluation at a point, given candidate road segments.
   * Used by chunk generation (every vertex) and the physics fallback.
   */
  evalPoint(x: number, z: number, cands: number[], nc: number, mix: BiomeMix, out: PointOut): PointOut {
    const p = this.blendParams(mix, this.params);
    const base = this.adjustBase(x, z, this.shape.height(x, z, p));
    out.base = base;
    out.lf = this.shape.lastLf;
    out.h = base;
    out.edge = 1e9;
    out.lateral = 9;
    out.roadSurf = 0;
    const patch = this.shape.patch(x, z);
    out.patch = patch;
    const bio = mix.t < 0.5 ? mix.a : mix.b;
    out.surface = patch > 1 - bio.def.patchAmount * 2.2 ? bio.patch : bio.offroad;
    if (nc > 0 && this.track.nearestOf(cands, nc, x, z, this.proj)) {
      const pr = this.proj;
      const edge = pr.dist - pr.halfW;
      const kind = this.roadKind(pr.idx);
      if (edge < TERRAIN.shoulderMax && kind !== 2) {
        const diff = base - pr.h;
        // a bridge deck stands on its own: the ground right beside it is the natural ground
        const shoulder = kind === 1 ? 0.9 : clamp(TERRAIN.shoulderMin + Math.abs(diff) * TERRAIN.shoulderPerMeter, TERRAIN.shoulderMin, TERRAIN.shoulderMax);
        const w = smoothstep(0.6, shoulder, edge);
        out.h = pr.h + (base - pr.h) * w;
        out.edge = edge;
        out.lateral = pr.dist / pr.halfW;
        out.roadSurf = pr.surface;
        if (edge < 0.3) out.surface = pr.surface;
      }
    }
    return out;
  }

  /** Slow exact height (used only when the chunk under a point is not generated yet). */
  exactPoint(x: number, z: number): PointOut {
    const r = TERRAIN.shoulderMax + 8;
    const c = this.track.queryRect(x - r, z - r, x + r, z + r, this.fbCands);
    return this.evalPoint(x, z, c, c.length, this.biomeAt(x, z, this.fbMix), this.fbPoint);
  }

  surfaceName(i: number): SurfaceId {
    return SURFACES[i].id;
  }
}
