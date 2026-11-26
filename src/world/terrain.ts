import * as THREE from 'three';
import type { PropType } from '../config/biomes';
import { TERRAIN } from '../config/quality';
import { clamp, smoothstep } from '../core/math';
import { Rng, hashInts } from '../core/rng';
import { MARKER, PROP_COLLIDER, PROP_TYPES } from '../render/models';
import { makePoint, mixRGB, type BiomeMix, type RGB, type World } from './world';

const SIZE = TERRAIN.chunkSize;
const RES = TERRAIN.chunkRes;
const V = RES + 1; // vertices per side
const VB = V + 2; // with 1-vertex border (for normals)
const STEP = SIZE / RES;
const COL_CELLS = 8; // collider grid cells per chunk side
const COL_CELL = SIZE / COL_CELLS;
const PROP_CAP = 220; // per type per chunk
const COL_CAP = 600;

export const chunkKey = (cx: number, cz: number): number => (cx + 32768) * 65536 + (cz + 32768);

export interface PropBucket {
  count: number;
  mat: Float32Array; // 16 * cap
  col: Float32Array; // 3 * cap
}

/** One terrain tile. Pooled: arrays and GPU buffers are reused when it is recycled. */
export class Chunk {
  cx = 0;
  cz = 0;
  key = 0;
  x0 = 0;
  z0 = 0;
  ready = false;
  job: Generator<void, void, void> | null = null;
  readonly heights = new Float32Array(VB * VB);
  readonly edge = new Float32Array(V * V);
  readonly surf = new Uint8Array(V * V);
  private readonly lf = new Float32Array(V * V);
  private readonly patch = new Float32Array(V * V);
  private readonly lat = new Float32Array(V * V);
  private readonly roadSurf = new Uint8Array(V * V);
  readonly mesh: THREE.Mesh;
  readonly geo: THREE.BufferGeometry;
  readonly box = new THREE.Box3();
  readonly props: Record<PropType, PropBucket>;
  // colliders (x, z, r, top-y)
  colCount = 0;
  readonly colX = new Float32Array(COL_CAP);
  readonly colZ = new Float32Array(COL_CAP);
  readonly colR = new Float32Array(COL_CAP);
  readonly colTop = new Float32Array(COL_CAP);
  readonly cellStart = new Uint16Array(COL_CELLS * COL_CELLS + 1);
  readonly cellItems = new Uint16Array(COL_CAP);
  private readonly cellOf = new Uint8Array(COL_CAP);

