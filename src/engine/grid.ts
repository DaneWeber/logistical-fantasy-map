import type { Grid, Vec } from './types';

export const DX8 = [1, 1, 0, -1, -1, -1, 0, 1];
export const DY8 = [0, 1, 1, 1, 0, -1, -1, -1];
export const DIST8 = [1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2];

export function makeGrid(widthKm: number, heightKm: number, resolution: number): Grid {
  const w = Math.max(16, Math.round(resolution));
  const cellKm = widthKm / w;
  const h = Math.max(16, Math.round(heightKm / cellKm));
  return { w, h, cellKm, widthKm, heightKm: h * cellKm };
}

export function cellCenter(g: Grid, i: number): Vec {
  return [((i % g.w) + 0.5) * g.cellKm, (Math.floor(i / g.w) + 0.5) * g.cellKm];
}

export function cellAt(g: Grid, p: Vec): number {
  const x = Math.min(g.w - 1, Math.max(0, Math.floor(p[0] / g.cellKm)));
  const y = Math.min(g.h - 1, Math.max(0, Math.floor(p[1] / g.cellKm)));
  return y * g.w + x;
}

export function dist(a: Vec, b: Vec): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** Bilinear sample of a cell-centred field at a km position. */
export function sample(g: Grid, f: ArrayLike<number>, p: Vec): number {
  const fx = Math.min(g.w - 1.001, Math.max(0, p[0] / g.cellKm - 0.5));
  const fy = Math.min(g.h - 1.001, Math.max(0, p[1] / g.cellKm - 0.5));
  const x = Math.floor(fx);
  const y = Math.floor(fy);
  const tx = fx - x;
  const ty = fy - y;
  const i = y * g.w + x;
  const a = f[i] * (1 - tx) + f[i + 1] * tx;
  const b = f[i + g.w] * (1 - tx) + f[i + g.w + 1] * tx;
  return a * (1 - ty) + b * ty;
}

/** Separable box blur with clamped edges. Repeating it approximates a gaussian. */
export function boxBlur(src: ArrayLike<number>, w: number, h: number, r: number, passes = 1): Float32Array {
  let a = Float32Array.from(src as ArrayLike<number>);
  if (r < 1) return a;
  const tmp = new Float32Array(w * h);
  const n = 2 * r + 1;
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let s = 0;
      for (let k = -r; k <= r; k++) s += a[row + Math.min(w - 1, Math.max(0, k))];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = s / n;
        s += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
      }
    }
    const out = new Float32Array(w * h);
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = s / n;
        s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
      }
    }
    a = out;
  }
  return a;
}

/** Max (or min) over a square window of radius r, separably. */
export function windowExtreme(src: ArrayLike<number>, w: number, h: number, r: number, max: boolean): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const pick = max ? Math.max : Math.min;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = src[y * w + x];
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) v = pick(v, src[y * w + k]);
      tmp[y * w + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = tmp[y * w + x];
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) v = pick(v, tmp[k * w + x]);
      out[y * w + x] = v;
    }
  }
  return out;
}

/** Grows a 0/1 mask by r cells (square neighbourhood). */
export function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return mask.slice();
  const e = windowExtreme(mask, w, h, r, true);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = e[i] > 0 ? 1 : 0;
  return out;
}

/** Chamfer distance (km) from every cell to the nearest cell where `mask` is set. */
export function distanceTo(g: Grid, mask: Uint8Array): Float32Array {
  const { w, h } = g;
  const d = new Float32Array(w * h).fill(1e9);
  for (let i = 0; i < d.length; i++) if (mask[i]) d[i] = 0;
  const a = 1;
  const b = Math.SQRT2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + a);
      if (y > 0) {
        v = Math.min(v, d[i - w] + a);
        if (x > 0) v = Math.min(v, d[i - w - 1] + b);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + b);
      }
      d[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (x < w - 1) v = Math.min(v, d[i + 1] + a);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + a);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + b);
        if (x > 0) v = Math.min(v, d[i + w - 1] + b);
      }
      d[i] = v;
    }
  }
  for (let i = 0; i < d.length; i++) d[i] *= g.cellKm;
  return d;
}

export function polylineLength(pts: Vec[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
  return L;
}

/**
 * Distance (km) from cells to a polyline, plus the arc-length position of the
 * nearest point. Only cells within maxKm are visited; others stay Infinity.
 */
export function polylineField(g: Grid, pts: Vec[], maxKm: number): { d: Float32Array; along: Float32Array; length: number } {
  const d = new Float32Array(g.w * g.h).fill(Infinity);
  const along = new Float32Array(g.w * g.h);
  let acc = 0;
  const segs = pts.length === 1 ? [[pts[0], pts[0]] as [Vec, Vec]] : [];
  for (let i = 1; i < pts.length; i++) segs.push([pts[i - 1], pts[i]]);
  for (const [a, b] of segs) {
    const len = dist(a, b);
    const x0 = Math.max(0, Math.floor((Math.min(a[0], b[0]) - maxKm) / g.cellKm));
    const x1 = Math.min(g.w - 1, Math.ceil((Math.max(a[0], b[0]) + maxKm) / g.cellKm));
    const y0 = Math.max(0, Math.floor((Math.min(a[1], b[1]) - maxKm) / g.cellKm));
    const y1 = Math.min(g.h - 1, Math.ceil((Math.max(a[1], b[1]) + maxKm) / g.cellKm));
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy || 1e-9;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px = (x + 0.5) * g.cellKm;
        const py = (y + 0.5) * g.cellKm;
        const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / l2));
        const dd = Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
        const i = y * g.w + x;
        if (dd < d[i] && dd <= maxKm) {
          d[i] = dd;
          along[i] = acc + t * len;
        }
      }
    }
    acc += len;
  }
  return { d, along, length: acc };
}

/** Ordered, 8-connected cells visited by a polyline, without repeats. */
export function rasterizePolyline(g: Grid, pts: Vec[]): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  const push = (c: number) => {
    if (out.length && out[out.length - 1] === c) return;
    if (seen.has(c)) {
      // Loops back over itself: cut the loop out so the path stays simple.
      const k = out.indexOf(c);
      for (const r of out.splice(k + 1)) seen.delete(r);
      return;
    }
    seen.add(c);
    out.push(c);
  };
  if (pts.length === 1) push(cellAt(g, pts[0]));
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]];
    const steps = Math.max(1, Math.ceil((dist(a, b) / g.cellKm) * 2));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      push(cellAt(g, [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]));
    }
  }
  return out;
}

export function isNeighbor8(g: Grid, a: number, b: number): boolean {
  const ax = a % g.w;
  const bx = b % g.w;
  const ay = Math.floor(a / g.w);
  const by = Math.floor(b / g.w);
  return Math.abs(ax - bx) <= 1 && Math.abs(ay - by) <= 1 && a !== b;
}

/** Chaikin corner cutting, keeping endpoints fixed. */
export function chaikin(pts: Vec[], iterations = 2): Vec[] {
  let p = pts;
  for (let it = 0; it < iterations && p.length > 2; it++) {
    const q: Vec[] = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const [a, b] = [p[i], p[i + 1]];
      if (i > 0) q.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]]);
      if (i < p.length - 2) q.push([0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
    }
    q.push(p[p.length - 1]);
    p = q;
  }
  return p;
}
