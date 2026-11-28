import * as THREE from 'three';
import { buildCar, disposeCar, type CarModel } from '@engine/render/models';
import type { PickupKind, Target } from './combat';
import type { Enemy, EnemyKind, PlayerRef } from './enemies/enemy';

/**
 * Missions: short single-player goals on the battlefields. Stars: ★ done, ★★ with at least
 * half your armour left, ★★★ also under the par time.
 */
export type MissionId = 'escort' | 'market' | 'beacon' | 'nightboss' | 'supply';

export interface MissionDef {
  id: MissionId;
  name: string;
  icon: string;
  arena: string;
  brief: string;
  /** seconds for the third star */
  par: number;
}

export const MISSIONS: MissionDef[] = [
  { id: 'escort', name: 'Water truck', icon: '🚚', arena: 'ghost-town', brief: 'Escort the water truck across Ghost Town. Robots will try to stop it!', par: 75 },
  { id: 'market', name: 'Defend the market', icon: '🔋', arena: 'cairo', brief: "Jelly aliens want the market's 3 power cores. Keep at least one safe for 3 waves.", par: 120 },
  { id: 'beacon', name: 'Alien beacon', icon: '📡', arena: 'riyadh', brief: 'An alien beacon on the plateau keeps calling robots. Climb up and switch it off for good.', par: 90 },
  { id: 'nightboss', name: 'Night of the Giant', icon: '🌙', arena: 'dubai', brief: 'A Giant Robot Mk 2 marches on the marina. Knees first, then the core!', par: 120 },
  { id: 'supply', name: 'Supply run', icon: '📦', arena: 'frozen', brief: 'Collect 10 golden supply crates on the ice before time runs out. Watch out for aliens!', par: 80 },
];

export const missionById = (id: string): MissionDef | undefined => MISSIONS.find((m) => m.id === id);

/** something the player must protect: the truck, a power core */
export class Guarded {
  readonly ref: PlayerRef;
  hp: number;
  readonly mesh: THREE.Group;
  private car: CarModel | null = null;
  private glow: THREE.Mesh | null = null;
  hitFlash = 0;

  constructor(
    readonly id: string,
    readonly kind: 'truck' | 'core',
    readonly maxHp: number,
    public x: number,
    public z: number,
    public y: number,
  ) {
    this.hp = maxHp;
    this.ref = { x, y, z, vx: 0, vz: 0, r: kind === 'truck' ? 2.4 : 1.4, alive: true, airborne: false };
    this.mesh = new THREE.Group();
    if (kind === 'truck' && typeof document !== 'undefined') {
      this.car = buildCar('truck', { id: 'water', name: 'Water', body: 0x3fa9f5, stripe: 0xffffff, roof: 0x2a6fb0 });
      this.mesh.add(this.car.root);
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 2.6, 12).rotateX(Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0xdff4ff }));
      tank.position.set(0, 2.1, -1.2);
      this.car.root.add(tank);
    } else {
      const base = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1, 2.2), new THREE.MeshLambertMaterial({ color: 0x5a4a3a }));
      base.position.y = 0.5;
      this.glow = new THREE.Mesh(new THREE.OctahedronGeometry(0.9, 0), new THREE.MeshBasicMaterial({ color: 0x5ff2ff }));
      this.glow.position.y = 2.1;
      this.mesh.add(base, this.glow);
    }
  }

  get alive(): boolean {
    return this.hp > 0;
  }

  target(): Target {
    return { id: this.id, team: 'player', x: this.x, y: this.y + (this.kind === 'truck' ? 1.6 : 1.6), z: this.z, r: this.ref.r, alive: this.alive, owner: this };
  }

  hurt(dmg: number): void {
    if (!this.alive) return;
    this.hp = Math.max(0, this.hp - dmg);
    this.hitFlash = 0.15;
  }

  sync(dt: number, time: number, heading = 0): void {
    this.hitFlash = Math.max(0, this.hitFlash - dt);
    this.mesh.visible = this.alive;
    if (this.car) {
      this.car.root.position.set(this.x, this.y, this.z);
      this.car.root.rotation.y = heading;
      for (const w of this.car.wheels) w.rotation.x += dt * 3;
    }
    if (this.glow) {
      this.mesh.position.set(this.x, this.y, this.z);
      this.glow.rotation.y = time * 1.5;
      this.glow.position.y = 2.1 + Math.sin(time * 2) * 0.2;
      (this.glow.material as THREE.MeshBasicMaterial).color.setHex(this.hitFlash > 0 ? 0xff5a4f : this.hp < this.maxHp * 0.35 ? 0xffb52e : 0x5ff2ff);
    }
    const r = this.ref;
    r.x = this.x;
    r.y = this.y;
    r.z = this.z;
    r.alive = this.alive;
  }

  dispose(): void {
    if (this.car) disposeCar(this.car);
    this.mesh.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      if (m.material) (m.material as THREE.Material).dispose();
    });
    this.mesh.removeFromParent();
  }
}

