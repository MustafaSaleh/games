import * as THREE from 'three';
import { clamp, wrapAngle } from '@engine/core/math';
import { resolveCircleColliders } from '@engine/physics/collisions';
import { ColliderHits } from '@engine/world/terrain';
import type { Target } from '../combat';
import { nearestPlayer, separate, type DamageResult, type Enemy, type EnemyCtx } from './enemy';

export const WALKER = {
  hp: 70,
  radius: 1.4,
  speed: 4.5,
  range: 24,
  burst: 3,
  burstGap: 0.2,
  every: [3.2, 4.4] as [number, number],
  /** the visor turns red this long before a burst */
  telegraph: 0.7,
  laserSpeed: 34,
};

let parts: {
  body: THREE.BufferGeometry;
  head: THREE.BufferGeometry;
  visor: THREE.BufferGeometry;
  leg: THREE.BufferGeometry;
  gun: THREE.BufferGeometry;
  mat: THREE.Material;
  accent: THREE.Material;
  dark: THREE.Material;
} | null = null;

function getParts() {
  return (parts ??= {
    body: new THREE.BoxGeometry(1.9, 1.5, 1.3).translate(0, 2.35, 0),
    head: new THREE.SphereGeometry(0.62, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 3.1, 0),
    visor: new THREE.BoxGeometry(0.85, 0.22, 0.2).translate(0, 3.32, 0.5),
    leg: new THREE.BoxGeometry(0.45, 1.6, 0.6).translate(0, -0.8, 0),
    gun: new THREE.BoxGeometry(0.38, 0.38, 1.4).translate(0, 0, 0.6),
    mat: new THREE.MeshLambertMaterial({ color: 0x8a93a3, flatShading: true }),
    accent: new THREE.MeshLambertMaterial({ color: 0x7b4bd1, emissive: 0x1a0b33, flatShading: true }),
    dark: new THREE.MeshLambertMaterial({ color: 0x2f3542, flatShading: true }),
  });
}

/** A boxy robot on two legs: walks to firing range, strafes, fires laser bursts. */
export class Walker implements Enemy, Target {
  readonly kind = 'walker' as const;
  readonly team = 'enemy' as const;
  readonly score = 200;
  readonly r = WALKER.radius;
  readonly mesh = new THREE.Group();
  x = 0;
  y = 0;
  z = 0;
  vx = 0;
  vz = 0;
  yawRate = 0;
  heading = 0;
  hp = WALKER.hp;
  hitFlash = 0;
  private fireCd: number;
  private burstLeft = 0;
  private burstT = 0;
  private strafe: number;
  private stride = 0;
  private legs: THREE.Object3D[] = [];
  private visorMat: THREE.MeshBasicMaterial;
  private hits = new ColliderHits();
  private bodyY = 0;

  constructor(
    readonly id: string,
    seed: number,
  ) {
    const p = getParts();
    this.fireCd = 2 + (seed % 4) * 0.5;
    this.strafe = seed % 2 ? 1 : -1;
    this.visorMat = new THREE.MeshBasicMaterial({ color: 0x5ff2ff });
    const body = new THREE.Group();
    body.add(new THREE.Mesh(p.body, p.mat), new THREE.Mesh(p.head, p.accent), new THREE.Mesh(p.visor, this.visorMat));
    for (const s of [1, -1]) {
      const leg = new THREE.Group();
      leg.position.set(s * 0.55, 1.65, 0);
      leg.add(new THREE.Mesh(p.leg, p.dark));
      body.add(leg);
      this.legs.push(leg);
      const gun = new THREE.Mesh(p.gun, p.dark);
      gun.position.set(s * 1.15, 2.3, 0.3);
      body.add(gun);
    }
    const stripe = new THREE.Mesh(p.visor, p.accent);
    stripe.scale.set(2.3, 0.8, 7);
    stripe.position.set(0, -0.55, -0.5);
    body.add(stripe);
    this.mesh.add(body);
  }

  get alive(): boolean {
    return this.hp > 0;
  }

  /** hit sphere centre */
  get cy(): number {
    return this.y + 2.3;
  }

