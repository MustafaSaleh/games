import * as THREE from 'three';
import type { BiomeDef } from '@engine/config/biomes';
import { smoothstep } from '@engine/core/math';
import { Kit } from './kit';

/**
 * City battlefields: Cairo, Riyadh, Dubai. Landmarks are INSPIRED BY the real ones, stand
 * outside the arena (out of reach) and are never damaged. Inside there is only cover:
 * market stalls, palms, planters, barriers.
 */

export type CityId = 'cairo' | 'riyadh' | 'dubai';

/** a solid circle inside the arena (absolute top height): blocks units and shots */
export interface Solid {
  x: number;
  z: number;
  r: number;
  top: number;
}

const sandSurfaces = (sand: number) => ({ tarmac: 0x4a4a4e, gravel: 0xa8946e, dirt: 0x9a7a52, sand, snow: 0xe8eef2, ice: 0xbcd6e6, mud: 0x5a4632, grass: 0x8aa04f });

export const CITY_BIOMES: Record<CityId, BiomeDef> = {
  cairo: {
    id: 'cairo',
    name: 'Cairo',
    palette: { ground: 0xd9b46e, groundAlt: 0xcfa862, groundLow: 0x9aa457, groundHigh: 0xe3c283, steep: 0xb48a55, surfaces: sandSurfaces(0xd9b46e), foliage: 0x4f7a32, foliageAlt: 0x6a8a3a, trunk: 0x7a5a3a, rock: 0xb59a72, bush: 0x6f8a3a, fog: 0xf0c98e },
    offroad: 'sand',
    patch: 'dirt',
    patchAmount: 0.15,
    roadSurfaces: ['sand'],
    terrain: { hillAmp: 4, midAmp: 1.4, roughAmp: 0.25, duneAmp: 2 },
    props: [
      { type: 'shrub', density: 1.6, cluster: 0.4, scale: [0.6, 1.2], roadGap: 1 },
      { type: 'rock', density: 0.6, cluster: 0.5, scale: [0.6, 1.4], roadGap: 2 },
      { type: 'pebble', density: 3, cluster: 0, scale: [0.4, 0.9], roadGap: 0.5 },
    ],
  },
  riyadh: {
    id: 'riyadh',
    name: 'Riyadh',
    palette: { ground: 0xd8b487, groundAlt: 0xcda679, groundLow: 0xc49d70, groundHigh: 0xe2c49a, steep: 0xa8754d, surfaces: sandSurfaces(0xd8b487), foliage: 0x557a36, foliageAlt: 0x6c8b3e, trunk: 0x7a5a3a, rock: 0xa77b55, bush: 0x77874a, fog: 0xf3dcb8 },
    offroad: 'sand',
    patch: 'gravel',
    patchAmount: 0.25,
    roadSurfaces: ['sand'],
    terrain: { hillAmp: 5, midAmp: 1.6, roughAmp: 0.3, duneAmp: 1.5 },
    props: [
      { type: 'rock', density: 1.0, cluster: 0.5, scale: [0.6, 1.5], roadGap: 2 },
      { type: 'shrub', density: 1.8, cluster: 0.3, scale: [0.6, 1.1], roadGap: 1 },
      { type: 'pebble', density: 4, cluster: 0, scale: [0.4, 1.0], roadGap: 0.5 },
    ],
  },
  dubai: {
    id: 'dubai',
    name: 'Dubai',
    palette: { ground: 0xe6c992, groundAlt: 0xdcbd84, groundLow: 0xcfae78, groundHigh: 0xf0d6a4, steep: 0xbf9862, surfaces: sandSurfaces(0xe6c992), foliage: 0x3f7a4a, foliageAlt: 0x4f8a50, trunk: 0x6a4e34, rock: 0xbfa47c, bush: 0x5a8a4a, fog: 0x2a2f52 },
    offroad: 'sand',
    patch: 'sand',
    patchAmount: 0,
    roadSurfaces: ['sand'],
    terrain: { hillAmp: 3, midAmp: 1, roughAmp: 0.2, duneAmp: 4 },
    props: [
      { type: 'shrub', density: 1.0, cluster: 0.4, scale: [0.6, 1.1], roadGap: 1 },
      { type: 'pebble', density: 2, cluster: 0, scale: [0.4, 0.8], roadGap: 0.5 },
    ],
  },
};

