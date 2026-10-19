import { DIST8, DX8, DY8, boxBlur, cellCenter, chaikin, dilate, distanceTo, lengthScale, windowExtreme } from './grid';
import type { Hydrology } from './hydrology';
import { LANDFORM, WATER, type Grid, type Polyline, type SiteKind } from './types';

export const SITE_BIT: Record<SiteKind, number> = {
  river: 1,
  coast: 2,
  riverMouth: 4,
  confluence: 8,
  lakeshore: 16,
  ridge: 32,
  mountains: 64,
  hills: 128,
  valley: 256,
  plain: 512,
};

export function siteBits(sites: SiteKind[]): number {
  let b = 0;
  for (const s of sites) b |= SITE_BIT[s];
  return b;
}

export interface Analysis {
  surface: Float32Array;
  landform: Uint8Array;
  ridge: Uint8Array;
  ridgeLines: Polyline[];
  coastDist: Float32Array;
  siteMask: Uint16Array;
}

export function analyze(g: Grid, h: Float32Array, hy: Hydrology): Analysis {
  const { w, h: H, cellKm } = g;
  const n = w * H;

  const surface = new Float32Array(n);
  const landH = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    surface[i] = hy.water[i] === WATER.ocean ? h[i] : hy.filled[i];
    landH[i] = hy.water[i] === WATER.ocean ? 0 : surface[i];
  }

  // Landform from local relief and topographic position (height relative to
  // the neighbourhood mean): that is what distinguishes valley from plain.
  // Radii and relief thresholds shrink with the map (see lengthScale);
  // absolute elevations stay absolute.
  const ls = lengthScale(g.widthKm, g.heightKm);
  const rs = Math.sqrt(ls);
  const rS = Math.max(1, Math.round((5 * ls) / cellKm));
  const rL = Math.max(2, Math.round((14 * ls) / cellKm));
  const maxS = windowExtreme(landH, w, H, rS, true);
  const minS = windowExtreme(landH, w, H, rS, false);
  const maxL = windowExtreme(landH, w, H, rL, true);
  const minL = windowExtreme(landH, w, H, rL, false);
  const valleyDepth = twoSidedDepth(g, landH);
  const landform = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (hy.water[i] === WATER.ocean) {
      landform[i] = LANDFORM.ocean;
      continue;
    }
    if (hy.water[i] === WATER.lake) {
      landform[i] = LANDFORM.lake;
      continue;
    }
    const s = surface[i];
    const reliefS = maxS[i] - minS[i];
    const reliefL = maxL[i] - minL[i];
    if (valleyDepth[i] > Math.max(80 * rs, 0.25 * reliefL) && s < 1800) landform[i] = LANDFORM.valley;
    else if (s > 1400 || reliefS > 650 * rs || (s > 800 && reliefS > 300 * rs)) landform[i] = LANDFORM.mountains;
    else if (reliefS > 160 * rs || (s > 500 && reliefS > 100 * rs)) landform[i] = LANDFORM.hills;
    else if (s > 750) landform[i] = LANDFORM.plateau;
    else landform[i] = LANDFORM.plain;
  }

  // Ridge lines: follow steepest ascent from every cell and count how many
  // paths pass through each one. Ascent paths converge on crests the same way
  // descent paths converge on rivers, so heavily-used cells trace the ridges.
  const up = new Int32Array(n).fill(-1);
  const land: number[] = [];
  for (let i = 0; i < n; i++) {
    if (hy.water[i] !== WATER.land) continue;
    land.push(i);
    const x = i % w;
    const y = (i - x) / w;
    let best = -1;
    let bestS = 0;
    for (let d = 0; d < 8; d++) {
      const nx = x + DX8[d];
      const ny = y + DY8[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= H) continue;
      const nb = ny * w + nx;
      if (hy.water[nb] !== WATER.land) continue;
      const sl = (surface[nb] - surface[i]) / DIST8[d];
      if (sl > bestS) {
        bestS = sl;
        best = nb;
      }
    }
    up[i] = best;
  }
  land.sort((a, b) => surface[a] - surface[b]);
  const accUp = new Float32Array(n).fill(1);
  for (const c of land) if (up[c] >= 0) accUp[up[c]] += accUp[c];
  const T = Math.max(10, Math.round((220 * ls * ls) / (cellKm * cellKm)));
  const ridge = new Uint8Array(n);
  for (const c of land) {
    const lf = landform[c];
    if (accUp[c] >= T && surface[c] > 350 && (lf === LANDFORM.mountains || lf === LANDFORM.hills || lf === LANDFORM.plateau)) ridge[c] = 1;
  }
  const ridgeLines = traceRidges(g, ridge, up, surface);

  const ocean = new Uint8Array(n);
  const notOcean = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (hy.water[i] === WATER.ocean) ocean[i] = 1;
    else notOcean[i] = 1;
  }
  const dOcean = distanceTo(g, ocean);
  const dLand = distanceTo(g, notOcean);
  const coastDist = new Float32Array(n);
  for (let i = 0; i < n; i++) coastDist[i] = ocean[i] ? -dLand[i] : dOcean[i];

  const siteMask = buildSiteMask(g, hy, landform, ridge);
  return { surface, landform, ridge, ridgeLines, coastDist, siteMask };
}

/**
 * How far the ground rises on *both* sides of a cell, best over four axes and
 * two scales. A valley floor has high ground on either hand; a plain at the
 * foot of a mountain front only has it on one.
 */
