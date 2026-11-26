import type { QualityLevel } from '../config/quality';
import type { TimeOfDay } from '../config/lighting';
import { load, save } from './storage';

export type SteerMode = 'joystick' | 'buttons' | 'tilt';

export interface Settings {
  quality: 'auto' | QualityLevel;
  artStyle: 'color' | 'mono';
  sound: boolean;
  volume: number;
  steer: SteerMode;
  tiltSensitivity: number;
  autoGas: boolean;
  haptics: boolean;
  timeOfDay: 'auto' | TimeOfDay;
  cameraRotate: boolean;
  showFps: boolean;
  carStyle: string;
  carLivery: string;
}

const DEFAULTS: Settings = {
  quality: 'auto',
  artStyle: 'color',
  sound: true,
  volume: 0.7,
  steer: 'joystick',
  tiltSensitivity: 1,
  autoGas: false,
  haptics: true,
  timeOfDay: 'auto',
  cameraRotate: false,
  showFps: false,
  carStyle: 'hatch',
  carLivery: 'white',
};

export const settings: Settings = { ...DEFAULTS, ...load<Partial<Settings>>('settings', {}) };

type Listener = (s: Settings) => void;
const listeners: Listener[] = [];

export function updateSettings(patch: Partial<Settings>): void {
  Object.assign(settings, patch);
  save('settings', settings);
  for (const l of listeners) l(settings);
}

export function onSettingsChange(l: Listener): void {
  listeners.push(l);
}

export function isTouchDevice(): boolean {
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}

/** Pick a quality level for 'auto' from cheap hardware hints. */
export function autoQuality(): QualityLevel {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const cores = nav.hardwareConcurrency || 4;
  const mem = nav.deviceMemory ?? 4;
  const touch = isTouchDevice();
  if (!touch && cores >= 6) return 'high';
  if (cores <= 4 || mem <= 3) return 'low';
  return 'medium';
}
