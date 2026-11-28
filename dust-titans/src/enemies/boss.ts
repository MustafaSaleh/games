import * as THREE from 'three';
import { clamp, wrapAngle } from '@engine/core/math';
import { SHOTS, type Target } from '../combat';
import { lob, nearestPlayer, type DamageResult, type Enemy, type EnemyCtx } from './enemy';

export const BOSS = {
  kneeHp: 160,
  coreHp: 260,
  speed: 2.4,
  keep: 18,
  turnRate: 0.7,
  volleyEvery: [4.2, 5.4] as [number, number],
  volleyTelegraph: 0.9,
  stompEvery: 7,
  stompRange: 26,
  stompWindup: 1.0,
  ringSpeed: 16,
  ringMax: 32,
  ringDamage: 14,
  ringWidth: 1.6,
  radius: 3.6,
};

type State = 'walk' | 'stomp' | 'kneel' | 'dying' | 'dead';

interface Ring {
  x: number;
  z: number;
  y: number;
  r: number;
  hit: Set<number>;
  mesh: THREE.Mesh;
}

/**
 * The Giant Robot. Knock out both glowing knees, then its chest core (shielded until the
 * knees are gone). It lobs plasma volleys and stomps shockwave rings you must jump or dodge.
 */
export class Boss implements Enemy {
  readonly kind = 'boss' as const;
  readonly r = BOSS.radius;
  readonly mesh = new THREE.Group(); // world-space container (body + rings)
  readonly score: number;
  x = 0;
  y = 0;
  z = 0;
  vx = 0;
  vz = 0;
  heading = 0;
  state: State = 'walk';
  knees = [0, 0];
  core: number;
  readonly maxHp: number;
  private body = new THREE.Group();
  private torso = new THREE.Group();
  private hips: THREE.Group[] = [];
  private kneeJ: THREE.Group[] = [];
  private kneeGlow: THREE.Mesh[] = [];
  private coreMesh: THREE.Mesh;
  private shield: THREE.Mesh;
  private shoulderGlow: THREE.Mesh[] = [];
  private eye: THREE.Mesh;
  private rings: Ring[] = [];
  private stride = 0;
  private volleyCd: number;
  private stompCd = 4;
  private stateT = 0;
  private stompLeg = 0;
  private sink = 0;
  private flash = 0;
  private boomT = 0;
  private time = 0;
  private geos: THREE.BufferGeometry[] = [];
  private mats: THREE.Material[] = [];
  private v = new THREE.Vector3();

