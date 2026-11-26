export type QualityLevel = 'low' | 'medium' | 'high';

export interface QualityPreset {
  id: QualityLevel;
  /** devicePixelRatio cap (hard cap of 2 is applied on top) */
  maxDpr: number;
  /** dynamic resolution steps it may fall back to */
  dprSteps: number[];
  antialias: boolean;
  /** radius (m) of terrain chunks kept around the look-ahead point */
  viewRadius: number;
  propDensity: number;
  particles: number;
  tireMarks: number;
  /** ms per frame the chunk generator may use */
  genBudgetMs: number;
}

export const QUALITY: Record<QualityLevel, QualityPreset> = {
  low: { id: 'low', maxDpr: 1.25, dprSteps: [1.25, 1, 0.75], antialias: false, viewRadius: 130, propDensity: 0.55, particles: 140, tireMarks: 500, genBudgetMs: 2.5 },
  medium: { id: 'medium', maxDpr: 1.5, dprSteps: [1.5, 1.25, 1, 0.75], antialias: false, viewRadius: 165, propDensity: 0.8, particles: 240, tireMarks: 1000, genBudgetMs: 3.5 },
  high: { id: 'high', maxDpr: 2, dprSteps: [2, 1.5, 1, 0.75], antialias: true, viewRadius: 200, propDensity: 1, particles: 360, tireMarks: 1600, genBudgetMs: 4.5 },
};

/** Dynamic resolution: drop a step when avg fps < down, raise when > up for a while. */
export const DYNAMIC_RES = {
  sampleSeconds: 1.5,
  downFps: 48,
  upFps: 58,
  upHoldSeconds: 6,
  cooldownSeconds: 8,
};

export const TERRAIN = {
  chunkSize: 64, // metres
  chunkRes: 40, // quads per side -> 1.6 m grid
  shoulderMin: 6, // m of blend from road edge into natural terrain
  shoulderPerMeter: 2, // extra blend width per metre of height difference
  shoulderMax: 26,
};
