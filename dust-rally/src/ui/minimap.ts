import type { TrackPath } from '../world/track';
import type { Gate } from '../world/stage';

/**
 * Canvas minimap. Screen orientation matches the camera: up = +z, right = -x
 * (or rotated with the car when the camera rotates).
 * Stages: whole track pre-rendered once. Endless: local window around the car.
 */
export class Minimap {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private bg: HTMLCanvasElement | null = null;
  private size = 132;
  private dpr = 1;
  private scale = 1;
  private ox = 0;
  private oz = 0;
  private frame = 0;
  private local = false;

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'minimap';
    parent.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.resize();
  }

  resize(): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const css = Math.round(Math.min(150, Math.max(96, Math.min(window.innerWidth, window.innerHeight) * 0.26)));
    this.size = css;
    this.canvas.style.width = this.canvas.style.height = css + 'px';
    this.canvas.width = this.canvas.height = css * this.dpr;
  }

  /** Stage mode: pre-render the full track. */
  setStage(track: TrackPath): void {
    this.local = false;
    let minX = 1e9,
      maxX = -1e9,
      minZ = 1e9,
      maxZ = -1e9;
    for (let i = track.start; i < track.end; i++) {
      minX = Math.min(minX, track.x(i));
      maxX = Math.max(maxX, track.x(i));
      minZ = Math.min(minZ, track.z(i));
      maxZ = Math.max(maxZ, track.z(i));
    }
    const S = this.size * this.dpr;
    const pad = 12 * this.dpr;
    this.scale = (S - pad * 2) / Math.max(maxX - minX, maxZ - minZ, 1);
    this.ox = (minX + maxX) / 2;
    this.oz = (minZ + maxZ) / 2;
    const bg = document.createElement('canvas');
    bg.width = bg.height = S;
    const g = bg.getContext('2d')!;
    g.lineJoin = g.lineCap = 'round';
    for (const [w, col] of [
      [7, 'rgba(0,0,0,0.35)'],
      [3.5, 'rgba(255,255,255,0.9)'],
    ] as [number, string][]) {
      g.strokeStyle = col;
      g.lineWidth = w * this.dpr;
      g.beginPath();
      for (let i = track.start; i < track.end; i += 3) {
        const [px, py] = this.toMap(track.x(i), track.z(i));
        if (i === track.start) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      g.stroke();
    }
    this.bg = bg;
  }

  setLocal(): void {
    this.local = true;
    this.bg = null;
    this.scale = 0.32 * this.dpr;
  }

  private toMap(x: number, z: number): [number, number] {
    const S = this.size * this.dpr;
    return [S / 2 - (x - this.ox) * this.scale, S / 2 - (z - this.oz) * this.scale];
  }

  draw(track: TrackPath, gates: Gate[], nextGate: Gate | undefined, carX: number, carZ: number, heading: number, ghost: { x: number; z: number } | null, rotate: number): void {
    // throttle redraws to every other frame
    if (++this.frame & 1) return;
    const g = this.ctx;
    const S = this.size * this.dpr;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, S, S);
    g.fillStyle = 'rgba(10,14,20,0.35)';
    g.beginPath();
    g.arc(S / 2, S / 2, S / 2 - 1, 0, Math.PI * 2);
    g.fill();
    g.save();
    g.beginPath();
    g.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2);
    g.clip();
    if (this.local) {
      this.ox = carX;
      this.oz = carZ;
      // rotate around the centre if camera rotates
      g.translate(S / 2, S / 2);
      g.rotate(rotate);
      g.translate(-S / 2, -S / 2);
      const range = (S / 2 / this.scale) * 1.5;
      g.lineJoin = g.lineCap = 'round';
      for (const [w, col] of [
        [7, 'rgba(0,0,0,0.35)'],
        [3.5, 'rgba(255,255,255,0.9)'],
      ] as [number, string][]) {
        g.strokeStyle = col;
        g.lineWidth = w * this.dpr;
        g.beginPath();
        let started = false;
        for (let i = track.start; i < track.end; i += 3) {
          const dx = track.x(i) - carX,
            dz = track.z(i) - carZ;
          if (Math.abs(dx) > range || Math.abs(dz) > range) {
            started = false;
            continue;
          }
          const [px, py] = this.toMap(track.x(i), track.z(i));
          if (!started) {
            g.moveTo(px, py);
            started = true;
          } else g.lineTo(px, py);
        }
        g.stroke();
      }
    } else if (this.bg) {
      g.drawImage(this.bg, 0, 0);
    }
    // gates
    for (const gt of gates) {
      if (gt.idx < track.start || gt.idx >= track.end) continue;
      const [px, py] = this.toMap(track.x(gt.idx), track.z(gt.idx));
      g.fillStyle = gt === nextGate ? '#ffb52e' : gt.finish ? '#fff' : 'rgba(255,255,255,0.45)';
      g.beginPath();
      g.arc(px, py, (gt === nextGate ? 4.5 : 2.5) * this.dpr, 0, Math.PI * 2);
      g.fill();
    }
    if (ghost) {
      const [px, py] = this.toMap(ghost.x, ghost.z);
      g.fillStyle = 'rgba(140,200,255,0.8)';
      g.beginPath();
      g.arc(px, py, 3.5 * this.dpr, 0, Math.PI * 2);
      g.fill();
    }
    // car arrow
    const [cx, cy] = this.toMap(carX, carZ);
    g.translate(cx, cy);
    g.rotate(-heading);
    g.fillStyle = '#ff4d3d';
    g.strokeStyle = '#fff';
    g.lineWidth = 1.5 * this.dpr;
    const d = this.dpr;
    g.beginPath();
    g.moveTo(0, -7 * d);
    g.lineTo(5 * d, 6 * d);
    g.lineTo(0, 3 * d);
    g.lineTo(-5 * d, 6 * d);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
  }
}
