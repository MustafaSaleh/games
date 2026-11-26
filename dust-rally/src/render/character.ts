import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

/**
 * Mody, the Dust Rally driver: a rigged GLB shown in its own small transparent canvas.
 * Clips in the file: "Running", "Walking" (in place). Idle, wave and cheer are procedural
 * layers on top of the rest pose, so no extra animation files are needed.
 *
 * Reusable: new CharacterView(container) and call play(...); render loop runs only while active.
 */
export type Gesture = 'idle' | 'wave' | 'cheer';

const MODEL_URL = `${import.meta.env.BASE_URL}models/mody.glb`;
const BONES = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'LeftArm', 'RightArm', 'LeftForeArm', 'RightForeArm', 'LeftHand', 'RightHand'] as const;
type BoneName = (typeof BONES)[number];

const Z = new THREE.Vector3(0, 0, 1);
const Y = new THREE.Vector3(0, 1, 0);
const X = new THREE.Vector3(1, 0, 0);
const _q = new THREE.Quaternion();
const _qp = new THREE.Quaternion();
const _qw = new THREE.Quaternion();

export class CharacterView {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(28, 1, 0.05, 50);
  private root = new THREE.Group();
  private shadow = groundShadow();
  private mixer: THREE.AnimationMixer | null = null;
  private run: THREE.AnimationAction | null = null;
  private bones = new Map<BoneName, THREE.Bone>();
  private rest = new Map<THREE.Bone, THREE.Quaternion>();
  private clipPose = new Map<THREE.Bone, THREE.Quaternion>();
  private hipsRest = new THREE.Vector3();
  private hipsClip = new THREE.Vector3();
  private height = 1;
  private loaded = false;
  private active = false;
  private raf = 0;
  private last = 0;
  private t = 0;

  /* animation state */
  private intro = -1; // seconds into the run-in; -1 = not running
  private clipW = 0; // weight of the clip layer vs the procedural layer
  private gesture: Gesture = 'idle';
  private gestureT = 0;
  private gestureW = 0;
  private lookX = 0;
  private lookTarget = 0;
  private hop = 0;

  /** called once when Mody has arrived (end of intro) */
  onArrive: (() => void) | null = null;

  constructor(private container: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'hero-canvas';
    container.appendChild(this.canvas);
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
    } catch {
      container.classList.add('hero-failed');
      return;
    }
    const r = this.renderer;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    r.setClearColor(0x000000, 0);
    const pm = new THREE.PMREMGenerator(r);
    this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    pm.dispose();

    const key = new THREE.DirectionalLight(0xffe2b8, 2.2);
    key.position.set(2, 3, 3);
    const rim = new THREE.DirectionalLight(0xff8a4a, 1.6);
    rim.position.set(-3, 2, -2.5);
    this.scene.add(new THREE.HemisphereLight(0xfff1dc, 0x5a3520, 0.9), key, rim, this.root, this.shadow);

