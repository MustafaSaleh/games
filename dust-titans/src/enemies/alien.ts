import * as THREE from 'three';
import { clamp } from '@engine/core/math';
import type { Target } from '../combat';
import { nearestPlayer, separate, type DamageResult, type Enemy, type EnemyCtx } from './enemy';

export const ALIEN = {
  hp: 24,
  radius: 1.0,
  speed: 12,
  hopEvery: 0.5,
  hopHeight: 1.2,
  touchDamage: 7,
  touchCooldown: 1.3,
  /** zig-zag so they're harder to hit */
  zigzag: 0.7,
};

let parts: { body: THREE.BufferGeometry; eye: THREE.BufferGeometry; pupil: THREE.BufferGeometry; bobble: THREE.BufferGeometry; eyeMat: THREE.Material; pupilMat: THREE.Material } | null = null;
function getParts() {
  return (parts ??= {
    body: new THREE.SphereGeometry(1, 14, 10),
    eye: new THREE.SphereGeometry(0.28, 10, 8),
    pupil: new THREE.SphereGeometry(0.13, 8, 6),
    bobble: new THREE.SphereGeometry(0.16, 8, 6),
    eyeMat: new THREE.MeshBasicMaterial({ color: 0xffffff }),
    pupilMat: new THREE.MeshBasicMaterial({ color: 0x1b1b2a }),
  });
}

const COLORS = [0x7dff6a, 0x6affd8, 0xd27dff];

/** A cute glowing jelly alien: hops toward you in zig-zags and zaps on contact. */
export class Alien implements Enemy {
  readonly kind = 'alien' as const;
  readonly score = 150;
  readonly r = ALIEN.radius;
  readonly mesh = new THREE.Group();
  x = 0;
  y = 0;
  z = 0;
  vx = 0;
  vz = 0;
  hp = ALIEN.hp;
  hitFlash = 0;
  private t: number;
  private touchCd = 0;
  private hopY = 0;
  private squash = 1;
  private bodyMat: THREE.MeshLambertMaterial;
  private body: THREE.Mesh;
  private bobbles: THREE.Object3D[] = [];
  readonly color: number;

  constructor(
    readonly id: string,
    seed: number,
  ) {
    const p = getParts();
    this.t = (seed % 7) * 0.37;
    this.color = COLORS[seed % COLORS.length];
    this.bodyMat = new THREE.MeshLambertMaterial({ color: this.color, emissive: new THREE.Color(this.color).multiplyScalar(0.35), transparent: true, opacity: 0.82 });
    this.body = new THREE.Mesh(p.body, this.bodyMat);
    this.mesh.add(this.body);
    for (const s of [1, -1]) {
      const eye = new THREE.Mesh(p.eye, p.eyeMat);
      eye.position.set(s * 0.36, 0.3, 0.78);
      const pupil = new THREE.Mesh(p.pupil, p.pupilMat);
      pupil.position.set(0, 0, 0.2);
      eye.add(pupil);
      this.body.add(eye);
      const bob = new THREE.Mesh(p.bobble, this.bodyMat);
      bob.position.set(s * 0.45, 1.25, 0);
      this.body.add(bob);
      this.bobbles.push(bob);
    }
  }

  get alive(): boolean {
    return this.hp > 0;
  }

  update(dt: number, ctx: EnemyCtx): void {
    this.t += dt;
    this.hitFlash = Math.max(0, this.hitFlash - dt);
    this.touchCd = Math.max(0, this.touchCd - dt);
    const n = nearestPlayer(ctx, this.x, this.z);
    let wx = 0,
      wz = 0;
    if (n) {
      const a = Math.atan2(n.p.x - this.x, n.p.z - this.z) + (n.d > 6 ? Math.sin(this.t * 2.6) * ALIEN.zigzag : 0);
      wx = Math.sin(a) * ALIEN.speed;
      wz = Math.cos(a) * ALIEN.speed;
      // touch: zap and bounce back
      if (this.touchCd <= 0 && n.d < this.r + n.p.r + 0.4 && n.p.y + 2 > this.y + this.hopY) {
        ctx.hurt(n.i, ALIEN.touchDamage, this.x, this.z);
        ctx.fx('jelly', this.x, this.y + 1, this.z);
        this.touchCd = ALIEN.touchCooldown;
        this.vx = -wx * 1.3;
        this.vz = -wz * 1.3;
      }
    }
    const [sx, sz] = separate(this, ctx.enemies, 0.4);
    wx += sx;
    wz += sz;
    if (this.touchCd < ALIEN.touchCooldown - 0.35) {
      const k = Math.min(1, 4 * dt);
      this.vx += (wx - this.vx) * k;
      this.vz += (wz - this.vz) * k;
    }
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    this.y = ctx.ground.heightAt(this.x, this.z);
    const ph = (this.t / ALIEN.hopEvery) * Math.PI;
    this.hopY = Math.abs(Math.sin(ph)) * ALIEN.hopHeight;
  }

  sync(dt: number): void {
    const ph = (this.t / ALIEN.hopEvery) * Math.PI;
    const s = Math.abs(Math.sin(ph));
    const target = s < 0.25 ? 0.7 : 1 + 0.15 * s; // squish when landing
    this.squash += (target - this.squash) * Math.min(1, dt * 16);
    this.mesh.position.set(this.x, this.y + this.hopY + this.squash * 0.95, this.z);
    this.body.scale.set(1 / Math.sqrt(this.squash), this.squash, 1 / Math.sqrt(this.squash));
    this.mesh.rotation.y = Math.atan2(this.vx, this.vz);
    for (let i = 0; i < 2; i++) this.bobbles[i].position.x = (i ? -0.45 : 0.45) + Math.sin(this.t * 7 + i) * 0.08;
    this.bodyMat.emissive.setHex(this.hitFlash > 0 ? 0xffffff : this.color).multiplyScalar(this.hitFlash > 0 ? 1 : 0.35);
    this.bodyMat.opacity = clamp(0.82, 0, 1);
  }

  targets(out: Target[]): void {
    out.push({ id: this.id, team: 'enemy', x: this.x, y: this.y + this.hopY + 0.95, z: this.z, r: 1.15, alive: this.alive, owner: this });
  }

  damage(_t: Target, dmg: number): DamageResult {
    this.hp -= dmg;
    this.hitFlash = 0.12;
    return this.hp > 0 ? 'hit' : 'killed';
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.bodyMat.dispose();
  }
}
