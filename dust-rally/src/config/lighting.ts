/**
 * Lighting presets. No shadows: a hemisphere light + one directional "sun" gives
 * the baked-looking shading; the car headlight is a fake additive cone.
 */
export type TimeOfDay = 'day' | 'dusk' | 'night';

export interface LightingPreset {
  id: TimeOfDay;
  sunColor: number;
  sunIntensity: number;
  sunDir: [number, number, number];
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  /** fog colour = biome fog colour * fogTint */
  fogTint: number;
  /** fog start/end in metres *beyond the camera's focus point* */
  fogNear: number;
  fogFar: number;
  /** 0..1 headlight cone strength */
  headlights: number;
  /** 0..1 CSS vignette strength */
  vignette: number;
}

export const LIGHTING: Record<TimeOfDay, LightingPreset> = {
  day: {
    id: 'day',
    sunColor: 0xfff4e0,
    sunIntensity: 2.3,
    sunDir: [-0.55, 0.6, -0.45],
    hemiSky: 0xdfeaff,
    hemiGround: 0x7a6a58,
    hemiIntensity: 1.0,
    fogTint: 0xffffff,
    fogNear: 20,
    fogFar: 190,
    headlights: 0,
    vignette: 0.35,
  },
  dusk: {
    id: 'dusk',
    sunColor: 0xffc48a,
    sunIntensity: 1.8,
    sunDir: [-0.75, 0.5, -0.25],
    hemiSky: 0xc8bfe0,
    hemiGround: 0x6a5048,
    hemiIntensity: 1.05,
    fogTint: 0xe6c4b4,
    fogNear: 10,
    fogFar: 160,
    headlights: 0.4,
    vignette: 0.5,
  },
  night: {
    id: 'night',
    sunColor: 0x8aa4ff,
    sunIntensity: 0.28,
    sunDir: [0.3, 0.8, 0.4],
    hemiSky: 0x4a5a8c,
    hemiGround: 0x1a1a24,
    hemiIntensity: 0.55,
    fogTint: 0x2a3048,
    fogNear: 0,
    fogFar: 130,
    headlights: 1.0,
    vignette: 0.7,
  },
};

/** Endless "auto" time of day cycles through these, one step every N metres. */
export const ENDLESS_TIME_CYCLE: TimeOfDay[] = ['day', 'dusk', 'night', 'dusk'];
export const ENDLESS_TIME_STEP = 2600;
