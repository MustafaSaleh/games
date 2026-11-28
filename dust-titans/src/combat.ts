import * as THREE from 'three';
import { ColliderHits } from '@engine/world/terrain';
import type { Ground } from './units/tank';

/** Combat tuning (kid-friendly: energy shells, sparks, robots falling apart). */
export const COMBAT = {
  shellDamage: 40,
  shellSplash: 4.5, // m
  shellGravity: 6,
  shellLife: 2.4,
  orbDamage: 6,
  orbSpeed: 22,
  orbLife: 4,
  orbRadius: 0.5,
};

export type Team = 'player' | 'enemy';

/** something that can be hit */
export interface Target {
  id: string;
  team: Team;
  x: number;
  y: number; // centre height
  z: number;
  r: number;
  alive: boolean;
}

interface Shot {
  team: Team;
  kind: 'shell' | 'orb';
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
}

export interface Impact {
  x: number;
  y: number;
  z: number;
  team: Team;
  kind: 'shell' | 'orb';
  /** the target hit directly, if any */
  target: Target | null;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _v = new THREE.Vector3();

/** Cannon shells (player) and glowing orbs (drones): flight, hits, rendering. */
export class Projectiles {
  readonly group = new THREE.Group();
  private shots: Shot[] = [];
  private hits = new ColliderHits();
  private shellMesh: THREE.InstancedMesh;
  private orbMesh: THREE.InstancedMesh;

  constructor() {
    this.shellMesh = new THREE.InstancedMesh(
      new THREE.CapsuleGeometry(0.22, 1.1, 2, 6).rotateX(Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
      64,
    );
    this.orbMesh = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(COMBAT.orbRadius, 1),
      new THREE.MeshBasicMaterial({ color: 0xff4fd8, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
      96,
    );
    for (const m of [this.shellMesh, this.orbMesh]) {
      m.count = 0;
      m.frustumCulled = false;
      m.renderOrder = 6;
      this.group.add(m);
    }
  }

  get count(): number {
    return this.shots.length;
  }

  clear(): void {
    this.shots.length = 0;
  }

  fire(team: Team, kind: 'shell' | 'orb', x: number, y: number, z: number, vx: number, vy: number, vz: number): void {
    this.shots.push({ team, kind, x, y, z, vx, vy, vz, life: kind === 'shell' ? COMBAT.shellLife : COMBAT.orbLife });
  }

  /** move everything; collisions with the ground, solid props and targets of the other team */
  step(dt: number, ground: Ground, targets: readonly Target[], out: Impact[]): void {
    out.length = 0;
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i];
      s.life -= dt;
      if (s.kind === 'shell') s.vy -= COMBAT.shellGravity * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.z += s.vz * dt;
      let hit: Impact | null = null;
      const rad = s.kind === 'orb' ? COMBAT.orbRadius : 0.3;
      for (const t of targets) {
        if (!t.alive || t.team === s.team) continue;
        const dx = s.x - t.x,
          dy = s.y - t.y,
          dz = s.z - t.z;
        const rr = t.r + rad;
        if (dx * dx + dy * dy + dz * dz < rr * rr) {
          hit = { x: s.x, y: s.y, z: s.z, team: s.team, kind: s.kind, target: t };
          break;
        }
      }
      if (!hit) {
        const gy = ground.heightAt(s.x, s.z);
        if (s.y < gy + 0.1) hit = { x: s.x, y: gy + 0.2, z: s.z, team: s.team, kind: s.kind, target: null };
        else {
          const h = ground.queryColliders(s.x, s.z, rad, this.hits);
          for (let k = 0; k < h.count; k++) {
            if (h.loose[k] || s.y > h.top[k]) continue;
            const dx = s.x - h.x[k],
              dz = s.z - h.z[k];
            if (dx * dx + dz * dz < (h.r[k] + rad) ** 2) {
              hit = { x: s.x, y: s.y, z: s.z, team: s.team, kind: s.kind, target: null };
              break;
            }
          }
        }
      }
      if (hit) out.push(hit);
      if (hit || s.life <= 0) this.shots.splice(i, 1);
    }
  }

  sync(time: number): void {
    let ns = 0,
      no = 0;
    for (const s of this.shots) {
      if (s.kind === 'shell') {
        if (ns >= 64) continue;
        _v.set(s.vx, s.vy, s.vz).normalize();
        _q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), _v);
        _m.compose(_s.set(s.x, s.y, s.z), _q, new THREE.Vector3(1, 1, 1));
        this.shellMesh.setMatrixAt(ns++, _m);
      } else {
        if (no >= 96) continue;
        const pulse = 1 + 0.18 * Math.sin(time * 18 + s.x);
        _m.makeScale(pulse, pulse, pulse).setPosition(s.x, s.y, s.z);
        this.orbMesh.setMatrixAt(no++, _m);
      }
    }
    this.shellMesh.count = ns;
    this.orbMesh.count = no;
    this.shellMesh.instanceMatrix.needsUpdate = true;
    this.orbMesh.instanceMatrix.needsUpdate = true;
  }
}

