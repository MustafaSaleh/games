import './ui/styles.css';
import { Game } from './core/game';
import type { StageDef } from './world/stage';

// every JSON file in src/tracks is a stage (sorted by file name)
const modules = import.meta.glob<{ default: StageDef }>('./tracks/*.json', { eager: true });
const stages = Object.keys(modules)
  .sort()
  .map((k) => modules[k].default);
const order = ['forest-ridge', 'dune-run', 'frost-line', 'redwood-pass', 'ghost-bay'];
stages.sort((a, b) => (order.indexOf(a.id) + 1 || 99) - (order.indexOf(b.id) + 1 || 99));

// iPhone / iPad ignore user-scalable=no: block pinch-zoom and double-tap-zoom ourselves,
// otherwise a quick double tap zooms the page and there is no easy way back.
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
    if (e.touches.length > 1) e.preventDefault(); // pinch
  },
  { passive: false },
);

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLElement;

try {
  const game = new Game(canvas, ui, stages);
  (window as unknown as { __game: Game }).__game = game;
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