  update(dt: number, ctx: EnemyCtx): void {
    this.hitFlash = Math.max(0, this.hitFlash - dt);
    const n = nearestPlayer(ctx, this.x, this.z);
    let wx = 0,
      wz = 0;
    if (n) {
      const rx = (n.p.x - this.x) / Math.max(0.1, n.d),
        rz = (n.p.z - this.z) / Math.max(0.1, n.d);
      const radial = n.d > WALKER.range ? WALKER.speed : n.d < WALKER.range * 0.55 ? -WALKER.speed * 0.7 : 0;
      const shooting = this.burstLeft > 0 || this.fireCd < WALKER.telegraph;
      const side = shooting ? 0 : WALKER.speed * 0.55 * this.strafe;
      wx = rx * radial - rz * side;
      wz = rz * radial + rx * side;
      this.heading += clamp(wrapAngle(Math.atan2(rx, rz) - this.heading), -4 * dt, 4 * dt);

      // weapons: telegraph, then a 3-shot burst
      this.fireCd -= dt;
      if (this.fireCd <= 0 && this.burstLeft === 0 && n.d < WALKER.range + 14) {
        this.burstLeft = WALKER.burst;
        this.burstT = 0;
        this.fireCd = WALKER.every[0] + Math.random() * (WALKER.every[1] - WALKER.every[0]);
        if (Math.random() < 0.3) this.strafe *= -1;
      }
      if (this.burstLeft > 0) {
        this.burstT -= dt;
        if (this.burstT <= 0) {
          this.burstT = WALKER.burstGap;
          this.burstLeft--;
          const side = this.burstLeft % 2 ? 1 : -1;
          const s = Math.sin(this.heading),
            c = Math.cos(this.heading);
          const mx = this.x + s * 1.3 - c * 1.15 * side,
            mz = this.z + c * 1.3 + s * 1.15 * side,
            my = this.y + 2.3;
          const t = n.d / WALKER.laserSpeed;
          const ax = n.p.x + n.p.vx * t * 0.6 - mx,
            ay = n.p.y + 1.3 - my,
            az = n.p.z + n.p.vz * t * 0.6 - mz;
          const l = Math.hypot(ax, ay, az) || 1;
          ctx.fire('laser', mx, my, mz, (ax / l) * WALKER.laserSpeed, (ay / l) * WALKER.laserSpeed, (az / l) * WALKER.laserSpeed);
        }
      }
    } else this.fireCd = Math.max(this.fireCd, 1);
    const [sx, sz] = separate(this, ctx.enemies, 1.5);
    wx += sx;
    wz += sz;
    const k = Math.min(1, 5 * dt);
    this.vx += (wx - this.vx) * k;
    this.vz += (wz - this.vz) * k;
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    ctx.ground.queryColliders(this.x, this.z, this.r, this.hits);
    resolveCircleColliders(this, this.x, this.z, this.r, this.hits);
    this.y = ctx.ground.heightAt(this.x, this.z);
    this.stride += Math.hypot(this.vx, this.vz) * dt;
  }

  sync(dt: number, _time: number): void {
    const m = this.mesh;
    this.bodyY += (Math.abs(Math.sin(this.stride * 1.6)) * 0.15 - this.bodyY) * Math.min(1, dt * 10);
    m.position.set(this.x, this.y + this.bodyY, this.z);
    m.rotation.y = this.heading;
    const a = clamp(Math.hypot(this.vx, this.vz) / WALKER.speed, 0, 1) * 0.6;
    this.legs[0].rotation.x = Math.sin(this.stride * 1.6) * a;
    this.legs[1].rotation.x = -Math.sin(this.stride * 1.6) * a;
    const warn = this.burstLeft > 0 || this.fireCd < WALKER.telegraph;
    this.visorMat.color.setHex(this.hitFlash > 0 ? 0xffffff : warn ? 0xff3b3b : 0x5ff2ff);
  }

  targets(out: Target[]): void {
    out.push({ id: this.id, team: 'enemy', x: this.x, y: this.cy, z: this.z, r: 1.6, alive: this.alive, owner: this });
  }

  damage(_t: Target, dmg: number): DamageResult {
    this.hp -= dmg;
    this.hitFlash = 0.15;
    return this.hp > 0 ? 'hit' : 'killed';
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.visorMat.dispose();
  }
}