  constructor(index: THREE.BufferAttribute, material: THREE.Material) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(V * V * 3);
    for (let j = 0; j < V; j++)
      for (let i = 0; i < V; i++) {
        const k = (j * V + i) * 3;
        pos[k] = i * STEP;
        pos[k + 2] = j * STEP;
      }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(V * V * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(V * V * 3), 3));
    geo.setIndex(index);
    geo.boundingSphere = new THREE.Sphere();
    geo.boundingBox = new THREE.Box3();
    this.geo = geo;
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;
    this.props = {} as Record<PropType, PropBucket>;
    for (const t of PROP_TYPES) this.props[t] = { count: 0, mat: new Float32Array(PROP_CAP * 16), col: new Float32Array(PROP_CAP * 3) };
  }

  /** bilinear height at local coords (no bounds check beyond clamping) */
  heightLocal(lx: number, lz: number): number {
    const fx = clamp(lx / STEP, 0, RES - 1e-4);
    const fz = clamp(lz / STEP, 0, RES - 1e-4);
    const i = Math.floor(fx),
      j = Math.floor(fz);
    const tx = fx - i,
      tz = fz - j;
    const h = this.heights;
    const k = (j + 1) * VB + (i + 1);
    const h00 = h[k],
      h10 = h[k + 1],
      h01 = h[k + VB],
      h11 = h[k + VB + 1];
    return (h00 + (h10 - h00) * tx) * (1 - tz) + (h01 + (h11 - h01) * tx) * tz;
  }

  vertexIndex(lx: number, lz: number): number {
    const i = clamp(Math.round(lx / STEP), 0, RES);
    const j = clamp(Math.round(lz / STEP), 0, RES);
    return j * V + i;
  }

  /** Generation job, run a slice at a time by the Terrain scheduler. */
  *generate(world: World, propMul: number): Generator<void, void, void> {
    const x0 = this.x0,
      z0 = this.z0;
    const margin = TERRAIN.shoulderMax + 8;
    const allCands = world.track.queryRect(x0 - margin, z0 - margin, x0 + SIZE + margin, z0 + SIZE + margin, scratchCands);
    dedupe(allCands);
    const mix: BiomeMix = { a: null!, b: null!, t: 0 };
    const pt = makePoint();
    const h = this.heights;
    // --- heights + surface data, in 4-row bands with per-band candidate culling
    const BAND = 3;
    for (let j0 = -1; j0 <= V; j0 += BAND) {
      const j1 = Math.min(V, j0 + BAND - 1);
      const bz0 = z0 + j0 * STEP - margin,
        bz1 = z0 + j1 * STEP + margin;
      let nc = 0;
      for (let c = 0; c < allCands.length; c++) {
        const i = allCands[c];
        const za = world.track.z(i),
          zb = world.track.z(i + 1);
        if (Math.max(za, zb) < bz0 || Math.min(za, zb) > bz1) continue;
        bandCands[nc++] = i;
      }
      for (let j = j0; j <= j1; j++) {
        const z = z0 + j * STEP;
        world.biomeAt(x0, z, mix);
        if (j >= 0 && j < V) rowMix[j] = mix.t;
        for (let i = -1; i <= V; i++) {
          const x = x0 + i * STEP;
          world.evalPoint(x, z, bandCands, nc, mix, pt);
          h[(j + 1) * VB + (i + 1)] = pt.h;
          if (i >= 0 && i < V && j >= 0 && j < V) {
            const k = j * V + i;
            this.edge[k] = pt.edge;
            this.surf[k] = pt.surface;
            this.lf[k] = pt.lf;
            this.patch[k] = pt.patch;
            this.lat[k] = pt.lateral;
            this.roadSurf[k] = pt.roadSurf;
          }
        }
      }
      yield;
    }

    // --- normals + colours
    const pos = this.geo.attributes.position.array as Float32Array;
    const nor = this.geo.attributes.normal.array as Float32Array;
    const col = this.geo.attributes.color.array as Float32Array;
    let minH = 1e9,
      maxH = -1e9;
    const c: RGB = [0, 0, 0];
    const t1: RGB = [0, 0, 0];
    for (let j = 0; j < V; j++) {
      const z = z0 + j * STEP;
      world.biomeAt(x0, z, mix);
      const pa = mix.a.pal,
        pb = mix.b.pal,
        mt = mix.t;
      const bio = mt < 0.5 ? mix.a : mix.b;
      const patchThr = 1 - bio.def.patchAmount * 2.2;
      for (let i = 0; i < V; i++) {
        const k = j * V + i;
        const kb = (j + 1) * VB + (i + 1);
        const hc = h[kb],
          hl = h[kb - 1],
          hr = h[kb + 1],
          hd = h[kb - VB],
          hu = h[kb + VB];
        let nx = (hl - hr) / (2 * STEP),
          ny = 1,
          nz = (hd - hu) / (2 * STEP);
        const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
        nx *= inv;
        ny *= inv;
        nz *= inv;
        nor[k * 3] = nx;
        nor[k * 3 + 1] = ny;
        nor[k * 3 + 2] = nz;
        pos[k * 3 + 1] = hc;
        if (hc < minH) minH = hc;
        if (hc > maxH) maxH = hc;

        // base ground colour: patches, valleys, hill tops
        const pn = this.patch[k];
        const lfv = this.lf[k];
        mixRGB(pa.ground, pb.ground, mt, c);
        mixRGB(c, mixRGB(pa.groundAlt, pb.groundAlt, mt, t1), smoothstep(-0.35, 0.45, pn), c);
        mixRGB(mixRGB(pa.groundLow, pb.groundLow, mt, t1), c, smoothstep(-0.85, -0.05, lfv), c);
        mixRGB(c, mixRGB(pa.groundHigh, pb.groundHigh, mt, t1), smoothstep(0.35, 0.95, lfv), c);
        // off-road surface patches (mud, ice, gravel...)
        const pw = smoothstep(patchThr - 0.06, patchThr + 0.1, pn);
        if (pw > 0) {
          const ps = bio.patch;
          mixRGB(c, mixRGB(pa.surfaces[ps], pb.surfaces[ps], mt, t1), pw * 0.9, c);
        }
        // steep cuts
        mixRGB(c, mixRGB(pa.steep, pb.steep, mt, t1), smoothstep(0.12, 0.4, 1 - ny) * 0.8, c);
        // road
        const e = this.edge[k];
        let roadShade = 1;
        if (e < 2.5) {
          const rs = this.roadSurf[k];
          const rw = 1 - smoothstep(-0.9, 0.7, e);
          mixRGB(c, mixRGB(pa.surfaces[rs], pb.surfaces[rs], mt, t1), rw, c);
          // packed centre / loose edges + a darker berm just outside the edge
          const l = this.lat[k];
          roadShade = 1.05 - 0.1 * l * l * rw;
          const berm = Math.exp(-((e - 0.9) * (e - 0.9)) / 0.9);
          roadShade *= 1 - 0.22 * berm;
        }
        // fake AO: concave = darker, convex = lighter
        const lap = (hl + hr + hu + hd - 4 * hc) / (STEP * STEP);
        let shade = clamp(1 - lap * 0.35, 0.82, 1.08) * roadShade;
        // tiny per-vertex grain
        shade *= 0.975 + (hashInts(this.cx * V + i, this.cz * V + j) & 255) / 255 * 0.05;
        col[k * 3] = c[0] * shade;
        col[k * 3 + 1] = c[1] * shade;
        col[k * 3 + 2] = c[2] * shade;
      }
      if ((j & 7) === 7) yield;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.normal.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
    this.geo.boundingBox!.min.set(0, minH - 1, 0);
    this.geo.boundingBox!.max.set(SIZE, maxH + 1, SIZE);
    this.geo.boundingBox!.getBoundingSphere(this.geo.boundingSphere!);
    this.box.min.set(x0, minH - 1, z0);
    this.box.max.set(x0 + SIZE, maxH + 6, z0 + SIZE);
    yield;

    this.placeProps(world, propMul, mix);
    this.placeMarkers(world, allCands);
  }

  /** Reflector posts along both road edges. */
  private placeMarkers(world: World, cands: number[]): void {
    const tr = world.track;
    const white: RGB = [1, 1, 1];
    for (let c = 0; c < cands.length; c++) {
      const i = cands[c];
      if (i % MARKER.every !== 0) continue;
      const x = tr.x(i),
        z = tr.z(i);
      if (x < this.x0 || x >= this.x0 + SIZE || z < this.z0 || z >= this.z0 + SIZE) continue;
      const off = tr.halfW(i) + MARKER.offset;
      const rx = -tr.dz(i),
        rz = tr.dx(i);
      for (let side = -1; side <= 1; side += 2) {
        const px = x + rx * off * side,
          pz = z + rz * off * side;
        const lx = px - this.x0,
          lz = pz - this.z0;
        if (lx < 0 || lx >= SIZE || lz < 0 || lz >= SIZE) continue;
        this.addProp('marker', px, pz, lx, lz, 1, Math.atan2(tr.dx(i), tr.dz(i)), white);
      }
    }
  }

  private placeProps(world: World, propMul: number, mix: BiomeMix): void {
    const rng = chunkRng;
    rng.seed(hashInts(this.cx, this.cz, world.seed));
    for (const t of PROP_TYPES) this.props[t].count = 0;
    this.colCount = 0;
    const area = (SIZE * SIZE) / 1000;
    const midZ = this.z0 + SIZE / 2;
    world.biomeAt(this.x0, midZ, mix);
    for (let b = 0; b < 2; b++) {
      const bio = b === 0 ? mix.a : mix.b;
      const share = b === 0 ? 1 - mix.t : mix.t;
      if (share <= 0.001 || (b === 1 && mix.a === mix.b)) continue;
      const pal = bio.pal;
      for (const rule of bio.def.props) {
        const n = Math.round(rule.density * area * share * propMul * world.propDensity * rng.range(0.8, 1.2));
        for (let k = 0; k < n; k++) {
          const lx = rng.next() * SIZE,
            lz = rng.next() * SIZE;
          const x = this.x0 + lx,
            z = this.z0 + lz;
          // biome boundary inside the chunk: keep the prop only if it belongs to this side
          if (mix.a !== mix.b) {
            world.biomeAt(x, z, tmpMix);
            const tb = tmpMix.t;
            if (rng.next() > (b === 0 ? 1 - tb : tb)) continue;
          }
          if (rule.cluster > 0) {
            const cm = world.shape.cluster(x, z);
            if (rng.next() > 1 - rule.cluster + rule.cluster * smoothstep(0.35, 0.7, cm)) continue;
          }
          const vi = this.vertexIndex(lx, lz);
          if (this.edge[vi] < rule.roadGap) continue;
          const s = rng.range(rule.scale[0], rule.scale[1]);
          const color =
            rule.type === 'pine' || rule.type === 'round' || rule.type === 'cactus'
              ? rng.next() < 0.5
                ? pal.foliage
                : pal.foliageAlt
              : rule.type === 'rock' || rule.type === 'pebble'
                ? pal.rock
                : rule.type === 'shrub'
                  ? mixRGB(pal.bush, pal.trunk, 0.4, tmpRGB)
                  : pal.bush;
          this.addProp(rule.type, x, z, lx, lz, s, rng.next() * Math.PI * 2, color);
        }
      }
    }
    // endless difficulty: rocks close to the road edge
    const boost = world.obstacleBoost(midZ);
    if (boost > 0) {
      const tries = Math.round(boost * 10);
      const pal = mix.a.pal;
      for (let k = 0; k < tries; k++) {
        const lx = rng.next() * SIZE,
          lz = rng.next() * SIZE;
        const e = this.edge[this.vertexIndex(lx, lz)];
        if (e < 0.3 || e > 3.5) continue;
        this.addProp('rock', this.x0 + lx, this.z0 + lz, lx, lz, rng.range(0.7, 1.3), rng.next() * 6.28, pal.rock);
      }
    }
    // build collider grid (counting sort into cells)
    const cs = this.cellStart;
    cs.fill(0);
    for (let i = 0; i < this.colCount; i++) cs[this.cellOf[i] + 1]++;
    for (let i = 1; i < cs.length; i++) cs[i] += cs[i - 1];
    const fill = scratchFill;
    fill.fill(0);
    for (let i = 0; i < this.colCount; i++) {
      const cell = this.cellOf[i];
      this.cellItems[cs[cell] + fill[cell]++] = i;
    }
  }

  private addProp(type: PropType, x: number, z: number, lx: number, lz: number, s: number, rot: number, color: RGB): void {
    const b = this.props[type];
    if (b.count >= PROP_CAP) return;
    const y = this.heightLocal(lx, lz) - (type === 'rock' ? 0.15 * s : 0.05);
    const co = Math.cos(rot) * s,
      si = Math.sin(rot) * s;
    const m = b.mat,
      o = b.count * 16;
    m[o] = co;
    m[o + 1] = 0;
    m[o + 2] = -si;
    m[o + 3] = 0;
    m[o + 4] = 0;
    m[o + 5] = s;
    m[o + 6] = 0;
    m[o + 7] = 0;
    m[o + 8] = si;
    m[o + 9] = 0;
    m[o + 10] = co;
    m[o + 11] = 0;
    m[o + 12] = x;
    m[o + 13] = y;
    m[o + 14] = z;
    m[o + 15] = 1;
    const cc = b.count * 3;
    b.col[cc] = color[0];
    b.col[cc + 1] = color[1];
    b.col[cc + 2] = color[2];
    b.count++;
    const pc = PROP_COLLIDER[type];
    if (pc.r > 0 && this.colCount < COL_CAP) {
      const i = this.colCount++;
      this.colX[i] = x;
      this.colZ[i] = z;
      this.colR[i] = pc.r * s;
      this.colTop[i] = y + pc.top * s;
      const gx = clamp(Math.floor(lx / COL_CELL), 0, COL_CELLS - 1);
      const gz = clamp(Math.floor(lz / COL_CELL), 0, COL_CELLS - 1);
      this.cellOf[i] = gz * COL_CELLS + gx;
    }
  }
}

