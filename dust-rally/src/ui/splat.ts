/**
 * Tomato on the windscreen: juicy blobs, seeds and drips over one player's view,
 * then an automatic squeegee sweeps across and wipes it clean.
 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const HOLD = 1500; // ms the view stays splatted before the squeegee comes
const WIPE = 750; // ms for one sweep

export function splatScreen(layer: HTMLElement, rect: Rect): void {
  const root = document.createElement('div');
  root.className = 'splat';
  Object.assign(root.style, { left: rect.x + 'px', top: rect.y + 'px', width: rect.w + 'px', height: rect.h + 'px' });
  const goo = document.createElement('div');
  goo.className = 'splat-goo';
  root.appendChild(goo);

  const R = (a: number, b: number) => a + Math.random() * (b - a);
  const min = Math.min(rect.w, rect.h);
  // a big centre splash plus satellites
  const blobs = 7 + Math.floor(Math.random() * 4);
  for (let i = 0; i < blobs; i++) {
    const b = document.createElement('i');
    b.className = 'blob';
    const big = i === 0;
    const size = big ? R(0.42, 0.55) * min : R(0.08, 0.24) * min;
    const cx = big ? R(0.35, 0.65) : R(0.08, 0.92),
      cy = big ? R(0.3, 0.6) : R(0.08, 0.9);
    Object.assign(b.style, {
      width: size + 'px',
      height: size * R(0.75, 1.15) + 'px',
      left: cx * rect.w - size / 2 + 'px',
      top: cy * rect.h - size / 2 + 'px',
      transform: `rotate(${R(0, 360)}deg)`,
      animationDelay: (big ? 0 : R(0, 80)) + 'ms',
    });
    goo.appendChild(b);
    // drips running down from the bigger blobs
    if (size > min * 0.12) {
      const n = big ? 4 : 1;
      for (let k = 0; k < n; k++) {
        const d = document.createElement('i');
        d.className = 'drip';
        const w = R(0.018, 0.04) * min;
        Object.assign(d.style, {
          width: w + 'px',
          height: R(0.12, 0.3) * min + 'px',
          left: cx * rect.w + R(-0.35, 0.35) * size + 'px',
          top: cy * rect.h + R(0, 0.25) * size + 'px',
          animationDelay: R(150, 500) + 'ms',
        });
        goo.appendChild(d);
      }
    }
  }
  // seeds
  for (let i = 0; i < 26; i++) {
    const s = document.createElement('i');
    s.className = 'seed';
    Object.assign(s.style, { left: R(0.2, 0.8) * rect.w + 'px', top: R(0.2, 0.75) * rect.h + 'px', transform: `rotate(${R(0, 180)}deg)` });
    goo.appendChild(s);
  }
  const blade = document.createElement('div');
  blade.className = 'squeegee';
  blade.innerHTML = '<span class="rubber"></span><span class="handle"></span>';
  root.appendChild(blade);
  layer.appendChild(root);

  // the wipe: blade sweeps left -> right, goo is cut away behind it
  const anim = (el: Element, kf: Keyframe[], o: KeyframeAnimationOptions) => (el.animate ? el.animate(kf, o) : null);
  anim(blade, [{ transform: 'translateX(-10%)' }, { transform: `translateX(${rect.w + 40}px)` }], { duration: WIPE, delay: HOLD, easing: 'ease-in-out', fill: 'both' });
  anim(goo, [{ clipPath: 'inset(0 0 0 0)' }, { clipPath: 'inset(0 0 0 100%)' }], { duration: WIPE, delay: HOLD, easing: 'ease-in-out', fill: 'forwards' });
  anim(root, [{ opacity: 1 }, { opacity: 0 }], { duration: 200, delay: HOLD + WIPE, fill: 'forwards' });
  setTimeout(() => root.remove(), HOLD + WIPE + 260);
}
