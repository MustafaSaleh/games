import * as THREE from 'three';
import { QUALITY } from '@engine/config/quality';
import { GameAudio } from '@engine/core/audio';
import { Loop } from '@engine/core/loop';
import { clamp, lerp, lerpAngle } from '@engine/core/math';
import { MusicPlayer } from '@engine/core/music';
import { autoQuality, isTouchDevice, onSettingsChange, settings, updateSettings } from '@engine/core/settings';
import { load, save } from '@engine/core/storage';
import { buzz } from '@engine/core/haptics';
import { FollowCamera } from '@engine/render/camera';
import { BlobShadow, Particles, Sparks, TireMarks } from '@engine/render/effects';
import { Renderer3D } from '@engine/render/renderer';
import { PropRenderer } from '@engine/world/props';
import { LooseRocks, type Pusher } from '@engine/world/rocks';
import { Terrain, makeGroundSample } from '@engine/world/terrain';
import { mixRGB, type BiomeMix, type RGB } from '@engine/world/world';
import { ArenaGround, ArenaWorld, arenaById, buildScenery, type ArenaDef } from './arena';
import { buildWater } from '@engine/render/bridge';
import { disposeGroup } from './world/kit';
import { Debris, PICKUPS, Pickups, Projectiles, SHOTS, type Impact, type PickupKind, type ShotKind, type Target, type Team } from './combat';
import { Alien } from './enemies/alien';
import { Boss } from './enemies/boss';
import { Drone, makeDroneParts, type DroneParts } from './enemies/drones';
import type { Enemy, EnemyCtx, EnemyFx, EnemyKind, PlayerRef } from './enemies/enemy';
import { Walker } from './enemies/walker';
import { TitansInput, TouchSticks } from './input';
import { cleanName, normCode } from '@engine/net/session';
import { localDriver, peerDriver, type NetDriver } from '@engine/net/transport';
import { EMOTES, Room, type Mode, type RoomPlayer, type Side } from './net/room';
import { decodeEnemies, decodePose, decodeShots, encodeEnemy, encodePose, encodeShot, type PoseState } from './net/sync';
import { BattleHud, SIDE_COLORS, Tags, TitansMenu, loadLoadout, type Loadout, type ResultRow } from './ui';
import { MECH, Mech } from './units/mech';
import { Tank } from './units/tank';
import { Scout } from './units/scout';
import { NO_UNIT_INPUT, liveryById, type Livery, type Muzzle, type Unit, type UnitInput } from './units/unit';
import { makeUnitView, type UnitView } from './units/views';
import { bossLevel, waveSpawns } from './waves';
import { BOT_NAMES, Bot } from './bots';
import { LIVERIES, UNIT_KINDS } from './units/unit';
import { SPECIAL_IDS } from './specials';
import { BEAM, EMP, SHIELD_TIME, SPECIALS, TOMATO_STUN, rayHit, type SpecialId } from './specials';

type State = 'menu' | 'playing' | 'paused' | 'over';

/** One pilot: their unit, its 3D view and their power-ups. */
export interface Player {
  id: string;
  name: string;
  team: Team;
  local: boolean;
  unit: Unit;
  view: UnitView;
  livery: Livery;
  bubble: THREE.Mesh;
  shieldT: number;
  rapidT: number;
  tripleT: number;
  score: number;
  /** knock-outs scored on other players (PvP) */
  ko: number;
  slot: number;
  side: Side;
  respawnT: number;
  special: SpecialId;
  /** computer player (practice battles) */
  bot?: Bot;
  specialCd: number;
  specialPrev: boolean;
  rocketsLeft: number;
  rocketT: number;
  /** laser beam time left, its mesh, damage waiting to be reported (online guest) */
  beamT: number;
  beam: THREE.Mesh | null;
  beamAcc: Map<string, { e: Enemy; t: string; dmg: number }>;
  beamSend: number;
  /** player-facing data the enemies see */
  ref: PlayerRef;
}

/** online: the latest pose received for a remote player */
interface RemotePose {
  pose: PoseState;
  at: number;
}

const MATCH_TIME: Record<Mode, number> = { coop: 0, arena: 180, alliance: 240 };
const KO_LIMIT = 10;


export class TitansGame {
  readonly r3: Renderer3D;
  readonly cam = new FollowCamera();
  readonly audio = new GameAudio();
  readonly music = new MusicPlayer();
  readonly input: TitansInput;
  readonly hud: BattleHud;
  readonly menu: TitansMenu;
  readonly sticks: TouchSticks;
  readonly loop: Loop;
  players: Player[] = [];
  enemies: Enemy[] = [];
  private world!: ArenaWorld;
  terrain!: Terrain;
  /** terrain + city cover: what units, shots and enemies collide with */
  ground!: ArenaGround;
  private scenery: THREE.Group | null = null;
  private water: THREE.Mesh | null = null;
  arena: ArenaDef = arenaById(load<string>('titans.arena', 'desert-bowl'));
  private props = new PropRenderer();
  private particles: Particles;
  private sparks = new Sparks(320);
  private marks: TireMarks;
  private shadow = new BlobShadow();
  private rocks: LooseRocks;
  private shots = new Projectiles();
  private debris = new Debris();
  private pickups = new Pickups();
  private droneParts: DroneParts = makeDroneParts();
  private impacts: Impact[] = [];
  private targets: Target[] = [];
  private aimMarker: THREE.Mesh;
  private flash = new THREE.PointLight(0xffb060, 0, 30, 2);
  /** night arenas: a cool fill light and a lamp over your unit */
  private nightFill = new THREE.HemisphereLight(0x9fb0ff, 0x3a3048, 0);
  private lamp = new THREE.PointLight(0xffe2b0, 0, 40, 1.6);
  private bubbleGeo = new THREE.SphereGeometry(1, 18, 12);
  private bubbleMat = new THREE.MeshBasicMaterial({ color: 0x5fb8ff, transparent: true, opacity: 0.18, depthWrite: false, blending: THREE.AdditiveBlending });
  state: State = 'menu';
  wave = 0;
  private queue: EnemyKind[] = [];
  private spawnT = 0;
  private waveT = 0;
  private overT = 0;
  private time = 0;
  private mix: BiomeMix = { a: null!, b: null!, t: 0 };
  private fog: RGB = [0.5, 0.5, 0.5];
  private tmpRGB: RGB = [0, 0, 0];
  private muzzle: Muzzle = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
  private nextId = 0;
  private bufSize = new THREE.Vector2();
  private ramCd = new WeakMap<Enemy, number>();
  private steps = 0;
  private bannerT = 0;
  private ctx: EnemyCtx;
  private loadout: Loadout = loadLoadout();
  /** online room (null = playing alone) */
  room: Room | null = null;
  mode: Mode = 'coop';
  /** offline battle against computer players */
  practice = false;
  private remote = new Map<string, RemotePose>();
  private eshots: number[] = [];
  private matchT = 0;
  private overSent = false;
  private allDownT = 0;
  private crateT = 6;
  private tags: Tags;
  private wakeLock: { release(): Promise<void> } | null = null;

