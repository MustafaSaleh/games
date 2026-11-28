import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { MISSIONS, MissionRun, type MissionHost } from '../src/missions';
import type { Enemy, EnemyKind } from '../src/enemies/enemy';
import { ARENAS } from '../src/arena';

function host(alive = true, spawnAlive = true) {
  const enemies: Enemy[] = [];
  const spawned: EnemyKind[] = [];
  const crates: string[] = [];
  const h: MissionHost = {
    scene: new THREE.Scene(),
    radius: 150,
    heightAt: () => 0,
    spawn: (kind) => {
      spawned.push(kind);
      const e = { kind, x: 0, y: 0, z: 0, alive: spawnAlive } as unknown as Enemy;
      enemies.push(e);
      return e;
    },
    enemies,
    banner: () => {},
    dropCrate: (_x, _y, _z, k) => crates.push(k),
    player: () => ({ x: 0, z: 0, alive }),
    addEnemy: () => {},
    beacon: () => ({ alive: true, hp: 700 }) as unknown as Enemy,
    cratesOnField: () => crates.length,
  };
  return { h, enemies, spawned, crates };
}

describe('missions', () => {
  it('every mission uses a real battlefield', () => {
    for (const m of MISSIONS) expect(ARENAS.some((a) => a.id === m.arena)).toBe(true);
  });
  it('the water truck drives to the far side and wins (when you clear the way)', () => {
    const { h } = host(true, false);
    const m = new MissionRun(MISSIONS.find((x) => x.id === 'escort')!, h);
    for (let i = 0; i < 60 * 80 && !m.outcome; i++) m.step(1 / 60);
    expect(m.outcome).toBe('win');
    expect(m.guarded[0].z).toBeGreaterThanOrEqual(115);
  });
  it('the truck waits while a robot blocks it, and losing it fails the mission', () => {
    const { h, enemies } = host();
    const m = new MissionRun(MISSIONS.find((x) => x.id === 'escort')!, h);
    const t = m.guarded[0];
    enemies.push({ kind: 'walker', x: t.x, z: t.z + 3, alive: true } as unknown as Enemy);
    const z0 = t.z;
    for (let i = 0; i < 120; i++) m.step(1 / 60);
    expect(t.z).toBe(z0);
    t.hurt(9999);
    m.step(1 / 60);
    expect(m.outcome).toBe('lose');
  });
  it('the market sends 3 waves of mostly aliens', () => {
    const { h, enemies, spawned } = host();
    const m = new MissionRun(MISSIONS.find((x) => x.id === 'market')!, h);
    for (let w = 0; w < 3; w++) {
      for (let i = 0; i < 60 * 20; i++) m.step(1 / 60);
      for (const e of enemies) (e as unknown as { alive: boolean }).alive = false; // wave cleared
    }
    for (let i = 0; i < 60 * 6 && !m.outcome; i++) m.step(1 / 60);
    expect(m.outcome).toBe('win');
    expect(spawned.filter((k) => k === 'alien').length).toBeGreaterThan(spawned.length / 2);
  });
  it('supply run: crates come two at a time, time runs out', () => {
    const { h, crates } = host();
    const m = new MissionRun(MISSIONS.find((x) => x.id === 'supply')!, h);
    for (let i = 0; i < 60 * 5; i++) m.step(1 / 60);
    expect(crates.length).toBe(2);
    for (let i = 0; i < 60 * 120 && !m.outcome; i++) m.step(1 / 60);
    expect(m.outcome).toBe('lose');
  });
  it('stars: finish, half armour, quick', () => {
    const { h } = host();
    const m = new MissionRun(MISSIONS[0], h);
    m.time = 10;
    expect(m.stars(1)).toBe(3);
    expect(m.stars(0.3)).toBe(1);
    m.time = 999;
    expect(m.stars(0.8)).toBe(2);
  });
});
