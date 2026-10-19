// Sub-cell terrain for zoomed-in views. The engine works on a coarse grid
// (a few km per cell on a continent-sized map), so when a cell covers many
// screen pixels this module fills in plausible detail: smooth bicubic
// interpolation of the engine's fields plus fractal noise whose amplitude
// follows the local relief. Everything is a pure function of world position,
// so tiles rendered separately (and at different zoom levels) agree at their
// seams, and the result never contradicts the engine at the cell scale.
//
// No DOM here: tiles are rendered in web workers (tileWorker.ts).

import { boxBlur } from '../engine/grid';
import { makeNoise2D, type Noise2D } from '../engine/noise';
import { LANDFORM, WATER, type WorldResult } from '../engine/types';

/** Plain arrays that can be posted to a worker. */
export interface DetailData {
  w: number;
  h: number;
  cellKm: number;
  /** Land surface (m); ocean is 0 so interpolation doesn't dip at the coast. */
  height: Float32Array;
  /** Signed km to the coast, positive on land. */
  coast: Float32Array;
  /** Lake indicator, blurred one cell. */
  lake: Float32Array;
  /** 1 where a lake is within a few cells; lets most pixels skip the lake test. */
  nearLake: Uint8Array;
  /** Amplitude (m) of the first sub-cell noise octave. */
  amp: Float32Array;
  /** 0 smooth .. 1 craggy: mixes ridged noise into the detail. */
  rugged: Float32Array;
  /** Landform tint per cell, RGB. */
  landformRGB: Uint8Array;
}

export const LANDFORM_COLORS: Record<number, string> = {
  [LANDFORM.plain]: '#e9dc8a',
  [LANDFORM.valley]: '#8fcf8a',
  [LANDFORM.hills]: '#e2a95e',
  [LANDFORM.mountains]: '#a8704f',
  [LANDFORM.plateau]: '#c49ad6',
};

export function buildDetailData(r: WorldResult): DetailData {
  const { w, h, cellKm } = r.grid;
  const n = w * h;
  const height = new Float32Array(n);
  const lakeI = new Float32Array(n);
  const riverI = new Float32Array(n);
  const rug = new Float32Array(n);
  const lf = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    height[i] = r.water[i] === WATER.ocean ? 0 : Math.max(0, r.height[i]);
    lakeI[i] = r.water[i] === WATER.lake ? 1 : 0;
    riverI[i] = r.river[i] && r.water[i] === WATER.land ? 1 : 0;
    const l = r.landform[i];
    rug[i] = l === LANDFORM.mountains ? 1 : l === LANDFORM.hills ? 0.45 : l === LANDFORM.plateau ? 0.3 : 0;
    const hex = LANDFORM_COLORS[l];
    if (hex) for (let c = 0; c < 3; c++) lf[i * 3 + c] = parseInt(hex.slice(1 + c * 2, 3 + c * 2), 16);
  }
  // Relief across one cell sets how much there is to hide inside it.
  const amp = new Float32Array(n);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (r.water[i] !== WATER.land) continue;
      let m = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx;
          if (r.water[j] === WATER.land) m = Math.max(m, Math.abs(height[j] - height[i]));
        }
      amp[i] = 0.8 + 0.15 * m + 12 * rug[i] * Math.min(1, cellKm / 2);
    }
  const ampB = boxBlur(amp, w, h, 1);
  const riverB = boxBlur(riverI, w, h, 1);
  // Valley floors along rivers stay smooth, so rivers don't seem to climb.
  for (let i = 0; i < n; i++) ampB[i] *= 1 - 0.75 * Math.min(1, riverB[i] * 2.2);
  const lake = boxBlur(lakeI, w, h, 1);
  const nearLake = new Uint8Array(n);
  const lakeWide = boxBlur(lakeI, w, h, 3);
  for (let i = 0; i < n; i++) nearLake[i] = lakeWide[i] > 0 ? 1 : 0;
  return { w, h, cellKm, height, coast: r.coastDist, lake, nearLake, amp: ampB, rugged: boxBlur(rug, w, h, 1), landformRGB: lf };
}

// ---------------------------------------------------------------------------
// Sampling