/* ------------------------------------------------------------------ */
/* terrain shapes                                                        */
/* ------------------------------------------------------------------ */

/** where the Nile flows (x of the river centre at z) */
export const nileX = (z: number): number => 18 * Math.sin(z / 55) + 8 * Math.sin(z / 23 + 1);

export const SHAPES: Record<CityId, { shape: (x: number, z: number, h: number) => number; water?: number }> = {
  // a shallow river winds through the middle: tanks wade, robot suits jump across
  cairo: {
    water: -1.3,
    shape: (x, z, h) => {
      const d = Math.abs(x - nileX(z));
      const cut = 1 - smoothstep(9, 24, d);
      return h + (-2.4 - h) * cut;
    },
  },
  // a high plateau in the north: robot suits jump up, tanks take the ramp in the middle
  riyadh: {
    shape: (x, z, h) => {
      const cliff = 7 * smoothstep(52, 60, z);
      const ramp = 7 * smoothstep(22, 60, z);
      const w = 1 - smoothstep(8, 13, Math.abs(x));
      return h + cliff + (ramp - cliff) * w;
    },
  },
  // the sea in the south: a shallow beach inside the arena, deep water outside
  dubai: {
    water: -0.9,
    shape: (x, z, h) => {
      const beach = smoothstep(-58, -82, z);
      const deep = smoothstep(150, 200, Math.hypot(x, z)) * beach;
      return h + (-1.7 - h) * beach + -7 * deep;
    },
  },
};

/* ------------------------------------------------------------------ */
/* scenery                                                              */
/* ------------------------------------------------------------------ */

type H = (x: number, z: number) => number;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function palm(k: Kit, solids: Solid[], x: number, z: number, y: number, h = 9, collide = true): void {
  const lean = Math.sin(x * 0.7 + z) * 0.5;
  k.cyl(0.32, 0.45, h, x, y, z, 0x8a6a44, 6);
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + lean;
    k.geo(new THREE.BoxGeometry(0.7, 0.12, 3.6).translate(0, 0, 1.8), i % 2 ? 0x4f8a3a : 0x3f7a32, x, y + h, z, a, false, 0.35);
  }
  if (collide) solids.push({ x, z, r: 0.7, top: y + h });
}

/** sandstone / modern blocks around the rim, outside the arena */
function cityRing(k: Kit, h: H, r: () => number, from: number, to: number, skip: (a: number) => boolean, colors: number[], windows: number, glow = 0): void {
  for (let i = 0; i < 70; i++) {
    const a = r() * Math.PI * 2;
    if (skip(a)) continue;
    const d = from + r() * (to - from);
    const x = Math.sin(a) * d,
      z = Math.cos(a) * d;
    const w = 12 + r() * 18,
      dd = 12 + r() * 16,
      hh = 10 + r() * (d > 230 ? 60 : 30);
    const y = h(x, z) - 1;
    const rot = a + (r() - 0.5) * 0.4;
    // deep foundations: far terrain isn't drawn, so buildings must not look like they float
    k.box(w, hh + 60, dd, x, y - 60, z, colors[Math.floor(r() * colors.length)], rot);
    // window bands
    for (let f = 3; f < hh - 2; f += 4.5) k.box(w * 0.86, 1.1, dd + 0.2, x, y + f, z, glow && r() < 0.5 ? glow : windows, rot, !!glow && r() < 0.5);
  }
}

