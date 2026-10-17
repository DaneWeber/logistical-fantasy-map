import { boxBlur, polylineField, rasterizePolyline, sample } from './grid';
import { fbm, lerp, makeNoise2D, ridged, smoothstep } from './noise';
import { hashString, mix } from './rng';
import {
  LANDFORM_PAINT,
  LANDSEA,
  type Grid,
  type ImplicitFeatures,
  type PaintLayer,
  type RidgeFeature,
  type RiverFeature,
  type Vec,
  type WorldDoc,
} from './types';

/** Reads a paint layer at a grid cell, resampling if the layer's size differs. */
export function paintAt(layer: PaintLayer, g: Grid, i: number): number {
  if (layer.w === g.w && layer.h === g.h) return layer.data[i];
  const x = Math.floor((((i % g.w) + 0.5) / g.w) * layer.w);
  const y = Math.floor(((Math.floor(i / g.w) + 0.5) / g.h) * layer.h);
  return layer.data[Math.min(layer.h - 1, y) * layer.w + Math.min(layer.w - 1, x)];
}

/**
 * Raw elevation (metres) before erosion: continent shape, painted land/sea,
 * natural mountain belts, user and implicit ridges, and landform hints.
 */
export function buildTerrain(doc: WorldDoc, g: Grid, implicit: ImplicitFeatures): Float32Array {
  const S = doc.settings;
  const seed = doc.seed >>> 0;
  const nC = makeNoise2D(mix(seed, 11));
  const nD = makeNoise2D(mix(seed, 12));
  const nM = makeNoise2D(mix(seed, 13));
  const nR = makeNoise2D(mix(seed, 14));
  const nW = makeNoise2D(mix(seed, 15));
  const nA = makeNoise2D(mix(seed, 16));
  const { w, h: H, cellKm } = g;
  const n = w * H;
  const maxDim = Math.max(g.widthKm, g.heightKm);
  const fc = 1.7 / maxDim;
  const fd = 1 / 45;
  const fm = 2.4 / maxDim;
  const fr = 1 / 150;

  // 1. Continent field: positive is land.
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = ((i % w) + 0.5) * cellKm;
    const y = (Math.floor(i / w) + 0.5) * cellKm;
    // Domain warp breaks up blobby continents into peninsulas and bays.
    const qx = x + fbm(nW, x * fc * 1.3, y * fc * 1.3, 3) * maxDim * 0.18;
    const qy = y + fbm(nW, x * fc * 1.3 + 40, y * fc * 1.3 - 40, 3) * maxDim * 0.18;
    let v = fbm(nC, qx * fc, qy * fc, 6, 0.55);
    let e = Infinity;
    if (S.seaEdges.w) e = Math.min(e, x);
    if (S.seaEdges.e) e = Math.min(e, g.widthKm - x);
    if (S.seaEdges.n) e = Math.min(e, y);
    if (S.seaEdges.s) e = Math.min(e, g.heightKm - y);
    if (e < Infinity) v -= 0.9 * (1 - smoothstep(0, 0.16 * maxDim, e)) ** 1.5;
    c[i] = v;
  }
  const sorted = Float32Array.from(c).sort();
  const q = sorted[Math.min(n - 1, Math.max(0, Math.floor((1 - S.landFraction) * (n - 1))))];
  for (let i = 0; i < n; i++) c[i] -= q;

  // 2. Painted land and sea (plus implicit inlets/islands), softened and
  // domain-warped so painted coastlines come out ragged rather than brush-shaped.
  const landM = new Float32Array(n);
  const seaM = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = paintAt(doc.paint.landSea, g, i);
    if (p === LANDSEA.land) landM[i] = 1;
    else if (p === LANDSEA.sea) seaM[i] = 1;
  }
  // Implicit shapes are placed precisely for a town, so they are not warped.
  const impLandM = new Float32Array(n);
  const impSeaM = new Float32Array(n);
  for (const s of implicit.seaStrokes) {
    const f = polylineField(g, s.points, s.widthKm / 2);
    for (let i = 0; i < n; i++) if (f.d[i] < Infinity) impSeaM[i] = 1;
  }
  for (const b of implicit.landBlobs) {
    const f = polylineField(g, [b.pos], b.radiusKm);
    for (let i = 0; i < n; i++) if (f.d[i] < Infinity) impLandM[i] = 1;
  }
  const pr = Math.max(1, Math.round(3 / cellKm));
  const landB = boxBlur(landM, w, H, pr, 2);
  const seaB = boxBlur(seaM, w, H, pr, 2);
  const impLandB = boxBlur(impLandM, w, H, 1);
  const impSeaB = boxBlur(impSeaM, w, H, 1);

  // 3. Landform hints from paint and implicit circles.
  const plainsM = new Float32Array(n);
  const hillsM = new Float32Array(n);
  const mtnM = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = paintAt(doc.paint.landform, g, i);
    if (p === LANDFORM_PAINT.plains) plainsM[i] = 1;
    else if (p === LANDFORM_PAINT.hills) hillsM[i] = 1;
    else if (p === LANDFORM_PAINT.mountains) mtnM[i] = 1;
  }
  for (const lc of implicit.landformCircles) {
    const f = polylineField(g, [lc.pos], lc.radiusKm);
    const target = lc.kind === 'plains' ? plainsM : hillsM;
    for (let i = 0; i < n; i++) if (f.d[i] < Infinity) target[i] = 1;
  }
  const lr = Math.max(1, Math.round(6 / cellKm));
  const plainsW = boxBlur(plainsM, w, H, lr, 2);
  const hillsW = boxBlur(hillsM, w, H, lr, 2);
  const mtnW = boxBlur(mtnM, w, H, lr, 2);

  // 4. Ridges: user-drawn and implicit, combined with max so crossings don't stack.
  const ridgeH = new Float32Array(n);
  const ridgeP = new Float32Array(n);
  const allRidges: RidgeFeature[] = [...doc.ridges, ...implicit.ridges];
  allRidges.forEach((r, k) => {
    if (r.points.length === 0) return;
    const halfW = Math.max(r.widthKm / 2, cellKm * 1.5);
    const f = polylineField(g, r.points, halfW);
    for (let i = 0; i < n; i++) {
      const d = f.d[i];
      if (d === Infinity) continue;
      const t = d / halfW;
      const prof = (1 - t * t) ** 2;
      const endDist = Math.min(f.along[i], f.length - f.along[i]);
      const taper = f.length === 0 ? 1 : 0.5 + 0.5 * smoothstep(0, Math.min(halfW * 1.2, f.length / 2), endDist);
      const crest = r.heightM * (0.8 + 0.3 * nA(f.along[i] / 30, k * 7.7)) * taper;
      if (crest * prof > ridgeH[i]) ridgeH[i] = crest * prof;
      if (prof > ridgeP[i]) ridgeP[i] = prof;
    }
  });

  // A drawn river is land along its whole course, except where it meets the sea.
  const riverLand = new Float32Array(n);
  for (const rv of doc.rivers) {
    if (rv.points.length < 2) continue;
    const reach = rv.valleyWidthKm / 2 + Math.max(6, cellKm * 2);
    const f = polylineField(g, rv.points, reach);
    for (let i = 0; i < n; i++) {
      if (f.d[i] === Infinity) continue;
      const toMouth = f.length - f.along[i];
      const v = (1 - f.d[i] / reach) * smoothstep(0, reach, toMouth);
      if (v > riverLand[i]) riverLand[i] = v;
    }
  }

  // 5. Compose elevation.
  const M = S.mountainousness;
  const lo = 0.62 - 0.36 * M;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = ((i % w) + 0.5) * cellKm;
    const y = (Math.floor(i / w) + 0.5) * cellKm;
    const wx = nW(x / 60, y / 60) * 9;
    const wy = nW(x / 60 + 71, y / 60 - 33) * 9;
    let cc = c[i];
    const mL = sample(g, landB, [x + wx, y + wy]);
    const mS = sample(g, seaB, [x + wx, y + wy]);
    if (mL > 0) cc = lerp(cc, Math.max(cc, 0.18), Math.min(1, mL * 1.8));
    if (mS > 0) cc = lerp(cc, Math.min(cc, -0.22), Math.min(1, mS * 1.8));
    if (ridgeP[i] > 0) cc = Math.max(cc, 0.3 * ridgeP[i]);
    if (riverLand[i] > 0) cc = Math.max(cc, 0.1 * Math.min(1, riverLand[i] * 2));
    // Implicit inlets cut through anything, even ridges (a fjord).
    if (impSeaB[i] > 0) cc = lerp(cc, Math.min(cc, -0.22), Math.min(1, impSeaB[i] * 2));
    if (impLandB[i] > 0) cc = lerp(cc, Math.max(cc, 0.12), Math.min(1, impLandB[i] * 2));

    const landF = smoothstep(0, 0.06, cc);
    let mm = smoothstep(lo, lo + 0.2, (fbm(nM, x * fm, y * fm, 3) + 1) / 2);
    mm = lerp(mm, 1, mtnW[i]);
    mm = lerp(mm, Math.min(mm, 0.12), hillsW[i]);
    mm = lerp(mm, 0, plainsW[i]);
    const rid = ridged(nR, x * fr, y * fr, 5);
    const mtn = S.maxElevationM * 0.9 * mm * Math.pow(rid, 1.6);
    const detail = fbm(nD, x * fd, y * fd, 5);
    const hillAmp = (60 + 280 * S.roughness) * (1 - 0.85 * plainsW[i]) * (1 + 1.8 * hillsW[i]) + 300 * mm;
    const base = cc * (cc >= 0 ? 650 : 3000) + 30 * landF;
    const ridgeTerm = ridgeH[i] * (0.7 + 0.45 * rid);
    let v = base + landF * (detail * hillAmp * 0.6 + hillAmp * 0.3 * hillsW[i] + mtn + ridgeTerm);
    if (cc > 0) v = Math.max(v, 2 + cc * 40);
    out[i] = v;
  }
  return out;
}

