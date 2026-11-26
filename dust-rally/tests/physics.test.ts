import { describe, expect, it } from 'vitest';
import { Car, type CarInput, type Ground } from '../src/physics/car';
import { SURFACE_INDEX } from '../src/config/surfaces';
import type { ColliderHits, GroundSample } from '../src/world/terrain';

/** Analytic ground for tests: height function + optional colliders. */
function makeGround(hf: (x: number, z: number) => number, surface = 'tarmac', cols: [number, number, number][] = []): Ground {
  const s = SURFACE_INDEX[surface as keyof typeof SURFACE_INDEX];
  return {
    heightAt: (x, z) => hf(x, z),
    sample(x: number, z: number, out: GroundSample) {
      const d = 0.5;
      out.h = hf(x, z);
      let nx = (hf(x - d, z) - hf(x + d, z)) / (2 * d),
        ny = 1,
        nz = (hf(x, z - d) - hf(x, z + d)) / (2 * d);
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv;
      ny *= inv;
      nz *= inv;
      out.nx = nx;
      out.ny = ny;
      out.nz = nz;
      out.surface = s;
      out.edge = -1;
      return out;
    },
    queryColliders(_x: number, _z: number, _r: number, out: ColliderHits) {
      out.count = 0;
      for (const [x, z, r] of cols) {
        out.x[out.count] = x;
        out.z[out.count] = z;
        out.r[out.count] = r;
        out.top[out.count] = 10;
        out.count++;
      }
      return out;
    },
  } as Ground;
}

const DT = 1 / 60;
const inp = (p: Partial<CarInput>): CarInput => ({ steer: 0, throttle: 0, brake: 0, handbrake: false, ...p });

function run(car: Car, g: Ground, seconds: number, i: CarInput | ((t: number) => CarInput), each?: (t: number) => void) {
  for (let t = 0; t < seconds; t += DT) {
    car.step(DT, typeof i === 'function' ? i(t) : i, g);
    each?.(t);
  }
}

