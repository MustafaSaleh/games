import * as THREE from 'three';
import { HANDLING as H } from '../config/handling';
import { propGeometry } from '../render/models';
import { ColliderHits, rockKey, type Chunk, type Terrain } from './terrain';

/**
 * Loose rocks. Small and medium rocks are part of the static scenery until a car touches
 * one; then it is lifted out of the chunk (instance hidden, collider disabled) and becomes
 * a live body here: knocked away with an equal-and-opposite impulse (by mass), it bounces,
 * rolls, tumbles off trees and settles. Big boulders stay solid (terrain LOOSE_ROCK_MAX).
 */
export const ROCK_PHYS = {
  carMass: 1100,
  gravity: 20,
  restitution: 0.3, // car <-> rock
  groundBounce: 0.3,
  rollFriction: 0.9, // 1/s on the ground
  airDrag: 0.15,
  maxBodies: 60,
};

/** something that can push rocks: a car (mass 0 = kinematic, e.g. an online player) */
export interface Pusher {
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
  heading: number;
  /** car mass; 0 = can't be pushed back (other player's car) */
  mass: number;
  /** filled in: strongest rock hit this step (m/s) for sound / shake */
  hit?: number;
  /** apply the reaction impulse (dv) to the car */
  push?: (dvx: number, dvz: number) => void;
}

interface Body {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  s: number; // instance scale
  r: number; // horizontal radius
  mass: number;
  q: THREE.Quaternion;
  spinAxis: THREE.Vector3;
  spin: number; // rad/s while airborne
  ground: boolean;
  still: number; // seconds at rest
  color: THREE.Color;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();

export class LooseRocks {
  readonly mesh: THREE.InstancedMesh;
  private bodies: Body[] = [];
  private hits = new ColliderHits();
  /** strongest impact of the last step on any pusher (for effects) */
  lastHit = { x: 0, y: 0, z: 0, speed: 0 };

  constructor(material: THREE.Material) {
    this.mesh = new THREE.InstancedMesh(propGeometry('rock'), material, ROCK_PHYS.maxBodies);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(ROCK_PHYS.maxBodies * 3), 3);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
  }

  get count(): number {
    return this.bodies.length;
  }

  clear(): void {
    this.bodies.length = 0;
    this.mesh.count = 0;
  }

  /** wake any loose rock a pusher's two collision circles touch */
  wake(p: Pusher, terrain: Terrain, knocked: Set<number>): void {
    const fx = Math.sin(p.heading),
      fz = Math.cos(p.heading);
    for (let c = -1; c <= 1; c += 2) {
      const cx = p.x + fx * H.colliderOffset * c,
        cz = p.z + fz * H.colliderOffset * c;
      const hits = terrain.queryColliders(cx, cz, H.colliderRadius, this.hits);
      for (let i = 0; i < hits.count; i++) {
        if (!hits.loose[i] || p.y > hits.top[i] - 0.2) continue;
        const dx = hits.x[i] - cx,
          dz = hits.z[i] - cz;
        const minD = hits.r[i] + H.colliderRadius;
        if (dx * dx + dz * dz >= minD * minD) continue;
        const chunk = hits.chunk[i];
        if (chunk) this.lift(chunk, hits.idx[i], knocked, terrain);
      }
    }
  }

  /** take a rock out of the static scenery and make it a body (it is hit right after) */
  private lift(chunk: Chunk, ci: number, knocked: Set<number>, terrain: Terrain): void {
    const pi = chunk.colProp[ci];
    if (pi < 0) return;
    const b = chunk.props.rock;
    const o = pi * 16;
    const m = b.mat;
    const x = m[o + 12],
      y = m[o + 13],
      z = m[o + 14];
    const s = m[o + 5];
    const rot = Math.atan2(m[o + 8], m[o]);
    const color = new THREE.Color(b.col[pi * 3], b.col[pi * 3 + 1], b.col[pi * 3 + 2]);
    // hide the static one for good
    m.fill(0, o, o + 16);
    chunk.colProp[ci] = -1;
    chunk.colR[ci] = 0;
    knocked.add(rockKey(x, z));
    terrain.version++; // instanced props get rebuilt without it
    if (this.bodies.length >= ROCK_PHYS.maxBodies) this.bodies.shift();
    this.bodies.push({
      x,
      y,
      z,
      vx: 0,
      vy: 0,
      vz: 0,
      s,
      r: 0.95 * s,
      mass: 30 + 160 * s * s * s, // arcade-light: ~190 kg for a 1 m rock
      q: new THREE.Quaternion().setFromAxisAngle(_v.set(0, 1, 0), rot),
      spinAxis: new THREE.Vector3(1, 0, 0),
      spin: 0,
      ground: true,
      still: 0,
      color,
    });
  }

