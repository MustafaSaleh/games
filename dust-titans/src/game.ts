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
import { Terrain } from '@engine/world/terrain';
import { mixRGB, type BiomeMix, type RGB } from '@engine/world/world';
import { ARENAS, ArenaWorld } from './arena';
import { Debris, PICKUPS, Pickups, Projectiles, SHOTS, type Impact, type PickupKind, type ShotKind, type Target, type Team } from './combat';
import { Alien } from './enemies/alien';
import { Boss } from './enemies/boss';
import { Drone, makeDroneParts, type DroneParts } from './enemies/drones';
import type { Enemy, EnemyCtx, EnemyFx, EnemyKind, PlayerRef } from './enemies/enemy';
import { Walker } from './enemies/walker';
import { TitansInput, TouchSticks } from './input';
import { BattleHud, TitansMenu, loadLoadout, type Loadout } from './ui';
import { MECH, Mech } from './units/mech';
import { TANK, Tank } from './units/tank';
import { NO_UNIT_INPUT, liveryById, type Livery, type Muzzle, type Unit, type UnitInput } from './units/unit';
import { makeUnitView, type UnitView } from './units/views';
import { bossLevel, waveSpawns } from './waves';

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
  /** player-facing data the enemies see */
  ref: PlayerRef;
}

const RELOAD = { tank: TANK.reload, mech: MECH.reload };

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
    this.r3.scene.add(this.props.group, this.shadow.mesh, this.marks.mesh, this.particles.points, this.sparks.group, this.rocks.mesh, this.shots.group, this.debris.mesh, this.pickups.group, this.aimMarker, this.flash);

    this.input = new TitansInput(canvas);
    this.hud = new BattleHud(ui);
    this.sticks = new TouchSticks(ui, this.input);
    this.menu = new TitansMenu(ui, {
      play: () => this.startBattle(),
      loadoutChanged: (l) => {
        this.loadout = { ...l };
        this.setLocalPlayer();
      },
      resume: () => this.resume(),
      quit: () => this.quit(),
      unlock: () => this.unlockAudio(),
      settingsChanged: () => this.applySettings(),
    });
    this.hud.onPause = () => this.pause();
    this.hud.onCamera = () => updateSettings({ cameraView: settings.cameraView === 'chase' ? 'top' : 'chase' });
    this.hud.onMusic = () => updateSettings({ music: !settings.music });
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
      fire: (kind, x, y, z, vx, vy, vz) => this.shots.fire('enemy', kind, x, y, z, vx, vy, vz),
      hurt: (i, dmg, fx, fz) => this.hurtPlayer(this.players[i], dmg, fx, fz),
      fx: (kind, x, y, z, size) => this.enemyFx(kind, x, y, z, size ?? 1),
    };
    this.loop = new Loop(
      (dt) => this.step(dt),
      (a, dt) => this.render(a, dt),
      () => {
        const u = this.local?.unit;
        this.input.update(this.cam.camera, this.cam.mode === 'chase' ? this.cam.yaw : 0, u ? { x: u.x, y: u.y + (u.kind === 'mech' ? 2.6 : 0), z: u.z } : { x: 0, y: 0, z: 0 });
      },
    );
    this.loadArena();
    this.setLocalPlayer();
    this.toMenu();
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

  private makePlayer(id: string, name: string, l: Loadout, local: boolean, team: Team = 'player'): Player {
    const livery = liveryById(l.livery);
    const unit: Unit = l.unit === 'mech' ? new Mech() : new Tank();
    const view = makeUnitView(l.unit, livery);
    const bubble = new THREE.Mesh(this.bubbleGeo, this.bubbleMat);
    bubble.visible = false;
    this.r3.scene.add(view.root, bubble);
    const p: Player = { id, name, team, local, unit, view, livery, bubble, shieldT: 0, rapidT: 0, tripleT: 0, score: 0, ref: { x: 0, y: 0, z: 0, vx: 0, vz: 0, r: unit.spec.radius, alive: false, airborne: false } };
    unit.reset(0, -20, 0, this.terrain);
    return p;
  }

  private removePlayer(p: Player): void {
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

  private loadArena(): void {
    this.terrain?.dispose();
    this.world = new ArenaWorld(ARENAS[0]);
    this.terrain = new Terrain(this.world, this.r3.quality.viewRadius);
    this.terrain.setPropDensity(this.r3.quality.propDensity);
    this.r3.scene.add(this.terrain.group);
    this.terrain.ensureAround(0, 0, 140);
    this.ctx.ground = this.terrain;
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
    this.players.forEach((p, i) => {
      p.unit.reset((i - (this.players.length - 1) / 2) * 8, -20, 0, this.terrain);
      p.shieldT = p.rapidT = p.tripleT = 0;
      p.score = 0;
    });
    const u = this.local!.unit;
    this.cam.snap(u.x, u.y, u.z, 0);
    this.wave = 0;
    this.queue = [];
    this.waveT = 1.5;
    this.overT = 0;
    this.hud.boss(false);
  }

  private toMenu(): void {
    this.state = 'menu';
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
    this.state = 'paused';
    this.audio.setActive(false);
    this.sticks.show(false);
    this.menu.show('pause');
  }

  private resume(): void {
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
    this.menu.result = { wave: this.wave, score: this.score, best, record: this.score > best };
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
    this.music.play(this.state === 'playing' ? (this.boss ? 'turbo' : 'dust') : 'sunny');
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
  /* enemies                                                              */
  /* ------------------------------------------------------------------ */

  spawn(kind: EnemyKind, angle?: number): Enemy {
    const id = kind + this.nextId++;
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
    const playing = this.state === 'playing';

    // ---- players ----
    for (const p of this.players) {
      const u = p.unit;
      const ui: UnitInput = p.local && playing && u.alive ? inp.unit : NO_UNIT_INPUT;
      u.reloadScale = p.rapidT > 0 ? 0.45 : 1;
      u.step(dt, ui, terrain);
      this.world.clamp(u);
      p.shieldT = Math.max(0, p.shieldT - dt);
      p.rapidT = Math.max(0, p.rapidT - dt);
      p.tripleT = Math.max(0, p.tripleT - dt);
      if (u.impact > 3 && p.local) {
        this.audio.impact(u.impact * 1.5);
        this.cam.shake(u.impact * 0.05);
      }
      if (u.fired) this.fireWeapon(p);
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
      tg.push({ id: p.id, team: p.team, x: u.x, y: u.y + u.spec.hitHeight, z: u.z, r: u.kind === 'mech' ? 1.7 : TANK.radius * 0.9, alive: u.alive && playing, owner: p });
    }
    for (const e of this.enemies) e.targets(tg);
    this.shots.step(dt, terrain, tg, this.impacts);
    for (const hit of this.impacts) this.onImpact(hit);
    this.debris.step(dt, terrain);
    const got = this.pickups.step(dt, this.time, terrain, this.players.map((p) => ({ x: p.unit.x, z: p.unit.z, alive: p.unit.alive })), 3.2);
    for (const g of got) this.applyPickup(this.players[g.by], g.kind);

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

    if (playing) this.waves(dt);
    if (playing && this.players.every((p) => !p.unit.alive)) {
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
    let vy = 0;
    for (let i = 0; i < spreads.length; i++) {
      u.muzzle(this.muzzle, spreads[i]);
      const m = this.muzzle;
      if (i === 0) {
        this.aimAssist(m, kind);
        vy = m.vy;
      } else m.vy = vy;
      this.shots.fire(p.team, kind, m.x, m.y, m.z, m.vx, m.vy, m.vz, p.id);
    }
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
  private aimAssist(m: Muzzle, kind: ShotKind): void {
    const sp = Math.hypot(m.vx, m.vz);
    const g = SHOTS[kind].gravity;
    let best: { x: number; y: number; z: number; vx: number; vz: number } | null = null,
      bestScore = 0.3; // ~17° off the barrel
    const pts: { x: number; y: number; z: number }[] = [];
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
    const fromPlayer = hit.team !== 'enemy';
    const shooter = this.players.find((p) => p.id === hit.by);
    if (fromPlayer) {
      const size = hit.kind === 'shell' ? 1 : 0.5;
      if (hit.target?.owner && hit.target.team === 'enemy') {
        const e = hit.target.owner as Enemy;
        const res = e.damage(hit.target, cfg.damage, this.ctx);
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
        // PvP: a player hit another team's player
        this.explode(hit.x, hit.y, hit.z, size * 0.8);
        this.hurtPlayer(hit.target.owner as Player, cfg.damage * 0.6, hit.x, hit.z);
      } else this.explode(hit.x, hit.y, hit.z, size);
      // splash on other enemies (weak points / bodies, not armour)
      if (cfg.splash > 0) {
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

  private onKill(e: Enemy, by: Player | undefined): void {
    (by ?? this.local!).score += e.score * (e.kind === 'boss' ? 1 : Math.max(1, Math.ceil(this.wave / 2)));
    const y = e.kind === 'walker' ? e.y + 2.3 : e.kind === 'alien' ? e.y + 1 : e.y;
    if (e.kind === 'alien') {
      const c = new THREE.Color((e as Alien).color);
      this.puff(e.x, y, e.z, 22, [c.r, c.g, c.b], 1.4);
      this.sparks.emit(e.x, y, e.z, 10, 4);
      this.audio.splat(true);
    } else if (e.kind === 'boss') {
      this.banner('🏆 GIANT ROBOT DOWN!', 3000);
      for (let i = 0; i < 3; i++) this.pickups.drop(e.x + (i - 1) * 4, e.y + 6, e.z, (['repair', 'shield', 'triple'] as PickupKind[])[i]);
      return;
    } else {
      this.explode(e.x, y, e.z, e.kind === 'walker' ? 1.6 : 1.3);
      this.debris.burst(e.x, y, e.z, e.kind === 'walker' ? 10 : 7, e.kind === 'walker' ? 1.1 : 0.9);
    }
    const chance = e.kind === 'walker' ? 0.45 : e.kind === 'alien' ? 0.2 : 0.25;
    if (Math.random() < chance) {
      const r = Math.random();
      this.pickups.drop(e.x, y, e.z, r < 0.45 ? 'repair' : r < 0.65 ? 'shield' : r < 0.85 ? 'rapid' : 'triple');
    }
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

  hurtPlayer(p: Player | undefined, dmg: number, fromX: number, fromZ: number): void {
    if (!p || !p.unit.alive || this.state !== 'playing') return;
    const u = p.unit;
    if (p.shieldT > 0) {
      this.sparks.emit(u.x, u.y + 2, u.z, 10, 4);
      if (p.local) this.audio.impact(3);
      return;
    }
    u.hp -= dmg;
    const dx = u.x - fromX,
      dz = u.z - fromZ;
    const l = Math.hypot(dx, dz) || 1;
    const kick = (dmg * 120) / u.spec.mass;
    u.vx += (dx / l) * kick;
    u.vz += (dz / l) * kick;
    if (p.local) {
      this.hud.hurt();
      this.cam.shake(0.5);
      this.audio.impact(10);
      buzz(40);
    }
    if (u.hp <= 0) {
      u.hp = 0;
      this.overT = 0;
      this.explode(u.x, u.y + 1.5, u.z, 2.2);
      this.debris.burst(u.x, u.y + 1.5, u.z, 12, 1.4);
      if (p.local) this.banner('KNOCKED OUT!', 2000);
    }
  }

  /** unit vs enemy bodies: push apart; a tank on turbo rams them */
  private contacts(dt: number): void {
    for (const p of this.players) {
      const u = p.unit;
      if (!u.alive) continue;
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
        const unitShare = e.kind === 'boss' ? 1 : u.kind === 'tank' ? 0.15 : 0.5;
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
            const res = e.damage(t, e.kind === 'boss' ? 15 : 45, this.ctx);
            this.sparks.emit(e.x, u.y + 1.5, e.z, 24, 7);
            this.audio.impact(12);
            if (p.local) this.cam.shake(0.6);
            e.vx -= nx * 14;
            e.vz -= nz * 14;
            if (res === 'killed') this.onKill(e, p);
          }
        }
      }
    }
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
      const res = e.damage(t, 22 * power, this.ctx);
      const d = Math.hypot(e.x - u.x, e.z - u.z) || 1;
      if (e.kind !== 'boss') {
        e.vx += ((e.x - u.x) / d) * 12;
        e.vz += ((e.z - u.z) / d) * 12;
      }
      if (res === 'killed') this.onKill(e, p);
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

  /* ------------------------------------------------------------------ */
  /* render                                                               */
  /* ------------------------------------------------------------------ */

  private render(alpha: number, frameDt: number): void {
    const dt = this.state === 'paused' ? 0 : frameDt;
    const me = this.local!;
    const t = me.unit;
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
        const r = u.kind === 'mech' ? 3.6 : 3.4;
        p.bubble.position.set(lerp(u.px, u.x, alpha), lerp(u.py, u.y, alpha) + (u.kind === 'mech' ? 2.8 : 1.4), lerp(u.pz, u.z, alpha));
        p.bubble.scale.setScalar(r * (1 + 0.03 * Math.sin(this.time * 8)));
      }
    }

    // camera, terrain, props
    const chase = settings.cameraView === 'chase' && this.state !== 'menu';
    this.cam.mode = chase ? 'chase' : 'top';
    this.cam.ground = (px, pz) => this.terrain.heightAt(px, pz);
    const bossNear = this.boss && Math.hypot(this.boss.x - x, this.boss.z - z) < 60 ? 0.25 : 0;
    this.cam.zoomTarget = this.state === 'menu' ? 0.9 : (isTouchDevice() ? 1.0 : 1.3) + bossNear;
    this.cam.chaseScale = t.kind === 'mech' ? 1.9 : 1.35;
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

    // effects
    this.shadow.update(x, z, h, 0, this.terrain, this.r3.light.level);
    this.shadow.mesh.visible = t.alive;
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
      this.hud.bar('hp', t.hp / t.spec.maxHp);
      this.hud.bar('reload', 1 - t.reload / (RELOAD[t.kind] * t.reloadScale));
      this.hud.bar('energy', t.energy);
      this.hud.set('wave', this.wave ? `WAVE ${this.wave}` : 'GET READY');
      this.hud.set('score', `${this.score}`);
      const pw: string[] = [];
      if (me.shieldT > 0) pw.push(`🛡️ ${Math.ceil(me.shieldT)}`);
      if (me.rapidT > 0) pw.push(`⚡ ${Math.ceil(me.rapidT)}`);
      if (me.tripleT > 0) pw.push(`🔱 ${Math.ceil(me.tripleT)}`);
      this.hud.set('powers', pw.join('  '));
      const b = this.boss;
      if (b) this.hud.bar('bossHp', b.hpFrac);
      const rpm = t.kind === 'mech' ? 700 + t.drive * 1300 + (t.dashing ? 1500 : 0) : 900 + Math.abs(t.drive) * 3200 + (this.input.unit.move > 0.1 ? 600 : 0) + (t.dashing ? 1200 : 0);
      this.audio.update(rpm, t.speed, this.input.unit.move, 0, t.airborne, 0, t.kind === 'tank' ? 0.3 : 0.1);
    }

    this.r3.monitor(frameDt);
    this.r3.render(this.cam.camera);
  }
}
