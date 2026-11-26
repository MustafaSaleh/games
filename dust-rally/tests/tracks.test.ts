import { describe, expect, it } from 'vitest';
import forest from '../src/tracks/forest.json';
import desert from '../src/tracks/desert.json';
import snow from '../src/tracks/snow.json';
import { StageWorld, type StageDef } from '../src/world/stage';

describe('stage tracks', () => {
  for (const def of [forest, desert, snow] as StageDef[]) {
    it(`${def.id} is valid and does not run into itself`, () => {
      const w = new StageWorld(def, false);
      const tr = w.track;
      let minGap = 1e9;
      for (let i = tr.start; i < tr.end; i += 2)
        for (let j = i + 60; j < tr.end; j += 2) {
          const d = Math.hypot(tr.x(i) - tr.x(j), tr.z(i) - tr.z(j));
          if (d < minGap) minGap = d;
        }
      let maxSlope = 0;
      for (let i = tr.start + 1; i < tr.end; i++) maxSlope = Math.max(maxSlope, Math.abs(tr.h(i) - tr.h(i - 1)) / tr.spacing);
      console.log(`${def.id}: ${tr.lengthM.toFixed(0)} m, gates at ${w.gates.map((g) => g.s.toFixed(0)).join(',')}, min self-gap ${minGap.toFixed(1)} m, max road slope ${(maxSlope * 100).toFixed(0)}%`);
      expect(minGap).toBeGreaterThan(30);
      expect(w.gates[w.gates.length - 1].finish).toBe(true);
    });
  }
});