  step(dt: number, terrain: Terrain, pushers: readonly Pusher[]): void {
    const P = ROCK_PHYS;
    this.lastHit.speed = 0;
    for (const p of pushers) p.hit = 0;
    for (const b of this.bodies) {
      // ---- cars ----
      for (const p of pushers) {
        if (p.y > b.y + 0.8 * b.s + 0.3) continue; // flying over it
        const fx = Math.sin(p.heading),
          fz = Math.cos(p.heading);
        for (let c = -1; c <= 1; c += 2) {
          const cx = p.x + fx * H.colliderOffset * c,
            cz = p.z + fz * H.colliderOffset * c;
          let dx = b.x - cx,
            dz = b.z - cz;
          const minD = b.r + H.colliderRadius;
          const d2 = dx * dx + dz * dz;
          if (d2 >= minD * minD) continue;
          const d = Math.sqrt(d2) || 1e-3;
          dx /= d;
          dz /= d;
          // the rock moves out of the way
          b.x += dx * (minD - d);
          b.z += dz * (minD - d);
          const vn = (b.vx - p.vx) * dx + (b.vz - p.vz) * dz;
          if (vn >= 0) continue;
          // impulse by masses (a kinematic car acts like an infinite mass)
          const inv = 1 / b.mass + (p.mass > 0 ? 1 / p.mass : 0);
          const j = (-(1 + P.restitution) * vn) / inv;
          // knocked slightly sideways so it leaves the car's path instead of being bulldozed
          const side = (dx * Math.cos(p.heading) - dz * Math.sin(p.heading) >= 0 ? 1 : -1) * 0.35;
          const kx = dx + -dz * side,
            kz = dz + dx * side;
          const kl = Math.hypot(kx, kz);
          b.vx += ((j / b.mass) * kx) / kl;
          b.vz += ((j / b.mass) * kz) / kl;
          const dv = j / b.mass;
          b.vy = Math.max(b.vy, Math.min(8, 1.5 + dv * 0.32)); // knocked up into the air
          b.ground = false;
          b.still = 0;
          b.spinAxis.set(dz, 0, -dx).normalize();
          b.spin = dv / Math.max(0.3, b.r);
          if (p.mass > 0 && p.push) p.push((-j / p.mass) * dx, (-j / p.mass) * dz);
          const hit = -vn;
          if (hit > (p.hit ?? 0)) p.hit = hit;
          if (hit > this.lastHit.speed) Object.assign(this.lastHit, { x: b.x, y: b.y + 0.5, z: b.z, speed: hit });
        }
      }
      if (b.still > 1.5) continue; // asleep until something hits it

      // ---- motion ----
      b.vy -= P.gravity * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.z += b.vz * dt;
      const rest = terrain.heightAt(b.x, b.z) - 0.15 * b.s;
      if (b.y <= rest) {
        b.y = rest;
        if (b.vy < -2.5) b.vy = -b.vy * P.groundBounce;
        else b.vy = 0;
        b.ground = b.vy === 0;
        const k = Math.exp(-P.rollFriction * dt);
        b.vx *= k;
        b.vz *= k;
      } else {
        b.ground = false;
        const k = Math.exp(-P.airDrag * dt);
        b.vx *= k;
        b.vz *= k;
      }
      // ---- solid props (trees, big boulders, buildings) ----
      const hits = terrain.queryColliders(b.x, b.z, b.r, this.hits);
      for (let i = 0; i < hits.count; i++) {
        if (hits.loose[i] || hits.r[i] <= 0 || b.y > hits.top[i]) continue;
        let dx = b.x - hits.x[i],
          dz = b.z - hits.z[i];
        const minD = b.r + hits.r[i];
        const d2 = dx * dx + dz * dz;
        if (d2 >= minD * minD || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        dx /= d;
        dz /= d;
        b.x += dx * (minD - d);
        b.z += dz * (minD - d);
        const vn = b.vx * dx + b.vz * dz;
        if (vn < 0) {
          b.vx -= 1.4 * vn * dx;
          b.vz -= 1.4 * vn * dz;
        }
      }
      // ---- rotation: roll on the ground, tumble in the air ----
      const sp = Math.hypot(b.vx, b.vz);
      if (b.ground) {
        if (sp > 0.05) {
          b.spinAxis.set(b.vz, 0, -b.vx).normalize();
          b.spin = sp / Math.max(0.3, b.r * 0.8);
        } else b.spin = 0;
      }
      if (b.spin > 0) b.q.premultiply(_q.setFromAxisAngle(b.spinAxis, b.spin * dt));
      b.still = b.ground && sp < 0.25 ? b.still + dt : 0;
    }
  }

  /** forget rocks far from every car; write instance matrices */
  sync(focus: readonly { x: number; z: number }[], keepRadius: number): void {
    const keep2 = keepRadius * keepRadius;
    this.bodies = this.bodies.filter((b) => focus.some((f) => (b.x - f.x) ** 2 + (b.z - f.z) ** 2 < keep2));
    const n = this.bodies.length;
    for (let i = 0; i < n; i++) {
      const b = this.bodies[i];
      _m.compose(_v.set(b.x, b.y, b.z), b.q, _s.setScalar(b.s));
      this.mesh.setMatrixAt(i, _m);
      this.mesh.setColorAt(i, b.color);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
