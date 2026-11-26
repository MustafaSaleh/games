/**
 * Procedural background music: a tiny step sequencer (drums, bass, chords, arpeggio,
 * lead) on Web Audio. Nothing is downloaded. Each track is a short description below;
 * the lead melody is generated from a seed so it is the same every time.
 */

export type TrackId = 'sunny' | 'dust' | 'turbo' | 'frost';

interface TrackDef {
  id: TrackId;
  name: string;
  bpm: number;
  /** MIDI note of the key's root */
  root: number;
  /** scale degrees (semitones) */
  scale: number[];
  /** chord roots per bar, as scale indices (each bar = 16 steps) */
  chords: number[];
  kick: string; // 16 chars, x = hit
  snare: string;
  hat: string;
  /** bass rhythm: x = chord root, o = octave, - = rest */
  bass: string;
  /** arpeggio on/off and lead density 0..1 */
  arp: boolean;
  lead: number;
  leadWave: OscillatorType;
  seed: number;
  /** used for the menu (calm) or races (energetic) */
  mood: 'menu' | 'race';
}

export const TRACKS: TrackDef[] = [
  {
    id: 'sunny',
    name: 'Sunny Garage',
    bpm: 104,
    root: 55, // G
    scale: [0, 2, 4, 5, 7, 9, 11],
    chords: [0, 5, 3, 4, 0, 5, 1, 4],
    kick: 'x-------x-------',
    snare: '----x-------x---',
    hat: '--x---x---x---x-',
    bass: 'x---o---x-x-o---',
    arp: true,
    lead: 0.35,
    leadWave: 'triangle',
    seed: 7,
    mood: 'menu',
  },
  {
    id: 'dust',
    name: 'Dust Devil',
    bpm: 132,
    root: 52, // E minor
    scale: [0, 2, 3, 5, 7, 8, 10],
    chords: [0, 5, 6, 4, 0, 5, 3, 4],
    kick: 'x---x---x---x---',
    snare: '----x-------x--x',
    hat: 'x-x-x-x-x-x-x-xx',
    bass: 'x-xox-x-x-xox-x-',
    arp: true,
    lead: 0.6,
    leadWave: 'square',
    seed: 21,
    mood: 'race',
  },
  {
    id: 'turbo',
    name: 'Turbo Hatch',
    bpm: 146,
    root: 57, // A
    scale: [0, 2, 4, 5, 7, 9, 11],
    chords: [0, 4, 5, 3, 0, 4, 3, 4],
    kick: 'x-----x-x---x---',
    snare: '----x-------x---',
    hat: 'xxxxxxxxxxxxxxxx',
    bass: 'xoxoxoxoxoxoxoxo',
    arp: false,
    lead: 0.75,
    leadWave: 'sawtooth',
    seed: 99,
    mood: 'race',
  },
  {
    id: 'frost',
    name: 'Night Frost',
    bpm: 118,
    root: 50, // D minor
    scale: [0, 2, 3, 5, 7, 8, 10],
    chords: [0, 3, 5, 4, 0, 3, 6, 4],
    kick: 'x-------x--x----',
    snare: '----x-------x---',
    hat: '--x-x---x-x-x-x-',
    bass: 'x--x--x-x--x--x-',
    arp: true,
    lead: 0.4,
    leadWave: 'triangle',
    seed: 5,
    mood: 'race',
  },
];

export function getTrack(id: string): TrackDef {
  return TRACKS.find((t) => t.id === id) ?? TRACKS[0];
}

const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 10000) / 10000;
  };
}

/** a lead line: per bar, 16 steps of scale offsets relative to the chord (or null = rest) */
function makeMelody(t: TrackDef): (number | null)[][] {
  const r = rng(t.seed);
  const bars: (number | null)[][] = [];
  for (let b = 0; b < t.chords.length; b++) {
    const bar: (number | null)[] = [];
    let deg = [0, 2, 4][Math.floor(r() * 3)];
    for (let s = 0; s < 16; s++) {
      const strong = s % 4 === 0;
      if (r() < (strong ? t.lead + 0.25 : t.lead * 0.55)) {
        deg += [-2, -1, 1, 2, 0][Math.floor(r() * 5)];
        deg = Math.max(-2, Math.min(9, deg));
        bar.push(deg);
      } else bar.push(null);
    }
    bars.push(bar);
  }
  // the second half repeats the first with an answer at the end, so it sounds like a tune
  const half = bars.length / 2;
  for (let b = half; b < bars.length - 1; b++) bars[b] = bars[b - half].slice();
  return bars;
}

export class MusicPlayer {
  private ctx: AudioContext | null = null;
  private out!: GainNode;
  private bus!: GainNode;
  private noise!: AudioBuffer;
  private track: TrackDef = TRACKS[0];
  private melody: (number | null)[][] = [];
  private step = 0;
  private nextTime = 0;
  private timer = 0;
  private playing = false;
  private volume = 0.5;
  private enabled = true;

  /** connect to the game's AudioContext (after the first tap / key press) */
  attach(ctx: AudioContext, noise: AudioBuffer): void {
    if (this.ctx) return;
    this.ctx = ctx;
    this.noise = noise;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(ctx.destination);
    // gentle glue: a compressor so drums and lead sit together
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 3;
    this.bus = ctx.createGain();
    this.bus.gain.value = 0.55;
    this.bus.connect(comp).connect(this.out);
    this.apply();
  }

  get current(): TrackDef {
    return this.track;
  }

