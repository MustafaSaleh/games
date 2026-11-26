import { describe, expect, it } from 'vitest';
import { TomatoSystem, aimThrow, type TomatoHit, type TomatoTarget } from '../src/core/tomatoes';

const flat = () => 0;

function fly(sys: TomatoSystem, targets: TomatoTarget[], move: (dt: number) => void): TomatoHit | null {
  const hits: TomatoHit[] = [];
  for (let i = 0; i < 240; i++) {
    move(1 / 60);
    sys.update(1 / 60, flat, targets, () => {}, hits);
    if (hits.length) return hits[0];
    if (!sys.count) return null;
  }
  return null;
}

describe('tomato fight', () => {
  it('a tomato thrown back hits the car chasing behind (leading a moving target)', () => {
    // leader at z=0 driving +z at 20 m/s; chaser 25 m behind, also at 20 m/s
    const leader = { x: 0, y: 0, z: 0, vx: 0, vz: 20, heading: 0 };
    const chaser: TomatoTarget = { id: 'b', x: 1.5, y: 0, z: -25, vx: 0, vz: 20 };
    const sys = new TomatoSystem();
    sys.spawn('a', aimThrow(leader, [chaser]));
    const hit = fly(sys, [chaser], (dt) => (chaser.z += chaser.vz * dt));
    expect(hit?.target).toBe('b');
    expect(hit?.owner).toBe('a');
  });

  it('never hits the thrower, and with nobody behind it lands on the road behind', () => {
    const leader = { x: 0, y: 0, z: 0, vx: 0, vz: 10, heading: 0 };
    const me: TomatoTarget = { id: 'a', x: 0, y: 0, z: 0, vx: 0, vz: 10 };
    const ahead: TomatoTarget = { id: 'c', x: 0, y: 0, z: 30, vx: 0, vz: 10 };
    const p = aimThrow(leader, [ahead]); // the car ahead is not a target
    expect(p[5]).toBeLessThan(0); // thrown backwards
    const sys = new TomatoSystem();
    let landed = false;
    sys.spawn('a', p);
    const hits: TomatoHit[] = [];
    for (let i = 0; i < 240 && sys.count; i++) sys.update(1 / 60, flat, [me, ahead], () => (landed = true), hits);
    expect(hits.length).toBe(0);
    expect(landed).toBe(true);
  });

  it('ignores malformed throws from the network', () => {
    const sys = new TomatoSystem();
    sys.spawn('x', [1, 2] as number[]);
    sys.spawn('x', [0, 0, 0, NaN, 0, 0]);
    expect(sys.count).toBe(0);
  });
});
