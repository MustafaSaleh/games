import * as THREE from 'three';
import type { PropType } from '../config/biomes';
import { PROP_TYPES, propGeometry } from '../render/models';
import type { Chunk, Terrain } from './terrain';

const CAPACITY: Record<PropType, number> = {
  pine: 6000,
  round: 2500,
  rock: 3500,
  pebble: 7000,
  bush: 4000,
  shrub: 4000,
  cactus: 1500,
  marker: 1500,
};

/**
 * One InstancedMesh (one geometry, one material) per prop type for the whole world.
 * Whenever the set of visible chunks changes, the per-chunk prebuilt matrices are
 * copied into the instance buffers (a few memcpy's, no allocation).
 */
export class PropRenderer {
  readonly group = new THREE.Group();
  readonly meshes = {} as Record<PropType, THREE.InstancedMesh>;
  readonly material: THREE.MeshLambertMaterial;
  /** markers are unlit so they read like reflectors at night */
  readonly unlit = new THREE.MeshBasicMaterial({ vertexColors: true });
  private visible: Chunk[] = [];
  private prevVisible: Chunk[] = [];
  private lastVersion = -1;
  private frustum = new THREE.Frustum();
  private projView = new THREE.Matrix4();
  instances = 0;

  constructor() {
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    for (const t of PROP_TYPES) {
      const m = new THREE.InstancedMesh(propGeometry(t), t === 'marker' ? this.unlit : this.material, CAPACITY[t]);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY[t] * 3), 3);
      m.instanceColor.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      m.frustumCulled = false; // culled per chunk below
      this.meshes[t] = m;
      this.group.add(m);
    }
  }

  /** Per-chunk frustum culling; rebuild instance buffers only if the visible set changed. */
  update(terrain: Terrain, camera: THREE.Camera): void {
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    const vis = this.visible;
    vis.length = 0;
    for (const c of terrain.chunks.values()) if (c.ready && this.frustum.intersectsBox(c.box)) vis.push(c);
    let changed = terrain.version !== this.lastVersion || vis.length !== this.prevVisible.length;
    if (!changed) for (let i = 0; i < vis.length; i++) if (vis[i] !== this.prevVisible[i]) changed = true;
    if (!changed) return;
    this.lastVersion = terrain.version;
    this.prevVisible.length = 0;
    for (const c of vis) this.prevVisible.push(c);
    this.rebuild(vis);
  }

  private rebuild(chunks: Chunk[]): void {
    let total = 0;
    for (const t of PROP_TYPES) {
      const mesh = this.meshes[t];
      const mat = mesh.instanceMatrix.array as Float32Array;
      const col = mesh.instanceColor!.array as Float32Array;
      const cap = CAPACITY[t];
      let n = 0;
      for (const c of chunks) {
        const b = c.props[t];
        const k = Math.min(b.count, cap - n);
        if (k <= 0) continue;
        mat.set(b.mat.subarray(0, k * 16), n * 16);
        col.set(b.col.subarray(0, k * 3), n * 3);
        n += k;
      }
      mesh.count = n;
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, n * 16);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor!.clearUpdateRanges();
      mesh.instanceColor!.addUpdateRange(0, n * 3);
      mesh.instanceColor!.needsUpdate = true;
      total += n;
    }
    this.instances = total;
  }

  dispose(): void {
    for (const t of PROP_TYPES) {
      this.meshes[t].geometry.dispose();
      this.meshes[t].dispose();
    }
    this.material.dispose();
    this.unlit.dispose();
  }
}
