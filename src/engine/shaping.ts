import { boxBlur, cellAt, cellCenter, dist, sample } from './grid';
import { constraintPenalty, nearestRiverCell, unmetSites, type PlacementCtx, type Solution } from './placement';
import { subRng, type Rng } from './rng';
import { WATER, type ImplicitFeatures, type SiteKind, type Vec, type WorldDoc } from './types';

export function emptyImplicit(): ImplicitFeatures {
  return { ridges: [], rivers: [], seaStrokes: [], landBlobs: [], landformCircles: [], notes: [] };
}

/** Adds a later pass's features to an earlier set, keeping ids unique. */
export function mergeImplicit(a: ImplicitFeatures, b: ImplicitFeatures, pass: number): ImplicitFeatures {
  const tag = <T extends { id: string }>(x: T): T => ({ ...x, id: `${x.id}-p${pass}` });
  return {
    ridges: [...a.ridges, ...b.ridges.map(tag)],
    rivers: [...a.rivers, ...b.rivers.map(tag)],
    seaStrokes: [...a.seaStrokes, ...b.seaStrokes],
    landBlobs: [...a.landBlobs, ...b.landBlobs],
    landformCircles: [...a.landformCircles, ...b.landformCircles],
    notes: [...new Set([...a.notes, ...b.notes])],
  };
}

export function hasImplicit(f: ImplicitFeatures): boolean {
  return f.ridges.length + f.rivers.length + f.seaStrokes.length + f.landBlobs.length + f.landformCircles.length > 0;
}

const add = (a: Vec, b: Vec, k = 1): Vec => [a[0] + b[0] * k, a[1] + b[1] * k];
const rot = (v: Vec, deg: number): Vec => {
  const r = (deg * Math.PI) / 180;
  return [v[0] * Math.cos(r) - v[1] * Math.sin(r), v[0] * Math.sin(r) + v[1] * Math.cos(r)];
};
const norm = (v: Vec): Vec => {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
};
const perp = (v: Vec): Vec => [-v[1], v[0]];

/**
 * Works out what terrain the facts need but don't have yet, given a first
 * pass. Each unmet fact turns into a small implicit feature (a ridge, a
 * river course, an inlet...) that the second pass builds in. Facts already
 * satisfied by the natural terrain produce nothing, so the map only changes
 * where it has to.
 */
