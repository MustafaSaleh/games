/** Game-mode rules (endless difficulty, countdown, gates...). */
export const ENDLESS = {
  startTime: 35, // seconds on the clock at the start
  gateSpacing: [520, 760] as [number, number], // metres between gates, easy -> hard
  gateBonus: [22, 13] as [number, number], // seconds added per gate, easy -> hard
  difficultyDistance: 9000, // metres until difficulty reaches 1
  roadHalfWidth: [5.6, 4.1] as [number, number],
  maxCurvature: [1 / 110, 1 / 26] as [number, number], // 1/radius
  jumpEvery: [1100, 380] as [number, number],
  jumpHeight: [1.4, 3.4] as [number, number],
  rollAmp: [0.9, 2.6] as [number, number],
  hardSurfaceChance: [0.08, 0.6] as [number, number],
  obstacleBoost: [0, 1.4] as [number, number], // extra rocks near the road
  trackAhead: 900, // m of road generated ahead of the car
  trackBehind: 700, // m kept behind (older samples discarded)
};

export const STAGE_DEFAULTS = {
  width: 9,
  checkpoints: 5,
  rolls: 1.5,
  elevation: 1,
  bank: 1,
  propDensity: 1,
};

export const BANK_FACTOR = 3.2; // bank slope per unit curvature*m
export const BANK_MAX = 0.12;