/** what a running mission needs from the game */
export interface MissionHost {
  scene: THREE.Scene;
  radius: number;
  heightAt(x: number, z: number): number;
  spawn(kind: EnemyKind): Enemy;
  enemies: readonly Enemy[];
  banner(text: string, ms: number): void;
  dropCrate(x: number, y: number, z: number, kind: PickupKind): void;
  player(): { x: number; z: number; alive: boolean };
  /** add a ready-made enemy (the beacon) */
  addEnemy(e: Enemy): void;
  beacon(x: number, z: number): Enemy;
  cratesOnField(kind: PickupKind): number;
}

/** a mission in progress */
export class MissionRun {
  time = 0;
  outcome: 'win' | 'lose' | null = null;
  guarded: Guarded[] = [];
  /** truck heading */
  heading = 0;
  private spawnT = 3;
  private wave = 0;
  private waveQueue: EnemyKind[] = [];
  private beaconE: Enemy | null = null;
  private boss: Enemy | null = null;
  collected = 0;
  private crateT = 0;

  constructor(
    readonly def: MissionDef,
    private host: MissionHost,
  ) {
    const h = host;
    if (def.id === 'escort') {
      const t = new Guarded('truck', 'truck', 320, this.pathX(-115), -115, h.heightAt(this.pathX(-115), -115));
      this.guarded.push(t);
    } else if (def.id === 'market') {
      for (const [x, z] of [
        [55, -10],
        [70, 12],
        [48, 30],
      ] as const)
        this.guarded.push(new Guarded('core' + this.guarded.length, 'core', 130, x, z, h.heightAt(x, z)));
    } else if (def.id === 'beacon') {
      this.beaconE = h.beacon(0, 95);
    } else if (def.id === 'nightboss') {
      this.boss = h.spawn('boss');
      for (let i = 0; i < 3; i++) h.spawn('drone');
    }
    for (const g of this.guarded) h.scene.add(g.mesh);
  }

  /** the truck's road through Ghost Town */
  pathX(z: number): number {
    return 22 * Math.sin(z / 40);
  }

  get ref(): PlayerRef[] {
    return this.guarded.map((g) => g.ref);
  }

  /** HUD line */
  objective(): string {
    const id = this.def.id;
    if (id === 'escort') {
      const t = this.guarded[0];
      return `🚚 ${Math.round(((t.z + 115) / 230) * 100)}% · ❤️ ${Math.round((t.hp / t.maxHp) * 100)}%`;
    }
    if (id === 'market') return `🔋 ${this.guarded.filter((g) => g.alive).length}/3 cores · wave ${Math.max(1, this.wave)}/3`;
    if (id === 'beacon') return `📡 Beacon ${Math.round(Math.max(0, (this.beaconE as unknown as { hp: number })?.hp ?? 0))}`;
    if (id === 'nightboss') return '🌙 Defeat the Giant Robot';
    const left = Math.max(0, 120 - this.time);
    return `📦 ${this.collected}/10 · ⏱ ${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`;
  }

  collect(): void {
    this.collected++;
  }

