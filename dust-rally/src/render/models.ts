import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { PropType } from '../config/biomes';
import { mulberry32 } from '../core/rng';
import type { CarStyle, Livery } from '../config/cars';

/**
 * Procedural low-poly geometry. No external model files.
 * Prop geometries carry a grey-scale vertex colour (shading detail) that gets
 * multiplied by the per-instance biome colour.
 */
function paint(g: THREE.BufferGeometry, shade: number): THREE.BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g;
  const n = geo.attributes.position.count;
  const c = new Float32Array(n * 3).fill(shade);
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  geo.deleteAttribute('uv');
  return geo;
}

function jitter(g: THREE.BufferGeometry, amt: number, seed: number): THREE.BufferGeometry {
  // jitter shared vertices consistently (on indexed geometry, before toNonIndexed)
  const rnd = mulberry32(seed);
  const p = g.attributes.position as THREE.BufferAttribute;
  const map = new Map<string, [number, number, number]>();
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    let d = map.get(key);
    if (!d) map.set(key, (d = [(rnd() - 0.5) * amt, (rnd() - 0.5) * amt, (rnd() - 0.5) * amt]));
    p.setXYZ(i, p.getX(i) + d[0], p.getY(i) + d[1], p.getZ(i) + d[2]);
  }
  return g;
}

function finish(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts, false)!;
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

