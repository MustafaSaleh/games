/**
 * Surface types. Every grip / drag number the car reads from the ground lives here.
 *
 * grip      lateral grip multiplier (1 = tarmac). Lower = more slide.
 * traction  longitudinal multiplier for engine + brakes.
 * rollDrag  fraction of speed lost per second (rolling resistance). Sand/mud are "sticky".
 * dust      particle emission multiplier when sliding / fast.
 * mark      tire-mark opacity (0 = none).
 * skid      skid-sound loudness multiplier.
 *
 * The colour of a surface (road, particles, marks) comes from the biome palette.
 */
export type SurfaceId = 'tarmac' | 'gravel' | 'dirt' | 'sand' | 'snow' | 'ice' | 'mud' | 'grass';

export interface SurfaceDef {
  id: SurfaceId;
  name: string;
  grip: number;
  traction: number;
  rollDrag: number;
  dust: number;
  mark: number;
  skid: number;
}

export const SURFACES: SurfaceDef[] = [
  { id: 'tarmac', name: 'Tarmac', grip: 1.0, traction: 1.0, rollDrag: 0.015, dust: 0.15, mark: 0.55, skid: 1.0 },
  { id: 'gravel', name: 'Gravel', grip: 0.74, traction: 0.86, rollDrag: 0.045, dust: 1.0, mark: 0.35, skid: 0.6 },
  { id: 'dirt', name: 'Dirt', grip: 0.8, traction: 0.88, rollDrag: 0.04, dust: 0.9, mark: 0.4, skid: 0.5 },
  { id: 'sand', name: 'Sand', grip: 0.56, traction: 0.68, rollDrag: 0.26, dust: 1.4, mark: 0.45, skid: 0.35 },
  { id: 'snow', name: 'Snow', grip: 0.52, traction: 0.64, rollDrag: 0.12, dust: 1.2, mark: 0.45, skid: 0.3 },
  { id: 'ice', name: 'Ice', grip: 0.24, traction: 0.38, rollDrag: 0.01, dust: 0.25, mark: 0.15, skid: 0.25 },
  { id: 'mud', name: 'Mud', grip: 0.58, traction: 0.6, rollDrag: 0.32, dust: 0.8, mark: 0.6, skid: 0.3 },
  { id: 'grass', name: 'Grass', grip: 0.66, traction: 0.76, rollDrag: 0.11, dust: 0.5, mark: 0.3, skid: 0.25 },
];

export const SURFACE_INDEX: Record<SurfaceId, number> = Object.fromEntries(
  SURFACES.map((s, i) => [s.id, i]),
) as Record<SurfaceId, number>;

export function surfaceByIndex(i: number): SurfaceDef {
  return SURFACES[i] ?? SURFACES[0];
}
