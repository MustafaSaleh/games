import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { StageWorld } from '../world/stage';

/**
 * A red suspension bridge over the bay, built from the stage's track: deck slab with side
 * girders and railings along the road, two tall towers with cross beams, main cables
 * draped between the towers, and vertical suspenders. The broken section has no deck,
 * jagged slab ends hanging down, no suspenders, and one snapped main cable dangling in the
 * water. The drivable surface itself is the terrain (raised road); this is the look.
 */
const RED = 0xc4452f;
const RED_DARK = 0x9b3524;
const STEEL = 0x3a3b40;

export function buildBridge(world: StageWorld): THREE.Mesh | null {
  const def = world.def.bridge;
  if (!def) return null;
  const tr = world.track;
  const sp = tr.spacing;
  const i0 = Math.max(0, Math.round(def.from / sp)),
    i1 = Math.min(tr.end - 1, Math.round(def.to / sp));
  const halfW = tr.halfW(i0);
  const side = halfW + 2.4; // deck overhang beyond the road edge (sidewalks)
  const water = world.waterLevel;
  const seabed = water - (world.def.bay?.depth ?? 20);
  const parts: THREE.BufferGeometry[] = [];
  const col = (g: THREE.BufferGeometry, hex: number) => {
    const geo = g.index ? g.toNonIndexed() : g;
    const c = new THREE.Color(hex);
    const n = geo.attributes.position.count;
    const a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
    geo.deleteAttribute('uv');
    parts.push(geo);
  };
  /** box with its local X across the road and Z along it, at a track heading */
  const obox = (w: number, h: number, d: number, x: number, y: number, z: number, heading: number, hex: number, pitch = 0) =>
    col(new THREE.BoxGeometry(w, h, d).rotateX(pitch).rotateY(heading).translate(x, y, z), hex);
  /** thin beam between two 3D points */
  const beam = (a: THREE.Vector3, b: THREE.Vector3, r: number, hex: number) => {
    const len = a.distanceTo(b);
    if (len < 0.01) return;
    const g = new THREE.BoxGeometry(r, r, len);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), b.clone().sub(a).normalize());
    g.applyQuaternion(q).translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    col(g, hex);
  };
  const head = (i: number) => Math.atan2(tr.dx(i), tr.dz(i));
  const kind = (i: number) => world.roadKind(i);
  const at = (i: number, lateral: number, y: number) => new THREE.Vector3(tr.x(i) - tr.dz(i) * lateral, y, tr.z(i) + tr.dx(i) * lateral);

  // ---- deck, girders, railings (every 2 samples = 4 m) ----
  const step = 2;
  for (let i = i0; i < i1; i += step) {
    const j = Math.min(i1, i + step);
    if (kind(i) !== 1 || kind(j) !== 1) continue;
    const h = (tr.h(i) + tr.h(j)) / 2;
    const len = Math.hypot(tr.x(j) - tr.x(i), tr.z(j) - tr.z(i)) + 0.05;
    const pitch = -Math.atan2(tr.h(j) - tr.h(i), len);
    const cx = (tr.x(i) + tr.x(j)) / 2,
      cz = (tr.z(i) + tr.z(j)) / 2;
    const hd = head(i);
    obox(side * 2, 0.9, len, cx, h - 0.55, cz, hd, STEEL, pitch);
    for (const s of [-1, 1]) {
      const lx = -Math.cos(hd) * side * s,
        lz = Math.sin(hd) * side * s;
      obox(0.35, 4.6, len, cx + lx, h - 2.0, cz + lz, hd, RED, pitch); // girder
      obox(0.12, 0.12, len, cx + lx * 0.98, h + 1.05, cz + lz * 0.98, hd, RED_DARK, pitch); // rail
      if (((i - i0) / step) % 2 === 0) obox(0.12, 1.05, 0.12, cx + lx * 0.98, h + 0.5, cz + lz * 0.98, hd, RED_DARK); // post
    }
  }
  // the approaches stand on piers (not over the gap)
  for (let i = i0; i <= i1; i += 20) {
    if (kind(i) !== 1) continue;
    const p = at(i, 0, 0);
    const top = tr.h(i) - 1;
    const ground = world.exactPoint(p.x, p.z).base;
    if (top - ground < 2.5) continue;
    obox(side * 1.4, top - ground, 1.6, p.x, (top + ground) / 2, p.z, head(i), RED_DARK);
  }

  // ---- broken ends of the gap: slabs hanging down ----
  const g = def.gap;
  if (g) {
    const ga = Math.round(g.from / sp),
      gb = Math.round(g.to / sp);
    for (const [i, dir] of [
      [ga, 1],
      [gb, -1],
    ] as const) {
      const hd = head(i);
      const h = tr.h(i);
      // a pier under each broken end: the heightfield's drop to the seabed becomes a pier
      const pc = at(i, 0, 0);
      const fx0 = Math.sin(hd) * dir,
        fz0 = Math.cos(hd) * dir;
      const pierTop = h - 1.0;
      obox(side * 2 + 2.4, pierTop - seabed, 5.5, pc.x + fx0 * 1.2, (pierTop + seabed) / 2, pc.z + fz0 * 1.2, hd, 0x8c877c);
      obox(side * 2 + 3.2, 1.4, 6.3, pc.x + fx0 * 1.2, pierTop - 0.4, pc.z + fz0 * 1.2, hd, RED_DARK); // cap
      obox(side * 2 + 2.6, 2.2, 5.9, pc.x + fx0 * 1.2, water + 0.6, pc.z + fz0 * 1.2, hd, 0x4e5a4a); // waterline grime
      for (let k = 0; k < 3; k++) {
        const lat = (k - 1) * side * 0.6;
        const p = at(i, lat, 0);
        const fx = Math.sin(hd) * dir,
          fz = Math.cos(hd) * dir;
        const tilt = (0.5 + k * 0.25) * dir;
        obox(side * 0.55, 0.8, 3.2, p.x + fx * 1.4, h - 1.6 - k * 0.4, p.z + fz * 1.4, hd, k === 1 ? STEEL : RED, tilt);
      }
    }
  }

  // ---- towers ----
  const towers = def.towers ?? [];
  const towerTop = (i: number) => tr.h(i) + 46;
  for (const ts of towers) {
    const i = Math.round(ts / sp);
    const hd = head(i);
    const top = towerTop(i);
    for (const s of [-1, 1]) {
      const p = at(i, (side + 1.4) * s, 0);
      obox(2.8, top - seabed, 2.8, p.x, (top + seabed) / 2, p.z, hd, RED);
      obox(3.4, 1.2, 3.4, p.x, top + 0.6, p.z, hd, RED_DARK); // cap
    }
    const mid = at(i, 0, 0);
    for (const y of [tr.h(i) + 16, tr.h(i) + 30, top - 2]) obox((side + 1.4) * 2, 2.4, 2.2, mid.x, y, mid.z, hd, RED);
    obox((side + 1.4) * 2, 2.0, 2.2, mid.x, tr.h(i) - 3.5, mid.z, hd, RED_DARK); // under the deck
  }

  // ---- main cables + suspenders ----
  if (towers.length >= 2) {
    const ta = Math.round(towers[0] / sp),
      tb = Math.round(towers[towers.length - 1] / sp);
    const cableY = (i: number): number => {
      if (i <= ta) {
        const u = (i - i0) / Math.max(1, ta - i0);
        return tr.h(i0) + 2 + (towerTop(ta) - tr.h(i0) - 2) * Math.pow(u, 1.6);
      }
      if (i >= tb) {
        const u = (i1 - i) / Math.max(1, i1 - tb);
        return tr.h(i1) + 2 + (towerTop(tb) - tr.h(i1) - 2) * Math.pow(u, 1.6);
      }
      const u = (i - ta) / (tb - ta); // 0..1 between the towers: a sagging parabola
      const topY = towerTop(ta) + (towerTop(tb) - towerTop(ta)) * u;
      return topY - 4 * u * (1 - u) * (topY - (tr.h(i) + 5));
    };
    const gapA = g ? Math.round(g.from / sp) - 3 : -1,
      gapB = g ? Math.round(g.to / sp) + 3 : -1;
    for (const s of [-1, 1]) {
      const lat = (side + 1.4) * s;
      const snapped = s < 0 && g; // this cable broke over the gap
      let prev: THREE.Vector3 | null = null;
      for (let i = i0; i <= i1; i += 3) {
        const p = at(i, lat, cableY(i));
        const cut = snapped && i > gapA && i < gapB;
        if (prev && !cut) beam(prev, p, 0.55, RED_DARK);
        if (cut && prev) {
          // the cut end dangles into the water
          beam(prev, at(i + 2, lat * 1.05, water - 2), 0.5, RED_DARK);
          prev = null;
        } else prev = cut ? null : p;
        if (cut && !prev) continue;
        // suspenders down to the deck (none over the gap)
        if (i % 6 === 0 && kind(i) === 1 && i > i0 + 6 && i < i1 - 6) {
          const y = cableY(i);
          if (y - tr.h(i) > 2) beam(at(i, lat, tr.h(i) + 0.9), p, 0.14, RED_DARK);
        }
      }
      if (snapped) {
        // the other cut end, from the far side, hanging down too
        beam(at(gapB, lat, cableY(gapB)), at(gapB - 4, lat * 1.05, water - 2), 0.5, RED_DARK);
      }
    }
  }

  const geo = mergeGeometries(parts, false)!;
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  mesh.frustumCulled = false;
  return mesh;
}

/** A big water plane at the bay's level (terrain above it hides it everywhere else). */
export function buildWater(level: number): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: 0x3d6a78, emissive: 0x0d2630, transparent: true, opacity: 0.9, depthWrite: true }),
  );
  m.position.y = level;
  m.renderOrder = 1;
  return m;
}
