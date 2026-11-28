import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, lerp, lerpAngle } from '@engine/core/math';
import type { Mech } from './mech';
import type { Scout } from './scout';
import { WARBOT, type Warbot } from './warbot';
import { loadWarbotModel, makeWarbotRig, type WarbotRig } from './warbotModel';
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
  return kind === 'mech' ? new MechView(l) : kind === 'scout' ? new ScoutView(l) : kind === 'warbot' ? new WarbotView(l) : new TankView(l);
}

/* ------------------------------------------------------------------ */
/* Warbot model                                                         */
/* ------------------------------------------------------------------ */

/** mix two colours: weathered olive armour tinted toward the livery */
function mixHex(a: number, b: number, t: number): number {
  return new THREE.Color(a).lerp(new THREE.Color(b), t).getHex();
}

/** a number painted on a shoulder plate */
function decal(text: string, color: string): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 64;
  const g = c.getContext('2d');
  if (!g) return null;
  g.fillStyle = color;
  g.font = 'bold 50px Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 64, 34);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const RIGID = ['RightForeArm', 'RightHand', 'LeftHand'];
/** forearm tilt that makes the gatling barrels level (y per 1 m forward) */
const GUN_PITCH = -0.47;
/** Warbot model timing: the moment the slam clip hits the ground (s), the unit's wind-up, and
 *  how long the slam pose holds after the hit; walk / run clip speeds at timeScale 1 (m/s) */
const SLAM_IMPACT = 1.72;
const WARBOT_WINDUP = WARBOT.slamWindup;
const SLAM_HOLD = 0.7;
const WALK_SPEED = 4.3;
const RUN_SPEED = 7.5;

/**
 * Warbot: a heavy armoured war walker — boxy chest with vents, numbered shoulder plates,
 * a small head with a blue visor, a 6-barrel gatling with ammo drum, belt and missile pod
 * on the right arm and a blaster forearm with a big fist on the left.
 */
export class WarbotView implements UnitView {
  readonly root = new THREE.Group();
  private pelvis = new THREE.Group();
  private torso = new THREE.Group();
  private gun = new THREE.Group();
  private barrels = new THREE.Group();
  private arm = new THREE.Group();
  private legs: Leg[] = [];
  private geos: THREE.BufferGeometry[] = [];
  private mats: THREE.Material[] = [];
  private tex: THREE.Texture[] = [];
  private lean = 0;
  private crouch = 0;
  private spinA = 0;
  private spinV = 0;
  /** the Meshy model once loaded (the built-in model shows until then, or if it fails) */
  private rig: WarbotRig | null = null;
  private acts: Record<'idle' | 'walk' | 'run' | 'slam', THREE.AnimationAction | null> = { idle: null, walk: null, run: null, slam: null };
  private slamClock = -1;
  private gunHold = 0;
  private wasDashing = false;
  private dead = false;