  constructor(
    readonly id: string,
    readonly level = 1,
  ) {
    const k = 1 + 0.4 * (level - 1);
    this.knees = [BOSS.kneeHp * k, BOSS.kneeHp * k];
    this.core = BOSS.coreHp * k;
    this.maxHp = this.knees[0] + this.knees[1] + this.core;
    this.score = 3000 * level;
    this.volleyCd = 3;

    const metal = this.mat(new THREE.MeshLambertMaterial({ color: 0x59606e, flatShading: true }));
    const dark = this.mat(new THREE.MeshLambertMaterial({ color: 0x2a2e37, flatShading: true }));
    const purple = this.mat(new THREE.MeshLambertMaterial({ color: 0x6b3fc4, emissive: 0x1d0d3d, flatShading: true }));
    const glow = () => this.mat(new THREE.MeshBasicMaterial({ color: 0xffa23a }));
    const box = (w: number, h: number, d: number, x: number, y: number, z: number, m: THREE.Material) => {
      const g = new THREE.BoxGeometry(w, h, d).translate(x, y, z);
      this.geos.push(g);
      return new THREE.Mesh(g, m);
    };
    const sphere = (r: number, m: THREE.Material) => {
      const g = new THREE.SphereGeometry(r, 14, 10);
      this.geos.push(g);
      return new THREE.Mesh(g, m);
    };

    this.body.rotation.order = 'YXZ'; // heading, then the fall forward
    // legs
    for (const s of [1, -1]) {
      const hip = new THREE.Group();
      hip.position.set(s * 2.4, 6.6, 0);
      hip.add(box(1.4, 3.3, 1.6, 0, -1.6, 0, metal), box(1.5, 0.4, 1.7, 0, -0.5, 0, purple));
      const knee = new THREE.Group();
      knee.position.y = -3.2;
      knee.add(box(1.25, 3.0, 1.45, 0, -1.6, 0.1, metal), box(2.3, 0.8, 3.4, 0, -3.0, 0.4, dark), box(1.3, 0.9, 0.3, 0, -1.2, 0.85, purple));
      const kg = sphere(0.85, glow());
      kg.position.set(0, 0, 0.75);
      knee.add(kg);
      hip.add(knee);
      this.body.add(hip);
      this.hips.push(hip);
      this.kneeJ.push(knee);
      this.kneeGlow.push(kg);
    }
    // pelvis + torso
    this.body.add(box(5.2, 1.6, 3.0, 0, 6.9, 0, dark));
    this.torso.position.y = 7.6;
    this.torso.add(
      box(6.4, 4.2, 4.4, 0, 2.2, 0, metal),
      box(6.6, 0.5, 4.6, 0, 3.9, 0, purple),
      box(2.4, 1.6, 2.2, 0, 5.0, 0.3, dark), // head
      box(4.0, 1.4, 1.6, 0, 2.0, -2.8, dark), // back pack
    );
    this.eye = box(1.8, 0.35, 0.2, 0, 5.15, 1.45, glow());
    this.torso.add(this.eye);
    for (const s of [1, -1]) {
      this.torso.add(box(1.8, 1.8, 2.4, s * 4.1, 3.4, 0, metal), box(1.4, 3.2, 1.4, s * 4.1, 0.9, 0.2, dark), box(1.6, 0.9, 1.6, s * 4.1, -0.9, 0.4, purple));
      this.torso.add(box(0.7, 0.7, 2.2, s * 4.1, 4.3, 1.4, dark));
      const sg = box(0.75, 0.75, 0.3, s * 4.1, 4.3, 2.55, glow());
      this.torso.add(sg);
      this.shoulderGlow.push(sg);
    }
    this.coreMesh = sphere(1.1, glow());
    this.coreMesh.position.set(0, 2.4, 2.2);
    this.torso.add(this.coreMesh);
    this.shield = sphere(1.7, this.mat(new THREE.MeshBasicMaterial({ color: 0x5fb8ff, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending })));
    this.shield.position.copy(this.coreMesh.position);
    this.torso.add(this.shield);
    this.body.add(this.torso);
    this.mesh.add(this.body);
  }

  private mat<T extends THREE.Material>(m: T): T {
    this.mats.push(m);
    return m;
  }

  get alive(): boolean {
    return this.state !== 'dead';
  }

  get hpFrac(): number {
    return (Math.max(0, this.knees[0]) + Math.max(0, this.knees[1]) + Math.max(0, this.core)) / this.maxHp;
  }

  /** online guests: follow the host's boss state */
  netState(k0: number, k1: number, core: number, st: number): void {
    const was = [this.knees[0] > 0, this.knees[1] > 0];
    this.knees[0] = k0;
    this.knees[1] = k1;
    this.core = core;
    const states: State[] = ['walk', 'stomp', 'kneel', 'dying', 'dead'];
    const next = states[st] ?? 'walk';
    if (next !== this.state && (next === 'dying' || next === 'kneel' || next === 'stomp')) this.stateT = 0;
    if (next !== 'dead') this.state = next;
    for (let i = 0; i < 2; i++) if (was[i] && this.knees[i] <= 0) this.flash = 0.3;
  }

  get stateCode(): number {
    return ['walk', 'stomp', 'kneel', 'dying', 'dead'].indexOf(this.state);
  }

