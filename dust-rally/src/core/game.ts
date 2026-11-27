import * as THREE from 'three';
import { HANDLING } from '../config/handling';
import { ENDLESS_TIME_CYCLE, ENDLESS_TIME_STEP, type TimeOfDay } from '../config/lighting';
import { QUALITY } from '../config/quality';
import { SURFACES } from '../config/surfaces';
import { Car } from '../physics/car';
import { FollowCamera } from '../render/camera';
import { BlobShadow, Headlights, Particles, Sparks, TireMarks } from '../render/effects';
import { makeContact, resolveCarCar, type CarBody, type CarContact } from '../physics/collisions';
import { TOMATO, TomatoSystem, aimThrow, type TomatoHit, type TomatoTarget } from './tomatoes';
import { splatScreen } from '../ui/splat';
import { MusicPlayer, TRACKS, type TrackId } from './music';
import { Skyline } from '../render/skyline';
import { BIOMES } from '../config/biomes';
import { GateView } from '../render/gates';
import { buildCar, disposeCar, setBrakeLights, type CarModel } from '../render/models';
import { GHOST_LIVERY, getLivery, getStyle } from '../config/cars';
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
import { autoQuality, isTouchDevice, onSettingsChange, settings, updateSettings } from './settings';
import { load, save } from './storage';
import { LocalRacer, RemoteCar, gridSlot, liveryCss, otherLivery } from './racers';
import { EMOTES, HOST_ID, Session, cleanName, normCode, type MpPlayer } from '../net/session';
import { localDriver, peerDriver } from '../net/transport';
import type { MapDot } from '../ui/minimap';
import type { Standing } from '../ui/menu';


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
  readonly music = new MusicPlayer();
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
  /* ---- multiplayer ---- */
  /** 'split' = two players on this device, 'online' = room with friends */
  mp: 'off' | 'split' | 'online' = 'off';
  private p2: LocalRacer | null = null;
  session: Session | null = null;
  private remotes = new Map<string, RemoteCar>();
  private labelLayer: HTMLElement;
  private splitTags: HTMLElement[] = [];
  private poseAcc = 0;
  private p1Finish: number | null = null;
  private mpDeadline = 0;
  private mpShown = false;
  private rbuf = [0, 0, 0, 0, 0, 0];
  private sparks = new Sparks();
  private skyline = new Skyline();
  private skyOn = false;
  /* ---- tomato fight ---- */
  private tomatoes = new TomatoSystem();
  private ammo = 0;
  private claimedGates = new Set<number>();
  private tomatoHits: TomatoHit[] = [];
  private tomatoTargets: TomatoTarget[] = [];
  private splatLayer: HTMLElement;
  private toast = { text: '', until: 0 };
  private contact: CarContact = makeContact();
  private remoteBody: CarBody = { x: 0, y: 0, z: 0, vx: 0, vz: 0, heading: 0, yawRate: 0 };
  private dots: MapDot[] = [];
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
    this.carModel = buildCar(getStyle(settings.carStyle).id, getLivery(settings.carLivery));
    this.ghostModel = buildCar(getStyle(settings.carStyle).id, GHOST_LIVERY, true);
    const sc = this.r3.scene;
    sc.add(this.props.group, this.shadow.mesh, this.carModel.root, this.ghostModel.root, this.marks.mesh, this.particles.points, this.headlights.group, this.gates.group, this.sparks.group, this.tomatoes.group, this.skyline.group);
    this.ghostModel.root.visible = false;

    this.vignette = el('div', 'vignette', uiRoot);
    this.labelLayer = el('div', 'name-tags', uiRoot);
    this.splatLayer = el('div', 'splat-layer', uiRoot);
    this.hud = new Hud(uiRoot);
    for (let i = 0; i < 2; i++) this.splitTags.push(el('div', `split-tag p${i + 1}`, this.hud.root));
    el('div', 'split-divider', this.hud.root);
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
      unlockAudio: () => this.unlockAudio(),
      toggleMusic: () => this.toggleMusic(),
      startSplit: (d) => this.startSplit(d),
      createRoom: (name) => this.createRoom(name),
      joinRoom: (code, name) => this.joinRoom(code, name),
      leaveRoom: () => this.leaveRoom(),
      hostStage: (id) => this.session?.setStage(id),
      hostStart: () => this.session?.start(),
      toLobby: () => this.toLobby(),
      emote: (i) => this.sendEmote(i),
    });
    this.hud.onPause = () => this.pause();
    this.hud.onReset = () => this.resetCar();
    this.hud.onCamera = () => this.toggleCamera();
    this.hud.onMusic = () => this.toggleMusic();
    this.hud.onEmote = (i) => this.sendEmote(i);
    this.hud.show(false);
    this.touch.show(false);

    this.loop = new Loop(
      (dt) => this.step(dt),
      (a, dt) => this.render(a, dt),
      (dt) => {
        this.input.update(dt);
        this.p2?.input.update(dt);
      },
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
        if (this.session) {
          this.wakeLock = null; // released automatically while hidden
          void this.keepAwake(true);
        }
      }
    });
    const unlock = () => this.unlockAudio();
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
    else if (params.get('room')) {
      this.menu.joinCode = params.get('room')!;
      this.menu.show('main');
      this.menu.show('online', true);
    } else if (stageId) {
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
    if (this.p2) {
      const [a, b] = Renderer3D.splitRects(window.innerWidth, window.innerHeight, 2);
      this.cam.resize(a.w, a.h);
      this.p2.cam.resize(b.w, b.h);
      this.hud.root.classList.toggle('split-stacked', a.w === window.innerWidth);
    } else this.cam.resize(window.innerWidth, window.innerHeight);
    this.hud.minimap.resize();
    if (this.world instanceof StageWorld) this.hud.minimap.setStage(this.world.track);
  }

  private carKey = '';
  /** Rebuild the player + ghost car when the garage selection changes. */
  private applyCar(): void {
    const key = settings.carStyle + '/' + settings.carLivery;
    if (key === this.carKey) return;
    const first = this.carKey === '';
    this.carKey = key;
    if (first) return; // built in the constructor
    this.session?.setCar(settings.carStyle, settings.carLivery);
    const style = getStyle(settings.carStyle).id;
    disposeCar(this.carModel);
    disposeCar(this.ghostModel);
    this.carModel = buildCar(style, getLivery(settings.carLivery));
    this.ghostModel = buildCar(style, GHOST_LIVERY, true);
    this.ghostModel.root.visible = false;
    this.r3.scene.add(this.carModel.root, this.ghostModel.root);
  }

  /** first tap / key press: start sound, and hook the music onto the same audio context */
  private unlockAudio(): void {
    this.audio.unlock();
    const ctx = this.audio.context;
    if (ctx) {
      this.music.attach(ctx, this.audio.noiseBuffer);
      this.updateMusic();
    }
  }

  /** pick the tune for what's on screen (or the player's fixed choice) and apply volume */
  private updateMusic(): void {
    this.music.set(settings.music, settings.musicVolume);
    let id = settings.musicTrack as TrackId;
    if (!TRACKS.some((t) => t.id === id)) {
      if (this.attract || !this.world) id = 'sunny';
      else {
        const biome = this.stageDef?.biome ?? '';
        id = biome === 'snow' ? 'frost' : biome === 'forest' || biome === 'redwood' ? 'turbo' : 'dust';
      }
    }
    this.music.play(id);
    this.hud.cls('music', 'off', !settings.music);
  }

  private toggleMusic(): void {
    updateSettings({ music: !settings.music });
  }

  private applySettings(): void {
    this.updateMusic();
    this.applyCar();
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
    this.mp = 'off';
    this.setupWorld(new StageWorld(def, settings.artStyle === 'mono'), 'stage', def, def.seed, false);
  }

  /** Two players on one device (keyboard halves / two gamepads). */
  startSplit(def: StageDef): void {
    this.mp = 'split';
    this.setupWorld(new StageWorld(def, settings.artStyle === 'mono'), 'stage', def, def.seed, false);
  }

  /** Online race: everyone in the room starts the same stage. */
  private startOnline(stageId: string, players: MpPlayer[]): void {
    const def = this.stages.find((d) => d.id === stageId) ?? this.stages[0];
    this.mp = 'online';
    this.setupWorld(new StageWorld(def, settings.artStyle === 'mono'), 'stage', def, def.seed, false, players);
  }

  startEndless(seed: number, mode: 'endless' | 'daily'): void {
    this.mp = 'off';
    this.setupWorld(new EndlessWorld(seed, settings.artStyle === 'mono'), mode, null, seed, false);
  }

  private attract = false;

  private setupWorld(world: World, mode: Mode, def: StageDef | null, seed: number, attract: boolean, online: MpPlayer[] | null = null): void {
    this.attract = attract;
    if (attract) this.mp = this.session ? 'online' : 'off';
    const split = this.mp === 'split' && !attract;
    this.clearRacers();
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
    const me = online?.find((p) => p.id === this.session?.myId);
    const solo = attract || (!split && !online);
    const g1 = gridSlot(tr, startIdx, me ? me.slot : 0, solo);
    terrain.ensureAround(sx, sz, 120);
    this.car.reset(g1.x, g1.z, g1.heading, terrain);
    this.cam.snap(g1.x, this.car.y, g1.z, g1.heading);
    this.input.scheme = split ? 'p1' : 'all';
    if (split) {
      const p2 = (this.p2 = new LocalRacer('P2', otherLivery(settings.carLivery), settings.carStyle, this.r3.scene));
      const g2 = gridSlot(tr, startIdx, 1, false);
      p2.car.reset(g2.x, g2.z, g2.heading, terrain);
      p2.cam.snap(g2.x, p2.car.y, g2.z, g2.heading);
      p2.input.enabled = true;
    }
    if (online && !attract)
      for (const pl of online) if (pl.id !== this.session?.myId) this.remotes.set(pl.id, new RemoteCar(pl, this.r3.scene, this.labelLayer));
    this.marks.clear();
    this.particles.clear();
    this.sparks.clear();
    const sky = def ? BIOMES[def.biome]?.skyline : undefined;
    this.skyOn = !!sky;
    if (sky) this.skyline.setColors(sky);
    this.tomatoes.clear();
    this.splatLayer.replaceChildren();
    this.ammo = 0;
    this.claimedGates.clear();
    this.toast.until = 0;

    const gates = world instanceof StageWorld || world instanceof EndlessWorld ? world.gates : [];
    this.best = def ? loadStageBest(def.id) : null;
    this.ghostPlay = def && !attract && this.mp === 'off' ? loadGhost(def.id) : null;
    this.ghostRec.reset();
    this.race = new Race(mode, gates, tr, this.mp === 'off' ? (this.best?.splits ?? null) : null, startIdx);
    if (this.p2) this.p2.race = new Race(mode, gates, tr, null, startIdx);
    this.p1Finish = null;
    this.mpDeadline = 0;
    this.mpShown = false;
    this.poseAcc = 0;
    this.hud.root.classList.toggle('split', !!this.p2);
    this.hud.root.classList.toggle('mp', this.mp !== 'off' && !attract);
    this.touch.setTomatoes(this.mp !== 'off' && !attract, 0);
    this.hud.root.classList.toggle('online', this.mp === 'online' && !attract);
    this.resize();
    if (attract) this.race.state = 'running';
    if (world instanceof StageWorld) this.hud.minimap.setStage(tr);
    else this.hud.minimap.setLocal();

    this.paused = false;
    this.input.enabled = true;
    if (!attract) {
      this.menu.hide();
      this.hud.show(true);
      this.touch.show(isTouchDevice() && !split);
      this.audio.setActive(true);
      if (settings.steer === 'tilt') this.input.calibrateTilt();
    } else {
      this.hud.show(false);
      this.touch.show(false);
      this.audio.setActive(false);
    }
    this.hud.set('timeLabel', mode === 'stage' ? 'TIME' : 'TIME LEFT');
    this.hud.set('sub', mode === 'stage' ? '' : `${mode === 'daily' ? 'DAILY ' : ''}SEED ${seedToString(seed)}`);
    if (this.mp === 'online' && !attract) this.hud.set('sub', `ROOM ${this.session?.code ?? ''}`);
    this.applySettings();
  }

  private restart(): void {
    if (this.mp === 'online') {
      if (this.session?.isHost) this.session.start(this.stageDef?.id);
      return;
    }
    if (this.mp === 'split' && this.stageDef) this.startSplit(this.stageDef);
    else if (this.mode === 'stage' && this.stageDef) this.startStage(this.stageDef);
    else this.startEndless(this.seed, this.mode === 'daily' ? 'daily' : 'endless');
  }

  private nextStage(): void {
    const i = this.stages.findIndex((s) => s.id === this.stageDef?.id);
    const next = this.stages[(i + 1) % this.stages.length];
    if (this.mp === 'online') {
      if (this.session?.isHost) this.session.start(next.id);
    } else if (this.mp === 'split') this.startSplit(next);
    else this.startStage(next);
  }

  private quit(): void {
    if (this.mp === 'online' && this.session) return this.toLobby();
    this.mp = 'off';
    this.refreshMenuData();
    this.startAttract();
    this.menu.show('main');
  }

  pause(): void {
    if (!this.race || this.attract || this.paused) return;
    if (this.race.state === 'finished' || this.race.state === 'over') return;
    if (this.mp === 'split' && this.p1Finish != null) return;
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

  private resetP2(): void {
    const p2 = this.p2;
    if (!p2 || !this.world || !this.terrain || p2.race.state !== 'running') return;
    const tr = this.world.track;
    const i = p2.race.respawnIndex();
    p2.car.reset(tr.x(i), tr.z(i), Math.atan2(tr.dx(i), tr.dz(i)), this.terrain);
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
  /* Multiplayer                                                          */
  /* ------------------------------------------------------------------ */
  private clearRacers(): void {
    this.p2?.dispose();
    this.p2 = null;
    for (const r of this.remotes.values()) r.dispose();
    this.remotes.clear();
  }

  private stepP2(p2: LocalRacer, dt: number, terrain: Terrain): void {
    const running = p2.race.state === 'running' && p2.finishTime == null;
    p2.car.step(dt, running && !this.paused ? p2.input : NO_INPUT, terrain);
    p2.race.update(dt, p2.car, p2.car.heading);
    if (p2.race.ev.finished && p2.finishTime == null) {
      p2.finishTime = p2.race.time;
      this.audio.checkpoint(true);
      if (this.p1Finish == null) this.mpDeadline = performance.now() + 30000;
    }
    if (p2.race.ev.gate) {
      this.audio.checkpoint(true);
      this.gatePassed(2, p2.race);
    }
    p2.car.consumeEvents(p2.ev);
    if (p2.ev.impact > 2.5) {
      p2.cam.shake(p2.ev.impact * 0.06);
      this.burst(p2.car, p2.car.x, p2.car.y + 0.6, p2.car.z, 8, 0.5);
      if (p2.ev.impact > 5) this.obstacleSparks(p2.car, p2.ev.impact);
    }
    if (p2.ev.landing > 2.5) {
      if (p2.ev.landing > HANDLING.landingHardImpact) p2.cam.shake(p2.ev.landing * 0.05);
      this.burst(p2.car, p2.car.x, p2.car.y + 0.2, p2.car.z, Math.min(24, p2.ev.landing * 2), 1);
    }
    this.emitFx(p2.car, dt, p2.input.handbrake && running);
  }

  /* ---- car contact: physics already applied, now sparks / sound / shake ---- */
  private carContact(c: CarContact, other: Car | null): void {
    if (c.impact > 1.2) {
      // big hit: shower of sparks thrown sideways, plus the usual impact sound / shake / dust
      const side = Math.random() < 0.5 ? -1 : 1;
      this.sparks.emit(c.x, c.y, c.z, Math.min(55, 8 + c.impact * 2.6), 4 + c.impact * 0.35, -c.nz * side * 0.6, c.nx * side * 0.6);
      this.car.impact = Math.max(this.car.impact, c.impact * 1.2);
      if (other) other.impact = Math.max(other.impact, c.impact * 1.2);
    }
    if (c.scrape > 3) {
      // grinding along each other: a steady trickle
      const n = c.scrape > 9 ? 3 : c.scrape > 6 ? 2 : 1;
      this.sparks.emit(c.x, c.y, c.z, n, 2.5 + c.scrape * 0.25);
    }
  }

  private obstacleSparks(car: Car, impact: number): void {
    const fx = Math.sin(car.heading),
      fz = Math.cos(car.heading);
    const k = car.forwardSpeed >= 0 ? 1.7 : -1.7;
    this.sparks.emit(car.x + fx * k, car.y + 0.5, car.z + fz * k, Math.min(30, impact * 2), 3 + impact * 0.3);
  }

  /** online: bump into the other players' cars (they are moved by their own devices) */
  private collideRemotes(): void {
    const now = performance.now();
    const b = this.remoteBody;
    for (const r of this.remotes.values()) {
      if (r.gone || r.finishTime != null || !r.body(now, b)) continue;
      if (resolveCarCar(this.car, b, false, this.contact)) this.carContact(this.contact, null);
    }
  }

  /* ---- tomato fight ---- */

  /** player 1 or 2 passed a checkpoint: the first one through earns a tomato */
  private gatePassed(who: 1 | 2, race: Race): void {
    const n = race.splits.length;
    if (race.gates[n - 1]?.finish) return; // nothing to throw after the finish
    if (this.mp === 'online') this.session?.claimGate(n);
    else if (!this.claimedGates.has(n)) {
      this.claimedGates.add(n);
      this.award(who);
    }
  }

  private award(who: 1 | 2): void {
    const key = who === 1 ? (this.p2 ? 'F' : 'F / 🍅') : '/';
    if (who === 1) this.ammo = Math.min(TOMATO.maxAmmo, this.ammo + 1);
    else if (this.p2) this.p2.ammo = Math.min(TOMATO.maxAmmo, this.p2.ammo + 1);
    this.audio.pickup();
    this.say(this.p2 ? `P${who} got a 🍅! (${key} to throw)` : `🍅 +1! Throw it back at your chaser (${isTouchDevice() ? 'tap 🍅' : 'F'})`);
  }

  private say(text: string, ms = 2200): void {
    this.toast.text = text;
    this.toast.until = performance.now() + ms;
  }

  private throwTomato(who: 1 | 2): void {
    const race = who === 1 ? this.race : this.p2?.race;
    if (!race || race.state !== 'running') return;
    const ammo = who === 1 ? this.ammo : (this.p2?.ammo ?? 0);
    if (ammo <= 0) return;
    if (who === 1) this.ammo--;
    else this.p2!.ammo--;
    const car = who === 1 ? this.car : this.p2!.car;
    const me = this.tomatoOwner(who);
    const targets = this.collectTargets().filter((t) => t.id !== me);
    const p = aimThrow(car, targets);
    this.tomatoes.spawn(me, p);
    this.audio.whoosh();
    if (this.mp === 'online') this.session?.sendThrow(p.map((v) => Math.round(v * 100) / 100));
  }

  private tomatoOwner(who: 1 | 2): string {
    return this.mp === 'online' ? (this.session?.myId ?? 'me') : who === 1 ? 'p1' : 'p2';
  }

  /** every car a tomato can hit, with ids matching tomato owners */
  private collectTargets(): TomatoTarget[] {
    const out = this.tomatoTargets;
    out.length = 0;
    const c = this.car;
    out.push({ id: this.tomatoOwner(1), x: c.x, y: c.y, z: c.z, vx: c.vx, vz: c.vz });
    if (this.p2) {
      const d = this.p2.car;
      out.push({ id: 'p2', x: d.x, y: d.y, z: d.z, vx: d.vx, vz: d.vz });
    }
    for (const [id, r] of this.remotes) if (!r.gone && r.visible) out.push({ id, x: r.x, y: r.model.root.position.y, z: r.z, vx: r.vx, vz: r.vz });
    return out;
  }

  private updateTomatoes(dt: number): void {
    if (this.mp === 'off' || this.attract) return;
    const hits = this.tomatoHits;
    const juice = (x: number, y: number, z: number, n: number) => {
      const red: RGB = [0.85, 0.08, 0.05];
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2,
          v = 2 + Math.random() * 4;
        this.particles.emit(x, y, z, Math.cos(a) * v, 1 + Math.random() * 3, Math.sin(a) * v, red, 0.5 + Math.random() * 0.6, 0.5 + Math.random() * 0.5, 0.9);
      }
    };
    this.tomatoes.update(dt, this.groundFn, this.collectTargets(), (x, y, z) => juice(x, y, z, 10), hits);
    for (const h of hits) {
      juice(h.x, h.y, h.z, 18);
      const local = h.target === this.tomatoOwner(1) ? 1 : h.target === 'p2' ? 2 : 0;
      this.audio.splat(local !== 0);
      if (!local) continue; // an online player: their own device shows the splat and tells everyone
      const w = window.innerWidth,
        hgt = window.innerHeight;
      const rect = this.p2 ? Renderer3D.splitRects(w, hgt, 2)[local - 1] : { x: 0, y: 0, w, h: hgt };
      splatScreen(this.splatLayer, rect);
      buzz(60);
      if (this.mp === 'online') this.session?.sendSplat(h.owner);
      else this.say(`SPLAT! ${h.owner.toUpperCase()} got ${h.target.toUpperCase()}! 🍅`);
    }
  }

  /* ---- emojis (online) ---- */

  private sendEmote(i: number): void {
    this.hud.root.classList.remove('emotes-open');
    if (!this.session?.sendEmote(i)) this.say('Wait a moment before the next emoji', 900);
  }

  /** someone (maybe me) sent an emoji: next to their name in menus, above their car in a race */
  private showEmote(id: string, e: number): void {
    const text = EMOTES[e];
    if (!text) return;
    const until = performance.now() + 2600;
    this.menu.emotes.set(id, { text, until });
    const cur = this.menu.visible ? this.menu.current : '';
    if (cur === 'lobby' || cur === 'results') {
      this.menu.refresh();
      setTimeout(() => this.menu.visible && this.menu.current === cur && this.menu.refresh(), 2700);
    }
    if (this.attract || !this.race || this.mp !== 'online') return;
    if (id === this.session?.myId) {
      // float it up from my own car
      const v = new THREE.Vector3(this.car.x, this.car.y + 2.4, this.car.z).project(this.cam.camera);
      floatEmote(this.labelLayer, ((v.x + 1) / 2) * window.innerWidth, ((1 - v.y) / 2) * window.innerHeight, text);
      return;
    }
    const r = this.remotes.get(id);
    if (r && r.visible) r.showEmote(text);
    else this.say(`${r?.player.name ?? this.session?.players.find((p) => p.id === id)?.name ?? 'Someone'} ${text}`, 1600);
  }

  /** switch between the top-down and the third-person chase camera */
  private toggleCamera(): void {
    updateSettings({ cameraView: settings.cameraView === 'chase' ? 'top' : 'chase' });
  }

  private stepOnline(dt: number): void {
    const s = this.session,
      race = this.race;
    if (!s || !race) return;
    this.poseAcc += dt;
    if (this.poseAcc < 1 / 15) return;
    this.poseAcc = 0;
    const c = this.car;
    const r = (v: number) => Math.round(v * 100) / 100;
    s.sendPose([r(race.time), r(c.x), r(c.y), r(c.z), r(c.heading), r(c.upX), r(c.upZ), r(race.maxS), r(c.speed), c.braking ? 1 : 0]);
  }

  /** player 1 crossed the finish line in a multiplayer race */
  private localFinished(t: number): void {
    if (this.p1Finish != null) return;
    this.p1Finish = t;
    buzz(40);
    if (this.mp === 'online') {
      this.session?.sendFinish(t);
      this.input.enabled = false;
      this.showMpResults(1400);
    } else if (this.p2 && this.p2.finishTime == null) this.mpDeadline = performance.now() + 30000;
  }

  private checkMpEnd(): void {
    if (this.mpShown) return;
    if (this.mp === 'split' && this.p2) {
      const both = this.p1Finish != null && this.p2.finishTime != null;
      if (both || (this.mpDeadline > 0 && performance.now() > this.mpDeadline)) this.showMpResults(both ? 1400 : 0);
    }
  }

  private showMpResults(delay: number): void {
    if (this.mpShown) return;
    this.mpShown = true;
    const race = this.race;
    setTimeout(() => {
      if (this.race !== race || this.attract) return;
      this.input.enabled = false;
      if (this.p2) this.p2.input.enabled = false;
      this.audio.setActive(false);
      this.touch.show(false);
      this.hud.show(false);
      this.labelLayer.style.display = 'none';
      this.fillMpResult();
      this.menu.show('results');
    }, delay);
  }

  /** (re)build the multiplayer standings shown on the results screen */
  private fillMpResult(): void {
    const final = this.mp === 'split';
    const rows: Standing[] = [];
    const st = (time: number | null, gone: boolean) => (time != null ? fmtTime(time) : gone ? 'left' : final ? 'DNF' : 'racing…');
    const me = this.session?.me;
    rows.push({
      id: me?.id,
      name: this.mp === 'split' ? 'P1' : (me?.name ?? 'You'),
      color: liveryCss(settings.carLivery),
      time: this.p1Finish,
      status: st(this.p1Finish, false),
      me: true,
      progress: this.race?.maxS ?? 0,
    });
    if (this.p2)
      rows.push({ name: 'P2', color: liveryCss(this.p2.livery.id), time: this.p2.finishTime, status: st(this.p2.finishTime, false), me: false, progress: this.p2.race.maxS });
    for (const r of this.remotes.values())
      rows.push({ id: r.player.id, name: r.player.name, color: liveryCss(r.player.livery), time: r.finishTime, status: st(r.finishTime, r.gone), me: false, progress: r.progress });
    rows.sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity) || b.progress - a.progress);
    const first = rows[0];
    const place = rows.findIndex((r) => r.me) + 1;
    let title: string;
    if (this.mp === 'split') title = first.time != null ? `${first.name} wins! 🏆` : 'Race over';
    else title = place === 1 && first.time != null ? 'You won! 🏆' : `You finished ${ordinal(place)}`;
    const host = this.mp !== 'online' || !!this.session?.isHost;
    this.menu.result = {
      title,
      big: this.p1Finish != null ? fmtTime(this.p1Finish) : '',
      lines: [this.stageDef?.name ?? ''],
      record: this.mp === 'split' ? first.time != null : place === 1,
      canNext: host && this.stages.length > 1,
      standings: rows,
      online: this.mp === 'online',
      waiting: !host,
    };
    if (this.session?.isHost && rows.every((r) => r.time != null || r.status === 'left')) this.session.endRace();
  }

  private refreshMpResults(): void {
    if (this.mpShown && this.menu.visible && this.menu.current === 'results') {
      this.fillMpResult();
      this.menu.refresh();
    }
  }

  private driver() {
    return new URLSearchParams(location.search).get('net') === 'local' ? Promise.resolve(localDriver()) : peerDriver();
  }

  private wakeLock: { release(): Promise<void> } | null = null;
  /** keep the screen on while in a room (a sleeping phone can't let friends join) */
  private async keepAwake(on: boolean): Promise<void> {
    const nav = navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } };
    try {
      if (on && !this.wakeLock && nav.wakeLock && !document.hidden) this.wakeLock = await nav.wakeLock.request('screen');
      else if (!on && this.wakeLock) {
        const w = this.wakeLock;
        this.wakeLock = null;
        await w.release();
      }
    } catch {
      /* not supported / denied */
    }
  }

  private bindSession(s: Session): void {
    this.session = s;
    void this.keepAwake(true);
    s.ev.lobby = () => {
      // guests learn about leavers from the lobby list
      for (const [id, r] of this.remotes)
        if (!r.gone && !s.players.some((p) => p.id === id)) {
          r.gone = true;
          r.label.style.display = 'none';
        }
      this.refreshMpResults();
      if (this.menu.visible && this.menu.current === 'lobby') this.menu.refresh();
    };
    s.ev.start = (stageId, players) => this.startOnline(stageId, players);
    const nameOf = (id: string) => s.players.find((p) => p.id === id)?.name ?? 'Someone';
    s.ev.award = (id) => {
      if (this.mp !== 'online' || this.attract) return;
      if (id === s.myId) this.award(1);
      else this.say(`${nameOf(id)} grabbed a 🍅`, 1500);
    };
    s.ev.throw = (id, p) => {
      if (this.mp === 'online' && !this.attract && this.remotes.has(id)) this.tomatoes.spawn(id, p);
    };
    s.ev.emote = (id, e) => this.showEmote(id, e);
    s.ev.splat = (id, by) => {
      if (this.mp !== 'online' || this.attract) return;
      if (by === s.myId) this.say(`SPLAT! You hit ${nameOf(id)}! 🍅`);
      else this.say(`${nameOf(by)} splatted ${nameOf(id)}! 🍅`, 1500);
    };
    s.ev.pose = (id, p) => this.remotes.get(id)?.push(p);
    s.ev.finish = (id, t) => {
      const r = this.remotes.get(id);
      if (!r || r.finishTime != null) return;
      r.finishTime = t;
      this.refreshMpResults();
    };
    s.ev.left = (id) => {
      const r = this.remotes.get(id);
      if (r) {
        r.gone = true;
        r.label.style.display = 'none';
      }
      this.refreshMpResults();
    };
    s.ev.closed = (reason) => {
      this.session = null;
      void this.keepAwake(false);
      this.mp = 'off';
      this.menu.netError = reason;
      this.quit();
      this.menu.show('online', true);
    };
    this.menu.mpInfo = () => {
      const ss = this.session;
      if (!ss) return null;
      const url = new URL(location.href);
      url.search = '';
      url.searchParams.set('room', ss.code);
      if (new URLSearchParams(location.search).get('net') === 'local') url.searchParams.set('net', 'local');
      return {
        code: ss.code,
        isHost: ss.isHost,
        racing: ss.racing,
        stageId: ss.stageId,
        shareUrl: url.toString(),
        players: ss.players.map((p) => ({
          id: p.id,
          name: p.name,
          color: liveryCss(p.livery),
          car: `${getStyle(p.style).name} · ${getLivery(p.livery).name}`,
          me: p.id === ss.myId,
          host: p.id === HOST_ID,
        })),
        serverOnline: ss.serverOnline,
      };
    };
  }

  private netMessage(e: unknown): string {
    const m = (e as Error)?.message ?? '';
    if (m === 'not-found') return "Can't find that room. Check the code, and make sure the host still has the game open. (not-found)";
    if (m === 'full') return 'That room is full (4 racers max).';
    if (m === 'version') return 'You and the host have different versions of the game. Both of you: reload the page (twice on iPhone/iPad), then try again. (version)';
    if (m === 'offline') return "Couldn't reach the room server. Check your internet and try again. (offline)";
    if (m === 'timeout') return "Found the room, but the host's device didn't answer. The host must keep the game open on screen (not switch to another app). Then tap Join again. (timeout)";
    if (m === 'connect-failed') return "Found the room, but couldn't connect to the host's device. The network may block direct connections; try another Wi-Fi or mobile data. (connect-failed)";
    return `Something went wrong. Try again. (${m || 'unknown'})`;
  }

  private async createRoom(name: string): Promise<void> {
    save('mp.name', cleanName(name));
    this.menu.netBusy = 'Creating room…';
    this.menu.netError = '';
    this.menu.refresh();
    try {
      const s = await Session.create(await this.driver(), name, settings.carStyle, settings.carLivery, this.stages[0].id);
      this.bindSession(s);
      this.mp = 'online';
      this.menu.netBusy = '';
      this.menu.show('main');
      this.menu.show('lobby', true);
    } catch (e) {
      this.menu.netBusy = '';
      this.menu.netError = this.netMessage(e);
      this.menu.refresh();
    }
  }

  private async joinRoom(code: string, name: string): Promise<void> {
    save('mp.name', cleanName(name));
    this.menu.netBusy = 'Joining…';
    this.menu.netError = '';
    this.menu.refresh();
    try {
      // The host's phone may be busy in another app (sharing the link) for a little while:
      // keep knocking for up to a minute instead of giving up after one try.
      const driver = await this.driver();
      const until = performance.now() + 60000;
      let s: Session | null = null;
      for (let attempt = 1; !s; attempt++) {
        try {
          s = await Session.join(driver, normCode(code), name, settings.carStyle, settings.carLivery);
        } catch (e) {
          const m = (e as Error).message;
          const retry = m === 'timeout' || m === 'closed' || (m === 'not-found' && attempt < 4);
          if (!retry || performance.now() > until || this.menu.current !== 'online') throw e;
          this.menu.netBusy =
            m === 'not-found' ? `Looking for room ${normCode(code)}…` : "Waiting for the host's device to answer… (the host should keep the game open on screen)";
          this.menu.refresh();
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
      this.bindSession(s);
      this.mp = 'online';
      this.menu.netBusy = '';
      this.menu.show('main');
      this.menu.show('lobby', true);
    } catch (e) {
      this.menu.netBusy = '';
      this.menu.netError = this.netMessage(e);
      this.menu.refresh();
    }
  }

  private leaveRoom(): void {
    const s = this.session;
    this.session = null;
    void this.keepAwake(false);
    s?.leave();
    this.mp = 'off';
    this.quit();
  }

  /** online: leave the race / results and go back to the room lobby */
  private toLobby(): void {
    if (!this.session) return this.quit();
    this.session.endRace();
    this.refreshMenuData();
    this.startAttract();
    this.menu.show('main');
    this.menu.show('lobby', true);
  }

  /* ------------------------------------------------------------------ */
  /* Fixed step (60 Hz)                                                   */
  /* ------------------------------------------------------------------ */
  private step(dt: number): void {
    const t0 = performance.now();
    const race = this.race,
      terrain = this.terrain,
      world = this.world;
    const online = this.mp === 'online' && !this.attract;
    if (!race || !terrain || !world || (this.paused && !online)) return;
    const inp = this.input;
    const p2 = this.p2;
    if (!this.attract && !this.menu.visible) {
      if (inp.pressed('Escape') || inp.pressed('KeyP') || inp.padPressed(9)) this.pause();
      if (inp.pressed('KeyR') || inp.padPressed(3)) this.resetCar();
      if (inp.pressed('KeyC') || inp.padPressed(8)) this.toggleCamera();
      if (inp.pressed('KeyM')) this.toggleMusic();
      if (this.mp === 'online') for (let i = 0; i < EMOTES.length; i++) if (inp.pressed('Digit' + (i + 1))) this.sendEmote(i);
      if (this.mp !== 'off' && (inp.pressed('KeyF') || inp.padPressed(4) || inp.throwReq)) this.throwTomato(1);
      if (p2 && (p2.input.pressed('Slash') || p2.input.pressed('ControlRight') || p2.input.padPressed(4))) this.throwTomato(2);
      if (p2 && (p2.input.pressed('Enter') || p2.input.pressed('NumpadEnter') || p2.input.padPressed(3))) this.resetP2();
      if (p2 && p2.input.padPressed(9)) this.pause();
    }
    inp.endFrame();
    inp.throwReq = false;
    p2?.input.endFrame();
    if (this.paused && !online) return;

    const running = race.state === 'running' && this.p1Finish == null;
    if (this.attract || this.debug.autopilot) this.autopilot(inp);
    const carInput = running && !this.paused ? inp : NO_INPUT;
    this.car.step(dt, carInput, terrain);
    if (this.debug.noTimer) race.timeLeft = 99;
    race.update(dt, this.car, this.car.heading);
    this.raceEvents();
    if (running && this.mode === 'stage' && !this.attract)
      this.ghostRec.record(dt, this.car.x, this.car.y, this.car.z, this.car.heading, this.car.upX, this.car.upZ);
    this.emitFx(this.car, dt, inp.handbrake && running);
    if (p2) {
      this.stepP2(p2, dt, terrain);
      if (resolveCarCar(this.car, p2.car, true, this.contact)) this.carContact(this.contact, p2.car);
    }
    if (online) {
      this.stepOnline(dt);
      this.collideRemotes();
    }
    if (this.mp !== 'off' && !this.attract) {
      this.updateTomatoes(dt);
      this.checkMpEnd();
    }
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
      if (this.mp !== 'off') this.gatePassed(1, race);
    }
    if (e.missed) this.audio.checkpoint(false);
    if (e.finished || e.over) {
      if (this.mp !== 'off') this.localFinished(race.time);
      else this.finishRace();
    }
    this.car.consumeEvents(this.ev);
    if (this.ev.impact > 2.5) {
      this.audio.impact(this.ev.impact);
      this.cam.shake(this.ev.impact * 0.06);
      if (this.ev.impact > 6) buzz(Math.min(80, 20 + this.ev.impact * 3));
      this.burst(this.car, this.car.x, this.car.y + 0.6, this.car.z, 8, 0.5);
      if (this.ev.impact > 5) this.obstacleSparks(this.car, this.ev.impact);
    }
    if (this.ev.landing > 2.5) {
      this.audio.landing(this.ev.landing);
      if (this.ev.landing > HANDLING.landingHardImpact) {
        buzz(35);
        this.cam.shake(this.ev.landing * 0.05);
      }
      this.burst(this.car, this.car.x, this.car.y + 0.2, this.car.z, Math.min(24, this.ev.landing * 2), 1);
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
    const limit = this.attract ? (this.menu.visible && this.menu.current === 'garage' ? 6 : 20) : clamp(44 - bend * 40, 14, 44);
    inp.steer = clamp(-diff * 2.6, -1, 1);
    inp.throttle = car.speed < limit ? 1 : 0;
    inp.brake = car.speed > limit + 4 ? 0.7 : 0;
    inp.handbrake = false;
    if (race.state === 'finished' && this.attract) this.startAttract();
  }

  /* ------------------------------------------------------------------ */
  /* Effects                                                               */
  /* ------------------------------------------------------------------ */
  private surfaceColor(car: Car, surface: number, out: RGB): RGB {
    const m = this.world!.biomeAt(car.x, car.z, this.mix);
    return mixRGB(m.a.pal.surfaces[surface], m.b.pal.surfaces[surface], m.t, out);
  }

  private markRGB: RGB = [0, 0, 0];
  private dustRGB: RGB = [0, 0, 0];

  private emitFx(car: Car, dt: number, handbrake: boolean): void {
    const terrain = this.terrain!;
    const w0 = car === this.car ? 0 : 2; // tyre-mark ribbons: 0,1 = player 1, 2,3 = player 2
    const surf = SURFACES[car.surface];
    const speed = car.speed;
    if (car.airborne) {
      this.marks.add(w0, 0, 0, 0, 0, 0, this.markRGB, terrain);
      this.marks.add(w0 + 1, 0, 0, 0, 0, 0, this.markRGB, terrain);
      return;
    }
    const slip = Math.abs(car.lateralSpeed);
    const markAmt = clamp((slip - HANDLING.driftMarkSlip) / 4 + car.wheelspin * 0.7 + (handbrake && speed > 4 ? 0.6 : 0), 0, 1);
    this.surfaceColor(car, car.surface, this.dustRGB);
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
      this.marks.add(w0 + w, wx, wz, s, co, alpha, this.markRGB, terrain);
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

  private burst(car: Car, x: number, y: number, z: number, count: number, spread: number): void {
    this.surfaceColor(car, car.surface, this.dustRGB);
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
    this.drawCar(this.carModel, car, alpha, dt);
    const p2 = this.p2;
    if (p2) this.drawCar(p2.model, p2.car, alpha, dt);

    // online players
    const now = performance.now();
    for (const r of this.remotes.values()) {
      const b = this.rbuf;
      r.visible = !r.gone && r.sample(now, b);
      r.model.root.visible = r.visible;
      if (r.visible) {
        this.poseCar(r.model, b[0], b[1], b[2], b[3], b[4], Math.sqrt(Math.max(0.01, 1 - b[4] * b[4] - b[5] * b[5])), b[5]);
        setBrakeLights(r.model, r.braking ? 1 : 0);
      }
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

    // world streaming (split-screen: around both cars)
    world.update(car.x, car.z, Math.max(race.progress.idx, p2 ? p2.race.progress.idx : 0, world.track.start));
    // chase camera looks toward the horizon: stream terrain further ahead of the car
    const chase = settings.cameraView === 'chase' && !this.attract;
    const ahead = chase ? this.r3.quality.viewRadius * 0.38 : 0;
    const fx = car.x + car.vx * 1.2 + Math.sin(car.heading) * ahead,
      fz = car.z + car.vz * 1.2 + Math.cos(car.heading) * ahead;
    const tg = performance.now();
    terrain.extra.length = 0;
    if (p2) terrain.extra.push([p2.car.x + p2.car.vx * 1.2 + Math.sin(p2.car.heading) * ahead, p2.car.z + p2.car.vz * 1.2 + Math.cos(p2.car.heading) * ahead]);
    terrain.update(fx, fz, this.r3.quality.genBudgetMs * (p2 ? 1.5 : 1));
    this.perf.genMs = performance.now() - tg;

    // camera
    const garage = false; // the garage shows the car in Mody's 360° showroom instead
    this.cam.zoomTarget = garage ? 0.32 : 1;
    this.cam.shiftTarget = garage ? 1 : 0;
    const ground = this.groundFn;
    this.cam.mode = chase ? 'chase' : 'top';
    this.cam.ground = ground;
    this.cam.update(Math.min(dt, 0.05), ix, iy, iz, car.vx, car.vz, ih, settings.cameraRotate);
    if (p2) {
      p2.cam.mode = this.cam.mode;
      p2.cam.ground = ground;
      const c2 = p2.car;
      p2.cam.update(Math.min(dt, 0.05), lerp(c2.px, c2.x, alpha), lerp(c2.py, c2.y, alpha), lerp(c2.pz, c2.z, alpha), c2.vx, c2.vz, lerpAngle(c2.pHeading, c2.heading, alpha), settings.cameraRotate);
    }
    this.props.update(terrain, this.cam.camera, p2?.cam.camera);

    // lighting (time of day + biome fog)
    const m = world.biomeAt(ix, iz, this.mix);
    mixRGB(m.a.pal.fog, m.b.pal.fog, m.t, this.fog);
    const [ta, tb, tt] = this.timeOfDay(race.maxS);
    this.r3.applyLighting(ta, tb, tt, this.fog, this.cam.dist, chase ? this.r3.quality.viewRadius * 1.2 : Infinity);
    this.skyline.group.visible = chase && this.skyOn;
    if (this.skyline.group.visible) this.skyline.update(this.cam.camera.position.x, iy, this.cam.camera.position.z, this.r3.fog.color);
    this.vignette.style.opacity = String(this.r3.light.vignette);

    // effects
    const groundH = terrain.heightAt(ix, iz);
    this.shadow.update(ix, iz, ih, iy - groundH, terrain, this.r3.light.level);
    this.headlights.update(ix, iz, iy, ih, this.r3.light.headlights, terrain, car.airborne);
    if (p2) {
      const c2 = p2.car;
      p2.shadow.update(c2.x, c2.z, c2.heading, c2.y - terrain.heightAt(c2.x, c2.z), terrain, this.r3.light.level);
      p2.headlights.update(c2.x, c2.z, c2.y, c2.heading, this.r3.light.headlights, terrain, c2.airborne);
    }
    this.particles.update(dt);
    this.sparks.update(dt, ground);
    this.r3.renderer.getDrawingBufferSize(this.bufSize);
    const viewH = p2 && window.innerWidth < window.innerHeight ? this.bufSize.y / 2 : this.bufSize.y;
    this.particles.mat.uniforms.uScale.value = viewH / (2 * Math.tan((this.cam.camera.fov * Math.PI) / 360));
    this.sparks.ptMat.uniforms.uScale.value = this.particles.mat.uniforms.uScale.value;
    this.particles.mat.uniforms.uLight.value = clamp(this.r3.light.level + this.r3.light.headlights * 0.4, 0.15, 1);
    this.marks.flush();
    this.drawGates(dt);

    if (!this.attract) this.updateHud();
    const surf = SURFACES[car.surface];
    this.audio.update(dt, car.speed, race.state === 'running' ? this.input.throttle : 0, Math.max(car.slide, this.input.handbrake ? 0.7 : 0), car.airborne, car.wheelspin, surf.skid, surf.dust);

    this.r3.monitor(frameDt);
    if (p2) this.r3.renderSplit([this.cam.camera, p2.cam.camera]);
    else this.r3.render(this.cam.camera);
    if (this.remotes.size && !this.attract) {
      this.labelLayer.style.display = this.mpShown ? 'none' : '';
      for (const r of this.remotes.values()) r.placeLabel(this.cam.camera, window.innerWidth, window.innerHeight, this.rbufY(r));
    }
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

  /** position the body, suspension and wheels of a simulated car */
  private drawCar(model: CarModel, car: Car, alpha: number, dt: number): void {
    const ix = lerp(car.px, car.x, alpha),
      iy = lerp(car.py, car.y, alpha),
      iz = lerp(car.pz, car.z, alpha);
    const ih = lerpAngle(car.pHeading, car.heading, alpha);
    this.poseCar(model, ix, iy + car.suspOffset * 0.3, iz, ih, car.upX, car.upY, car.upZ);
    setBrakeLights(model, car.braking ? 1 : 0);
    const body = model.body;
    body.position.y = car.suspOffset * 0.5;
    body.rotation.set(-car.pitch, 0, -car.roll);
    const wheels = model.wheels;
    const spin = (car.forwardSpeed * dt) / model.wheelRadius + (car.wheelspin > 0.3 ? 0.4 : 0);
    for (let i = 0; i < 4; i++) {
      wheels[i].rotation.x += spin;
      if (i < 2) wheels[i].rotation.y = -car.steerAngle * 1.3;
      wheels[i].position.y = model.wheelRadius + (car.airborne ? -0.12 : -car.suspOffset * 0.2);
    }
  }

  private groundFn = (x: number, z: number): number => this.terrain?.heightAt(x, z) ?? 0;

  private rbufY(r: RemoteCar): number {
    return r.model.root.position.y;
  }

  /** split-screen player tags and online race position */
  private updateMpHud(): void {
    const race = this.race!;
    const p2 = this.p2;
    const ammoText = (n: number) => (n > 0 ? '🍅'.repeat(n) : '');
    this.hud.set('ammo', p2 ? '' : this.ammo > 0 ? `${ammoText(this.ammo)} ${isTouchDevice() ? '' : 'F'}` : '');
    this.touch.setTomatoes(true, this.ammo);
    if (p2) {
      const lead = race.maxS >= p2.race.maxS ? 0 : 1;
      const tag = (i: number, r: Race, fin: number | null, color: string) => {
        const pos = fin != null ? `FINISHED ${fmtTime(fin)}` : `${(i === lead) === true ? '1st' : '2nd'} · CP ${r.gatesPassed}/${r.gates.length}`;
        const warn = fin == null && r.state === 'running' ? (r.wrongWay ? ' · WRONG WAY' : r.missedWarn > 0 ? ' · MISSED CP' : '') : '';
        const n = i === 0 ? this.ammo : p2.ammo;
        const html = `<i style="background:${color}"></i>P${i + 1} · ${pos}${warn}${n > 0 ? ' · ' + ammoText(n) : ''}`;
        if (this.splitTags[i].innerHTML !== html) this.splitTags[i].innerHTML = html;
      };
      tag(0, race, this.p1Finish, liveryCss(settings.carLivery));
      tag(1, p2.race, p2.finishTime, liveryCss(p2.livery.id));
      if (p2.race.state === 'running' && race.state === 'running' && this.p1Finish != null && p2.finishTime == null)
        this.hud.set('msg', `P2: ${Math.max(0, Math.ceil((this.mpDeadline - performance.now()) / 1000))}s to finish!`);
    } else if (this.mp === 'online') {
      let pos = 1,
        n = 1;
      for (const r of this.remotes.values()) {
        if (r.gone) continue;
        n++;
        if (r.finishTime != null || r.progress > race.maxS) pos++;
      }
      this.hud.set('sub', `${ordinal(pos).toUpperCase()} OF ${n} · ROOM ${this.session?.code ?? ''}`);
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
    // start line (stages)
    if (this.world instanceof StageWorld && race.time < 30) this.gates.draw(tr, this.world.startIdx + 4, 0, true, terrain);
    for (const g of race.gates) {
      if (g.idx < tr.start || g.idx >= tr.end) continue;
      const dx = tr.x(g.idx) - this.car.x,
        dz = tr.z(g.idx) - this.car.z;
      const far2 = this.p2 ? (tr.x(g.idx) - this.p2.car.x) ** 2 + (tr.z(g.idx) - this.p2.car.z) ** 2 : Infinity;
      if (dx * dx + dz * dz > 260 * 260 && far2 > 260 * 260) continue;
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
    if (!msg && this.toast.until > performance.now()) msg = this.toast.text;
    hud.set('msg', msg);
    if (settings.showFps) hud.set('fps', `${this.r3.fps.toFixed(0)} fps · dpr ${this.r3.dpr} · ${this.props.instances} props`);
    const next = race.nextGate();
    const dots = this.dots;
    dots.length = 0;
    if (this.ghostVisible) dots.push({ x: this.ghostPose.x, z: this.ghostPose.z, color: 'rgba(140,200,255,0.8)' });
    if (this.p2) dots.push({ x: this.p2.car.x, z: this.p2.car.z, color: liveryCss(this.p2.livery.id) });
    for (const r of this.remotes.values()) if (r.visible) dots.push({ x: r.x, z: r.z, color: liveryCss(r.player.livery) });
    hud.minimap.draw(this.world!.track, race.gates, next, car.x, car.z, car.heading, dots, settings.cameraRotate || this.cam.mode === 'chase' ? this.cam.yaw : 0);
    if (this.mp !== 'off') this.updateMpHud();
  }
}

const NO_INPUT = { steer: 0, throttle: 0, brake: 0, handbrake: false };

function el(tag: string, cls: string, parent: HTMLElement): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  parent.appendChild(e);
  return e;
}

function ordinal(n: number): string {
  return n + (n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th');
}

/** an emoji that pops up at a screen position and floats away */
function floatEmote(layer: HTMLElement, x: number, y: number, text: string): void {
  const d = document.createElement('div');
  d.className = 'float-emote';
  d.textContent = text;
  d.style.left = x + 'px';
  d.style.top = y + 'px';
  layer.appendChild(d);
  setTimeout(() => d.remove(), 2200);
}
