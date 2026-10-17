import { DIST8, DX8, DY8, chaikin, cellCenter, isNeighbor8 } from './grid';
import { WATER, type Grid, type Polyline } from './types';

/** Binary min-heap of cell indices keyed by elevation. */
class Heap {
  private keys: Float64Array;
  private vals: Int32Array;
  size = 0;
  constructor(cap: number) {
    this.keys = new Float64Array(cap);
    this.vals = new Int32Array(cap);
  }
  push(v: number, k: number) {
    let i = this.size++;
    const { keys, vals } = this;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= k) break;
      keys[i] = keys[p];
      vals[i] = vals[p];
      i = p;
    }
    keys[i] = k;
    vals[i] = v;
  }
  pop(): number {
    const { keys, vals } = this;
    const top = vals[0];
    const k = keys[--this.size];
    const v = vals[this.size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && keys[c + 1] < keys[c]) c++;
      if (keys[c] >= k) break;
      keys[i] = keys[c];
      vals[i] = vals[c];
      i = c;
    }
    keys[i] = k;
    vals[i] = v;
    return top;
  }
}

/**
 * Ocean = below-sea-level regions that touch the map edge or are large.
 * Small below-sea-level pockets inland are treated as land depressions.
 */
export function detectOcean(g: Grid, h: ArrayLike<number>): Uint8Array {
  const { w, h: H } = g;
  const n = w * H;
  const ocean = new Uint8Array(n);
  const comp = new Int32Array(n).fill(-1);
  const minSize = Math.max(60, Math.round(n * 0.003));
  const stack: number[] = [];
  let id = 0;
  for (let s = 0; s < n; s++) {
    if (h[s] >= 0 || comp[s] >= 0) continue;
    const members: number[] = [];
    let touchesEdge = false;
    comp[s] = id;
    stack.push(s);
    while (stack.length) {
      const c = stack.pop()!;
      members.push(c);
      const x = c % w;
      const y = (c - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === H - 1) touchesEdge = true;
      for (let k = 0; k < 8; k += 2) {
        const nx = x + DX8[k];
        const ny = y + DY8[k];
        if (nx < 0 || ny < 0 || nx >= w || ny >= H) continue;
        const nb = ny * w + nx;
        if (h[nb] < 0 && comp[nb] < 0) {
          comp[nb] = id;
          stack.push(nb);
        }
      }
    }
    if (touchesEdge || members.length >= minSize) for (const c of members) ocean[c] = 1;
    id++;
  }
  return ocean;
}

export interface Drainage {
  filled: Float64Array;
  recv: Int32Array;
  /** Cells from downstream to upstream (receivers always come first). */
  order: Int32Array;
}

const EPS = 1e-3;

/**
 * Priority-flood depression filling (Barnes et al. 2014) with an epsilon
 * gradient, so every land cell has a strictly lower receiver and all water
 * reaches the ocean or the map edge. Receivers are then re-chosen as the
 * steepest strictly-lower neighbour, which keeps the graph acyclic.
 */
export function drain(g: Grid, h: ArrayLike<number>, ocean: Uint8Array): Drainage {
  const { w, h: H } = g;
  const n = w * H;
  const filled = new Float64Array(n);
  const recv = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const order = new Int32Array(n);
  const heap = new Heap(n);
  for (let i = 0; i < n; i++) {
    const x = i % w;
    const y = (i - x) / w;
    const edge = x === 0 || y === 0 || x === w - 1 || y === H - 1;
    if (ocean[i] || edge) {
      closed[i] = 1;
      filled[i] = h[i];
      heap.push(i, h[i]);
    }
  }
  let k = 0;
  while (heap.size) {
    const c = heap.pop();
    order[k++] = c;
    const x = c % w;
    const y = (c - x) / w;
    for (let d = 0; d < 8; d++) {
      const nx = x + DX8[d];
      const ny = y + DY8[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= H) continue;
      const nb = ny * w + nx;
      if (closed[nb]) continue;
      closed[nb] = 1;
      filled[nb] = Math.max(h[nb], filled[c] + EPS * DIST8[d]);
      recv[nb] = c;
      heap.push(nb, filled[nb]);
    }
  }
  for (let i = 0; i < n; i++) {
    if (recv[i] < 0) continue;
    const x = i % w;
    const y = (i - x) / w;
    let best = recv[i];
    let bestSlope = (filled[i] - filled[best]) / (isDiag(g, i, best) ? Math.SQRT2 : 1);
    for (let d = 0; d < 8; d++) {
      const nx = x + DX8[d];
      const ny = y + DY8[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= H) continue;
      const nb = ny * w + nx;
      const s = (filled[i] - filled[nb]) / DIST8[d];
      if (filled[nb] < filled[i] && s > bestSlope) {
        bestSlope = s;
        best = nb;
      }
    }
    recv[i] = best;
  }
  return { filled, recv, order };
}

function isDiag(g: Grid, a: number, b: number): boolean {
  return a % g.w !== b % g.w && Math.floor(a / g.w) !== Math.floor(b / g.w);
}

/** Routes forced paths (user rivers) cell-to-cell wherever that stays downhill. */
export function forcePaths(g: Grid, d: Drainage, paths: number[][]): void {
  for (const path of paths) {
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i];
      const b = path[i + 1];
      if (d.recv[a] < 0) break;
      if (isNeighbor8(g, a, b) && d.filled[b] < d.filled[a]) d.recv[a] = b;
    }
  }
}

/** Upstream area in km² for every cell. */
export function accumulate(g: Grid, d: Drainage): Float32Array {
  const n = g.w * g.h;
  const acc = new Float32Array(n).fill(g.cellKm * g.cellKm);
  for (let k = n - 1; k >= 0; k--) {
    const c = d.order[k];
    const r = d.recv[c];
    if (r >= 0) acc[r] += acc[c];
  }
  return acc;
}