  get shielded(): boolean {
    return this.knees[0] > 0 || this.knees[1] > 0;
  }

  update(dt: number, ctx: EnemyCtx): void {
    this.time += dt;
    this.stateT += dt;
    this.flash = Math.max(0, this.flash - dt);
    this.updateRings(dt, ctx);
    if (this.state === 'dead') return;
    const n = nearestPlayer(ctx, this.x, this.z);

    if (this.state === 'dying') {
      this.boomT -= dt;
      if (this.boomT <= 0) {
        this.boomT = 0.28;
        this.v.set((Math.random() - 0.5) * 6, 4 + Math.random() * 8, (Math.random() - 0.5) * 4);
        this.body.localToWorld(this.v);
        ctx.fx('explode', this.v.x, this.v.y, this.v.z, 1.4);
      }
      this.body.rotation.x = Math.min(1.35, (this.stateT / 2.4) ** 2 * 1.35);
      this.sink = Math.min(3, this.stateT * 1.2);
      if (this.stateT > 2.6) {
        this.state = 'dead';
        ctx.fx('bigExplode', this.x + Math.sin(this.heading) * 6, this.y + 2, this.z + Math.cos(this.heading) * 6, 3);
        this.body.visible = false;
      }
      this.pose(dt);
      return;
    }

    // ---- turn + walk ----
    const kneel = this.state === 'kneel';
    let speed = 0;
    if (n) {
      const want = Math.atan2(n.p.x - this.x, n.p.z - this.z);
      this.heading = wrapAngle(this.heading + clamp(wrapAngle(want - this.heading), -BOSS.turnRate * dt, BOSS.turnRate * dt));
      if (this.state === 'walk' && n.d > BOSS.keep) speed = BOSS.speed * (this.knees[0] > 0 && this.knees[1] > 0 ? 1 : 0.6);
    }
    this.vx = Math.sin(this.heading) * speed;
    this.vz = Math.cos(this.heading) * speed;
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    this.y = ctx.ground.heightAt(this.x, this.z);
    this.stride += speed * dt;

    // ---- plasma volley (shoulders glow first) ----
    this.volleyCd -= dt;
    if (this.volleyCd <= 0 && n) {
      this.volleyCd = BOSS.volleyEvery[0] + Math.random() * (BOSS.volleyEvery[1] - BOSS.volleyEvery[0]) - (kneel ? 1 : 0);
      const g = SHOTS.plasma.gravity;
      for (let i = 0; i < 6; i++) {
        const s = i % 2 ? 1 : -1;
        this.v.set(s * 4.1, 7.6 + 4.3, 2.6);
        this.body.localToWorld(this.v);
        const spread = (Math.floor(i / 2) - 1) * 4.5;
        const t = clamp(n.d / 18, 0.9, 2.6);
        const tx = n.p.x + n.p.vx * t * 0.5 + Math.cos(this.heading) * spread,
          tz = n.p.z + n.p.vz * t * 0.5 - Math.sin(this.heading) * spread;
        const [vx, vy, vz] = lob(this.v.x, this.v.y, this.v.z, tx, ctx.ground.heightAt(tx, tz) + 1, tz, t + i * 0.05, g);
        ctx.fire('plasma', this.v.x, this.v.y, this.v.z, vx, vy, vz);
      }
      ctx.fx('roar', this.x, this.y + 10, this.z);
    }

    // ---- stomp: lift a leg, slam, shockwave ring ----
    this.stompCd -= dt;
    if (this.state === 'walk' && this.stompCd <= 0 && n && n.d < BOSS.stompRange) {
      this.state = 'stomp';
      this.stateT = 0;
      this.stompLeg = this.knees[0] > 0 ? 0 : 1;
      ctx.fx('warn', this.x, this.y, this.z);
    }
    if (this.state === 'stomp' && this.stateT >= BOSS.stompWindup) {
      this.v.set(this.stompLeg ? -2.4 : 2.4, 0, 1.2);
      this.body.localToWorld(this.v);
      this.spawnRing(this.v.x, ctx.ground.heightAt(this.v.x, this.v.z), this.v.z);
      ctx.fx('stomp', this.v.x, this.y, this.v.z, 2);
      this.state = this.shielded ? 'walk' : 'kneel';
      this.stompCd = BOSS.stompEvery;
    }
    if (kneel && this.stompCd <= 0 && n && n.d < BOSS.stompRange) {
      // kneeling: slams both fists instead
      this.v.set(0, 0, 4);
      this.body.localToWorld(this.v);
      this.spawnRing(this.v.x, ctx.ground.heightAt(this.v.x, this.v.z), this.v.z);
      ctx.fx('stomp', this.v.x, this.y, this.v.z, 2);
      this.stompCd = BOSS.stompEvery + 1.5;
    }
    this.pose(dt);
  }

