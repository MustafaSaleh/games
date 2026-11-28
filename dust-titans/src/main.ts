import '@engine/ui/styles.css';
import './titans.css';
import { TitansGame } from './game';

// iPhone / iPad: block pinch-zoom and double-tap-zoom (same as Dust Rally)
document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
let lastTouchEnd = 0;
document.addEventListener(
  'touchend',
  (e) => {
    const now = performance.now();
    const t = e.target as HTMLElement | null;
    if (now - lastTouchEnd < 350 && !t?.closest('input, select, textarea')) e.preventDefault();
    lastTouchEnd = now;
  },
  { passive: false },
);
document.addEventListener(
  'touchmove',
  (e) => {
    if (e.touches.length > 1) e.preventDefault();
  },
  { passive: false },
);

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLElement;

try {
  const game = new TitansGame(canvas, ui);
  (window as unknown as { __titans: TitansGame }).__titans = game;
  document.getElementById('boot')?.remove();
} catch (e) {
  console.error(e);
  const boot = document.getElementById('boot');
  if (boot) boot.textContent = 'Could not start WebGL: ' + (e as Error).message;
}

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
