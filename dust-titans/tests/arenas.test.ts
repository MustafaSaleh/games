import { describe, expect, it } from 'vitest';
import { ColliderHits } from '@engine/world/terrain';
import { ARENAS, ArenaGround, ArenaWorld, buildScenery } from '../src/arena';
import { nileX } from '../src/world/cities';

describe('arenas', () => {
  it('every arena builds its world and scenery; cities have cover inside the arena', () => {
    for (const def of ARENAS) {
      const w = new ArenaWorld(def);
      const h = (x: number, z: number) => w.adjustBase(x, z, 0);
      const sc = buildScenery(def, h);
      if (def.city) {
        expect(sc.solids.length).toBeGreaterThan(5);
        for (const s of sc.solids) expect(Math.hypot(s.x, s.z)).toBeLessThan(def.radius);
        expect(sc.group.children.length).toBe(2);
      } else expect(sc.solids.length).toBe(0);
    }
  });

  it('shapes: the Nile is below the water, the Riyadh plateau has a ramp, Dubai has a beach', () => {
    const cairo = new ArenaWorld(ARENAS.find((a) => a.id === 'cairo')!);
    expect(cairo.adjustBase(nileX(0), 0, 0)).toBeLessThan(cairo.waterLevel - 0.5);
    expect(cairo.adjustBase(nileX(0) + 40, 0, 0)).toBeGreaterThan(cairo.waterLevel);
    const riyadh = new ArenaWorld(ARENAS.find((a) => a.id === 'riyadh')!);
    expect(riyadh.adjustBase(40, 80, 0) - riyadh.adjustBase(40, 30, 0)).toBeGreaterThan(5); // cliff
    expect(riyadh.adjustBase(0, 45, 0)).toBeGreaterThan(2); // ramp half way up
    expect(riyadh.adjustBase(0, 45, 0)).toBeLessThan(6);
    const dubai = new ArenaWorld(ARENAS.find((a) => a.id === 'dubai')!);
    expect(dubai.adjustBase(0, -110, 0)).toBeLessThan(dubai.waterLevel);
    expect(dubai.adjustBase(0, -110, 0)).toBeGreaterThan(dubai.waterLevel - 1.5); // shallow enough to wade
  });

  it('city cover blocks units like terrain props', () => {
    const terrain = { heightAt: () => 0, sample: () => null, queryColliders: (_x: number, _z: number, _r: number, out: ColliderHits) => ((out.count = 0), out) } as never;
    const g = new ArenaGround(terrain, [{ x: 10, z: 0, r: 2, top: 3 }]);
    const hits = new ColliderHits();
    expect(g.queryColliders(7, 0, 1.5, hits).count).toBe(1);
    expect(hits.top[0]).toBe(3);
    expect(g.queryColliders(-20, 0, 1.5, hits).count).toBe(0);
  });
});
