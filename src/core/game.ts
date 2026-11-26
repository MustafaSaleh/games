import * as THREE from 'three';
import { HANDLING } from '../config/handling';
import { ENDLESS_TIME_CYCLE, ENDLESS_TIME_STEP, type TimeOfDay } from '../config/lighting';
import { QUALITY } from '../config/quality';
import { SURFACES } from '../config/surfaces';
import { Car } from '../physics/car';
import { FollowCamera } from '../render/camera';
import { BlobShadow, Headlights, Particles, TireMarks } from '../render/effects';
import { GateView } from '../render/gates';
import { buildCar, type CarModel } from '../render/models';
import { Renderer3D } from '../render/renderer';
import { Hud, fmtDelta, fmtTime } from '../ui/hud';
import { Menu, type StageInfo } from '../ui/menu';
import { TouchControls } from '../ui/touch';
import { EndlessWorld } from '../world/endless';
import { PropRenderer } from '../world/props';
import { StageWorld, type StageDef } from '../world/stage';
import { Terrain } from '../world/terrain';
import { mixRGB, type BiomeMix, type RGB, type World } from '../world/world';
import { GameAudio } from './audio';
import { GhostPlayer, GhostRecorder, loadGhost, loadStageBest, saveStageBest, type GhostPose, type StageBest } from './ghost';
import { buzz } from './haptics';
import { Input } from './input';
import { Loop } from './loop';
import { clamp, lerp, lerpAngle, smoothstep, wrapAngle } from './math';
import { Race, type Mode } from './race';
import { dailySeed, randomSeed, seedToString, todayKey } from './rng';
import { autoQuality, isTouchDevice, onSettingsChange, settings } from './settings';
import { load, save } from './storage';

const CAR_COLOR = 0xf1eee6;

interface Debug {
  autopilot: boolean;
  timeScale: number;
  noTimer: boolean;
}

/** Owns everything; wires world + physics + render + UI together. */
export class Game {
  readonly r3: Renderer3D;
  readonly cam = new FollowCamera();
  readonly input = new Input();
  readonly audio = new GameAudio();
  readonly hud: Hud;
  readonly menu: Menu;
  readonly touch: TouchControls;
  readonly loop: Loop;
  readonly car = new Car();
  private carModel: CarModel;
  private ghostModel: CarModel;
  private props = new PropRenderer();
  private shadow = new BlobShadow();
  private headlights = new Headlights();
  private marks: TireMarks;
  private particles: Particles;
  private gates = new GateView();
  world: World | null = null;
  terrain: Terrain | null = null;
  race: Race | null = null;
  private mode: Mode = 'stage';
  private stageDef: StageDef | null = null;
  private seed = 0;
  private ghostRec = new GhostRecorder();
  private ghostPlay: GhostPlayer | null = null;
  private ghostPose: GhostPose = { x: 0, y: 0, z: 0, heading: 0, upX: 0, upZ: 0 };
  private ghostVisible = false;
  private best: StageBest | null = null;
  paused = false;
  private ev = { impact: 0, landing: 0 };
  private mix: BiomeMix = { a: null!, b: null!, t: 0 };
  private fog: RGB = [0.5, 0.5, 0.5];
  private tmpRGB: RGB = [0, 0, 0];
  private vignette: HTMLElement;
  private m4 = new THREE.Matrix4();
  private vUp = new THREE.Vector3();
  private vF = new THREE.Vector3();
  private vX = new THREE.Vector3();
  private bufSize = new THREE.Vector2();
  readonly debug: Debug;
  /** perf counters (exposed for the perf test) */
  readonly perf = { stepMs: 0, frameMs: 0, maxFrameMs: 0, genMs: 0, frames: 0, sumMs: 0, over8: 0, over16: 0, maxGenMs: 0 };

