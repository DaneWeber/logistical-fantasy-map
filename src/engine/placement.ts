import { SITE_BIT, siteBits } from './analysis';
import { cellAt, cellCenter, dist, lengthScale, sample } from './grid';
import { makeName } from './names';
import type { Rng } from './rng';
import {
  LANDFORM,
  SITE_KINDS,
  SITE_LABELS,
  WATER,
  type Constraint,
  type ConstraintStatus,
  type Grid,
  type Place,
  type PlaceKind,
  type SiteKind,
  type Vec,
} from './types';

export interface PlacementCtx {
  g: Grid;
  surface: Float32Array;
  water: Uint8Array;
  siteMask: Uint16Array;
  recv: Int32Array;
  river: Uint8Array;
  landform: Uint8Array;
  catchment: Float32Array;
}

export const MOUNTAIN_MIN_M = 1000;
export const MOUNTAIN_RISE_M = 300;

function ls(g: Grid): number {
  return lengthScale(g.widthKm, g.heightKm);
}

/**
 * What "mountains between" asks for on this map. 1000 m high and 300 m above
 * both towns on big maps; scaled down with relief on small ones, where it
 * reads as a ridge or high moor between two villages.
 */
export function mountainThresholds(g: Grid): { minM: number; riseM: number } {
  const rs = Math.sqrt(ls(g));
  return { minM: Math.round(MOUNTAIN_MIN_M * rs), riseM: Math.round(MOUNTAIN_RISE_M * rs) };
}

// ---------------------------------------------------------------------------
// Constraint evaluation (shared by the solver and the final report)

function landHeight(ctx: PlacementCtx, p: Vec): number {
  const i = cellAt(ctx.g, p);
  return ctx.water[i] === WATER.ocean ? 0 : ctx.surface[i];
}

/** Highest ground on the straight line between a and b, ignoring the ends. */
export function crestBetween(ctx: PlacementCtx, a: Vec, b: Vec): { max: number; at: Vec } {
  const L = dist(a, b);
  const steps = Math.max(4, Math.ceil(L / ctx.g.cellKm));
  let max = 0;
  let at: Vec = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  for (let s = 0; s <= steps; s++) {
    const t = 0.08 + (0.84 * s) / steps;
    const p: Vec = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const i = cellAt(ctx.g, p);
    const v = ctx.water[i] === WATER.ocean ? 0 : ctx.surface[i];
    if (v > max) {
      max = v;
      at = p;
    }
  }
  return { max, at };
}

export function nearestRiverCell(ctx: PlacementCtx, p: Vec, tolKm = 3 * ls(ctx.g)): number {
  const { g } = ctx;
  const c = cellAt(g, p);
  const R = Math.max(1, Math.ceil(tolKm / g.cellKm));
  const cx = c % g.w;
  const cy = Math.floor(c / g.w);
  let best = -1;
  let bestD = Infinity;
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= g.w || y >= g.h) continue;
      const i = y * g.w + x;
      if (!ctx.river[i] || ctx.water[i] === WATER.ocean) continue;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
  }
  return best;
}

/** Walks downstream from `from`; how close does it come to `target`? (km) */
function downstreamApproach(ctx: PlacementCtx, from: number, target: number): number {
  const { g } = ctx;
  const tx = target % g.w;
  const ty = Math.floor(target / g.w);
  let c = from;
  let best = Infinity;
  for (let steps = 0; c >= 0 && steps < g.w * g.h; steps++) {
    const d = Math.max(Math.abs((c % g.w) - tx), Math.abs(Math.floor(c / g.w) - ty));
    if (d < best) best = d;
    if (best === 0 || ctx.water[c] === WATER.ocean) break;
    c = ctx.recv[c];
  }
  return best * g.cellKm;
}

export function riverConnection(ctx: PlacementCtx, a: Vec, b: Vec): { ra: number; rb: number; gapKm: number } {
  const ra = nearestRiverCell(ctx, a);
  const rb = nearestRiverCell(ctx, b);
  if (ra < 0 || rb < 0) return { ra, rb, gapKm: Infinity };
  return { ra, rb, gapKm: Math.min(downstreamApproach(ctx, ra, rb), downstreamApproach(ctx, rb, ra)) };
}