export function propGeometry(type: PropType): THREE.BufferGeometry {
  switch (type) {
    case 'pine': {
      // tall, narrow, tiered: reads as a silhouette from the tilted top-down camera
      const trunk = new THREE.CylinderGeometry(0.14, 0.2, 1.2, 5).translate(0, 0.6, 0);
      const c1 = new THREE.ConeGeometry(1.25, 2.0, 7).translate(0, 1.9, 0);
      const c2 = new THREE.ConeGeometry(0.98, 1.8, 7).translate(0, 2.9, 0).rotateY(0.4);
      const c3 = new THREE.ConeGeometry(0.7, 1.6, 7).translate(0, 3.85, 0).rotateY(0.9);
      const c4 = new THREE.ConeGeometry(0.42, 1.3, 6).translate(0, 4.75, 0).rotateY(0.2);
      return finish([paint(trunk, 0.55), paint(c1, 0.82), paint(c2, 0.92), paint(c3, 1.0), paint(c4, 1.08)]);
    }
    case 'round': {
      const trunk = new THREE.CylinderGeometry(0.16, 0.24, 1.6, 5).translate(0, 0.8, 0);
      const crown = jitter(new THREE.IcosahedronGeometry(1.35, 0), 0.35, 3).scale(1, 0.8, 1).translate(0, 2.3, 0);
      const crown2 = jitter(new THREE.IcosahedronGeometry(0.85, 0), 0.25, 4).translate(0.55, 2.9, 0.2);
      return finish([paint(trunk, 0.55), paint(crown, 0.95), paint(crown2, 1.05)]);
    }
    case 'rock': {
      const r = jitter(new THREE.IcosahedronGeometry(1, 0), 0.45, 7).scale(1.1, 0.65, 0.95).translate(0, 0.15, 0);
      return finish([paint(r, 1)]);
    }
    case 'pebble': {
      const r = jitter(new THREE.DodecahedronGeometry(0.35, 0), 0.15, 9).scale(1.2, 0.6, 1).translate(0, 0.05, 0);
      return finish([paint(r, 1)]);
    }
    case 'bush': {
      const a = jitter(new THREE.IcosahedronGeometry(0.75, 0), 0.25, 11).scale(1, 0.7, 1).translate(0, 0.35, 0);
      const b = jitter(new THREE.IcosahedronGeometry(0.55, 0), 0.2, 12).scale(1, 0.75, 1).translate(0.6, 0.3, 0.25);
      const c = jitter(new THREE.IcosahedronGeometry(0.5, 0), 0.2, 13).scale(1, 0.75, 1).translate(-0.45, 0.28, -0.35);
      return finish([paint(a, 1), paint(b, 0.9), paint(c, 1.08)]);
    }
    case 'shrub': {
      const parts: THREE.BufferGeometry[] = [];
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        const cone = new THREE.ConeGeometry(0.13, 0.9, 4).translate(0, 0.45, 0).rotateZ(0.5).rotateY(a);
        parts.push(paint(cone, 0.85 + (i % 3) * 0.1));
      }
      parts.push(paint(new THREE.OctahedronGeometry(0.3, 0).scale(1, 0.5, 1).translate(0, 0.1, 0), 0.8));
      return finish(parts);
    }
    case 'marker': {
      // road-edge reflector post: white pole, orange reflective top (unlit material)
      const pole = new THREE.BoxGeometry(0.26, 1.4, 0.26).translate(0, 0.7, 0);
      const top = new THREE.BoxGeometry(0.32, 0.45, 0.32).translate(0, 1.6, 0);
      return finish([colorGeo(pole, 0xe8e8e8), colorGeo(top, 0xff7a1a)]);
    }
    case 'redwood': {
      // giant redwood: thick flared red-brown trunk, bare lower half, narrow dark crown high up
      const bark = 0x8a4a2c,
        barkDark = 0x6a3420,
        leaf = 0x2a4a2c,
        leafAlt = 0x335a33;
      const parts: THREE.BufferGeometry[] = [
        colorGeo(new THREE.CylinderGeometry(1.0, 1.7, 2.2, 9).translate(0, 1.1, 0), barkDark), // root flare
        colorGeo(jitter(new THREE.CylinderGeometry(0.55, 1.0, 13, 9, 3), 0.12, 21).translate(0, 8.7, 0), bark),
        colorGeo(new THREE.CylinderGeometry(0.25, 0.55, 6, 7).translate(0, 18, 0), barkDark),
      ];
      // a few stubby branches below the crown
      for (let i = 0; i < 4; i++) {
        const a = i * 1.7 + 0.4;
        parts.push(colorGeo(new THREE.CylinderGeometry(0.08, 0.16, 2.2, 4).rotateZ(1.2).translate(0.9, 12.5 + i * 0.9, 0).rotateY(a), barkDark));
      }
      // crown: stacked, jittered cones (narrow, dense, high)
      const tiers: [number, number, number][] = [
        [3.0, 4.2, 14.8],
        [2.6, 4.0, 17.2],
        [2.1, 3.6, 19.4],
        [1.5, 3.2, 21.4],
        [0.9, 2.6, 23.2],
      ];
      tiers.forEach(([r, h, y], i) => parts.push(colorGeo(jitter(new THREE.ConeGeometry(r, h, 8, 1), 0.5, 30 + i).translate(0, y, 0).rotateY(i * 0.7), i % 2 ? leafAlt : leaf)));
      return finish(parts.map((g) => (g.index ? g.toNonIndexed() : g)));
    }
    case 'ruin': {
      // a broken low-rise: shell with half an upper floor left, dark windows, moss and vines
      const con = 0x9a948a,
        conDark = 0x7c776d,
        win = 0x25272b,
        moss = 0x5a7a34;
      const p: THREE.BufferGeometry[] = [
        colorGeo(box(11, 6, 9, 0, 3, 0), con),
        colorGeo(box(11, 3.4, 4.5, 0, 7.7, -2.25), conDark),
        colorGeo(box(4.6, 2.6, 4.5, -3.2, 10.7, -2.25), con),
        colorGeo(box(1.2, 4.2, 1.2, 4.9, 8.1, 3.9), conDark), // a lone column
        colorGeo(box(3.2, 0.45, 2.4, 2, 6.2, 2), moss),
        colorGeo(box(2.4, 0.4, 1.8, -2.5, 9.6, -2.4), moss),
        colorGeo(box(0.7, 4.6, 0.16, 3.8, 2.6, 4.56), moss), // vines
        colorGeo(box(0.6, 3.4, 0.16, -4.6, 2.2, 4.56), moss),
        colorGeo(jitter(new THREE.IcosahedronGeometry(1.6, 0), 0.5, 41).scale(1.4, 0.5, 1).translate(-4.5, 0.3, 5.4), conDark), // rubble
      ];
      for (const y of [1.8, 4.5])
        for (const x of [-3.6, -0.6, 2.4]) {
          p.push(colorGeo(box(1.5, 1.3, 0.12, x, y, 4.53), win));
          p.push(colorGeo(box(1.5, 1.3, 0.12, x, y, -4.53), win));
        }
      for (const y of [1.8, 4.5]) for (const z of [-2, 1.6]) p.push(colorGeo(box(0.12, 1.3, 1.5, 5.53, y, z), win), colorGeo(box(0.12, 1.3, 1.5, -5.53, y, z), win));
      return finish(p);
    }
    case 'tower': {
      // a tall broken office block with window bands and a jagged top
      const con = 0x8f8b82,
        band = 0x2b2d31;
      const p: THREE.BufferGeometry[] = [
        colorGeo(box(9, 24, 9, 0, 12, 0), con),
        colorGeo(box(9, 4, 5, 0, 26, -2), con),
        colorGeo(box(4, 3.2, 4, -2.5, 29.6, -2.5), 0x7d796f),
        colorGeo(box(2.6, 0.4, 2.2, 2, 28.2, -1.6), 0x5a7a34),
      ];
      for (let y = 2.2; y < 23; y += 3) p.push(colorGeo(box(9.12, 1.1, 9.12, 0, y, 0), band));
      for (let y = 25.2; y < 27.5; y += 3) p.push(colorGeo(box(9.12, 1.1, 5.12, 0, y, -2), band));
      return finish(p);
    }
    case 'wreck': {
      // an old rusty car shell on its rims, grass on the roof
      const rust = 0x8a4b2b,
        rustDark = 0x63361f;
      const p: THREE.BufferGeometry[] = [
        colorGeo(box(1.8, 0.7, 4.1, 0, 0.55, 0), rust),
        colorGeo(box(1.6, 0.6, 1.9, 0, 1.18, -0.2), rustDark),
        colorGeo(box(1.64, 0.32, 1.5, 0, 1.22, -0.2), 0x22262a), // broken glass band
        colorGeo(box(1.7, 0.08, 1.2, 0, 0.94, 1.35), 0x9a5a35), // bonnet
        colorGeo(box(1.2, 0.18, 1.0, 0.1, 1.55, -0.3), 0x5a7a34), // moss on the roof
      ];
      for (const [x, z] of [
        [0.78, 1.3],
        [-0.78, 1.3],
        [0.78, -1.35],
        [-0.78, -1.35],
      ])
        p.push(colorGeo(box(0.32, 0.36, 0.62, x, 0.18, z), 0x1d1d1f));
      return finish(p.map((g) => g.rotateZ(0.05)));
    }
    case 'barrier': {
      // concrete road barrier with faded orange stripes
      const p: THREE.BufferGeometry[] = [
        colorGeo(box(0.85, 0.22, 3, 0, 0.11, 0), 0x9a968e),
        colorGeo(box(0.55, 0.7, 3, 0, 0.55, 0), 0xa8a49c),
        colorGeo(box(0.57, 0.14, 0.7, 0, 0.62, 0.9), 0xd2561e),
        colorGeo(box(0.57, 0.14, 0.7, 0, 0.62, -0.9), 0xd2561e),
      ];
      return finish(p);
    }
    case 'cactus': {
      const body = new THREE.CylinderGeometry(0.24, 0.28, 2.3, 6).translate(0, 1.15, 0);
      const arm1 = new THREE.CylinderGeometry(0.15, 0.15, 0.8, 5).translate(0, 0.4, 0).translate(0.45, 1.1, 0);
      const arm1b = new THREE.CylinderGeometry(0.14, 0.15, 0.5, 5).rotateZ(Math.PI / 2).translate(0.25, 1.0, 0);
      const arm2 = new THREE.CylinderGeometry(0.13, 0.13, 0.6, 5).translate(0, 0.3, 0).translate(-0.42, 1.45, 0);
      const arm2b = new THREE.CylinderGeometry(0.12, 0.13, 0.45, 5).rotateZ(Math.PI / 2).translate(-0.22, 1.4, 0);
      return finish([paint(body, 1), paint(arm1, 0.92), paint(arm1b, 0.92), paint(arm2, 0.95), paint(arm2b, 0.95)]);
    }
  }
}