/**
 * Blends locked terrain back in. Locked cells get their snapshot exactly;
 * a narrow band around them is eased toward it so there are no seams.
 */
export function applyLock(doc: WorldDoc, g: Grid, h: Float32Array): void {
  const snap = doc.lockHeights;
  if (!snap || snap.w !== g.w || snap.h !== g.h) return;
  const n = g.w * g.h;
  const lock = new Float32Array(n);
  const weighted = new Float32Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    if (paintAt(doc.paint.lock, g, i)) {
      lock[i] = 1;
      weighted[i] = snap.data[i];
      any = true;
    }
  }
  if (!any) return;
  const r = Math.max(2, Math.round(6 / g.cellKm));
  const lb = boxBlur(lock, g.w, g.h, r);
  const wb = boxBlur(weighted, g.w, g.h, r);
  for (let i = 0; i < n; i++) {
    if (lock[i]) h[i] = snap.data[i];
    else if (lb[i] > 0.001) {
      const avg = wb[i] / lb[i];
      h[i] = lerp(h[i], avg, Math.min(1, lb[i] * 1.6) * 0.85);
    }
  }
}

/**
 * Adds gentle bends between the clicked points of a hand-drawn river, so a
 * two-click river isn't ruler-straight. The bends vanish at every vertex, so
 * the course still passes exactly through each point the user placed.
 */
