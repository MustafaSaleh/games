import { describe, expect, it } from 'vitest';
import { ColliderHits, makeGroundSample } from '@engine/world/terrain';
import { MECH } from '../src/units/mech';
import { Warbot, WARBOT } from '../src/units/warbot';
import { unitKind, type UnitInput } from '../src/units/unit';

const flat = {
  heightAt: () => 0,
  sample: (_x: number, _z: number, out = makeGroundSample()) => Object.assign(out, { h: 0, nx: 0, ny: 1, nz: 0, surface: 3, edge: 1e9 }),
  queryColliders: (_x: number, _z: number, _r: number, out: ColliderHits) => ((out.count = 0), out),
} as never;
const inp = (o: Partial<UnitInput> = {}): UnitInput => ({ moveX: 0, moveZ: 0, move: 0, aimYaw: null, fire: false, jump: false, dash: false, ...o });

describe('warbot', () => {
  it('is a known unit kind', () => expect(unitKind('warbot')).toBe('warbot'));

  it('walks slower than the robot suit and does not jump', () => {
    const w = new Warbot();
    w.reset(0, 0, 0, flat);
    for (let i = 0; i < 120; i++) w.step(1 / 60, inp({ moveZ: 1, move: 1, jump: true }), flat);
    expect(w.vz).toBeGreaterThan(WARBOT.maxSpeed * 0.9);
    expect(w.vz).toBeLessThan(MECH.maxSpeed);
    expect(w.airborne).toBe(false);
  });

  it('gatling spins up: fires faster the longer the trigger is held', () => {
    const w = new Warbot();
    w.reset(0, 0, 0, flat);
    const shots = (secs: number) => {
      let n = 0;
      for (let i = 0; i < secs * 60; i++) {
        w.step(1 / 60, inp({ fire: true }), flat);
        if (w.fired) n++;
      }
      return n;
    };
    const first = shots(1);
    const later = shots(1);
    expect(w.spin).toBe(1);
    expect(later).toBeGreaterThan(first * 1.5);
  });

  it('fires a missile from the pod at full spin', () => {
    const w = new Warbot();
    w.reset(0, 0, 0, flat);
    let missiles = 0;
    for (let i = 0; i < 6 * 60; i++) {
      w.step(1 / 60, inp({ fire: true }), flat);
      if (w.missile) missiles++;
    }
    expect(missiles).toBeGreaterThanOrEqual(1);
  });

  it('ground slam: winds up, then lands a big stomp and uses energy', () => {
    const w = new Warbot();
    w.reset(0, 0, 0, flat);
    w.step(1 / 60, inp({ dash: true }), flat);
    expect(w.dashing).toBe(true);
    let slammed = false;
    for (let i = 0; i < 60 && !slammed; i++) {
      w.step(1 / 60, inp(), flat);
      if (w.slammed) {
        slammed = true;
        expect(w.landed).toBeGreaterThan(MECH.stompSpeed);
      }
    }
    expect(slammed).toBe(true);
    expect(w.energy).toBeLessThan(1 - WARBOT.slamCost * 0.8);
    // cooldown: can't slam again right away
    w.step(1 / 60, inp({ dash: true }), flat);
    expect(w.dashing).toBe(false);
  });
});