const scratchCands: number[] = [];
const bandCands: number[] = [];
const rowMix = new Float32Array(V);
const scratchFill = new Uint16Array(COL_CELLS * COL_CELLS);
const chunkRng = new Rng(1);
const tmpMix: BiomeMix = { a: null!, b: null!, t: 0 };
const tmpRGB: RGB = [0, 0, 0];

function dedupe(a: number[]): void {
  if (a.length < 2) return;
  a.sort((x, y) => x - y);
  let w = 1;
  for (let r = 1; r < a.length; r++) if (a[r] !== a[w - 1]) a[w++] = a[r];
  a.length = w;
}

function buildIndex(): THREE.BufferAttribute {
  const idx = new Uint16Array(RES * RES * 6);
  let o = 0;
  for (let j = 0; j < RES; j++)
    for (let i = 0; i < RES; i++) {
      const a = j * V + i,
        b = a + 1,
        c = a + V,
        d = c + 1;
      // alternate diagonals for a less "combed" look
      if ((i + j) & 1) {
        idx[o++] = a;
        idx[o++] = c;
        idx[o++] = b;
        idx[o++] = b;
        idx[o++] = c;
        idx[o++] = d;
      } else {
        idx[o++] = a;
        idx[o++] = c;
        idx[o++] = d;
        idx[o++] = a;
        idx[o++] = d;
        idx[o++] = b;
      }
    }
  return new THREE.BufferAttribute(idx, 1);
}

