import * as THREE from 'three';
import { BIOMES } from '@engine/config/biomes';
import type { TimeOfDay } from '@engine/config/lighting';
import { smoothstep } from '@engine/core/math';
import type { TrackId } from '@engine/core/music';
import { type ColliderHits, type GroundSample, type Terrain } from '@engine/world/terrain';
import { World, makeBiomeRuntime, type BiomeMix, type BiomeRuntime } from '@engine/world/world';
import { CITY_BIOMES, SHAPES, buildCity, type CityId, type Solid } from './world/cities';
import type { Ground } from './units/unit';

/**
 * A battle arena: a round bowl of terrain (no race track) with a raised rim, using a Dust
 * Rally biome or a city biome. Units can't leave the bowl (ArenaWorld.clamp).
 */
export interface ArenaDef {
  id: string;
  name: string;
  description: string;
  icon: string;
  biome: string;
  timeOfDay: TimeOfDay;
  seed: number;
  /** playable radius (m) */
  radius: number;
  /** terrain relief multiplier (lower = flatter floor) */
  elevation: number;
  propDensity: number;
  /** rim height (m); low for cities so the skyline shows */
  wall: number;
  music: TrackId;
  city?: CityId;
}

export const ARENAS: ArenaDef[] = [
  { id: 'desert-bowl', name: 'Desert Bowl', icon: '🏜️', description: 'Dunes, rocks and cacti in a sunset crater.', biome: 'desert', timeOfDay: 'dusk', seed: 7101, radius: 150, elevation: 0.55, propDensity: 0.8, wall: 55, music: 'dust' },
  { id: 'cairo', name: 'Cairo · Nile Bank', icon: '🐫', description: 'The Nile winds through the arena: wade across or jump. Pyramids on the horizon.', biome: 'cairo', city: 'cairo', timeOfDay: 'dusk', seed: 2020, radius: 150, elevation: 0.35, propDensity: 0.7, wall: 16, music: 'sunny' },
  { id: 'riyadh', name: 'Riyadh · Edge of the World', icon: '🌴', description: 'A high plateau: robot suits jump up, tanks take the ramp. Sky-bridge tower on the horizon.', biome: 'riyadh', city: 'riyadh', timeOfDay: 'day', seed: 1966, radius: 150, elevation: 0.4, propDensity: 0.7, wall: 16, music: 'turbo' },
  { id: 'dubai', name: 'Dubai · Marina Nights', icon: '🌃', description: 'Neon towers, a beach and the sea. The tallest tower on Earth lights up the night.', biome: 'dubai', city: 'dubai', timeOfDay: 'night', seed: 2010, radius: 150, elevation: 0.35, propDensity: 0.6, wall: 14, music: 'turbo' },
  { id: 'forest', name: 'Forest Clearing', icon: '🌲', description: 'Pines all around: great cover, watch the shadows.', biome: 'forest', timeOfDay: 'day', seed: 4242, radius: 140, elevation: 0.5, propDensity: 0.55, wall: 50, music: 'sunny' },
  { id: 'frozen', name: 'Frozen Lake', icon: '❄️', description: 'Snow and ice: tanks slide, robot suits stomp.', biome: 'snow', timeOfDay: 'day', seed: 3131, radius: 140, elevation: 0.45, propDensity: 0.6, wall: 50, music: 'frost' },
  { id: 'redwoods', name: 'Redwood Grove', icon: '🌳', description: 'Giant trees to hide behind.', biome: 'redwood', timeOfDay: 'dusk', seed: 5151, radius: 140, elevation: 0.5, propDensity: 0.6, wall: 50, music: 'sunny' },
  { id: 'ghost-town', name: 'Ghost Town', icon: '🏚️', description: 'An abandoned city taken over by grass (and aliens).', biome: 'city', timeOfDay: 'dusk', seed: 6161, radius: 140, elevation: 0.5, propDensity: 0.6, wall: 40, music: 'dust' },
];

export const arenaById = (id: string): ArenaDef => ARENAS.find((a) => a.id === id) ?? ARENAS[0];

export class ArenaWorld extends World {
  readonly biome: BiomeRuntime;
  private cityShape?: (x: number, z: number, h: number) => number;

  constructor(
    readonly def: ArenaDef,
    mono = false,
  ) {
    super(def.seed, mono);
    const city = def.city ? SHAPES[def.city] : undefined;
    this.biome = makeBiomeRuntime(BIOMES[def.biome] ?? CITY_BIOMES[def.biome as CityId] ?? BIOMES.desert, mono);
    this.elevation = def.elevation;
    this.propDensity = def.propDensity;
    this.cityShape = city?.shape;
    if (city?.water !== undefined) this.waterLevel = city.water;
  }

  biomeAt(_x: number, _z: number, out: BiomeMix): BiomeMix {
    out.a = this.biome;
    out.b = this.biome;
    out.t = 0;
    return out;
  }

  /** a flatter floor in the middle, rising into a rim around the edge */
  adjustBase(x: number, z: number, h: number): number {
    const R = this.def.radius;
    const d = Math.hypot(x, z);
    const floor = 0.45 + 0.55 * smoothstep(R * 0.25, R * 0.8, d);
    const wall = smoothstep(R * 0.92, R + 45, d);
    const base = h * floor + wall * wall * this.def.wall;
    return this.cityShape ? this.cityShape(x, z, base) : base;
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

/**
 * The ground the battle sees: the terrain plus the arena's own solid scenery (city cover)
 * for units, shots and enemies.
 */
export class ArenaGround implements Ground {
  constructor(
    readonly terrain: Terrain,
    readonly solids: Solid[],
  ) {}

  heightAt(x: number, z: number): number {
    return this.terrain.heightAt(x, z);
  }

  sample(x: number, z: number, out: GroundSample): GroundSample {
    return this.terrain.sample(x, z, out);
  }

  queryColliders(x: number, z: number, r: number, out: ColliderHits): ColliderHits {
    this.terrain.queryColliders(x, z, r, out);
    for (const s of this.solids) {
      if (out.count >= out.x.length) break;
      const dx = x - s.x,
        dz = z - s.z,
        rr = r + s.r + 1;
      if (dx * dx + dz * dz > rr * rr) continue;
      const i = out.count++;
      out.x[i] = s.x;
      out.z[i] = s.z;
      out.r[i] = s.r;
      out.top[i] = s.top;
      out.loose[i] = 0;
      out.chunk[i] = null;
      out.idx[i] = -1;
    }
    return out;
  }
}

/** landmarks + cover for a city arena (empty group for natural arenas) */
export function buildScenery(def: ArenaDef, heightAt: (x: number, z: number) => number): { group: THREE.Group; solids: Solid[] } {
  return def.city ? buildCity(def.city, heightAt, def.radius) : { group: new THREE.Group(), solids: [] };
}
