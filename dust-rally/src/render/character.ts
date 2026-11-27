import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { buildCar, disposeCar, type CarModel } from './models';
import { getLivery, getStyle } from '../config/cars';

/**
 * Mody, the Dust Rally driver, and the player's car, in one small transparent canvas.
 *  - home:    the car is parked behind Mody. He sits on its nose swinging his legs, hops
 *             down, waves hi, and after a while hops back up.
 *  - results: he stands in front of the car and cheers / waves.
 *  - garage:  Mody steps away; the car spins on a turntable (drag to rotate it 360°).
 * Idle, sitting, wave and cheer are procedural poses on top of the rest pose (no extra
 * animation files). The render loop runs only while active and the tab is visible.
 */
export type Gesture = 'idle' | 'wave' | 'cheer';
export type StageMode = 'home' | 'results' | 'garage';

const MODEL_URL = `${import.meta.env.BASE_URL}models/mody.glb`;
const BONES = [
  'Hips',
  'Spine',
  'Spine1',
  'Spine2',
  'Neck',
  'Head',
  'LeftArm',
  'RightArm',
  'LeftForeArm',
  'RightForeArm',
  'LeftHand',
  'RightHand',
  'LeftUpLeg',
  'RightUpLeg',
  'LeftLeg',
  'RightLeg',
] as const;
type BoneName = (typeof BONES)[number];

/** home / garage car size relative to the in-game car */
const CAR_SCALE = 0.74;

/** timings of the home routine (seconds) */
const ROUTINE = { firstSit: 3.2, sit: 9, stand: 11, hop: 0.75 };

const Z = new THREE.Vector3(0, 0, 1);
const Y = new THREE.Vector3(0, 1, 0);
const X = new THREE.Vector3(1, 0, 0);
const _q = new THREE.Quaternion();
const _qp = new THREE.Quaternion();
const _qw = new THREE.Quaternion();
const _v = new THREE.Vector3();
const ease = (x: number) => x * x * (3 - 2 * x);

type Phase = 'sit' | 'standUp' | 'stand' | 'sitDown';

