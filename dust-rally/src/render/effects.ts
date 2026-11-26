import * as THREE from 'three';
import type { RGB } from '../world/world';

/** Anything that can give terrain height. */
export interface HeightSource {
  heightAt(x: number, z: number): number;
}

/* ------------------------------------------------------------------ */
/* Terrain-hugging grid (used by headlight cone and blob shadow)        */
/* ------------------------------------------------------------------ */
class DrapedGrid {
  readonly geo = new THREE.BufferGeometry();
  readonly local: Float32Array; // local x,z per vertex
  readonly pos: Float32Array;

  constructor(
    readonly cols: number,
    readonly rows: number,
    makeLocal: (u: number, v: number, out: [number, number]) => void,
  ) {
    const n = (cols + 1) * (rows + 1);
    this.local = new Float32Array(n * 2);
    this.pos = new Float32Array(n * 3);
    const uv = new Float32Array(n * 2);
    const tmp: [number, number] = [0, 0];
    for (let j = 0; j <= rows; j++)
      for (let i = 0; i <= cols; i++) {
        const k = j * (cols + 1) + i;
        const u = i / cols,
          v = j / rows;
        makeLocal(u, v, tmp);
        this.local[k * 2] = tmp[0];
        this.local[k * 2 + 1] = tmp[1];
        uv[k * 2] = u;
        uv[k * 2 + 1] = v;
      }
    const idx: number[] = [];
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const a = j * (cols + 1) + i,
          b = a + 1,
          c = a + cols + 1,
          d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    this.geo.setIndex(idx);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  }

  /** Place grid at (x,z) rotated by heading, draped on terrain. */
  drape(x: number, z: number, heading: number, lift: number, ground: HeightSource, minY = -1e9): void {
    const s = Math.sin(heading),
      c = Math.cos(heading);
    const n = this.local.length / 2;
    for (let k = 0; k < n; k++) {
      const lx = this.local[k * 2],
        lz = this.local[k * 2 + 1];
      // local +z = forward, local +x = left (matches car model)
      const wx = x + lx * c + lz * s;
      const wz = z - lx * s + lz * c;
      this.pos[k * 3] = wx;
      this.pos[k * 3 + 1] = Math.max(minY, ground.heightAt(wx, wz)) + lift;
      this.pos[k * 3 + 2] = wz;
    }
    this.geo.attributes.position.needsUpdate = true;
  }
}

/* ------------------------------------------------------------------ */
/* Fake volumetric headlights: additive gradient mesh on the ground     */
/* ------------------------------------------------------------------ */
export const HEADLIGHT = {
  length: 30,
  spread: 0.36, // half-angle tan
  startWidth: 1.6,
  color: 0xfff1d6,
  intensity: 0.6,
};

export class Headlights {
  readonly group = new THREE.Group();
  private cone: DrapedGrid;
  private mat: THREE.ShaderMaterial;
  private glow: THREE.Mesh;
  private tail: THREE.Mesh;