/** 0 when satisfied; grows with how badly it's violated. */
export function constraintPenalty(ctx: PlacementCtx, c: Constraint, a: Vec, b: Vec): number {
  switch (c.type) {
    case 'distance': {
      const d = dist(a, b);
      let p = 0;
      if (c.minKm != null && d < c.minKm) p += (c.minKm - d) / Math.max(c.minKm, 1);
      if (c.maxKm != null && d > c.maxKm) p += (d - c.maxKm) / Math.max(c.maxKm, 1);
      return p * 3;
    }
    case 'mountainsBetween': {
      const { max } = crestBetween(ctx, a, b);
      const ends = Math.max(landHeight(ctx, a), landHeight(ctx, b));
      const { minM, riseM } = mountainThresholds(ctx.g);
      return Math.max(0, (minM - max) / minM) + Math.max(0, (riseM - (max - ends)) / riseM);
    }
    case 'sameRiver': {
      const tol = Math.max(3 * ls(ctx.g), ctx.g.cellKm * 1.5);
      const { ra, rb, gapKm } = riverConnection(ctx, a, b);
      if (ra < 0 || rb < 0) return 1 + (ra < 0 ? 0.5 : 0) + (rb < 0 ? 0.5 : 0);
      const far = 300 * ls(ctx.g);
      return gapKm <= tol ? 0 : 1 + Math.min(gapKm, far) / far;
    }
  }
}

export function describeConstraint(ctx: PlacementCtx, c: Constraint, a: Vec, b: Vec, an: string, bn: string): ConstraintStatus {
  const ok = constraintPenalty(ctx, c, a, b) < 1e-6;
  switch (c.type) {
    case 'distance': {
      const d = Math.round(dist(a, b));
      const range =
        c.minKm != null && c.maxKm != null
          ? `${c.minKm}–${c.maxKm} km`
          : c.minKm != null
            ? `≥ ${c.minKm} km`
            : c.maxKm != null
              ? `≤ ${c.maxKm} km`
              : 'any distance';
      return { id: c.id, ok, message: `${an} ↔ ${bn}: ${d} km (want ${range})` };
    }
    case 'mountainsBetween': {
      const { max } = crestBetween(ctx, a, b);
      const { minM, riseM } = mountainThresholds(ctx.g);
      return {
        id: c.id,
        ok,
        message: ok
          ? `Mountains between ${an} and ${bn} (crest ${Math.round(max)} m)`
          : `No mountains between ${an} and ${bn} (highest ground ${Math.round(max)} m; need ≥ ${minM} m and ${riseM} m above both)`,
      };
    }
    case 'sameRiver': {
      const { ra, rb } = riverConnection(ctx, a, b);
      const why = ra < 0 ? `${an} is not on a river` : rb < 0 ? `${bn} is not on a river` : 'they are on different rivers';
      return { id: c.id, ok, message: ok ? `${an} and ${bn} are on the same river` : `${an} / ${bn} same river: ${why}` };
    }
  }
}

function popcount(v: number): number {
  let c = 0;
  while (v) {
    v &= v - 1;
    c++;
  }
  return c;
}

export function unmetSites(ctx: PlacementCtx, sites: SiteKind[], p: Vec): SiteKind[] {
  const m = ctx.siteMask[cellAt(ctx.g, p)];
  return sites.filter((s) => !(m & SITE_BIT[s]));
}

// ---------------------------------------------------------------------------
// Solver

export interface Solution {
  pos: Map<string, Vec>;
  /** Places whose site requirements could not be met anywhere they're allowed. */
  relaxed: Set<string>;
}

interface Var {
  place: Place;
  req: number;
  domain: Int32Array;
  inDomain: Uint8Array;
  relaxed: boolean;
  cons: Constraint[];
}

/**
 * Places free and "near" towns with min-conflicts local search: start from a
 * greedy assignment, then repeatedly move the most-conflicted town to the
 * best of a batch of candidate spots (biased toward rings that satisfy its
 * distance rules) until nothing is violated or the budget runs out.
 */