  /** legs / sink / torso from the state (60 Hz, also used for hit spheres) */
  private pose(dt: number): void {
    const kneel = this.state === 'kneel' || this.state === 'dying';
    const sinkT = kneel ? 2.6 : 0;
    if (this.state !== 'dying') this.sink += (sinkT - this.sink) * Math.min(1, dt * 3);
    const ph = this.stride * 0.55;
    for (let i = 0; i < 2; i++) {
      let hip = Math.sin(ph + i * Math.PI) * 0.3,
        knee = Math.max(0, Math.cos(ph + i * Math.PI)) * 0.4;
      if (this.state === 'stomp' && i === this.stompLeg) {
        const t = clamp(this.stateT / BOSS.stompWindup, 0, 1);
        hip = -0.75 * Math.sin(t * Math.PI * 0.5);
        knee = 1.0 * Math.sin(t * Math.PI * 0.5);
      }
      if (kneel) {
        hip = -1.1;
        knee = 2.0;
      }
      this.hips[i].rotation.x += (hip - this.hips[i].rotation.x) * Math.min(1, dt * 8);
      this.kneeJ[i].rotation.x += (knee - this.kneeJ[i].rotation.x) * Math.min(1, dt * 8);
    }
    this.body.position.set(this.x, this.y - this.sink + Math.abs(Math.sin(ph)) * 0.25, this.z);
    this.body.rotation.y = this.heading;
    this.mesh.updateMatrixWorld(true);
  }

