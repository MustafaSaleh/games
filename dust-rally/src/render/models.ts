import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { PropType } from '../config/biomes';
import { mulberry32 } from '../core/rng';

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
};

export const PROP_TYPES: PropType[] = ['pine', 'round', 'rock', 'pebble', 'bush', 'shrub', 'cactus', 'marker'];

/** Road-edge marker spacing (track samples, 2 m each) and offset from the edge (m). */
export const MARKER = { every: 10, offset: 1.5 };

/* ------------------------------------------------------------------ */
/* Car                                                                  */
/* ------------------------------------------------------------------ */
export interface CarModel {
  root: THREE.Group; // positioned/rotated by the game
  body: THREE.Group; // suspension offset / roll / pitch applied here
  wheels: THREE.Object3D[]; // FL, FR, RL, RR
  materials: THREE.Material[];
}

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

/** Low-poly rally hatchback, facing +z, ~4 m long. */
export function buildCar(bodyHex: number, ghost = false): CarModel {
  const stripe = 0x1d1d22;
  const parts: THREE.BufferGeometry[] = [];
  // lower body
  parts.push(colorGeo(new THREE.BoxGeometry(1.8, 0.55, 3.9).translate(0, 0.55, 0), bodyHex));
  // bonnet slope
  const bonnet = new THREE.BoxGeometry(1.7, 0.2, 1.2).translate(0, 0.88, 1.2);
  parts.push(colorGeo(bonnet, bodyHex));
  // cabin
  const cabin = new THREE.BoxGeometry(1.55, 0.55, 1.9);
  const cp = cabin.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < cp.count; i++) {
    if (cp.getY(i) > 0) {
      cp.setX(i, cp.getX(i) * 0.86);
      cp.setZ(i, cp.getZ(i) * 0.78 - 0.1);
    }
  }
  parts.push(colorGeo(cabin.translate(0, 1.1, -0.25), bodyHex));
  // windows (dark band)
  parts.push(colorGeo(new THREE.BoxGeometry(1.42, 0.34, 1.6).translate(0, 1.08, -0.2), 0x22262e));
  // roof (body colour, on top of windows)
  parts.push(colorGeo(new THREE.BoxGeometry(1.3, 0.08, 1.35).translate(0, 1.38, -0.33), bodyHex));
  // roof stripe + bonnet stripe
  parts.push(colorGeo(new THREE.BoxGeometry(0.35, 0.02, 1.36).translate(0, 1.43, -0.33), stripe));
  parts.push(colorGeo(new THREE.BoxGeometry(0.35, 0.02, 1.2).translate(0, 0.99, 1.2), stripe));
  // spoiler
  parts.push(colorGeo(new THREE.BoxGeometry(1.6, 0.08, 0.35).translate(0, 1.35, -1.75), stripe));
  parts.push(colorGeo(new THREE.BoxGeometry(0.1, 0.3, 0.2).translate(0.6, 1.2, -1.7), stripe));
  parts.push(colorGeo(new THREE.BoxGeometry(0.1, 0.3, 0.2).translate(-0.6, 1.2, -1.7), stripe));
  // bumpers
  parts.push(colorGeo(new THREE.BoxGeometry(1.85, 0.25, 0.2).translate(0, 0.38, 1.98), stripe));
  parts.push(colorGeo(new THREE.BoxGeometry(1.85, 0.25, 0.2).translate(0, 0.38, -1.98), stripe));
  // head / tail lights
  parts.push(colorGeo(new THREE.BoxGeometry(0.4, 0.16, 0.06).translate(0.6, 0.66, 1.96), 0xfff6d8));
  parts.push(colorGeo(new THREE.BoxGeometry(0.4, 0.16, 0.06).translate(-0.6, 0.66, 1.96), 0xfff6d8));
  parts.push(colorGeo(new THREE.BoxGeometry(0.4, 0.14, 0.06).translate(0.62, 0.7, -1.96), 0xd0202a));
  parts.push(colorGeo(new THREE.BoxGeometry(0.4, 0.14, 0.06).translate(-0.62, 0.7, -1.96), 0xd0202a));
  // spot lights pod on bonnet front
  for (const x of [-0.5, -0.17, 0.17, 0.5]) parts.push(colorGeo(new THREE.CylinderGeometry(0.11, 0.11, 0.08, 6).rotateX(Math.PI / 2).translate(x, 0.98, 1.85), 0xfffbe8));

  const bodyGeo = mergeGeometries(parts, false)!;
  bodyGeo.computeVertexNormals();
  const mat = ghost
    ? new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.35, depthWrite: false })
    : new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  body.add(new THREE.Mesh(bodyGeo, mat));

  const wheelGeo = colorGeo(new THREE.CylinderGeometry(0.36, 0.36, 0.28, 8).rotateZ(Math.PI / 2), 0x18181a);
  const wheelMat = ghost ? mat : new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const wheels: THREE.Object3D[] = [];
  for (const [x, z] of [
    [0.82, 1.25],
    [-0.82, 1.25],
    [0.82, -1.25],
    [-0.82, -1.25],
  ]) {
    const w = new THREE.Mesh(wheelGeo, wheelMat);
    w.position.set(x, 0.36, z);
    root.add(w);
    wheels.push(w);
  }
  return { root, body, wheels, materials: ghost ? [mat] : [mat, wheelMat] };
}
