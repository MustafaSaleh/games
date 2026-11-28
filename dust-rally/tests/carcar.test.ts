import { describe, expect, it } from 'vitest';
import { makeContact, resolveCarCar, type CarBody } from '../src/physics/collisions';

const car = (x: number, z: number, heading: number, vx = 0, vz = 0): CarBody => ({ x, y: 0, z, vx, vz, heading, yawRate: 0 });

describe('car vs car collisions', () => {
  it('head-on: both cars bounce back, momentum is conserved', () => {
    const a = car(0, -1.9, 0, 0, 10); // driving +z
    const b = car(0, 1.9, Math.PI, 0, -10); // driving -z
    const c = makeContact();
    expect(resolveCarCar(a, b, true, c)).toBe(true);
    expect(a.vz).toBeLessThan(0);
    expect(b.vz).toBeGreaterThan(0);
    expect(a.vz + b.vz).toBeCloseTo(0, 5);
    expect(c.impact).toBeGreaterThan(15);
  });

  it('rear-end: the car in front gets pushed, the hitter slows down', () => {
    const a = car(0, 0, 0, 0, 5); // in front, slow
    const b = car(0, -3.9, 0, 0, 20); // behind, fast
    resolveCarCar(a, b, true, makeContact());
    expect(a.vz).toBeGreaterThan(5);
    expect(b.vz).toBeLessThan(20);
  });

  it('a side hit near the nose spins the car', () => {
    const a = car(0, 0, 0); // pointing +z, standing
    const b = car(2.3, 1.2, -Math.PI / 2, -12, 0); // coming from the right, hitting the front
    resolveCarCar(a, b, true, makeContact());
    expect(a.vx).toBeLessThan(0);
    expect(Math.abs(a.yawRate)).toBeGreaterThan(0.1);
  });

  it('online (kinematic other car): only our car is moved', () => {
    const a = car(0, -1.9, 0, 0, 10);
    const b = car(0, 1.9, Math.PI, 0, -10);
    resolveCarCar(a, b, false, makeContact());
    expect(a.vz).toBeLessThan(0);
    expect(b.vz).toBe(-10);
    expect(b.z).toBe(1.9);
  });

  it('a heavy truck shoves a light buggy (momentum is still conserved)', () => {
    const truck = { ...car(0, -1.9, 0, 0, 10), mass: 1750 };
    const buggy = { ...car(0, 1.9, Math.PI, 0, -10), mass: 700 };
    resolveCarCar(truck, buggy, true, makeContact());
    expect(Math.abs(buggy.vz - -10)).toBeGreaterThan(Math.abs(truck.vz - 10) * 2); // the buggy's speed changes much more
    expect(truck.vz).toBeGreaterThan(0); // the truck keeps going forward
    expect(truck.vz * 1750 + buggy.vz * 700).toBeCloseTo(10 * 1750 - 10 * 700, 3);
  });

  it('far apart or one car flying over: no contact', () => {
    expect(resolveCarCar(car(0, 0, 0), car(10, 0, 0), true, makeContact())).toBe(false);
    const a = car(0, 0, 0);
    a.y = 3;
    expect(resolveCarCar(a, car(0, 1, 0), true, makeContact())).toBe(false);
  });
});