function cr(p0: number, p1: number, p2: number, p3: number, t: number): number {
  return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
}

/** Catmull-Rom bicubic sample of a cell-centred field at km (x, y). */
export function bicubic(d: { w: number; h: number; cellKm: number }, f: ArrayLike<number>, x: number, y: number): number {
  const { w, h } = d;
  const fx = x / d.cellKm - 0.5;
  const fy = y / d.cellKm - 0.5;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = fx - ix;
  const ty = fy - iy;
  const row = (yy: number) => {
    const r = Math.min(h - 1, Math.max(0, yy)) * w;
    const a = f[r + Math.min(w - 1, Math.max(0, ix - 1))];
    const b = f[r + Math.min(w - 1, Math.max(0, ix))];
    const c = f[r + Math.min(w - 1, Math.max(0, ix + 1))];
    const e = f[r + Math.min(w - 1, Math.max(0, ix + 2))];
    return cr(a, b, c, e, tx);
  };
  return cr(row(iy - 1), row(iy), row(iy + 1), row(iy + 2), ty);
}

function bilinear(d: { w: number; h: number; cellKm: number }, f: ArrayLike<number>, x: number, y: number): number {
  const fx = Math.min(d.w - 1.001, Math.max(0, x / d.cellKm - 0.5));
  const fy = Math.min(d.h - 1.001, Math.max(0, y / d.cellKm - 0.5));
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = fx - ix;
  const ty = fy - iy;
  const i = iy * d.w + ix;
  return (f[i] * (1 - tx) + f[i + 1] * tx) * (1 - ty) + (f[i + d.w] * (1 - tx) + f[i + d.w + 1] * tx) * ty;
}

function cellOf(d: DetailData, x: number, y: number): number {
  const cx = Math.min(d.w - 1, Math.max(0, Math.floor(x / d.cellKm)));
  const cy = Math.min(d.h - 1, Math.max(0, Math.floor(y / d.cellKm)));
  return cy * d.w + cx;
}

/**
 * The detailed terrain. `pxKm` is the finest feature size worth computing
 * (about a screen pixel); coarser views get fewer noise octaves.
 */
export class DetailField {
  readonly d: DetailData;
  private nH: Noise2D;
  private nC: Noise2D;

  constructor(d: DetailData) {
    this.d = d;
    this.nH = makeNoise2D(70123);
    this.nC = makeNoise2D(70457);
  }

  /** Noise octaves from the cell size down to ~2 px. */
  octaves(pxKm: number, startKm: number): number {
    return Math.max(0, Math.min(9, Math.ceil(Math.log2(startKm / (2.5 * pxKm))) + 1));
  }

  height(x: number, y: number, pxKm: number): number {
    const d = this.d;
    const base = bicubic(d, d.height, x, y);
    const amp0 = bilinear(d, d.amp, x, y);
    const oct = this.octaves(pxKm, d.cellKm);
    if (amp0 < 0.5 || oct === 0) return Math.max(0, base);
    const rug = bilinear(d, d.rugged, x, y);
    let sum = 0;
    let amp = amp0;
    let lam = d.cellKm;
    for (let o = 0; o < oct; o++) {
      const v = this.nH(x / lam + o * 19.1, y / lam - o * 7.3);
      // Ridged noise gives crests and gullies in rough country.
      // Bumps under ~150 m are too small to matter on any map; fade them.
      const fine = lam < 0.15 ? lam / 0.15 : 1;
      sum += amp * fine * ((1 - rug) * v + rug * (0.85 - 1.7 * Math.abs(v)));
      // Falls off faster than the wavelength, so slopes come mostly from
      // the larger shapes and close-ups don't look like orange peel.
      amp *= 0.4;
      lam *= 0.5;
    }
    return Math.max(0, base + sum);
  }

  /**
   * Where to draw a river point. Flow routing across flats gives ruler-
   * straight reaches; a smooth warp of the plane bends them. It's a function
   * of position alone, so a tributary still meets its main stem, and it
   * fades out in steep country where the river must keep to its valley.
   */
  riverWarp(x: number, y: number): [number, number] {
    const d = this.d;
    const lam = d.cellKm * 5;
    const flat = Math.max(0.1, 1 - bilinear(d, d.amp, x, y) / 25);
    const a = 0.7 * d.cellKm * flat;
    return [x + a * this.nC(x / lam + 300, y / lam), y + a * this.nC(x / lam, y / lam - 300)];
  }