    new ResizeObserver(() => this.resize()).observe(container);
    container.addEventListener('pointermove', (e) => {
      const b = container.getBoundingClientRect();
      this.lookTarget = THREE.MathUtils.clamp(((e.clientX - b.left) / b.width - 0.5) * 2, -1, 1);
    });
    container.addEventListener('pointerleave', () => (this.lookTarget = 0));
    document.addEventListener('visibilitychange', () => this.updateLoop());
    if (import.meta.env.DEV) (window as unknown as { __mody: CharacterView }).__mody = this;
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
      const gltf = await loader.loadAsync(MODEL_URL);
      const model = gltf.scene;
      model.traverse((o) => {
        const b = o as THREE.Bone;
        if (b.isBone) {
          const name = b.name.replace(/^mixamorig:?/, '') as BoneName;
          if (BONES.includes(name)) this.bones.set(name, b);
          this.rest.set(b, b.quaternion.clone());
          this.clipPose.set(b, new THREE.Quaternion());
        }
        const m = o as THREE.SkinnedMesh;
        if (m.isMesh) m.frustumCulled = false;
      });
      const hips = this.bones.get('Hips');
      if (hips) this.hipsRest.copy(hips.position);
      // normalise: feet on y=0, centred, 1 unit = model height
      model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      this.height = size.y;
      model.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
      this.root.add(model);
      this.shadow.scale.setScalar(this.height * 0.55);
      this.mixer = new THREE.AnimationMixer(model);
      const clip = gltf.animations.find((a) => /run/i.test(a.name)) ?? gltf.animations[0];
      if (clip) {
        // in-place clip: keep hips over the root
        this.run = this.mixer.clipAction(clip);
        this.run.play();
      }
      this.loaded = true;
      this.resize();
      this.container.classList.add('hero-ready');
      this.updateLoop();
    } catch (e) {
      console.warn('Mody failed to load', e);
      this.container.classList.add('hero-failed');
    }
  }

  /** Start/stop rendering (e.g. when the menu screen changes). */
  setActive(on: boolean): void {
    this.active = on;
    this.updateLoop();
  }

  /** Run in from the side, then turn to the camera and wave. */
  playIntro(): void {
    this.intro = 0;
    this.clipW = 1;
    this.gesture = 'idle';
  }

  play(g: Gesture): void {
    if (this.intro >= 0) return;
    this.gesture = g;
    this.gestureT = 0;
    if (g === 'cheer') this.hop = 0;
  }

  private updateLoop(): void {
    const want = this.active && this.loaded && !document.hidden && !!this.renderer;
    if (want && !this.raf) {
      this.last = performance.now();
      this.raf = requestAnimationFrame(this.frame);
    } else if (!want && this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  private frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = THREE.MathUtils.clamp((now - this.last) / 1000, 0, 0.05);
    this.last = now;
    this.update(dt);
    this.renderer!.render(this.scene, this.camera);
  };

  private resize(): void {
    if (!this.renderer) return;
    const w = Math.max(1, this.container.clientWidth),
      h = Math.max(1, this.container.clientHeight);
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // fit the full body (plus room for the cheer jump) vertically, and his width horizontally
    const H = this.height * 1.3;
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const distV = H / 2 / Math.tan(fov / 2);
    const distH = (this.height * 0.75) / 2 / Math.tan(fov / 2) / this.camera.aspect;
    const d = Math.max(distV, distH);
    const cy = this.height * 0.47;
    this.camera.position.set(0, cy + this.height * 0.08, d);
    this.camera.lookAt(0, cy, 0);
    this.camera.updateProjectionMatrix();
  }

  /** visible half-width of the view at the character's depth */
  private viewHalfWidth(): number {
    const d = this.camera.position.z;
    return d * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * this.camera.aspect;
  }

  private update(dt: number): void {
    this.t += dt;
    const ease = (x: number) => x * x * (3 - 2 * x);

    // ---- intro: run in from the right, slow down, turn to camera, wave ----
    if (this.intro >= 0) {
      this.intro += dt;
      const RUN = 1.15,
        TURN = 0.45;
      const startX = this.viewHalfWidth() + this.height * 0.5;
      if (this.intro < RUN) {
        const k = this.intro / RUN;
        this.root.position.x = startX * (1 - (1 - (1 - k) * (1 - k))); // decelerating
        this.root.rotation.y = -Math.PI / 2;
        this.clipW = 1;
        if (this.run) this.run.timeScale = 1.15 - 0.35 * k;
      } else {
        const k = Math.min(1, (this.intro - RUN) / TURN);
        this.root.position.x = 0;
        this.root.rotation.y = -Math.PI / 2 * (1 - ease(k));
        this.clipW = 1 - ease(k);
        if (k >= 1) {
          this.intro = -1;
          this.gesture = 'wave';
          this.gestureT = 0;
          this.onArrive?.();
        }
      }
    } else {
      this.root.position.x = 0;
      this.clipW = Math.max(0, this.clipW - dt * 4);
      this.root.rotation.y = THREE.MathUtils.damp(this.root.rotation.y, this.lookX * 0.12, 4, dt);
    }

    // ---- clip layer ----
    if (this.mixer && this.clipW > 0) {
      this.mixer.update(dt);
      for (const [b, q] of this.clipPose) q.copy(b.quaternion);
      const hips = this.bones.get('Hips');
      if (hips) this.hipsClip.copy(hips.position);
    }

    // ---- procedural layer ----
    this.gestureT += dt;
    const g = this.gesture;
    const dur = g === 'wave' ? 2.2 : g === 'cheer' ? 2.6 : Infinity;
    if (this.gestureT > dur) {
      this.gesture = 'idle';
      this.gestureT = 0;
    }
    const inG = this.gesture === 'idle' ? 0 : Math.min(1, this.gestureT / 0.3, (dur - this.gestureT) / 0.4);
    this.gestureW = THREE.MathUtils.damp(this.gestureW, inG, 14, dt);
    this.lookX = THREE.MathUtils.damp(this.lookX, this.lookTarget, 3, dt);
    this.pose(this.gesture, this.gestureW);

    // ---- blend in the clip ----
    if (this.clipW > 0) {
      for (const [b, q] of this.clipPose) b.quaternion.slerp(q, this.clipW);
      const hips = this.bones.get('Hips');
      if (hips) hips.position.lerpVectors(this.hipsRest, this.hipsClip, this.clipW);
    }
  }

  /** Rotate `bone` by `angle` around a world-space axis, on top of its current local rotation. */
  private turn(name: BoneName, axis: THREE.Vector3, angle: number): void {
    const b = this.bones.get(name);
    if (!b || !b.parent || angle === 0) return;
    b.parent.updateWorldMatrix(true, false);
    b.parent.getWorldQuaternion(_qp);
    _qw.setFromAxisAngle(axis, angle);
    // local = parent^-1 * world * parent * local
    _q.copy(_qp).invert().multiply(_qw).multiply(_qp);
    b.quaternion.premultiply(_q);
  }

  private pose(g: Gesture, w: number): void {
    const t = this.t;
    for (const [b, q] of this.rest) b.quaternion.copy(q);
    const hips = this.bones.get('Hips');
    if (hips) hips.position.copy(this.hipsRest);
    // the model faces +Z; turn() axes are in world space, so undo the root yaw for the arm axes
    const fwd = Z.clone().applyAxisAngle(Y, this.root.rotation.y);
    const side = X.clone().applyAxisAngle(Y, this.root.rotation.y);

    // idle: breathe, sway, relaxed arms, look toward the pointer
    const breathe = Math.sin(t * 2.1);
    this.turn('Spine', side, 0.025 * breathe);
    this.turn('Spine1', fwd, 0.03 * Math.sin(t * 0.9));
    this.turn('Head', Y, 0.35 * this.lookX + 0.08 * Math.sin(t * 0.7));
    this.turn('Head', side, -0.04 + 0.03 * Math.sin(t * 1.3));
    const armDown = 0.62 + 0.03 * breathe;
    let la = -armDown,
      ra = armDown;

    if (g === 'wave' && w > 0) {
      ra = THREE.MathUtils.lerp(ra, -1.4, w); // right arm up beside the head
    }
    if (g === 'cheer' && w > 0) {
      la = THREE.MathUtils.lerp(la, 1.4, w);
      ra = THREE.MathUtils.lerp(ra, -1.4, w);
    }
    this.turn('LeftArm', fwd, la);
    this.turn('RightArm', fwd, ra);
    // slight inward elbow bend at rest
    this.turn('LeftForeArm', Y, 0.25 * (1 - w));
    this.turn('RightForeArm', Y, -0.25 * (1 - w));
    if (g === 'wave' && w > 0) {
      this.turn('RightForeArm', fwd, w * (-0.6 + 0.32 * Math.sin(this.gestureT * 11)));
      this.turn('RightHand', fwd, w * 0.2 * Math.sin(this.gestureT * 11 + 0.6));
      this.turn('Head', fwd, w * -0.08);
    }
    if (g === 'cheer' && w > 0) {
      const p = Math.abs(Math.sin(this.gestureT * 6));
      this.turn('LeftForeArm', fwd, w * (0.3 + 0.2 * p));
      this.turn('RightForeArm', fwd, -w * (0.3 + 0.2 * p));
      this.hop = w * p * 0.09;
    } else this.hop = 0;
    this.root.position.y = this.hop * this.height;
    this.shadow.position.x = this.root.position.x;
    this.shadow.scale.setScalar(this.height * 0.55 * (1 - this.hop * 2.5));
  }
}

/** soft round shadow under the feet */
function groundShadow(): THREE.Mesh {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(0,0,0,0.45)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.6), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.002;
  return m;
}