/** Collision radius / height (unit scale) per prop type; radius 0 = no collision. */
export const PROP_COLLIDER: Record<PropType, { r: number; top: number }> = {
  pine: { r: 0.7, top: 5 },
  round: { r: 0.6, top: 3.5 },
  rock: { r: 0.95, top: 0.9 },
  pebble: { r: 0, top: 0 },
  bush: { r: 0, top: 0 },
  shrub: { r: 0, top: 0 },
  cactus: { r: 0.35, top: 2.3 },
  marker: { r: 0, top: 0 },
  redwood: { r: 1.35, top: 24 },
  ruin: { r: 6.0, top: 12 },
  tower: { r: 5.6, top: 31 },
  wreck: { r: 1.6, top: 1.6 },
  barrier: { r: 1.3, top: 0.9 },
};

export const PROP_TYPES: PropType[] = ['pine', 'round', 'rock', 'pebble', 'bush', 'shrub', 'cactus', 'marker', 'redwood', 'ruin', 'tower', 'wreck', 'barrier'];

/** Road-edge marker spacing (track samples, 2 m each) and offset from the edge (m). */
export const MARKER = { every: 10, offset: 1.5 };

/* ------------------------------------------------------------------ */
/* Car                                                                  */
/* ------------------------------------------------------------------ */
export interface CarModel {
  root: THREE.Group; // positioned/rotated by the game
  body: THREE.Group; // suspension offset / roll / pitch applied here
  wheels: THREE.Object3D[]; // FL, FR, RL, RR
  wheelRadius: number;
  materials: THREE.Material[];
  geometries: THREE.BufferGeometry[];
  /** brake lamps (null on ghosts): use setBrakeLights() */
  brake: { mat: THREE.MeshBasicMaterial; glows: THREE.Sprite[]; on: number } | null;
}