  /** Signed km to the sea, positive on land; ragged below the cell scale. */
  sea(x: number, y: number, pxKm: number): number {
    const d = this.d;
    const k = d.cellKm;
    const base = bicubic(d, d.coast, x, y);
    if (base > 2.2 * k || base < -2.2 * k) return base;
    return base + this.ragged(x, y, pxKm, 0.4 * k, 0);
  }

  /** Signed distance-like value for lakes, positive on dry land. */
  lake(x: number, y: number, pxKm: number): number {
    const d = this.d;
    if (!d.nearLake[cellOf(d, x, y)]) return 1;
    const v = (0.5 - bicubic(d, d.lake, x, y)) * 2 * d.cellKm;
    if (v > 1.5 * d.cellKm) return v;
    return v + this.ragged(x, y, pxKm, 0.25 * d.cellKm, 500);
  }

  private ragged(x: number, y: number, pxKm: number, amp0: number, off: number): number {
    const k = this.d.cellKm;
    const oct = this.octaves(pxKm, k * 1.5);
    let s = 0;
    let amp = amp0;
    let lam = k * 1.5;
    for (let o = 0; o < oct; o++) {
      s += amp * this.nC(x / lam + o * 11.7 + off, y / lam + o * 3.1 - off);
      amp *= 0.55;
      lam *= 0.5;
    }
    return s;
  }
}

// ---------------------------------------------------------------------------
// Tile rendering

export const TILE = 256;

export interface TileFlags {
  relief: boolean;
  tint: boolean;
  landforms: boolean;
}

export interface TileRequest {
  z: number;
  tx: number;
  ty: number;
  /** Device pixels per CSS pixel the tile is rendered for (sets line spacing). */
  dpr: number;
  flags: TileFlags;
}

export interface TileOutput {
  rgba: Uint8ClampedArray<ArrayBuffer>;
  /** Line segments in km, as x0,y0,x1,y1 runs. */
  coast: Float32Array;
  lake: Float32Array;
  ripples: Float32Array[];
  minor: Float32Array;
  major: Float32Array;
  interval: number;
}

export function tilePxKm(z: number): number {
  return 1 / 2 ** z;
}
export function tileKm(z: number): number {
  return TILE / 2 ** z;
}

const NICE_M = [2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];
export function nice(v: number, steps = NICE_M): number {
  for (const s of steps) if (s >= v) return s;
  return steps[steps.length - 1];
}

/** Contour interval (m) for a zoom of `kCss` CSS pixels per km. */
export function contourInterval(kCss: number): number {
  return nice(160 / Math.pow(Math.max(kCss, 0.01), 0.55));
}

const SEA = [200, 216, 218];
const LAKE = [186, 210, 220];
const RAMP: [number, number[]][] = [
  [0, [228, 230, 196]],
  [300, [236, 232, 200]],
  [800, [232, 218, 182]],
  [1500, [214, 192, 160]],
  [2300, [206, 190, 176]],
  [3200, [246, 244, 240]],
];
export function elevationColor(h: number, out: number[] = [0, 0, 0]): number[] {
  for (let k = 1; k < RAMP.length; k++) {
    if (h <= RAMP[k][0]) {
      const t = Math.max(0, (h - RAMP[k - 1][0]) / (RAMP[k][0] - RAMP[k - 1][0]));
      for (let c = 0; c < 3; c++) out[c] = RAMP[k - 1][1][c] + (RAMP[k][1][c] - RAMP[k - 1][1][c]) * t;
      return out;
    }
  }
  for (let c = 0; c < 3; c++) out[c] = RAMP[RAMP.length - 1][1][c];
  return out;
}
export function seaColor(depthKm: number, cellKm: number, out: number[] = [0, 0, 0]): number[] {
  const deep = Math.min(1, depthKm / (cellKm * 24));
  for (let c = 0; c < 3; c++) out[c] = SEA[c] - 14 * deep;
  return out;
}
export { LAKE as LAKE_RGB };

