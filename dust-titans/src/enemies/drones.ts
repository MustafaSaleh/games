import * as THREE from 'three';
import { clamp } from '@engine/core/math';
import { COMBAT, type Target } from '../combat';
import type { Ground } from '../units/unit';
import { nearestPlayer, type DamageResult, type Enemy, type EnemyCtx } from './enemy';

/** Drone tuning. */
export const DRONE = {
  hp: 30,
  hover: 5.5, // m above the ground
  radius: 1.1,
  maxSpeed: 9,
  accel: 6,
  fireRange: 46,
  fireEvery: [2.3, 3.6] as [number, number],
  /** the eye glows this long before a shot, so players can dodge */
  telegraph: 0.45,
};

/** Small flying alien drone: orbits the player at a distance and lobs glowing orbs. */
export class Drone implements Target, Enemy {
  readonly kind = 'drone' as const;
  readonly score = 100;
  readonly team = 'enemy' as const;
  readonly r = DRONE.radius;
  x = 0;
  y = 0;
  z = 0;
  vx = 0;
  vy = 0;
  vz = 0;
  hp = DRONE.hp;
  fireCd: number;
  /** -1 / 1: which way it circles */
  orbit: number;
  dist: number;
  t = Math.random() * 10;
  hitFlash = 0;
  readonly mesh: THREE.Group;
  private eye: THREE.Mesh;
  private rotors: THREE.Object3D[] = [];

  constructor(
    readonly id: string,
    parts: DroneParts,
    seed: number,
  ) {
    this.orbit = seed % 2 ? 1 : -1;
    this.dist = 18 + (seed % 4) * 4;
    this.fireCd = 1.5 + (seed % 5) * 0.4;
    const g = new THREE.Group();
    g.add(new THREE.Mesh(parts.body, parts.bodyMat));
    const ring = new THREE.Mesh(parts.ring, parts.ringMat);
    ring.rotation.x = Math.PI / 2;
    g.add(ring);
    this.eye = new THREE.Mesh(parts.eye, parts.eyeMat.clone());
    this.eye.position.set(0, 0, 0.78);
    g.add(this.eye);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const arm = new THREE.Mesh(parts.arm, parts.bodyMat);
      arm.position.set(Math.cos(a) * 0.95, 0.1, Math.sin(a) * 0.95);
      arm.rotation.y = -a;
      g.add(arm);
      const rotor = new THREE.Mesh(parts.rotor, parts.rotorMat);
      rotor.position.set(Math.cos(a) * 1.5, 0.28, Math.sin(a) * 1.5);
      g.add(rotor);
      this.rotors.push(rotor);
    }
    this.mesh = g;
  }

  get alive(): boolean {
    return this.hp > 0;
  }

  /** hit spheres point back at their enemy */
  get owner(): this {
    return this;
  }

  /**
   * AI step. `fire(x,y,z,vx,vy,vz)` launches an orb. `others` keeps drones apart.
   */
  step(dt: number, ground: Ground, player: { x: number; y: number; z: number; vx: number; vz: number; alive: boolean }, others: readonly { x: number; z: number; alive: boolean }[], fire: (x: number, y: number, z: number, vx: number, vy: number, vz: number) => void): void {
    this.t += dt;
    this.hitFlash = Math.max(0, this.hitFlash - dt);
    const dx = player.x - this.x,
      dz = player.z - this.z;
    const d = Math.max(0.1, Math.hypot(dx, dz));
    const rx = dx / d,
      rz = dz / d;
    // keep a distance, circle around, stay apart from the other drones
    const radial = clamp((d - this.dist) * 0.6, -DRONE.maxSpeed, DRONE.maxSpeed);
    let wx = rx * radial + -rz * this.orbit * 5,
      wz = rz * radial + rx * this.orbit * 5;
    for (const o of others) {
      if (o === this || !o.alive) continue;
      const ox = this.x - o.x,
        oz = this.z - o.z;
      const od2 = ox * ox + oz * oz;
      if (od2 < 49 && od2 > 1e-4) {
        const od = Math.sqrt(od2);
        wx += (ox / od) * (7 - od) * 1.5;
        wz += (oz / od) * (7 - od) * 1.5;
      }
    }
    const k = Math.min(1, DRONE.accel * dt * 0.3);
    this.vx += (wx - this.vx) * k;
    this.vz += (wz - this.vz) * k;
    const sp = Math.hypot(this.vx, this.vz);
    if (sp > DRONE.maxSpeed) {
      this.vx *= DRONE.maxSpeed / sp;
      this.vz *= DRONE.maxSpeed / sp;
    }
    const targetY = ground.heightAt(this.x, this.z) + DRONE.hover + Math.sin(this.t * 1.7) * 0.7;
    this.vy += ((targetY - this.y) * 3 - this.vy) * Math.min(1, 4 * dt);
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.z += this.vz * dt;

    // shoot: aim a little ahead of the player
    this.fireCd -= dt;
    if (this.fireCd <= 0 && player.alive && d < DRONE.fireRange) {
      this.fireCd = DRONE.fireEvery[0] + Math.random() * (DRONE.fireEvery[1] - DRONE.fireEvery[0]);
      const tt = d / COMBAT.orbSpeed;
      const ax = player.x + player.vx * tt * 0.7 - this.x,
        ay = player.y + 1.2 - this.y,
        az = player.z + player.vz * tt * 0.7 - this.z;
      const l = Math.hypot(ax, ay, az) || 1;
      fire(this.x + (ax / l) * 1.2, this.y - 0.2, this.z + (az / l) * 1.2, (ax / l) * COMBAT.orbSpeed, (ay / l) * COMBAT.orbSpeed, (az / l) * COMBAT.orbSpeed);
    }
  }

  update(dt: number, ctx: EnemyCtx): void {
    const n = nearestPlayer(ctx, this.x, this.z);
    const f = ctx.players[0];
    const p = n?.p ?? { x: f?.x ?? 0, y: f?.y ?? 0, z: f?.z ?? 0, vx: 0, vz: 0, alive: false };
    this.step(dt, ctx.ground, p, ctx.enemies, (x, y, z, vx, vy, vz) => ctx.fire('orb', x, y, z, vx, vy, vz));
  }

  targets(out: Target[]): void {
    out.push(this);
  }

  damage(_t: Target, dmg: number): DamageResult {
    this.hp -= dmg;
    this.hitFlash = 0.15;
    return this.hp > 0 ? 'hit' : 'killed';
  }

  dispose(): void {
    this.mesh.removeFromParent();
    (this.eye.material as THREE.Material).dispose();
  }

  /** visuals: face the player, spin rotors, tilt with speed, glow before firing */
  sync(_dt: number, _time: number, ctx: EnemyCtx | { x: number; z: number }): void {
    const n = 'players' in ctx ? (nearestPlayer(ctx, this.x, this.z)?.p ?? ctx.players[0]) : ctx;
    const player = n ?? { x: this.x, z: this.z + 1 };
    const m = this.mesh;
    m.position.set(this.x, this.y, this.z);
    m.rotation.y = Math.atan2(player.x - this.x, player.z - this.z);
    m.rotation.x = clamp(Math.hypot(this.vx, this.vz) * 0.03, 0, 0.3);
    for (const r of this.rotors) r.rotation.y += 0.9;
    const warn = this.fireCd < DRONE.telegraph ? 1 : 0;
    const s = 1 + warn * 0.5 + this.hitFlash * 2;
    this.eye.scale.setScalar(s);
    (this.eye.material as THREE.MeshBasicMaterial).color.setHex(this.hitFlash > 0 ? 0xffffff : warn ? 0xff4fd8 : 0x5ff2ff);
  }
}