  /** volume 0..1 and on/off; fades smoothly */
  set(enabled: boolean, volume: number): void {
    this.enabled = enabled;
    this.volume = volume;
    this.apply();
  }

  private apply(): void {
    if (!this.ctx) return;
    const v = this.enabled ? this.volume * 0.6 : 0;
    this.out.gain.setTargetAtTime(v, this.ctx.currentTime, 0.25);
    if (this.enabled && !this.playing) this.start();
    if (!this.enabled && this.playing) setTimeout(() => !this.enabled && this.stop(), 900);
  }

  /** switch tune (no-op if already playing it); fades out, then starts the new one on the beat */
  play(id: TrackId): void {
    const t = getTrack(id);
    if (t === this.track && this.melody.length) return;
    const ctx = this.ctx;
    if (!ctx || !this.playing) {
      this.track = t;
      this.melody = makeMelody(t);
      this.step = 0;
      return;
    }
    this.bus.gain.setTargetAtTime(0, ctx.currentTime, 0.15);
    setTimeout(() => {
      this.track = t;
      this.melody = makeMelody(t);
      this.step = 0;
      this.nextTime = ctx.currentTime + 0.05;
      this.bus.gain.setTargetAtTime(0.55, ctx.currentTime, 0.2);
    }, 600);
  }

  private start(): void {
    if (!this.ctx || this.playing) return;
    if (!this.melody.length) this.melody = makeMelody(this.track);
    this.playing = true;
    this.nextTime = this.ctx.currentTime + 0.1;
    this.timer = window.setInterval(() => this.schedule(), 25);
  }

  private stop(): void {
    this.playing = false;
    clearInterval(this.timer);
  }

  /** look-ahead scheduler: queue every step that starts in the next 150 ms */
  private schedule(): void {
    const ctx = this.ctx!;
    if (ctx.state !== 'running') {
      this.nextTime = ctx.currentTime + 0.1;
      return;
    }
    const stepDur = 60 / this.track.bpm / 4;
    if (this.nextTime < ctx.currentTime - 0.2) this.nextTime = ctx.currentTime + 0.05; // after a pause
    while (this.nextTime < ctx.currentTime + 0.15) {
      this.playStep(this.step, this.nextTime, stepDur);
      this.nextTime += stepDur;
      this.step = (this.step + 1) % (this.track.chords.length * 16);
    }
  }

  private playStep(step: number, t: number, dur: number): void {
    const tr = this.track;
    const bar = Math.floor(step / 16),
      s = step % 16;
    const chordDeg = tr.chords[bar];
    const note = (deg: number, oct = 0) => {
      const n = tr.scale.length;
      const d = chordDeg + deg;
      const o = Math.floor(d / n);
      return tr.root + tr.scale[((d % n) + n) % n] + 12 * (o + oct);
    };
    // drums
    if (tr.kick[s] === 'x') this.kick(t);
    if (tr.snare[s] === 'x') this.snare(t);
    if (tr.hat[s] === 'x') this.hat(t, s % 4 === 2 ? 0.07 : 0.04);
    // bass
    const bs = tr.bass[s];
    if (bs === 'x' || bs === 'o') this.tone(hz(note(0, bs === 'o' ? -1 : -2)), t, dur * 1.8, 'sawtooth', 0.16, 500);
    // chord pad on the bar start
    if (s === 0) for (const d of [0, 2, 4]) this.tone(hz(note(d, 0)), t, dur * 15, 'triangle', 0.035, 1400, 0.25);
    // arpeggio
    if (tr.arp && s % 2 === 0) this.tone(hz(note([0, 2, 4, 7][(s / 2) % 4], 1)), t, dur * 0.9, 'square', 0.025, 2200);
    // lead (off in the first pass of the loop's opening bars for some breathing room)
    const m = this.melody[bar]?.[s];
    if (m != null) this.tone(hz(note(m, 1)), t, dur * 1.7, tr.leadWave, tr.leadWave === 'sawtooth' ? 0.04 : 0.06, 2600, 0.01, true);
  }

  private tone(f: number, t: number, len: number, type: OscillatorType, vol: number, cutoff: number, attack = 0.005, vibrato = false): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (vibrato) {
      const lfo = ctx.createOscillator();
      const lg = ctx.createGain();
      lfo.frequency.value = 5.5;
      lg.gain.value = f * 0.006;
      lfo.connect(lg).connect(o.frequency);
      lfo.start(t);
      lfo.stop(t + len + 0.05);
    }
    const flt = ctx.createBiquadFilter();
    flt.type = 'lowpass';
    flt.frequency.value = cutoff;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(flt).connect(g).connect(this.bus);
    o.start(t);
    o.stop(t + len + 0.05);
  }

  private kick(t: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.14);
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    o.connect(g).connect(this.bus);
    o.start(t);
    o.stop(t + 0.25);
  }

  private noiseHit(t: number, len: number, vol: number, type: BiquadFilterType, freq: number): void {
    const ctx = this.ctx!;
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    n.connect(f).connect(g).connect(this.bus);
    n.start(t, Math.random() * 1.2);
    n.stop(t + len + 0.02);
  }

  private snare(t: number): void {
    this.noiseHit(t, 0.16, 0.22, 'bandpass', 1800);
    this.tone(190, t, 0.1, 'triangle', 0.1, 1200);
  }

  private hat(t: number, vol: number): void {
    this.noiseHit(t, 0.04, vol, 'highpass', 7000);
  }
}