  constructor(l: Livery) {
    void loadWarbotModel().then((g) => {
      if (!g || this.dead) return;
      const rig = makeWarbotRig(g, l.body, 0.14);
      this.rig = rig;
      const act = (name: string, once = false) => {
        const c = rig.clips.get(name);
        if (!c) return null;
        const a = rig.mixer.clipAction(c);
        if (once) {
          a.setLoop(THREE.LoopOnce, 1);
          a.clampWhenFinished = true;
        } else a.play();
        a.setEffectiveWeight(0);
        return a;
      };
      this.acts = { idle: act('Idle_02'), walk: act('Walking'), run: act('Running'), slam: act('Charged_Ground_Slam', true) };
      this.pelvis.visible = false;
      this.root.add(rig.root);
    });
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    const glowMat = new THREE.MeshBasicMaterial({ color: 0x5fd0ff });
    this.mats.push(mat, glowMat);
    const mesh = (parts: THREE.BufferGeometry[], m: THREE.Material = mat) => {
      const g = mergeGeometries(parts, false)!;
      g.computeVertexNormals();
      this.geos.push(g);
      return new THREE.Mesh(g, m);
    };
    const glow = (geo: THREE.BufferGeometry) => mesh([colored(geo, 0xffffff)], glowMat);
    const armor = mixHex(0x5f6540, l.body, 0.3);
    const armor2 = mixHex(0x4a4f33, l.body, 0.22);
    const rust = 0x8a5a2b;
    const steel = 0x4b5052;
    const brass = 0xc79a3a;
    const stripe = l.stripe;
    const cyl = (rt: number, rb: number, h: number, seg = 8) => new THREE.CylinderGeometry(rt, rb, h, seg);

    // ---- legs: chunky thighs, knee pads, big feet ----
    this.pelvis.position.y = 3.0;
    this.root.add(this.pelvis);
    this.pelvis.add(
      mesh([
        colored(box(2.3, 0.75, 1.35, 0, 0, 0), steel),
        colored(box(1.3, 0.7, 0.22, 0, -0.15, 0.75), armor), // front skirt
        colored(box(1.32, 0.1, 0.24, 0, 0.18, 0.76), rust),
        colored(box(1.0, 0.6, 0.22, 0, -0.1, -0.75), armor2),
      ]),
    );
    for (const s of [1, -1]) {
      const hip = new THREE.Group();
      hip.position.set(s * 1.05, -0.1, 0);
      hip.add(
        mesh([
          colored(cyl(0.45, 0.45, 0.9, 10).rotateZ(Math.PI / 2), steel),
          colored(box(0.95, 1.55, 1.05, s * 0.05, -0.75, 0), armor),
          colored(box(1.0, 0.5, 0.2, s * 0.05, -0.55, 0.56), armor2), // thigh plate
          colored(box(0.2, 0.9, 0.7, s * 0.55, -0.7, 0), rust),
        ]),
      );
      const knee = new THREE.Group();
      knee.position.y = -1.5;
      knee.add(
        mesh([
          colored(new THREE.SphereGeometry(0.42, 8, 6), steel),
          colored(box(0.85, 0.75, 0.4, 0, -0.05, 0.5), rust), // knee pad
          colored(box(0.9, 1.35, 1.0, 0, -0.75, 0), armor),
          colored(box(0.92, 0.55, 0.18, 0, -0.75, 0.55), armor2), // shin plate
          colored(cyl(0.12, 0.12, 1.1, 6).translate(0, -0.7, -0.6), steel), // calf piston
          colored(box(1.25, 0.38, 1.95, 0, -1.33, 0.3), steel), // foot
          colored(box(1.28, 0.3, 0.45, 0, -1.3, 1.2), rust), // toe
          colored(box(0.9, 0.3, 0.4, 0, -1.3, -0.75), armor2), // heel
        ]),
      );
      hip.add(knee);
      this.pelvis.add(hip);
      this.legs.push({ hip, knee });
    }

    // ---- torso (turns to aim) ----
    this.pelvis.add(this.torso);
    const chest: THREE.BufferGeometry[] = [
      colored(box(1.7, 0.7, 1.3, 0, 0.6, 0), steel), // waist
      colored(box(3.0, 1.8, 2.1, 0, 1.75, -0.05), armor),
      colored(box(2.1, 1.0, 0.35, 0, 1.95, 1.08), armor2), // chest plate
      colored(box(2.12, 0.12, 0.37, 0, 2.48, 1.09), rust),
      colored(box(1.2, 0.5, 0.3, 0, 1.15, 1.0), armor2), // belly plate
      colored(box(0.4, 0.1, 0.1, 0, 2.0, 1.28), stripe), // chest badge
      colored(box(2.0, 1.4, 0.8, 0, 1.75, -1.4), steel), // backpack
      colored(cyl(0.22, 0.26, 0.9).translate(0.6, 2.7, -1.5), steel), // exhausts
      colored(cyl(0.22, 0.26, 0.9).translate(-0.6, 2.7, -1.5), steel),
      // head: small, set low between the shoulders
      colored(box(0.95, 0.62, 0.85, 0, 2.95, 0.45), armor),
      colored(box(1.0, 0.16, 0.9, 0, 3.3, 0.45), armor2),
      colored(box(0.35, 0.4, 0.35, 0.62, 3.05, 0.35), steel), // side sensor
      colored(cyl(0.03, 0.03, 0.7, 4).translate(-0.3, 3.6, 0.2), steel), // antenna
    ];
    // vents on the chest sides
    for (const s of [1, -1]) for (let i = 0; i < 4; i++) chest.push(colored(box(0.08, 0.1, 1.1, s * 1.52, 1.35 + i * 0.22, 0.1), steel));
    this.torso.add(mesh(chest));
    this.torso.add(
      glow(box(0.62, 0.13, 0.08, 0, 3.0, 0.89)), // visor
    );
    this.torso.add(glow(new THREE.CircleGeometry(0.1, 8).translate(0.62, 3.05, 0.53)));

    // ---- shoulder plates with a painted number ----
    const num = decal('08', '#f3efe2');
    if (num) this.tex.push(num);
    const numMat = num ? new THREE.MeshBasicMaterial({ map: num, transparent: true, depthWrite: false }) : null;
    if (numMat) this.mats.push(numMat);
    for (const s of [1, -1]) {
      const p = new THREE.Group();
      p.position.set(s * 1.95, 2.75, 0);
      p.rotation.z = -s * 0.22;
      p.add(
        mesh([
          colored(box(1.5, 0.95, 1.75, 0, 0, 0), armor),
          colored(box(1.52, 0.14, 1.77, 0, -0.42, 0), rust),
          colored(box(0.1, 0.5, 1.2, s * 0.76, 0.05, 0), armor2),
        ]),
      );
      if (numMat) {
        const g = new THREE.PlaneGeometry(1.1, 0.55);
        this.geos.push(g);
        const d = new THREE.Mesh(g, numMat);
        d.position.set(s * 0.82, 0.05, 0);
        d.rotation.y = (s * Math.PI) / 2;
        p.add(d);
      }
      this.torso.add(p);
    }

    // ---- right arm: gatling (aims with the torso) ----
    this.gun.position.set(-2.0, 1.2, 0.2);
    this.gun.add(
      mesh([
        colored(box(0.75, 1.0, 0.75, 0, 0.45, -0.1), steel), // upper arm
        colored(box(1.0, 0.95, 1.8, 0, 0, 0.7), armor), // gun housing
        colored(box(1.02, 0.12, 1.82, 0, 0.42, 0.7), rust),
        colored(cyl(0.48, 0.48, 0.5, 12).rotateZ(Math.PI / 2).translate(-0.15, -0.75, 0.35), steel), // ammo drum
        colored(new THREE.TorusGeometry(0.42, 0.09, 4, 10, Math.PI).rotateY(Math.PI / 2).translate(0, -0.5, 1.0), brass), // belt
        colored(box(0.75, 0.5, 0.85, 0, 0.75, 0.75), armor2), // missile pod
        colored(cyl(0.11, 0.11, 0.1, 6).rotateX(Math.PI / 2).translate(-0.18, 0.86, 1.2), 0xd23a2a),
        colored(cyl(0.11, 0.11, 0.1, 6).rotateX(Math.PI / 2).translate(0.18, 0.86, 1.2), 0xd23a2a),
        colored(cyl(0.11, 0.11, 0.1, 6).rotateX(Math.PI / 2).translate(-0.18, 0.64, 1.2), 0xd23a2a),
        colored(cyl(0.11, 0.11, 0.1, 6).rotateX(Math.PI / 2).translate(0.18, 0.64, 1.2), 0xd23a2a),
        colored(cyl(0.13, 0.13, 1.2, 8).rotateX(Math.PI / 2).translate(0, -0.6, 2.0), 0x6b6a5a), // slung missile
        colored(new THREE.ConeGeometry(0.13, 0.35, 8).rotateX(Math.PI / 2).translate(0, -0.6, 2.77), 0xc8302a),
      ]),
    );
    // six spinning barrels
    this.barrels.position.set(0, 0, 1.6);
    const bp: THREE.BufferGeometry[] = [colored(cyl(0.36, 0.36, 0.2, 10).rotateX(Math.PI / 2).translate(0, 0, 0.1), steel), colored(cyl(0.34, 0.34, 0.16, 10).rotateX(Math.PI / 2).translate(0, 0, 1.45), steel)];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      bp.push(colored(cyl(0.075, 0.075, 1.7, 6).rotateX(Math.PI / 2).translate(Math.cos(a) * 0.22, Math.sin(a) * 0.22, 0.85), 0x2a2c2e));
    }
    bp.push(colored(cyl(0.09, 0.09, 1.7, 6).rotateX(Math.PI / 2).translate(0, 0, 0.85), steel));
    this.barrels.add(mesh(bp));
    this.gun.add(this.barrels);
    this.torso.add(this.gun);