/** shared drone geometry / materials */
export interface DroneParts {
  body: THREE.BufferGeometry;
  ring: THREE.BufferGeometry;
  eye: THREE.BufferGeometry;
  arm: THREE.BufferGeometry;
  rotor: THREE.BufferGeometry;
  bodyMat: THREE.Material;
  ringMat: THREE.Material;
  eyeMat: THREE.MeshBasicMaterial;
  rotorMat: THREE.Material;
}

export function makeDroneParts(): DroneParts {
  return {
    body: new THREE.IcosahedronGeometry(0.85, 1).scale(1, 0.72, 1),
    ring: new THREE.TorusGeometry(0.95, 0.12, 6, 18),
    eye: new THREE.SphereGeometry(0.3, 10, 8),
    arm: new THREE.BoxGeometry(1.1, 0.14, 0.18),
    rotor: new THREE.CylinderGeometry(0.62, 0.62, 0.05, 14),
    bodyMat: new THREE.MeshLambertMaterial({ color: 0x2f3542, flatShading: true }),
    ringMat: new THREE.MeshLambertMaterial({ color: 0xff6a3d, emissive: 0x401006 }),
    eyeMat: new THREE.MeshBasicMaterial({ color: 0x5ff2ff }),
    rotorMat: new THREE.MeshBasicMaterial({ color: 0xbfe9ff, transparent: true, opacity: 0.35, depthWrite: false }),
  };
}