export function buildCity(id: CityId, h: H, radius: number): { group: THREE.Group; solids: Solid[] } {
  const k = new Kit(); // landmarks (no fog, far away)
  const near = new Kit(); // cover inside the arena
  const solids: Solid[] = [];
  const r = rng(id.length * 977 + 13);

  if (id === 'cairo') {
    // pyramids on the western desert plateau
    for (const [px, pz, w] of [
      [-300, -40, 120],
      [-330, 70, 104],
      [-270, 150, 58],
    ] as const) {
      k.box(w * 1.6, 60, w * 1.6, px, h(px, pz) - 62, pz, 0xd9b46e, 0.08);
      k.pyramid(w, w * 0.64, px, h(px, pz) - 2, pz, 0xdcb97c, 0.08);
      k.pyramid(w * 0.18, w * 0.115, px, h(px, pz) - 2 + w * 0.525, pz, 0xf2dcae, 0.08); // bright tip
    }
    // lotus-lattice tower (north-east)
    const tx = 190,
      tz = 290,
      ty = h(tx, tz);
    k.cyl(5.5, 5.5, 60, tx, ty - 60, tz, 0xc9b79a, 12).cyl(4.2, 5.5, 120, tx, ty, tz, 0xc9b79a, 12).cyl(9, 4.5, 10, tx, ty + 118, tz, 0xd8c7a8, 12).cyl(6, 7, 8, tx, ty + 128, tz, 0xbfae92, 12).cyl(0.6, 0.6, 18, tx, ty + 136, tz, 0x9a8a72, 6);
    // minarets and domes (far east, out of reach)
    for (const [mx, mz] of [
      [300, -70],
      [320, 40],
    ] as const) {
      const my = h(mx, mz);
      k.box(46, 82, 46, mx, my - 60, mz, 0xe6d6b8).sphere(16, mx, my + 22, mz, 0xd2c09c, false, true).sphere(7, mx + 18, my + 22, mz + 18, 0xd2c09c, false, true);
      for (const [ox, oz] of [
        [-26, -26],
        [26, 26],
      ] as const) {
        k.cyl(1.6, 2, 58, mx + ox, my, mz + oz, 0xeadcc0, 8).cyl(2.8, 2.8, 1.5, mx + ox, my + 40, mz + oz, 0xd8c8a8, 8).cyl(0, 1.9, 8, mx + ox, my + 58, mz + oz, 0xc8b48c, 8);
      }
    }
    cityRing(k, h, r, 205, 300, (a) => Math.sin(a) < -0.55, [0xd9c29a, 0xcdb084, 0xe6d3b0, 0xc69f74], 0x6a5a48);
    // the Nile: palms on both banks, feluccas on the water
    for (let z = -140; z <= 140; z += 13) {
      for (const side of [-1, 1]) {
        const x = nileX(z) + side * (18 + r() * 4);
        if (Math.hypot(x, z) > radius - 8) continue;
        palm(near, solids, x, z, h(x, z), 8 + r() * 3);
      }
    }
    for (const fz of [-70, 15, 90]) {
      const fx = nileX(fz),
        fy = -1.3;
      near.box(7, 1, 2.2, fx, fy - 0.4, fz, 0x7a5236, 0.25).cyl(0.12, 0.15, 9, fx, fy, fz, 0x5a3e28, 5);
      near.geo(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 8.5, 0), new THREE.Vector3(0, 1.2, 5.5)]), 0xfaf3e0, fx, fy + 0.6, fz, 0.25);
    }
    // market stalls (cover)
    const awn = [0xd84a3a, 0x2e7dd1, 0xf2b630, 0x3aa35a];
    for (let i = 0; i < 12; i++) {
      const side = i % 2 ? 1 : -1;
      const z = -60 + Math.floor(i / 2) * 22 + r() * 6;
      const x = nileX(z) + side * (48 + r() * 30);
      const y = h(x, z);
      near.box(4.4, 2.4, 3.2, x, y, z, 0x8a6a48, side * 0.3).box(5.2, 0.35, 4.2, x, y + 2.6, z, awn[i % 4], side * 0.3).box(5.2, 0.36, 1.2, x, y + 2.6, z, 0xfaf3e0, side * 0.3);
      solids.push({ x, z, r: 2.7, top: y + 3 });
    }
  }

  if (id === 'riyadh') {
    // tower with a sky bridge (north-east)
    const tx = 140,
      tz = 330,
      ty = h(tx, tz) - 2;
    k.box(44, 210, 26, tx, ty - 60, tz, 0x9fb3c4, 0.3);
    for (const s of [-1, 1]) k.geo(new THREE.BoxGeometry(12, 80, 24).translate(0, 40, 0), 0xa9bccc, tx + Math.cos(0.3) * s * 16, ty + 148, tz - Math.sin(0.3) * s * 16, 0.3, false, 0, -s * 0.14);
    k.box(30, 4, 8, tx, ty + 196, tz, 0x6f8494, 0.3).box(30, 0.8, 8.4, tx, ty + 195.2, tz, 0xffe7a6, 0.3, true);
    // tapered tower with a golden sphere (north-west)
    const fx = -180,
      fz = 320,
      fy = h(fx, fz) - 2;
    k.box(34, 60, 34, fx, fy - 60, fz, 0x8fa4b4, 0.2).pyramid(34, 190, fx, fy, fz, 0x8fa4b4, 0.2).sphere(9, fx, fy + 125, fz, 0xf2c24a).cyl(0.6, 0.6, 40, fx, fy + 186, fz, 0x5f6f7a, 6);
    cityRing(k, h, r, 200, 300, (a) => Math.cos(a) > 0.8, [0xe8dcc6, 0xd9cbb0, 0xf2ebdc, 0xc8b89a], 0x5f7f98);
    // palm boulevards and planters (cover)
    for (let z = -120; z <= 40; z += 14) for (const x of [-42, 42]) if (Math.hypot(x, z) < radius - 8) palm(near, solids, x + r() * 2, z, h(x, z), 8 + r() * 2);
    for (let i = 0; i < 10; i++) {
      const a = r() * Math.PI * 2,
        d = 30 + r() * 90;
      const x = Math.sin(a) * d,
        z = Math.cos(a) * d;
      if (Math.abs(x) < 16 && z > 15) continue; // keep the ramp free
      const y = h(x, z);
      const rot = r() * Math.PI;
      near.box(8, 1.4, 2.4, x, y, z, 0xcbb592, rot).box(7.4, 0.5, 1.8, x, y + 1.4, z, 0x6c8b3e, rot);
      solids.push({ x: x + Math.cos(rot) * 2.5, z: z - Math.sin(rot) * 2.5, r: 1.6, top: y + 1.8 }, { x: x - Math.cos(rot) * 2.5, z: z + Math.sin(rot) * 2.5, r: 1.6, top: y + 1.8 });
    }
  }

  if (id === 'dubai') {
    // the super-tall stepped tower (north)
    const bx = 0,
      bz = 360,
      by = h(bx, bz) - 2;
    k.box(40, 60, 40, bx, by - 60, bz, 0x9fb6c9);
    let y = by;
    for (let t = 0; t < 10; t++) {
      const hh = 34 - t * 1.5,
        s = 1 - t * 0.085;
      for (let lobe = 0; lobe < 3; lobe++) {
        const a = (lobe / 3) * Math.PI * 2;
        const off = (10 - t * 0.6) * s;
        k.box(14 * s, hh, 22 * s, bx + Math.sin(a) * off, y, bz + Math.cos(a) * off, 0x9fb6c9, a);
        k.box(14 * s + 0.2, 0.6, 22 * s + 0.2, bx + Math.sin(a) * off, y + hh - 1, bz + Math.cos(a) * off, 0xbfe6ff, a, true);
      }
      y += hh;
    }
    k.cyl(0.4, 3.2, 70, bx, y, bz, 0xa9bccc, 8).sphere(1.2, bx, y + 70, bz, 0xff3b3b, true);
    // sail-shaped hotel on its island (south, in the sea)
    const sx = 70,
      sz = -300;
    const sail = new THREE.Shape();
    sail.moveTo(0, 0);
    sail.quadraticCurveTo(34, 50, 4, 120);
    sail.lineTo(0, 120);
    sail.lineTo(0, 0);
    k.cyl(26, 28, 3, sx, -2, sz, 0xe6c992, 16)
      .geo(new THREE.ExtrudeGeometry(sail, { depth: 14, bevelEnabled: false }).translate(0, 0, -7), 0xf2f6fa, sx - 8, 1, sz, Math.PI / 2 + 0.3)
      .cyl(0.8, 1, 135, sx - 8, 1, sz, 0xb8c4cc, 6)
      .geo(new THREE.BoxGeometry(0.8, 120, 0.8).translate(0, 60, 0), 0x9fd8ff, sx - 7, 1, sz, 0.3, true);
    // palm-shaped island (south-west, at sea level)
    const px = -280,
      pz = -330;
    k.box(14, 1.2, 160, px, -1.2, pz + 40, 0xe6c992, 0.4);
    for (let i = 0; i < 14; i++) {
      const a = 0.4 + (i / 13 - 0.5) * 2.6 + Math.PI;
      k.geo(new THREE.BoxGeometry(7, 1.2, 70).translate(0, 0, 40), i % 2 ? 0xdfc088 : 0x6a9a5a, px, -1.1, pz - 40, a);
    }
    k.geo(new THREE.TorusGeometry(110, 4, 4, 40, Math.PI * 1.2).rotateX(Math.PI / 2), 0xe6c992, px, -1.6, pz - 40, 0.4 + Math.PI * 0.9);
    // marina towers with neon
    const neon = [0x5ff2ff, 0xff5fc8, 0xffd23a, 0x8a7dff];
    for (let i = 0; i < 26; i++) {
      const a = (r() - 0.5) * 2.4;
      const d = 220 + r() * 110;
      const x = Math.sin(a) * d,
        z = Math.cos(a) * d;
      const hh = 40 + r() * 120,
        w = 14 + r() * 12;
      const yy = h(x, z) - 2;
      k.box(w, hh + 60, w, x, yy - 60, z, r() < 0.5 ? 0x2a3550 : 0x364466, a);
      const c = neon[i % 4];
      for (let f = 8; f < hh; f += 9) if (r() < 0.6) k.box(w + 0.3, 0.7, w + 0.3, x, yy + f, z, c, a, true);
      k.box(w * 0.7, 1.2, w * 0.7, x, yy + hh, z, c, a, true);
    }
    // beach umbrellas, palms and light posts inside
    for (let i = 0; i < 14; i++) {
      const x = -90 + i * 13 + r() * 4,
        z = -50 - r() * 6;
      if (Math.hypot(x, z) > radius - 8) continue;
      const yy = h(x, z);
      near.cyl(0.08, 0.08, 2.6, x, yy, z, 0xeeeeee, 5).cyl(0, 2, 0.9, x, yy + 2.3, z, i % 2 ? 0xff5f8a : 0x3fb6ff, 8);
    }
    for (let i = 0; i < 16; i++) {
      const a = r() * Math.PI * 2,
        d = 25 + r() * 110;
      const x = Math.sin(a) * d,
        z = Math.cos(a) * d;
      if (z < -55) continue;
      const yy = h(x, z);
      if (i % 2) palm(near, solids, x, z, yy, 9);
      else {
        near.cyl(0.15, 0.2, 6, x, yy, z, 0x3a3f4a, 6).box(1.4, 0.35, 0.5, x, yy + 6, z, neon[i % 4], 0, true);
        solids.push({ x, z, r: 0.4, top: yy + 6 });
      }
    }
  }

  const group = new THREE.Group();
  group.add(k.build(false), near.build(true));
  return { group, solids };
}
