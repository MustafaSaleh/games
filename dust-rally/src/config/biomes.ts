import type { SurfaceId } from './surfaces';

/** Props that can be scattered around. Each one is a single InstancedMesh. */
export type PropType = 'pine' | 'round' | 'rock' | 'pebble' | 'bush' | 'shrub' | 'cactus' | 'marker' | 'redwood' | 'ruin' | 'tower' | 'wreck' | 'barrier';
/** props that carry their own colours (the instance colour only varies brightness) */
export const SELF_COLORED: ReadonlySet<PropType> = new Set<PropType>(['redwood', 'ruin', 'tower', 'wreck', 'barrier']);

export interface PropRule {
  type: PropType;
  /** instances per 1000 m² */
  density: number;
  /** clustering: 0 = uniform, 1 = only in noise clumps */
  cluster: number;
  scale: [number, number];
  /** minimum distance from road edge (m) */
  roadGap: number;
}

/** All colours are sRGB hex. */
export interface BiomePalette {
  ground: number;
  groundAlt: number; // patch variation
  groundLow: number; // valleys
  groundHigh: number; // hill tops / ridges
  steep: number; // steep slopes / cuts
  surfaces: Record<SurfaceId, number>;
  foliage: number;
  foliageAlt: number;
  trunk: number;
  rock: number;
  bush: number;
  fog: number;
}

export interface TerrainParams {
  hillAmp: number; // big rolling hills (~220 m wavelength)
  midAmp: number; // medium bumps (~70 m)
  roughAmp: number; // small bumps (~18 m)
  duneAmp: number; // ridged dunes
}

export interface BiomeDef {
  id: string;
  name: string;
  palette: BiomePalette;
  offroad: SurfaceId;
  /** off-road patches of another surface (mud puddles, ice sheets...) */
  patch: SurfaceId;
  patchAmount: number; // 0..1
  /** road surfaces used by the endless generator, easy -> hard */
  roadSurfaces: SurfaceId[];
  terrain: TerrainParams;
  props: PropRule[];
  /** distant mountain ranges on the horizon (seen from the chase camera) */
  skyline?: { rock: number; rockFar: number; snow: number };
}

const forest: BiomeDef = {
  id: 'forest',
  name: 'Forest',
  palette: {
    ground: 0x6f9a48,
    groundAlt: 0x5f8c3e,
    groundLow: 0x4f7a37,
    groundHigh: 0x86ac57,
    steep: 0x7a6a4a,
    surfaces: {
      tarmac: 0x4a4a4e,
      gravel: 0x9c8a6c,
      dirt: 0x8a6a45,
      sand: 0xc9ad78,
      snow: 0xe8eef2,
      ice: 0xbcd6e6,
      mud: 0x5a4632,
      grass: 0x6f9a48,
    },
    foliage: 0x2f5a2c,
    foliageAlt: 0x3d6b32,
    trunk: 0x5b4030,
    rock: 0x7b7d80,
    bush: 0x4c7d35,
    fog: 0xa9c4b0,
  },
  offroad: 'grass',
  patch: 'mud',
  patchAmount: 0.14,
  roadSurfaces: ['gravel', 'dirt', 'mud'],
  terrain: { hillAmp: 16, midAmp: 4.5, roughAmp: 0.6, duneAmp: 0 },
  props: [
    { type: 'pine', density: 8, cluster: 0.55, scale: [0.8, 1.4], roadGap: 2.5 },
    { type: 'round', density: 1.2, cluster: 0.4, scale: [0.8, 1.3], roadGap: 3 },
    { type: 'bush', density: 2.0, cluster: 0.3, scale: [0.6, 1.2], roadGap: 1 },
    { type: 'rock', density: 0.8, cluster: 0.2, scale: [0.6, 1.3], roadGap: 2 },
    { type: 'pebble', density: 4, cluster: 0, scale: [0.4, 0.9], roadGap: 0.5 },
  ],
};

const desert: BiomeDef = {
  id: 'desert',
  name: 'Desert',
  palette: {
    ground: 0xd6a66c,
    groundAlt: 0xcc9a60,
    groundLow: 0xbd8650,
    groundHigh: 0xe4c08c,
    steep: 0xb9794b,
    surfaces: {
      tarmac: 0x55504a,
      gravel: 0xb89474,
      dirt: 0xb07a4e,
      sand: 0xf0d8a8,
      snow: 0xf2f2f2,
      ice: 0xcfe3ee,
      mud: 0x7a5a3a,
      grass: 0xc7b06a,
    },
    foliage: 0x7f8a45,
    foliageAlt: 0x96884a,
    trunk: 0x6b4b30,
    rock: 0xa0623e,
    bush: 0x9a8a50,
    fog: 0xecd2a8,
  },
  offroad: 'sand',
  patch: 'gravel',
  patchAmount: 0.25,
  roadSurfaces: ['gravel', 'dirt', 'sand'],
  terrain: { hillAmp: 10, midAmp: 2.5, roughAmp: 0.35, duneAmp: 7 },
  props: [
    { type: 'rock', density: 1.4, cluster: 0.5, scale: [0.7, 1.8], roadGap: 2 },
    { type: 'shrub', density: 2.6, cluster: 0.2, scale: [0.6, 1.2], roadGap: 1 },
    { type: 'cactus', density: 0.7, cluster: 0.3, scale: [0.8, 1.4], roadGap: 2.5 },
    { type: 'pebble', density: 5, cluster: 0, scale: [0.4, 1.0], roadGap: 0.5 },
  ],
};