export function solvePlacement(
  ctx: PlacementCtx,
  places: Place[],
  constraints: Constraint[],
  hints: Record<string, Vec>,
  hintWeight: number,
  minSpacingKm: number,
  rng: Rng,
): Solution {
  const { g } = ctx;
  const n = g.w * g.h;
  const L = ls(g);
  const pos = new Map<string, Vec>();
  const relaxed = new Set<string>();
  const ids = new Set(places.map((p) => p.id));
  const valid = constraints.filter((c) => ids.has(c.a) && ids.has(c.b) && c.a !== c.b);

  const landCells: number[] = [];
  for (let i = 0; i < n; i++) if (ctx.water[i] === WATER.land) landCells.push(i);

  const vars: Var[] = [];
  for (const p of places) {
    if (p.mode === 'fixed' && p.pos) {
      pos.set(p.id, p.pos);
      continue;
    }
    const req = siteBits(p.sites);
    const center = p.mode === 'near' ? p.pos : undefined;
    const r = p.radiusKm ?? 50 * L;
    const inRange = (i: number) => !center || dist(cellCenter(g, i), center) <= r;
    let domain = landCells.filter((i) => inRange(i) && (ctx.siteMask[i] & req) === req);
    let isRelaxed = false;
    if (domain.length === 0) {
      isRelaxed = req !== 0;
      domain = landCells.filter(inRange);
      if (domain.length === 0) domain = center ? [cellAt(g, center)] : landCells.length ? landCells : [Math.floor(n / 2)];
    }
    const inDomain = new Uint8Array(n);
    for (const i of domain) inDomain[i] = 1;
    if (isRelaxed) relaxed.add(p.id);
    vars.push({
      place: p,
      req,
      domain: Int32Array.from(domain),
      inDomain,
      relaxed: isRelaxed,
      cons: valid.filter((c) => c.a === p.id || c.b === p.id),
    });
  }
  if (vars.length === 0) return { pos, relaxed };

  const cur = new Map<string, number>();

  const cost = (v: Var, cell: number, withSoft: boolean): number => {
    const p = cellCenter(g, cell);
    let s = v.relaxed ? popcount(v.req & ~ctx.siteMask[cell]) * 2 : 0;
    for (const c of v.cons) {
      const other = c.a === v.place.id ? c.b : c.a;
      const po = pos.get(other);
      if (!po) continue;
      s += c.a === v.place.id ? constraintPenalty(ctx, c, p, po) : constraintPenalty(ctx, c, po, p);
    }
    if (!withSoft) return s;
    for (const [id, q] of pos) {
      if (id === v.place.id) continue;
      const d = dist(p, q);
      if (d < minSpacingKm) s += (0.5 * (minSpacingKm - d)) / minSpacingKm;
    }
    const hnt = hints[v.place.id];
    if (hnt) s += hintWeight * Math.min(1, dist(p, hnt) / (300 * L));
    return s;
  };

  const candidates = (v: Var, k: number): number[] => {
    const out: number[] = [];
    const add = (i: number) => {
      if (i >= 0 && v.inDomain[i]) out.push(i);
    };
    for (let j = 0; j < k; j++) out.push(v.domain[rng.int(v.domain.length)]);
    const hnt = hints[v.place.id];
    if (hnt) {
      add(cellAt(g, hnt));
      for (let j = 0; j < 8; j++) add(cellAt(g, [hnt[0] + rng.range(-15 * L, 15 * L), hnt[1] + rng.range(-15 * L, 15 * L)]));
    }
    const c0 = cur.get(v.place.id);
    if (c0 != null) {
      out.push(c0);
      const p0 = cellCenter(g, c0);
      for (let j = 0; j < 8; j++) add(cellAt(g, [p0[0] + rng.range(-25 * L, 25 * L), p0[1] + rng.range(-25 * L, 25 * L)]));
    }
    for (const c of v.cons) {
      const other = c.a === v.place.id ? c.b : c.a;
      const po = pos.get(other);
      if (!po) continue;
      if (c.type === 'distance') {
        const lo = c.minKm ?? 0;
        const hi = c.maxKm ?? Math.max(lo * 1.6, lo + 80 * L);
        for (let j = 0; j < 24; j++) {
          const a = rng.next() * Math.PI * 2;
          const r = rng.range(lo, hi);
          add(cellAt(g, [po[0] + Math.cos(a) * r, po[1] + Math.sin(a) * r]));
        }
      } else if (c.type === 'sameRiver') {
        let rc = nearestRiverCell(ctx, po, 6 * L);
        const path: number[] = [];
        for (let s = 0; rc >= 0 && s < 2000 && ctx.water[rc] !== WATER.ocean; s++) {
          path.push(rc);
          rc = ctx.recv[rc];
        }
        for (let j = 0; j < 16 && path.length; j++) add(path[rng.int(path.length)]);
      }
    }
    return out;
  };

  const place = (v: Var, cell: number) => {
    cur.set(v.place.id, cell);
    pos.set(v.place.id, cellCenter(g, cell));
  };

  // Greedy start: most constrained first.
  const order = [...vars].sort((a, b) => b.cons.length - a.cons.length || a.domain.length - b.domain.length);
  for (const v of order) {
    let best = -1;
    let bestC = Infinity;
    for (const cell of candidates(v, 150)) {
      const cc = cost(v, cell, true);
      if (cc < bestC) {
        bestC = cc;
        best = cell;
      }
    }
    place(v, best);
  }

  const hardTotal = () => vars.reduce((s, v) => s + cost(v, cur.get(v.place.id)!, false), 0);
  let bestTotal = hardTotal();
  let bestSnap = new Map(cur);
  const budget = 80 * vars.length + 300;
  for (let it = 0; it < budget && bestTotal > 1e-6; it++) {
    const conflicts = vars.map((v) => cost(v, cur.get(v.place.id)!, false));
    const sum = conflicts.reduce((a, b) => a + b, 0);
    if (sum < 1e-6) break;
    let r = rng.next() * sum;
    let vi = 0;
    while (vi < vars.length - 1 && r > conflicts[vi]) r -= conflicts[vi++];
    const v = vars[vi];
    const scored = candidates(v, 80).map((cell) => ({ cell, c: cost(v, cell, true) }));
    scored.sort((a, b) => a.c - b.c);
    const pick = rng.next() < 0.12 ? scored[rng.int(Math.min(5, scored.length))] : scored[0];
    place(v, pick.cell);
    const total = hardTotal();
    if (total < bestTotal - 1e-9) {
      bestTotal = total;
      bestSnap = new Map(cur);
    }
  }
  for (const v of vars) place(v, bestSnap.get(v.place.id)!);
  // Snap fixed-cell centres back to the hint when the hint cell was chosen,
  // so a stable town doesn't jitter by half a cell between runs.
  for (const v of vars) {
    const hnt = hints[v.place.id];
    if (hnt && cellAt(g, hnt) === cur.get(v.place.id)) pos.set(v.place.id, hnt);
  }
  return { pos, relaxed };
}

