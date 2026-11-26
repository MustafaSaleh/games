/**
 * Fixed-timestep loop: physics at 60 Hz, rendering at display rate with
 * interpolation alpha. Stops accumulating while paused/hidden.
 */
export class Loop {
  readonly fixedDt = 1 / 60;
  timeScale = 1;
  running = false;
  private acc = 0;
  private last = 0;
  private raf = 0;
  /** last frame delta (s, unscaled) */
  frameDt = 0;

  constructor(
    private step: (dt: number) => void,
    private render: (alpha: number, frameDt: number) => void,
    private beforeSteps: (frameDt: number) => void = () => {},
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.acc = 0;
    this.raf = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private tick = (now: number): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.tick);
    let dt = (now - this.last) / 1000;
    this.last = now;
    if (dt > 0.25) dt = 0.25; // tab switch / hitch: don't spiral
    this.frameDt = dt;
    this.beforeSteps(dt);
    this.acc += dt * this.timeScale;
    let steps = 0;
    const maxSteps = this.timeScale > 1 ? 40 : 5;
    while (this.acc >= this.fixedDt && steps < maxSteps) {
      this.step(this.fixedDt);
      this.acc -= this.fixedDt;
      steps++;
    }
    if (steps === maxSteps) this.acc = 0;
    this.render(this.acc / this.fixedDt, dt);
  };
}