  constructor(canvas: HTMLCanvasElement, ui: HTMLElement) {
    const q = QUALITY[settings.quality === 'auto' ? autoQuality() : settings.quality];
    this.r3 = new Renderer3D(canvas, q);
    this.particles = new Particles(q.particles + 300);
    this.marks = new TireMarks(q.tireMarks);
    this.rocks = new LooseRocks(this.props.material);
    this.aimMarker = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1.25, 24).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffb52e, transparent: true, opacity: 0.85, depthWrite: false }),
    );
    this.aimMarker.renderOrder = 7;
    this.r3.scene.add(this.props.group, this.shadow.mesh, this.marks.mesh, this.particles.points, this.sparks.group, this.rocks.mesh, this.shots.group, this.debris.mesh, this.pickups.group, this.aimMarker, this.flash, this.nightFill, this.lamp);

    this.input = new TitansInput(canvas);
    this.hud = new BattleHud(ui);
    this.sticks = new TouchSticks(ui, this.input);
    this.tags = new Tags(ui);
    this.menu = new TitansMenu(ui, {
      play: () => this.startBattle(),
      loadoutChanged: (l) => {
        this.loadout = { ...l };
        if (this.state === 'menu') this.setLocalPlayer();
        this.room?.setLoadout(l.unit, l.livery);
      },
      createRoom: (name) => void this.createRoom(name),
      joinRoom: (code, name) => void this.joinRoom(code, name),
      leaveRoom: () => this.leaveRoom(),
      startRoom: () => this.room?.start(),
      setMode: (m) => this.room?.setMode(m),
      setSide: (sd) => this.room?.setSide(sd),
      toRoom: () => this.toRoom(),
      practice: (m, skill) => this.startPractice(m, skill),
      pickArena: (id) => {
        if (this.room?.isHost) this.room.setArena(id);
        else this.pickArena(id);
      },
      emote: (i) => this.emote(i),
      resume: () => this.resume(),
      quit: () => this.quit(),
      unlock: () => this.unlockAudio(),
      settingsChanged: () => this.applySettings(),
    });
    this.hud.onPause = () => this.pause();
    this.hud.onCamera = () => updateSettings({ cameraView: settings.cameraView === 'chase' ? 'top' : 'chase' });
    this.hud.onMusic = () => updateSettings({ music: !settings.music });
    this.hud.onEmote = (i) => this.emote(i);
    this.hud.onSpecial = () => {
      const me = this.local;
      if (me && me.specialCd <= 0 && me.unit.alive && this.state === 'playing') this.useSpecial(me);
    };
    onSettingsChange(() => this.applySettings());
    const unlock = () => this.unlockAudio();
    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (this.state === 'playing') this.pause();
        this.audio.suspend();
        this.loop.stop();
      } else {
        this.audio.resume();
        this.loop.start();
      }
    });

    this.ctx = {
      ground: null!,
      players: [],
      enemies: this.enemies,
      fire: (kind, x, y, z, vx, vy, vz) => {
        if (this.room && !this.room.isHost) return; // guests get enemy shots from the host
        this.shots.fire('enemy', kind, x, y, z, vx, vy, vz);
        if (this.room) this.eshots.push(...encodeShot(kind, { x, y, z, vx, vy, vz }));
      },
      hurt: (i, dmg, fx, fz) => this.hurtPlayer(this.players[i], dmg, fx, fz),
      fx: (kind, x, y, z, size) => this.enemyFx(kind, x, y, z, size ?? 1),
    };
    this.loop = new Loop(
      (dt) => this.step(dt),
      (a, dt) => this.render(a, dt),
      () => {
        const u = this.local?.unit;
        this.input.update(this.cam.camera, this.cam.mode === 'chase' ? this.cam.yaw : 0, u ? { x: u.x, y: u.y + u.spec.aimHeight, z: u.z } : { x: 0, y: 0, z: 0 });
      },
    );
    this.loadArena();
    this.setLocalPlayer();
    this.toMenu();
    const code = new URLSearchParams(location.search).get('room');
    if (code) {
      this.menu.codeHint = normCode(code);
      this.menu.show('online');
    }
    this.resize();
    this.loop.start();
  }

  get local(): Player | undefined {
    return this.players.find((p) => p.local);
  }

  get boss(): Boss | undefined {
    return this.enemies.find((e): e is Boss => e.kind === 'boss');
  }

  /* ------------------------------------------------------------------ */
  /* players                                                              */
  /* ------------------------------------------------------------------ */

  private makePlayer(id: string, name: string, l: Loadout, local: boolean, team: Team = 'player', slot = 0, side: Side = 'blue'): Player {
    const livery = liveryById(l.livery);
    const unit: Unit = l.unit === 'mech' ? new Mech() : l.unit === 'scout' ? new Scout() : new Tank();
    const view = makeUnitView(l.unit, livery);
    const bubble = new THREE.Mesh(this.bubbleGeo, this.bubbleMat);
    bubble.visible = false;
    this.r3.scene.add(view.root, bubble);
    const p: Player = { id, name, team, local, unit, view, livery, bubble, shieldT: 0, rapidT: 0, tripleT: 0, score: 0, ko: 0, slot, side, respawnT: 0, special: l.special, specialCd: 0, specialPrev: false, rocketsLeft: 0, rocketT: 0, beamT: 0, beam: null, beamAcc: new Map(), beamSend: 0, ref: { x: 0, y: 0, z: 0, vx: 0, vz: 0, r: unit.spec.radius, alive: false, airborne: false } };
    unit.reset(0, -20, 0, this.ground);
    return p;
  }

  private removePlayer(p: Player): void {
    if (p.beam) {
      p.beam.removeFromParent();
      p.beam.geometry.dispose();
    }
    p.view.dispose();
    p.bubble.removeFromParent();
    this.players = this.players.filter((x) => x !== p);
  }

  /** (re)build the local player's unit from the garage loadout */
  private setLocalPlayer(): void {
    const old = this.local;
    if (old) this.removePlayer(old);
    const p = this.makePlayer('me', 'Mody', this.loadout, true);
    this.players.unshift(p);
    this.sticks.setUnit(this.loadout.unit);
    this.cam.snap(p.unit.x, p.unit.y, p.unit.z, 0);
  }

  /* ------------------------------------------------------------------ */
  /* flow                                                                 */
  /* ------------------------------------------------------------------ */

  private loadArena(def = this.arena): void {
    if (this.terrain && this.world?.def === def) return;
    this.arena = def;
    this.terrain?.dispose();
    if (this.scenery) disposeGroup(this.scenery);
    if (this.water) disposeGroup(this.water);
    this.world = new ArenaWorld(def);
    this.terrain = new Terrain(this.world, this.r3.quality.viewRadius);
    this.terrain.setPropDensity(this.r3.quality.propDensity);
    this.r3.scene.add(this.terrain.group);
    this.terrain.ensureAround(0, 0, 140);
    const sc = buildScenery(def, (x, z) => this.terrain.heightAt(x, z));
    this.scenery = sc.group;
    this.r3.scene.add(sc.group);
    this.ground = new ArenaGround(this.terrain, sc.solids);
    this.water = Number.isFinite(this.world.waterLevel) ? buildWater(this.world.waterLevel) : null;
    if (this.water) this.r3.scene.add(this.water);
    this.ctx.ground = this.ground;
    this.shots.bound = def.radius + 25;
    for (const p of this.players) p.unit.reset(p.unit.x, p.unit.z, p.unit.heading, this.ground);
  }

  /** solo: pick a battlefield (also shown behind the menu) */
  private pickArena(id: string): void {
    save('titans.arena', id);
    this.loadArena(arenaById(id));
    this.resetBattle();
  }

  private clearEnemies(): void {
    for (const e of this.enemies) e.dispose();
    this.enemies.length = 0;
  }

  private resetBattle(): void {
    this.clearEnemies();
    this.shots.clear();
    this.debris.clear();
    this.pickups.clear();
    this.rocks.clear();
    this.particles.clear();
    this.sparks.clear();
    this.marks.clear();
    for (const p of this.players) {
      const sp = this.spawnPoint(p);
      p.unit.reset(sp.x, sp.z, sp.h, this.ground);
      p.shieldT = p.rapidT = p.tripleT = 0;
      p.score = p.ko = p.respawnT = 0;
      p.specialCd = p.rocketsLeft = p.beamT = 0;
    }
    this.matchT = this.multi ? MATCH_TIME[this.mode] : 0;
    this.overSent = false;
    this.allDownT = 0;
    const u = this.local!.unit;
    this.cam.snap(u.x, u.y, u.z, 0);
    this.wave = 0;
    this.queue = [];
    this.waveT = this.multi ? 3 : 1.5;
    this.overT = 0;
    this.hud.boss(false);
  }

  /** where a player starts / respawns */
  private spawnPoint(p: Player): { x: number; z: number; h: number } {
    if (this.multi && this.mode === 'arena') {
      const a = (p.slot / 4) * Math.PI * 2 + Math.PI / 4;
      return { x: Math.sin(a) * 60, z: Math.cos(a) * 60, h: a + Math.PI };
    }
    if (this.multi && this.mode === 'alliance') {
      const mates = this.players.filter((q) => q.side === p.side).sort((a, b) => a.slot - b.slot);
      const k = mates.indexOf(p);
      const dir = p.side === 'blue' ? -1 : 1;
      return { x: (k - (mates.length - 1) / 2) * 12, z: dir * 62, h: dir < 0 ? 0 : Math.PI };
    }
    return { x: (p.slot - (this.players.length - 1) / 2) * 9, z: -20, h: 0 };
  }

  /** do enemies / waves happen in this game? */
  get enemiesOn(): boolean {
    return !this.multi || this.mode !== 'arena';
  }

  /** does this device run the enemies (solo, or the online host)? */
  /** a battle with other players (online or bots) */
  get multi(): boolean {
    return !!this.room || this.practice;
  }

  get authority(): boolean {
    return !this.room || this.room.isHost;
  }

  private toMenu(): void {
    if (this.practice) this.endPractice();
    this.state = 'menu';
    this.hud.online(false);
    this.tags.clear();
    this.resetBattle();
    for (let i = 0; i < 3; i++) this.spawn('drone', i * 2.1);
    this.hud.show(false);
    this.sticks.show(false);
    this.input.enabled = false;
    this.audio.setActive(false);
    this.menu.show('main');
    this.updateMusic();
  }

  startBattle(): void {
    this.resetBattle();
    this.state = 'playing';
    this.menu.hide();
    this.hud.show(true);
    this.sticks.show(isTouchDevice());
    this.input.enabled = true;
    this.audio.setActive(true);
    this.updateMusic();
  }

  private pause(): void {
    if (this.state !== 'playing') return;
    if (this.room) {
      // online the battle can't stop: just show the menu over it
      this.menu.show('pause');
      return;
    }
    this.state = 'paused';
    this.audio.setActive(false);
    this.sticks.show(false);
    this.menu.show('pause');
  }

  private resume(): void {
    if (this.room && this.state === 'playing') {
      this.menu.hide();
      return;
    }
    this.state = 'playing';
    this.menu.hide();
    this.audio.setActive(true);
    this.sticks.show(isTouchDevice());
  }

  private quit(): void {
    this.toMenu();
  }

  get score(): number {
    return this.players.reduce((s, p) => s + p.score, 0);
  }

  private gameOver(): void {
    this.state = 'over';
    const best = load<number>('titans.best', 0);
    const coins = this.menu.earn(this.score / 40 + this.wave * 5);
    this.menu.result = { wave: this.wave, score: this.score, best, record: this.score > best, coins };
    if (this.score > best) save('titans.best', this.score);
    this.hud.show(false);
    this.sticks.show(false);
    this.audio.setActive(false);
    this.menu.show('over');
    this.updateMusic();
  }

  private unlockAudio(): void {
    this.audio.unlock();
    const ctx = this.audio.context;
    if (ctx) {
      this.music.attach(ctx, this.audio.noiseBuffer);
      this.updateMusic();
    }
  }

  private updateMusic(): void {
    this.music.set(settings.music, settings.musicVolume);
    this.music.play(this.state === 'playing' ? (this.boss ? 'turbo' : this.arena.music) : 'sunny');
  }

  private applySettings(): void {
    this.audio.applyVolume();
    this.updateMusic();
  }

  private resize(): void {
    this.r3.resize();
    this.cam.resize(window.innerWidth, window.innerHeight);
  }

  private banner(text: string, ms: number): void {
    this.hud.set('banner', text);
    clearTimeout(this.bannerT);
    this.bannerT = window.setTimeout(() => this.hud.set('banner', ''), ms);
  }

  /* ------------------------------------------------------------------ */
  /* online                                                               */
  /* ------------------------------------------------------------------ */

  private driver(): Promise<NetDriver> {
    return new URLSearchParams(location.search).get('net') === 'local' ? Promise.resolve(localDriver('dusttitans-')) : peerDriver('dusttitans-v1-');
  }

  private netMessage(e: unknown): string {
    const m = (e as Error)?.message ?? '';
    if (m === 'not-found') return "Couldn't find that room. Check the code (like TIGER-42) and that your friend's game is open.";
    if (m === 'full') return 'That room is full (4 players max).';
    if (m === 'playing') return 'That room is in the middle of a battle. Try again when it is back in the room.';
    if (m === 'version') return 'You and the host have different versions of the game. Both of you: reload the page, then try again. (version)';
    if (m === 'offline') return "Couldn't reach the room server. Check your internet and try again. (offline)";
    if (m === 'timeout') return "Found the room, but the host's device didn't answer. The host must keep the game open on screen. (timeout)";
    if (m === 'connect-failed') return "Found the room, but couldn't connect to the host's device. Try another Wi-Fi or mobile data. (connect-failed)";
    return `Something went wrong. Try again. (${m || 'unknown'})`;
  }

  private async createRoom(name: string): Promise<void> {
    save('mp.name', cleanName(name));
    this.menu.netBusy = 'Creating room…';
    this.menu.netError = '';
    this.menu.refresh();
    try {
      const room = await Room.create(await this.driver(), name, this.loadout.unit, this.loadout.livery, this.arena.id);
      this.bindRoom(room);
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
      const driver = await this.driver();
      const until = performance.now() + 60000;
      let room: Room | null = null;
      for (let attempt = 1; !room; attempt++) {
        try {
          room = await Room.join(driver, normCode(code), name, this.loadout.unit, this.loadout.livery);
        } catch (e) {
          const m = (e as Error).message;
          const retry = m === 'timeout' || m === 'closed' || (m === 'not-found' && attempt < 4);
          if (!retry || performance.now() > until || this.menu.current !== 'online') throw e;
          this.menu.netBusy = m === 'not-found' ? `Looking for room ${normCode(code)}…` : "Waiting for the host's device to answer…";
          this.menu.refresh();
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
      this.bindRoom(room);
    } catch (e) {
      this.menu.netBusy = '';
      this.menu.netError = this.netMessage(e);
      this.menu.refresh();
    }
  }

  private bindRoom(room: Room): void {
    this.room = room;
    this.menu.room = room;
    this.menu.netBusy = '';
    const url = new URL(location.href);
    url.search = '';
    url.searchParams.set('room', room.code);
    if (new URLSearchParams(location.search).get('net') === 'local') url.searchParams.set('net', 'local');
    this.menu.shareUrl = url.toString();
    room.ev = {
      lobby: () => {
        if (this.menu.current === 'room') this.menu.refresh();
      },
      start: (mode, arena, players, seed) => this.startOnline(mode, players, seed, arena),
      game: (t, id, d) => this.onGame(t, id, d),
      left: (id) => {
        const p = this.players.find((x) => x.id === id && !x.local);
        if (p) {
          if (this.state === 'playing') this.banner(`${p.name} left`, 1800);
          this.removePlayer(p);
          this.remote.delete(id);
        }
        if (this.menu.current === 'room') this.menu.refresh();
      },
      closed: (reason) => {
        this.dropRoom();
        this.toMenu();
        this.menu.netError = reason;
        this.menu.show('online');
      },
    };
    void this.keepAwake(true);
    this.menu.show('room');
  }

  private dropRoom(): void {
    this.room = null;
    this.menu.room = null;
    this.remote.clear();
    for (const p of this.players.filter((x) => !x.local)) this.removePlayer(p);
    void this.keepAwake(false);
  }

  private leaveRoom(): void {
    const r = this.room;
    this.dropRoom();
    r?.leave();
    this.setLocalPlayer();
    this.toMenu();
  }

  /** back from a battle / results to the room lobby */
  private toRoom(): void {
    if (!this.room) return this.toMenu();
    for (const p of this.players.filter((x) => !x.local)) this.removePlayer(p);
    this.remote.clear();
    this.setLocalPlayer();
    this.toMenu();
    this.room.endGame();
    this.menu.show('room');
  }

  private async keepAwake(on: boolean): Promise<void> {
    const nav = navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } };
    try {
      if (on && !this.wakeLock && nav.wakeLock && !document.hidden) this.wakeLock = await nav.wakeLock.request('screen');
      else if (!on && this.wakeLock) {
        await this.wakeLock.release();
        this.wakeLock = null;
      }
    } catch {
      /* not allowed: fine */
    }
  }

  /** the host pressed Start: build every player and go */
  private startOnline(mode: Mode, players: RoomPlayer[], _seed: number, arena: string): void {
    const room = this.room;
    if (!room) return;
    this.loadArena(arenaById(arena));
    this.mode = mode;
    for (const p of [...this.players]) this.removePlayer(p);
    this.remote.clear();
    const teamOf = (rp: RoomPlayer): Team => (mode === 'coop' ? 'player' : mode === 'arena' ? 'p-' + rp.id : rp.side);
    for (const rp of players) {
      const local = rp.id === room.myId;
      const l: Loadout = local ? this.loadout : { unit: rp.unit, livery: rp.livery, special: 'rockets' };
      const p = this.makePlayer(rp.id, rp.name, l, local, teamOf(rp), rp.slot, rp.side);
      if (local) this.players.unshift(p);
      else this.players.push(p);
    }
    this.sticks.setUnit(this.loadout.unit);
    this.startBattle();
    this.hud.online(true);
    this.banner(mode === 'coop' ? '🤝 Defend together!' : mode === 'arena' ? '⚔️ Arena battle!' : this.local!.side === 'blue' ? '🔵 Blue team: go!' : '🔴 Red team: go!', 2200);
  }

  private emote(i: number): void {
    if (!this.room || !EMOTES[i]) return;
    this.room.send('emote', i);
    this.tags.emote(this.room.myId, EMOTES[i]);
  }

  /** a game message from another device */
  private onGame(t: string, id: string, d: unknown): void {
    const p = this.players.find((x) => x.id === id);
    if (t === 'emote') {
      const e = EMOTES[d as number];
      if (e) this.tags.emote(id, e);
      return;
    }
    if (this.state === 'menu' && t !== 'over') return;
    if (t === 'pose') {
      const pose = decodePose(d);
      if (pose && p && !p.local) this.remote.set(id, { pose, at: performance.now() });
    } else if (t === 'shot' && p && !p.local) {
      for (const sh of decodeShots(d)) {
        this.shots.fire(p.team, sh.kind, sh.x, sh.y, sh.z, sh.vx, sh.vy, sh.vz, p.id);
        this.sparks.emit(sh.x, sh.y, sh.z, sh.kind === 'shell' ? 8 : 3, sh.kind === 'shell' ? 6 : 3);
      }
      p.unit.fired = true;
    } else if (t === 'beam' && p && !p.local) {
      p.beamT = Math.min(2, +(d as number) || 0);
    } else if (t === 'emp' && p && !p.local) {
      const e = d as { x: number; z: number };
      this.empAt(p, +e.x || 0, +e.z || 0);
    } else if (t === 'eshot') {
      for (const sh of decodeShots(d)) this.shots.fire('enemy', sh.kind, sh.x, sh.y, sh.z, sh.vx, sh.vy, sh.vz);
    } else if (t === 'enemies') this.applyEnemies(d);
    else if (t === 'wave') {
      const w = d as { n: number; boss: boolean };
      this.wave = +w.n || 0;
      this.banner(w.boss ? '⚠️ GIANT ROBOT!' : `WAVE ${this.wave}`, w.boss ? 2600 : 1800);
      this.audio.beep(true);
    } else if (t === 'drop') {
      const c = d as { i: number; x: number; y: number; z: number; k: PickupKind };
      if (PICKUPS[c.k]) this.pickups.drop(c.x, c.y, c.z, c.k, c.i);
    } else if (t === 'take') this.pickups.remove(+(d as number));
    else if (t === 'ko') {
      const by = this.players.find((x) => x.id === String((d as { by: string }).by));
      if (by) by.ko++;
      if (p) this.koBanner(p, by);
    } else if (t === 'hit' && this.authority) {
      const h = d as { e: string; t: string; dmg: number };
      const e = this.enemies.find((x) => x.id === h.e);
      if (!e || !(h.dmg > 0) || h.dmg > 80) return;
      const tg: Target[] = [];
      e.targets(tg);
      const target = tg.find((x) => x.id === h.t) ?? tg.find((x) => !x.armor);
      if (target && e.damage(target, h.dmg, this.ctx) === 'killed') this.onKill(e, p);
    } else if (t === 'score') {
      const sc = d as Record<string, number>;
      for (const q of this.players) if (typeof sc[q.id] === 'number') q.score = sc[q.id];
    } else if (t === 'clock') this.matchT = +(d as number) || 0;
    else if (t === 'over') this.showMpOver(d as { title: string; sub: string });
  }

  private koBanner(victim: Player, by: Player | undefined): void {
    if (by && by.local) this.banner(`💥 You knocked out ${victim.name}!`, 1600);
    else if (victim.local) this.banner(by ? `${by.name} knocked you out!` : 'KNOCKED OUT!', 1800);
    else this.banner(by ? `${by.name} 💥 ${victim.name}` : `${victim.name} is out`, 1400);
  }

  /** guests: follow the host's enemies */
  private applyEnemies(d: unknown): void {
    const rows = decodeEnemies(d);
    const seen = new Set<string>();
    for (const r of rows) {
      seen.add(r.id);
      let e = this.enemies.find((x) => x.id === r.id);
      if (!e) {
        e = this.spawn(r.kind, 0, r.id);
        e.x = r.x;
        e.y = r.y;
        e.z = r.z;
        if (r.kind === 'boss') {
          this.hud.boss(true);
          this.updateMusic();
        }
      }
      const far = Math.hypot(e.x - r.x, e.z - r.z) > 8;
      e.x = far ? r.x : e.x + (r.x - e.x) * 0.5;
      e.z = far ? r.z : e.z + (r.z - e.z) * 0.5;
      if (e.kind === 'drone') e.y = far ? r.y : e.y + (r.y - e.y) * 0.5;
      e.vx = r.vx;
      e.vz = r.vz;
      const any = e as unknown as { hp?: number; heading?: number };
      if (r.kind !== 'boss') {
        if (any.hp !== undefined && r.hp < any.hp) (e as unknown as { hitFlash: number }).hitFlash = 0.15;
        any.hp = r.hp;
      }
      if (r.kind === 'walker' || r.kind === 'boss') any.heading = r.heading;
      if (r.boss) (e as Boss).netState(r.boss.k0, r.boss.k1, r.boss.core, r.boss.state);
    }
    // gone on the host: destroyed
    for (const e of this.enemies)
      if (!seen.has(e.id) && e.alive) {
        if (e.kind === 'boss') (e as Boss).netState(0, 0, 0, 3);
        else {
          (e as unknown as { hp: number }).hp = 0;
          this.killFx(e);
        }
      }
  }

  /** every step online: send my pose; the host also sends enemies, shots, scores */
  private netSend(): void {
    const room = this.room;
    const me = this.local;
    if (!room || !me || this.state !== 'playing') return;
    if (this.steps % 3 === 0) room.send('pose', encodePose(me.unit, me.shieldT > 0));
    if (!room.isHost) return;
    if (this.eshots.length) {
      room.send('eshot', this.eshots);
      this.eshots = [];
    }
    if (this.enemiesOn && this.steps % 6 === 0) room.send('enemies', this.enemies.filter((e) => e.alive || e.kind === 'boss').map(encodeEnemy));
    if (this.steps % 30 === 0) {
      const sc: Record<string, number> = {};
      for (const p of this.players) sc[p.id] = p.score;
      room.send('score', sc);
      if (this.matchT > 0) room.send('clock', Math.round(this.matchT));
    }
  }

  /** remote units follow their latest pose (a little extrapolation, smoothed) */
  private applyRemote(p: Player, dt: number): void {
    const r = this.remote.get(p.id);
    const u = p.unit;
    u.px = u.x;
    u.py = u.y;
    u.pz = u.z;
    u.pHeading = u.heading;
    u.pTurret = u.turret;
    u.fired = false;
    u.landed = 0;
    if (!r) return;
    const q = r.pose;
    const age = Math.min(0.25, (performance.now() - r.at) / 1000);
    const tx = q.x + q.vx * age,
      tz = q.z + q.vz * age,
      ty = q.y + (q.airborne ? q.vy * age : 0);
    const k = 1 - Math.exp(-14 * dt);
    if (Math.hypot(tx - u.x, tz - u.z) > 10) {
      u.x = tx;
      u.z = tz;
      u.y = ty;
    } else {
      u.x += (tx - u.x) * k;
      u.y += (ty - u.y) * k;
      u.z += (tz - u.z) * k;
    }
    u.heading = lerpAngle(u.heading, q.heading, k);
    u.turret = lerpAngle(u.turret, q.turret, k);
    u.vx = q.vx;
    u.vy = q.vy;
    u.vz = q.vz;
    const wasAlive = u.alive;
    u.hp = q.hp;
    if (wasAlive && !u.alive) {
      this.explode(u.x, u.y + 1.5, u.z, 2.2);
      this.debris.burst(u.x, u.y + 1.5, u.z, 12, 1.4);
    }
    u.energy = q.energy;
    u.airborne = q.airborne;
    u.dashing = q.dashing;
    const m = u as Mech;
    if (u.kind === 'mech') {
      m.stride = q.stride;
      m.jets = q.jets;
    }
    u.drive = clamp(Math.hypot(q.vx, q.vz) / u.spec.maxSpeed, 0, 1);
    p.shieldT = q.shield ? 1 : 0;
    const g = this.terrain.sample(u.x, u.z, this.gs);
    const up = u.spec.upright;
    u.upX += (g.nx * up - u.upX) * k;
    u.upY += ((up < 1 ? 1 : g.ny) - u.upY) * k;
    u.upZ += (g.nz * up - u.upZ) * k;
  }
  private gs = makeGroundSample();

  /** online end of game: the host decides */
  private checkMpOver(dt: number): void {
    if (!this.authority || this.overSent) return;
    let over: { title: string; sub: string } | null = null;
    if (this.mode === 'coop') {
      const down = this.players.every((p) => !p.unit.alive);
      this.allDownT = down ? this.allDownT + dt : 0;
      if (this.allDownT > 2) over = { title: 'Knocked out!', sub: `Your team reached wave ${this.wave}` };
    } else {
      this.matchT -= dt;
      const top = Math.max(...this.players.map((p) => p.ko));
      if (this.matchT <= 0 || (this.mode === 'arena' && top >= KO_LIMIT)) over = { title: '', sub: '' };
    }
    if (!over) return;
    this.overSent = true;
    if (this.mode !== 'coop') over = this.pvpResult();
    this.room?.send('over', over);
    this.showMpOver(over);
  }

  private teamPoints(side: Side): number {
    return this.players.filter((p) => p.side === side).reduce((s, p) => s + p.score + p.ko * 1000, 0);
  }

  private pvpResult(): { title: string; sub: string } {
    if (this.mode === 'alliance') {
      const b = this.teamPoints('blue'),
        r = this.teamPoints('red');
      return { title: b === r ? "It's a draw!" : b > r ? '🔵 Blue team wins!' : '🔴 Red team wins!', sub: 'Points: enemies destroyed + 1000 per knock-out' };
    }
    const best = [...this.players].sort((a, b) => b.ko - a.ko || b.score - a.score)[0];
    return { title: `🏆 ${best?.name ?? ''} wins!`, sub: `Most knock-outs (${best?.ko ?? 0})` };
  }

  private showMpOver(o: { title: string; sub: string }): void {
    if (this.state === 'menu') return;
    this.state = 'over';
    const rows: ResultRow[] = [...this.players]
      .sort((a, b) => (this.mode === 'coop' ? b.score - a.score : b.ko - a.ko || b.score - a.score))
      .map((p) => ({ name: p.name, me: p.local, score: p.score, ko: p.ko, side: this.mode === 'alliance' ? p.side : undefined }));
    const me = this.local;
    const coins = me ? this.menu.earn(me.score / 40 + me.ko * 20 + this.wave * 3 + 10) : 0;
    this.menu.mpResult = { title: String(o.title || ''), sub: String(o.sub || ''), rows, teams: this.mode === 'alliance' ? { blue: this.teamPoints('blue'), red: this.teamPoints('red') } : undefined, coins };
    this.hud.show(false);
    this.sticks.show(false);
    this.audio.setActive(false);
    this.menu.show('mpover');
    this.updateMusic();
  }

  /** local player knocked out online: respawn (PvP always, co-op while a teammate stands) */
  private respawnStep(dt: number): void {
    for (const b of this.players) if (b.bot) this.respawnOne(b, dt);
    const me = this.local;
    if (!this.multi || !me || me.unit.alive || this.state !== 'playing') return;
    this.respawnOne(me, dt);
  }

  /** knocked out: respawn (PvP always, co-op while a teammate stands) */
  private respawnOne(p: Player, dt: number): void {
    if (p.unit.alive || this.state !== 'playing') return;
    const mates = this.players.filter((q) => q !== p && q.team === p.team && q.unit.alive);
    if (this.mode === 'coop' && !mates.length) {
      p.respawnT = 6;
      return;
    }
    p.respawnT -= dt;
    if (p.local) this.hud.set('banner', `Back in ${Math.max(1, Math.ceil(p.respawnT))}…`);
    if (p.respawnT > 0) return;
    const sp = this.mode === 'coop' && mates.length ? { x: mates[0].unit.x + 6, z: mates[0].unit.z, h: mates[0].unit.heading } : this.spawnPoint(p);
    p.unit.reset(sp.x, sp.z, sp.h, this.ground);
    if (this.mode === 'coop') p.unit.hp = p.unit.spec.maxHp * 0.6;
    p.shieldT = 3;
    if (p.local) this.hud.set('banner', '');
  }

  /* ------------------------------------------------------------------ */
  /* practice battles (computer players)                                  */
  /* ------------------------------------------------------------------ */

  private botWorld = (() => {
    const game = this;
    return {
      get radius() {
        return game.arena.radius;
      },
      get players() {
        return game.players;
      },
      get enemies() {
        return game.enemies;
      },
      crate: (x: number, z: number) => game.pickups.nearest(x, z),
    };
  })();

  /** offline Arena (you + 3 bots) or Alliance (you + 1 bot vs 2 bots, with enemy waves) */
  startPractice(mode: Mode, skill: number): void {
    this.endPractice();
    this.practice = true;
    this.mode = mode;
    const me = this.local!;
    me.team = mode === 'arena' ? 'p-me' : 'blue';
    me.side = 'blue';
    me.slot = 0;
    const names = [...BOT_NAMES].sort(() => Math.random() - 0.5);
    for (let i = 1; i <= 3; i++) {
      const side: Side = mode === 'alliance' && i >= 2 ? 'red' : 'blue';
      const l: Loadout = { unit: UNIT_KINDS[Math.floor(Math.random() * 3)], livery: LIVERIES[(i * 2 + Math.floor(Math.random() * 5)) % LIVERIES.length].id, special: SPECIAL_IDS[Math.floor(Math.random() * SPECIAL_IDS.length)] };
      const p = this.makePlayer('bot' + i, names[i - 1], l, false, mode === 'arena' ? 'p-bot' + i : side, i, side);
      p.bot = new Bot(skill, i * 7 + Math.floor(Math.random() * 100));
      this.players.push(p);
    }
    this.startBattle();
    this.hud.online(true, false);
    this.banner(mode === 'arena' ? '⚔️ Arena practice!' : '🔵 You + ally vs 🔴 Red team!', 2200);
  }

  private endPractice(): void {
    if (!this.practice) return;
    this.practice = false;
    for (const p of this.players.filter((q) => q.bot)) this.removePlayer(p);
    this.mode = 'coop';
    const me = this.local;
    if (me) {
      me.team = 'player';
      me.slot = 0;
    }
  }

  /* ------------------------------------------------------------------ */
  /* enemies                                                              */
  /* ------------------------------------------------------------------ */

  spawn(kind: EnemyKind, angle?: number, forceId?: string): Enemy {
    const id = forceId ?? kind + this.nextId++;
    const seed = this.nextId;
    const e: Enemy = kind === 'drone' ? new Drone(id, this.droneParts, seed) : kind === 'walker' ? new Walker(id, seed) : kind === 'alien' ? new Alien(id, seed) : new Boss(id, bossLevel(this.wave));
    const me = this.local?.unit;
    // spawn away from the players (boss: on the far side)
    let a = angle ?? Math.random() * Math.PI * 2;
    if (angle == null && me) {
      const away = Math.atan2(-me.x, -me.z);
      a = kind === 'boss' ? away + (Math.random() - 0.5) * 0.6 : a;
      for (let k = 0; k < 8; k++) {
        const R = this.world.def.radius * 0.55;
        if (Math.hypot(Math.sin(a) * R - me.x, Math.cos(a) * R - me.z) > 35) break;
        a += 0.8;
      }
    }
    const R = this.world.def.radius * (kind === 'boss' ? 0.6 : 0.5);
    e.x = Math.sin(a) * R;
    e.z = Math.cos(a) * R;
    e.y = this.terrain.heightAt(e.x, e.z) + (kind === 'drone' ? 18 : 0);
    this.enemies.push(e);
    this.r3.scene.add(e.mesh);
    return e;
  }

  private enemyFx(kind: EnemyFx, x: number, y: number, z: number, size: number): void {
    if (kind === 'explode') this.explode(x, y, z, size);
    else if (kind === 'bigExplode') {
      this.explode(x, y, z, size);
      this.debris.burst(x, y, z, Math.round(8 * size), 1.2 * size);
    } else if (kind === 'stomp') this.stompFx(x, y, z, size);
    else if (kind === 'jelly') {
      this.puff(x, y, z, 10, [0.55, 1, 0.5], 1);
      this.audio.splat(true);
    } else if (kind === 'warn') this.audio.beep(false);
    else if (kind === 'roar') {
      this.audio.whoosh();
      this.audio.impact(6);
    } else if (kind === 'sparks') this.sparks.emit(x, y, z, 16, 5);
  }

  /* ------------------------------------------------------------------ */
  /* simulation (60 Hz)                                                   */
  /* ------------------------------------------------------------------ */

  private step(dt: number): void {
    const inp = this.input;
    this.time += dt;
    this.steps++;
    if (this.state === 'playing') {
      if (inp.pressed('Escape') || inp.pressed('KeyP') || inp.padPressed(9)) this.pause();
      if (inp.pressed('KeyC') || inp.padPressed(8)) this.hud.onCamera();
      if (inp.pressed('KeyM')) this.hud.onMusic();
    }
    inp.endFrame();
    if (this.state === 'paused') return;
    const terrain = this.terrain;
    const ground = this.ground;
    const playing = this.state === 'playing';

    // ---- players ----
    for (const p of this.players) {
      const u = p.unit;
      if (!p.local && !p.bot && this.room) {
        this.applyRemote(p, dt);
        const r = p.ref;
        r.x = u.x;
        r.y = u.y;
        r.z = u.z;
        r.vx = u.vx;
        r.vz = u.vz;
        r.airborne = u.airborne;
        r.alive = playing && u.alive;
        continue;
      }
      const ui: UnitInput = p.bot && playing ? p.bot.think(dt, p, this.botWorld) : p.local && playing && u.alive ? inp.unit : NO_UNIT_INPUT;
      u.reloadScale = (p.rapidT > 0 ? 0.45 : 1) * (p.local ? 1 - 0.07 * this.menu.ups.reload : 1);
      u.energyMul = p.local ? 1 + 0.15 * this.menu.ups.energy : 1;
      u.step(dt, ui, ground);
      this.wade(u, dt);
      this.world.clamp(u);
      p.shieldT = Math.max(0, p.shieldT - dt);
      p.rapidT = Math.max(0, p.rapidT - dt);
      p.tripleT = Math.max(0, p.tripleT - dt);
      if (u.impact > 3 && p.local) {
        this.audio.impact(u.impact * 1.5);
        this.cam.shake(u.impact * 0.05);
      }
      if (u.fired) this.fireWeapon(p);
      this.specialStep(p, ui, dt);
      if (u.kind === 'mech') this.mechFx(p, u as Mech);
      else this.trackMarks(u);
      if (u.landed > MECH.stompSpeed && u.alive) this.playerStomp(p);
      // loose rocks
      const pusher: Pusher = {
        x: u.x,
        y: u.y,
        z: u.z,
        vx: u.vx,
        vz: u.vz,
        heading: u.heading,
        mass: u.spec.mass,
        push: (dx, dz) => {
          u.vx += dx;
          u.vz += dz;
        },
      };
      this.rocks.wake(pusher, terrain, this.world.knockedRocks);
      if (this.rocks.count) this.rocks.step(dt, terrain, [pusher]);
      const r = p.ref;
      r.x = u.x;
      r.y = u.y;
      r.z = u.z;
      r.vx = u.vx;
      r.vz = u.vz;
      r.airborne = u.airborne;
      r.alive = playing && u.alive;
    }

    // ---- enemies ----
    this.ctx.players = this.players.map((p) => p.ref);
    for (const e of this.enemies) {
      if (e.stunT && e.stunT > 0) {
        e.stunT -= dt;
        if (this.steps % 8 === 0) this.sparks.emit(e.x, e.y + (e.kind === 'walker' ? 2.5 : e.kind === 'boss' ? 9 : 1), e.z, 4, 3);
        continue;
      }
      e.update(dt, this.ctx);
      if (e.kind !== 'boss') this.world.clamp(e, e.kind === 'drone' ? -10 : 4);
      else this.world.clamp(e, 12);
    }
    this.contacts(dt);

    // ---- shots ----
    const tg = this.targets;
    tg.length = 0;
    for (const p of this.players) {
      const u = p.unit;
      tg.push({ id: p.id, team: p.team, x: u.x, y: u.y + u.spec.hitHeight, z: u.z, r: u.spec.hitR, alive: u.alive && playing, owner: p });
    }
    for (const e of this.enemies) e.targets(tg);
    for (const p of this.players) if (p.beamT > 0) this.beamStep(p, dt);
    this.updateRings(dt);
    this.shots.step(dt, ground, tg, this.impacts);
    for (const hit of this.impacts) this.onImpact(hit);
    this.debris.step(dt, ground);
    const sim = this.players.filter((p) => p.local || p.bot);
    const got = this.pickups.step(dt, this.time, ground, sim.map((p) => ({ x: p.unit.x, z: p.unit.z, alive: p.unit.alive && playing })), 3.2);
    for (const g of got) {
      this.applyPickup(sim[g.by], g.kind);
      this.room?.send('take', g.id);
    }

    // ---- clean up destroyed enemies ----
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (!e.alive) {
        e.dispose();
        this.enemies.splice(i, 1);
        if (e.kind === 'boss') {
          this.hud.boss(false);
          this.updateMusic();
        }
      }
    }

    if (playing && this.authority && this.enemiesOn) this.waves(dt);
    if (playing && this.authority && this.multi && this.mode === 'arena') {
      this.crateT -= dt;
      if (this.crateT <= 0) {
        this.crateT = 10;
        const a = Math.random() * Math.PI * 2,
          R = Math.random() * 70;
        const k: PickupKind[] = ['repair', 'shield', 'rapid', 'triple'];
        this.dropCrate(Math.sin(a) * R, this.terrain.heightAt(Math.sin(a) * R, Math.cos(a) * R) + 8, Math.cos(a) * R, k[Math.floor(Math.random() * 4)]);
      }
    }
    if (this.multi) {
      if (playing) {
        this.respawnStep(dt);
        this.checkMpOver(dt);
      }
      if (this.room) this.netSend();
    } else if (playing && this.players.every((p) => !p.unit.alive)) {
      this.overT += dt;
      if (this.overT > 1.8) this.gameOver();
    }
  }

  private waves(dt: number): void {
    const alive = this.enemies.length > 0;
    if (!alive && this.queue.length === 0) {
      this.waveT -= dt;
      if (this.waveT <= 0) {
        this.wave++;
        this.queue = waveSpawns(this.wave);
        this.spawnT = 0;
        this.waveT = 3;
        const boss = this.queue.includes('boss');
        this.room?.send('wave', { n: this.wave, boss });
        this.banner(boss ? `⚠️ GIANT ROBOT!` : `WAVE ${this.wave}`, boss ? 2600 : 1800);
        this.audio.beep(true);
        if (boss) this.audio.impact(12);
      }
    }
    if (this.queue.length) {
      this.spawnT -= dt;
      if (this.spawnT <= 0) {
        const kind = this.queue.shift()!;
        this.spawn(kind);
        this.spawnT = kind === 'boss' ? 2.5 : 1.0;
        if (kind === 'boss') {
          this.hud.boss(true);
          this.hud.set('bossName', this.wave >= 10 ? `GIANT ROBOT MK ${bossLevel(this.wave)}` : 'GIANT ROBOT');
          this.updateMusic();
        }
      }
    }
  }

  /** shoot: shell / bolt, triple-shot spread, kid-friendly aim assist */
  private fireWeapon(p: Player): void {
    const u = p.unit;
    const kind: ShotKind = u.spec.shot;
    const spreads = p.tripleT > 0 ? [0, -0.13, 0.13] : [0];
    const sent: number[] = [];
    let vy = 0;
    for (let i = 0; i < spreads.length; i++) {
      u.muzzle(this.muzzle, spreads[i]);
      const m = this.muzzle;
      if (i === 0) {
        this.aimAssist(m, kind, p);
        vy = m.vy;
      } else m.vy = vy;
      this.shots.fire(p.team, kind, m.x, m.y, m.z, m.vx, m.vy, m.vz, p.id);
      if (this.room) sent.push(...encodeShot(kind, m));
    }
    if (this.room && sent.length) this.room.send('shot', sent);
    const m = this.muzzle;
    const s = Math.sin(u.turret),
      c = Math.cos(u.turret);
    if (kind === 'shell') {
      this.sparks.emit(m.x, m.y, m.z, 10, 6, s * 0.8, c * 0.8);
      this.puff(m.x, m.y, m.z, 6, [0.85, 0.82, 0.78], 1.2);
      if (p.local) {
        this.audio.impact(9);
        this.audio.whoosh();
        this.cam.shake(0.25);
      }
    } else {
      this.sparks.emit(m.x, m.y, m.z, 4, 3, s * 0.6, c * 0.6);
      if (p.local) this.audio.impact(3.5);
    }
  }

  /** bend the shot toward the enemy weak spot closest to the aim line */
  private aimAssist(m: Muzzle, kind: ShotKind, shooter = this.local): void {
    const sp = Math.hypot(m.vx, m.vz);
    const g = SHOTS[kind].gravity;
    let best: { x: number; y: number; z: number; vx: number; vz: number } | null = null,
      bestScore = 0.3; // ~17° off the barrel
    const pts: { x: number; y: number; z: number }[] = [];
    const me = shooter;
    for (const p of this.players) {
      if (!this.multi || p === me || !p.unit.alive || p.team === me?.team) continue;
      const u = p.unit;
      const dx = u.x - m.x,
        dz = u.z - m.z;
      if (Math.hypot(dx, dz) > 95) continue;
      const off = Math.abs(Math.atan2(dx * m.vz - dz * m.vx, dx * m.vx + dz * m.vz));
      if (off < bestScore) {
        bestScore = off;
        best = { x: u.x, y: u.y + u.spec.hitHeight, z: u.z, vx: u.vx, vz: u.vz };
      }
    }
    for (const e of this.enemies) {
      if (!e.alive) continue;
      pts.length = 0;
      if (e instanceof Boss) e.aimPoints(pts);
      else {
        const t: Target[] = [];
        e.targets(t);
        for (const x of t) pts.push(x);
      }
      for (const pt of pts) {
        const dx = pt.x - m.x,
          dz = pt.z - m.z;
        if (Math.hypot(dx, dz) > 95) continue;
        const off = Math.abs(Math.atan2(dx * m.vz - dz * m.vx, dx * m.vx + dz * m.vz));
        if (off < bestScore) {
          bestScore = off;
          best = { x: pt.x, y: pt.y, z: pt.z, vx: e.vx, vz: e.vz };
        }
      }
    }
    if (!best) return;
    const t = Math.max(0.05, Math.hypot(best.x - m.x, best.z - m.z) / sp);
    const tx = best.x + best.vx * t,
      tz = best.z + best.vz * t;
    const l = Math.hypot(tx - m.x, tz - m.z) || 1;
    m.vx = ((tx - m.x) / l) * sp;
    m.vz = ((tz - m.z) / l) * sp;
    m.vy = (best.y - m.y) / t + 0.5 * g * t;
  }

  private onImpact(hit: Impact): void {
    const cfg = SHOTS[hit.kind];
    if (hit.kind === 'tomato') this.tomatoSplat(hit);
    const fromPlayer = hit.team !== 'enemy';
    const shooter = this.players.find((p) => p.id === hit.by);
    if (fromPlayer) {
      const size = hit.kind === 'shell' ? 1 : 0.5;
      if (hit.target?.owner && hit.target.team === 'enemy') {
        const e = hit.target.owner as Enemy;
        const res = this.authority ? e.damage(hit.target, cfg.damage, this.ctx) : (hit.target.armor ? 'armor' : 'hit');
        if (res === 'armor') {
          this.sparks.emit(hit.x, hit.y, hit.z, 14, 6);
          this.audio.impact(4);
        } else {
          this.explode(hit.x, hit.y, hit.z, size);
          if (res === 'killed') this.onKill(e, shooter);
          else if (res === 'part') {
            this.banner(this.boss?.shielded ? '💥 Knee down!' : '🛡️ Shield down! Hit the core!', 1800);
            if (shooter) shooter.score += 500;
          }
        }
      } else if (hit.target?.owner) {
        // PvP: a player hit another team's player (the victim's device decides)
        this.explode(hit.x, hit.y, hit.z, size * 0.8);
        this.hurtPlayer(hit.target.owner as Player, cfg.damage * 0.6, hit.x, hit.z, hit.by);
      } else this.explode(hit.x, hit.y, hit.z, size);
      // splash on other enemies (weak points / bodies, not armour)
      if (cfg.splash > 0 && this.authority) {
        for (const e of this.enemies) {
          if (!e.alive) continue;
          const tg: Target[] = [];
          e.targets(tg);
          let nearest: Target | null = null,
            nd = cfg.splash;
          for (const t of tg) {
            if (t.armor || t === hit.target || t.id === hit.target?.id) continue;
            const d = Math.hypot(t.x - hit.x, t.y - hit.y, t.z - hit.z) - t.r;
            if (d < nd) {
              nd = Math.max(0, d);
              nearest = t;
            }
          }
          if (!nearest || (hit.target?.owner === e && e.kind !== 'boss')) continue;
          const res = e.damage(nearest, cfg.damage * 0.5 * (1 - nd / cfg.splash), this.ctx);
          if (res === 'killed') this.onKill(e, shooter);
        }
      }
    } else {
      // enemy shot
      if (hit.kind === 'plasma') this.explode(hit.x, hit.y, hit.z, 0.8);
      else {
        this.sparks.emit(hit.x, hit.y, hit.z, 12, 5);
        this.puff(hit.x, hit.y, hit.z, 6, hit.kind === 'laser' ? [1, 0.4, 0.4] : [1, 0.45, 0.9], 0.9);
      }
      const direct = hit.target?.owner as Player | undefined;
      if (direct) this.hurtPlayer(direct, cfg.damage, hit.x, hit.z);
      if (cfg.splash > 0)
        for (const p of this.players) {
          if (p === direct || !p.unit.alive) continue;
          const d = Math.hypot(p.unit.x - hit.x, p.unit.z - hit.z);
          if (d < cfg.splash + p.unit.spec.radius) this.hurtPlayer(p, cfg.damage * 0.6, hit.x, hit.z);
        }
      if (!direct) this.audio.impact(3);
    }
  }

  /** damage dealt by a stomp / ram: applied here, or reported to the online host */
  private dealDamage(e: Enemy, t: Target, dmg: number, by: Player): void {
    if (this.authority) {
      if (e.damage(t, dmg, this.ctx) === 'killed') this.onKill(e, by);
    } else this.room?.send('hit', { e: e.id, t: t.id, dmg: Math.round(dmg) });
  }

  private onKill(e: Enemy, by: Player | undefined): void {
    (by ?? this.local!).score += e.score * (e.kind === 'boss' ? 1 : Math.max(1, Math.ceil(this.wave / 2)));
    const y = this.killFx(e);
    if (e.kind === 'boss') {
      for (let i = 0; i < 3; i++) this.dropCrate(e.x + (i - 1) * 4, e.y + 6, e.z, (['repair', 'shield', 'triple'] as PickupKind[])[i]);
      return;
    }
    const chance = (e.kind === 'walker' ? 0.45 : e.kind === 'alien' ? 0.2 : 0.25) * (this.players.length > 1 ? 1.3 : 1);
    if (Math.random() < chance) {
      const r = Math.random();
      this.dropCrate(e.x, y, e.z, r < 0.45 ? 'repair' : r < 0.65 ? 'shield' : r < 0.85 ? 'rapid' : 'triple');
    }
  }

  private dropCrate(x: number, y: number, z: number, k: PickupKind): void {
    const i = this.pickups.drop(x, y, z, k);
    this.room?.send('drop', { i, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, z: Math.round(z * 10) / 10, k });
  }

  /** destruction effects; returns the effect height */
  private killFx(e: Enemy): number {
    const y = e.kind === 'walker' ? e.y + 2.3 : e.kind === 'alien' ? e.y + 1 : e.y;
    if (e.kind === 'alien') {
      const c = new THREE.Color((e as Alien).color);
      this.puff(e.x, y, e.z, 22, [c.r, c.g, c.b], 1.4);
      this.sparks.emit(e.x, y, e.z, 10, 4);
      this.audio.splat(true);
    } else if (e.kind === 'boss') {
      this.banner('🏆 GIANT ROBOT DOWN!', 3000);
    } else {
      this.explode(e.x, y, e.z, e.kind === 'walker' ? 1.6 : 1.3);
      this.debris.burst(e.x, y, e.z, e.kind === 'walker' ? 10 : 7, e.kind === 'walker' ? 1.1 : 0.9);
    }
    return y;
  }

  private applyPickup(p: Player | undefined, kind: PickupKind): void {
    if (!p) return;
    if (kind === 'repair') p.unit.hp = Math.min(p.unit.spec.maxHp, p.unit.hp + 30);
    else if (kind === 'shield') p.shieldT = PICKUPS.shield.time;
    else if (kind === 'rapid') p.rapidT = PICKUPS.rapid.time;
    else p.tripleT = PICKUPS.triple.time;
    if (p.local) {
      this.audio.pickup();
      this.banner(PICKUPS[kind].label, 1200);
    }
  }

  hurtPlayer(p: Player | undefined, dmg: number, fromX: number, fromZ: number, by?: string, soft = false): void {
    if (!p || !p.unit.alive || this.state !== 'playing') return;
    if (this.room && !p.local && !p.bot) return; // every device decides for its own unit
    const u = p.unit;
    if (p.shieldT > 0) {
      this.sparks.emit(u.x, u.y + 2, u.z, 10, 4);
      if (p.local) this.audio.impact(3);
      return;
    }
    u.hp -= dmg * (1 - 0.08 * this.menu.ups.armour);
    const dx = u.x - fromX,
      dz = u.z - fromZ;
    const l = Math.hypot(dx, dz) || 1;
    const kick = Math.min(6, (dmg * 120) / u.spec.mass);
    u.vx += (dx / l) * kick;
    u.vz += (dz / l) * kick;
    if (p.local && !soft) {
      this.hud.hurt();
      this.cam.shake(0.5);
      this.audio.impact(10);
      buzz(40);
    }
    if (u.hp <= 0) {
      u.hp = 0;
      this.overT = 0;
      p.respawnT = this.mode === 'coop' ? 8 : 4;
      this.explode(u.x, u.y + 1.5, u.z, 2.2);
      this.debris.burst(u.x, u.y + 1.5, u.z, 12, 1.4);
      const killer = by ? this.players.find((q) => q.id === by && q !== p) : undefined;
      if (this.multi) {
        this.room?.send('ko', { by: killer?.id ?? '' });
        if (killer) killer.ko++;
        this.koBanner(p, killer);
      } else if (p.local) this.banner('KNOCKED OUT!', 2000);
    }
  }

  /** unit vs enemy bodies: push apart; a tank on turbo rams them */
  private contacts(dt: number): void {
    for (const p of this.players) {
      const u = p.unit;
      if (!u.alive || !p.local) continue;
      for (const e of this.enemies) {
        if (!e.alive || e.kind === 'drone') continue;
        const dx = u.x - e.x,
          dz = u.z - e.z;
        const min = u.spec.radius + e.r;
        const d2 = dx * dx + dz * dz;
        if (d2 >= min * min || d2 < 1e-6) continue;
        if (u.airborne && u.y > e.y + (e.kind === 'boss' ? 12 : 3)) continue;
        const d = Math.sqrt(d2);
        const nx = dx / d,
          nz = dz / d;
        const pen = min - d;
        const unitShare = e.kind === 'boss' ? 1 : u.spec.push;
        u.x += nx * pen * unitShare;
        u.z += nz * pen * unitShare;
        e.x -= nx * pen * (1 - unitShare);
        e.z -= nz * pen * (1 - unitShare);
        const vn = u.vx * nx + u.vz * nz;
        if (vn < 0 && e.kind === 'boss') {
          u.vx -= vn * nx * 1.3;
          u.vz -= vn * nz * 1.3;
        }
        // turbo ram
        const cd = (this.ramCd.get(e) ?? 0) - dt;
        this.ramCd.set(e, cd);
        if (u.dashing && cd <= 0 && u.speed > 10) {
          this.ramCd.set(e, 0.5);
          const tg: Target[] = [];
          e.targets(tg);
          const t = tg.find((x) => !x.armor) ?? tg[0];
          if (t) {
            this.dealDamage(e, t, e.kind === 'boss' ? 15 : 45, p);
            this.sparks.emit(e.x, u.y + 1.5, e.z, 24, 7);
            this.audio.impact(12);
            if (p.local) this.cam.shake(0.6);
            e.vx -= nx * 14;
            e.vz -= nz * 14;
          }
        }
      }
    }
  }

  /** shallow water (Nile, Dubai beach): slows you down and splashes */
  private wade(u: Unit, dt: number): void {
    const w = this.world.waterLevel;
    if (!Number.isFinite(w) || u.airborne || u.y > w - 0.25) return;
    const drag = Math.exp(-1.6 * dt);
    u.vx *= drag;
    u.vz *= drag;
    if (u.speed > 2 && this.steps % 2 === 0) {
      const a = Math.random() * Math.PI * 2;
      this.particles.emit(u.x + Math.cos(a) * 2, w + 0.2, u.z + Math.sin(a) * 2, Math.cos(a) * 2, 2 + Math.random() * 3, Math.sin(a) * 2, [0.75, 0.88, 0.95], 1 + Math.random(), 0.6, 0.8);
    }
  }


  /* ------------------------------------------------------------------ */
  /* special weapons                                                      */
  /* ------------------------------------------------------------------ */

  /** cooldown, the press, rocket salvos */
  private specialStep(p: Player, ui: UnitInput, dt: number): void {
    const u = p.unit;
    p.specialCd = Math.max(0, p.specialCd - dt);
    const pressed = !!ui.special && !p.specialPrev;
    p.specialPrev = !!ui.special;
    if (pressed && p.specialCd <= 0 && u.alive && this.state === 'playing') this.useSpecial(p);
    if (p.rocketsLeft > 0 && u.alive) {
      p.rocketT -= dt;
      if (p.rocketT <= 0) {
        p.rocketT = 0.09;
        p.rocketsLeft--;
        u.muzzle(this.muzzle, (Math.random() - 0.5) * 0.9);
        const m = this.muzzle;
        const hs = Math.hypot(m.vx, m.vz) || 1;
        m.vx = (m.vx / hs) * 32;
        m.vz = (m.vz / hs) * 32;
        m.vy = 5 + Math.random() * 3;
        this.shots.fire(p.team, 'rocket', m.x, m.y + 0.4, m.z, m.vx, m.vy, m.vz, p.id);
        this.room?.send('shot', encodeShot('rocket', { ...m, y: m.y + 0.4 }));
        this.puff(m.x, m.y, m.z, 2, [0.9, 0.85, 0.8], 0.9);
        if (p.local) this.audio.whoosh();
      }
    }
  }

  private useSpecial(p: Player): void {
    const u = p.unit;
    p.specialCd = SPECIALS[p.special].cooldown;
    if (p.special === 'rockets') {
      p.rocketsLeft = 6;
      p.rocketT = 0;
    } else if (p.special === 'laser') {
      p.beamT = BEAM.time;
      this.room?.send('beam', BEAM.time);
      if (p.local) this.audio.whoosh();
    } else if (p.special === 'emp') {
      this.empAt(p, u.x, u.z);
      this.room?.send('emp', { x: Math.round(u.x * 10) / 10, z: Math.round(u.z * 10) / 10 });
    } else if (p.special === 'shield') {
      p.shieldT = Math.max(p.shieldT, SHIELD_TIME);
      if (p.local) this.audio.pickup();
    } else if (p.special === 'tomato') {
      u.muzzle(this.muzzle);
      const m = this.muzzle;
      const hs = Math.hypot(m.vx - u.vx, m.vz - u.vz) || 1;
      m.vx = ((m.vx - u.vx) / hs) * 34 + u.vx;
      m.vz = ((m.vz - u.vz) / hs) * 34 + u.vz;
      m.vy = 9;
      this.aimAssist(m, 'tomato', p);
      this.shots.fire(p.team, 'tomato', m.x, m.y + 0.5, m.z, m.vx, m.vy, m.vz, p.id);
      this.room?.send('shot', encodeShot('tomato', { ...m, y: m.y + 0.5 }));
      if (p.local) this.audio.whoosh();
    }
  }

  /** the laser: first thing in front of the beam gets burned (60 Hz) */
  private beamStep(p: Player, dt: number): void {
    const u = p.unit;
    p.beamT -= dt;
    if (!u.alive) p.beamT = 0;
    if (!p.beam) {
      p.beam = new THREE.Mesh(new THREE.CylinderGeometry(BEAM.width, BEAM.width, 1, 8, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.5), new THREE.MeshBasicMaterial({ color: 0xff5ff0, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
      p.beam.renderOrder = 6;
      this.r3.scene.add(p.beam);
    }
    p.beam.visible = p.beamT > 0;
    if (p.beamT <= 0) return;
    u.muzzle(this.muzzle);
    const m = this.muzzle;
    const dx = Math.sin(u.turret),
      dz = Math.cos(u.turret);
    // flat beam; it reaches up to drones (kid-friendly), stops at the first thing it touches
    let best: Target | null = null,
      bt = BEAM.length;
    for (const t of this.targets) {
      if (!t.alive || t.team === p.team || t.owner === p) continue;
      if (t.y > m.y + 9 || t.y < m.y - 6) continue;
      const hitT = rayHit(m.x, 0, m.z, dx, 0, dz, BEAM.length, t.x, 0, t.z, t.r + 0.5);
      if (hitT >= 0 && hitT < bt) {
        bt = hitT;
        best = t;
      }
    }
    const ex = m.x + dx * bt,
      ez = m.z + dz * bt,
      ey = best ? best.y : m.y;
    const len = Math.hypot(ex - m.x, ey - m.y, ez - m.z);
    p.beam.position.set(m.x, m.y, m.z);
    p.beam.lookAt(ex, ey, ez);
    p.beam.scale.set(1 + Math.sin(this.time * 50) * 0.25, 1 + Math.sin(this.time * 50) * 0.25, len);
    if (this.steps % 3 === 0) this.sparks.emit(ex, ey, ez, 3, 3);
    if (!best) return;
    if (best.team === 'enemy' && best.owner) {
      const e = best.owner as Enemy;
      if (best.armor) return;
      if (this.authority) {
        if (e.damage(best, BEAM.dps * dt, this.ctx) === 'killed') this.onKill(e, p);
      } else if (p.local) {
        const a = p.beamAcc.get(best.id) ?? { e, t: best.id, dmg: 0 };
        a.dmg += BEAM.dps * dt;
        p.beamAcc.set(best.id, a);
        p.beamSend -= dt;
        if (p.beamSend <= 0) {
          p.beamSend = 0.25;
          for (const x of p.beamAcc.values()) this.room?.send('hit', { e: x.e.id, t: x.t, dmg: Math.round(x.dmg) });
          p.beamAcc.clear();
        }
      }
    } else if (best.owner) {
      const victim = best.owner as Player;
      if (victim.team !== p.team) this.hurtPlayer(victim, BEAM.pvpDps * dt, m.x, m.z, p.id, true);
    }
  }

  private fxRings: { x: number; y: number; z: number; r: number; max: number; speed: number; mesh: THREE.Mesh }[] = [];

  private ring(x: number, y: number, z: number, max: number, color: number, speed = 40): void {
    const mesh = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
    mesh.renderOrder = 5;
    this.r3.scene.add(mesh);
    this.fxRings.push({ x, y, z, r: 1, max, speed, mesh });
  }

  private updateRings(dt: number): void {
    for (let i = this.fxRings.length - 1; i >= 0; i--) {
      const g = this.fxRings[i];
      g.r += g.speed * dt;
      g.mesh.position.set(g.x, g.y + 0.5, g.z);
      g.mesh.scale.set(g.r, 1, g.r);
      (g.mesh.material as THREE.MeshBasicMaterial).opacity = 0.9 * Math.max(0, 1 - g.r / g.max);
      if (g.r >= g.max) {
        g.mesh.removeFromParent();
        g.mesh.geometry.dispose();
        (g.mesh.material as THREE.Material).dispose();
        this.fxRings.splice(i, 1);
      }
    }
  }

  /** EMP: freeze and zap every robot around (x, z); rivals lose their energy */
  private empAt(p: Player, x: number, z: number): void {
    const y = this.terrain.heightAt(x, z);
    this.ring(x, y, z, EMP.radius, 0x7fd8ff, 45);
    this.ring(x, y + 1.5, z, EMP.radius * 0.7, 0xffffff, 30);
    this.sparks.emit(x, y + 2, z, 30, 6);
    this.audio.impact(9);
    if (this.authority)
      for (const e of this.enemies) {
        if (!e.alive || Math.hypot(e.x - x, e.z - z) > EMP.radius) continue;
        e.stunT = EMP.stun;
        const tg: Target[] = [];
        e.targets(tg);
        const t = tg.find((q) => !q.armor);
        if (t && e.damage(t, EMP.damage, this.ctx) === 'killed') this.onKill(e, p);
      }
    for (const q of this.players) {
      if (!q.local || q === p || q.team === p.team || !q.unit.alive) continue;
      if (Math.hypot(q.unit.x - x, q.unit.z - z) > EMP.radius) continue;
      q.unit.energy = 0;
      this.hurtPlayer(q, EMP.pvpDamage, x, z, p.id);
    }
  }

  private tomatoSplat(hit: Impact): void {
    const red: RGB = [0.95, 0.2, 0.12];
    for (let i = 0; i < 24; i++) {
      const a = Math.random() * Math.PI * 2,
        v = 2 + Math.random() * 7;
      this.particles.emit(hit.x, hit.y + 0.3, hit.z, Math.cos(a) * v, 2 + Math.random() * 5, Math.sin(a) * v, i % 4 ? red : [1, 0.85, 0.4], 0.6 + Math.random() * 0.8, 0.6 + Math.random() * 0.5, 1);
    }
    this.audio.splat(true);
    if (this.authority)
      for (const e of this.enemies) if (e.alive && Math.hypot(e.x - hit.x, e.z - hit.z) < SHOTS.tomato.splash + e.r) e.stunT = Math.max(e.stunT ?? 0, TOMATO_STUN);
    const me = this.local;
    if (me && me.unit.alive && hit.team !== me.team && Math.hypot(me.unit.x - hit.x, me.unit.z - hit.z) < SHOTS.tomato.splash + 1) this.hud.splat();
  }

  /** a mech landing hard stomps the ground: damages nearby enemies */
  private playerStomp(p: Player): void {
    const u = p.unit;
    const power = clamp(u.landed / MECH.stompSpeed, 1, 1.7);
    this.stompFx(u.x, u.y, u.z, power * 0.7);
    for (const e of this.enemies) {
      if (!e.alive || e.kind === 'drone') continue;
      const tg: Target[] = [];
      e.targets(tg);
      const t = tg.find((x) => !x.armor && Math.hypot(x.x - u.x, x.z - u.z) < 6 + x.r);
      if (!t) continue;
      this.dealDamage(e, t, 22 * power, p);
      const d = Math.hypot(e.x - u.x, e.z - u.z) || 1;
      if (e.kind !== 'boss') {
        e.vx += ((e.x - u.x) / d) * 12;
        e.vz += ((e.z - u.z) / d) * 12;
      }
    }
  }

  private stompFx(x: number, y: number, z: number, size: number): void {
    const m = this.world.biomeAt(x, z, this.mix);
    const c = m.a.pal.surfaces[m.a.offroad];
    for (let i = 0; i < 26 * size; i++) {
      const a = (i / (26 * size)) * Math.PI * 2;
      const v = 6 + Math.random() * 4;
      this.particles.emit(x, y + 0.4, z, Math.cos(a) * v * size, 0.6 + Math.random(), Math.sin(a) * v * size, [c[0] * 1.1, c[1] * 1.1, c[2] * 1.1], 2 * size, 0.9, 0.8);
    }
    this.audio.landing(10 * size);
    this.audio.impact(8 * size);
    const me = this.local?.unit;
    const d = me ? Math.hypot(x - me.x, z - me.z) : 0;
    this.cam.shake(clamp((1.1 * size) / Math.max(1, d / 12), 0, 1.2));
  }

  private mechFx(p: Player, u: Mech): void {
    if (u.jets && this.steps % 2 === 0) {
      const s = Math.sin(u.turret),
        c = Math.cos(u.turret);
      for (const side of [-0.5, 0.5]) {
        const bx = u.x - s * 1.6 - c * side,
          bz = u.z - c * 1.6 + s * side;
        this.particles.emit(bx, u.y + 3, bz, 0, -6, 0, [1, 0.7, 0.3], 1.1, 0.25, 1);
      }
    }
    if (u.dashing && this.steps % 2 === 0) this.puff(u.x, u.y + 0.5, u.z, 2, [0.9, 0.85, 0.75], 1.4);
    if (u.landed > 2) this.puff(u.x, u.y + 0.3, u.z, 8, [0.85, 0.78, 0.65], 1.6);
    // footsteps
    const step = Math.floor(u.stride / 1.6);
    if (p.local && !u.airborne && step !== (u as unknown as { _st?: number })._st) {
      (u as unknown as { _st?: number })._st = step;
      this.audio.landing(1.2);
    }
  }

  /** fireball + smoke + sparks + light + sound */
  private explode(x: number, y: number, z: number, size: number): void {
    const fire: RGB = [1, 0.62, 0.22],
      hot: RGB = [1, 0.9, 0.55],
      smoke: RGB = [0.32, 0.3, 0.28];
    for (let i = 0; i < 14 * size; i++) {
      const a = Math.random() * Math.PI * 2,
        v = (2 + Math.random() * 6) * size;
      this.particles.emit(x, y, z, Math.cos(a) * v, 1 + Math.random() * 5 * size, Math.sin(a) * v, i % 3 ? fire : hot, (1.4 + Math.random()) * size, 0.45 + Math.random() * 0.3, 1);
    }
    this.puff(x, y, z, 10 * size, smoke, 2.2 * size);
    this.sparks.emit(x, y, z, Math.round(24 * size), 7 * size);
    this.flash.position.set(x, y + 2, z);
    this.flash.intensity = Math.max(this.flash.intensity, 60 * size);
    this.audio.impact(14 * size);
    this.audio.landing(8 * size);
    const me = this.local?.unit;
    const d = me ? Math.hypot(x - me.x, z - me.z) : 0;
    this.cam.shake(clamp((1.2 * size) / Math.max(1, d / 10), 0, 1.2));
  }

  private puff(x: number, y: number, z: number, n: number, c: RGB, size: number): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2,
        v = 0.5 + Math.random() * 2;
      this.particles.emit(x, y, z, Math.cos(a) * v, 0.8 + Math.random() * 1.6, Math.sin(a) * v, c, size * (0.8 + Math.random() * 0.8), 0.9 + Math.random() * 0.8, 0.7);
    }
  }

  private trackMarks(t: Unit): void {
    const s = Math.sin(t.heading),
      c = Math.cos(t.heading);
    const moving = t.speed > 1 || Math.abs(t.yawRate) > 0.3;
    const m = this.world.biomeAt(t.x, t.z, this.mix);
    const col = mixRGB(m.a.pal.surfaces[m.a.offroad], m.a.pal.surfaces[m.a.offroad], 0, this.tmpRGB);
    const dark: RGB = [col[0] * 0.65, col[1] * 0.65, col[2] * 0.65];
    for (let w = 0; w < 2; w++) {
      const lx = w === 0 ? 1.7 : -1.7;
      this.marks.add(w, t.x + lx * c, t.z - lx * s, s, c, moving ? 0.5 : 0, dark, this.terrain);
    }
    if (t.speed > 6 && Math.random() < (t.dashing ? 1 : 0.5)) this.puff(t.x - s * 3, t.y + 0.3, t.z - c * 3, 1, [col[0] * 1.1, col[1] * 1.1, col[2] * 1.1], 1.4);
  }

  private colorOf(p: Player): string {
    if (this.mode === 'alliance') return SIDE_COLORS[p.side];
    return '#' + p.livery.body.toString(16).padStart(6, '0');
  }

  private updateTags(dt: number): void {
    this.tags.update(
      this.cam.camera,
      dt,
      this.players.map((p) => ({
        id: p.id,
        name: p.name,
        color: this.colorOf(p),
        x: p.view.root.position.x,
        y: p.view.root.position.y + p.unit.spec.tagHeight,
        z: p.view.root.position.z,
        visible: p.unit.alive,
        showName: !p.local,
      })),
    );
  }

  private updateBoard(): void {
    const ps = [...this.players].sort((a, b) => (this.mode === 'coop' ? b.score - a.score : b.ko - a.ko || b.score - a.score));
    const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    let html = '';
    if (this.mode === 'alliance') html += `<div><span style="color:${SIDE_COLORS.blue}">Blue ${this.teamPoints('blue')}</span><span style="color:${SIDE_COLORS.red}">Red ${this.teamPoints('red')}</span></div>`;
    for (const p of ps) {
      const val = this.mode === 'coop' ? `${p.score}` : `💥 ${p.ko}`;
      html += `<div class="${p.local ? 'me' : ''} ${p.unit.alive ? '' : 'dead'}"><span style="color:${this.colorOf(p)}">●</span><span>${esc(p.name)}</span><span>${val}</span></div>`;
    }
    this.hud.board(html);
  }

  /* ------------------------------------------------------------------ */
  /* render                                                               */
  /* ------------------------------------------------------------------ */

  private render(alpha: number, frameDt: number): void {
    const dt = this.state === 'paused' ? 0 : frameDt;
    const me = this.local!;
    // knocked out online: watch a teammate (or anyone) until you're back
    const watch = this.multi && !me.unit.alive ? this.players.find((p) => !p.local && p.unit.alive && (this.mode === 'arena' || p.team === me.team)) : undefined;
    const t = (watch ?? me).unit;
    const x = lerp(t.px, t.x, alpha),
      y = lerp(t.py, t.y, alpha),
      z = lerp(t.pz, t.z, alpha);
    const h = lerpAngle(t.pHeading, t.heading, alpha);
    for (const p of this.players) {
      const u = p.unit;
      p.view.root.visible = u.alive;
      p.view.update(u, alpha, dt);
      p.bubble.visible = u.alive && p.shieldT > 0 && (p.shieldT > 2 || Math.sin(this.time * 20) > 0);
      if (p.bubble.visible) {
        const [r, by] = u.spec.bubble;
        p.bubble.position.set(lerp(u.px, u.x, alpha), lerp(u.py, u.y, alpha) + by, lerp(u.pz, u.z, alpha));
        p.bubble.scale.setScalar(r * (1 + 0.03 * Math.sin(this.time * 8)));
      }
    }

    // camera, terrain, props
    const chase = settings.cameraView === 'chase' && this.state !== 'menu';
    this.cam.mode = chase ? 'chase' : 'top';
    this.cam.ground = (px, pz) => this.terrain.heightAt(px, pz);
    const bossNear = this.boss && Math.hypot(this.boss.x - x, this.boss.z - z) < 60 ? 0.25 : 0;
    this.cam.zoomTarget = this.state === 'menu' ? 0.9 : (isTouchDevice() ? 1.0 : 1.3) + bossNear;
    this.cam.chaseScale = t.spec.chase;
    const ch = t.kind === 'mech' ? (chase ? lerpAngle(t.pTurret, t.turret, alpha) : h) : h;
    this.cam.update(Math.min(dt, 0.05), x, y, z, t.vx, t.vz, ch, false);
    this.terrain.update(x + t.vx, z + t.vz, this.r3.quality.genBudgetMs);
    this.props.update(this.terrain, this.cam.camera);

    // lighting
    const mix = this.world.biomeAt(x, z, this.mix);
    mixRGB(mix.a.pal.fog, mix.b.pal.fog, mix.t, this.fog);
    const tod = this.world.def.timeOfDay;
    this.r3.applyLighting(tod, tod, 0, this.fog, this.cam.dist, chase ? this.r3.quality.viewRadius * 1.2 : Infinity);
    this.flash.intensity *= Math.exp(-dt * 9);
    const night = tod === 'night';
    this.nightFill.intensity = night ? 1.6 : 0;
    this.lamp.intensity = night ? 60 : 0;
    this.lamp.position.set(x, y + 9, z);

    // effects
    this.shadow.update(x, z, h, 0, this.terrain, this.r3.light.level);
    this.shadow.mesh.visible = t.alive;
    if (this.multi) this.updateTags(dt);
    this.particles.update(dt);
    this.r3.renderer.getDrawingBufferSize(this.bufSize);
    this.particles.mat.uniforms.uScale.value = this.bufSize.y / (2 * Math.tan((this.cam.camera.fov * Math.PI) / 360));
    this.particles.mat.uniforms.uLight.value = clamp(this.r3.light.level + 0.3, 0.3, 1);
    this.sparks.ptMat.uniforms.uScale.value = this.particles.mat.uniforms.uScale.value;
    this.sparks.update(dt, (px, pz) => this.terrain.heightAt(px, pz));
    this.marks.flush();
    this.rocks.sync(
      this.players.map((p) => p.unit),
      this.r3.quality.viewRadius * 1.3,
    );
    this.shots.sync(this.time);
    for (const e of this.enemies) e.sync(dt, this.time, this.ctx);
    this.aimMarker.visible = this.state === 'playing' && t.alive && this.input.aimVisible;
    if (this.aimMarker.visible) {
      const a = this.input.aimPoint;
      this.aimMarker.position.set(a.x, this.terrain.heightAt(a.x, a.z) + 0.15, a.z);
    }

    // hud
    if (this.state === 'playing') {
      const mu = me.unit;
      this.hud.bar('hp', mu.hp / mu.spec.maxHp);
      this.hud.bar('reload', 1 - mu.reload / (mu.spec.reload * mu.reloadScale));
      this.hud.bar('energy', mu.energy);
      const sp = SPECIALS[me.special];
      const charge = 1 - me.specialCd / sp.cooldown;
      this.hud.special(sp.icon, charge);
      this.sticks.setSpecial(sp.icon, charge);
      const mt = Math.max(0, Math.ceil(this.matchT));
      this.hud.set('wave', this.multi && this.mode !== 'coop' ? `⏱ ${Math.floor(mt / 60)}:${String(mt % 60).padStart(2, '0')}` : this.wave ? `WAVE ${this.wave}` : 'GET READY');
      if (this.multi) this.updateBoard();
      this.hud.set('score', `${this.score}`);
      const pw: string[] = [];
      if (me.shieldT > 0) pw.push(`🛡️ ${Math.ceil(me.shieldT)}`);
      if (me.rapidT > 0) pw.push(`⚡ ${Math.ceil(me.rapidT)}`);
      if (me.tripleT > 0) pw.push(`🔱 ${Math.ceil(me.tripleT)}`);
      this.hud.set('powers', pw.join('  '));
      const b = this.boss;
      if (b) this.hud.bar('bossHp', b.hpFrac);
      const rpm = t.kind === 'mech' ? 700 + t.drive * 1300 + (t.dashing ? 1500 : 0) : t.kind === 'scout' ? 1400 + Math.abs(t.drive) * 5200 + (t.dashing ? 1500 : 0) : 900 + Math.abs(t.drive) * 3200 + (this.input.unit.move > 0.1 ? 600 : 0) + (t.dashing ? 1200 : 0);
      this.audio.update(me.unit.alive ? rpm : 0, me.unit.speed, this.input.unit.move, 0, me.unit.airborne, 0, t.kind === 'tank' ? 0.3 : 0.1);
    }

    this.r3.monitor(frameDt);
    this.r3.render(this.cam.camera);
  }
}