export interface GroundSample {
  h: number;
  nx: number;
  ny: number;
  nz: number;
  surface: number;
  edge: number;
}

export function makeGroundSample(): GroundSample {
  return { h: 0, nx: 0, ny: 1, nz: 0, surface: 0, edge: 1e9 };
}

/** Flat list of colliders near a point, filled by Terrain.queryColliders (no allocation). */
export class ColliderHits {
  count = 0;
  x = new Float32Array(64);
  z = new Float32Array(64);
  r = new Float32Array(64);
  top = new Float32Array(64);
}

/**
 * Streams chunks around a focus point. Generation is time-sliced (generators) so a
 * new chunk never causes a frame spike. The physics reads heights from the chunks
 * (bilinear) and falls back to the exact function for not-yet-built chunks.
 */
export class Terrain {
  readonly group = new THREE.Group();
  readonly chunks = new Map<number, Chunk>();
  private pool: Chunk[] = [];
  private queue: Chunk[] = [];
  private active: Chunk | null = null;
  private index = buildIndex();
  readonly material: THREE.MeshLambertMaterial;
  /** bumps whenever the set of ready chunks changes (props need a rebuild) */
  version = 0;
  stats = { generated: 0, lastGenMs: 0, pooled: 0 };
  private propMul = 1;