export function deriveImplicit(doc: WorldDoc, ctx: PlacementCtx, sol: Solution): ImplicitFeatures {
  const out = emptyImplicit();
  const { g } = ctx;
  const n = g.w * g.h;
  const landH = new Float32Array(n);
  for (let i = 0; i < n; i++) landH[i] = ctx.water[i] === WATER.ocean ? 0 : ctx.surface[i];
  const smooth = boxBlur(landH, g.w, g.h, Math.max(2, Math.round(10 / g.cellKm)), 2);

  const upDir = (p: Vec, rng: Rng): Vec => {
    const e = g.cellKm * 3;
    const gx = sample(g, smooth, [p[0] + e, p[1]]) - sample(g, smooth, [p[0] - e, p[1]]);
    const gy = sample(g, smooth, [p[0], p[1] + e]) - sample(g, smooth, [p[0], p[1] - e]);
    if (Math.hypot(gx, gy) < 1) {
      const a = rng.next() * Math.PI * 2;
      return [Math.cos(a), Math.sin(a)];
    }
    return norm([gx, gy]);
  };

  const nearestOcean = (p: Vec): Vec | null => {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      if (ctx.water[i] !== WATER.ocean) continue;
      const d = dist(cellCenter(g, i), p);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) return cellCenter(g, best);
    // No ocean at all: open one at the nearest map edge.
    const edges: Vec[] = [
      [0, p[1]],
      [g.widthKm, p[1]],
      [p[0], 0],
      [p[0], g.heightKm],
    ];
    return edges.reduce((a, b) => (dist(a, p) <= dist(b, p) ? a : b));
  };

  /** The first pass's drainage route from p to the sea, so carved courses have an outlet. */
  const downstream = (p: Vec, maxKm = Infinity): Vec[] => {
    const out: Vec[] = [];
    let c = ctx.recv[cellAt(g, p)];
    let travelled = 0;
    let prev = p;
    while (c >= 0 && travelled <= maxKm) {
      const q = cellCenter(g, c);
      travelled += dist(prev, q);
      out.push(q);
      prev = q;
      if (ctx.water[c] === WATER.ocean) break;
      c = ctx.recv[c];
    }
    return out;
  };

  /** Upstream from cell c along the biggest tributary, as points ending just above c. */
  const traceUp = (c: number, steps = 15): Vec[] => {
    const up: Vec[] = [];
    for (let k = 0; k < steps; k++) {
      let best = -1;
      const x = c % g.w;
      const y = Math.floor(c / g.w);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= g.w || ny >= g.h) continue;
          const nb = ny * g.w + nx;
          if (ctx.recv[nb] === c && ctx.river[nb] && (best < 0 || ctx.catchment[nb] > ctx.catchment[best])) best = nb;
        }
      if (best < 0) break;
      c = best;
      up.unshift(cellCenter(g, c));
    }
    return up;
  };

  /** Pins the existing river through p: upstream a way, then down to the sea. */
  const anchorRiver = (p: Vec, id: string, name: string): ImplicitFeatures['rivers'] => {
    const r = nearestRiverCell(ctx, p);
    if (r < 0) return [];
    const at = cellCenter(g, r);
    return [{ id, name, points: [...traceUp(r), at, ...downstream(at)], valleyWidthKm: 0 }];
  };

  /** Pins the two largest streams meeting near p. */
  const anchorConfluence = (p: Vec, id: string, name: string): ImplicitFeatures['rivers'] => {
    const c0 = cellAt(g, p);
    const R = Math.max(1, Math.ceil(6 / g.cellKm));
    for (let dy = -R; dy <= R; dy++)
      for (let dx = -R; dx <= R; dx++) {
        const x = (c0 % g.w) + dx;
        const y = Math.floor(c0 / g.w) + dy;
        if (x < 0 || y < 0 || x >= g.w || y >= g.h) continue;
        const q = y * g.w + x;
        if (!ctx.river[q]) continue;
        const donors: number[] = [];
        for (let ey = -1; ey <= 1; ey++)
          for (let ex = -1; ex <= 1; ex++) {
            const nx = x + ex;
            const ny = y + ey;
            if (nx < 0 || ny < 0 || nx >= g.w || ny >= g.h) continue;
            const nb = ny * g.w + nx;
            if (ctx.recv[nb] === q && ctx.river[nb]) donors.push(nb);
          }
        if (donors.length < 2) continue;
        donors.sort((a, b) => ctx.catchment[b] - ctx.catchment[a]);
        const at = cellCenter(g, q);
        const down = downstream(at);
        return donors.slice(0, 2).map((d, k) => ({
          id: `${id}-${k}`,
          name,
          points: [...traceUp(d), cellCenter(g, d), at, ...(k === 0 ? down : [])],
          valleyWidthKm: 0,
        }));
      }
    return anchorRiver(p, id, name);
  };

  const nearestLand = (p: Vec): Vec | null => {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      if (ctx.water[i] === WATER.ocean) continue;
      const d = dist(cellCenter(g, i), p);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best >= 0 ? cellCenter(g, best) : null;
  };

  for (const place of doc.places) {
    const p = sol.pos.get(place.id);
    if (!p) continue;
    if (!(place.mode === 'fixed' || sol.relaxed.has(place.id))) continue;
    const rng = subRng(doc.seed, 'shape:' + place.id);
    const inSea = ctx.water[cellAt(g, p)] === WATER.ocean;
    const unmet = new Set<SiteKind>(unmetSites(ctx, place.sites, p));
    if (inSea && place.sites.length === 0) {
      out.landBlobs.push({ pos: p, radiusKm: 8 + g.cellKm * 2 });
      out.notes.push(`${place.name} sat in the sea; raised land under it.`);
    }
    if (unmet.size === 0) continue;
    if (unmet.has('valley') || unmet.has('riverMouth') || unmet.has('confluence')) unmet.delete('river');
    const tag = `auto: ${place.name}`;
    let up = upDir(p, rng);
    if (inSea) {
      // Offshore, "uphill" is wherever the nearest land is.
      const l = nearestLand(p);
      if (l && dist(l, p) > 0.1) up = norm([l[0] - p[0], l[1] - p[1]]);
    }

    if (unmet.has('coast') || unmet.has('riverMouth')) {
      if (inSea) {
        const l = nearestLand(p);
        const dir = l && dist(l, p) > 0.1 ? norm([l[0] - p[0], l[1] - p[1]]) : up;
        const r = 7 + g.cellKm * 2;
        out.landBlobs.push({ pos: add(p, dir, r * 0.75), radiusKm: r });
        out.notes.push(`Raised a headland so ${place.name} sits on the coast.`);
      } else if (!(ctx.siteMask[cellAt(g, p)] & 2)) {
        const o = nearestOcean(p)!;
        const d = dist(o, p);
        const dir = norm([p[0] - o[0], p[1] - o[1]]);
        const width = Math.max(5, g.cellKm * 2.5);
        const tip = add(p, dir, -(width / 2 + g.cellKm * 0.5));
        out.seaStrokes.push({ points: [add(o, dir, -10), tip], widthKm: width });
        out.landBlobs.push({ pos: p, radiusKm: g.cellKm * 1.2 });
        out.notes.push(
          d > 60
            ? `${place.name} must be coastal but the sea was ${Math.round(d)} km away — cut a long inlet. Consider painting sea nearby.`
            : `Cut an inlet so ${place.name} sits on the coast.`,
        );
      }
    }
    if (unmet.has('riverMouth')) {
      // Run the river through the town and on into the sea beside it.
      const o = inSea ? nearestLand(p) : nearestOcean(p);
      let inland = o && dist(o, p) > 0.1 ? norm([p[0] - o[0], p[1] - o[1]]) : up;
      if (inSea) inland = [-inland[0], -inland[1]];
      const reach = (o && !inSea ? dist(o, p) : 0) + g.cellKm * 3;
      out.rivers.push({
        id: `auto-mouth-${place.id}`,
        name: tag,
        points: [add(p, rot(inland, rng.range(-25, 25)), 45), p, add(p, inland, -reach)],
        valleyWidthKm: 2,
      });
    }
    if (unmet.has('river')) {
      out.rivers.push({ id: `auto-river-${place.id}`, name: tag, points: [add(p, rot(up, rng.range(-20, 20)), 35), p, ...downstream(p)], valleyWidthKm: 0 });
    }
    if (unmet.has('confluence')) {
      out.rivers.push({ id: `auto-conf1-${place.id}`, name: tag, points: [add(p, rot(up, 40), 35), p, ...downstream(p)], valleyWidthKm: 0 });
      out.rivers.push({ id: `auto-conf2-${place.id}`, name: tag, points: [add(p, rot(up, -40), 35), p], valleyWidthKm: 0 });
    }
    if (unmet.has('valley')) {
      const down = downstream(p);
      const split = down.findIndex((q) => dist(q, p) > 30);
      const head = split < 0 ? down : down.slice(0, split + 1);
      out.rivers.push({ id: `auto-valley-${place.id}`, name: tag, points: [add(p, up, 40), p, ...head], valleyWidthKm: 10 });
      if (split >= 0) out.rivers.push({ id: `auto-valley-out-${place.id}`, name: tag, points: down.slice(split), valleyWidthKm: 0 });
      const side = perp(up);
      for (const s of [1, -1]) {
        out.ridges.push({
          id: `auto-valleyside${s}-${place.id}`,
          name: tag,
          points: [add(add(p, side, 18 * s), up, 45), add(add(p, side, 18 * s), up, -25)],
          heightM: 800,
          widthKm: 20,
        });
      }
    }
    if (unmet.has('mountains') || unmet.has('ridge')) {
      const along = perp(up);
      const L = unmet.has('ridge') ? 40 : 45;
      out.ridges.push({
        id: `auto-mtn-${place.id}`,
        name: tag,
        points: [add(p, along, -L), add(p, rot(along, rng.range(-10, 10)), 0.01), add(p, rot(along, rng.range(-15, 15)), L)],
        heightM: Math.max(1600, doc.settings.maxElevationM * 0.75),
        widthKm: unmet.has('ridge') ? 28 : 40,
      });
    }
    if (unmet.has('hills')) out.landformCircles.push({ pos: p, radiusKm: 25, kind: 'hills' });
    if (unmet.has('plain')) out.landformCircles.push({ pos: p, radiusKm: 30, kind: 'plains' });
    if (unmet.has('lakeshore')) out.notes.push(`Can't create a lake for ${place.name} automatically; move it near a lake or drop the requirement.`);
  }

  // Facts the first pass got right by luck could be lost when the second
  // pass reshapes nearby terrain, so pin their rivers down too.
  const anchors: ImplicitFeatures['rivers'] = [];
  const anchorCircles: ImplicitFeatures['landformCircles'] = [];
  const RIVERISH: SiteKind[] = ['river', 'riverMouth', 'confluence', 'valley'];
  for (const place of doc.places) {
    const p = sol.pos.get(place.id);
    if (!p || place.mode !== 'fixed') continue;
    const unmet = unmetSites(ctx, place.sites, p);
    const met = place.sites.filter((s) => !unmet.includes(s));
    const tag = `auto: ${place.name}`;
    if (met.includes('confluence')) anchors.push(...anchorConfluence(p, `anchor-${place.id}`, tag));
    else if (met.some((s) => RIVERISH.includes(s))) anchors.push(...anchorRiver(p, `anchor-${place.id}`, tag));
    if (met.includes('plain')) anchorCircles.push({ pos: p, radiusKm: 20, kind: 'plains' });
    if (met.includes('hills')) anchorCircles.push({ pos: p, radiusKm: 20, kind: 'hills' });
  }

  for (const c of doc.constraints) {
    const a = sol.pos.get(c.a);
    const b = sol.pos.get(c.b);
    if (!a || !b) continue;
    if (constraintPenalty(ctx, c, a, b) < 1e-6) {
      const pa = doc.places.find((p) => p.id === c.a);
      const pb = doc.places.find((p) => p.id === c.b);
      if (c.type === 'sameRiver' && pa?.mode === 'fixed' && pb?.mode === 'fixed') {
        const hi = sample(g, ctx.surface, a) >= sample(g, ctx.surface, b) ? a : b;
        anchors.push(...anchorRiver(hi, `anchor-${c.id}`, 'auto: same river'));
      }
      continue;
    }
    const an = doc.places.find((p) => p.id === c.a)?.name ?? '?';
    const bn = doc.places.find((p) => p.id === c.b)?.name ?? '?';
    const rng = subRng(doc.seed, 'shape:' + c.id);
    const L = dist(a, b);
    if (c.type === 'mountainsBetween') {
      if (L < 16) {
        out.notes.push(`${an} and ${bn} are only ${Math.round(L)} km apart — too close to fit mountains between them.`);
        continue;
      }
      const u = norm([b[0] - a[0], b[1] - a[1]]);
      const v = perp(u);
      const m = add([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], u, rng.range(-0.08, 0.08) * L);
      const span = Math.max(0.9 * L, 120);
      out.ridges.push({
        id: `auto-between-${c.id}`,
        name: `auto: range between ${an} & ${bn}`,
        points: [add(add(m, v, -span / 2), u, rng.range(-0.1, 0.1) * L), m, add(add(m, v, span / 2), u, rng.range(-0.1, 0.1) * L)],
        heightM: Math.max(1800, doc.settings.maxElevationM * 0.8),
        widthKm: Math.min(45, L - 14),
      });
    } else if (c.type === 'sameRiver') {
      const [hi, lo] = sample(g, ctx.surface, a) >= sample(g, ctx.surface, b) ? [a, b] : [b, a];
      const dir = L > 0.1 ? norm([hi[0] - lo[0], hi[1] - lo[1]]) : upDir(hi, rng);
      out.rivers.push({ id: `auto-same-${c.id}`, name: `auto: river through ${an} & ${bn}`, points: [add(hi, dir, 25), hi, lo, ...downstream(lo)], valleyWidthKm: 3 });
    }
  }
  if (hasImplicit(out)) {
    out.rivers.push(...anchors);
    out.landformCircles.push(...anchorCircles);
  }
  return out;
}
