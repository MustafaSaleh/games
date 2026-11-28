import * as THREE from 'three';
import { ColliderHits } from '@engine/world/terrain';
import type { Ground } from './units/unit';

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

export type ShotKind = 'shell' | 'bolt' | 'orb' | 'laser' | 'plasma';

/** per-kind damage, blast radius, gravity, lifetime, hit radius, look */
export const SHOTS: Record<ShotKind, { damage: number; splash: number; gravity: number; life: number; radius: number; color: number; scale: number; round: boolean }> = {
  shell: { damage: COMBAT.shellDamage, splash: COMBAT.shellSplash, gravity: COMBAT.shellGravity, life: COMBAT.shellLife, radius: 0.3, color: 0xffd27a, scale: 1, round: false },
  bolt: { damage: 15, splash: 2.2, gravity: 1.5, life: 1.5, radius: 0.35, color: 0x8ff7ff, scale: 0.7, round: false },
  orb: { damage: COMBAT.orbDamage, splash: 0, gravity: 0, life: COMBAT.orbLife, radius: COMBAT.orbRadius, color: 0xff4fd8, scale: 1, round: true },
  laser: { damage: 5, splash: 0, gravity: 0, life: 2.6, radius: 0.35, color: 0xff3b3b, scale: 0.8, round: false },
  plasma: { damage: 9, splash: 3.5, gravity: 5, life: 4, radius: 0.9, color: 0xff8a2a, scale: 1.9, round: true },
};

/** 'player' (co-op), 'enemy', or a PvP side ('blue' / 'red' / a player id) */
export type Team = string;

/** something that can be hit */
export interface Target {
  id: string;
  team: Team;
  x: number;
  y: number; // centre height
  z: number;
  r: number;
  alive: boolean;
  /** armour plate: stops shots without taking damage (boss body) */
  armor?: boolean;
  /** who owns this hit sphere (enemy object or player slot) */
  owner?: unknown;
}

interface Shot {
  team: Team;
  kind: ShotKind;
  /** who fired it (player id for scores) */
  by: string;
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
  kind: ShotKind;
  by: string;
  /** the target hit directly, if any */
  target: Target | null;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _v = new THREE.Vector3();
const _c = new THREE.Color();
const Z = new THREE.Vector3(0, 0, 1);

/** Every projectile in the battle: flight, hits, rendering (two instanced meshes). */
export class Projectiles {
  readonly group = new THREE.Group();
  private shots: Shot[] = [];
  private hits = new ColliderHits();
  private longMesh: THREE.InstancedMesh;
  private roundMesh: THREE.InstancedMesh;
  /** friendly fire between these teams (PvP): 'player' shots never hurt 'player' */
  static hostile(a: Team, b: Team): boolean {
    return a !== b;
  }

