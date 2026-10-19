import { analyze, type Analysis } from './analysis';
import { cellAt, makeGrid } from './grid';
import { detectOcean, drain, erode, hydrology, traceRivers, type Hydrology } from './hydrology';
import { describeConstraint, solvePlacement, suggestTowns, unmetSites, type PlacementCtx, type Solution } from './placement';
import { subRng } from './rng';
import { deriveImplicit, emptyImplicit, hasImplicit, mergeImplicit } from './shaping';
import { applyLock, breachAt, buildTerrain, carveRivers } from './terrain';
import { WATER, type Grid, type ImplicitFeatures, type ResolvedPlace, type Vec, type WorldDoc, type WorldResult } from './types';

export function riverThreshold(doc: WorldDoc): number {
  // Below 800 km the threshold shrinks with map area, so a small map shows its
  // creeks at the same density a big one shows its rivers.
  const f = Math.min(1, Math.max(doc.settings.widthKm, doc.settings.heightKm) / 800);
  return 1500 * Math.pow(0.1, doc.settings.riverDensity) * f * f;
}

interface Pass {
  g: Grid;
  h: Float32Array;
  baseHeight: Float32Array;
  hy: Hydrology;
  an: Analysis;
  ctx: PlacementCtx;
  sol: Solution;
  warnings: string[];
}

function runPass(doc: WorldDoc, g: Grid, implicit: ImplicitFeatures, hints: Record<string, Vec>, hintWeight: number): Pass {
  const S = doc.settings;
  const h = buildTerrain(doc, g, implicit);
  const rivers = [...doc.rivers, ...implicit.rivers];
  const ridges = [...doc.ridges, ...implicit.ridges];
  // Carve once before erosion so the river attracts drainage and erosion
  // widens its valley, then again after so the course is exactly kept.
  carveRivers(g, h, rivers, ridges);
  erode(g, h, detectOcean(g, h), S.erosion, 4);
  applyLock(doc, g, h);
  const carve = carveRivers(g, h, rivers, ridges);
  const townCells = doc.places
    .filter((p) => p.mode === 'fixed' && p.pos && !p.sites.includes('lakeshore'))
    .map((p) => cellAt(g, p.pos!));
  if (townCells.length) breachAt(g, h, townCells, drain(g, h, detectOcean(g, h)));
  const baseHeight = h.slice();
  const hy = hydrology(g, h, carve.paths, riverThreshold(doc), S.lakes);
  const an = analyze(g, h, hy);
  const ctx: PlacementCtx = {
    g,
    surface: an.surface,
    water: hy.water,
    siteMask: an.siteMask,
    recv: hy.recv,
    river: hy.river,
    landform: an.landform,
    catchment: hy.catchment,
  };
  const sol = solvePlacement(ctx, doc.places, doc.constraints, hints, hintWeight, S.minTownSpacingKm, subRng(doc.seed, 'placement'));
  return { g, h, baseHeight, hy, an, ctx, sol, warnings: carve.warnings };
}

/**
 * The whole pipeline. Pass A builds terrain from the seed and the user's
 * features and places towns; any facts it can't satisfy become implicit
 * terrain features, and pass B rebuilds with those included.
 */
export function generate(doc: WorldDoc): WorldResult {
  const t0 = performance.now();
  const S = doc.settings;
  const g = makeGrid(S.widthKm, S.heightKm, S.resolution);
  const A = runPass(doc, g, emptyImplicit(), doc.hints, 0.15);
  let implicit = deriveImplicit(doc, A.ctx, A.sol);
  let R = A;
  // Usually one reshaping pass settles everything; a third catches facts
  // the second pass disturbed (e.g. a new ridge turning a plain into a valley).
  for (let pass = 2; pass <= 3 && hasImplicit(implicit); pass++) {
    const hints = { ...doc.hints };
    for (const p of doc.places) {
      const at = R.sol.pos.get(p.id);
      if (at && p.mode !== 'fixed') hints[p.id] = at;
    }
    R = runPass(doc, g, implicit, hints, 1.5);
    if (pass === 3) break;
    const more = deriveImplicit(doc, R.ctx, R.sol);
    if (!hasImplicit(more)) break;
    implicit = mergeImplicit(implicit, more, pass);
  }

  const { ctx, sol, hy, an } = R;
  const names = new Map(doc.places.map((p) => [p.id, p.name]));
  const warnings = [...R.warnings, ...implicit.notes];

  const places: ResolvedPlace[] = [];
  for (const p of doc.places) {
    const pos = sol.pos.get(p.id);
    if (!pos) continue;
    const unmet = unmetSites(ctx, p.sites, pos);
    if (ctx.water[cellAt(g, pos)] === WATER.ocean) warnings.push(`${p.name} is in the sea.`);
    places.push({ id: p.id, name: p.name, kind: p.kind, mode: p.mode, pos, sites: p.sites, unmetSites: unmet });
  }

  const report = doc.constraints.map((c) => {
    const a = sol.pos.get(c.a);
    const b = sol.pos.get(c.b);
    if (!a || !b) return { id: c.id, ok: false, message: 'Refers to a place that no longer exists' };
    if (c.a === c.b) return { id: c.id, ok: false, message: 'Both ends are the same place' };
    return describeConstraint(ctx, c, a, b, names.get(c.a)!, names.get(c.b)!);
  });

  const auto = suggestTowns(ctx, places.map((p) => p.pos), S.autoTowns, S.minTownSpacingKm, subRng(doc.seed, 'auto-towns'));
  auto.forEach((t, k) =>
    places.push({ id: `auto-${k}`, name: t.name, kind: t.kind, mode: 'auto', pos: t.pos, sites: t.sites, unmetSites: [] }),
  );

  return {
    grid: g,
    height: an.surface,
    baseHeight: R.baseHeight,
    water: hy.water,
    flowTo: hy.recv,
    catchment: hy.catchment,
    river: hy.river,
    ridge: an.ridge,
    landform: an.landform,
    coastDist: an.coastDist,
    siteMask: an.siteMask,
    rivers: traceRivers(g, hy),
    ridgeLines: an.ridgeLines,
    places,
    report,
    implicit,
    warnings,
    riverThresholdKm2: riverThreshold(doc),
    ms: Math.round(performance.now() - t0),
  };
}
