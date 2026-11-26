/**
 * Garage: car body styles and colour liveries (cosmetic only – handling is the same).
 * Add a livery by appending to CAR_LIVERIES; add a body style in render/models.ts (buildCar).
 */
export type CarStyle = 'hatch' | 'coupe' | 'truck';

export interface CarStyleDef {
  id: CarStyle;
  name: string;
  description: string;
}

export const CAR_STYLES: CarStyleDef[] = [
  { id: 'hatch', name: 'Hatch', description: 'Classic rally hatchback with roof spoiler and light pod.' },
  { id: 'coupe', name: 'Coupe', description: 'Low, long-nosed coupe with a big rear wing.' },
  { id: 'truck', name: 'Raid', description: 'Tall rally-raid truck with roof rack and big tyres.' },
];

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