  constructor() {
    this.cone = new DrapedGrid(8, 10, (u, v, out) => {
      const d = 1.6 + v * HEADLIGHT.length;
      const half = HEADLIGHT.startWidth / 2 + v * HEADLIGHT.length * HEADLIGHT.spread;
      out[0] = (u - 0.5) * 2 * half;
      out[1] = d;
    });
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(HEADLIGHT.color) }, uIntensity: { value: 0 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 uColor; uniform float uIntensity; varying vec2 vUv;
        void main(){
          float x = abs(vUv.x * 2.0 - 1.0);
          float across = pow(max(0.0, 1.0 - x * x), 1.6);
          float along = smoothstep(0.0, 0.15, vUv.y) * pow(1.0 - vUv.y, 1.6);
          float hot = exp(-vUv.y * 6.0) * (1.0 - x) * 0.5;
          float i = (across * along + hot) * uIntensity;
          gl_FragColor = vec4(uColor * i, 1.0);
          #include <colorspace_fragment>
        }`,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    const coneMesh = new THREE.Mesh(this.cone.geo, this.mat);
    coneMesh.frustumCulled = false;
    coneMesh.renderOrder = 2;
    this.group.add(coneMesh);
    // lamp glow + tail lights (simple additive radial sprites)
    this.glow = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 2.2), radialMaterial(0xfff4dd));
    this.tail = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.4), radialMaterial(0xff2020));
    for (const m of [this.glow, this.tail]) {
      m.rotation.x = -Math.PI / 2;
      m.frustumCulled = false;
      m.renderOrder = 3;
      this.group.add(m);
    }
  }

  update(x: number, z: number, y: number, heading: number, strength: number, ground: HeightSource, airborne: boolean): void {
    this.group.visible = strength > 0.02;
    if (!this.group.visible) return;
    this.mat.uniforms.uIntensity.value = strength * HEADLIGHT.intensity * (airborne ? 0.7 : 1);
    this.cone.drape(x, z, heading, 0.12, ground);
    const s = Math.sin(heading),
      c = Math.cos(heading);
    this.glow.position.set(x + s * 2.3, y + 0.9, z + c * 2.3);
    this.glow.rotation.z = heading;
    (this.glow.material as THREE.ShaderMaterial).uniforms.uIntensity.value = strength * 0.9;
    this.tail.position.set(x - s * 2.2, y + 0.75, z - c * 2.2);
    this.tail.rotation.z = heading;
    (this.tail.material as THREE.ShaderMaterial).uniforms.uIntensity.value = strength * 0.6;
  }
}

function radialMaterial(hex: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(hex) }, uIntensity: { value: 1 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 uColor; uniform float uIntensity; varying vec2 vUv;
      void main(){ vec2 p = vUv * 2.0 - 1.0; float d = dot(p,p); float a = max(0.0, 1.0 - d); a *= a;
        gl_FragColor = vec4(uColor * a * uIntensity, 1.0);
        #include <colorspace_fragment>
      }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    fog: false,
  });
}

/* ------------------------------------------------------------------ */
/* Blob shadow                                                          */
/* ------------------------------------------------------------------ */
export class BlobShadow {
  readonly mesh: THREE.Mesh;
  private grid: DrapedGrid;
  private mat: THREE.ShaderMaterial;

  constructor() {
    this.grid = new DrapedGrid(4, 4, (u, v, out) => {
      out[0] = (u - 0.5) * 2.9;
      out[1] = (v - 0.5) * 5.0;
    });
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uOpacity: { value: 0.5 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform float uOpacity; varying vec2 vUv;
        void main(){ vec2 p = vUv * 2.0 - 1.0; p = abs(p); float d = pow(pow(p.x, 4.0) + pow(p.y, 4.0), 0.25);
          float a = 1.0 - smoothstep(0.45, 1.0, d); gl_FragColor = vec4(0.0, 0.0, 0.0, a * uOpacity); }`,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.mesh = new THREE.Mesh(this.grid.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  update(x: number, z: number, heading: number, heightAbove: number, ground: HeightSource, level: number): void {
    this.grid.drape(x, z, heading, 0.05, ground);
    this.mat.uniforms.uOpacity.value = (0.55 * Math.max(0, 1 - heightAbove / 8)) * (0.4 + 0.6 * level);
  }
}

/* ------------------------------------------------------------------ */
/* Tire marks: ring buffer of quads                                     */
/* ------------------------------------------------------------------ */
export class TireMarks {
  readonly mesh: THREE.Mesh;
  private pos: Float32Array;
  private col: Float32Array;
  private cap: number;
  private head = 0;
  private last: { x: number; z: number; lx: number; lz: number; rx: number; rz: number; y0: number; y1: number; on: boolean }[] = [];
  private dirtyFrom = -1;
  private dirtyTo = -1;

  constructor(cap: number) {
    this.cap = cap;
    this.pos = new Float32Array(cap * 4 * 3);
    this.col = new Float32Array(cap * 4 * 4);
    const idx = new Uint32Array(cap * 6);
    for (let i = 0; i < cap; i++) {
      const v = i * 4;
      idx.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], i * 6);
    }
    const geo = new THREE.BufferGeometry();
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    // 0,1 = player 1 rear wheels; 2,3 = split-screen player 2
    for (let w = 0; w < 4; w++) this.last.push({ x: 0, z: 0, lx: 0, lz: 0, rx: 0, rz: 0, y0: 0, y1: 0, on: false });
  }