const snow: BiomeDef = {
  id: 'snow',
  name: 'Snow',
  palette: {
    ground: 0xe6edf2,
    groundAlt: 0xd8e3ec,
    groundLow: 0xc5d4e2,
    groundHigh: 0xf6f9fb,
    steep: 0x9aa7b4,
    surfaces: {
      tarmac: 0x5a5e66,
      gravel: 0xa7a49c,
      dirt: 0x8d8070,
      sand: 0xcbbd9a,
      snow: 0x9aa8b8,
      ice: 0x9cc6e2,
      mud: 0x6a6056,
      grass: 0xb8c6b0,
    },
    foliage: 0x22403a,
    foliageAlt: 0x2b4b40,
    trunk: 0x4a3a30,
    rock: 0x6c7380,
    bush: 0x5c6e68,
    fog: 0xd2dde8,
  },
  offroad: 'snow',
  patch: 'ice',
  patchAmount: 0.2,
  roadSurfaces: ['snow', 'gravel', 'ice'],
  terrain: { hillAmp: 20, midAmp: 5, roughAmp: 0.5, duneAmp: 0 },
  props: [
    { type: 'pine', density: 7, cluster: 0.6, scale: [0.9, 1.5], roadGap: 2.5 },
    { type: 'rock', density: 1.0, cluster: 0.4, scale: [0.6, 1.5], roadGap: 2 },
    { type: 'bush', density: 0.8, cluster: 0.3, scale: [0.5, 1.0], roadGap: 1 },
    { type: 'pebble', density: 3, cluster: 0, scale: [0.4, 0.9], roadGap: 0.5 },
  ],
};

const savanna: BiomeDef = {
  id: 'savanna',
  name: 'Savanna',
  palette: {
    ground: 0xc9b25a,
    groundAlt: 0xbba24c,
    groundLow: 0xa99446,
    groundHigh: 0xd9c46e,
    steep: 0x9c6a42,
    surfaces: {
      tarmac: 0x4e4a48,
      gravel: 0xa45f3e,
      dirt: 0x9a5a38,
      sand: 0xd7b880,
      snow: 0xeeeeee,
      ice: 0xc8e0ec,
      mud: 0x6a4630,
      grass: 0xc9b25a,
    },
    foliage: 0x5d7a2e,
    foliageAlt: 0x6e8a36,
    trunk: 0x5a3e2a,
    rock: 0x8c6a52,
    bush: 0x7a8a3a,
    fog: 0xe0cf9a,
  },
  offroad: 'grass',
  patch: 'sand',
  patchAmount: 0.2,
  roadSurfaces: ['dirt', 'gravel', 'sand'],
  terrain: { hillAmp: 9, midAmp: 3, roughAmp: 0.5, duneAmp: 0 },
  props: [
    { type: 'round', density: 0.9, cluster: 0.5, scale: [1.0, 1.8], roadGap: 3 },
    { type: 'shrub', density: 2.4, cluster: 0.3, scale: [0.6, 1.2], roadGap: 1 },
    { type: 'bush', density: 1.2, cluster: 0.4, scale: [0.6, 1.1], roadGap: 1 },
    { type: 'rock', density: 0.6, cluster: 0.3, scale: [0.6, 1.4], roadGap: 2 },
    { type: 'pebble', density: 3, cluster: 0, scale: [0.4, 0.9], roadGap: 0.5 },
  ],
};

