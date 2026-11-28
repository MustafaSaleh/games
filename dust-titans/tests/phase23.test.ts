import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ColliderHits, makeGroundSample } from '@engine/world/terrain';
import { Mech, MECH } from '../src/units/mech';
import type { UnitInput } from '../src/units/unit';
import { waveSpawns } from '../src/waves';
import { Boss } from '../src/enemies/boss';
import { Walker } from '../src/enemies/walker';
import { Alien } from '../src/enemies/alien';
import type { EnemyCtx, PlayerRef } from '../src/enemies/enemy';
import type { Target } from '../src/combat';

const flat = {
  heightAt: () => 0,
  sample: (_x: number, _z: number, out = makeGroundSample()) => Object.assign(out, { h: 0, nx: 0, ny: 1, nz: 0, surface: 3, edge: 1e9 }),
  queryColliders: (_x: number, _z: number, _r: number, out: ColliderHits) => ((out.count = 0), out),
} as never;

const inp = (o: Partial<UnitInput> = {}): UnitInput => ({ moveX: 0, moveZ: 0, move: 0, aimYaw: null, fire: false, jump: false, dash: false, ...o });

function ctxWith(player: Partial<PlayerRef>, log: { shots: string[]; hurts: number[] }): EnemyCtx {
  return {
    ground: flat,
    players: [{ x: 0, y: 0, z: 0, vx: 0, vz: 0, r: 2, alive: true, airborne: false, ...player }],
    enemies: [],
    fire: (kind) => log.shots.push(kind),
    hurt: (_i, dmg) => log.hurts.push(dmg),
    fx: () => {},
  };
}

describe('mech', () => {
  it('strafes straight away in any direction (no turning first)', () => {
    const m = new Mech();
    m.reset(0, 0, 0, flat);
    for (let i = 0; i < 30; i++) m.step(1 / 60, inp({ moveX: 1, move: 1 }), flat);
    expect(m.vx).toBeGreaterThan(MECH.maxSpeed * 0.9);
    expect(Math.abs(m.vz)).toBeLessThan(0.5);
  });
  it('jumps, holding jump hovers longer, and lands', () => {
    const air = (hold: boolean) => {
      const m = new Mech();
      m.reset(0, 0, 0, flat);
      let t = 0;
      m.step(1 / 60, inp({ jump: true }), flat);
      while (m.airborne && t < 10) {
        m.step(1 / 60, inp({ jump: hold }), flat);
        t += 1 / 60;
      }
      return { t, m };
    };
    const tap = air(false),
      hold = air(true);
    expect(tap.t).toBeGreaterThan(0.7);
    expect(hold.t).toBeGreaterThan(tap.t + 0.4);
    expect(tap.m.airborne).toBe(false);
    expect(hold.m.energy).toBeLessThan(1);
  });
  it('dashes fast for a moment and uses energy', () => {
    const m = new Mech();
    m.reset(0, 0, 0, flat);
    m.step(1 / 60, inp({ dash: true, moveZ: 1, move: 1 }), flat);
    expect(m.speed).toBeGreaterThan(25);
    expect(m.energy).toBeLessThan(0.7);
    for (let i = 0; i < 60; i++) m.step(1 / 60, inp(), flat);
    expect(m.dashing).toBe(false);
    expect(m.speed).toBeLessThan(MECH.maxSpeed);
  });
});

describe('waves', () => {
  it('starts gentle, adds walkers and aliens, a boss every 5th wave', () => {
    expect(waveSpawns(1)).toEqual(['drone', 'drone', 'drone']);
    expect(waveSpawns(3)).toContain('walker');
    expect(waveSpawns(4)).toContain('alien');
    for (const n of [5, 10, 15]) expect(waveSpawns(n)[0]).toBe('boss');
    for (let n = 1; n < 30; n++) {
      expect(waveSpawns(n).length).toBeLessThanOrEqual(12);
      if (n % 5) expect(waveSpawns(n)).not.toContain('boss');
    }
  });
});

describe('enemies', () => {
  it('walkers telegraph and fire laser bursts at a player in range', () => {
    const log = { shots: [] as string[], hurts: [] as number[] };
    const w = new Walker('w', 1);
    w.z = 20;
    const ctx = ctxWith({}, log);
    for (let i = 0; i < 60 * 8; i++) w.update(1 / 60, ctx);
    expect(log.shots.filter((s) => s === 'laser').length).toBeGreaterThanOrEqual(3);
  });
  it('aliens hop to the player and zap on contact', () => {
    const log = { shots: [] as string[], hurts: [] as number[] };
    const a = new Alien('a', 2);
    a.z = 30;
    const ctx = ctxWith({}, log);
    for (let i = 0; i < 60 * 6; i++) a.update(1 / 60, ctx);
    expect(log.hurts.length).toBeGreaterThan(0);
  });
  it('the Giant Robot core is shielded until both knees are down, then it falls', () => {
    const log = { shots: [] as string[], hurts: [] as number[] };
    const b = new Boss('b', 1);
    b.z = 40;
    const ctx = ctxWith({}, log);
    new THREE.Scene().add(b.mesh);
    b.update(1 / 60, ctx);
    const tg = () => {
      const t: Target[] = [];
      b.targets(t);
      return t;
    };
    const core = () => tg().find((t) => t.id.endsWith('core'))!;
    expect(b.damage(core(), 999, ctx)).toBe('armor');
    expect(b.damage(tg().find((t) => t.id.endsWith('torso'))!, 999, ctx)).toBe('armor');
    expect(b.damage(tg().find((t) => t.id.endsWith('knee0'))!, 999, ctx)).toBe('part');
    expect(b.shielded).toBe(true);
    expect(b.damage(tg().find((t) => t.id.endsWith('knee1'))!, 999, ctx)).toBe('part');
    expect(b.shielded).toBe(false);
    expect(b.damage(core(), 999, ctx)).toBe('killed');
    for (let i = 0; i < 60 * 3; i++) b.update(1 / 60, ctx);
    expect(b.alive).toBe(false);
  });
  it('the Giant Robot stomps a shockwave that a jumping player avoids', () => {
    const run = (airborne: boolean) => {
      const log = { shots: [] as string[], hurts: [] as number[] };
      const b = new Boss('b', 1);
      b.z = 15;
      const ctx = ctxWith({ airborne }, log);
      for (let i = 0; i < 60 * 8; i++) b.update(1 / 60, ctx);
      return log;
    };
    expect(run(false).hurts).toContain(14);
    expect(run(true).hurts).not.toContain(14);
    expect(run(false).shots).toContain('plasma');
  });
});
