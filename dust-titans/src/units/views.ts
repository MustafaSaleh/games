import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, lerp, lerpAngle } from '@engine/core/math';
import type { Mech } from './mech';
import type { Scout } from './scout';
import { buildCar, disposeCar, type CarModel } from '@engine/render/models';
import { buildTank, type TankModel } from './tankModel';
import type { Livery, Unit, UnitKind } from './unit';

/** A unit's 3D model plus how it is posed from the simulation every frame. */
export interface UnitView {
  readonly root: THREE.Group;
  update(u: Unit, alpha: number, dt: number): void;
  dispose(): void;
}

const _up = new THREE.Vector3();
const _f = new THREE.Vector3();
const _r = new THREE.Vector3();
const _m = new THREE.Matrix4();

/** tilt the root with a smoothed ground normal, facing `h` */
function pose(root: THREE.Object3D, x: number, y: number, z: number, h: number, u: Unit): void {
  root.position.set(x, y, z);
  _up.set(u.upX, u.upY, u.upZ).normalize();
  _f.set(Math.sin(h), 0, Math.cos(h));
  _f.addScaledVector(_up, -_f.dot(_up)).normalize();
  root.quaternion.setFromRotationMatrix(_m.makeBasis(_r.crossVectors(_up, _f), _up, _f));
}

export class TankView implements UnitView {
  readonly root: THREE.Group;
  private m: TankModel;

  constructor(l: Livery) {
    this.m = buildTank(l);
    this.root = this.m.root;
  }

  /** recoil kick (call when the cannon fires) */
  kick(): void {
    this.m.barrel.position.z = 0.4;
  }

  update(u: Unit, alpha: number, dt: number): void {
    const h = lerpAngle(u.pHeading, u.heading, alpha);
    pose(this.root, lerp(u.px, u.x, alpha), lerp(u.py, u.y, alpha), lerp(u.pz, u.z, alpha), h, u);
    if (u.fired) this.kick();
    this.m.turret.rotation.y = lerpAngle(u.pTurret, u.turret, alpha) - h;
    this.m.barrel.position.z += (0.9 - this.m.barrel.position.z) * Math.min(1, dt * 8);
    for (const w of this.m.wheels) w.rotation.x += u.drive * dt * (u.dashing ? 16 : 9);
  }

  dispose(): void {
    this.m.dispose();
  }
}

/* ------------------------------------------------------------------ */
/* Mech model                                                           */
/* ------------------------------------------------------------------ */

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

interface Leg {
  hip: THREE.Group;
  knee: THREE.Group;
}

export class MechView implements UnitView {
  readonly root = new THREE.Group();
  private pelvis = new THREE.Group();
  private torso = new THREE.Group();
  private cannon = new THREE.Group();
  private fist = new THREE.Group();
  private legs: Leg[] = [];
  private flames: THREE.Mesh[] = [];
  private geos: THREE.BufferGeometry[] = [];
  private mats: THREE.Material[] = [];
  private lean = 0;
  private flameT = 0;