/**
 * Light from the north-west. `sx`, `sy` are slopes (rise over run). Shared by
 * the coarse base raster and tiles so they shade alike.
 */
export function hillshade(sx: number, sy: number): number {
  const nl = Math.hypot(sx, sy, 2);
  const d = (0.55 * sx + 0.55 * sy + 2 * 0.63) / nl;
  return Math.max(0.62, Math.min(1.08, 0.38 + 0.72 * d));
}

export function renderTile(field: DetailField, req: TileRequest): TileOutput {
  const d = field.d;
  const pxKm = tilePxKm(req.z);
  const N = TILE + 2; // one-sample border for gradients and seamless contours
  const x0 = req.tx * tileKm(req.z);
  const y0 = req.ty * tileKm(req.z);
  const sx = (i: number) => x0 + (i - 0.5) * pxKm; // sample i ↔ pixel i-1
  const sy = (j: number) => y0 + (j - 0.5) * pxKm;
  const hgt = new Float32Array(N * N);
  const sea = new Float32Array(N * N);
  const lake = new Float32Array(N * N);
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const x = sx(i);
      const y = sy(j);
      const k = j * N + i;
      sea[k] = field.sea(x, y, pxKm);
      lake[k] = field.lake(x, y, pxKm);
      hgt[k] = sea[k] < 0 ? 0 : field.height(x, y, pxKm);
    }

  // Hillshade exaggeration eases off as we zoom in, or detail looks harsh.
  const zoomIn = Math.min(1, Math.max(0.3, Math.pow(pxKm / 0.4, 0.3)));
  const ex = (7 * zoomIn) / (2 * pxKm * 1000);
  const rgba = new Uint8ClampedArray(TILE * TILE * 4);
  const col = [0, 0, 0];
  for (let j = 1; j <= TILE; j++)
    for (let i = 1; i <= TILE; i++) {
      const k = j * N + i;
      const x = sx(i);
      const y = sy(j);
      if (sea[k] < 0) seaColor(-sea[k], d.cellKm, col);
      else if (lake[k] < 0) {
        col[0] = LAKE[0];
        col[1] = LAKE[1];
        col[2] = LAKE[2];
      } else {
        const h = hgt[k];
        if (req.flags.tint) elevationColor(h, col);
        else {
          col[0] = 242;
          col[1] = 234;
          col[2] = 214;
        }
        if (req.flags.landforms) {
          const c = cellOf(d, x, y) * 3;
          if (d.landformRGB[c] | d.landformRGB[c + 1] | d.landformRGB[c + 2])
            for (let c2 = 0; c2 < 3; c2++) col[c2] += (d.landformRGB[c + c2] - col[c2]) * 0.55;
        }
        if (req.flags.relief) {
          const s = hillshade((hgt[k + 1] - hgt[k - 1]) * ex, (hgt[k + N] - hgt[k - N]) * ex);
          col[0] *= s;
          col[1] *= s;
          col[2] *= s;
        }
      }
      const o = ((j - 1) * TILE + (i - 1)) * 4;
      rgba[o] = col[0];
      rgba[o + 1] = col[1];
      rgba[o + 2] = col[2];
      rgba[o + 3] = 255;
    }

  // Vector lines run over a lattice of every second sample, starting at
  // sample 0 (half a pixel outside the tile), so neighbouring tiles' lattices
  // join without overlap.
  const kCss = 2 ** req.z / req.dpr;
  const interval = contourInterval(kCss);
  const S = 2;
  const M = TILE / S + 1;
  const pick = (src: Float32Array) => {
    const out = new Float32Array(M * M);
    for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) out[j * M + i] = src[j * S * N + i * S];
    return out;
  };
  // Contours follow a smoother surface than the shading, without the finest
  // octaves, so they read as landforms rather than noise.
  const hL = new Float32Array(M * M);
  for (let j = 0; j < M; j++)
    for (let i = 0; i < M; i++) {
      const k = j * S * N + i * S;
      hL[j * M + i] = sea[k] < 0 ? 0 : field.height(sx(i * S), sy(j * S), pxKm * 6);
    }
  const sL = pick(sea);
  const lL = pick(lake);
  const lat = { w: M, h: M, x0: sx(0), y0: sy(0), step: S * pxKm };
  const wet = (i: number) => sL[i] < 0 || lL[i] < 0;
  const coast: number[] = [];
  const lakeSeg: number[] = [];
  marching(lat, sL, 0, coast);
  marching(lat, lL, 0, lakeSeg, (i) => sL[i] < 0);
  const ripples: Float32Array[] = [];
  for (let r = 1; r <= 3; r++) {
    const seg: number[] = [];
    marching(lat, sL, -(5 + 5 * r) * (pxKm * req.dpr) * 1.0, seg);
    ripples.push(Float32Array.from(seg));
  }
  const minor: number[] = [];
  const major: number[] = [];
  let hMin = Infinity;
  let hMax = -Infinity;
  for (const v of hL) {
    hMin = Math.min(hMin, v);
    hMax = Math.max(hMax, v);
  }
  // Drop minor contours where they'd crowd closer than ~4 CSS px.
  const tooSteep = (i: number) => {
    const gx = (hL[i + 1] - hL[i]) / lat.step;
    const gy = (hL[i + M] - hL[i]) / lat.step;
    const perPx = Math.hypot(gx, gy) * (pxKm * req.dpr); // m per CSS px
    return interval / Math.max(perPx, 1e-6) < 4;
  };
  for (let lv = Math.ceil(Math.max(hMin, 1) / interval) * interval; lv < hMax; lv += interval) {
    const isMajor = Math.round(lv / interval) % 5 === 0;
    if (isMajor) marching(lat, hL, lv, major, wet);
    else marching(lat, hL, lv, minor, (i) => wet(i) || tooSteep(i));
  }
  return {
    rgba,
    coast: Float32Array.from(coast),
    lake: Float32Array.from(lakeSeg),
    ripples,
    minor: Float32Array.from(minor),
    major: Float32Array.from(major),
    interval,
  };
}