export class CharacterView {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 1, 0.05, 60);
  private root = new THREE.Group(); // Mody
  private shadow = groundShadow();
  private carGroup = new THREE.Group();
  private carShadow = groundShadow();
  private car: CarModel | null = null;
  private carKey = '';
  private bones = new Map<BoneName, THREE.Bone>();
  private rest = new Map<THREE.Bone, THREE.Quaternion>();
  private hipsRest = new THREE.Vector3();
  private height = 1.3;
  private hipY = 0.6; // hips above the feet when standing
  private thigh = 0.3;
  private loaded = false;
  private active = false;
  private raf = 0;
  private last = 0;
  private t = 0;

  /* where things are (home / results layout) */
  private carYaw = -0.6;
  private seat = new THREE.Vector3(); // where Mody's hips rest on the car's nose
  private standAt = new THREE.Vector3(); // where he stands in front of it
  private seatY = 0.8;
  private carLen = 4.2;

  /* animation state */
  mode: StageMode = 'home';
  private phase: Phase = 'stand';
  private phaseT = 0;
  private sitW = 0; // 1 = seated pose
  private routine = false; // home sit/stand loop running
  private gesture: Gesture = 'idle';
  private gestureT = 0;
  private gestureW = 0;
  private lookX = 0;
  private lookTarget = 0;
  private hop = 0;
  private firstStand = true;

  /* camera (smoothed toward the mode's framing) */
  private camPos = new THREE.Vector3(0, 1.5, 8);
  private camLook = new THREE.Vector3(0, 0.8, 0);
  private camInit = false;

  /* garage turntable */
  private spin = 0.6;
  private spinVel = 0.45;
  private dragX: number | null = null;
  private lastDrag = 0;

  /** called when Mody has hopped off the car and waves (first time only) */
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
    this.carShadow.material.opacity = 0.8;
    this.carGroup.add(this.carShadow);
    this.scene.add(new THREE.HemisphereLight(0xfff1dc, 0x5a3520, 1.1), key, rim, this.root, this.shadow, this.carGroup);

    new ResizeObserver(() => this.resize()).observe(container);
    container.addEventListener('pointermove', (e) => {
      const b = container.getBoundingClientRect();
      this.lookTarget = THREE.MathUtils.clamp(((e.clientX - b.left) / b.width - 0.5) * 2, -1, 1);
      if (this.dragX != null) {
        const dx = e.clientX - this.dragX;
        this.dragX = e.clientX;
        const now = performance.now();
        const dt = Math.max(1, now - this.lastDrag) / 1000;
        this.lastDrag = now;
        const d = (dx / Math.max(200, b.width)) * Math.PI * 2;
        this.spin += d;
        this.spinVel = THREE.MathUtils.clamp(d / dt, -8, 8);
      }
    });
    container.addEventListener('pointerdown', (e) => {
      if (this.mode !== 'garage') return;
      this.dragX = e.clientX;
      this.lastDrag = performance.now();
      container.setPointerCapture(e.pointerId);
    });
    const endDrag = () => (this.dragX = null);
    container.addEventListener('pointerup', endDrag);
    container.addEventListener('pointercancel', endDrag);
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
        }
        const m = o as THREE.SkinnedMesh;
        if (m.isMesh) m.frustumCulled = false;
      });
      const hips = this.bones.get('Hips');
      if (hips) this.hipsRest.copy(hips.position);
      // normalise: feet on y=0, centred
      model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      this.height = size.y;
      model.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
      this.root.add(model);
      this.root.updateMatrixWorld(true);
      // body measurements for sitting
      if (hips) this.hipY = hips.getWorldPosition(_v).y;
      const ul = this.bones.get('LeftUpLeg'),
        ll = this.bones.get('LeftLeg');
      if (ul && ll) this.thigh = ul.getWorldPosition(new THREE.Vector3()).distanceTo(ll.getWorldPosition(_v));
      this.shadow.scale.setScalar(this.height * 0.55);
      this.loaded = true;
      this.layout();
      this.resize();
      this.container.classList.add('hero-ready');
      this.updateLoop();
    } catch (e) {
      console.warn('Mody failed to load', e);
      this.container.classList.add('hero-failed');
    }
  }

  /** the player's car (rebuilt only when the style / colour changes) */
  setCar(style: string, livery: string): void {
    const key = style + '/' + livery;
    if (key === this.carKey) return;
    this.carKey = key;
    if (this.car) disposeCar(this.car);
    this.car = buildCar(getStyle(style).id, getLivery(livery));
    // the game's cars are chunky; a bit smaller here so Mody (a kid) looks right next to it
    this.car.root.scale.setScalar(CAR_SCALE);
    // measure in the car's own frame, BEFORE it goes onto the (possibly spinning) turntable
    this.car.root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.car.root);
    this.carLen = box.max.z - box.min.z;
    // find the bonnet: scan down from above along the nose; the seat is the highest surface
    // in the front part, and its front edge is where that height starts
    const ray = new THREE.Raycaster();
    ray.camera = this.camera; // sprites (brake-light glows) need a camera to be raycast
    const heights: [number, number][] = [];
    for (let z = box.max.z; z > box.max.z - this.carLen * 0.4; z -= 0.05) {
      ray.set(new THREE.Vector3(0, 10, z), new THREE.Vector3(0, -1, 0));
      const hit = ray.intersectObject(this.car.root, true)[0];
      if (hit) heights.push([z, hit.point.y]);
    }
    // the bonnet = the first flat stretch from the front (before the jump up to the windscreen)
    let edge: [number, number] | undefined;
    for (let i = 0; i + 3 < heights.length; i++) {
      const y = heights[i][1];
      if (Math.abs(heights[i + 1][1] - y) < 0.03 && Math.abs(heights[i + 2][1] - y) < 0.03 && Math.abs(heights[i + 3][1] - y) < 0.03) {
        edge = heights[i];
        break;
      }
    }
    this.seatY = edge ? edge[1] : 0.7;
    this.seatEdgeZ = edge ? edge[0] - 0.04 : box.max.z - 0.4;
    this.carGroup.add(this.car.root);
    this.carShadow.scale.set((box.max.x - box.min.x) * 1.4, (this.carLen * 1.05) / 0.6, 1);
    this.layout();
  }
  private seatEdgeZ = 1.7;

  /** place car, seat and standing spot for the home / results layout */
  private layout(): void {
    const fx = Math.sin(this.carYaw),
      fz = Math.cos(this.carYaw);
    // seat: on the nose, hips set back so the knees reach the edge
    const back = this.thigh * 0.55;
    const seatLocal = this.seatEdgeZ - back;
    // car placed so the seat is near the middle of the view, slightly to the right
    const seatX = 0.25,
      seatZ = 0;
    this.seat.set(seatX, this.seatY, seatZ);
    this.carGroup.userData.home = new THREE.Vector3(seatX - fx * seatLocal, 0, seatZ - fz * seatLocal);
    this.standAt.set(seatX + fx * (back + 0.9) + 0.25, 0, seatZ + fz * (back + 0.9));
  }

  /** Start/stop rendering (e.g. when the menu screen changes). */
  setActive(on: boolean): void {
    this.active = on;
    this.updateLoop();
  }

  setMode(m: StageMode): void {
    if (m === this.mode) return;
    const prev = this.mode;
    this.mode = m;
    if (m === 'garage') {
      this.spin = this.carYaw + 0.6;
      this.spinVel = 0.45;
    }
    if (m === 'results' && this.phase !== 'stand') this.setPhase('standUp');
    if (m === 'home' && prev !== 'home') this.routine = true;
  }

  /** Home: start the routine sitting on the car (first launch). */
  playIntro(): void {
    this.routine = true;
    this.phase = 'sit';
    this.phaseT = ROUTINE.sit - ROUTINE.firstSit;
    this.sitW = 1;
  }

  play(g: Gesture): void {
    if (this.mode === 'garage') return;
    if (this.phase === 'sit' || this.phase === 'sitDown') {
      // tapped while sitting: hop down first, the wave comes after
      this.setPhase('standUp');
      return;
    }
    this.gesture = g;
    this.gestureT = 0;
  }

  private setPhase(p: Phase): void {
    this.phase = p;
    this.phaseT = 0;
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
    this.camera.updateProjectionMatrix();
  }

  /** camera target for the current mode: fit a box of `w` x `h` metres around `look` */
  private framing(outPos: THREE.Vector3, outLook: THREE.Vector3): void {
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const fit = (w: number, h: number) => Math.max(h / 2 / Math.tan(fov / 2), w / 2 / Math.tan(fov / 2) / this.camera.aspect);
    if (this.mode === 'garage') {
      const d = fit(this.carLen * 1.12, 2.4) + this.carLen * 0.3;
      outLook.set(0, 0.62, 0);
      outPos.set(0, 0.62 + d * 0.32, d);
    } else {
      // Mody in front, the car's nose behind him
      const d = fit(2.8, this.height * 1.75) + 1.0;
      outLook.set(0.05, this.height * 0.58, -0.35);
      outPos.set(0.15, outLook.y + d * 0.2, d);
    }
  }

  private update(dt: number): void {
    this.t += dt;
    const garage = this.mode === 'garage';

    // ---- car: parked (home/results) or on the turntable (garage) ----
    const home = this.carGroup.userData.home as THREE.Vector3 | undefined;
    if (garage) {
      if (this.dragX == null) {
        this.spinVel = THREE.MathUtils.damp(this.spinVel, 0.45, 1.2, dt); // settle back to a slow spin
        this.spin += this.spinVel * dt;
      }
      this.carGroup.position.lerp(_v.set(0, 0, 0), 1 - Math.exp(-6 * dt));
      this.carGroup.rotation.y = this.spin;
    } else if (home) {
      this.carGroup.position.lerp(home, 1 - Math.exp(-6 * dt));
      this.carGroup.rotation.y = THREE.MathUtils.lerp(this.carGroup.rotation.y, this.carYaw, 1 - Math.exp(-6 * dt));
      this.spin = this.carGroup.rotation.y;
    }
    this.root.visible = this.shadow.visible = !garage;

    // ---- camera ----
    const tp = _v.set(0, 0, 0),
      tl = new THREE.Vector3();
    this.framing(tp, tl);
    if (!this.camInit) {
      this.camPos.copy(tp);
      this.camLook.copy(tl);
      this.camInit = true;
    }
    const k = 1 - Math.exp(-4 * dt);
    this.camPos.lerp(tp, k);
    this.camLook.lerp(tl, k);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
    if (garage) return;

    // ---- home routine: sit on the car, hop down, wave, wander back ----
    this.phaseT += dt;
    if (this.mode === 'home' && this.routine) {
      if (this.phase === 'sit' && this.phaseT > ROUTINE.sit) this.setPhase('standUp');
      else if (this.phase === 'stand' && this.phaseT > ROUTINE.stand && this.gesture === 'idle') this.setPhase('sitDown');
    }
    let k2 = 0;
    if (this.phase === 'standUp' || this.phase === 'sitDown') {
      k2 = Math.min(1, this.phaseT / ROUTINE.hop);
      if (k2 >= 1) {
        if (this.phase === 'standUp') {
          this.setPhase('stand');
          this.gesture = 'wave';
          this.gestureT = 0;
          if (this.firstStand) {
            this.firstStand = false;
            this.onArrive?.();
          }
        } else this.setPhase('sit');
        k2 = 0;
      }
    }
    // seated amount and where the root goes (with a little hop arc between)
    const seatedRootY = this.seat.y + 0.05 - this.hipY;
    let s: number; // 1 = on the car
    if (this.phase === 'sit') s = 1;
    else if (this.phase === 'stand') s = 0;
    else s = this.phase === 'standUp' ? 1 - ease(k2) : ease(k2);
    this.sitW = s;
    const arc = this.phase === 'standUp' || this.phase === 'sitDown' ? Math.sin(Math.PI * k2) * 0.28 : 0;
    this.root.position.set(
      THREE.MathUtils.lerp(this.standAt.x, this.seat.x, s),
      THREE.MathUtils.lerp(0, seatedRootY, s) + arc,
      THREE.MathUtils.lerp(this.standAt.z, this.seat.z, s),
    );
    // face the camera, turned a little toward the car's direction when seated
    const faceYaw = THREE.MathUtils.lerp(this.lookX * 0.12, this.carYaw * 0.35, s);
    this.root.rotation.y = THREE.MathUtils.damp(this.root.rotation.y, faceYaw, 6, dt);

    // ---- gestures ----
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
    this.root.position.y += this.hop * this.height;
    this.shadow.position.set(this.root.position.x, s > 0.5 ? this.seat.y - 0.0 + 0.004 : 0.004, this.root.position.z);
    this.shadow.visible = s < 0.5;
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
    const s = this.sitW;
    for (const [b, q] of this.rest) b.quaternion.copy(q);
    const hips = this.bones.get('Hips');
    if (hips) hips.position.copy(this.hipsRest);
    this.root.updateMatrixWorld(true);
    // the model faces +Z; turn() axes are in world space, so follow the root's yaw
    const fwd = Z.clone().applyAxisAngle(Y, this.root.rotation.y);
    const side = X.clone().applyAxisAngle(Y, this.root.rotation.y);

    // sitting: thighs forward over the car's nose, shins hanging and swinging, leaning back a bit
    if (s > 0) {
      const swing = 0.16 * s;
      this.turn('LeftUpLeg', side, (-Math.PI / 2) * s);
      this.turn('RightUpLeg', side, (-Math.PI / 2) * s);
      this.turn('LeftUpLeg', fwd, 0.08 * s);
      this.turn('RightUpLeg', fwd, -0.08 * s);
      // knees only half bent: feet rest forward on the bumper, which sticks out past the bonnet
      this.turn('LeftLeg', side, 0.95 * s + swing * Math.sin(t * 2.3));
      this.turn('RightLeg', side, 0.95 * s + swing * Math.sin(t * 2.3 + 2.1));
      this.turn('Spine', side, 0.12 * s);
    }

    // idle: breathe, sway, relaxed arms, look toward the pointer / around
    const breathe = Math.sin(t * 2.1);
    this.turn('Spine', side, 0.025 * breathe);
    this.turn('Spine1', fwd, 0.03 * Math.sin(t * 0.9));
    const lookAround = s > 0.5 ? 0.35 * Math.sin(t * 0.45) : 0;
    this.turn('Head', Y, 0.35 * this.lookX + 0.08 * Math.sin(t * 0.7) + lookAround);
    this.turn('Head', side, -0.04 + 0.03 * Math.sin(t * 1.3));
    const armDown = 0.62 + 0.03 * breathe;
    let la = -armDown,
      ra = armDown;

    if (g === 'wave' && w > 0) ra = THREE.MathUtils.lerp(ra, -1.4, w); // right arm up beside the head
    if (g === 'cheer' && w > 0) {
      la = THREE.MathUtils.lerp(la, 1.4, w);
      ra = THREE.MathUtils.lerp(ra, -1.4, w);
    }
    this.turn('LeftArm', fwd, la);
    this.turn('RightArm', fwd, ra);
    // seated: hands back on the bonnet
    if (s > 0) {
      this.turn('LeftArm', side, 0.45 * s * (1 - w));
      this.turn('RightArm', side, 0.45 * s * (g === 'wave' ? 1 - w : 1));
    }
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
      this.hop = w * p * 0.09 * (1 - s);
    } else this.hop = 0;
  }
}

/** soft round shadow (unit size; scale it) */
function groundShadow(): THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> {
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
  m.position.y = 0.004;
  return m;
}
