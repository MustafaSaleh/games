import * as THREE from 'three';
import { mulberry32 } from '../core/rng';

/**
 * Distant mountain ranges: two jagged rings around the camera, drawn behind everything
 * (no depth write), fading into the fog colour with snow on the high peaks.
 * Only visible from the chase camera (the top-down camera never sees the horizon).
 */
export class Skyline {
  readonly group = new THREE.Group();
  private mat: THREE.ShaderMaterial;

  constructor(seed = 7) {
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uFog: { value: new THREE.Color(0xb4c8c4) },
        uRock: { value: new THREE.Color(0x4f6470) },
        uRockFar: { value: new THREE.Color(0x7d93a3) },
        uSnow: { value: new THREE.Color(0xf2f6fa) },
      },
      vertexShader: `attribute vec3 aInfo; varying vec3 vInfo;
        void main(){ vInfo = aInfo; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      // aInfo: x = 0 bottom .. 1 top of this ridge column, y = snow amount, z = 0 near ring / 1 far ring
      fragmentShader: `uniform vec3 uFog; uniform vec3 uRock; uniform vec3 uRockFar; uniform vec3 uSnow; varying vec3 vInfo;
        void main(){
          vec3 rock = mix(uRock, uRockFar, vInfo.z);
          vec3 c = mix(rock * (0.8 + 0.35 * vInfo.x), uSnow, smoothstep(0.55, 0.8, vInfo.y));
          float haze = mix(0.25, 0.55, vInfo.z) + (1.0 - vInfo.x) * 0.45;
          gl_FragColor = vec4(mix(c, uFog, clamp(haze, 0.0, 1.0)), 1.0);
          #include <colorspace_fragment>
        }`,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    const rnd = mulberry32(seed);
    for (const [ring, radius, base, height] of [
      [1, 620, 30, 150],
      [0, 500, 20, 105],
    ] as const) {
      const mesh = new THREE.Mesh(ridge(radius, base, height, ring, rnd), this.mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = ring ? -11 : -10; // far range first, near range over it
      this.group.add(mesh);
    }
    this.group.visible = false;
  }

  setColors(c: { rock: number; rockFar: number; snow: number }): void {
    this.mat.uniforms.uRock.value.setHex(c.rock);
    this.mat.uniforms.uRockFar.value.setHex(c.rockFar);
    this.mat.uniforms.uSnow.value.setHex(c.snow);
  }

  /** follow the camera (so the mountains stay on the horizon) and blend with the fog */
  update(camX: number, groundY: number, camZ: number, fogLinear: THREE.Color): void {
    this.group.position.set(camX, groundY - 25, camZ);
    this.mat.uniforms.uFog.value.copy(fogLinear);
  }
}

/** a ring of peaks: columns from below the horizon up to a jagged ridge line */
function ridge(radius: number, base: number, height: number, far: number, rnd: () => number): THREE.BufferGeometry {
  const N = 180;
  // ridge profile: a few sine octaves with random phases, sharpened into peaks
  const ph = Array.from({ length: 6 }, () => rnd() * Math.PI * 2);
  const prof = (a: number) => {
    let v = 0.5 * Math.sin(a * 3 + ph[0]) + 0.3 * Math.sin(a * 7 + ph[1]) + 0.2 * Math.sin(a * 13 + ph[2]) + 0.12 * Math.sin(a * 29 + ph[3]) + 0.06 * Math.sin(a * 53 + ph[4]);
    v = 1 - Math.abs(v); // ridged
    return Math.max(0, v * v);
  };
  const pos: number[] = [],
    info: number[] = [],
    idx: number[] = [];
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * Math.PI * 2;
    const h = base + prof(a) * height;
    const x = Math.sin(a) * radius,
      z = Math.cos(a) * radius;
    const snow = h / (base + height);
    pos.push(x, -60, z, x, h * 0.45, z, x, h, z);
    info.push(0, snow * 0.2, far, 0.45, snow * 0.6, far, 1, snow, far);
    if (i < N) {
      const o = i * 3;
      for (const [p, q] of [
        [0, 1],
        [1, 2],
      ])
        idx.push(o + p, o + 3 + p, o + q, o + q, o + 3 + p, o + 3 + q);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aInfo', new THREE.Float32BufferAttribute(info, 3));
  g.setIndex(idx);
  return g;
}