  clear(): void {
    this.col.fill(0);
    this.head = 0;
    for (const l of this.last) l.on = false;
    (this.mesh.geometry.attributes.color as THREE.BufferAttribute).clearUpdateRanges();
    this.mesh.geometry.attributes.color.needsUpdate = true;
  }

  /** wheel: 0 = rear-left, 1 = rear-right (2, 3 for player 2). alpha 0 breaks the trail. */
  add(wheel: number, x: number, z: number, dirX: number, dirZ: number, alpha: number, color: RGB, ground: HeightSource): void {
    const L = this.last[wheel];
    if (alpha <= 0.01) {
      L.on = false;
      return;
    }
    const hw = 0.17;
    const px = -dirZ * hw,
      pz = dirX * hw;
    const y = ground.heightAt(x, z) + 0.035;
    if (!L.on) {
      L.on = true;
      L.x = x;
      L.z = z;
      L.lx = x + px;
      L.lz = z + pz;
      L.rx = x - px;
      L.rz = z - pz;
      L.y0 = y;
      return;
    }
    const dx = x - L.x,
      dz = z - L.z;
    if (dx * dx + dz * dz < 0.36) return;
    if (dx * dx + dz * dz > 25) {
      // teleport / big gap: restart trail
      L.on = false;
      return;
    }
    const i = this.head;
    this.head = (this.head + 1) % this.cap;
    const p = this.pos,
      o = i * 12;
    p[o] = L.lx;
    p[o + 1] = L.y0;
    p[o + 2] = L.lz;
    p[o + 3] = L.rx;
    p[o + 4] = L.y0;
    p[o + 5] = L.rz;
    p[o + 6] = x + px;
    p[o + 7] = y;
    p[o + 8] = z + pz;
    p[o + 9] = x - px;
    p[o + 10] = y;
    p[o + 11] = z - pz;
    const c = this.col,
      co = i * 16;
    for (let v = 0; v < 4; v++) {
      c[co + v * 4] = color[0];
      c[co + v * 4 + 1] = color[1];
      c[co + v * 4 + 2] = color[2];
      c[co + v * 4 + 3] = alpha;
    }
    L.x = x;
    L.z = z;
    L.lx = x + px;
    L.lz = z + pz;
    L.rx = x - px;
    L.rz = z - pz;
    L.y0 = y;
    if (this.dirtyFrom < 0) this.dirtyFrom = this.dirtyTo = i;
    else if (i < this.dirtyFrom) this.dirtyFrom = 0, (this.dirtyTo = this.cap - 1);
    else this.dirtyTo = i;
  }

  flush(): void {
    if (this.dirtyFrom < 0) return;
    const g = this.mesh.geometry;
    const pa = g.attributes.position as THREE.BufferAttribute,
      ca = g.attributes.color as THREE.BufferAttribute;
    pa.clearUpdateRanges();
    ca.clearUpdateRanges();
    pa.addUpdateRange(this.dirtyFrom * 12, (this.dirtyTo - this.dirtyFrom + 1) * 12);
    ca.addUpdateRange(this.dirtyFrom * 16, (this.dirtyTo - this.dirtyFrom + 1) * 16);
    pa.needsUpdate = true;
    ca.needsUpdate = true;
    this.dirtyFrom = this.dirtyTo = -1;
  }
}

/* ------------------------------------------------------------------ */
/* Particles: pooled point sprites (dust / sand / snow / sparks)       */
/* ------------------------------------------------------------------ */
export class Particles {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private colA: Float32Array; // rgba
  private size: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private baseSize: Float32Array;
  private baseAlpha: Float32Array;
  private cap: number;
  private next = 0;
  readonly mat: THREE.ShaderMaterial;
  alive = 0;