  constructor(
    readonly world: World,
    public viewRadius: number,
  ) {
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.group.matrixAutoUpdate = false;
  }

  setPropDensity(m: number): void {
    this.propMul = m;
  }

  private obtain(cx: number, cz: number): Chunk {
    const c = this.pool.pop() ?? new Chunk(this.index, this.material);
    c.cx = cx;
    c.cz = cz;
    c.key = chunkKey(cx, cz);
    c.x0 = cx * SIZE;
    c.z0 = cz * SIZE;
    c.ready = false;
    c.job = null;
    c.mesh.visible = false;
    c.mesh.position.set(c.x0, 0, c.z0);
    c.mesh.updateMatrix();
    if (!c.mesh.parent) this.group.add(c.mesh);
    this.chunks.set(c.key, c);
    return c;
  }

  private release(c: Chunk): void {
    this.chunks.delete(c.key);
    c.ready = false;
    c.job = null;
    c.mesh.visible = false;
    this.pool.push(c);
    this.stats.pooled = this.pool.length;
  }

  private finishChunk(c: Chunk): void {
    c.ready = true;
    c.job = null;
    c.mesh.visible = true;
    this.version++;
    this.stats.generated++;
  }

  /** Synchronously generate everything around a point (initial load / reset). */
  ensureAround(x: number, z: number, radius = this.viewRadius): void {
    this.update(x, z, 0);
    const r2 = radius * radius;
    for (const c of this.chunks.values()) {
      if (c.ready) continue;
      const dx = c.x0 + SIZE / 2 - x,
        dz = c.z0 + SIZE / 2 - z;
      if (dx * dx + dz * dz > r2) continue;
      if (!c.job) c.job = c.generate(this.world, this.propMul);
      while (!c.job.next().done) {
        /* run to completion */
      }
      if (this.active === c) this.active = null;
      this.finishChunk(c);
    }
    this.queue = this.queue.filter((c) => !c.ready && this.chunks.get(c.key) === c);
  }