    // ---- left arm: blaster forearm and a big fist ----
    this.arm.position.set(2.0, 2.2, 0.1);
    this.arm.add(
      mesh([
        colored(cyl(0.32, 0.32, 1.2, 8).translate(0, -0.55, 0), steel), // upper arm
        colored(new THREE.SphereGeometry(0.38, 8, 6).translate(0, -1.15, 0), steel), // elbow
        colored(box(0.85, 1.35, 0.85, 0, -1.85, 0.05), armor), // forearm
        colored(box(0.87, 0.12, 0.87, 0, -1.4, 0.05), rust),
        colored(cyl(0.15, 0.15, 1.3, 8).translate(0.5, -1.85, 0.2), steel), // blaster tubes
        colored(cyl(0.12, 0.12, 1.1, 8).translate(0.5, -1.85, -0.15), steel),
        colored(box(0.95, 0.75, 0.9, 0, -2.85, 0.1), steel), // fist
        colored(box(0.2, 0.3, 0.92, -0.3, -3.3, 0.1), steel), // fingers
        colored(box(0.2, 0.3, 0.92, 0, -3.3, 0.1), steel),
        colored(box(0.2, 0.3, 0.92, 0.3, -3.3, 0.1), steel),
      ]),
    );
    this.arm.add(glow(cyl(0.1, 0.1, 0.12, 8).translate(0.5, -2.55, 0.2)));
    this.arm.add(glow(cyl(0.08, 0.08, 0.12, 8).translate(0.5, -2.45, -0.15)));
    this.torso.add(this.arm);
  }

  update(u: Unit, alpha: number, dt: number): void {
    const w = u as Warbot;
    const h = lerpAngle(u.pHeading, u.heading, alpha);
    pose(this.root, lerp(u.px, u.x, alpha), lerp(u.py, u.y, alpha), lerp(u.pz, u.z, alpha), h, u);
    if (this.rig) return this.animate(u, lerpAngle(u.pTurret, u.turret, alpha) - h, dt);

    // heavy stride: one step every 4.4 m
    const ph = (w.stride / 4.4) * Math.PI * 2;
    const a = clamp(u.drive, 0, 1) * 0.5;
    for (let i = 0; i < 2; i++) {
      const leg = this.legs[i];
      const p = ph + i * Math.PI;
      let hip = -Math.sin(p) * a,
        knee = Math.max(0, Math.cos(p)) * a * 1.4;
      if (this.crouch > 0.01) {
        hip -= this.crouch * 0.55;
        knee += this.crouch * 1.0;
      }
      leg.hip.rotation.x += (hip - leg.hip.rotation.x) * Math.min(1, dt * 12);
      leg.knee.rotation.x += (knee - leg.knee.rotation.x) * Math.min(1, dt * 12);
    }
    // slam: crouch and raise the fist while winding up, then smash down
    const crouchT = u.dashing ? 1 : 0;
    this.crouch += (crouchT - this.crouch) * Math.min(1, dt * (u.dashing ? 6 : 18));
    this.pelvis.position.y = 3.0 - Math.abs(Math.cos(ph)) * 0.2 * (a / 0.5) - this.crouch * 0.7;
    this.lean += (u.drive * 0.08 + this.crouch * 0.25 - this.lean) * Math.min(1, dt * 8);
    this.pelvis.rotation.x = this.lean;
    this.pelvis.rotation.z = Math.sin(ph) * 0.05 * (a / 0.5); // sway side to side

    this.torso.rotation.y = lerpAngle(u.pTurret, u.turret, alpha) - h;
    this.arm.rotation.x = u.dashing ? -2.4 * this.crouch : Math.sin(ph) * a * 0.6;

    // gatling: barrels spin with the trigger; recoil on each shot
    const target = Math.max(w.spin ?? 0, u.fired ? 0.6 : 0);
    this.spinV += (target * 40 - this.spinV) * Math.min(1, dt * 4);
    this.spinA += this.spinV * dt;
    this.barrels.rotation.z = this.spinA;
    if (u.fired) this.gun.position.z = 0.05;
    this.gun.position.z += (0.2 - this.gun.position.z) * Math.min(1, dt * 20);
  }

  /** Meshy model: blend idle / walk / run by speed, play the slam, twist the upper body to aim */
  private animate(u: Unit, aim: number, dt: number): void {
    const { idle, walk, run, slam } = this.acts;
    const rig = this.rig!;
    const sp = u.alive ? u.speed : 0;
    // the slam clip: start it so its impact lands when the unit's wind-up ends
    if (u.dashing && !this.wasDashing && slam) {
      slam.reset().play();
      slam.time = Math.max(0, SLAM_IMPACT - WARBOT_WINDUP);
      this.slamClock = 0;
    }
    this.wasDashing = u.dashing;
    let slamW = 0;
    if (this.slamClock >= 0) {
      this.slamClock += dt;
      const fadeAt = WARBOT_WINDUP + SLAM_HOLD;
      slamW = this.slamClock < fadeAt ? Math.min(1, this.slamClock / 0.08) : Math.max(0, 1 - (this.slamClock - fadeAt) / 0.35);
      // walking away early: hand back to the legs sooner
      if (this.slamClock > WARBOT_WINDUP + 0.15 && sp > 2) slamW = Math.min(slamW, Math.max(0, 1 - (sp - 2) / 2));
      if (slamW <= 0 && this.slamClock > WARBOT_WINDUP) {
        this.slamClock = -1;
        slam?.stop();
      }
    }
    const move = clamp((sp - 0.3) / 1.5, 0, 1);
    const fast = clamp((sp - 4.5) / 3, 0, 1);
    const rest = 1 - slamW;
    idle?.setEffectiveWeight((1 - move) * rest);
    walk?.setEffectiveWeight(move * (1 - fast) * rest);
    run?.setEffectiveWeight(move * fast * rest);
    slam?.setEffectiveWeight(slamW);
    if (walk) walk.timeScale = clamp(sp / WALK_SPEED, 0.5, 1.8);
    if (run) run.timeScale = clamp(sp / RUN_SPEED, 0.6, 1.5);
    rig.mixer.update(dt);
    // the gatling and the fist are skinned over the elbow and wrist: bending those joints bends
    // the gun barrels, so keep them as modelled and move the arms only from the shoulders
    for (const name of RIGID) {
      const b = rig.bones.get(name);
      const q = b && rig.rest.get(b);
      if (b && q) b.quaternion.copy(q);
    }
    // hold the gatling level and pointing forward (the clips let it hang), except while slamming
    this.gunHold += ((slamW > 0.05 ? 0 : 1) - this.gunHold) * Math.min(1, dt * 10);
    const ua = rig.bones.get('RightArm'),
      fa = rig.bones.get('RightForeArm'),
      hand = rig.bones.get('RightHand');
    if (ua?.parent && fa && hand && this.gunHold > 0.01) {
      fa.getWorldPosition(_r);
      hand.getWorldPosition(_v);
      _v.sub(_r).normalize(); // forearm direction now
      _r.set(0, GUN_PITCH, 1).normalize().applyQuaternion(this.root.quaternion); // wanted: forward
      _q.setFromUnitVectors(_v, _r);
      _q2.identity().slerp(_q, this.gunHold);
      // world rotation -> the upper arm's parent space
      ua.parent.getWorldQuaternion(_q3);
      _q.copy(_q3).invert().multiply(_q2).multiply(_q3);
      ua.quaternion.premultiply(_q);
    }
    // twist the upper body toward the aim (split over the spine bones), around the body's up axis
    const a = Math.atan2(Math.sin(aim), Math.cos(aim)) * (1 - slamW * 0.7);
    _up.set(0, 1, 0).applyQuaternion(this.root.quaternion);
    for (const name of ['Spine', 'Spine1', 'Spine2']) {
      const b = rig.bones.get(name);
      if (!b?.parent) continue;
      b.parent.getWorldQuaternion(_q).invert();
      _f.copy(_up).applyQuaternion(_q).normalize();
      b.quaternion.premultiply(_q.setFromAxisAngle(_f, a / 3));
    }
  }

  dispose(): void {
    this.dead = true;
    this.root.removeFromParent();
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    for (const t of this.tex) t.dispose();
    if (this.rig) {
      this.rig.mixer.stopAllAction();
      for (const m of this.rig.materials) m.dispose();
    }
  }
}