  constructor(cap: number) {
    this.cap = cap;
    this.pos = new Float32Array(cap * 3);
    this.colA = new Float32Array(cap * 4);
    this.size = new Float32Array(cap);
    this.vel = new Float32Array(cap * 3);
    this.life = new Float32Array(cap);
    this.maxLife = new Float32Array(cap);
    this.baseSize = new Float32Array(cap);
    this.baseAlpha = new Float32Array(cap);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aCol', new THREE.BufferAttribute(this.colA, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 400 }, uLight: { value: 1 } },
      vertexShader: `attribute vec4 aCol; attribute float aSize; uniform float uScale; varying vec4 vCol;
        void main(){ vCol = aCol; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
          gl_PointSize = min(aSize * uScale / -mv.z, 90.0); }`,
      fragmentShader: `uniform float uLight; varying vec4 vCol;
        void main(){ vec2 p = gl_PointCoord * 2.0 - 1.0; float d = dot(p,p); if (d > 1.0) discard;
          gl_FragColor = vec4(vCol.rgb * uLight, vCol.a * (1.0 - d));
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
  }

  clear(): void {
    this.life.fill(0);
    this.size.fill(0);
    this.alive = 0;
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, c: RGB, size: number, life: number, alpha: number): void {
    const i = this.next;
    this.next = (this.next + 1) % this.cap;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.colA[i * 4] = c[0];
    this.colA[i * 4 + 1] = c[1];
    this.colA[i * 4 + 2] = c[2];
    this.colA[i * 4 + 3] = alpha;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.baseSize[i] = size;
    this.baseAlpha[i] = alpha;
    this.size[i] = size;
  }

  update(dt: number): void {
    let alive = 0;
    const drag = Math.exp(-2.2 * dt);
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] <= 0) {
        if (this.size[i] !== 0) this.size[i] = 0;
        continue;
      }
      alive++;
      this.life[i] -= dt;
      const t = 1 - Math.max(0, this.life[i]) / this.maxLife[i];
      const k = i * 3;
      this.vel[k] *= drag;
      this.vel[k + 2] *= drag;
      this.vel[k + 1] = this.vel[k + 1] * drag + 0.6 * dt; // dust rises slightly
      this.pos[k] += this.vel[k] * dt;
      this.pos[k + 1] += this.vel[k + 1] * dt;
      this.pos[k + 2] += this.vel[k + 2] * dt;
      this.size[i] = this.baseSize[i] * (1 + t * 2.2);
      this.colA[i * 4 + 3] = this.baseAlpha[i] * (1 - t) * Math.min(1, t * 8 + 0.2);
      if (this.life[i] <= 0) this.size[i] = 0;
    }
    this.alive = alive;
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aCol.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;
  }
}

/* ------------------------------------------------------------------ */
/* Sparks: additive glowing points + short streaks, with gravity          */
/* ------------------------------------------------------------------ */
export class Sparks {
  readonly group = new THREE.Group();
  private cap: number;
  private pos: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private next = 0;
  private ptPos: Float32Array;
  private ptCol: Float32Array;
  private lnPos: Float32Array;
  private lnCol: Float32Array;
  private points: THREE.Points;
  private lines: THREE.LineSegments;
  readonly ptMat: THREE.ShaderMaterial;
  alive = 0;

  constructor(cap = 220) {
    this.cap = cap;
    this.pos = new Float32Array(cap * 3);
    this.vel = new Float32Array(cap * 3);
    this.life = new Float32Array(cap);
    this.maxLife = new Float32Array(cap);
    this.ptPos = new Float32Array(cap * 3);
    this.ptCol = new Float32Array(cap * 3);
    this.lnPos = new Float32Array(cap * 6);
    this.lnCol = new Float32Array(cap * 6);
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(this.ptPos, 3).setUsage(THREE.DynamicDrawUsage));
    pg.setAttribute('color', new THREE.BufferAttribute(this.ptCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.ptMat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 400 } },
      vertexShader: `attribute vec3 color; uniform float uScale; varying vec3 vCol;
        void main(){ vCol = color; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp(0.6 * uScale / -mv.z, 2.5, 7.0); }`,
      fragmentShader: `varying vec3 vCol;
        void main(){ vec2 p = gl_PointCoord * 2.0 - 1.0; float d = dot(p,p); if (d > 1.0) discard;
          gl_FragColor = vec4(vCol * (1.0 - d) * 1.6, 1.0); }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(pg, this.ptMat);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(this.lnPos, 3).setUsage(THREE.DynamicDrawUsage));
    lg.setAttribute('color', new THREE.BufferAttribute(this.lnCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    for (const o of [this.points, this.lines]) {
      o.frustumCulled = false;
      o.renderOrder = 5;
      this.group.add(o);
    }
  }

  clear(): void {
    this.life.fill(0);
    this.alive = 0;
    this.flush();
  }

  /** a shower of `count` sparks at (x,y,z), thrown mostly along (dirX,dirZ) and upward */
  emit(x: number, y: number, z: number, count: number, power: number, dirX = 0, dirZ = 0): void {
    for (let n = 0; n < count; n++) {
      const i = this.next;
      this.next = (this.next + 1) % this.cap;
      const o = i * 3;
      this.pos[o] = x + (Math.random() - 0.5) * 0.4;
      this.pos[o + 1] = y + (Math.random() - 0.5) * 0.3;
      this.pos[o + 2] = z + (Math.random() - 0.5) * 0.4;
      const a = Math.random() * Math.PI * 2;
      const sp = power * (0.35 + Math.random() * 0.9);
      this.vel[o] = Math.cos(a) * sp * 0.7 + dirX * sp;
      this.vel[o + 1] = 1.5 + Math.random() * power * 0.6;
      this.vel[o + 2] = Math.sin(a) * sp * 0.7 + dirZ * sp;
      this.maxLife[i] = this.life[i] = 0.25 + Math.random() * 0.45;
    }
  }

  update(dt: number, groundAt: (x: number, z: number) => number): void {
    let alive = 0;
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const o = i * 3;
      this.vel[o + 1] -= 16 * dt;
      this.vel[o] *= 1 - 1.5 * dt;
      this.vel[o + 2] *= 1 - 1.5 * dt;
      this.pos[o] += this.vel[o] * dt;
      this.pos[o + 1] += this.vel[o + 1] * dt;
      this.pos[o + 2] += this.vel[o + 2] * dt;
      const g = groundAt(this.pos[o], this.pos[o + 2]) + 0.05;
      if (this.pos[o + 1] < g) {
        // bounce off the ground, losing energy
        this.pos[o + 1] = g;
        this.vel[o + 1] = Math.abs(this.vel[o + 1]) * 0.35;
        this.vel[o] *= 0.6;
        this.vel[o + 2] *= 0.6;
      }
      if (this.life[i] > 0) alive++;
    }
    this.alive = alive;
    this.flush();
  }

