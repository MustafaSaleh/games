import { BIOME_BLEND, BIOME_LIST, BIOME_SPAN } from '../config/biomes';
import { BANK_FACTOR, BANK_MAX, ENDLESS } from '../config/game';
import { SURFACE_INDEX } from '../config/surfaces';
import { clamp, range, smoothstep } from '../core/math';
import { Simplex2 } from '../core/noise';
import { Rng, hashInts } from '../core/rng';
import { jumpProfile, jumpWindow, type Gate } from './stage';
import { World, makeBiomeRuntime, type BiomeMix, type BiomeRuntime } from './world';

/**
 * Endless procedural world. The road is generated a few hundred metres ahead of the
 * car and discarded behind it; terrain chunks stream around it (see Terrain).
 * Everything derives from the seed, so a seed always reproduces the same run.
 */
export class EndlessWorld extends World {
  readonly gates: Gate[] = [];
  private biomes: BiomeRuntime[];
  private biomeSeq: number[] = [0];
  private rng: Rng;
  private curvN: Simplex2;
  private rollN: Simplex2;
  // generator state
  private gx = 0;
  private gz = 0;
  private heading = 0;
  private nextJump: number;
  private jump = { at: -1e9, h: 0, len: 24 };
  private nextZone = 0;
  private zoneSurf = 0;
  private nextGate: number;
  private mix: BiomeMix;
  readonly startIdx = 6;

  constructor(seed: number, mono: boolean) {
    super(seed, mono);
    this.biomes = BIOME_LIST.map((b) => makeBiomeRuntime(b, mono));
    this.rng = new Rng(hashInts(seed, 991));
    this.curvN = new Simplex2(seed + 7);
    this.rollN = new Simplex2(seed + 8);
    this.nextJump = 520 + this.rng.range(0, 300);
    this.nextGate = 460;
    this.mix = { a: this.biomes[0], b: this.biomes[0], t: 0 };
    this.zoneSurf = SURFACE_INDEX[this.biomes[0].def.roadSurfaces[0]];
    this.nextZone = 260;
    // first biome is chosen from the seed so different seeds look different
    this.biomeSeq[0] = hashInts(seed, 5) % this.biomes.length;
    this.extendTo(ENDLESS.trackAhead);
  }

  difficulty(s: number): number {
    return clamp(s / ENDLESS.difficultyDistance, 0, 1);
  }

  private biomeIndex(seg: number): number {
    while (this.biomeSeq.length <= seg) {
      const prev = this.biomeSeq[this.biomeSeq.length - 1];
      let next = hashInts(this.seed, this.biomeSeq.length, 77) % this.biomes.length;
      if (next === prev) next = (next + 1) % this.biomes.length;
      this.biomeSeq.push(next);
    }
    return this.biomeSeq[seg];
  }

  biomeAt(_x: number, z: number, out: BiomeMix): BiomeMix {
    const zz = Math.max(0, z);
    const seg = Math.floor(zz / BIOME_SPAN);
    const f = zz - seg * BIOME_SPAN;
    out.a = this.biomes[this.biomeIndex(seg)];
    out.b = this.biomes[this.biomeIndex(seg + 1)];
    out.t = smoothstep(BIOME_SPAN - BIOME_BLEND, BIOME_SPAN, f);
    return out;
  }

  obstacleBoost(z: number): number {
    return range(ENDLESS.obstacleBoost, this.difficulty(Math.max(0, z) / 0.85));
  }

  update(_x: number, _z: number, progressIdx: number): void {
    const sp = this.track.spacing;
    this.extendTo(progressIdx * sp + ENDLESS.trackAhead);
    const keepFrom = progressIdx - Math.round(ENDLESS.trackBehind / sp);
    if (keepFrom - this.track.base > 250) {
      this.track.trimBefore(keepFrom);
      while (this.gates.length && this.gates[0].idx < keepFrom) this.gates.shift();
    }
  }

  /** Generate road samples until the track is `sTarget` metres long. */
  extendTo(sTarget: number): void {
    const sp = this.track.spacing;
    while ((this.track.end - 1) * sp < sTarget) this.step();
  }

  private step(): void {
    const tr = this.track;
    const sp = tr.spacing;
    const idx = tr.end;
    const s = idx * sp;
    const d = this.difficulty(s);
    if (idx > 0) {
      const kMax = range(ENDLESS.maxCurvature, d);
      let c = (this.curvN.noise1(s / 150) * 0.8 + this.curvN.noise1(s / 46 + 50) * (0.15 + 0.35 * d)) * kMax * 1.5;
      c = clamp(c, -kMax, kMax);
      c *= smoothstep(40, 180, s); // straight-ish start
      // keep the road generally heading "up" the screen (+z): mean-reverting heading
      c -= this.heading * 0.0035;
      if (Math.abs(this.heading) > 1.2 && Math.sign(c) === Math.sign(this.heading)) c = -Math.sign(this.heading) * kMax * 0.4;
      // calm the curve around jumps
      const rel = s - this.jump.at;
      if (rel > -this.jump.len - 25 && rel < this.jump.len) c *= 0.2;
      this.heading += c * sp;
      this.gx += Math.sin(this.heading) * sp;
      this.gz += Math.cos(this.heading) * sp;
      this.lastCurv = c;
    }
    const x = this.gx,
      z = this.gz;
    this.biomeAt(x, z, this.mix);

    // jumps
    if (s >= this.nextJump - 40 && this.jump.at < this.nextJump) {
      this.jump.at = this.nextJump;
      this.jump.h = range(ENDLESS.jumpHeight, d) * this.rng.range(0.8, 1.15);
      this.jump.len = this.rng.range(20, 28);
      this.nextJump += range(ENDLESS.jumpEvery, d) * this.rng.range(0.7, 1.3);
    }
    // surface zones
    if (s >= this.nextZone) {
      const bio = this.mix.t < 0.5 ? this.mix.a : this.mix.b;
      const list = bio.def.roadSurfaces;
      const hard = this.rng.next() < range(ENDLESS.hardSurfaceChance, d);
      const pick = hard ? list[Math.min(list.length - 1, 1 + (this.rng.next() < 0.55 ? 1 : 0))] : list[this.rng.next() < 0.75 ? 0 : 1];
      this.zoneSurf = SURFACE_INDEX[pick];
      this.nextZone = s + this.rng.range(160, 380);
    }
    // gates
    if (s >= this.nextGate) {
      this.gates.push({ idx, s, bonus: Math.round(range(ENDLESS.gateBonus, d)), finish: false });
      this.nextGate = s + range(ENDLESS.gateSpacing, d);
    }

    const rollAmp = range(ENDLESS.rollAmp, d) * (0.35 + 0.65 * (this.rollN.noise1(s / 380) * 0.5 + 0.5));
    let h = this.roadBase(x, z, this.mix);
    h += (1 - jumpWindow(s - this.jump.at, this.jump.len)) * rollAmp * this.rollN.noise1(s / 68 + 3);
    h += jumpProfile(s - this.jump.at, this.jump.h, this.jump.len);
    const bank = clamp(this.lastCurv * BANK_FACTOR, -BANK_MAX, BANK_MAX);
    tr.push(x, z, h, Math.sin(this.heading), Math.cos(this.heading), range(ENDLESS.roadHalfWidth, d), bank, this.zoneSurf);
  }
  private lastCurv = 0;
}