/** 0 = off (dim tail lights), 1 = full brake lights */
export function setBrakeLights(m: CarModel, amount: number): void {
  const b = m.brake;
  if (!b) return;
  const a = Math.max(0, Math.min(1, amount));
  if (Math.abs(a - b.on) < 0.01) return;
  b.on = a;
  b.mat.color.setRGB(0.35 + 0.65 * a, 0.03 + 0.12 * a, 0.03 + 0.08 * a);
  for (const g of b.glows) g.material.opacity = a;
}

let glowTex: THREE.CanvasTexture | null = null;
function brakeGlowTexture(): THREE.CanvasTexture {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,90,70,1)');
  grd.addColorStop(0.25, 'rgba(255,30,20,0.75)');
  grd.addColorStop(1, 'rgba(255,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}

/** rear lamp centres of the car being built (filled by lights()) */
const rearLamps: [number, number, number][] = [];

function colorGeo(g: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const c = new THREE.Color(hex);
  const geo = g.index ? g.toNonIndexed() : g;
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  geo.deleteAttribute('uv');
  return geo;
}

type Parts = THREE.BufferGeometry[];
const box = (w: number, h: number, d: number, x: number, y: number, z: number) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);

/** Box whose top face is narrowed/shortened (cabins). */
function taperBox(w: number, h: number, d: number, topX: number, topZ: number, topShift: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) > 0) {
      p.setX(i, p.getX(i) * topX);
      p.setZ(i, p.getZ(i) * topZ + topShift);
    }
  }
  return g;
}

function lights(parts: Parts, front: number, rear: number, y: number, x = 0.6): void {
  parts.push(colorGeo(box(0.4, 0.16, 0.06, x, y, front), 0xfff6d8));
  parts.push(colorGeo(box(0.4, 0.16, 0.06, -x, y, front), 0xfff6d8));
  parts.push(colorGeo(box(0.4, 0.14, 0.06, x + 0.02, y + 0.04, rear), 0xd0202a));
  parts.push(colorGeo(box(0.4, 0.14, 0.06, -x - 0.02, y + 0.04, rear), 0xd0202a));
  rearLamps.push([x + 0.02, y + 0.04, rear], [-x - 0.02, y + 0.04, rear]);
}