  /** Stream chunks around (x,z); spend at most budgetMs generating. */
  update(x: number, z: number, budgetMs: number): void {
    const R = this.viewRadius;
    const unloadR = R + SIZE * 1.2;
    // unload
    for (const c of this.chunks.values()) {
      const dx = c.x0 + SIZE / 2 - x,
        dz = c.z0 + SIZE / 2 - z;
      if (dx * dx + dz * dz > unloadR * unloadR) {
        if (this.active === c) this.active = null;
        if (c.ready) this.version++;
        this.release(c);
      }
    }
    // request
    const c0x = Math.floor((x - R) / SIZE),
      c1x = Math.floor((x + R) / SIZE);
    const c0z = Math.floor((z - R) / SIZE),
      c1z = Math.floor((z + R) / SIZE);
    let added = false;
    for (let cz = c0z; cz <= c1z; cz++)
      for (let cx = c0x; cx <= c1x; cx++) {
        const dx = cx * SIZE + SIZE / 2 - x,
          dz = cz * SIZE + SIZE / 2 - z;
        if (dx * dx + dz * dz > (R + SIZE * 0.5) * (R + SIZE * 0.5)) continue;
        const k = chunkKey(cx, cz);
        if (this.chunks.has(k)) continue;
        this.queue.push(this.obtain(cx, cz));
        added = true;
      }
    if (added || this.queue.length > 1) {
      // nearest first
      for (let i = this.queue.length - 1; i >= 0; i--) if (this.chunks.get(this.queue[i].key) !== this.queue[i] || this.queue[i].ready) this.queue.splice(i, 1);
      this.queue.sort((a, b) => dist2(a, x, z) - dist2(b, x, z));
    }
    if (budgetMs <= 0) return;
    const t0 = performance.now();
    while (performance.now() - t0 < budgetMs) {
      if (!this.active) {
        const next = this.queue.shift();
        if (!next) break;
        if (this.chunks.get(next.key) !== next || next.ready) continue;
        this.active = next;
        next.job = next.generate(this.world, this.propMul);
      }
      const c = this.active;
      if (c.job!.next().done) {
        this.finishChunk(c);
        this.active = null;
      }
    }
    this.stats.lastGenMs = performance.now() - t0;
  }

