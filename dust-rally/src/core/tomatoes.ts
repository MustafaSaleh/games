import * as THREE from 'three';

/**
 * Tomato fight (multiplayer only): the first racer through each checkpoint earns a
 * tomato (up to MAX_AMMO) and can lob it back at whoever is chasing. A hit splats
 * the victim's screen (ui/splat.ts) until the squeegee wipes it.
 */
export const TOMATO = {
  maxAmmo: 3,
  gravity: 14,
  /** aim assist: look for a car behind within this range / cone */
  range: 75,
  coneCos: Math.cos((70 * Math.PI) / 180),
  /** horizontal hit radius around a car, and the height band (above its wheels) that counts */
  hitRadius: 2.3,
  hitLow: -0.4,
  hitHigh: 2.8,
  /** flight time limits of an aimed lob (s) */
  minFlight: 0.6,
  maxFlight: 1.5,
  maxAge: 3.5,
};

export interface TomatoTarget {
  id: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
}

/** throw parameters: origin + velocity [x, y, z, vx, vy, vz] */
export type ThrowArr = number[];

/**
 * Lob a tomato backwards from a car. With a car behind in range, aim where it will be
 * when the tomato lands; otherwise just throw it straight back.
 */
export function aimThrow(car: { x: number; y: number; z: number; vx: number; vz: number; heading: number }, targets: readonly TomatoTarget[]): ThrowArr {
  const bx = -Math.sin(car.heading),
    bz = -Math.cos(car.heading);
  const ox = car.x + bx * 2.2,
    oy = car.y + 1.4,
    oz = car.z + bz * 2.2;
  let best: TomatoTarget | null = null;
  let bestD = Infinity;
  for (const t of targets) {
    const dx = t.x - ox,
      dz = t.z - oz;
    const d = Math.hypot(dx, dz);
    if (d > TOMATO.range || d < 0.5) continue;
    if ((dx * bx + dz * bz) / d < TOMATO.coneCos) continue; // not behind us
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  const g = TOMATO.gravity;
  if (best) {
    // fixed-time lob to the predicted spot (time grows with distance)
    const time = (d: number) => Math.min(TOMATO.maxFlight, Math.max(TOMATO.minFlight, d / 28));
    let T = time(bestD);
    for (let i = 0; i < 2; i++) T = time(Math.hypot(best.x + best.vx * T - ox, best.z + best.vz * T - oz));
    const px = best.x + best.vx * T,
      py = best.y + 1.2, // roof height: the arc comes down onto the car
      pz = best.z + best.vz * T;
    return [ox, oy, oz, (px - ox) / T, (py - oy) / T + 0.5 * g * T, (pz - oz) / T];
  }
  const sp = 15;
  return [ox, oy, oz, car.vx * 0.6 + bx * sp, 7, car.vz * 0.6 + bz * sp];
}

interface Flying {
  owner: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  mesh: THREE.Group;
}

interface Stain {
  mesh: THREE.Mesh;
  age: number;
}

export interface TomatoHit {
  owner: string;
  target: string;
  x: number;
  y: number;
  z: number;
}

/** Flying tomatoes, ground splats and stains. */
export class TomatoSystem {
  readonly group = new THREE.Group();
  private flying: Flying[] = [];
  private stains: Stain[] = [];
  private bodyGeo = new THREE.IcosahedronGeometry(0.42, 1);
  private bodyMat = new THREE.MeshLambertMaterial({ color: 0xe8261c, emissive: 0x3a0402 });
  private stemGeo = new THREE.ConeGeometry(0.2, 0.18, 5);
  private stemMat = new THREE.MeshLambertMaterial({ color: 0x2f8a2a });
  private stainGeo = new THREE.CircleGeometry(1, 10);

  clear(): void {
    for (const f of this.flying) this.group.remove(f.mesh);
    for (const s of this.stains) {
      this.group.remove(s.mesh);
      (s.mesh.material as THREE.Material).dispose();
    }
    this.flying.length = 0;
    this.stains.length = 0;
  }

  get count(): number {
    return this.flying.length;
  }

  spawn(owner: string, p: ThrowArr): void {
    if (!Array.isArray(p) || p.length < 6 || !p.every(Number.isFinite)) return;
    const mesh = new THREE.Group();
    const body = new THREE.Mesh(this.bodyGeo, this.bodyMat);
    body.scale.set(1, 0.85, 1);
    const stem = new THREE.Mesh(this.stemGeo, this.stemMat);
    stem.position.y = 0.38;
    stem.rotation.x = Math.PI;
    mesh.add(body, stem);
    mesh.position.set(p[0], p[1], p[2]);
    this.group.add(mesh);
    this.flying.push({ owner, x: p[0], y: p[1], z: p[2], vx: p[3], vy: p[4], vz: p[5], age: 0, mesh });
  }

  /**
   * Move tomatoes; returns hits against `targets` (any car except the thrower's).
   * Ground hits leave a stain and call `onGround` for juice particles.
   */
  update(dt: number, groundAt: (x: number, z: number) => number, targets: readonly TomatoTarget[], onGround: (x: number, y: number, z: number) => void, hits: TomatoHit[]): void {
    hits.length = 0;
    for (let i = this.flying.length - 1; i >= 0; i--) {
      const f = this.flying[i];
      f.age += dt;
      f.vy -= TOMATO.gravity * dt;
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.z += f.vz * dt;
      f.mesh.position.set(f.x, f.y, f.z);
      f.mesh.rotation.x += dt * 9;
      f.mesh.rotation.z += dt * 5;
      let done = false;
      for (const t of targets) {
        if (t.id === f.owner) continue;
        const dx = f.x - t.x,
          dy = f.y - t.y,
          dz = f.z - t.z;
        if (dx * dx + dz * dz < TOMATO.hitRadius * TOMATO.hitRadius && dy > TOMATO.hitLow && dy < TOMATO.hitHigh) {
          hits.push({ owner: f.owner, target: t.id, x: f.x, y: f.y, z: f.z });
          done = true;
          break;
        }
      }
      const gy = groundAt(f.x, f.z);
      if (!done && f.y < gy + 0.25) {
        this.stain(f.x, gy, f.z);
        onGround(f.x, gy + 0.3, f.z);
        done = true;
      }
      if (done || f.age > TOMATO.maxAge) {
        this.group.remove(f.mesh);
        this.flying.splice(i, 1);
      }
    }
    // stains fade out
    for (let i = this.stains.length - 1; i >= 0; i--) {
      const s = this.stains[i];
      s.age += dt;
      const m = s.mesh.material as THREE.MeshBasicMaterial;
      m.opacity = 0.85 * Math.min(1, Math.max(0, (8 - s.age) / 3));
      if (s.age > 8) {
        this.group.remove(s.mesh);
        m.dispose();
        this.stains.splice(i, 1);
      }
    }
  }

  private stain(x: number, y: number, z: number): void {
    const mat = new THREE.MeshBasicMaterial({ color: 0xb3140c, transparent: true, opacity: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    const m = new THREE.Mesh(this.stainGeo, mat);
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = Math.random() * Math.PI;
    m.scale.set(1.3 + Math.random() * 0.6, 0.9 + Math.random() * 0.5, 1);
    m.position.set(x, y + 0.06, z);
    m.renderOrder = 2;
    this.group.add(m);
    this.stains.push({ mesh: m, age: 0 });
    if (this.stains.length > 12) {
      const old = this.stains.shift()!;
      this.group.remove(old.mesh);
      (old.mesh.material as THREE.Material).dispose();
    }
  }
}