  constructor() {
    const mat = () => new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    this.longMesh = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.22, 1.1, 2, 6).rotateX(Math.PI / 2), mat(), 160);
    this.roundMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.5, 1), mat(), 160);
    for (const m of [this.longMesh, this.roundMesh]) {
      m.count = 0;
      m.frustumCulled = false;
      m.renderOrder = 6;
      m.setColorAt(0, _c.set(0xffffff));
      this.group.add(m);
    }
  }

  get count(): number {
    return this.shots.length;
  }

  clear(): void {
    this.shots.length = 0;
  }

  fire(team: Team, kind: ShotKind, x: number, y: number, z: number, vx: number, vy: number, vz: number, by = ''): void {
    if (this.shots.length > 300) this.shots.shift();
    this.shots.push({ team, kind, by, x, y, z, vx, vy, vz, life: SHOTS[kind].life });
  }

  /** move everything; collisions with the ground, solid props and targets of other teams */
  step(dt: number, ground: Ground, targets: readonly Target[], out: Impact[]): void {
    out.length = 0;
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i];
      const cfg = SHOTS[s.kind];
      s.life -= dt;
      s.vy -= cfg.gravity * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.z += s.vz * dt;
      let hit: Impact | null = null;
      const rad = cfg.radius;
      for (const t of targets) {
        if (!t.alive || !Projectiles.hostile(s.team, t.team)) continue;
        const dx = s.x - t.x,
          dy = s.y - t.y,
          dz = s.z - t.z;
        const rr = t.r + rad;
        if (dx * dx + dy * dy + dz * dz < rr * rr) {
          hit = { x: s.x, y: s.y, z: s.z, team: s.team, kind: s.kind, by: s.by, target: t };
          break;
        }
      }
      if (!hit) {
        const gy = ground.heightAt(s.x, s.z);
        if (s.y < gy + 0.1) hit = { x: s.x, y: gy + 0.2, z: s.z, team: s.team, kind: s.kind, by: s.by, target: null };
        else {
          const h = ground.queryColliders(s.x, s.z, rad, this.hits);
          for (let k = 0; k < h.count; k++) {
            if (h.loose[k] || s.y > h.top[k]) continue;
            const dx = s.x - h.x[k],
              dz = s.z - h.z[k];
            if (dx * dx + dz * dz < (h.r[k] + rad) ** 2) {
              hit = { x: s.x, y: s.y, z: s.z, team: s.team, kind: s.kind, by: s.by, target: null };
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
    let nl = 0,
      nr = 0;
    for (const s of this.shots) {
      const cfg = SHOTS[s.kind];
      if (!cfg.round) {
        if (nl >= 160) continue;
        _v.set(s.vx, s.vy, s.vz).normalize();
        _q.setFromUnitVectors(Z, _v);
        _m.compose(_s.set(s.x, s.y, s.z), _q, _v.set(cfg.scale, cfg.scale, cfg.scale * (s.kind === 'laser' ? 1.6 : 1)));
        this.longMesh.setMatrixAt(nl, _m);
        this.longMesh.setColorAt(nl++, _c.set(cfg.color));
      } else {
        if (nr >= 160) continue;
        const pulse = cfg.scale * (1 + 0.18 * Math.sin(time * 18 + s.x)) * (cfg.radius / 0.5);
        _m.makeScale(pulse, pulse, pulse).setPosition(s.x, s.y, s.z);
        this.roundMesh.setMatrixAt(nr, _m);
        this.roundMesh.setColorAt(nr++, _c.set(cfg.color));
      }
    }
    for (const [m, n] of [
      [this.longMesh, nl],
      [this.roundMesh, nr],
    ] as const) {
      m.count = n;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
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

export type PickupKind = 'repair' | 'shield' | 'rapid' | 'triple';

export const PICKUPS: Record<PickupKind, { color: number; emissive: number; label: string; time: number }> = {
  repair: { color: 0x35c46a, emissive: 0x0b4a22, label: '🔧 Repaired!', time: 0 },
  shield: { color: 0x4fb3ff, emissive: 0x0b2a4a, label: '🛡️ Shield!', time: 8 },
  rapid: { color: 0xffd23a, emissive: 0x4a3a0b, label: '⚡ Rapid fire!', time: 8 },
  triple: { color: 0xff7a3a, emissive: 0x4a1a0b, label: '🔱 Triple shot!', time: 8 },
};

/** Power-up crates dropped by destroyed enemies. */
export class Pickups {
  readonly group = new THREE.Group();
  private items: { id: number; kind: PickupKind; x: number; y: number; z: number; mesh: THREE.Group; life: number }[] = [];
  private nextId = 1;
  private box = new THREE.BoxGeometry(1.1, 1.1, 1.1);
  private iconA = new THREE.BoxGeometry(0.75, 0.22, 1.14);
  private iconB = new THREE.BoxGeometry(0.22, 0.75, 1.14);
  private mats = new Map<PickupKind, THREE.Material>();
  private iconMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  private got: { id: number; kind: PickupKind; by: number }[] = [];

  clear(): void {
    for (const it of this.items) this.group.remove(it.mesh);
    this.items.length = 0;
  }

  get count(): number {
    return this.items.length;
  }

  /** returns the crate id (online: the host's ids are used everywhere) */
  drop(x: number, y: number, z: number, kind: PickupKind = 'repair', id = this.nextId++): number {
    this.nextId = Math.max(this.nextId, id + 1);
    let mat = this.mats.get(kind);
    if (!mat) this.mats.set(kind, (mat = new THREE.MeshLambertMaterial({ color: PICKUPS[kind].color, emissive: PICKUPS[kind].emissive })));
    const g = new THREE.Group();
    g.add(new THREE.Mesh(this.box, mat));
    for (const r of [0, Math.PI / 2]) {
      const a = new THREE.Mesh(this.iconA, this.iconMat),
        b = new THREE.Mesh(this.iconB, this.iconMat);
      a.rotation.y = b.rotation.y = r;
      b.visible = kind === 'repair' || kind === 'triple'; // cross / plus, or a bar
      g.add(a, b);
    }
    g.position.set(x, y, z);
    this.group.add(g);
    this.items.push({ id, kind, x, y, z, mesh: g, life: 25 });
    return id;
  }

  /** someone else took it */
  remove(id: number): void {
    const i = this.items.findIndex((it) => it.id === id);
    if (i < 0) return;
    this.group.remove(this.items[i].mesh);
    this.items.splice(i, 1);
  }

  /**
   * Move and animate; any collector within `reach` takes the crate. Returns the crates
   * taken this step (`by` = index into collectors).
   */
  step(dt: number, time: number, ground: Ground, collectors: readonly { x: number; z: number; alive: boolean }[], reach: number): readonly { id: number; kind: PickupKind; by: number }[] {
    this.got.length = 0;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.life -= dt;
      const gy = ground.heightAt(it.x, it.z);
      it.y = Math.max(gy + 1.1, it.y - 8 * dt);
      it.mesh.position.set(it.x, it.y + Math.sin(time * 3 + it.x) * 0.2, it.z);
      it.mesh.rotation.y += dt * 1.5;
      it.mesh.visible = it.life > 3 || Math.sin(time * 20) > 0;
      for (let c = 0; c < collectors.length; c++) {
        const p = collectors[c];
        if (p.alive && (it.x - p.x) ** 2 + (it.z - p.z) ** 2 < reach * reach) {
          this.got.push({ id: it.id, kind: it.kind, by: c });
          it.life = 0;
          break;
        }
      }
      if (it.life <= 0) {
        this.group.remove(it.mesh);
        this.items.splice(i, 1);
      }
    }
    return this.got;
  }
}