/** Rally hatchback (the original car). */
function hatch(parts: Parts, L: Livery): void {
  parts.push(colorGeo(box(1.8, 0.55, 3.9, 0, 0.55, 0), L.body));
  parts.push(colorGeo(box(1.7, 0.2, 1.2, 0, 0.88, 1.2), L.body));
  parts.push(colorGeo(taperBox(1.55, 0.55, 1.9, 0.86, 0.78, -0.1).translate(0, 1.1, -0.25), L.body));
  parts.push(colorGeo(box(1.42, 0.34, 1.6, 0, 1.08, -0.2), 0x22262e));
  parts.push(colorGeo(box(1.3, 0.08, 1.35, 0, 1.38, -0.33), L.roof));
  parts.push(colorGeo(box(0.35, 0.02, 1.36, 0, 1.43, -0.33), L.stripe));
  parts.push(colorGeo(box(0.35, 0.02, 1.2, 0, 0.99, 1.2), L.stripe));
  parts.push(colorGeo(box(1.6, 0.08, 0.35, 0, 1.35, -1.75), L.stripe));
  parts.push(colorGeo(box(0.1, 0.3, 0.2, 0.6, 1.2, -1.7), L.stripe));
  parts.push(colorGeo(box(0.1, 0.3, 0.2, -0.6, 1.2, -1.7), L.stripe));
  parts.push(colorGeo(box(1.85, 0.25, 0.2, 0, 0.38, 1.98), L.stripe));
  parts.push(colorGeo(box(1.85, 0.25, 0.2, 0, 0.38, -1.98), L.stripe));
  lights(parts, 1.96, -1.96, 0.66);
  for (const x of [-0.5, -0.17, 0.17, 0.5])
    parts.push(colorGeo(new THREE.CylinderGeometry(0.11, 0.11, 0.08, 6).rotateX(Math.PI / 2).translate(x, 0.98, 1.85), 0xfffbe8));
}

/** Low long-nosed coupe with a big wing. */
function coupe(parts: Parts, L: Livery): void {
  parts.push(colorGeo(box(1.86, 0.45, 4.2, 0, 0.5, 0), L.body));
  // long sloped bonnet
  parts.push(colorGeo(taperBox(1.76, 0.18, 1.7, 0.95, 0.9, 0.08).translate(0, 0.81, 1.1), L.body));
  // low fastback cabin, set back
  parts.push(colorGeo(taperBox(1.6, 0.48, 2.0, 0.82, 0.62, -0.2).translate(0, 0.96, -0.55), L.body));
  parts.push(colorGeo(box(1.46, 0.28, 1.6, 0, 0.94, -0.5), 0x22262e));
  parts.push(colorGeo(box(1.24, 0.07, 1.1, 0, 1.2, -0.68), L.roof));
  // twin stripes over the whole car
  for (const x of [-0.22, 0.22]) {
    parts.push(colorGeo(box(0.16, 0.02, 1.72, x, 0.91, 1.1), L.stripe));
    parts.push(colorGeo(box(0.16, 0.02, 1.12, x, 1.245, -0.68), L.stripe));
  }
  // big rear wing on two posts
  parts.push(colorGeo(box(1.9, 0.07, 0.5, 0, 1.28, -1.85), L.stripe));
  parts.push(colorGeo(box(0.08, 0.2, 0.5, 0.92, 1.33, -1.85), L.stripe));
  parts.push(colorGeo(box(0.08, 0.2, 0.5, -0.92, 1.33, -1.85), L.stripe));
  parts.push(colorGeo(box(0.1, 0.5, 0.18, 0.55, 1.0, -1.85), L.stripe));
  parts.push(colorGeo(box(0.1, 0.5, 0.18, -0.55, 1.0, -1.85), L.stripe));
  // splitter / bumpers / side skirts
  parts.push(colorGeo(box(1.95, 0.12, 0.35, 0, 0.3, 2.1), L.stripe));
  parts.push(colorGeo(box(1.9, 0.22, 0.18, 0, 0.36, -2.1), L.stripe));
  parts.push(colorGeo(box(0.08, 0.14, 2.6, 0.95, 0.32, 0), L.stripe));
  parts.push(colorGeo(box(0.08, 0.14, 2.6, -0.95, 0.32, 0), L.stripe));
  lights(parts, 2.11, -2.11, 0.6, 0.62);
}