interface Lattice {
  w: number;
  h: number;
  x0: number;
  y0: number;
  step: number;
}

/**
 * Marching squares over lattice cells (0..w-2, 0..h-2), appending segments
 * as x0,y0,x1,y1. `skip(i)` (by the cell's top-left sample) suppresses a cell.
 */
export function marching(L: Lattice, f: ArrayLike<number>, level: number, out: number[], skip?: (i: number) => boolean) {
  const { w, h, step } = L;
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const i = y * w + x;
      const a = f[i];
      const b = f[i + 1];
      const c = f[i + w + 1];
      const e = f[i + w];
      const idx = (a > level ? 8 : 0) | (b > level ? 4 : 0) | (c > level ? 2 : 0) | (e > level ? 1 : 0);
      if (idx === 0 || idx === 15) continue;
      if (skip && skip(i)) continue;
      const X = L.x0 + x * step;
      const Y = L.y0 + y * step;
      const t = (p: number, q: number) => (level - p) / (q - p);
      const top = () => [X + t(a, b) * step, Y];
      const right = () => [X + step, Y + t(b, c) * step];
      const bottom = () => [X + t(e, c) * step, Y + step];
      const left = () => [X, Y + t(a, e) * step];
      const seg = (p: number[], q: number[]) => out.push(p[0], p[1], q[0], q[1]);
      const center = (a + b + c + e) / 4 > level;
      switch (idx) {
        case 1:
        case 14:
          seg(left(), bottom());
          break;
        case 2:
        case 13:
          seg(bottom(), right());
          break;
        case 3:
        case 12:
          seg(left(), right());
          break;
        case 4:
        case 11:
          seg(top(), right());
          break;
        case 6:
        case 9:
          seg(top(), bottom());
          break;
        case 7:
        case 8:
          seg(left(), top());
          break;
        case 5:
          if (center) {
            seg(left(), top());
            seg(bottom(), right());
          } else {
            seg(top(), right());
            seg(left(), bottom());
          }
          break;
        case 10:
          if (center) {
            seg(top(), right());
            seg(left(), bottom());
          } else {
            seg(left(), top());
            seg(bottom(), right());
          }
          break;
      }
    }
  }
}
