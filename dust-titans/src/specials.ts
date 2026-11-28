/**
 * Special weapons: one per unit, chosen in the Garage, fired with Q / E, gamepad Y or the
 * SPECIAL touch button, then they recharge.
 */
export type SpecialId = 'rockets' | 'laser' | 'emp' | 'shield' | 'tomato';

export const SPECIAL_IDS: SpecialId[] = ['rockets', 'laser', 'emp', 'shield', 'tomato'];

export const SPECIALS: Record<SpecialId, { name: string; icon: string; blurb: string; cooldown: number }> = {
  rockets: { name: 'Rocket swarm', icon: '🚀', blurb: '6 rockets that chase the nearest enemy', cooldown: 8 },
  laser: { name: 'Laser beam', icon: '🔆', blurb: 'A long beam for a second: sweep it across them', cooldown: 9 },
  emp: { name: 'EMP pulse', icon: '⚡', blurb: 'Freezes every robot around you for 3 s', cooldown: 12 },
  shield: { name: 'Shield bubble', icon: '🫧', blurb: 'Nothing gets through for 5 s', cooldown: 14 },
  tomato: { name: 'Tomato cannon', icon: '🍅', blurb: 'SPLAT! Big squishy tomato: enemies get stuck in the juice', cooldown: 3.5 },
};

export const specialId = (v: unknown): SpecialId => (SPECIAL_IDS.includes(v as SpecialId) ? (v as SpecialId) : 'rockets');

export const BEAM = { length: 70, dps: 70, pvpDps: 40, time: 1.3, width: 0.45 };
export const EMP = { radius: 24, stun: 3, damage: 10, pvpDamage: 8 };
export const TOMATO_STUN = 1.6;
export const SHIELD_TIME = 5;

/**
 * distance along a ray (origin o, unit dir d) to the first sphere it passes within r of,
 * or -1. Used by the laser beam.
 */
export function rayHit(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, len: number, cx: number, cy: number, cz: number, r: number): number {
  const lx = cx - ox,
    ly = cy - oy,
    lz = cz - oz;
  const t = lx * dx + ly * dy + lz * dz;
  if (t < 0 || t > len + r) return -1;
  const px = lx - dx * t,
    py = ly - dy * t,
    pz = lz - dz * t;
  return px * px + py * py + pz * pz <= r * r ? t : -1;
}