  constructor(
    canvas: HTMLCanvasElement,
    uiRoot: HTMLElement,
    private stages: StageDef[],
  ) {
    const params = new URLSearchParams(location.search);
    this.debug = { autopilot: params.has('autopilot'), timeScale: Number(params.get('timescale') ?? 1) || 1, noTimer: params.has('notimer') };
    // debug / screenshot overrides (not persisted)
    const tod = params.get('tod');
    if (tod === 'day' || tod === 'dusk' || tod === 'night') settings.timeOfDay = tod;
    const art = params.get('art');
    if (art === 'mono' || art === 'color') settings.artStyle = art;
    this.r3 = new Renderer3D(canvas, QUALITY[this.qualityLevel()]);
    this.marks = new TireMarks(this.r3.quality.tireMarks);
    this.particles = new Particles(this.r3.quality.particles);
    this.carModel = buildCar(CAR_COLOR);
    this.ghostModel = buildCar(0x8ac8ff, true);
    const sc = this.r3.scene;
    sc.add(this.props.group, this.shadow.mesh, this.carModel.root, this.ghostModel.root, this.marks.mesh, this.particles.points, this.headlights.group, this.gates.group);
    this.ghostModel.root.visible = false;
    for (const w of this.carModel.wheels) w.rotation.order = 'YXZ';

    this.vignette = el('div', 'vignette', uiRoot);
    this.hud = new Hud(uiRoot);
    this.touch = new TouchControls(uiRoot, this.input);
    this.menu = new Menu(uiRoot, {
      startStage: (d) => this.startStage(d),
      startEndless: (s) => this.startEndless(s ?? randomSeed(), 'endless'),
      startDaily: () => this.startEndless(dailySeed(), 'daily'),
      resume: () => this.resume(),
      restart: () => this.restart(),
      quit: () => this.quit(),
      next: () => this.nextStage(),
      enableTilt: () => this.input.enableTilt(),
      settingsChanged: () => this.applySettings(),
      unlockAudio: () => this.audio.unlock(),
    });
    this.hud.onPause = () => this.pause();
    this.hud.onReset = () => this.resetCar();
    this.hud.show(false);
    this.touch.show(false);

    this.loop = new Loop(
      (dt) => this.step(dt),
      (a, dt) => this.render(a, dt),
      (dt) => this.input.update(dt),
    );
    this.loop.timeScale = this.debug.timeScale;

    window.addEventListener('resize', () => this.resize());
    window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 200));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (this.race && !this.paused && this.race.state !== 'finished' && this.race.state !== 'over') this.pause();
        this.audio.suspend();
        this.loop.stop();
      } else {
        this.audio.resume();
        this.loop.start();
      }
    });
    const unlock = () => this.audio.unlock();
    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });
    onSettingsChange(() => this.applySettings());
    if (settings.steer === 'tilt') void this.input.enableTilt();

    this.resize();
    this.refreshMenuData();
    this.startAttract();
    this.loop.start();

    // deep links: ?mode=endless&seed=ABC | ?mode=daily | ?stage=<id>
    const mode = params.get('mode');
    const stageId = params.get('stage');
    if (mode === 'endless') this.startEndless(params.get('seed') ? parseInt(params.get('seed')!, 36) >>> 0 : randomSeed(), 'endless');
    else if (mode === 'daily') this.startEndless(dailySeed(), 'daily');
    else if (stageId) {
      const d = this.stages.find((s) => s.id === stageId);
      if (d) this.startStage(d);
      else this.menu.show('main');
    } else this.menu.show('main');
  }

  private qualityLevel() {
    return settings.quality === 'auto' ? autoQuality() : settings.quality;
  }

  private resize(): void {
    this.r3.resize();
    this.cam.resize(window.innerWidth, window.innerHeight);
    this.hud.minimap.resize();
    if (this.world instanceof StageWorld) this.hud.minimap.setStage(this.world.track);
  }

  private applySettings(): void {
    this.audio.applyVolume();
    this.touch.applyMode();
    this.hud.cls('fps', 'on', settings.showFps);
  }

  private refreshMenuData(): void {
    const infos: StageInfo[] = this.stages.map((def) => ({ def, best: loadStageBest(def.id)?.time ?? null }));
    this.menu.stages = infos;
    this.menu.endlessBest = load('endless.best', { score: 0, seed: 0 });
    this.menu.dailySeed = dailySeed();
    this.menu.dailyBest = load<number>('daily.' + todayKey(), 0);
  }

  /* ------------------------------------------------------------------ */
  /* Race setup                                                           */
  /* ------------------------------------------------------------------ */

  /** Menu background: a slow autopilot drive on the first stage. */
  private startAttract(): void {
    const def = this.stages[0];
    if (!def) return;
    this.setupWorld(new StageWorld(def, settings.artStyle === 'mono'), 'stage', def, 0, true);
  }

  startStage(def: StageDef): void {
    this.setupWorld(new StageWorld(def, settings.artStyle === 'mono'), 'stage', def, def.seed, false);
  }

  startEndless(seed: number, mode: 'endless' | 'daily'): void {
    this.setupWorld(new EndlessWorld(seed, settings.artStyle === 'mono'), mode, null, seed, false);
  }

  private attract = false;

  private setupWorld(world: World, mode: Mode, def: StageDef | null, seed: number, attract: boolean): void {
    this.attract = attract;
    this.terrain?.dispose();
    const q = QUALITY[this.qualityLevel()];
    if (q.id !== this.r3.quality.id) this.r3.setQuality(q);
    this.world = world;
    this.mode = mode;
    this.stageDef = def;
    this.seed = seed;
    const terrain = new Terrain(world, q.viewRadius);
    terrain.setPropDensity(q.propDensity);
    this.terrain = terrain;
    this.r3.scene.add(terrain.group);

    const startIdx = world instanceof StageWorld || world instanceof EndlessWorld ? world.startIdx : 4;
    const tr = world.track;
    const sx = tr.x(startIdx),
      sz = tr.z(startIdx);
    const heading = Math.atan2(tr.dx(startIdx), tr.dz(startIdx));
    terrain.ensureAround(sx, sz, 120);
    this.car.reset(sx, sz, heading, terrain);
    this.cam.snap(sx, this.car.y, sz, heading);
    this.marks.clear();
    this.particles.clear();

    const gates = world instanceof StageWorld || world instanceof EndlessWorld ? world.gates : [];
    this.best = def ? loadStageBest(def.id) : null;
    this.ghostPlay = def && !attract ? loadGhost(def.id) : null;
    this.ghostRec.reset();
    this.race = new Race(mode, gates, tr, this.best?.splits ?? null, startIdx);
    if (attract) this.race.state = 'running';
    if (world instanceof StageWorld) this.hud.minimap.setStage(tr);
    else this.hud.minimap.setLocal();

    this.paused = false;
    this.input.enabled = true;
    if (!attract) {
      this.menu.hide();
      this.hud.show(true);
      this.touch.show(isTouchDevice());
      this.audio.setActive(true);
      if (settings.steer === 'tilt') this.input.calibrateTilt();
    } else {
      this.hud.show(false);
      this.touch.show(false);
      this.audio.setActive(false);
    }
    this.hud.set('timeLabel', mode === 'stage' ? 'TIME' : 'TIME LEFT');
    this.hud.set('sub', mode === 'stage' ? '' : `${mode === 'daily' ? 'DAILY ' : ''}SEED ${seedToString(seed)}`);
    this.applySettings();
  }

  private restart(): void {
    if (this.mode === 'stage' && this.stageDef) this.startStage(this.stageDef);
    else this.startEndless(this.seed, this.mode === 'daily' ? 'daily' : 'endless');
  }

  private nextStage(): void {
    const i = this.stages.findIndex((s) => s.id === this.stageDef?.id);
    this.startStage(this.stages[(i + 1) % this.stages.length]);
  }

  private quit(): void {
    this.refreshMenuData();
    this.startAttract();
    this.menu.show('main');
  }

  pause(): void {
    if (!this.race || this.attract || this.paused) return;
    if (this.race.state === 'finished' || this.race.state === 'over') return;
    this.paused = true;
    this.audio.setActive(false);
    this.touch.show(false);
    this.menu.show('pause');
  }

  private resume(): void {
    this.paused = false;
    this.menu.hide();
    this.audio.setActive(true);
    this.touch.show(isTouchDevice());
  }

  private resetCar(): void {
    if (!this.race || !this.world || !this.terrain || this.race.state !== 'running') return;
    const tr = this.world.track;
    const i = this.race.respawnIndex();
    this.car.reset(tr.x(i), tr.z(i), Math.atan2(tr.dx(i), tr.dz(i)), this.terrain);
    this.marks.add(0, 0, 0, 0, 0, 0, this.tmpRGB, this.terrain);
    this.marks.add(1, 0, 0, 0, 0, 0, this.tmpRGB, this.terrain);
  }

  /* ------------------------------------------------------------------ */
  /* Fixed step (60 Hz)                                                   */
  /* ------------------------------------------------------------------ */
  private step(dt: number): void {
    const t0 = performance.now();
    const race = this.race,
      terrain = this.terrain,
      world = this.world;
    if (!race || !terrain || !world || this.paused) return;
    const inp = this.input;
    if (!this.attract && !this.menu.visible) {
      if (inp.pressed('Escape') || inp.pressed('KeyP') || inp.padPressed(9)) this.pause();
      if (inp.pressed('KeyR') || inp.padPressed(3)) this.resetCar();
    }
    inp.endFrame();
    if (this.paused) return;

    const running = race.state === 'running';
    if (this.attract || this.debug.autopilot) this.autopilot(inp);
    const carInput = running ? inp : NO_INPUT;
    this.car.step(dt, carInput, terrain);
    if (this.debug.noTimer) race.timeLeft = 99;
    race.update(dt, this.car, this.car.heading);
    this.raceEvents();
    if (running && this.mode === 'stage' && !this.attract)
      this.ghostRec.record(dt, this.car.x, this.car.y, this.car.z, this.car.heading, this.car.upX, this.car.upZ);
    this.emitFx(dt, inp.handbrake && running);
    this.perf.stepMs = performance.now() - t0;
  }

  private raceEvents(): void {
    const race = this.race!;
    const e = race.ev;
    if (this.attract) return;
    if (e.beep) this.audio.beep(e.beep === 2);
    if (e.gate) {
      this.audio.checkpoint(true);
      buzz(20);
    }
    if (e.missed) this.audio.checkpoint(false);
    if (e.finished || e.over) this.finishRace();
    this.car.consumeEvents(this.ev);
    if (this.ev.impact > 2.5) {
      this.audio.impact(this.ev.impact);
      this.cam.shake(this.ev.impact * 0.06);
      if (this.ev.impact > 6) buzz(Math.min(80, 20 + this.ev.impact * 3));
      this.burst(this.car.x, this.car.y + 0.6, this.car.z, 8, 0.5);
    }
    if (this.ev.landing > 2.5) {
      this.audio.landing(this.ev.landing);
      if (this.ev.landing > HANDLING.landingHardImpact) {
        buzz(35);
        this.cam.shake(this.ev.landing * 0.05);
      }
      this.burst(this.car.x, this.car.y + 0.2, this.car.z, Math.min(24, this.ev.landing * 2), 1);
    }
  }

  private finishRace(): void {
    const race = this.race!;
    this.input.enabled = false;
    this.audio.setActive(false);
    this.touch.show(false);
    const record = { yes: false };
    if (this.mode === 'stage' && this.stageDef) {
      const t = race.time;
      const prev = this.best?.time ?? Infinity;
      record.yes = t < prev;
      if (record.yes) saveStageBest(this.stageDef.id, { time: t, splits: race.splits.slice(), date: todayKey() }, this.ghostRec.snapshot());
      this.menu.result = {
        title: record.yes ? 'New record!' : 'Stage complete',
        big: fmtTime(t),
        lines: [
          this.stageDef.name,
          Number.isFinite(prev) ? `Best ${fmtTime(Math.min(prev, t))}${record.yes ? ` (${fmtDelta(t - prev)})` : ''}` : 'First time set',
        ],
        record: record.yes,
        canNext: this.stages.length > 1,
      };
    } else {
      const score = Math.floor(race.maxS);
      const key = this.mode === 'daily' ? 'daily.' + todayKey() : 'endless.best';
      let best: number;
      if (this.mode === 'daily') {
        best = load<number>(key, 0);
        record.yes = score > best;
        if (record.yes) save(key, score);
      } else {
        const b = load('endless.best', { score: 0, seed: 0 });
        best = b.score;
        record.yes = score > best;
        if (record.yes) save(key, { score, seed: this.seed });
      }
      const url = `${location.origin}${location.pathname}?mode=endless&seed=${seedToString(this.seed)}`;
      this.menu.result = {
        title: record.yes ? 'New high score!' : "Time's up",
        big: `${score} m`,
        lines: [`${race.gatesPassed} gates · ${fmtTime(race.time, false)} driven`, `${this.mode === 'daily' ? 'Daily best' : 'High score'} ${Math.max(best, score)} m`],
        seed: this.seed,
        shareUrl: this.mode === 'daily' ? undefined : url,
        record: record.yes,
        canNext: false,
      };
    }
    this.refreshMenuData();
    setTimeout(() => {
      if (this.race === race) {
        this.hud.show(false);
        this.menu.show('results');
      }
    }, 1400);
  }

  /** Simple pure-pursuit driver (menu background, ?autopilot soak tests). */
  private autopilot(inp: Input): void {
    const race = this.race!,
      tr = this.world!.track,
      car = this.car;
    const p = race.progress;
    const base = p.idx >= 0 ? p.idx : tr.start;
    const ahead = 4 + Math.round(car.speed * 0.45);
    const i = tr.clampIdx(base + ahead);
    const desired = Math.atan2(tr.x(i) - car.x, tr.z(i) - car.z);
    const diff = wrapAngle(desired - car.heading);
    const j = tr.clampIdx(base + ahead + 20);
    const bend = Math.abs(wrapAngle(Math.atan2(tr.dx(j), tr.dz(j)) - Math.atan2(tr.dx(i), tr.dz(i))));
    const limit = this.attract ? 20 : clamp(44 - bend * 40, 14, 44);
    inp.steer = clamp(-diff * 2.6, -1, 1);
    inp.throttle = car.speed < limit ? 1 : 0;
    inp.brake = car.speed > limit + 4 ? 0.7 : 0;
    inp.handbrake = false;
    if (race.state === 'finished' && this.attract) this.startAttract();
  }

  /* ------------------------------------------------------------------ */
  /* Effects                                                               */
  /* ------------------------------------------------------------------ */
  private surfaceColor(surface: number, out: RGB): RGB {
    const m = this.world!.biomeAt(this.car.x, this.car.z, this.mix);
    return mixRGB(m.a.pal.surfaces[surface], m.b.pal.surfaces[surface], m.t, out);
  }

  private markRGB: RGB = [0, 0, 0];
  private dustRGB: RGB = [0, 0, 0];

  private emitFx(dt: number, handbrake: boolean): void {
    const car = this.car,
      terrain = this.terrain!;
    const surf = SURFACES[car.surface];
    const speed = car.speed;
    if (car.airborne) {
      this.marks.add(0, 0, 0, 0, 0, 0, this.markRGB, terrain);
      this.marks.add(1, 0, 0, 0, 0, 0, this.markRGB, terrain);
      return;
    }
    const slip = Math.abs(car.lateralSpeed);
    const markAmt = clamp((slip - HANDLING.driftMarkSlip) / 4 + car.wheelspin * 0.7 + (handbrake && speed > 4 ? 0.6 : 0), 0, 1);
    this.surfaceColor(car.surface, this.dustRGB);
    const c = this.dustRGB;
    const dark = car.surface === 5 || car.surface === 4 ? 0.72 : 0.55;
    this.markRGB[0] = c[0] * dark;
    this.markRGB[1] = c[1] * dark;
    this.markRGB[2] = c[2] * dark;
    const s = Math.sin(car.heading),
      co = Math.cos(car.heading);
    const alpha = markAmt * surf.mark;
    for (let w = 0; w < 2; w++) {
      const lx = w === 0 ? 0.82 : -0.82,
        lz = -1.25;
      const wx = car.x + lx * co + lz * s,
        wz = car.z - lx * s + lz * co;
      this.marks.add(w, wx, wz, s, co, alpha, this.markRGB, terrain);
    }
    // dust: rolling dust on loose surfaces + sliding + wheelspin
    const rate = surf.dust * (clamp(speed / 40, 0, 1) * 0.35 + markAmt * 1.6 + car.wheelspin * 0.8);
    let n = rate * 60 * dt * 1.4;
    const light = 1.12;
    const dc: RGB = this.tmpRGB;
    dc[0] = Math.min(1, c[0] * light + 0.05);
    dc[1] = Math.min(1, c[1] * light + 0.05);
    dc[2] = Math.min(1, c[2] * light + 0.05);
    while (n > 0) {
      if (n < 1 && Math.random() > n) break;
      n -= 1;
      const w = Math.random() < 0.5 ? 0.82 : -0.82;
      const wx = car.x + w * co - 1.4 * s,
        wz = car.z - w * s - 1.4 * co;
      const sp = 0.25 + Math.random() * 0.25;
      this.particles.emit(
        wx,
        car.y + 0.25,
        wz,
        car.vx * sp + (Math.random() - 0.5) * 3,
        0.5 + Math.random() * 1.2,
        car.vz * sp + (Math.random() - 0.5) * 3,
        dc,
        0.9 + Math.random() * 0.8,
        0.7 + Math.random() * 0.9,
        0.5,
      );
    }
  }

  private burst(x: number, y: number, z: number, count: number, spread: number): void {
    this.surfaceColor(this.car.surface, this.dustRGB);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = 2 + Math.random() * 4 * spread;
      this.particles.emit(x, y, z, Math.cos(a) * v, 0.8 + Math.random() * 2, Math.sin(a) * v, this.dustRGB, 1 + Math.random(), 0.6 + Math.random() * 0.6, 0.55);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Render (display rate)                                                */
  /* ------------------------------------------------------------------ */
  private render(alpha: number, frameDt: number): void {
    const t0 = performance.now();
    const race = this.race,
      terrain = this.terrain,
      world = this.world,
      car = this.car;
    if (!race || !terrain || !world) return;
    const dt = this.paused ? 0 : frameDt;

    // interpolated pose
    const ix = lerp(car.px, car.x, alpha),
      iy = lerp(car.py, car.y, alpha),
      iz = lerp(car.pz, car.z, alpha);
    const ih = lerpAngle(car.pHeading, car.heading, alpha);
    this.poseCar(this.carModel, ix, iy + car.suspOffset * 0.3, iz, ih, car.upX, car.upY, car.upZ);
    const body = this.carModel.body;
    body.position.y = car.suspOffset * 0.5;
    body.rotation.set(-car.pitch, 0, -car.roll);
    const wheels = this.carModel.wheels;
    const spin = (car.forwardSpeed * dt) / 0.36 + (car.wheelspin > 0.3 ? 0.4 : 0);
    for (let i = 0; i < 4; i++) {
      wheels[i].rotation.x += spin;
      if (i < 2) wheels[i].rotation.y = -car.steerAngle * 1.3;
      wheels[i].position.y = 0.36 + (car.airborne ? -0.12 : -car.suspOffset * 0.2);
    }

    // ghost
    this.ghostVisible = false;
    if (this.ghostPlay && race.state === 'running' && this.ghostPlay.sample(race.time, this.ghostPose)) {
      const g = this.ghostPose;
      const uy = Math.sqrt(Math.max(0.01, 1 - g.upX * g.upX - g.upZ * g.upZ));
      this.poseCar(this.ghostModel, g.x, g.y, g.z, g.heading, g.upX, uy, g.upZ);
      this.ghostVisible = true;
    }
    this.ghostModel.root.visible = this.ghostVisible;

    // world streaming
    world.update(car.x, car.z, Math.max(race.progress.idx, world.track.start));
    const fx = car.x + car.vx * 1.2,
      fz = car.z + car.vz * 1.2;
    const tg = performance.now();
    terrain.update(fx, fz, this.r3.quality.genBudgetMs);
    this.perf.genMs = performance.now() - tg;

    // camera
    this.cam.update(Math.min(dt, 0.05), ix, iy, iz, car.vx, car.vz, ih, settings.cameraRotate);
    this.props.update(terrain, this.cam.camera);

    // lighting (time of day + biome fog)
    const m = world.biomeAt(ix, iz, this.mix);
    mixRGB(m.a.pal.fog, m.b.pal.fog, m.t, this.fog);
    const [ta, tb, tt] = this.timeOfDay(race.maxS);
    this.r3.applyLighting(ta, tb, tt, this.fog, this.cam.dist);
    this.vignette.style.opacity = String(this.r3.light.vignette);

    // effects
    const groundH = terrain.heightAt(ix, iz);
    this.shadow.update(ix, iz, ih, iy - groundH, terrain, this.r3.light.level);
    this.headlights.update(ix, iz, iy, ih, this.r3.light.headlights, terrain, car.airborne);
    this.particles.update(dt);
    this.r3.renderer.getDrawingBufferSize(this.bufSize);
    this.particles.mat.uniforms.uScale.value = this.bufSize.y / (2 * Math.tan((this.cam.camera.fov * Math.PI) / 360));
    this.particles.mat.uniforms.uLight.value = clamp(this.r3.light.level + this.r3.light.headlights * 0.4, 0.15, 1);
    this.marks.flush();
    this.drawGates(dt);

    if (!this.attract) this.updateHud();
    const surf = SURFACES[car.surface];
    this.audio.update(dt, car.speed, race.state === 'running' ? this.input.throttle : 0, Math.max(car.slide, this.input.handbrake ? 0.7 : 0), car.airborne, car.wheelspin, surf.skid, surf.dust);

    this.r3.monitor(frameDt);
    this.r3.render(this.cam.camera);
    const ft = performance.now() - t0;
    this.perf.frameMs = ft;
    this.perf.frames++;
    if (this.perf.frames > 120) {
      const p = this.perf;
      p.maxFrameMs = Math.max(p.maxFrameMs, ft);
      p.maxGenMs = Math.max(p.maxGenMs, p.genMs);
      p.sumMs += ft;
      if (ft > 8) p.over8++;
      if (ft > 16) p.over16++;
    }
  }

  private poseCar(model: CarModel, x: number, y: number, z: number, heading: number, ux: number, uy: number, uz: number): void {
    const up = this.vUp.set(ux, uy, uz).normalize();
    const f = this.vF.set(Math.sin(heading), 0, Math.cos(heading));
    f.addScaledVector(up, -f.dot(up)).normalize();
    const xAxis = this.vX.crossVectors(up, f);
    this.m4.makeBasis(xAxis, up, f);
    model.root.quaternion.setFromRotationMatrix(this.m4);
    model.root.position.set(x, y, z);
  }

  private timeOfDay(dist: number): [TimeOfDay, TimeOfDay, number] {
    if (settings.timeOfDay !== 'auto') return [settings.timeOfDay, settings.timeOfDay, 0];
    if (this.world instanceof StageWorld) return [this.world.def.timeOfDay, this.world.def.timeOfDay, 0];
    const k = dist / ENDLESS_TIME_STEP;
    const i = Math.floor(k);
    const n = ENDLESS_TIME_CYCLE.length;
    return [ENDLESS_TIME_CYCLE[i % n], ENDLESS_TIME_CYCLE[(i + 1) % n], smoothstep(0.75, 1, k - i)];
  }

  private drawGates(dt: number): void {
    const race = this.race!,
      tr = this.world!.track,
      terrain = this.terrain!;
    this.gates.begin(dt);
    const next = race.nextGate();
    for (const g of race.gates) {
      if (g.idx < tr.start || g.idx >= tr.end) continue;
      const dx = tr.x(g.idx) - this.car.x,
        dz = tr.z(g.idx) - this.car.z;
      if (dx * dx + dz * dz > 260 * 260) continue;
      const st = race.gateState.get(g) ?? (g === next ? 1 : 0);
      this.gates.draw(tr, g.idx, st, g.finish, terrain);
    }
    this.gates.end();
  }

  private updateHud(): void {
    const race = this.race!,
      hud = this.hud,
      car = this.car;
    if (this.mode === 'stage') hud.set('time', fmtTime(race.time));
    else {
      hud.set('time', race.timeLeft.toFixed(1));
      hud.cls('time', 'low', race.timeLeft < 10);
    }
    hud.set('speed', String(Math.round(car.speed * 3.6)));
    if (this.mode !== 'stage') hud.set('split', `${Math.floor(race.maxS)} m`);
    else if (race.splitShow > 0 && race.splitDelta != null) {
      hud.set('split', `CP ${race.gatesPassed}  ${fmtDelta(race.splitDelta)}`);
      hud.cls('split', 'ahead', race.splitDelta < 0);
      hud.cls('split', 'behind', race.splitDelta >= 0);
    } else {
      const total = race.gates.length;
      hud.set('split', `CP ${race.gatesPassed}/${total}${this.best ? '  · best ' + fmtTime(this.best.time) : ''}`);
      hud.cls('split', 'ahead', false);
      hud.cls('split', 'behind', false);
    }
    // countdown & messages
    if (race.state === 'countdown') hud.set('count', String(Math.max(1, Math.ceil(race.countdown))));
    else if (race.time < 0.8) hud.set('count', 'GO!');
    else hud.set('count', '');
    let msg = '';
    if (race.state === 'finished') msg = 'FINISH';
    else if (race.state === 'over') msg = "TIME'S UP";
    else if (race.splitShow > 1.2 && race.ev.gateBonus && this.mode !== 'stage') msg = `+${race.ev.gateBonus}s`;
    else if (race.missedWarn > 0) msg = 'MISSED CHECKPOINT — GO BACK';
    else if (race.wrongWay) msg = 'WRONG WAY';
    else if (race.offTrackFar) msg = 'OFF ROUTE — press ↺';
    hud.set('msg', msg);
    if (settings.showFps) hud.set('fps', `${this.r3.fps.toFixed(0)} fps · dpr ${this.r3.dpr} · ${this.props.instances} props`);
    const next = race.nextGate();
    hud.minimap.draw(this.world!.track, race.gates, next, car.x, car.z, car.heading, this.ghostVisible ? this.ghostPose : null, settings.cameraRotate ? this.cam.yaw : 0);
  }
}

const NO_INPUT = { steer: 0, throttle: 0, brake: 0, handbrake: false };

function el(tag: string, cls: string, parent: HTMLElement): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  parent.appendChild(e);
  return e;
}