/** Giant redwood forest in the mountains (Pacific Northwest / Sierra feel). */
const redwood: BiomeDef = {
  id: 'redwood',
  name: 'Redwoods',
  palette: {
    ground: 0x557a3a,
    groundAlt: 0x4a6e33,
    groundLow: 0x3f602d,
    groundHigh: 0x6a8b45,
    steep: 0x6e5a40,
    surfaces: {
      tarmac: 0x4a4a4e,
      gravel: 0x8f8068,
      dirt: 0x7c5a3c,
      sand: 0xc2a878,
      snow: 0xe8eef2,
      ice: 0xbcd6e6,
      mud: 0x50402e,
      grass: 0x557a3a,
    },
    foliage: 0x22422a,
    foliageAlt: 0x2b4e2e,
    trunk: 0x7a3f26,
    rock: 0x707478,
    bush: 0x3f6e30,
    fog: 0xb4c8c4,
  },
  offroad: 'grass',
  patch: 'dirt',
  patchAmount: 0.12,
  roadSurfaces: ['gravel', 'dirt', 'mud'],
  terrain: { hillAmp: 26, midAmp: 5.5, roughAmp: 0.6, duneAmp: 0 },
  props: [
    { type: 'redwood', density: 1.5, cluster: 0.45, scale: [0.75, 1.25], roadGap: 7 },
    { type: 'pine', density: 4, cluster: 0.5, scale: [0.9, 1.6], roadGap: 2.5 },
    { type: 'bush', density: 3.2, cluster: 0.35, scale: [0.6, 1.3], roadGap: 1 },
    { type: 'rock', density: 0.9, cluster: 0.3, scale: [0.7, 1.6], roadGap: 2 },
    { type: 'pebble', density: 3, cluster: 0, scale: [0.4, 0.9], roadGap: 0.5 },
  ],
  skyline: { rock: 0x4f6470, rockFar: 0x7d93a3, snow: 0xf2f6fa },
};

/** Abandoned city: cracked streets, ruins, rusty wrecks, nature taking over. */
const city: BiomeDef = {
  id: 'city',
  name: 'Ruins',
  palette: {
    ground: 0x6d7a52,
    groundAlt: 0x8a8a7a,
    groundLow: 0x5c6c45,
    groundHigh: 0x7f8a62,
    steep: 0x77736a,
    surfaces: {
      tarmac: 0x3f4145,
      gravel: 0x8c867a,
      dirt: 0x6c5a46,
      sand: 0xbfae8c,
      snow: 0xe8eef2,
      ice: 0xbcd6e6,
      mud: 0x4e4234,
      grass: 0x6d7a52,
    },
    foliage: 0x4a6a32,
    foliageAlt: 0x5c7c38,
    trunk: 0x4d3b2c,
    rock: 0x8e8c86,
    bush: 0x5c7e34,
    fog: 0xcdbfa8,
  },
  offroad: 'grass',
  patch: 'gravel',
  patchAmount: 0.3,
  roadSurfaces: ['tarmac', 'gravel', 'dirt'],
  terrain: { hillAmp: 5, midAmp: 1.2, roughAmp: 0.3, duneAmp: 0 },
  props: [
    { type: 'ruin', density: 0.9, cluster: 0.35, scale: [0.75, 1.35], roadGap: 9 },
    { type: 'tower', density: 0.28, cluster: 0.5, scale: [0.8, 1.4], roadGap: 15 },
    { type: 'wreck', density: 0.45, cluster: 0.2, scale: [0.95, 1.05], roadGap: 1.2 },
    { type: 'round', density: 0.7, cluster: 0.5, scale: [0.8, 1.4], roadGap: 2.5 },
    { type: 'bush', density: 3.2, cluster: 0.4, scale: [0.6, 1.3], roadGap: -0.5 },
    // grass tufts growing through the cracked road
    { type: 'shrub', density: 5, cluster: 0.3, scale: [0.6, 1.3], roadGap: -3.6 },
    { type: 'rock', density: 1.1, cluster: 0.4, scale: [0.5, 1.2], roadGap: 1 },
    { type: 'pebble', density: 4, cluster: 0, scale: [0.4, 1.0], roadGap: -2 },
  ],
  skyline: { rock: 0x6e6a60, rockFar: 0x9c9585, snow: 0xb2ab9b },
};

export const BIOMES: Record<string, BiomeDef> = { forest, desert, snow, savanna, redwood, city };
export const BIOME_LIST: BiomeDef[] = [forest, desert, snow, savanna];

/**
 * Alternate "Monochrome" art style: near-monochrome ground, dark silhouette props.
 * Applied on top of any biome (terrain shape and surfaces stay the same).
 */
export const MONOCHROME_PALETTE: BiomePalette = {
  ground: 0x8e8e90,
  groundAlt: 0x8a8a8c,
  groundLow: 0x7e7e80,
  groundHigh: 0x9a9a9c,
  steep: 0x767678,
  surfaces: {
    tarmac: 0x727274,
    gravel: 0x868688,
    dirt: 0x848486,
    sand: 0x929294,
    snow: 0x9c9c9e,
    ice: 0xa4a4a8,
    mud: 0x7a7a7c,
    grass: 0x8e8e90,
  },
  foliage: 0x353537,
  foliageAlt: 0x3c3c3e,
  trunk: 0x2e2e30,
  rock: 0x3a3a3c,
  bush: 0x404042,
  fog: 0x9a9a9c,
};

/** Endless mode: how long each biome lasts along the road direction and how wide the blend is (m). */
export const BIOME_SPAN = 1600;
export const BIOME_BLEND = 420;