  private spawnRing(x: number, y: number, z: number): void {
    const g = new THREE.RingGeometry(0.88, 1, 48).rotateX(-Math.PI / 2);
    const m = new THREE.MeshBasicMaterial({ color: 0xffc46a, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
    const mesh = new THREE.Mesh(g, m);
    mesh.renderOrder = 5;
    this.mesh.add(mesh);
    this.rings.push({ x, y, z, r: 1, hit: new Set(), mesh });
  }

  private updateRings(dt: number, ctx: EnemyCtx): void {
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const ring = this.rings[i];
      ring.r += BOSS.ringSpeed * dt;
      ctx.players.forEach((p, k) => {
        if (!p.alive || ring.hit.has(k) || p.airborne) return;
        const d = Math.hypot(p.x - ring.x, p.z - ring.z);
        if (Math.abs(d - ring.r) < BOSS.ringWidth) {
          ring.hit.add(k);
          ctx.hurt(k, BOSS.ringDamage, ring.x, ring.z);
        }
      });
      ring.mesh.position.set(ring.x, ring.y + 0.4, ring.z);
      ring.mesh.scale.set(ring.r, 1, ring.r);
      (ring.mesh.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - ring.r / BOSS.ringMax);
      if (ring.r > BOSS.ringMax) {
        ring.mesh.removeFromParent();
        ring.mesh.geometry.dispose();
        (ring.mesh.material as THREE.Material).dispose();
        this.rings.splice(i, 1);
      }
    }
  }

  sync(_dt: number, time: number): void {
    const pulse = 0.85 + 0.15 * Math.sin(time * 6);
    this.kneeGlow.forEach((g, i) => {
      g.visible = this.knees[i] > 0;
      g.scale.setScalar(pulse);
      (g.material as THREE.MeshBasicMaterial).color.setHex(this.flash > 0 ? 0xffffff : 0xffa23a);
    });
    this.shield.visible = this.shielded && this.state !== 'dying';
    this.shield.scale.setScalar(1 + 0.05 * Math.sin(time * 9));
    this.coreMesh.scale.setScalar(this.shielded ? 0.8 : pulse * 1.1);
    (this.coreMesh.material as THREE.MeshBasicMaterial).color.setHex(this.flash > 0 && !this.shielded ? 0xffffff : this.shielded ? 0xb26a2a : 0xff5a2a);
    const warn = this.volleyCd < BOSS.volleyTelegraph;
    for (const s of this.shoulderGlow) {
      s.scale.setScalar(warn ? 1.4 + 0.3 * Math.sin(time * 30) : 1);
      (s.material as THREE.MeshBasicMaterial).color.setHex(warn ? 0xffffff : 0xffa23a);
    }
    (this.eye.material as THREE.MeshBasicMaterial).color.setHex(this.state === 'stomp' ? 0xff3b3b : 0xffa23a);
  }

  targets(out: Target[]): void {
    if (this.state === 'dying' || this.state === 'dead') return;
    const p = this.v;
    // weak points first (they win when a shot overlaps an armour sphere too)
    for (let i = 0; i < 2; i++) {
      if (this.knees[i] <= 0) continue;
      this.kneeGlow[i].getWorldPosition(p);
      out.push({ id: `${this.id}:knee${i}`, team: 'enemy', x: p.x, y: p.y, z: p.z, r: 1.3, alive: true, owner: this });
    }
    this.coreMesh.getWorldPosition(p);
    out.push({ id: `${this.id}:core`, team: 'enemy', x: p.x, y: p.y, z: p.z, r: 1.5, alive: true, owner: this, armor: this.shielded });
    // armour
    this.torso.getWorldPosition(p);
    out.push({ id: `${this.id}:torso`, team: 'enemy', x: p.x, y: p.y + 2.2, z: p.z, r: 3.4, alive: true, owner: this, armor: true });
    for (const h of this.hips) {
      h.getWorldPosition(p);
      out.push({ id: `${this.id}:hip`, team: 'enemy', x: p.x, y: p.y - 1.6, z: p.z, r: 1.2, alive: true, owner: this, armor: true });
    }
  }

  /** aim-assist points: the weak spots that can take damage right now */
  aimPoints(out: { x: number; y: number; z: number }[]): void {
    const tg: Target[] = [];
    this.targets(tg);
    for (const t of tg) if (!t.armor) out.push({ x: t.x, y: t.y, z: t.z });
  }

  damage(t: Target, dmg: number, ctx: EnemyCtx): DamageResult {
    if (t.armor || this.state === 'dying' || this.state === 'dead') return 'armor';
    this.flash = 0.12;
    const m = /knee(\d)$/.exec(t.id);
    if (m) {
      const i = +m[1];
      this.knees[i] -= dmg;
      if (this.knees[i] <= 0) {
        ctx.fx('bigExplode', t.x, t.y, t.z, 1.6);
        if (!this.shielded) {
          this.state = 'kneel';
          this.stateT = 0;
          ctx.fx('roar', this.x, this.y + 8, this.z);
        }
        return 'part';
      }
      return 'hit';
    }
    this.core -= dmg;
    if (this.core <= 0) {
      this.state = 'dying';
      this.stateT = 0;
      return 'killed';
    }
    return 'hit';
  }

  dispose(): void {
    this.mesh.removeFromParent();
    for (const r of this.rings) {
      r.mesh.geometry.dispose();
      (r.mesh.material as THREE.Material).dispose();
    }
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
  }
}
