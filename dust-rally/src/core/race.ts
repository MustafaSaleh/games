import { ENDLESS } from '../config/game';
import { GATE_PAD } from '../render/gates';
import type { Gate } from '../world/stage';
import { makeProject, type ProjectOut, type TrackPath } from '../world/track';

export type Mode = 'stage' | 'endless' | 'daily';
export type RaceState = 'countdown' | 'running' | 'finished' | 'over';

export interface RaceEvents {
  beep: number; // 0 none, 1 low, 2 GO
  gate: boolean;
  gateBonus: number;
  missed: boolean;
  finished: boolean;
  over: boolean;
}

interface CarLike {
  x: number;
  z: number;
  px: number;
  pz: number;
}

/** Rules for all modes: countdown, gates, splits, timer, endless clock, progress. */
export class Race {
  state: RaceState = 'countdown';
  countdown = 3.2;
  time = 0;
  timeLeft: number;
  passedIdx = -1; // track index of the last passed/missed gate
  readonly splits: number[] = [];
  splitDelta: number | null = null;
  splitShow = 0;
  readonly progress: ProjectOut = makeProject();
  private hint = -1;
  maxS = 0;
  wrongWay = false;
  offTrackFar = false;
  missedWarn = 0;
  readonly gateState = new Map<Gate, number>(); // 2 passed, 3 missed
  readonly ev: RaceEvents = { beep: 0, gate: false, gateBonus: 0, missed: false, finished: false, over: false };
  private lastBeep = 4;

  constructor(
    readonly mode: Mode,
    readonly gates: Gate[],
    readonly track: TrackPath,
    readonly bestSplits: number[] | null,
    startIdx: number,
  ) {
    this.timeLeft = mode === 'stage' ? 0 : ENDLESS.startTime;
    this.hint = startIdx;
  }

  get endless(): boolean {
    return this.mode !== 'stage';
  }

  nextGate(): Gate | undefined {
    for (const g of this.gates) if (g.idx > this.passedIdx) return g;
    return undefined;
  }

  get gatesPassed(): number {
    return this.splits.length;
  }

  update(dt: number, car: CarLike, heading: number): void {
    const ev = this.ev;
    ev.beep = 0;
    ev.gate = false;
    ev.missed = false;
    ev.finished = false;
    ev.over = false;
    if (this.splitShow > 0) this.splitShow -= dt;
    if (this.missedWarn > 0) this.missedWarn -= dt;

    if (this.state === 'countdown') {
      this.countdown -= dt;
      const n = Math.ceil(this.countdown);
      if (n < this.lastBeep && n >= 0) {
        this.lastBeep = n;
        ev.beep = n === 0 ? 2 : 1;
      }
      if (this.countdown <= 0) {
        this.state = 'running';
      }
      return;
    }
    if (this.state !== 'running') return;
    this.time += dt;

    // progress along the track
    const tr = this.track;
    const ok = tr.nearest(car.x, car.z, this.hint, 30, this.progress);
    if (ok) {
      if (this.progress.dist > 45) tr.nearest(car.x, car.z, -1, 0, this.progress);
      this.hint = this.progress.idx;
      if (this.progress.s > this.maxS && this.progress.dist < 60) this.maxS = this.progress.s;
      this.offTrackFar = this.progress.dist > 40;
      const i = tr.clampIdx(this.progress.idx);
      const dot = Math.sin(heading) * tr.dx(i) + Math.cos(heading) * tr.dz(i);
      this.wrongWay = dot < -0.5 && this.progress.dist < 20;
    }

    // gates
    const g = this.nextGate();
    if (g && g.idx >= tr.start && g.idx < tr.end) {
      if (this.crosses(car, g)) this.passGate(g);
      else if (this.progress.s > g.s + 30 && this.progress.dist < 40) {
        if (this.endless) {
          this.gateState.set(g, 3);
          this.passedIdx = g.idx;
          ev.missed = true;
        } else if (this.missedWarn <= 0) {
          this.missedWarn = 2.5;
          ev.missed = true;
        }
      }
    }

    if (this.endless) {
      this.timeLeft -= dt;
      if (this.timeLeft <= 0) {
        this.timeLeft = 0;
        this.state = 'over';
        ev.over = true;
      }
    }
  }

  private passGate(g: Gate): void {
    const ev = this.ev;
    this.gateState.set(g, 2);
    this.passedIdx = g.idx;
    this.splits.push(this.time);
    ev.gate = true;
    const k = this.splits.length - 1;
    this.splitDelta = this.bestSplits && this.bestSplits[k] != null ? this.time - this.bestSplits[k] : null;
    this.splitShow = 2.5;
    if (this.endless) {
      this.timeLeft += g.bonus;
      ev.gateBonus = g.bonus;
    }
    if (g.finish) {
      this.state = 'finished';
      ev.finished = true;
    }
  }

  /** Did the car's last movement segment cross the gate line? */
  private crosses(car: CarLike, g: Gate): boolean {
    const tr = this.track;
    const x = tr.x(g.idx),
      z = tr.z(g.idx);
    const rx = -tr.dz(g.idx),
      rz = tr.dx(g.idx);
    const hw = tr.halfW(g.idx) + GATE_PAD + 0.8;
    return segIntersect(car.px, car.pz, car.x, car.z, x - rx * hw, z - rz * hw, x + rx * hw, z + rz * hw);
  }

  /** Where to put the car on a reset: on the road at current progress. */
  respawnIndex(): number {
    return this.track.clampIdx((this.hint >= 0 ? this.hint : this.track.start) - 2);
  }
}

function segIntersect(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): boolean {
  const d1 = cross(dx - cx, dz - cz, ax - cx, az - cz);
  const d2 = cross(dx - cx, dz - cz, bx - cx, bz - cz);
  const d3 = cross(bx - ax, bz - az, cx - ax, cz - az);
  const d4 = cross(bx - ax, bz - az, dx - ax, dz - az);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

const cross = (ax: number, az: number, bx: number, bz: number): number => ax * bz - az * bx;
