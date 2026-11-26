import { b64ToF32, f32ToB64, load, remove, save } from './storage';

const RATE = 20; // samples per second
const STRIDE = 6; // x, y, z, heading, upX, upZ

/** Records the car at 20 Hz into a growable Float32Array (no per-frame allocation). */
export class GhostRecorder {
  private data = new Float32Array(RATE * STRIDE * 240);
  private n = 0;
  private acc = 0;

  reset(): void {
    this.n = 0;
    this.acc = 0;
  }

  record(dt: number, x: number, y: number, z: number, heading: number, upX: number, upZ: number): void {
    this.acc += dt;
    if (this.n > 0 && this.acc < 1 / RATE) return;
    this.acc -= this.n > 0 ? 1 / RATE : 0;
    if ((this.n + 1) * STRIDE > this.data.length) {
      if (this.data.length > RATE * STRIDE * 60 * 15) return; // 15 min cap
      const d = new Float32Array(this.data.length * 2);
      d.set(this.data);
      this.data = d;
    }
    const o = this.n * STRIDE;
    this.data[o] = x;
    this.data[o + 1] = y;
    this.data[o + 2] = z;
    this.data[o + 3] = heading;
    this.data[o + 4] = upX;
    this.data[o + 5] = upZ;
    this.n++;
  }

  snapshot(): Float32Array {
    return this.data.slice(0, this.n * STRIDE);
  }
}

export interface GhostPose {
  x: number;
  y: number;
  z: number;
  heading: number;
  upX: number;
  upZ: number;
}

export class GhostPlayer {
  constructor(private data: Float32Array) {}

  get duration(): number {
    return (this.data.length / STRIDE - 1) / RATE;
  }

  /** false when past the end */
  sample(t: number, out: GhostPose): boolean {
    const n = this.data.length / STRIDE;
    if (n < 2) return false;
    const f = t * RATE;
    if (f >= n - 1) return false;
    const i = Math.max(0, Math.floor(f));
    const a = f - i;
    const d = this.data,
      o = i * STRIDE,
      p = o + STRIDE;
    out.x = d[o] + (d[p] - d[o]) * a;
    out.y = d[o + 1] + (d[p + 1] - d[o + 1]) * a;
    out.z = d[o + 2] + (d[p + 2] - d[o + 2]) * a;
    let dh = d[p + 3] - d[o + 3];
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    out.heading = d[o + 3] + dh * a;
    out.upX = d[o + 4] + (d[p + 4] - d[o + 4]) * a;
    out.upZ = d[o + 5] + (d[p + 5] - d[o + 5]) * a;
    return true;
  }
}

/* ---------- persistence: best time + splits + ghost per stage ---------- */
export interface StageBest {
  time: number;
  splits: number[];
  date: string;
}

export function loadStageBest(id: string): StageBest | null {
  return load<StageBest | null>('best.' + id, null);
}

export function loadGhost(id: string): GhostPlayer | null {
  const b = load<string | null>('ghost.' + id, null);
  if (!b) return null;
  try {
    return new GhostPlayer(b64ToF32(b));
  } catch {
    return null;
  }
}

export function saveStageBest(id: string, best: StageBest, ghost: Float32Array): void {
  save('best.' + id, best);
  if (!save('ghost.' + id, f32ToB64(ghost))) remove('ghost.' + id);
}