export function meander(pts: Vec[], seed: number, cellKm: number): Vec[] {
  const out: Vec[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.round(L / cellKm));
    const amp = L < cellKm * 4 ? 0 : Math.min(L * 0.06, 7);
    const nx = -(b[1] - a[1]) / (L || 1);
    const ny = (b[0] - a[0]) / (L || 1);
    const ph = ((seed + i * 977) % 1000) / 159;
    const waves = Math.max(1, Math.round(L / 45));
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const off = amp * Math.sin(Math.PI * t) * (0.7 * Math.sin(2 * Math.PI * waves * t + ph) + 0.3 * Math.sin(5.3 * Math.PI * waves * t + ph * 2));
      out.push([a[0] + (b[0] - a[0]) * t + nx * off, a[1] + (b[1] - a[1]) * t + ny * off]);
    }
  }
  return out;
}

export interface CarveResult {
  paths: number[][];
  warnings: string[];
}

/**
 * Cuts each river's course into the terrain so it runs strictly downhill
 * from source to mouth. Where the course climbs, it carves a gorge instead
 * (a water gap), and reports it, since a river crossing a ridge is unusual.
 */
export function carveRivers(g: Grid, h: Float32Array, rivers: RiverFeature[], ridges: RidgeFeature[]): CarveResult {
  const paths: number[][] = [];
  const warnings: string[] = [];
  for (const rv of rivers) {
    if (rv.points.length < 2) continue;
    let cells = rasterizePolyline(g, meander(rv.points, hashString(rv.id), g.cellKm));
    if (cells.length < 2) continue;
    const first = cells[0];
    const last = cells[cells.length - 1];
    // Drawn order is source → mouth, unless it plainly starts in the sea.
    if (h[first] < 0 && h[last] >= 0) cells.reverse();
    while (cells.length && h[cells[0]] < 0) cells.shift();
    const seaAt = cells.findIndex((c) => h[c] < 0);
    if (seaAt >= 0) cells = cells.slice(0, seaAt);
    if (cells.length < 2) continue;

    const depth = Math.min(80, 6 + rv.valleyWidthKm * 4);
    const z = new Float64Array(cells.length);
    let maxCut = 0;
    let cutAt = 0;
    for (let i = 0; i < cells.length; i++) {
      const floor = 0.5 + 0.01 * (cells.length - i);
      const want = h[cells[i]] - depth;
      const v = i === 0 ? want : Math.min(z[i - 1] - 0.5, want);
      z[i] = Math.max(v, floor);
      if (h[cells[i]] - z[i] > maxCut) {
        maxCut = h[cells[i]] - z[i];
        cutAt = cells[i];
      }
    }

    const W = Math.max(rv.valleyWidthKm / 2, g.cellKm * 1.2);
    const R = Math.ceil(W / g.cellKm);
    const orig = h.slice();
    for (let k = 0; k < cells.length; k++) {
      const c = cells[k];
      const cx = c % g.w;
      const cy = Math.floor(c / g.w);
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= g.w || y >= g.h) continue;
          const i = y * g.w + x;
          if (orig[i] < 0) continue;
          const dd = Math.hypot(dx, dy) * g.cellKm;
          if (dd > W || orig[i] <= z[k]) continue;
          const target = z[k] + (orig[i] - z[k]) * Math.pow(dd / W, 1.3);
          if (target < h[i]) h[i] = Math.max(target, 0.5);
        }
      }
    }
    for (let k = 0; k < cells.length; k++) h[cells[k]] = z[k];
    paths.push(cells);

    if (maxCut > 250) {
      const crossed = ridges.find((r) => {
        if (r.points.length === 0) return false;
        const f = polylineField(g, r.points, r.widthKm * 0.3);
        return cells.some((ci) => f.d[ci] < Infinity);
      });
      const where = `${Math.round(((cutAt % g.w) + 0.5) * g.cellKm)}, ${Math.round((Math.floor(cutAt / g.w) + 0.5) * g.cellKm)} km`;
      warnings.push(
        crossed
          ? `River "${rv.name}" crosses ridge "${crossed.name}" — carved a gorge (water gap) near ${where}. Move one of them if that's not intended.`
          : `River "${rv.name}" climbs over high ground — carved a ${Math.round(maxCut)} m gorge near ${where}.`,
      );
    }
  }
  return { paths, warnings };
}

/**
 * Drains any closed basin that a town sits in by cutting its outlet down to
 * the town's level, so fixed towns never end up underwater in a lake.
 */
export function breachAt(g: Grid, h: Float32Array, cells: number[], drainage: { recv: Int32Array; filled: Float64Array }): void {
  for (const t of cells) {
    if (h[t] < 0 || drainage.filled[t] - h[t] < 1) continue;
    let z = h[t];
    let c = drainage.recv[t];
    for (let steps = 0; c >= 0 && h[c] >= 0 && steps < g.w * g.h; steps++) {
      z = Math.min(z - 0.01, h[c]);
      h[c] = Math.max(z, 0.5);
      c = drainage.recv[c];
    }
  }
}