/** Tall rally-raid truck: open bed, roof rack, spare wheel. */
function truck(parts: Parts, L: Livery): void {
  const y0 = 0.3; // extra ride height
  parts.push(colorGeo(box(1.95, 0.7, 4.3, 0, 0.75 + y0, 0), L.body));
  parts.push(colorGeo(box(1.85, 0.22, 1.1, 0, 1.2 + y0, 1.55), L.body));
  parts.push(colorGeo(taperBox(1.8, 0.7, 1.7, 0.92, 0.85, 0).translate(0, 1.45 + y0, 0.15), L.body));
  parts.push(colorGeo(box(1.7, 0.4, 1.5, 0, 1.45 + y0, 0.15), 0x22262e));
  parts.push(colorGeo(box(1.62, 0.08, 1.4, 0, 1.82 + y0, 0.15), L.roof));
  // roof rack + light bar
  parts.push(colorGeo(box(1.5, 0.08, 1.2, 0, 1.94 + y0, 0.1), 0x2a2a2e));
  for (const x of [-0.45, -0.15, 0.15, 0.45])
    parts.push(colorGeo(new THREE.CylinderGeometry(0.1, 0.1, 0.08, 6).rotateX(Math.PI / 2).translate(x, 2.05 + y0, 0.72), 0xfffbe8));
  // open bed with spare wheel
  parts.push(colorGeo(box(1.75, 0.08, 1.6, 0, 1.12 + y0, -1.25), 0x2a2a2e));
  parts.push(colorGeo(new THREE.CylinderGeometry(0.42, 0.42, 0.28, 8).translate(0, 1.3 + y0, -1.25), 0x18181a));
  // side stripe + bonnet stripe
  parts.push(colorGeo(box(0.06, 0.16, 4.1, 0.99, 0.85 + y0, 0), L.stripe));
  parts.push(colorGeo(box(0.06, 0.16, 4.1, -0.99, 0.85 + y0, 0), L.stripe));
  parts.push(colorGeo(box(0.5, 0.02, 1.1, 0, 1.32 + y0, 1.55), L.stripe));
  // bull bar + rear bumper
  parts.push(colorGeo(box(1.7, 0.4, 0.12, 0, 0.6 + y0, 2.22), 0x2a2a2e));
  parts.push(colorGeo(box(2.0, 0.25, 0.2, 0, 0.45 + y0, -2.15), L.stripe));
  lights(parts, 2.16, -2.16, 0.95 + y0, 0.65);
}

/** two bucket seats with headrests (open cars) */
function seats(parts: Parts, y: number, z: number): void {
  for (const x of [-0.38, 0.38]) {
    parts.push(colorGeo(box(0.5, 0.16, 0.55, x, y, z), 0x1f1f23));
    parts.push(colorGeo(new THREE.BoxGeometry(0.5, 0.62, 0.13).rotateX(-0.18).translate(x, y + 0.36, z - 0.3), 0x1f1f23));
    parts.push(colorGeo(box(0.3, 0.2, 0.12, x, y + 0.75, z - 0.37), 0x2c2c32));
  }
}

