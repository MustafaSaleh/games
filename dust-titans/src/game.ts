import * as THREE from 'three';
import { QUALITY } from '@engine/config/quality';
import { LIGHTING } from '@engine/config/lighting';
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
import { COMBAT, Debris, Pickups, Projectiles, type Impact, type Target } from './combat';
import { DRONE, Drone, makeDroneParts, type DroneParts } from './enemies/drones';
import { TitansInput, TouchSticks } from './input';
import { BattleHud, TitansMenu } from './ui';
import { NO_UNIT_INPUT, TANK, Tank } from './units/tank';
import { buildTank, type TankModel } from './units/tankModel';

type State = 'menu' | 'playing' | 'paused' | 'over';

/** Phase 1: one tank, the desert arena, waves of drones. */
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
  readonly tank = new Tank();
  private model: TankModel;
  private world!: ArenaWorld;
  terrain!: Terrain;
  private props = new PropRenderer();
  private particles: Particles;
  private sparks = new Sparks(260);
  private marks: TireMarks;
  private shadow = new BlobShadow();
  private rocks: LooseRocks;
  private shots = new Projectiles();
  private debris = new Debris();
  private pickups = new Pickups();
  private droneParts: DroneParts = makeDroneParts();
  drones: Drone[] = [];
  private impacts: Impact[] = [];
  private targets: Target[] = [];
  private aimMarker: THREE.Mesh;
  private flash = new THREE.PointLight(0xffb060, 0, 30, 2);
  state: State = 'menu';
  wave = 0;
  score = 0;
  private toSpawn = 0;
  private spawnT = 0;
  private waveT = 0;
  private overT = 0;
  private time = 0;
  private mix: BiomeMix = { a: null!, b: null!, t: 0 };
  private fog: RGB = [0.5, 0.5, 0.5];
  private tmpRGB: RGB = [0, 0, 0];
  private muzzle = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
  private nextId = 0;
  private bufSize = new THREE.Vector2();

  constructor(canvas: HTMLCanvasElement, ui: HTMLElement) {
    const q = QUALITY[settings.quality === 'auto' ? autoQuality() : settings.quality];
    this.r3 = new Renderer3D(canvas, q);
    this.particles = new Particles(q.particles + 200);
    this.marks = new TireMarks(q.tireMarks);
    this.rocks = new LooseRocks(this.props.material);
    this.model = buildTank();
    this.aimMarker = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1.25, 24).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffb52e, transparent: true, opacity: 0.85, depthWrite: false }),
    );
    this.aimMarker.renderOrder = 7;
    this.r3.scene.add(this.props.group, this.model.root, this.shadow.mesh, this.marks.mesh, this.particles.points, this.sparks.group, this.rocks.mesh, this.shots.group, this.debris.mesh, this.pickups.group, this.aimMarker, this.flash);

    this.input = new TitansInput(canvas);
    this.hud = new BattleHud(ui);
    this.sticks = new TouchSticks(ui, this.input);
    this.menu = new TitansMenu(ui, {
      play: () => this.startBattle(),
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

    this.loop = new Loop(
      (dt) => this.step(dt),
      (a, dt) => this.render(a, dt),
      () => this.input.update(this.cam.camera, this.cam.mode === 'chase' ? this.cam.yaw : 0, this.tank),
    );
    this.loadArena();
    this.toMenu();
    this.resize();
    this.loop.start();
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
  }

  private resetBattle(): void {
    for (const d of this.drones) this.r3.scene.remove(d.mesh);
    this.drones = [];
    this.shots.clear();
    this.debris.clear();
    this.pickups.clear();
    this.rocks.clear();
    this.particles.clear();
    this.sparks.clear();
    this.marks.clear();
    this.tank.reset(0, -20, 0, this.terrain);
    this.cam.snap(this.tank.x, this.tank.y, this.tank.z, 0);
    this.wave = 0;
    this.score = 0;
    this.toSpawn = 0;
    this.waveT = 1.5;
  }

  private toMenu(): void {
    this.state = 'menu';
    this.resetBattle();
    // a few drones circle the parked tank behind the title screen
    for (let i = 0; i < 3; i++) this.spawnDrone(i * 2.1);
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

  private gameOver(): void {
    this.state = 'over';
    const best = load<number>('titans.best', 0);
    this.menu.result = { wave: this.wave, score: this.score, best, record: this.score > best };
    if (this.score > best) save('titans.best', this.score);
    this.hud.show(false);
    this.sticks.show(false);
    this.audio.setActive(false);
    this.menu.show('over');
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
    this.music.play(this.state === 'playing' ? 'dust' : 'sunny');
  }

  private applySettings(): void {
    this.audio.applyVolume();
    this.updateMusic();
  }

  private resize(): void {
    this.r3.resize();
    this.cam.resize(window.innerWidth, window.innerHeight);
  }

  /* ------------------------------------------------------------------ */
  /* simulation (60 Hz)                                                   */
  /* ------------------------------------------------------------------ */

  private spawnDrone(angleHint = Math.random() * Math.PI * 2): void {
    const d = new Drone('d' + this.nextId++, this.droneParts, this.nextId);
    const R = this.world.def.radius * 0.5;
    d.x = Math.sin(angleHint) * R;
    d.z = Math.cos(angleHint) * R;
    d.y = this.terrain.heightAt(d.x, d.z) + 18;
    this.drones.push(d);
    this.r3.scene.add(d.mesh);
  }

  private step(dt: number): void {
    const inp = this.input;
    this.time += dt;
    if (this.state === 'playing') {
      if (inp.pressed('Escape') || inp.pressed('KeyP') || inp.padPressed(9)) this.pause();
      if (inp.pressed('KeyC') || inp.padPressed(8)) this.hud.onCamera();
      if (inp.pressed('KeyM')) this.hud.onMusic();
    }
    inp.endFrame();
    if (this.state === 'paused') return;
    const terrain = this.terrain;
    const tank = this.tank;
    const playing = this.state === 'playing';

    // ---- player ----
    tank.step(dt, playing && tank.alive ? inp.unit : NO_UNIT_INPUT, terrain);
    this.world.clamp(tank);
    if (tank.impact > 3) {
      this.audio.impact(tank.impact * 1.5);
      this.cam.shake(tank.impact * 0.05);
    }
    if (tank.fired) {
      tank.muzzle(this.muzzle);
      const m = this.muzzle;
      this.aimAssist(m);
      this.shots.fire('player', 'shell', m.x, m.y, m.z, m.vx, m.vy, m.vz);
      this.sparks.emit(m.x, m.y, m.z, 10, 6, Math.sin(tank.turret) * 0.8, Math.cos(tank.turret) * 0.8);
      this.puff(m.x, m.y, m.z, 6, [0.85, 0.82, 0.78], 1.2);
      this.audio.impact(9);
      this.audio.whoosh();
      this.cam.shake(0.25);
      this.model.barrel.position.z = 0.4; // recoil
    }
    this.trackMarks(dt);

    // ---- loose rocks: the heavy tank shoves them aside ----
    const pusher: Pusher = {
      x: tank.x,
      y: tank.y,
      z: tank.z,
      vx: tank.vx,
      vz: tank.vz,
      heading: tank.heading,
      mass: TANK.mass,
      push: (dx, dz) => {
        tank.vx += dx;
        tank.vz += dz;
      },
    };
    this.rocks.wake(pusher, terrain, this.world.knockedRocks);
    if (this.rocks.count) this.rocks.step(dt, terrain, [pusher]);

    // ---- drones ----
    const player = { x: tank.x, y: tank.y, z: tank.z, vx: tank.vx, vz: tank.vz, alive: playing && tank.alive };
    for (const d of this.drones) {
      d.step(dt, terrain, player, this.drones, (x, y, z, vx, vy, vz) => this.shots.fire('enemy', 'orb', x, y, z, vx, vy, vz));
      this.world.clamp(d, -10);
    }

    // ---- shots ----
    const tg = this.targets;
    tg.length = 0;
    tg.push({ id: 'player', team: 'player', x: tank.x, y: tank.y + 1.2, z: tank.z, r: TANK.radius * 0.9, alive: tank.alive && playing });
    for (const d of this.drones) tg.push(d);
    this.shots.step(dt, terrain, tg, this.impacts);
    for (const hit of this.impacts) this.onImpact(hit);
    this.debris.step(dt, terrain);
    const kits = this.pickups.step(dt, this.time, terrain, tank.x, tank.z, 3.2);
    if (kits && tank.alive) {
      tank.hp = Math.min(TANK.maxHp, tank.hp + 30 * kits);
      this.audio.pickup();
      this.banner('🔧 Repaired!', 1200);
    }

    if (playing) this.waves(dt);
    if (this.state === 'playing' && !tank.alive) {
      this.overT += dt;
      if (this.overT > 1.8) this.gameOver();
    }
  }

  private waves(dt: number): void {
    const alive = this.drones.some((d) => d.alive);
    if (!alive && this.toSpawn === 0) {
      this.waveT -= dt;
      if (this.waveT <= 0) {
        this.wave++;
        this.toSpawn = Math.min(2 + this.wave, 10);
        this.spawnT = 0;
        this.waveT = 3;
        this.banner(`WAVE ${this.wave}`, 1800);
        this.audio.beep(true);
      }
    }
    if (this.toSpawn > 0) {
      this.spawnT -= dt;
      if (this.spawnT <= 0) {
        this.spawnDrone();
        this.toSpawn--;
        this.spawnT = 1.1;
      }
    }
  }

  private onImpact(hit: Impact): void {
    if (hit.kind === 'shell') {
      this.explode(hit.x, hit.y, hit.z, 1);
      // splash damage to enemies
      for (const d of this.drones) {
        if (!d.alive) continue;
        const dist = Math.hypot(d.x - hit.x, d.y - hit.y, d.z - hit.z);
        const dmg = hit.target === d ? COMBAT.shellDamage : dist < COMBAT.shellSplash ? COMBAT.shellDamage * 0.5 * (1 - dist / COMBAT.shellSplash) : 0;
        if (dmg > 0) this.damageDrone(d, dmg);
      }
    } else {
      // drone orb
      this.sparks.emit(hit.x, hit.y, hit.z, 14, 5);
      this.puff(hit.x, hit.y, hit.z, 8, [1, 0.45, 0.9], 0.9);
      if (hit.target?.id === 'player' && this.tank.alive) {
        this.tank.hp -= COMBAT.orbDamage;
        this.hud.hurt();
        this.cam.shake(0.5);
        this.audio.impact(10);
        buzz(40);
        if (this.tank.hp <= 0) this.tankDestroyed();
      } else this.audio.impact(4);
    }
  }

  /** kid-friendly aim assist: lift / bend the shell toward the drone closest to the aim line */
  private aimAssist(m: { x: number; y: number; z: number; vx: number; vy: number; vz: number }): void {
    const sp = Math.hypot(m.vx, m.vz);
    let best: Drone | null = null,
      bestScore = 0.3; // max ~17° off the barrel
    for (const d of this.drones) {
      if (!d.alive) continue;
      const dx = d.x - m.x,
        dz = d.z - m.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 90) continue;
      const off = Math.abs(Math.atan2(dx * m.vz - dz * m.vx, dx * m.vx + dz * m.vz));
      if (off < bestScore) {
        bestScore = off;
        best = d;
      }
    }
    if (!best) return;
    const t = Math.hypot(best.x - m.x, best.z - m.z) / sp;
    const tx = best.x + best.vx * t,
      tz = best.z + best.vz * t;
    const l = Math.hypot(tx - m.x, tz - m.z) || 1;
    m.vx = ((tx - m.x) / l) * sp;
    m.vz = ((tz - m.z) / l) * sp;
    m.vy = (best.y + best.vy * t - m.y) / t + 0.5 * COMBAT.shellGravity * t;
  }

  private damageDrone(d: Drone, dmg: number): void {
    d.hp -= dmg;
    d.hitFlash = 0.15;
    if (d.hp > 0) return;
    this.explode(d.x, d.y, d.z, 1.3);
    this.debris.burst(d.x, d.y, d.z, 7, 0.9);
    this.score += 100 * Math.max(1, this.wave);
    if (Math.random() < 0.25) this.pickups.drop(d.x, d.y, d.z);
    this.r3.scene.remove(d.mesh);
    this.drones = this.drones.filter((x) => x !== d);
  }

  private tankDestroyed(): void {
    this.tank.hp = 0;
    this.overT = 0;
    this.explode(this.tank.x, this.tank.y + 1.5, this.tank.z, 2.2);
    this.debris.burst(this.tank.x, this.tank.y + 1.5, this.tank.z, 12, 1.4);
    this.banner('KNOCKED OUT!', 2000);
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
    this.flash.intensity = 60 * size;
    this.audio.impact(14 * size);
    this.audio.landing(8 * size);
    const d = Math.hypot(x - this.tank.x, z - this.tank.z);
    this.cam.shake(clamp((1.2 * size) / Math.max(1, d / 10), 0, 1.2));
  }

  private puff(x: number, y: number, z: number, n: number, c: RGB, size: number): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2,
        v = 0.5 + Math.random() * 2;
      this.particles.emit(x, y, z, Math.cos(a) * v, 0.8 + Math.random() * 1.6, Math.sin(a) * v, c, size * (0.8 + Math.random() * 0.8), 0.9 + Math.random() * 0.8, 0.7);
    }
  }

  private trackMarks(_dt: number): void {
    const t = this.tank;
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
    if (t.speed > 6 && Math.random() < 0.5) this.puff(t.x - s * 3, t.y + 0.3, t.z - c * 3, 1, [col[0] * 1.1, col[1] * 1.1, col[2] * 1.1], 1.4);
  }

  private banner(text: string, ms: number): void {
    this.hud.set('banner', text);
    clearTimeout(this.bannerT);
    this.bannerT = window.setTimeout(() => this.hud.set('banner', ''), ms);
  }
  private bannerT = 0;

  /* ------------------------------------------------------------------ */
  /* render                                                               */
  /* ------------------------------------------------------------------ */

  private render(alpha: number, frameDt: number): void {
    const dt = this.state === 'paused' ? 0 : frameDt;
    const t = this.tank;
    const x = lerp(t.px, t.x, alpha),
      z = lerp(t.pz, t.z, alpha);
    const h = lerpAngle(t.pHeading, t.heading, alpha);
    // tank pose: tilt with the ground
    const m = this.model;
    m.root.visible = t.alive;
    m.root.position.set(x, t.y, z);
    const up = new THREE.Vector3(t.upX, t.upY, t.upZ).normalize();
    const f = new THREE.Vector3(Math.sin(h), 0, Math.cos(h));
    f.addScaledVector(up, -f.dot(up)).normalize();
    m.root.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(up, f), up, f));
    m.turret.rotation.y = lerpAngle(t.pTurret, t.turret, alpha) - h;
    m.barrel.position.z += (0.9 - m.barrel.position.z) * Math.min(1, dt * 8);
    for (const w of m.wheels) w.rotation.x += t.drive * dt * 9;

    // camera, terrain, props
    const chase = settings.cameraView === 'chase' && this.state !== 'menu';
    this.cam.mode = chase ? 'chase' : 'top';
    this.cam.ground = (px, pz) => this.terrain.heightAt(px, pz);
    if (this.state === 'menu') this.cam.zoomTarget = 0.9;
    else this.cam.zoomTarget = isTouchDevice() ? 1.0 : 1.3;
    this.cam.update(Math.min(dt, 0.05), x, t.y, z, t.vx, t.vz, h, false);
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
    this.rocks.sync([t], this.r3.quality.viewRadius * 1.3);
    this.shots.sync(this.time);
    for (const d of this.drones) d.sync(t);
    this.aimMarker.visible = this.state === 'playing' && t.alive && this.input.aimVisible;
    if (this.aimMarker.visible) {
      const a = this.input.aimPoint;
      this.aimMarker.position.set(a.x, this.terrain.heightAt(a.x, a.z) + 0.15, a.z);
    }

    // hud
    if (this.state === 'playing') {
      this.hud.bar('hp', t.hp / TANK.maxHp);
      this.hud.bar('reload', 1 - t.reload / TANK.reload);
      this.hud.set('wave', this.wave ? `WAVE ${this.wave}` : 'GET READY');
      this.hud.set('score', `${this.score}`);
      this.audio.update(900 + Math.abs(t.drive) * 3200 + (this.input.unit.move > 0.1 ? 600 : 0), t.speed, this.input.unit.move, 0, false, 0, 0.3);
    }

    this.r3.monitor(frameDt);
    this.r3.render(this.cam.camera);
  }
}

// keep the drone tuning visible to the HUD / tests
export { DRONE, LIGHTING };
