import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Tiny builder for static scenery: collects coloured primitives and merges them into one
 * flat-shaded mesh (plus one unlit "glow" mesh for lights / neon). Few draw calls, no textures.
 */
export class Kit {
  private solid: THREE.BufferGeometry[] = [];
  private glow: THREE.BufferGeometry[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private one = new THREE.Vector3(1, 1, 1);

  private add(g: THREE.BufferGeometry, color: number, x: number, y: number, z: number, rotY: number, glow: boolean, rotX = 0, rotZ = 0): void {
    const geo = g.index ? g.toNonIndexed() : g;
    if (g !== geo) g.dispose();
    geo.deleteAttribute('uv');
    if (geo.getAttribute('normal') && glow) geo.deleteAttribute('normal');
    if (!glow && !geo.getAttribute('normal')) geo.computeVertexNormals();
    const c = new THREE.Color(color);
    const n = geo.attributes.position.count;
    const a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
    this.q.setFromEuler(this.e.set(rotX, rotY, rotZ, 'YXZ'));
    geo.applyMatrix4(this.m.compose(new THREE.Vector3(x, y, z), this.q, this.one));
    (glow ? this.glow : this.solid).push(geo);
  }

  /** box standing on y (its bottom at y) */
  box(w: number, h: number, d: number, x: number, y: number, z: number, color: number, rotY = 0, glow = false): this {
    this.add(new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0), color, x, y, z, rotY, glow);
    return this;
  }

  /** cylinder / tapered cylinder / cone standing on y */
  cyl(rTop: number, rBot: number, h: number, x: number, y: number, z: number, color: number, seg = 10, rotY = 0, glow = false): this {
    this.add(new THREE.CylinderGeometry(rTop, rBot, h, seg).translate(0, h / 2, 0), color, x, y, z, rotY, glow);
    return this;
  }

  /** a 4-sided pyramid (base width w, height h) */
  pyramid(w: number, h: number, x: number, y: number, z: number, color: number, rotY = 0): this {
    this.add(new THREE.ConeGeometry(w / Math.SQRT2, h, 4, 1).rotateY(Math.PI / 4).translate(0, h / 2, 0), color, x, y, z, rotY, false);
    return this;
  }

  sphere(r: number, x: number, y: number, z: number, color: number, glow = false, half = false): this {
    this.add(new THREE.SphereGeometry(r, 14, half ? 6 : 10, 0, Math.PI * 2, 0, half ? Math.PI / 2 : Math.PI), color, x, y, z, 0, glow);
    return this;
  }

  /** any geometry, already shaped */
  geo(g: THREE.BufferGeometry, color: number, x: number, y: number, z: number, rotY = 0, glow = false, rotX = 0, rotZ = 0): this {
    this.add(g, color, x, y, z, rotY, glow, rotX, rotZ);
    return this;
  }

  /** merge into meshes; `fog` false keeps far landmarks visible through the haze */
  build(fog = true): THREE.Group {
    const g = new THREE.Group();
    if (this.solid.length) {
      const geo = mergeGeometries(this.solid, false)!;
      geo.computeVertexNormals();
      g.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, fog })));
    }
    if (this.glow.length) g.add(new THREE.Mesh(mergeGeometries(this.glow, false)!, new THREE.MeshBasicMaterial({ vertexColors: true, fog })));
    for (const x of [...this.solid, ...this.glow]) x.dispose();
    this.solid = [];
    this.glow = [];
    return g;
  }
}

export function disposeGroup(g: THREE.Object3D): void {
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose());
  });
  g.removeFromParent();
}