/** Open-top two-seat roadster: long bonnet, windscreen, roll hoops behind the seats. */
function roadster(parts: Parts, L: Livery): void {
  parts.push(colorGeo(box(1.82, 0.42, 3.9, 0, 0.48, 0), L.body));
  parts.push(colorGeo(taperBox(1.7, 0.16, 1.5, 0.95, 0.9, 0.05).translate(0, 0.77, 1.1), L.body)); // bonnet
  parts.push(colorGeo(box(1.7, 0.2, 1.05, 0, 0.79, -1.38), L.body)); // rear deck
  parts.push(colorGeo(box(1.5, 0.08, 1.25, 0, 0.72, -0.2), 0x2a2a2e)); // open cockpit floor
  parts.push(colorGeo(box(0.14, 0.22, 1.3, 0.84, 0.8, -0.2), L.body)); // door tops
  parts.push(colorGeo(box(0.14, 0.22, 1.3, -0.84, 0.8, -0.2), L.body));
  seats(parts, 0.82, -0.12);
  // roll hoops
  for (const x of [-0.38, 0.38]) {
    parts.push(colorGeo(box(0.08, 0.55, 0.08, x - 0.24, 1.15, -0.72), L.stripe));
    parts.push(colorGeo(box(0.08, 0.55, 0.08, x + 0.24, 1.15, -0.72), L.stripe));
    parts.push(colorGeo(box(0.56, 0.08, 0.08, x, 1.44, -0.72), L.stripe));
  }
  // windscreen: frame + tinted glass, raked back
  parts.push(colorGeo(new THREE.BoxGeometry(1.46, 0.4, 0.04).rotateX(-0.55).translate(0, 1.0, 0.5), 0x9fc8e0));
  parts.push(colorGeo(new THREE.BoxGeometry(1.52, 0.06, 0.06).translate(0, 1.18, 0.4), L.stripe));
  // stripes, bumpers, mirrors
  parts.push(colorGeo(box(0.32, 0.02, 1.52, 0, 0.86, 1.1), L.stripe));
  parts.push(colorGeo(box(0.32, 0.02, 1.07, 0, 0.9, -1.38), L.stripe));
  parts.push(colorGeo(box(1.86, 0.18, 0.18, 0, 0.34, 1.98), L.stripe));
  parts.push(colorGeo(box(1.86, 0.18, 0.18, 0, 0.34, -1.98), L.stripe));
  parts.push(colorGeo(box(0.14, 0.1, 0.18, 0.98, 0.98, 0.35), L.stripe));
  parts.push(colorGeo(box(0.14, 0.1, 0.18, -0.98, 0.98, 0.35), L.stripe));
  lights(parts, 1.98, -1.98, 0.6, 0.6);
}

/** Two-seat dune buggy: tube roll cage, open sides, engine at the back, big wheels. */
function buggy(parts: Parts, L: Livery): void {
  const tube = L.stripe;
  parts.push(colorGeo(box(1.5, 0.14, 3.3, 0, 0.62, -0.05), 0x2a2a2e)); // floor pan
  parts.push(colorGeo(taperBox(1.4, 0.36, 1.05, 0.78, 0.7, 0).translate(0, 0.86, 1.3), L.body)); // nose
  parts.push(colorGeo(box(0.24, 0.34, 1.7, 0.74, 0.84, -0.15), L.body)); // side pods
  parts.push(colorGeo(box(0.24, 0.34, 1.7, -0.74, 0.84, -0.15), L.body));
  parts.push(colorGeo(box(1.3, 0.42, 0.9, 0, 0.95, -1.4), L.body)); // engine cover
  parts.push(colorGeo(box(0.9, 0.22, 0.6, 0, 1.25, -1.45), 0x3a3a40)); // engine
  for (const x of [-0.3, 0.3]) parts.push(colorGeo(new THREE.CylinderGeometry(0.06, 0.06, 0.4, 6).rotateX(Math.PI / 2).translate(x, 0.95, -1.95), 0x9a9aa2)); // exhausts
  seats(parts, 0.78, -0.2);
  // roll cage: four posts, top frame, cross bars, A-pillars down to the nose
  const post = (x: number, z: number) => parts.push(colorGeo(box(0.08, 1.15, 0.08, x, 1.27, z), tube));
  post(0.68, 0.32);
  post(-0.68, 0.32);
  post(0.68, -0.8);
  post(-0.68, -0.8);
  parts.push(colorGeo(box(0.08, 0.08, 1.2, 0.68, 1.85, -0.24), tube));
  parts.push(colorGeo(box(0.08, 0.08, 1.2, -0.68, 1.85, -0.24), tube));
  parts.push(colorGeo(box(1.44, 0.08, 0.08, 0, 1.85, 0.32), tube));
  parts.push(colorGeo(box(1.44, 0.08, 0.08, 0, 1.85, -0.8), tube));
  parts.push(colorGeo(new THREE.BoxGeometry(0.08, 0.08, 1.05).rotateX(0.78).translate(0.6, 1.47, 0.68), tube));
  parts.push(colorGeo(new THREE.BoxGeometry(0.08, 0.08, 1.05).rotateX(0.78).translate(-0.6, 1.47, 0.68), tube));
  parts.push(colorGeo(new THREE.BoxGeometry(1.44, 0.07, 0.07).rotateZ(0.5).translate(0, 1.6, -0.8), tube)); // diagonal
  // light bar on the cage + front bumper tube
  for (const x of [-0.42, -0.14, 0.14, 0.42])
    parts.push(colorGeo(new THREE.CylinderGeometry(0.09, 0.09, 0.08, 6).rotateX(Math.PI / 2).translate(x, 1.95, 0.36), 0xfffbe8));
  parts.push(colorGeo(box(1.4, 0.1, 0.1, 0, 0.62, 1.88), tube));
  parts.push(colorGeo(box(0.3, 0.02, 1.0, 0, 1.05, 1.3), L.stripe));
  lights(parts, 1.84, -1.86, 0.84, 0.45);
}