  step(dt: number): void {
    if (this.outcome) return;
    this.time += dt;
    const h = this.host;
    const me = h.player();
    if (!me.alive) {
      this.outcome = 'lose';
      return;
    }
    const alive = h.enemies.filter((e) => e.alive).length;
    const id = this.def.id;

    if (id === 'escort') {
      const t = this.guarded[0];
      if (!t.alive) return void (this.outcome = 'lose');
      // the truck waits while robots are right next to it
      const blocked = h.enemies.some((e) => e.alive && e.kind !== 'drone' && Math.hypot(e.x - t.x, e.z - t.z) < 9);
      if (!blocked) {
        const nz = t.z + 3.2 * dt;
        const nx = this.pathX(nz);
        this.heading = Math.atan2(nx - t.x, nz - t.z);
        t.x = nx;
        t.z = nz;
        t.y = h.heightAt(t.x, t.z);
      }
      if (t.z >= 115) return void (this.outcome = 'win');
      this.spawnT -= dt;
      if (this.spawnT <= 0 && alive < 6) {
        this.spawnT = 5.5;
        const e = h.spawn(Math.random() < 0.5 ? 'walker' : 'drone');
        e.x = this.pathX(t.z + 45) + (Math.random() - 0.5) * 50;
        e.z = Math.min(130, t.z + 40 + Math.random() * 25);
        e.y = h.heightAt(e.x, e.z) + (e.kind === 'drone' ? 14 : 0);
      }
    } else if (id === 'market') {
      if (!this.guarded.some((g) => g.alive)) return void (this.outcome = 'lose');
      if (!this.waveQueue.length && alive === 0) {
        if (this.wave >= 3) return void (this.outcome = 'win');
        this.spawnT -= dt;
        if (this.spawnT <= 0) {
          this.wave++;
          const plan: EnemyKind[][] = [
            ['alien', 'alien', 'alien', 'alien', 'alien', 'drone', 'drone'],
            ['alien', 'walker', 'alien', 'alien', 'walker', 'alien', 'alien', 'alien'],
            ['alien', 'drone', 'walker', 'alien', 'alien', 'drone', 'alien', 'walker', 'alien', 'alien', 'drone', 'alien'],
          ];
          this.waveQueue = plan[this.wave - 1];
          h.banner(`WAVE ${this.wave} of 3`, 1600);
          this.spawnT = 0;
        }
      }
      if (this.waveQueue.length) {
        this.spawnT -= dt;
        if (this.spawnT <= 0) {
          this.spawnT = 0.9;
          h.spawn(this.waveQueue.shift()!);
          if (!this.waveQueue.length) this.spawnT = 3; // a breather before the next wave
        }
      }
    } else if (id === 'beacon') {
      if (this.beaconE && !this.beaconE.alive) return void (this.outcome = 'win');
      this.spawnT -= dt;
      if (this.spawnT <= 0 && alive < 6) {
        this.spawnT = 7;
        for (const k of ['walker', 'drone'] as EnemyKind[]) {
          const e = h.spawn(k);
          const a = Math.random() * Math.PI * 2;
          e.x = Math.sin(a) * 14;
          e.z = 95 + Math.cos(a) * 10;
          e.y = h.heightAt(e.x, e.z) + (k === 'drone' ? 10 : 0);
        }
      }
    } else if (id === 'nightboss') {
      if (this.boss && !this.boss.alive) return void (this.outcome = 'win');
      this.spawnT -= dt;
      if (this.spawnT <= 0 && alive < 5) {
        this.spawnT = 14;
        h.spawn('drone');
        h.spawn('drone');
      }
    } else if (id === 'supply') {
      if (this.collected >= 10) return void (this.outcome = 'win');
      if (this.time >= 120) return void (this.outcome = 'lose');
      this.crateT -= dt;
      const out = h.cratesOnField('supply');
      if (this.crateT <= 0 && this.collected + out < 10 && out < 2) {
        this.crateT = 0.5;
        const a = Math.random() * Math.PI * 2,
          d = 40 + Math.random() * 70;
        const x = Math.sin(a) * d,
          z = Math.cos(a) * d;
        h.dropCrate(x, h.heightAt(x, z) + 10, z, 'supply');
      }
      this.spawnT -= dt;
      if (this.spawnT <= 0 && alive < 6) {
        this.spawnT = 4;
        h.spawn('alien');
      }
    }
  }

  /** ★ count for a win */
  stars(hpFrac: number): number {
    return 1 + (hpFrac >= 0.5 ? 1 : 0) + (hpFrac >= 0.5 && this.time <= this.def.par ? 1 : 0);
  }

  dispose(): void {
    for (const g of this.guarded) g.dispose();
    this.guarded = [];
  }
}