/** Broken robot parts: tumbling boxes that bounce and fade. */
export class Debris {
  readonly mesh: THREE.InstancedMesh;
  private parts: { x: number; y: number; z: number; vx: number; vy: number; vz: number; q: THREE.Quaternion; ax: THREE.Vector3; spin: number; life: number; s: number }[] = [];

  constructor() {
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: 0x3a3f4a, flatShading: true }), 120);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
  }

  clear(): void {
    this.parts.length = 0;
  }

  burst(x: number, y: number, z: number, n: number, size: number): void {
    for (let i = 0; i < n; i++) {
      if (this.parts.length >= 120) this.parts.shift();
      const a = Math.random() * Math.PI * 2,
        v = 3 + Math.random() * 6;
      this.parts.push({
        x,
        y,
        z,
        vx: Math.cos(a) * v,
        vy: 4 + Math.random() * 6,
        vz: Math.sin(a) * v,
        q: new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.random() * 6, Math.random() * 6, 0)),
        ax: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(),
        spin: 4 + Math.random() * 8,
        life: 3 + Math.random() * 2,
        s: size * (0.4 + Math.random() * 0.6),
      });
    }
  }

  step(dt: number, ground: Ground): void {
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      p.life -= dt;
      p.vy -= 18 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      const gy = ground.heightAt(p.x, p.z) + p.s * 0.3;
      if (p.y < gy) {
        p.y = gy;
        p.vy = Math.abs(p.vy) * 0.3;
        p.vx *= 0.6;
        p.vz *= 0.6;
        p.spin *= 0.5;
      }
      p.q.premultiply(_q.setFromAxisAngle(p.ax, p.spin * dt));
      if (p.life <= 0) this.parts.splice(i, 1);
    }
    let n = 0;
    for (const p of this.parts) {
      const sc = p.s * Math.min(1, p.life / 0.6);
      _m.compose(_v.set(p.x, p.y, p.z), p.q, _s.set(sc, sc * 0.6, sc));
      this.mesh.setMatrixAt(n++, _m);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** Repair kits dropped by destroyed robots. */
export class Pickups {
  readonly group = new THREE.Group();
  private items: { x: number; y: number; z: number; mesh: THREE.Group; life: number }[] = [];
  private box = new THREE.BoxGeometry(1.1, 1.1, 1.1);
  private crossA = new THREE.BoxGeometry(0.75, 0.22, 1.14);
  private crossB = new THREE.BoxGeometry(0.22, 0.75, 1.14);
  private boxMat = new THREE.MeshLambertMaterial({ color: 0x35c46a, emissive: 0x0b4a22 });
  private crossMat = new THREE.MeshBasicMaterial({ color: 0xffffff });

  clear(): void {
    for (const it of this.items) this.group.remove(it.mesh);
    this.items.length = 0;
  }

  drop(x: number, y: number, z: number): void {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(this.box, this.boxMat));
    for (const r of [0, Math.PI / 2]) {
      const a = new THREE.Mesh(this.crossA, this.crossMat),
        b = new THREE.Mesh(this.crossB, this.crossMat);
      a.rotation.y = b.rotation.y = r;
      g.add(a, b);
    }
    g.position.set(x, y, z);
    this.group.add(g);
    this.items.push({ x, y, z, mesh: g, life: 25 });
  }

  /** returns how many kits the collector (at x,z) picked up */
  step(dt: number, time: number, ground: Ground, cx: number, cz: number, reach: number): number {
    let got = 0;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.life -= dt;
      const gy = ground.heightAt(it.x, it.z);
      it.y = Math.max(gy + 1.1, it.y - 8 * dt);
      it.mesh.position.set(it.x, it.y + Math.sin(time * 3 + it.x) * 0.2, it.z);
      it.mesh.rotation.y += dt * 1.5;
      it.mesh.visible = it.life > 3 || Math.sin(time * 20) > 0;
      if ((it.x - cx) ** 2 + (it.z - cz) ** 2 < reach * reach) {
        got++;
        it.life = 0;
      }
      if (it.life <= 0) {
        this.group.remove(it.mesh);
        this.items.splice(i, 1);
      }
    }
    return got;
  }
}