/**
 * Stream-power erosion, solved implicitly (Braun & Willett 2013) so it is
 * stable at any strength. Big rivers cut valleys; ridges between them remain.
 */
export function erode(g: Grid, h: Float32Array, ocean: Uint8Array, strength: number, iterations: number, frozen?: Uint8Array): void {
  const n = g.w * g.h;
  const K = 0.03 * strength;
  if (K <= 0) return;
  const hn = new Float64Array(n);
  for (let it = 0; it < iterations; it++) {
    const d = drain(g, h, ocean);
    const acc = accumulate(g, d);
    for (let k = 0; k < n; k++) {
      const c = d.order[k];
      const r = d.recv[c];
      if (r < 0 || ocean[c]) {
        hn[c] = d.filled[c];
        continue;
      }
      const dx = (isDiag(g, c, r) ? Math.SQRT2 : 1) * g.cellKm;
      const F = (K * Math.sqrt(acc[c])) / dx;
      const base = Math.max(0, ocean[r] ? 0 : hn[r]);
      let v = (d.filled[c] + F * base) / (1 + F);
      v = Math.max(v, base + 0.01, 1);
      if (frozen && frozen[c]) v = d.filled[c];
      hn[c] = v;
    }
    for (let i = 0; i < n; i++) if (!ocean[i]) h[i] = Math.min(h[i], hn[i]);
    // Light hillslope diffusion softens the stream-cut grid artefacts.
    const { w } = g;
    const src = h.slice();
    for (let y = 1; y < g.h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (ocean[i] || (frozen && frozen[i])) continue;
        const avg = (src[i - 1] + src[i + 1] + src[i - w] + src[i + w]) / 4;
        h[i] = Math.max(1, src[i] * 0.85 + avg * 0.15);
      }
    }
  }
}

export interface Hydrology extends Drainage {
  water: Uint8Array;
  catchment: Float32Array;
  river: Uint8Array;
}

export function hydrology(
  g: Grid,
  h: Float32Array,
  forced: number[][],
  riverThresholdKm2: number,
  lakes: boolean,
): Hydrology {
  const n = g.w * g.h;
  const ocean = detectOcean(g, h);
  const d = drain(g, h, ocean);
  forcePaths(g, d, forced);
  const catchment = accumulate(g, d);
  const water = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (ocean[i]) water[i] = WATER.ocean;

  if (lakes) {
    // A lake is a filled depression that's deep enough and not a single cell.
    const deep = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (!ocean[i] && d.filled[i] - h[i] > 15) deep[i] = 1;
    const seen = new Uint8Array(n);
    const stack: number[] = [];
    for (let s = 0; s < n; s++) {
      if (!deep[s] || seen[s]) continue;
      const members: number[] = [];
      seen[s] = 1;
      stack.push(s);
      while (stack.length) {
        const c = stack.pop()!;
        members.push(c);
        const x = c % g.w;
        const y = (c - x) / g.w;
        for (let k = 0; k < 8; k++) {
          const nx = x + DX8[k];
          const ny = y + DY8[k];
          if (nx < 0 || ny < 0 || nx >= g.w || ny >= g.h) continue;
          const nb = ny * g.w + nx;
          if (deep[nb] && !seen[nb]) {
            seen[nb] = 1;
            stack.push(nb);
          }
        }
      }
      if (members.length >= 6) for (const c of members) water[c] = WATER.lake;
    }
  }

  const river = new Uint8Array(n);
  const isForced = new Uint8Array(n);
  for (const p of forced) for (const c of p) if (!ocean[c]) isForced[c] = 1;
  // Downstream of anything forced is river too; order runs downstream→upstream.
  for (let k = n - 1; k >= 0; k--) {
    const c = d.order[k];
    if (ocean[c]) continue;
    if (catchment[c] >= riverThresholdKm2 || isForced[c]) {
      river[c] = 1;
      const r = d.recv[c];
      if (r >= 0 && !ocean[r]) isForced[r] = 1;
    }
  }
  return { ...d, water, catchment, river };
}

/** Rivers as polylines from each source to the sea or the stream they join. */
export function traceRivers(g: Grid, hy: Hydrology): Polyline[] {
  const n = g.w * g.h;
  const donors = new Uint8Array(n);
  for (let c = 0; c < n; c++) {
    if (!hy.river[c]) continue;
    const r = hy.recv[c];
    if (r >= 0 && hy.river[r]) donors[r]++;
  }
  const heads: number[] = [];
  for (let c = 0; c < n; c++) if (hy.river[c] && donors[c] === 0) heads.push(c);
  // Trace the highest sources first so main stems come out as long lines.
  heads.sort((a, b) => hy.filled[b] - hy.filled[a]);
  const visited = new Uint8Array(n);
  const lines: Polyline[] = [];
  for (const head of heads) {
    const cells = [head];
    visited[head] = 1;
    let c = head;
    for (;;) {
      const r = hy.recv[c];
      if (r < 0) break;
      cells.push(r);
      if (hy.water[r] === WATER.ocean || visited[r]) break;
      visited[r] = 1;
      c = r;
    }
    if (cells.length < 2) continue;
    const raw = cells.map((ci) => cellCenter(g, ci));
    const flow = cells.map((ci) => hy.catchment[ci]);
    const pts = chaikin(raw, 2);
    // Re-sample flow onto the smoothed points by proportional index.
    const f = pts.map((_, i) => flow[Math.min(flow.length - 1, Math.round((i / (pts.length - 1)) * (flow.length - 1)))]);
    lines.push({ pts, flow: f });
  }
  return lines;
}
