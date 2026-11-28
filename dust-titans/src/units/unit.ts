import type { Terrain } from '@engine/world/terrain';

/** Ground interface a unit needs (Terrain implements it; tests use a mock). */
export type Ground = Pick<Terrain, 'sample' | 'heightAt' | 'queryColliders'>;

export type UnitKind = 'tank' | 'mech' | 'scout' | 'warbot';
export const UNIT_KINDS: UnitKind[] = ['tank', 'mech', 'scout', 'warbot'];
export const unitKind = (v: unknown): UnitKind => (UNIT_KINDS.includes(v as UnitKind) ? (v as UnitKind) : 'tank');

/**
 * What a unit is asked to do this step. Movement is "screen-relative": the player points
 * where they want to go (a world direction) and the unit works out how to get there.
 */
export interface UnitInput {
  /** desired move direction (world x/z) and strength 0..1 */
  moveX: number;
  moveZ: number;
  move: number;
  /** weapon aim: world yaw, or null to keep the current aim */
  aimYaw: number | null;
  fire: boolean;
  /** mech: jump-jets (hold to hover a little) */
  jump?: boolean;
  /** mech: dash · tank: turbo ram · scout: nitro · warbot: ground slam */
  dash?: boolean;
  /** special weapon (held; the game uses the press) */
  special?: boolean;
}

export const NO_UNIT_INPUT: UnitInput = { moveX: 0, moveZ: 0, move: 0, aimYaw: null, fire: false, jump: false, dash: false, special: false };

export interface Muzzle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

/** Garage numbers (0..1 bars) and the unit's main weapon. */
export interface UnitSpec {
  kind: UnitKind;
  name: string;
  blurb: string;
  maxHp: number;
  radius: number;
  mass: number;
  /** centre height for being hit */
  hitHeight: number;
  shot: 'shell' | 'bolt' | 'pellet';
  icon: string;
  maxSpeed: number;
  /** base reload (s) */
  reload: number;
  /** height of the aiming plane above the unit */
  aimHeight: number;
  /** hit sphere radius */
  hitR: number;
  /** name tag height */
  tagHeight: number;
  /** shield bubble radius / centre height */
  bubble: [number, number];
  /** chase camera size */
  chase: number;
  /** how much the body tilts with the ground (1 = fully) */
  upright: number;
  /** share of the push it takes when bumping enemies (heavy = small) */
  push: number;
  bars: { armour: number; speed: number; firepower: number; agility: number };
  ability: string;
}

/** Everything the game needs from a player unit (tank or mech). */
export interface Unit {
  readonly kind: UnitKind;
  readonly spec: UnitSpec;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  heading: number;
  yawRate: number;
  /** weapon aim yaw (turret / torso) in world space */
  turret: number;
  hp: number;
  reload: number;
  /** 0..1 jets / dash / turbo energy */
  energy: number;
  /** -1..1 forward speed fraction (engine sound, wheels / legs) */
  drive: number;
  airborne: boolean;
  /** > 0 the step it touched down (fall speed m/s): mech stomps */
  landed: number;
  /** dash / turbo active */
  dashing: boolean;
  px: number;
  py: number;
  pz: number;
  pHeading: number;
  pTurret: number;
  upX: number;
  upY: number;
  upZ: number;
  fired: boolean;
  impact: number;
  readonly speed: number;
  readonly alive: boolean;
  reset(x: number, z: number, heading: number, ground: Ground): void;
  step(dt: number, inp: UnitInput, ground: Ground): void;
  muzzle(out: Muzzle, spread?: number): void;
  /** multiply the reload after a shot (rapid-fire power-up, upgrades) */
  reloadScale: number;
  /** energy regeneration multiplier (upgrade) */
  energyMul: number;
}

/** Colour schemes for both units. */
export interface Livery {
  id: string;
  name: string;
  body: number;
  stripe: number;
  dark: number;
  glow: number;
}

export const LIVERIES: Livery[] = [
  { id: 'sunset', name: 'Sunset', body: 0xe9a53a, stripe: 0xff6a3d, dark: 0x2a2c31, glow: 0xffd27a },
  { id: 'ocean', name: 'Ocean', body: 0x3a8fd9, stripe: 0x5ff2ff, dark: 0x1d2a3a, glow: 0x9ff6ff },
  { id: 'jungle', name: 'Jungle', body: 0x4fa34a, stripe: 0xf4d03f, dark: 0x22301f, glow: 0xd9ff7a },
  { id: 'galaxy', name: 'Galaxy', body: 0x6c4bd1, stripe: 0xff5fc8, dark: 0x1f1a33, glow: 0xffa8ec },
  { id: 'snow', name: 'Snow', body: 0xeef2f5, stripe: 0xe53935, dark: 0x2f3542, glow: 0xffffff },
];

/** Garage upgrades bought with coins: 3 levels each */
export type UpgradeId = 'armour' | 'reload' | 'energy';
export interface Upgrades {
  armour: number;
  reload: number;
  energy: number;
}
export const UPGRADES: Record<UpgradeId, { name: string; icon: string; per: string; costs: number[] }> = {
  armour: { name: 'Armour', icon: '🛡️', per: '-8% damage taken per level', costs: [150, 400, 900] },
  reload: { name: 'Reload', icon: '⚡', per: '7% faster firing per level', costs: [150, 400, 900] },
  energy: { name: 'Energy', icon: '🔋', per: '+15% jets / dash / turbo energy per level', costs: [150, 400, 900] },
};

export const liveryById = (id: string): Livery => LIVERIES.find((l) => l.id === id) ?? LIVERIES[0];
