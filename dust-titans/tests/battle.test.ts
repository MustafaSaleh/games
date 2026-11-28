import { describe, expect, it } from 'vitest';
import { Tank, TANK, type UnitInput } from '../src/units/tank';
import { Projectiles, type Impact, COMBAT } from '../src/combat';
import { Drone, makeDroneParts } from '../src/enemies/drones';
import { ColliderHits, makeGroundSample } from '@engine/world/terrain';

const flat = {
  heightAt: () => 0,
  sample: (_x: number, _z: number, out = makeGroundSample()) => Object.assign(out, { h: 0, nx: 0, ny: 1, nz: 0, surface: 3, edge: 1e9 }),
  queryColliders: (_x: number, _z: number, _r: number, out: ColliderHits) => ((out.count = 0), out),
} as never;

const go = (x: number, z: number, fire = false, aimYaw: number | null = null): UnitInput => ({ moveX: x, moveZ: z, move: Math.min(1, Math.hypot(x, z)), aimYaw, fire });

describe('tank', () => {
  it('drives where you point: turns the hull first, then goes', () => {
    const t = new Tank();
    t.reset(0, 0, 0, flat); // facing +z
    for (let i = 0; i < 60 * 3; i++) t.step(1 / 60, go(1, 0), flat); // point to +x
    expect(Math.abs(t.heading - Math.PI / 2)).toBeLessThan(0.05);
    expect(t.x).toBeGreaterThan(15);
    expect(t.speed).toBeLessThanOrEqual(TANK.maxSpeed + 0.01);
  });
  it('backs up instead of turning around when you point behind it', () => {
    const t = new Tank();
    t.reset(0, 0, 0, flat);
    for (let i = 0; i < 60; i++) t.step(1 / 60, go(0, -1), flat);
    expect(t.z).toBeLessThan(-1);
    expect(Math.abs(t.heading)).toBeLessThan(0.05); // still facing forward
  });
  it('the turret turns on its own and the cannon reloads', () => {
    const t = new Tank();
    t.reset(0, 0, 0, flat);
    let shots = 0;
    for (let i = 0; i < 60 * 2; i++) {
      t.step(1 / 60, go(0, 0, true, Math.PI), flat);
      if (t.fired) shots++;
    }
    expect(Math.abs(Math.abs(t.turret) - Math.PI)).toBeLessThan(0.05);
    expect(Math.abs(t.heading)).toBeLessThan(0.01);
    expect(shots).toBe(Math.ceil(2 / TANK.reload));
  });
});

describe('combat', () => {
  it('a shell flies and hits a drone in front of the tank', () => {
    const p = new Projectiles();
    const d = new Drone('d1', makeDroneParts(), 1);
    d.x = 0;
    d.y = 2;
    d.z = 30;
    p.fire('player', 'shell', 0, 2, 0, 0, 1.2, 70);
    const out: Impact[] = [];
    let hit: Impact | undefined;
    for (let i = 0; i < 120 && !hit; i++) {
      p.step(1 / 60, flat, [d], out);
      hit = out[0];
    }
    expect(hit?.target).toBe(d);
  });
  it('shots never hit their own team, and orbs fall to the ground eventually', () => {
    const p = new Projectiles();
    const d = new Drone('d1', makeDroneParts(), 1);
    d.y = 2;
    d.z = 10;
    p.fire('enemy', 'orb', 0, 2, 0, 0, -1, COMBAT.orbSpeed);
    const out: Impact[] = [];
    let ground = false;
    for (let i = 0; i < 300; i++) {
      p.step(1 / 60, flat, [d], out);
      if (out.length) {
        expect(out[0].target).toBeNull();
        ground = true;
        break;
      }
    }
    expect(ground).toBe(true);
  });
});

describe('drones', () => {
  it('circle the player at a distance and fire at them', () => {
    const d = new Drone('d1', makeDroneParts(), 2);
    d.x = 60;
    d.y = 5;
    const player = { x: 0, y: 0, z: 0, vx: 0, vz: 0, alive: true };
    let shots = 0;
    for (let i = 0; i < 60 * 12; i++) d.step(1 / 60, flat, player, [d], () => shots++);
    const dist = Math.hypot(d.x, d.z);
    expect(dist).toBeGreaterThan(d.dist - 6);
    expect(dist).toBeLessThan(d.dist + 8);
    expect(d.y).toBeGreaterThan(3);
    expect(shots).toBeGreaterThanOrEqual(3);
  });
});
