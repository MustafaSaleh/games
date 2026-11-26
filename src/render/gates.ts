import * as THREE from 'three';
import type { TrackPath } from '../world/track';
import type { HeightSource } from './effects';

export const GATE_PAD = 2.2; // gate half-width = road half-width + this

/** Pooled checkpoint gate meshes: two posts + banner + ground line. */
export class GateView {
  readonly group = new THREE.Group();
  private pool: THREE.Group[] = [];
  private used = 0;
  private matNext = new THREE.MeshBasicMaterial({ color: 0xffb52e });
  private matOther = new THREE.MeshBasicMaterial({ color: 0xf2f2f2 });
  private matDone = new THREE.MeshBasicMaterial({ color: 0x5fd17a, transparent: true, opacity: 0.5 });
  private matDark = new THREE.MeshBasicMaterial({ color: 0x222226 });
  private matLine = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
  private post = new THREE.BoxGeometry(0.35, 4.2, 0.35).translate(0, 2.1, 0);
  private banner = new THREE.BoxGeometry(1, 0.8, 0.12);
  private line = new THREE.PlaneGeometry(1, 0.6).rotateX(-Math.PI / 2);
  private checker: THREE.Texture;
  private matChecker: THREE.MeshBasicMaterial;
  private time = 0;

  constructor() {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 8;
    const g = c.getContext('2d')!;
    for (let i = 0; i < 16; i++)
      for (let j = 0; j < 2; j++) {
        g.fillStyle = (i + j) % 2 ? '#111' : '#fff';
        g.fillRect(i * 4, j * 4, 4, 4);
      }
    this.checker = new THREE.CanvasTexture(c);
    this.checker.colorSpace = THREE.SRGBColorSpace;
    this.checker.magFilter = THREE.NearestFilter;
    this.matChecker = new THREE.MeshBasicMaterial({ map: this.checker });
  }

  private obtain(): THREE.Group {
    let g = this.pool[this.used];
    if (!g) {
      g = new THREE.Group();
      const p1 = new THREE.Mesh(this.post, this.matDark);
      const p2 = new THREE.Mesh(this.post, this.matDark);
      const b = new THREE.Mesh(this.banner, this.matOther);
      const l = new THREE.Mesh(this.line, this.matLine);
      g.add(p1, p2, b, l);
      this.pool.push(g);
      this.group.add(g);
    }
    this.used++;
    g.visible = true;
    return g;
  }

  begin(dt: number): void {
    this.used = 0;
    this.time += dt;
  }

  /** state: 0 upcoming, 1 next, 2 passed, 3 missed */
  draw(track: TrackPath, idx: number, state: number, finish: boolean, ground: HeightSource): void {
    if (idx < track.start || idx >= track.end) return;
    const g = this.obtain();
    const x = track.x(idx),
      z = track.z(idx);
    const dx = track.dx(idx),
      dz = track.dz(idx);
    const hw = track.halfW(idx) + GATE_PAD;
    const rx = -dz,
      rz = dx;
    const [p1, p2, b, l] = g.children as THREE.Mesh[];
    const y1 = ground.heightAt(x + rx * hw, z + rz * hw);
    const y2 = ground.heightAt(x - rx * hw, z - rz * hw);
    const yc = ground.heightAt(x, z);
    p1.position.set(x + rx * hw, y1, z + rz * hw);
    p2.position.set(x - rx * hw, y2, z - rz * hw);
    const by = Math.max(y1, y2) + 3.9;
    b.position.set(x, by, z);
    b.scale.set(hw * 2 + 0.4, state === 1 ? 1.15 + Math.sin(this.time * 6) * 0.12 : 1, 1);
    b.rotation.set(0, Math.atan2(dx, dz), 0);
    b.material = finish ? this.matChecker : state === 1 ? this.matNext : state === 2 ? this.matDone : state === 3 ? this.matDark : this.matOther;
    l.position.set(x, yc + 0.08, z);
    l.scale.set(hw * 2, 1, 1);
    l.rotation.set(0, Math.atan2(dx, dz), 0);
    l.visible = state !== 2;
    l.material = finish ? this.matChecker : this.matLine;
  }

  end(): void {
    for (let i = this.used; i < this.pool.length; i++) this.pool[i].visible = false;
  }
}