  private flush(): void {
    for (let i = 0; i < this.cap; i++) {
      const o = i * 3,
        l = i * 6;
      const k = this.life[i] > 0 ? this.life[i] / this.maxLife[i] : 0;
      // white-hot -> yellow -> orange -> dark red as it cools
      const r = k > 0 ? 1 : 0,
        g = k > 0 ? 0.25 + 0.75 * k : 0,
        b = k > 0 ? 0.1 + 0.6 * k * k : 0;
      const bright = k > 0 ? 0.35 + 0.65 * k : 0;
      this.ptPos[o] = this.pos[o];
      this.ptPos[o + 1] = this.pos[o + 1];
      this.ptPos[o + 2] = this.pos[o + 2];
      this.ptCol[o] = r * bright;
      this.ptCol[o + 1] = g * bright;
      this.ptCol[o + 2] = b * bright;
      // streak: from the spark back along its velocity
      const s = 0.05;
      this.lnPos[l] = this.pos[o];
      this.lnPos[l + 1] = this.pos[o + 1];
      this.lnPos[l + 2] = this.pos[o + 2];
      this.lnPos[l + 3] = this.pos[o] - this.vel[o] * s;
      this.lnPos[l + 4] = this.pos[o + 1] - this.vel[o + 1] * s;
      this.lnPos[l + 5] = this.pos[o + 2] - this.vel[o + 2] * s;
      this.lnCol[l] = r * bright;
      this.lnCol[l + 1] = g * bright;
      this.lnCol[l + 2] = b * bright;
      this.lnCol[l + 3] = r * bright * 0.3;
      this.lnCol[l + 4] = g * bright * 0.2;
      this.lnCol[l + 5] = 0;
    }
    for (const obj of [this.points, this.lines]) {
      const geo = obj.geometry;
      geo.attributes.position.needsUpdate = true;
      geo.attributes.color.needsUpdate = true;
    }
  }
}