// ---------------------------------------------------------------------------
// Suggested settlements

export interface AutoTown {
  name: string;
  kind: PlaceKind;
  pos: Vec;
  sites: SiteKind[];
}

export function suggestTowns(ctx: PlacementCtx, taken: Vec[], count: number, minSpacingKm: number, rng: Rng): AutoTown[] {
  const { g } = ctx;
  const n = g.w * g.h;
  const land: number[] = [];
  for (let i = 0; i < n; i++) if (ctx.water[i] === WATER.land) land.push(i);
  if (!land.length) return [];
  const score = (i: number) => {
    const m = ctx.siteMask[i];
    let s = 0;
    if (m & SITE_BIT.river) s += 2;
    if (m & SITE_BIT.confluence) s += 2.5;
    if (m & SITE_BIT.riverMouth) s += 3;
    if (m & SITE_BIT.coast) s += 1.5;
    if (m & SITE_BIT.lakeshore) s += 1.5;
    if (ctx.landform[i] === LANDFORM.plain) s += 1;
    if (ctx.landform[i] === LANDFORM.valley) s += 1.2;
    if (ctx.landform[i] === LANDFORM.mountains) s -= 2.5;
    s -= Math.max(0, ctx.surface[i] - 900) / 400;
    return s;
  };
  const out: AutoTown[] = [];
  const all = [...taken];
  for (let k = 0; k < count; k++) {
    let best = -1;
    let bestS = -Infinity;
    for (let j = 0; j < 2500; j++) {
      const i = land[rng.int(land.length)];
      const p = cellCenter(g, i);
      if (all.some((q) => dist(p, q) < minSpacingKm)) continue;
      const s = score(i) + rng.next() * 1.5;
      if (s > bestS) {
        bestS = s;
        best = i;
      }
    }
    if (best < 0) break;
    const p = cellCenter(g, best);
    const sites = SITE_KINDS.filter((s) => ctx.siteMask[best] & SITE_BIT[s]);
    const kind: PlaceKind = bestS > 5 || k < count / 6 ? 'town' : 'village';
    out.push({ name: makeName(rng, sites), kind, pos: p, sites });
    all.push(p);
  }
  return out;
}

export function siteSummary(sites: SiteKind[]): string {
  return sites.map((s) => SITE_LABELS[s]).join(', ');
}

export function heightAt(ctx: PlacementCtx, p: Vec): number {
  return sample(ctx.g, ctx.surface, p);
}
