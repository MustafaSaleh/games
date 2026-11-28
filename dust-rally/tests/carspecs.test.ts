import { describe, expect, it } from 'vitest';
import { Car } from '../src/physics/car';
import { getStyle } from '../src/config/cars';
import { SURFACE_INDEX } from '../src/config/surfaces';
import { ColliderHits, makeGroundSample } from '../src/world/terrain';

/** flat endless ground of one surface */
function ground(surface: keyof typeof SURFACE_INDEX) {
  return {
    heightAt: () => 0,
    sample: (_x: number, _z: number, out = makeGroundSample()) => Object.assign(out, { h: 0, nx: 0, ny: 1, nz: 0, surface: SURFACE_INDEX[surface], edge: -1 }),
    queryColliders: (_x: number, _z: number, _r: number, out: ColliderHits) => ((out.count = 0), out),
  } as never;
}

function drive(style: string, surface: keyof typeof SURFACE_INDEX, seconds: number): number {
  const c = new Car();
  c.spec = getStyle(style).spec;
  const g = ground(surface);
  c.reset(0, 0, 0, g);
  for (let i = 0; i < seconds * 60; i++) c.step(1 / 60, { steer: 0, throttle: 1, brake: 0, handbrake: false }, g);
  return c.speed;
}

describe('car performance differs', () => {
  it('on tarmac the coupe and roadster are faster than the truck and buggy at the top end', () => {
    const t = 25;
    expect(drive('coupe', 'tarmac', t)).toBeGreaterThan(drive('truck', 'tarmac', t));
    expect(drive('roadster', 'tarmac', t)).toBeGreaterThan(drive('buggy', 'tarmac', t));
  });
  it('on sand the buggy and truck beat the coupe and roadster', () => {
    const t = 6;
    expect(drive('buggy', 'sand', t)).toBeGreaterThan(drive('coupe', 'sand', t));
    expect(drive('truck', 'sand', t)).toBeGreaterThan(drive('roadster', 'sand', t));
  });
  it('the buggy gets off the line quickest', () => {
    const b = drive('buggy', 'gravel', 2);
    for (const s of ['hatch', 'coupe', 'truck', 'roadster']) expect(b).toBeGreaterThan(drive(s, 'gravel', 2));
  });
});
