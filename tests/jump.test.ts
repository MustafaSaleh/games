import { describe, expect, it } from 'vitest';
import forest from '../src/tracks/forest.json';
import { StageWorld, type StageDef } from '../src/world/stage';
import { Terrain } from '../src/world/terrain';
import { Car } from '../src/physics/car';

describe('jumps on real terrain', () => {
  it('car gets airborne over the first forest-ridge jump at rally speed', () => {
    const def = forest as StageDef;
    const w = new StageWorld(def, false);
    const t = new Terrain(w, 140);
    const at = def.jumps![0].at;
    const i0 = Math.round((at - 90) / 2);
    const tr = w.track;
    t.ensureAround(tr.x(i0 + 45), tr.z(i0 + 45), 200);
    const car = new Car();
    car.reset(tr.x(i0), tr.z(i0), Math.atan2(tr.dx(i0), tr.dz(i0)), t);
    const sp = 34;
    car.vx = tr.dx(i0) * sp;
    car.vz = tr.dz(i0) * sp;
    let maxAir = 0;
    let hint = i0;
    const prof: string[] = [];
    for (let k = 0; k < 60 * 4; k++) {
      // follow the road (simple pursuit), hold speed
      let best = 1e9;
      for (let i = hint; i < hint + 30; i++) {
        const d = Math.hypot(tr.x(i) - car.x, tr.z(i) - car.z);
        if (d < best) { best = d; hint = i; }
      }
      const j = hint + 10;
      const desired = Math.atan2(tr.x(j) - car.x, tr.z(j) - car.z);
      let diff = desired - car.heading;
      while (diff > Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;
      car.step(1 / 60, { steer: Math.max(-1, Math.min(1, -diff * 2.5)), throttle: car.speed < sp ? 1 : 0, brake: 0, handbrake: false }, t);
      maxAir = Math.max(maxAir, car.airTime);
      if (k % 6 === 0) prof.push(`${(hint * 2).toFixed(0)}:${car.y.toFixed(2)}${car.airborne ? '*' : ''}`);
    }
    console.log(`jump at ${at} m: max airtime ${maxAir.toFixed(2)} s`);
    console.log(prof.join(' '));
    const hs: string[] = [];
    for (let s = at - 30; s <= at + 25; s += 4) hs.push(`${s}:${tr.h(Math.round(s / 2)).toFixed(2)}/${t.heightAt(tr.x(Math.round(s / 2)), tr.z(Math.round(s / 2))).toFixed(2)}`);
    console.log('road h / terrain h:', hs.join(' '));
    expect(maxAir).toBeGreaterThan(0.25);
  });
});

describe('off-road bumps', () => {
  it('no constant micro-hopping over rough terrain at speed', () => {
    const w = new StageWorld(forest as StageDef, false);
    const t = new Terrain(w, 160);
    t.setPropDensity(0); // no trees: we only care about the ground here
    t.ensureAround(400, 300, 260);
    const car = new Car();
    car.reset(300, 300, Math.PI / 2, t); // drive along +x, away from the road
    car.vx = 32;
    let takeoffs = 0,
      airFrames = 0,
      was = false;
    for (let k = 0; k < 60 * 6; k++) {
      car.step(1 / 60, { steer: 0, throttle: 1, brake: 0, handbrake: false }, t);
      if (car.airborne && !was) takeoffs++;
      if (car.airborne) airFrames++;
      was = car.airborne;
    }
    console.log(`6 s off-road at ~${(car.speed * 3.6).toFixed(0)} km/h: ${takeoffs} takeoffs, ${airFrames} airborne frames of 360`);
    expect(airFrames).toBeLessThan(120);
  });
});
