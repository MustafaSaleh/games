import * as THREE from 'three';
import { DYNAMIC_RES, type QualityPreset } from '../config/quality';
import { LIGHTING, type LightingPreset, type TimeOfDay } from '../config/lighting';
import { lerp } from '../core/math';
import type { RGB } from '../world/world';

/**
 * WebGL renderer + scene + lights + dynamic resolution.
 * DPR is capped at 2 (and by the quality preset) and stepped down when fps drops.
 */
export class Renderer3D {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  readonly sun = new THREE.DirectionalLight(0xffffff, 1);
  readonly fog = new THREE.Fog(0xffffff, 100, 250);
  quality: QualityPreset;
  private dprStep = 0;
  private fpsAcc = 0;
  private fpsFrames = 0;
  private goodTime = 0;
  private cooldown = 0;
  fps = 60;
  /** current blended lighting values */
  readonly light = { headlights: 0, vignette: 0.4, level: 1 };

  constructor(canvas: HTMLCanvasElement, quality: QualityPreset) {
    this.quality = quality;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: quality.antialias, powerPreference: 'high-performance', stencil: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = false;
    this.scene.fog = this.fog;
    this.scene.add(this.hemi, this.sun, this.sun.target);
    this.scene.matrixWorldAutoUpdate = true;
    this.setQuality(quality);
  }

  setQuality(q: QualityPreset): void {
    this.quality = q;
    this.dprStep = 0;
    this.applyDpr();
  }

  get dpr(): number {
    const steps = this.quality.dprSteps;
    const cap = Math.min(2, window.devicePixelRatio || 1, this.quality.maxDpr);
    return Math.min(cap, steps[Math.min(this.dprStep, steps.length - 1)]);
  }

  private applyDpr(): void {
    this.renderer.setPixelRatio(this.dpr);
    this.resize();
  }

  resize(): void {
    const w = window.innerWidth,
      h = window.innerHeight;
    this.renderer.setSize(w, h, false);
  }

  /** Feed frame times; steps resolution down/up with hysteresis. */
  monitor(frameDt: number): void {
    this.fpsAcc += frameDt;
    this.fpsFrames++;
    this.cooldown -= frameDt;
    if (this.fpsAcc < DYNAMIC_RES.sampleSeconds) return;
    this.fps = this.fpsFrames / this.fpsAcc;
    this.fpsAcc = 0;
    this.fpsFrames = 0;
    const steps = this.quality.dprSteps;
    if (this.fps < DYNAMIC_RES.downFps && this.dprStep < steps.length - 1 && this.cooldown <= 0) {
      this.dprStep++;
      this.cooldown = DYNAMIC_RES.cooldownSeconds;
      this.goodTime = 0;
      this.applyDpr();
    } else if (this.fps > DYNAMIC_RES.upFps && this.dprStep > 0) {
      this.goodTime += DYNAMIC_RES.sampleSeconds;
      if (this.goodTime >= DYNAMIC_RES.upHoldSeconds && this.cooldown <= 0) {
        this.dprStep--;
        this.goodTime = 0;
        this.cooldown = DYNAMIC_RES.cooldownSeconds * 2;
        this.applyDpr();
      }
    } else this.goodTime = 0;
  }

  private ca = new THREE.Color();
  private cb = new THREE.Color();

  /** Blend two lighting presets and apply with the biome fog colour. */
  applyLighting(a: TimeOfDay, b: TimeOfDay, t: number, biomeFog: RGB, camDist: number): void {
    const A = LIGHTING[a],
      B = LIGHTING[b];
    const mixC = (x: number, y: number, out: THREE.Color) => out.setHex(x).lerp(this.cb.setHex(y), t);
    mixC(A.sunColor, B.sunColor, this.sun.color);
    this.sun.intensity = lerp(A.sunIntensity, B.sunIntensity, t);
    this.sun.position.set(lerp(A.sunDir[0], B.sunDir[0], t), lerp(A.sunDir[1], B.sunDir[1], t), lerp(A.sunDir[2], B.sunDir[2], t)).multiplyScalar(100);
    mixC(A.hemiSky, B.hemiSky, this.hemi.color);
    mixC(A.hemiGround, B.hemiGround, this.hemi.groundColor);
    this.hemi.intensity = lerp(A.hemiIntensity, B.hemiIntensity, t);
    mixC(A.fogTint, B.fogTint, this.ca);
    this.fog.color.setRGB(biomeFog[0] * this.ca.r, biomeFog[1] * this.ca.g, biomeFog[2] * this.ca.b);
    this.fog.near = camDist + lerp(A.fogNear, B.fogNear, t);
    this.fog.far = camDist + lerp(A.fogFar, B.fogFar, t);
    this.scene.background = this.fog.color;
    this.light.headlights = lerp(A.headlights, B.headlights, t);
    this.light.vignette = lerp(A.vignette, B.vignette, t);
    this.light.level = lerp(lightLevel(A), lightLevel(B), t);
  }

  render(camera: THREE.Camera): void {
    this.renderer.render(this.scene, camera);
  }
}

function lightLevel(p: LightingPreset): number {
  return Math.min(1, (p.sunIntensity * 0.5 + p.hemiIntensity * 0.6) / 1.6);
}
