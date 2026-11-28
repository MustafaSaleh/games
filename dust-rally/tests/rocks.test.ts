import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { LooseRocks, type Pusher } from '../src/world/rocks';
import { ColliderHits } from '../src/world/terrain';

// flat ground, no other props
const flat = {
  heightAt: () => 0,
  queryColliders: (_x: number, _z: number, _r: number, out: ColliderHits) => ((out.count = 0), out),
  version: 0,
} as never;

function rockAt(rocks: LooseRocks, x: number, z: number, s = 1): void {
  (rocks as unknown as { bodies: unknown[] }).bodies.push({
    x, y: -0.15 * s, z, vx: 0, vy: 0, vz: 0, s, r: 0.95 * s, mass: 30 + 160 * s * s * s,
    q: new THREE.Quaternion(), spinAxis: new THREE.Vector3(1, 0, 0), spin: 0, ground: true, still: 0, color: new THREE.Color(1, 1, 1),
  });
}
const body = (rocks: LooseRocks) => (rocks as unknown as { bodies: { x: number; y: number; z: number; vx: number; vz: number; still: number }[] }).bodies[0];

describe('loose rocks', () => {
  it('a car knocks a rock away and only loses a little speed', () => {
    const rocks = new LooseRocks(new THREE.MeshBasicMaterial());
    rockAt(rocks, 0, 2.6);
    const car = { vx: 0, vz: 15 };
    const p: Pusher = { x: 0, y: 0, z: 0, vx: 0, vz: 15, heading: 0, mass: 1100, push: (dx, dz) => ((car.vx += dx), (car.vz += dz)) };
    rocks.step(1 / 60, flat, [p]);
    const b = body(rocks);
    expect(Math.hypot(b.vx, b.vz)).toBeGreaterThan(15); // rock flies faster than the car
    expect(car.vz).toBeGreaterThan(10); // car keeps most of its speed
    expect(car.vz).toBeLessThan(15);
    expect(Math.abs(b.vx)).toBeGreaterThan(1); // knocked to the side, out of the way
    expect(p.hit).toBeCloseTo(15, 0);
  });

  it('it bounces, rolls, then settles on the ground', () => {
    const rocks = new LooseRocks(new THREE.MeshBasicMaterial());
    rockAt(rocks, 0, 2.6, 0.8);
    const p: Pusher = { x: 0, y: 0, z: 0, vx: 0, vz: 12, heading: 0, mass: 1100, push: () => {} };
    rocks.step(1 / 60, flat, [p]);
    p.z = -50; // car gone
    let maxY = 0;
    for (let i = 0; i < 60 * 12; i++) {
      rocks.step(1 / 60, flat, [p]);
      maxY = Math.max(maxY, body(rocks).y);
    }
    const b = body(rocks);
    expect(maxY).toBeGreaterThan(0.2); // it was in the air
    expect(Math.hypot(b.x, b.z - 2.6)).toBeGreaterThan(5); // travelled
    expect(Math.hypot(b.vx, b.vz)).toBeLessThan(0.3); // and stopped
    expect(b.y).toBeCloseTo(-0.15 * 0.8, 2);
  });

  it("another player's car (kinematic) pushes rocks without being pushed back", () => {
    const rocks = new LooseRocks(new THREE.MeshBasicMaterial());
    rockAt(rocks, 0, 2.6);
    let pushed = false;
    const p: Pusher = { x: 0, y: 0, z: 0, vx: 0, vz: 15, heading: 0, mass: 0, push: () => (pushed = true) };
    rocks.step(1 / 60, flat, [p]);
    expect(Math.hypot(body(rocks).vx, body(rocks).vz)).toBeGreaterThan(15);
    expect(pushed).toBe(false);
  });
});