  constructor(l: Livery) {
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    this.mats.push(mat);
    const mesh = (parts: THREE.BufferGeometry[]) => {
      const g = mergeGeometries(parts, false)!;
      g.computeVertexNormals();
      this.geos.push(g);
      return new THREE.Mesh(g, mat);
    };
    const { body, stripe, dark, glow } = l;

    // ---- legs (hip at the pelvis, knee half way, feet on the ground) ----
    this.pelvis.position.y = 2.6;
    this.root.add(this.pelvis);
    this.pelvis.add(mesh([colored(box(1.9, 0.6, 1.1, 0, 0, 0), dark), colored(box(2.0, 0.14, 1.15, 0, 0.3, 0), stripe)]));
    for (const s of [1, -1]) {
      const hip = new THREE.Group();
      hip.position.set(s * 0.78, -0.1, 0);
      hip.add(mesh([colored(box(0.62, 1.35, 0.72, 0, -0.62, 0), body), colored(new THREE.CylinderGeometry(0.36, 0.36, 0.8, 8).rotateZ(Math.PI / 2), dark)]));
      const knee = new THREE.Group();
      knee.position.y = -1.3;
      knee.add(
        mesh([
          colored(new THREE.SphereGeometry(0.34, 8, 6), dark),
          colored(box(0.55, 1.2, 0.62, 0, -0.62, 0.02), body),
          colored(box(0.58, 0.5, 0.15, 0, -0.45, 0.34), stripe), // shin plate
          colored(box(0.85, 0.28, 1.35, 0, -1.2, 0.18), dark), // foot
          colored(box(0.86, 0.08, 0.3, 0, -1.04, 0.75), stripe),
        ]),
      );
      hip.add(knee);
      this.pelvis.add(hip);
      this.legs.push({ hip, knee });
    }

    // ---- torso (turns to aim) ----
    this.pelvis.add(this.torso);
    this.torso.add(
      mesh([
        colored(box(2.5, 1.5, 1.9, 0, 1.15, -0.05), body),
        colored(box(2.0, 0.5, 1.6, 0, 0.35, 0), dark), // waist
        colored(box(2.6, 0.16, 1.95, 0, 1.5, -0.05), stripe),
        colored(box(0.9, 0.9, 0.9, 1.6, 1.55, 0), body), // shoulders
        colored(box(0.9, 0.9, 0.9, -1.6, 1.55, 0), body),
        colored(box(0.95, 0.18, 0.95, 1.6, 2.05, 0), stripe),
        colored(box(0.95, 0.18, 0.95, -1.6, 2.05, 0), stripe),
        colored(box(1.5, 1.2, 0.6, 0, 1.2, -1.2), dark), // jetpack
        colored(new THREE.CylinderGeometry(0.3, 0.38, 1.2, 8).translate(0.5, 1.0, -1.55), dark),
        colored(new THREE.CylinderGeometry(0.3, 0.38, 1.2, 8).translate(-0.5, 1.0, -1.55), dark),
        colored(new THREE.CylinderGeometry(0.04, 0.04, 0.9, 4).translate(0.8, 2.3, -0.6), dark), // antenna
        colored(new THREE.SphereGeometry(0.1, 6, 4).translate(0.8, 2.78, -0.6), glow),
      ]),
    );
    // cockpit glass with Mody inside (helmet + visor)
    const glass = new THREE.Mesh(
      new THREE.SphereGeometry(0.78, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.9, 1).rotateX(Math.PI / 2).translate(0, 1.25, 0.88),
      new THREE.MeshLambertMaterial({ color: 0x9fe7ff, transparent: true, opacity: 0.38, emissive: 0x0b3a4a, depthWrite: false }),
    );
    this.geos.push(glass.geometry);
    this.mats.push(glass.material as THREE.Material);
    const pilot = mesh([
      colored(new THREE.SphereGeometry(0.42, 12, 10).translate(0, 1.3, 0.75), 0xffc93c), // helmet
      colored(box(0.56, 0.2, 0.2, 0, 1.3, 1.12), 0x3a2a1c), // visor strip
      colored(new THREE.SphereGeometry(0.2, 8, 6).scale(1.1, 0.9, 0.6).translate(0, 1.14, 1.07), 0xf2c49b), // face
      colored(box(0.7, 0.12, 0.05, 0, 1.52, 1.14), 0xff6a3d), // helmet stripe
    ]);
    this.torso.add(pilot, glass);

    // right arm: cannon (aims), left arm: big fist
    this.cannon.position.set(-1.6, 1.1, 0.1);
    this.cannon.add(
      mesh([
        colored(box(0.7, 0.7, 1.5, 0, 0, 0.2), dark),
        colored(new THREE.CylinderGeometry(0.24, 0.28, 1.6, 8).rotateX(Math.PI / 2).translate(0, 0, 1.6), dark),
        colored(new THREE.CylinderGeometry(0.33, 0.33, 0.3, 8).rotateX(Math.PI / 2).translate(0, 0, 2.35), stripe),
        colored(box(0.74, 0.14, 1.0, 0, 0.36, 0.1), stripe),
      ]),
    );
    this.fist.position.set(1.6, 1.0, 0.1);
    this.fist.add(mesh([colored(box(0.62, 1.1, 0.62, 0, -0.2, 0), body), colored(box(0.85, 0.75, 0.85, 0, -0.95, 0.25), dark), colored(box(0.88, 0.14, 0.88, 0, -0.62, 0.25), stripe)]));
    this.torso.add(this.cannon, this.fist);

    // jet flames (additive, shown while the jets fire)
    const flameGeo = new THREE.ConeGeometry(0.3, 1.4, 8).rotateX(Math.PI).translate(0, -0.7, 0);
    const flameMat = new THREE.MeshBasicMaterial({ color: 0xffa03a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
    this.geos.push(flameGeo);
    this.mats.push(flameMat);
    for (const s of [0.5, -0.5]) {
      const f = new THREE.Mesh(flameGeo, flameMat);
      f.position.set(s, 0.4, -1.55);
      f.visible = false;
      this.torso.add(f);
      this.flames.push(f);
    }
  }

  update(u: Unit, alpha: number, dt: number): void {
    const m = u as Mech;
    const h = lerpAngle(u.pHeading, u.heading, alpha);
    pose(this.root, lerp(u.px, u.x, alpha), lerp(u.py, u.y, alpha), lerp(u.pz, u.z, alpha), h, u);

    // legs: a stride every 3.2 m; tucked in the air
    const ph = (m.stride / 3.2) * Math.PI * 2;
    const a = clamp(u.drive, 0, 1) * 0.6;
    for (let i = 0; i < 2; i++) {
      const leg = this.legs[i];
      const p = ph + i * Math.PI;
      let hip = -Math.sin(p) * a,
        knee = Math.max(0, Math.cos(p)) * a * 1.5;
      if (u.airborne) {
        hip = -0.45 + i * 0.25;
        knee = 0.9 - i * 0.3;
      }
      leg.hip.rotation.x += (hip - leg.hip.rotation.x) * Math.min(1, dt * 14);
      leg.knee.rotation.x += (knee - leg.knee.rotation.x) * Math.min(1, dt * 14);
    }
    this.pelvis.position.y = 2.6 - (u.airborne ? 0 : Math.abs(Math.cos(ph)) * 0.12 * (a / 0.6));
    // lean into a dash / fast walk
    const leanT = u.dashing ? 0.35 : u.drive * 0.12;
    this.lean += (leanT - this.lean) * Math.min(1, dt * 10);
    this.pelvis.rotation.x = this.lean;

    // torso + cannon aim
    this.torso.rotation.y = lerpAngle(u.pTurret, u.turret, alpha) - h;
    if (u.fired) this.cannon.position.z = -0.35;
    this.cannon.position.z += (0.1 - this.cannon.position.z) * Math.min(1, dt * 14);
    this.fist.rotation.x = Math.sin(ph) * a * 0.8;

    // flames
    this.flameT = m.jets || u.dashing ? 0.15 : Math.max(0, this.flameT - dt);
    for (const f of this.flames) {
      f.visible = this.flameT > 0;
      f.scale.set(1, 0.8 + Math.random() * 0.6, 1);
    }
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
  }
}

/** Scout: a Dust Rally buggy in your colours with a mini-gun turret on the roll cage. */
export class ScoutView implements UnitView {
  readonly root: THREE.Group;
  private car: CarModel;
  private turret = new THREE.Group();
  private gun = new THREE.Group();
  private geos: THREE.BufferGeometry[] = [];
  private mats: THREE.Material[] = [];
  private spin = 0;

  constructor(l: Livery) {
    this.car = buildCar('buggy', { id: l.id, name: l.name, body: l.body, stripe: l.stripe, roof: l.dark });
    this.root = this.car.root;
    const mat = new THREE.MeshLambertMaterial({ color: l.dark, flatShading: true });
    const acc = new THREE.MeshLambertMaterial({ color: l.stripe, flatShading: true });
    this.mats.push(mat, acc);
    const g = (geo: THREE.BufferGeometry, m: THREE.Material) => {
      this.geos.push(geo);
      return new THREE.Mesh(geo, m);
    };
    this.turret.position.set(0, 1.55, -0.2);
    this.turret.add(g(new THREE.CylinderGeometry(0.42, 0.5, 0.35, 8), mat), g(new THREE.BoxGeometry(0.5, 0.3, 0.5).translate(0, 0.3, 0), acc));
    this.gun.position.set(0, 0.3, 0.2);
    for (const x of [-0.12, 0.12]) this.gun.add(g(new THREE.CylinderGeometry(0.06, 0.06, 1.2, 6).rotateX(Math.PI / 2).translate(x, 0, 0.6), mat));
    this.turret.add(this.gun);
    this.car.body.add(this.turret);
  }

  update(u: Unit, alpha: number, dt: number): void {
    const h = lerpAngle(u.pHeading, u.heading, alpha);
    pose(this.root, lerp(u.px, u.x, alpha), lerp(u.py, u.y, alpha), lerp(u.pz, u.z, alpha), h, u);
    const s = u as Scout;
    const w = this.car.wheels;
    for (let i = 0; i < w.length; i++) {
      w[i].rotation.x += (u.drive * 24 * dt) / Math.max(0.2, this.car.wheelRadius);
      if (i < 2) w[i].rotation.y = -(s.steerAngle ?? 0) * 0.5;
    }
    // body roll in turns
    this.car.body.rotation.z += (clamp(-u.yawRate * u.drive * 0.12, -0.12, 0.12) - this.car.body.rotation.z) * Math.min(1, dt * 8);
    this.turret.rotation.y = lerpAngle(u.pTurret, u.turret, alpha) - h;
    if (u.fired) this.spin += 1.2;
    this.gun.rotation.z = this.spin;
  }

  dispose(): void {
    disposeCar(this.car);
    this.root.removeFromParent();
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
  }
}

export function makeUnitView(kind: UnitKind, l: Livery): UnitView {
  return kind === 'mech' ? new MechView(l) : kind === 'scout' ? new ScoutView(l) : new TankView(l);
}