function twoSidedDepth(g: Grid, landH: Float32Array): Float32Array {
  const { w, h: H, cellKm } = g;
  const ls = lengthScale(g.widthKm, g.heightKm);
  const sm = boxBlur(landH, w, H, Math.max(1, Math.round((2 * ls) / cellKm)));
  const out = new Float32Array(w * H);
  const axes = [
    [1, 0],
    [0, 1],
    [Math.SQRT1_2, Math.SQRT1_2],
    [Math.SQRT1_2, -Math.SQRT1_2],
  ];
  const scales = [8, 16].map((km) => Math.max(2, (km * ls) / cellKm));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const h0 = sm[i];
      let best = 0;
      for (const R of scales) {
        for (const [ax, ay] of axes) {
          // Highest point out to R on each side, so a narrow crest counts.
          let hiA = -Infinity;
          let hiB = -Infinity;
          for (let k = 1; k <= 4; k++) {
            const t = (R * k) / 4;
            const xa = Math.round(x + ax * t);
            const ya = Math.round(y + ay * t);
            const xb = Math.round(x - ax * t);
            const yb = Math.round(y - ay * t);
            if (xa >= 0 && ya >= 0 && xa < w && ya < H) hiA = Math.max(hiA, sm[ya * w + xa]);
            if (xb >= 0 && yb >= 0 && xb < w && yb < H) hiB = Math.max(hiB, sm[yb * w + xb]);
          }
          const d = Math.min(hiA, hiB) - h0;
          if (d > best) best = d;
        }
      }
      out[i] = best;
    }
  }
  return out;
}

function traceRidges(g: Grid, ridge: Uint8Array, up: Int32Array, surface: Float32Array): Polyline[] {
  const n = g.w * g.h;
  const hasDonor = new Uint8Array(n);
  for (let c = 0; c < n; c++) if (ridge[c] && up[c] >= 0 && ridge[up[c]]) hasDonor[up[c]] = 1;
  const tails: number[] = [];
  for (let c = 0; c < n; c++) if (ridge[c] && !hasDonor[c]) tails.push(c);
  tails.sort((a, b) => surface[a] - surface[b]);
  const visited = new Uint8Array(n);
  const lines: Polyline[] = [];
  for (const t of tails) {
    const cells = [t];
    visited[t] = 1;
    let c = t;
    while (up[c] >= 0 && ridge[up[c]]) {
      const u = up[c];
      cells.push(u);
      if (visited[u]) break;
      visited[u] = 1;
      c = u;
    }
    if (cells.length >= 3) lines.push({ pts: chaikin(cells.map((ci) => cellCenter(g, ci)), 2) });
  }
  return lines;
}

function buildSiteMask(g: Grid, hy: Hydrology, landform: Uint8Array, ridge: Uint8Array): Uint16Array {
  const { w, h: H, cellKm } = g;
  const n = w * H;
  const base: Record<SiteKind, Uint8Array> = {
    river: new Uint8Array(n),
    coast: new Uint8Array(n),
    riverMouth: new Uint8Array(n),
    confluence: new Uint8Array(n),
    lakeshore: new Uint8Array(n),
    ridge,
    mountains: new Uint8Array(n),
    hills: new Uint8Array(n),
    valley: new Uint8Array(n),
    plain: new Uint8Array(n),
  };
  const donors = new Uint8Array(n);
  for (let c = 0; c < n; c++) {
    const r = hy.recv[c];
    if (hy.river[c] && hy.water[c] === WATER.land && r >= 0 && hy.river[r]) donors[r]++;
  }
  for (let i = 0; i < n; i++) {
    if (hy.water[i] !== WATER.land) continue;
    const x = i % w;
    const y = (i - x) / w;
    let nearOcean = false;
    let nearLake = false;
    for (let d = 0; d < 8; d++) {
      const nx = x + DX8[d];
      const ny = y + DY8[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= H) continue;
      const nb = ny * w + nx;
      if (hy.water[nb] === WATER.ocean) nearOcean = true;
      if (hy.water[nb] === WATER.lake) nearLake = true;
    }
    if (hy.river[i]) base.river[i] = 1;
    if (nearOcean) base.coast[i] = 1;
    if (nearLake) base.lakeshore[i] = 1;
    if (hy.river[i] && (nearOcean || (hy.recv[i] >= 0 && hy.water[hy.recv[i]] === WATER.ocean))) base.riverMouth[i] = 1;
    if (hy.river[i] && donors[i] >= 2) base.confluence[i] = 1;
    const lf = landform[i];
    if (lf === LANDFORM.mountains) base.mountains[i] = 1;
    else if (lf === LANDFORM.hills) base.hills[i] = 1;
    else if (lf === LANDFORM.valley) base.valley[i] = 1;
    else if (lf === LANDFORM.plain) base.plain[i] = 1;
  }
  // Towns are points next to features, not on them: allow a little slack.
  const near = Math.max(1, Math.ceil(2.5 / cellKm));
  const nearish = Math.max(1, Math.ceil(6 / cellKm));
  const radius: Record<SiteKind, number> = {
    river: near,
    coast: near,
    riverMouth: nearish,
    confluence: nearish,
    lakeshore: near,
    ridge: near,
    mountains: 0,
    hills: 0,
    valley: near,
    plain: 0,
  };
  const mask = new Uint16Array(n);
  for (const k of Object.keys(base) as SiteKind[]) {
    const m = dilate(base[k], w, H, radius[k]);
    const bit = SITE_BIT[k];
    for (let i = 0; i < n; i++) if (m[i] && hy.water[i] === WATER.land) mask[i] |= bit;
  }
  return mask;
}
