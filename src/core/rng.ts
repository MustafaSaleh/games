/** Small seeded PRNG + hashing helpers. Everything procedural goes through these. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Integer hash of a few ints. */
export function hashInts(a: number, b: number, c = 0): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Re-seedable RNG object (no allocation when reseeded). */
export class Rng {
  private a = 0;
  constructor(seed = 1) {
    this.seed(seed);
  }
  seed(s: number): void {
    this.a = s >>> 0;
  }
  next(): number {
    this.a = (this.a + 0x6d2b79f5) | 0;
    let t = Math.imul(this.a ^ (this.a >>> 15), 1 | this.a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  int(a: number, b: number): number {
    return a + Math.floor(this.next() * (b - a + 1));
  }
}

/** Seeds are shown to players as short base-36 strings. */
export function seedToString(seed: number): string {
  return (seed >>> 0).toString(36).toUpperCase();
}

export function parseSeed(str: string): number {
  const s = str.trim();
  if (/^[0-9a-zA-Z]{1,7}$/.test(s)) {
    const n = parseInt(s, 36);
    if (Number.isFinite(n)) return n >>> 0;
  }
  return hashString(s);
}

export function randomSeed(): number {
  return (Math.random() * 0x7fffffff) >>> 0;
}

export function todayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10); // UTC date, same for everybody
}

export function dailySeed(d = new Date()): number {
  return hashString('rally-daily-' + todayKey(d)) % 2176782336; // fits in 6 base36 chars
}
