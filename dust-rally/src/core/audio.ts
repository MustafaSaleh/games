import { clamp } from './math';
import { settings } from './settings';

/** Gear top speeds (m/s) used to fake an RPM curve. */
const GEARS = [0, 9, 16, 23, 31, 39, 50];

/**
 * Procedural Web Audio: engine (two oscillators through a low-pass, pitch from fake
 * RPM), skid (band-passed noise), surface rumble, one-shot impacts/landings/beeps.
 * Nothing is loaded from the network. Silent until unlock() is called from a gesture.
 */
export class GameAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private engGain!: GainNode;
  private osc1!: OscillatorNode;
  private osc2!: OscillatorNode;
  private engFilter!: BiquadFilterNode;
  private skidGain!: GainNode;
  private skidFilter!: BiquadFilterNode;
  private rumbleGain!: GainNode;
  private noise!: AudioBuffer;
  private rpm = 900;
  private active = false;

  get unlocked(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  unlock(): void {
    if (!this.ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.build();
    }
    if (this.ctx.state !== 'running') void this.ctx.resume();
    this.applyVolume();
  }

  private build(): void {
    const ctx = this.ctx!;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    // noise buffer (shared)
    const len = ctx.sampleRate * 1.5;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // engine
    this.engFilter = ctx.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.frequency.value = 600;
    this.engFilter.Q.value = 2;
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0;
    this.osc1 = ctx.createOscillator();
    this.osc1.type = 'sawtooth';
    this.osc2 = ctx.createOscillator();
    this.osc2.type = 'square';
    const g2 = ctx.createGain();
    g2.gain.value = 0.5;
    this.osc1.connect(this.engFilter);
    this.osc2.connect(g2).connect(this.engFilter);
    this.engFilter.connect(this.engGain).connect(this.master);
    this.osc1.start();
    this.osc2.start();

    // skid
    const skidSrc = ctx.createBufferSource();
    skidSrc.buffer = this.noise;
    skidSrc.loop = true;
    this.skidFilter = ctx.createBiquadFilter();
    this.skidFilter.type = 'bandpass';
    this.skidFilter.frequency.value = 900;
    this.skidFilter.Q.value = 0.8;
    this.skidGain = ctx.createGain();
    this.skidGain.gain.value = 0;
    skidSrc.connect(this.skidFilter).connect(this.skidGain).connect(this.master);
    skidSrc.start();

    // rumble (gravel / wind)
    const rSrc = ctx.createBufferSource();
    rSrc.buffer = this.noise;
    rSrc.loop = true;
    rSrc.playbackRate.value = 0.7;
    const rf = ctx.createBiquadFilter();
    rf.type = 'lowpass';
    rf.frequency.value = 380;
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0;
    rSrc.connect(rf).connect(this.rumbleGain).connect(this.master);
    rSrc.start();
  }

  applyVolume(): void {
    if (!this.ctx) return;
    this.master.gain.setTargetAtTime(settings.sound ? settings.volume : 0, this.ctx.currentTime, 0.05);
  }

  /** engine on/off (menus vs racing) */
  setActive(on: boolean): void {
    this.active = on;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (!on) {
      this.engGain.gain.setTargetAtTime(0, t, 0.1);
      this.skidGain.gain.setTargetAtTime(0, t, 0.05);
      this.rumbleGain.gain.setTargetAtTime(0, t, 0.1);
    }
  }

  suspend(): void {
    if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend();
  }
  resume(): void {
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
  }

  update(dt: number, speed: number, throttle: number, slide: number, airborne: boolean, wheelspin: number, skidMul: number, dust: number): void {
    if (!this.ctx || !this.active || this.ctx.state !== 'running') return;
    // fake gearbox
    let g = 1;
    while (g < GEARS.length - 1 && speed > GEARS[g]) g++;
    const lo = GEARS[g - 1] * 0.75,
      hi = GEARS[g];
    let target = 1000 + clamp((speed - lo) / (hi - lo), 0, 1) * 5600;
    if (airborne || wheelspin > 0.2) target = Math.max(target, 2500 + 4500 * Math.max(throttle, wheelspin));
    if (throttle < 0.05 && !airborne) target *= 0.85;
    this.rpm += (target - this.rpm) * Math.min(1, dt * (target > this.rpm ? 6 : 4));
    const f = this.rpm / 30;
    const t = this.ctx.currentTime;
    this.osc1.frequency.setTargetAtTime(f, t, 0.03);
    this.osc2.frequency.setTargetAtTime(f * 0.5, t, 0.03);
    this.engFilter.frequency.setTargetAtTime(350 + this.rpm * 0.25 + throttle * 700, t, 0.05);
    this.engGain.gain.setTargetAtTime(0.09 + throttle * 0.08, t, 0.05);
    const skid = airborne ? 0 : clamp(slide, 0, 1) * clamp(speed / 12, 0, 1) * skidMul;
    this.skidGain.gain.setTargetAtTime(skid * 0.35, t, 0.04);
    this.skidFilter.frequency.setTargetAtTime(500 + skidMul * 900, t, 0.1);
    this.rumbleGain.gain.setTargetAtTime(airborne ? 0.02 : clamp(speed / 40, 0, 1) * (0.06 + dust * 0.08), t, 0.1);
  }

  private oneShot(freqFrom: number, freqTo: number, dur: number, vol: number, type: OscillatorType = 'sine', noise = 0): void {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const ctx = this.ctx,
      t = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    g.connect(this.master);
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freqFrom, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, freqTo), t + dur);
    o.connect(g);
    o.start(t);
    o.stop(t + dur + 0.02);
    if (noise > 0) {
      const n = ctx.createBufferSource();
      n.buffer = this.noise;
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 1200;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(noise, t);
      ng.gain.exponentialRampToValueAtTime(0.001, t + dur * 0.8);
      n.connect(f).connect(ng).connect(this.master);
      n.start(t, Math.random());
      n.stop(t + dur);
    }
  }

  impact(strength: number): void {
    const s = clamp(strength / 15, 0.15, 1);
    this.oneShot(140, 40, 0.35, 0.5 * s, 'triangle', 0.6 * s);
  }
  landing(strength: number): void {
    const s = clamp(strength / 12, 0.1, 1);
    this.oneShot(90, 35, 0.25, 0.45 * s, 'sine', 0.3 * s);
  }
  beep(high = false): void {
    this.oneShot(high ? 1320 : 660, high ? 1320 : 660, high ? 0.5 : 0.18, 0.18, 'square');
  }
  checkpoint(good = true): void {
    this.oneShot(good ? 880 : 520, good ? 1320 : 400, 0.25, 0.15, 'triangle');
  }
}
