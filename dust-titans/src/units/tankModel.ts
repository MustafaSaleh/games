import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Procedural low-poly tank (Dust Titans colours): hull with a sloped nose, two tracks with
 * road wheels, a rounded turret with a hatch, a long barrel. The hull is posed by the game;
 * the turret turns on its own and the barrel recoils when it fires.
 */
export interface TankColors {
  body: number;
  stripe: number;
  dark: number;
}

export const TANK_COLORS: TankColors = { body: 0xe9a53a, stripe: 0xff6a3d, dark: 0x2a2c31 };

export interface TankModel {
  root: THREE.Group; // positioned / tilted by the game
  turret: THREE.Group; // rotation.y relative to the hull
  barrel: THREE.Group; // recoil along local z
  wheels: THREE.Object3D[];
  dispose(): void;
}

function colored(g: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g;
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
  geo.deleteAttribute('uv');
  return geo;
}
const box = (w: number, h: number, d: number, x: number, y: number, z: number) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);

export function buildTank(c: TankColors = TANK_COLORS): TankModel {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const geos: THREE.BufferGeometry[] = [];
  const merged = (parts: THREE.BufferGeometry[]) => {
    const g = mergeGeometries(parts, false)!;
    g.computeVertexNormals();
    geos.push(g);
    return new THREE.Mesh(g, mat);
  };
  const root = new THREE.Group();

  // ---- hull + tracks ----
  const hull: THREE.BufferGeometry[] = [
    colored(box(2.7, 0.9, 5.6, 0, 1.05, 0), c.body),
    colored(new THREE.BoxGeometry(2.6, 0.7, 1.3).rotateX(-0.55).translate(0, 1.15, 2.95), c.body), // sloped nose
    colored(box(0.35, 0.1, 5.0, 1.05, 1.53, -0.2), c.stripe),
    colored(box(0.35, 0.1, 5.0, -1.05, 1.53, -0.2), c.stripe),
    colored(box(0.5, 0.06, 4.2, 0, 1.62, -0.2), c.dark),
    colored(box(2.8, 0.3, 0.25, 0, 0.75, -2.85), c.dark), // rear plate
    colored(box(0.4, 0.15, 0.1, 0.9, 1.1, 3.25), 0xfff6d8), // headlights
    colored(box(0.4, 0.15, 0.1, -0.9, 1.1, 3.25), 0xfff6d8),
  ];
  for (const s of [-1, 1]) {
    hull.push(colored(box(0.9, 1.0, 6.0, s * 1.7, 0.55, 0), c.dark)); // track
    hull.push(colored(box(1.0, 0.12, 6.1, s * 1.7, 1.12, 0), c.body)); // fender
    for (let k = -2; k <= 2; k++) hull.push(colored(box(0.95, 0.08, 0.3, s * 1.7, 0.06, k * 1.15), 0x3c3f45)); // cleats
  }
  root.add(merged(hull));
  const wheels: THREE.Object3D[] = [];
  const wheelGeo = colored(new THREE.CylinderGeometry(0.42, 0.42, 0.95, 8).rotateZ(Math.PI / 2), 0x4a4d54);
  geos.push(wheelGeo);
  for (const s of [-1, 1])
    for (let k = -2; k <= 2; k++) {
      const w = new THREE.Mesh(wheelGeo, mat);
      w.position.set(s * 1.72, 0.5, k * 1.15);
      root.add(w);
      wheels.push(w);
    }

  // ---- turret ----
  const turret = new THREE.Group();
  turret.position.set(0, 1.55, -0.3);
  turret.add(
    merged([
      colored(new THREE.CylinderGeometry(1.15, 1.35, 0.85, 8).translate(0, 0.45, 0), c.body),
      colored(new THREE.CylinderGeometry(0.42, 0.42, 0.22, 8).translate(-0.35, 0.95, -0.3), c.dark), // hatch
      colored(box(0.25, 0.25, 0.25, 0.55, 1.0, -0.4), c.stripe), // sensor
      colored(box(1.6, 0.14, 0.5, 0, 0.6, -1.2), c.stripe), // bustle rack
    ]),
  );
  const barrel = new THREE.Group();
  barrel.position.set(0, 0.5, 0.9);
  barrel.add(
    merged([
      colored(new THREE.CylinderGeometry(0.17, 0.2, 2.8, 8).rotateX(Math.PI / 2).translate(0, 0, 1.4), c.dark),
      colored(new THREE.CylinderGeometry(0.26, 0.26, 0.45, 8).rotateX(Math.PI / 2).translate(0, 0, 2.75), c.stripe), // muzzle
    ]),
  );
  turret.add(barrel);
  root.add(turret);

  return {
    root,
    turret,
    barrel,
    wheels,
    dispose() {
      root.removeFromParent();
      for (const g of geos) g.dispose();
      mat.dispose();
    },
  };
}
