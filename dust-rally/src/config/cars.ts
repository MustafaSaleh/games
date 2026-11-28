/**
 * Garage: car body styles and colour liveries (cosmetic only – handling is the same).
 * Add a livery by appending to CAR_LIVERIES; add a body style in render/models.ts (buildCar).
 */
export type CarStyle = 'hatch' | 'coupe' | 'truck' | 'roadster' | 'buggy';

/**
 * Performance. Multipliers on the shared handling (config/handling.ts), plus the weight:
 *  power     engine acceleration
 *  topSpeed  maximum speed
 *  mass      kg: who shoves whom in car crashes, how rocks fly
 *  grip      sideways grip on tarmac
 *  offroad   grip + traction on loose surfaces (gravel, dirt, sand, snow, mud, grass)
 *  steer     steering sharpness
 * Every car trades something away: none is best at everything.
 */
export interface CarSpec {
  power: number;
  topSpeed: number;
  mass: number;
  grip: number;
  offroad: number;
  steer: number;
}

export interface CarStyleDef {
  id: CarStyle;
  name: string;
  description: string;
  spec: CarSpec;
}

export const CAR_STYLES: CarStyleDef[] = [
  {
    id: 'hatch',
    name: 'Hatch',
    description: 'The all-rounder: classic rally hatchback, good everywhere.',
    spec: { power: 1, topSpeed: 1, mass: 1100, grip: 1, offroad: 1, steer: 1 },
  },
  {
    id: 'coupe',
    name: 'Coupe',
    description: 'Fast and planted on tarmac with its big wing; slippery on dirt.',
    spec: { power: 1.07, topSpeed: 1.08, mass: 1200, grip: 1.1, offroad: 0.88, steer: 0.95 },
  },
  {
    id: 'truck',
    name: 'Raid',
    description: 'Heavy rally-raid truck: slower, but unstoppable off-road and shoves everyone aside.',
    spec: { power: 0.93, topSpeed: 0.9, mass: 1750, grip: 0.92, offroad: 1.16, steer: 0.88 },
  },
  {
    id: 'roadster',
    name: 'Roadster',
    description: 'Open-top two-seater: light, quick and sharp on tarmac. Hold on to your helmet!',
    spec: { power: 1.05, topSpeed: 1.05, mass: 900, grip: 1.08, offroad: 0.86, steer: 1.12 },
  },
  {
    id: 'buggy',
    name: 'Buggy',
    description: 'Two-seat dune buggy with a roll cage: flies off the line and loves sand and dirt; easy to bump around.',
    spec: { power: 1.12, topSpeed: 0.9, mass: 700, grip: 0.95, offroad: 1.22, steer: 1.1 },
  },
];

/** the reference car (hatch) */
export const BASE_SPEC: CarSpec = CAR_STYLES[0].spec;

export interface Livery {
  id: string;
  name: string;
  body: number; // main paint
  stripe: number; // stripes, spoiler, bumpers
  roof: number; // roof panel
}

export const CAR_LIVERIES: Livery[] = [
  { id: 'white', name: 'Alpine White', body: 0xf1eee6, stripe: 0x1d1d22, roof: 0xf1eee6 },
  { id: 'red', name: 'Rosso', body: 0xd8322a, stripe: 0xf4f1ea, roof: 0xd8322a },
  { id: 'blue', name: 'Works Blue', body: 0x1f5fbf, stripe: 0xffc21a, roof: 0x1f5fbf },
  { id: 'yellow', name: 'Sun Yellow', body: 0xf5c518, stripe: 0x1d1d22, roof: 0x1d1d22 },
  { id: 'green', name: 'Racing Green', body: 0x1f6b45, stripe: 0xf1eee6, roof: 0x1f6b45 },
  { id: 'orange', name: 'Papaya', body: 0xff7a1a, stripe: 0x1f3f7a, roof: 0xff7a1a },
  { id: 'black', name: 'Midnight', body: 0x24262c, stripe: 0xff3b5c, roof: 0x24262c },
  { id: 'teal', name: 'Gulf', body: 0x7cc6e0, stripe: 0xff7a1a, roof: 0x7cc6e0 },
  { id: 'purple', name: 'Violet', body: 0x6a3fb5, stripe: 0x7cf0c8, roof: 0x6a3fb5 },
  { id: 'silver', name: 'Silver', body: 0xa9adb5, stripe: 0xd8322a, roof: 0xd8322a },
];

export function getStyle(id: string): CarStyleDef {
  return CAR_STYLES.find((s) => s.id === id) ?? CAR_STYLES[0];
}

export function getLivery(id: string): Livery {
  return CAR_LIVERIES.find((l) => l.id === id) ?? CAR_LIVERIES[0];
}

export const GHOST_LIVERY: Livery = { id: 'ghost', name: 'Ghost', body: 0x8ac8ff, stripe: 0x8ac8ff, roof: 0x8ac8ff };