describe('car physics', () => {
  const flat = makeGround(() => 0);

  it('accelerates to a sensible top speed', () => {
    const car = new Car();
    car.reset(0, 0, 0, flat);
    let t100 = -1;
    run(car, flat, 25, inp({ throttle: 1 }), (t) => {
      if (t100 < 0 && car.speed > 27.8) t100 = t;
    });
    console.log(`0-100 km/h: ${t100.toFixed(2)} s, top: ${(car.speed * 3.6).toFixed(0)} km/h`);
    expect(t100).toBeGreaterThan(2);
    expect(t100).toBeLessThan(6);
    expect(car.speed * 3.6).toBeGreaterThan(140);
    expect(car.speed * 3.6).toBeLessThan(175);
    expect(car.z).toBeGreaterThan(100); // heading 0 = +z
  });

  it('steers right with +steer (toward -x when heading +z)', () => {
    const car = new Car();
    car.reset(0, 0, 0, flat);
    run(car, flat, 2, inp({ throttle: 1 }));
    run(car, flat, 1, inp({ throttle: 1, steer: 1 }));
    expect(car.x).toBeLessThan(-1);
  });

  it('turning radius at 60 km/h and grip drift on gravel vs tarmac', () => {
    for (const surf of ['tarmac', 'gravel', 'ice']) {
      const g = makeGround(() => 0, surf);
      const car = new Car();
      car.reset(0, 0, 0, g);
      car.vz = 16.7;
      let maxSlip = 0;
      run(car, g, 3, inp({ throttle: 0.6, steer: 1 }), () => (maxSlip = Math.max(maxSlip, Math.abs(car.lateralSpeed))));
      const r = car.speed / Math.max(1e-3, Math.abs(car.yawRate));
      console.log(`${surf}: radius ~${r.toFixed(1)} m, speed ${(car.speed * 3.6).toFixed(0)} km/h, max slip ${maxSlip.toFixed(1)} m/s`);
      expect(r).toBeGreaterThan(5);
      expect(r).toBeLessThan(60);
    }
  });

  it('handbrake makes the car rotate and slide', () => {
    const g = makeGround(() => 0, 'gravel');
    const car = new Car();
    car.reset(0, 0, 0, g);
    car.vz = 25;
    let maxSlip = 0;
    run(car, g, 0.8, inp({ steer: 1, handbrake: true }), () => (maxSlip = Math.max(maxSlip, Math.abs(car.lateralSpeed))));
    console.log(`handbrake: heading ${((car.heading * 180) / Math.PI).toFixed(0)} deg, max slip ${maxSlip.toFixed(1)} m/s`);
    expect(Math.abs(car.heading)).toBeGreaterThan(0.6);
    expect(maxSlip).toBeGreaterThan(4);
  });

  it('drift recovers when steering is released', () => {
    const g = makeGround(() => 0, 'gravel');
    const car = new Car();
    car.reset(0, 0, 0, g);
    car.vz = 25;
    run(car, g, 0.6, inp({ steer: 1, handbrake: true, throttle: 1 }));
    run(car, g, 2.5, inp({ throttle: 1 }));
    console.log(`after recovery: slip ${car.lateralSpeed.toFixed(2)} m/s yaw ${car.yawRate.toFixed(2)}`);
    expect(Math.abs(car.lateralSpeed)).toBeLessThan(1.5);
    expect(Math.abs(car.yawRate)).toBeLessThan(0.2);
  });

  it('slows uphill and speeds downhill', () => {
    const up = makeGround((_x, z) => z * 0.15);
    const down = makeGround((_x, z) => -z * 0.15);
    const a = new Car(),
      b = new Car();
    a.reset(0, 0, 0, up);
    b.reset(0, 0, 0, down);
    a.vz = b.vz = 20;
    run(a, up, 3, inp({}));
    run(b, down, 3, inp({}));
    console.log(`coast 3s from 72 km/h: uphill ${(a.speed * 3.6).toFixed(0)}, downhill ${(b.speed * 3.6).toFixed(0)} km/h`);
    expect(a.speed).toBeLessThan(15);
    expect(b.speed).toBeGreaterThan(21);
  });

  it('gets airborne over a crest and lands', () => {
    // ramp up then sharp drop at z = 50
    const crest = makeGround((_x, z) => (z < 50 ? Math.max(0, (z - 30) * 0.12) : Math.max(0, 2.4 - (z - 50) * 0.3)));
    const car = new Car();
    car.reset(0, 0, 0, crest);
    car.vz = 30;
    let maxAir = 0,
      landed = 0;
    const ev = { impact: 0, landing: 0 };
    run(car, crest, 3, inp({ throttle: 1 }), () => {
      maxAir = Math.max(maxAir, car.airTime);
      car.consumeEvents(ev);
      landed = Math.max(landed, ev.landing);
    });
    console.log(`crest at 108 km/h: airtime ${maxAir.toFixed(2)} s, landing impact ${landed.toFixed(1)} m/s`);
    expect(maxAir).toBeGreaterThan(0.3);
    expect(car.airborne).toBe(false);
  });

  it('collides with a tree and bounces', () => {
    const g = makeGround(() => 0, 'tarmac', [[0, 20, 0.8]]);
    const car = new Car();
    car.reset(0, 0, 0, g);
    car.vz = 20;
    let impact = 0;
    const ev = { impact: 0, landing: 0 };
    run(car, g, 1.5, inp({}), () => {
      car.consumeEvents(ev);
      impact = Math.max(impact, ev.impact);
    });
    expect(impact).toBeGreaterThan(10);
    expect(car.z).toBeLessThan(20);
  });
});

describe('handling report', () => {
  it('steady-state cornering', () => {
    for (const surf of ['tarmac', 'gravel', 'snow', 'ice']) {
      for (const st of [0.5, 1]) {
        const g = makeGround(() => 0, surf);
        const car = new Car();
        car.reset(0, 0, 0, g);
        car.vz = 27.8;
        run(car, g, 2.5, inp({ throttle: 0.8, steer: st }));
        const r = car.speed / Math.max(1e-3, Math.abs(car.yawRate));
        console.log(`${surf} steer ${st} @100: radius ${r.toFixed(1)} m, speed ${(car.speed * 3.6).toFixed(0)} km/h, slip ${car.lateralSpeed.toFixed(1)} m/s, slide ${car.slide.toFixed(2)}`);
      }
    }
  });
});
