import { settings } from './settings';

let lastBuzz = 0;
/** Short vibration where supported (Android). Rate limited. */
export function buzz(ms: number | number[]): void {
  if (!settings.haptics || !('vibrate' in navigator)) return;
  const ua = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
  if (ua && !ua.hasBeenActive) return;
  const now = performance.now();
  if (now - lastBuzz < 120) return;
  lastBuzz = now;
  try {
    navigator.vibrate(ms);
  } catch {
    /* ignore */
  }
}