  get pending(): number {
    return this.queue.length + (this.active ? 1 : 0);
  }

  chunkAt(x: number, z: number): Chunk | undefined {
    return this.chunks.get(chunkKey(Math.floor(x / SIZE), Math.floor(z / SIZE)));
  }

  heightAt(x: number, z: number): number {
    const c = this.chunkAt(x, z);
    if (c && c.ready) return c.heightLocal(x - c.x0, z - c.z0);
    return this.world.exactPoint(x, z).h;
  }

  /** Height, normal and surface at (x,z). */
  sample(x: number, z: number, out: GroundSample): GroundSample {
    const c = this.chunkAt(x, z);
    const d = 1.0;
    if (c && c.ready) {
      const lx = x - c.x0,
        lz = z - c.z0;
      out.h = c.heightLocal(lx, lz);
      const vi = c.vertexIndex(lx, lz);
      out.surface = c.surf[vi];
      out.edge = c.edge[vi];
    } else {
      const p = this.world.exactPoint(x, z);
      out.h = p.h;
      out.surface = p.surface;
      out.edge = p.edge;
    }
    const hl = this.heightAt(x - d, z),
      hr = this.heightAt(x + d, z);
    const hd = this.heightAt(x, z - d),
      hu = this.heightAt(x, z + d);
    let nx = (hl - hr) / (2 * d),
      ny = 1,
      nz = (hd - hu) / (2 * d);
    const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
    nx *= inv;
    ny *= inv;
    nz *= inv;
    out.nx = nx;
    out.ny = ny;
    out.nz = nz;
    return out;
  }

  /** Colliders whose grid cells overlap the circle (x,z,r). */
  queryColliders(x: number, z: number, r: number, out: ColliderHits): ColliderHits {
    out.count = 0;
    const gx0 = Math.floor((x - r - 2) / COL_CELL),
      gx1 = Math.floor((x + r + 2) / COL_CELL);
    const gz0 = Math.floor((z - r - 2) / COL_CELL),
      gz1 = Math.floor((z + r + 2) / COL_CELL);
    for (let gz = gz0; gz <= gz1; gz++)
      for (let gx = gx0; gx <= gx1; gx++) {
        const cx = Math.floor(gx / COL_CELLS),
          cz = Math.floor(gz / COL_CELLS);
        const c = this.chunks.get(chunkKey(cx, cz));
        if (!c || !c.ready) continue;
        const cell = (gz - cz * COL_CELLS) * COL_CELLS + (gx - cx * COL_CELLS);
        for (let k = c.cellStart[cell]; k < c.cellStart[cell + 1]; k++) {
          if (out.count >= out.x.length) return out;
          const i = c.cellItems[k];
          const n = out.count++;
          out.x[n] = c.colX[i];
          out.z[n] = c.colZ[i];
          out.r[n] = c.colR[i];
          out.top[n] = c.colTop[i];
        }
      }
    return out;
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const c of [...this.chunks.values(), ...this.pool]) c.geo.dispose();
    this.material.dispose();
    this.chunks.clear();
    this.pool.length = 0;
  }
}

function dist2(c: Chunk, x: number, z: number): number {
  const dx = c.x0 + SIZE / 2 - x,
    dz = c.z0 + SIZE / 2 - z;
  return dx * dx + dz * dz;
}
