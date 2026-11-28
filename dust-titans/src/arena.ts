import { BIOMES } from '@engine/config/biomes';
import type { TimeOfDay } from '@engine/config/lighting';
import { smoothstep } from '@engine/core/math';
import { World, makeBiomeRuntime, type BiomeMix, type BiomeRuntime } from '@engine/world/world';

/**
 * A battle arena: a round bowl of natural terrain (no race track) with cliffs around the
 * edge, using any Dust Rally biome. Units can't leave the bowl (ArenaWorld.clamp).
 */
export interface ArenaDef {
  id: string;
  name: string;
  description: string;
  biome: string;
  timeOfDay: TimeOfDay;
  seed: number;
  /** playable radius (m) */
  radius: number;
  /** terrain relief multiplier (lower = flatter floor) */
  elevation: number;
  propDensity: number;
}

export const ARENAS: ArenaDef[] = [
  {
    id: 'desert-bowl',
    name: 'Desert Bowl',
    description: 'Dunes, rocks and cacti in a sunset crater. The drones are coming!',
    biome: 'desert',
    timeOfDay: 'dusk',
    seed: 7101,
    radius: 150,
    elevation: 0.55,
    propDensity: 0.8,
  },
];

export class ArenaWorld extends World {
  readonly biome: BiomeRuntime;

  constructor(
    readonly def: ArenaDef,
    mono = false,
  ) {
    super(def.seed, mono);
    this.biome = makeBiomeRuntime(BIOMES[def.biome] ?? BIOMES.desert, mono);
    this.elevation = def.elevation;
    this.propDensity = def.propDensity;
  }

  biomeAt(_x: number, _z: number, out: BiomeMix): BiomeMix {
    out.a = this.biome;
    out.b = this.biome;
    out.t = 0;
    return out;
  }

  /** a flatter floor in the middle, rising into cliffs around the edge */
  adjustBase(x: number, z: number, h: number): number {
    const R = this.def.radius;
    const d = Math.hypot(x, z);
    const floor = 0.45 + 0.55 * smoothstep(R * 0.25, R * 0.8, d);
    const wall = smoothstep(R * 0.92, R + 45, d);
    return h * floor + wall * wall * 55;
  }

  /** keep a unit inside the bowl; returns true if it was pushed back */
  clamp(p: { x: number; z: number; vx: number; vz: number }, margin = 4): boolean {
    const R = this.def.radius - margin;
    const d = Math.hypot(p.x, p.z);
    if (d <= R) return false;
    const nx = p.x / d,
      nz = p.z / d;
    p.x = nx * R;
    p.z = nz * R;
    const vn = p.vx * nx + p.vz * nz;
    if (vn > 0) {
      p.vx -= vn * nx;
      p.vz -= vn * nz;
    }
    return true;
  }
}
