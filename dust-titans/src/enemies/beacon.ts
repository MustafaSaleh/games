import * as THREE from 'three';
import { COMBAT, type Target } from '../combat';
import { nearestPlayer, type DamageResult, type Enemy, type EnemyCtx } from './enemy';

/** Alien beacon (mission): a glowing crystal tower that calls robots and zaps orbs. */
export class Beacon implements Enemy {
  readonly kind = 'beacon' as const;
  readonly score = 2000;
  readonly r = 3;
  readonly mesh = new THREE.Group();
  x = 0;
  y = 0;
  z = 0;
  vx = 0;
  vz = 0;
  hp = 700;
  readonly maxHp = 700;
  private fireCd = 3;
  private crystal: THREE.Mesh;
  private mat: THREE.MeshBasicMaterial;
  private flash = 0;
  private t = 0;

  constructor(readonly id: string) {
    const base = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 3.4, 2, 6), new THREE.MeshLambertMaterial({ color: 0x3a2f55, flatShading: true }));
    base.position.y = 1;
    const spire = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 1.4, 9, 6), new THREE.MeshLambertMaterial({ color: 0x4f3f7a, flatShading: true }));
    spire.position.y = 6.5;
    this.mat = new THREE.MeshBasicMaterial({ color: 0xc86bff });
    this.crystal = new THREE.Mesh(new THREE.OctahedronGeometry(1.8, 0), this.mat);
    this.crystal.position.y = 12.5;
    this.mesh.add(base, spire, this.crystal);
  }

  get alive(): boolean {
    return this.hp > 0;
  }

  update(dt: number, ctx: EnemyCtx): void {
    this.t += dt;
    this.flash = Math.max(0, this.flash - dt);
    this.y = ctx.ground.heightAt(this.x, this.z);
    this.fireCd -= dt;
    const n = nearestPlayer(ctx, this.x, this.z);
    if (n && this.fireCd <= 0 && n.d < 70) {
      this.fireCd = 2.2;
      const sy = this.y + 12.5;
      for (const off of [-0.25, 0, 0.25]) {
        const dx = n.p.x - this.x,
          dy = n.p.y + 1.2 - sy,
          dz = n.p.z - this.z;
        const l = Math.hypot(dx, dy, dz) || 1;
        const c = Math.cos(off),
          s = Math.sin(off);
        const vx = (dx * c - dz * s) / l,
          vz = (dx * s + dz * c) / l;
        ctx.fire('orb', this.x + vx * 2, sy, this.z + vz * 2, vx * COMBAT.orbSpeed, (dy / l) * COMBAT.orbSpeed, vz * COMBAT.orbSpeed);
      }
    }
  }

  sync(_dt: number, time: number): void {
    this.mesh.position.set(this.x, this.y, this.z);
    this.crystal.rotation.y = time * 1.2;
    this.crystal.scale.setScalar(1 + 0.12 * Math.sin(time * 4) + (this.fireCd < 0.5 ? 0.3 : 0));
    this.mat.color.setHex(this.flash > 0 ? 0xffffff : this.fireCd < 0.5 ? 0xff7af0 : 0xc86bff);
  }

  targets(out: Target[]): void {
    out.push({ id: this.id + ':crystal', team: 'enemy', x: this.x, y: this.y + 12.5, z: this.z, r: 2.2, alive: this.alive, owner: this });
    out.push({ id: this.id + ':tower', team: 'enemy', x: this.x, y: this.y + 4, z: this.z, r: 3, alive: this.alive, owner: this });
  }

  damage(_t: Target, dmg: number): DamageResult {
    this.hp -= dmg;
    this.flash = 0.12;
    return this.hp > 0 ? 'hit' : 'killed';
  }

  dispose(): void {
    this.mesh.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      if (m.material) (m.material as THREE.Material).dispose();
    });
    this.mesh.removeFromParent();
  }
}