const WHEELS: Record<CarStyle, { r: number; w: number; x: number; z: number }> = {
  hatch: { r: 0.36, w: 0.28, x: 0.82, z: 1.25 },
  coupe: { r: 0.35, w: 0.32, x: 0.86, z: 1.35 },
  truck: { r: 0.5, w: 0.36, x: 0.92, z: 1.4 },
  roadster: { r: 0.34, w: 0.3, x: 0.84, z: 1.3 },
  buggy: { r: 0.47, w: 0.4, x: 0.98, z: 1.28 },
};

/** Build a car of the given style and livery, facing +z, ~4 m long. */
export function buildCar(style: CarStyle, livery: Livery, ghost = false): CarModel {
  const parts: Parts = [];
  rearLamps.length = 0;
  if (style === 'coupe') coupe(parts, livery);
  else if (style === 'truck') truck(parts, livery);
  else if (style === 'roadster') roadster(parts, livery);
  else if (style === 'buggy') buggy(parts, livery);
  else hatch(parts, livery);

  const bodyGeo = mergeGeometries(parts, false)!;
  bodyGeo.computeVertexNormals();
  const mat = ghost
    ? new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.35, depthWrite: false })
    : new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  body.add(new THREE.Mesh(bodyGeo, mat));

  const W = WHEELS[style];
  const wheelGeo = colorGeo(new THREE.CylinderGeometry(W.r, W.r, W.w, 8).rotateZ(Math.PI / 2), 0x18181a);
  const wheelMat = ghost ? mat : new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const wheels: THREE.Object3D[] = [];
  for (const [x, z] of [
    [W.x, W.z],
    [-W.x, W.z],
    [W.x, -W.z],
    [-W.x, -W.z],
  ]) {
    const w = new THREE.Mesh(wheelGeo, wheelMat);
    w.position.set(x, W.r, z);
    w.rotation.order = 'YXZ';
    root.add(w);
    wheels.push(w);
  }
  const geometries = [bodyGeo, wheelGeo];
  const materials: THREE.Material[] = ghost ? [mat] : [mat, wheelMat];
  let brake: CarModel['brake'] = null;
  if (!ghost) {
    // brake lamps: slightly behind the tail lights, unlit (dim) until braking, plus a glow sprite
    const lampMat = new THREE.MeshBasicMaterial({ color: 0x5a0808 });
    const lampGeo = new THREE.BoxGeometry(0.42, 0.16, 0.04);
    const glowMat = new THREE.SpriteMaterial({ map: brakeGlowTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 });
    const glows: THREE.Sprite[] = [];
    for (const [x, y, z] of rearLamps) {
      const lamp = new THREE.Mesh(lampGeo, lampMat);
      lamp.position.set(x, y, z - 0.035);
      body.add(lamp);
      const glow = new THREE.Sprite(glowMat);
      glow.position.set(x, y, z - 0.25);
      glow.scale.setScalar(1.6);
      glow.renderOrder = 6;
      body.add(glow);
      glows.push(glow);
    }
    geometries.push(lampGeo);
    materials.push(lampMat, glowMat);
    brake = { mat: lampMat, glows, on: -1 };
    setBrakeLights({ brake } as CarModel, 0);
  }
  return { root, body, wheels, wheelRadius: W.r, materials, geometries, brake };
}

export function disposeCar(m: CarModel): void {
  m.root.removeFromParent();
  for (const g of m.geometries) g.dispose();
  for (const mat of m.materials) mat.dispose();
}
