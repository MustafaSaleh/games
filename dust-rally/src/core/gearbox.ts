import { clamp } from './math';

/** Gear top speeds (m/s) for the reference car; scaled by each car's top speed. */
export const GEARS = [0, 9, 16, 23, 31, 39, 50];
export const MAX_RPM = 7000;
export const REDLINE = 6300;

/**
 * Fake gearbox shared by the engine sound and the rev gauge: picks a gear from the
 * speed and eases the revs toward that gear's range (blipping in the air / on wheelspin).
 */
export class Gearbox {
  rpm = 900;
  /** -1 = reverse, 0 = neutral, 1..6 */
  gear = 0;

  update(dt: number, forwardSpeed: number, throttle: number, airborne: boolean, wheelspin: number, topSpeedMul = 1): void {
    const speed = Math.abs(forwardSpeed) / topSpeedMul;
    let g = 1;
    while (g < GEARS.length - 1 && speed > GEARS[g]) g++;
    const lo = GEARS[g - 1] * 0.75,
      hi = GEARS[g];
    let target = 1000 + clamp((speed - lo) / (hi - lo), 0, 1) * 5600;
    if (airborne || wheelspin > 0.2) target = Math.max(target, 2500 + 4500 * Math.max(throttle, wheelspin));
    if (throttle < 0.05 && !airborne) target *= 0.85;
    this.rpm += (target - this.rpm) * Math.min(1, dt * (target > this.rpm ? 6 : 4));
    this.rpm = clamp(this.rpm, 800, MAX_RPM);
    this.gear = forwardSpeed < -0.5 ? -1 : Math.abs(forwardSpeed) < 0.5 && throttle < 0.05 ? 0 : g;
  }

  get label(): string {
    return this.gear < 0 ? 'R' : this.gear === 0 ? 'N' : String(this.gear);
  }
}
