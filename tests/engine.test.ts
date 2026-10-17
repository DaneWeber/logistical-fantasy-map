import { describe, expect, it } from 'vitest';
import { deserialize, newDoc, serialize } from '../src/engine/doc';
import { generate } from '../src/engine/generate';
import { cellAt } from '../src/engine/grid';
import { LANDSEA, WATER, type Vec, type WorldDoc, type WorldResult } from '../src/engine/types';

const small = (seed: number): WorldDoc => newDoc(seed, { resolution: 200 });

/** A continent filling the middle of the map, so tests can rely on land. */
function withLand(doc: WorldDoc, x0: number, y0: number, x1: number, y1: number): WorldDoc {
  const { w, h, data } = doc.paint.landSea;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const kx = ((x + 0.5) / w) * doc.settings.widthKm;
      const ky = ((y + 0.5) / h) * doc.settings.heightKm;
      if (kx > x0 && kx < x1 && ky > y0 && ky < y1) data[y * w + x] = LANDSEA.land;
    }
  return doc;
}

function segmentsCross(p1: Vec, p2: Vec, q1: Vec, q2: Vec): boolean {
  const o = (a: Vec, b: Vec, c: Vec) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  return o(p1, p2, q1) !== o(p1, p2, q2) && o(q1, q2, p1) !== o(q1, q2, p2);
}

function cellPos(r: WorldResult, i: number): Vec {
  return [((i % r.grid.w) + 0.5) * r.grid.cellKm, (Math.floor(i / r.grid.w) + 0.5) * r.grid.cellKm];
}

describe('hydrology', () => {
  const r = generate(small(4242));

  it('every river runs downhill and ends in the sea or off the map', () => {
    const { w, h } = r.grid;
    let rivers = 0;
    for (let i = 0; i < w * h; i++) {
      if (!r.river[i] || r.water[i] !== WATER.land) continue;
      rivers++;
      let c = i;
      for (let steps = 0; steps < w * h; steps++) {
        const nx = r.flowTo[c];
        if (nx < 0) break; // map edge outlet
        // Rivers never climb: the next cell's surface is no higher.
        expect(r.height[nx]).toBeLessThanOrEqual(r.height[c] + 1e-3);
        c = nx;
        if (r.water[c] === WATER.ocean) break;
      }
      const x = c % w;
      const y = Math.floor(c / w);
      const atEdge = x === 0 || y === 0 || x === w - 1 || y === h - 1;
      expect(r.water[c] === WATER.ocean || atEdge).toBe(true);
    }
    expect(rivers).toBeGreaterThan(50);
  });

  it('rivers join rather than split (each cell has one receiver)', () => {
    expect(r.flowTo.length).toBe(r.grid.w * r.grid.h);
  });

  it('is deterministic', () => {
    const r2 = generate(small(4242));
    expect(r2.height).toEqual(r.height);
  });
});

describe('user features', () => {
  const doc = withLand(small(99), 100, 100, 700, 500);
  const crest: Vec[] = [
    [250, 150],
    [400, 300],
    [550, 450],
  ];
  doc.ridges.push({ id: 'r1', name: 'Spine', points: crest, heightM: 2200, widthKm: 50 });
  doc.rivers.push({
    id: 'v1',
    name: 'Long River',
    points: [
      [200, 400],
      [150, 470],
      [60, 520],
    ],
    valleyWidthKm: 6,
  });
  const r = generate(doc);

  it('keeps a drawn ridge high along its whole length', () => {
    for (let t = 0.1; t <= 0.9; t += 0.1) {
      const k = t < 0.5 ? t * 2 : (t - 0.5) * 2;
      const [a, b] = t < 0.5 ? [crest[0], crest[1]] : [crest[1], crest[2]];
      const p: Vec = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
      expect(r.height[cellAt(r.grid, p)]).toBeGreaterThan(900);
    }
  });

  it('no river crosses the ridge crest', () => {
    const { w, h } = r.grid;
    for (let i = 0; i < w * h; i++) {
      if (!r.river[i] || r.flowTo[i] < 0) continue;
      const a = cellPos(r, i);
      const b = cellPos(r, r.flowTo[i]);
      for (let k = 1; k < crest.length; k++) expect(segmentsCross(a, b, crest[k - 1], crest[k])).toBe(false);
    }
  });

  it('a drawn river is a river along its course', () => {
    // Exactly through every clicked point...
    for (const p of [
      [200, 400],
      [150, 470],
    ] as Vec[]) {
      expect(r.river[cellAt(r.grid, p)]).toBe(1);
    }
    // ...and close to the straight line between them (it meanders a little).
    for (const p of [
      [175, 435],
      [105, 495],
    ] as Vec[]) {
      let near = false;
      for (let dy = -8; dy <= 8; dy += 2) for (let dx = -8; dx <= 8; dx += 2) if (r.river[cellAt(r.grid, [p[0] + dx, p[1] + dy])]) near = true;
      expect(near).toBe(true);
    }
  });
});

describe('facts about places', () => {
  it('shapes terrain so fixed towns get their sites', () => {
    const doc = withLand(small(7), 150, 120, 650, 480);
    doc.places.push(
      { id: 'a', name: 'Rivertown', kind: 'town', mode: 'fixed', pos: [380, 260], sites: ['river'] },
      { id: 'b', name: 'Port', kind: 'city', mode: 'fixed', pos: [420, 330], sites: ['coast'] },
      { id: 'c', name: 'Eyrie', kind: 'fort', mode: 'fixed', pos: [250, 200], sites: ['mountains'] },
      { id: 'd', name: 'Meadow', kind: 'village', mode: 'fixed', pos: [550, 400], sites: ['plain'] },
    );
    const r = generate(doc);
    for (const p of r.places.filter((p) => p.mode !== 'auto')) expect(p.unmetSites, p.name).toEqual([]);
  });

  it('raises mountains between two fixed towns when asked', () => {
    const doc = withLand(small(31), 100, 100, 700, 500);
    doc.settings.mountainousness = 0;
    doc.places.push(
      { id: 'a', name: 'West', kind: 'city', mode: 'fixed', pos: [250, 300], sites: [] },
      { id: 'b', name: 'East', kind: 'city', mode: 'fixed', pos: [520, 300], sites: [] },
    );
    doc.constraints.push({ id: 'k', type: 'mountainsBetween', a: 'a', b: 'b' });
    const r = generate(doc);
    expect(r.report[0].ok, r.report[0].message).toBe(true);
  });

  it('puts two fixed towns on the same river', () => {
    const doc = withLand(small(55), 100, 100, 700, 500);
    doc.places.push(
      { id: 'a', name: 'Upton', kind: 'town', mode: 'fixed', pos: [300, 220], sites: [] },
      { id: 'b', name: 'Downton', kind: 'town', mode: 'fixed', pos: [380, 330], sites: [] },
    );
    doc.constraints.push({ id: 'k', type: 'sameRiver', a: 'a', b: 'b' });
    const r = generate(doc);
    expect(r.report[0].ok, r.report[0].message).toBe(true);
  });

  it('places free towns to satisfy distance and site rules', () => {
    const doc = withLand(small(5), 100, 100, 700, 500);
    doc.places.push(
      { id: 'cap', name: 'Capital', kind: 'city', mode: 'fixed', pos: [400, 300], sites: [] },
      { id: 'f1', name: 'Ferry', kind: 'town', mode: 'free', sites: ['river'] },
      { id: 'f2', name: 'Harbour', kind: 'town', mode: 'free', sites: ['coast'] },
      { id: 'f3', name: 'Outpost', kind: 'fort', mode: 'free', sites: [] },
    );
    doc.constraints.push(
      { id: 'k1', type: 'distance', a: 'cap', b: 'f1', minKm: 60, maxKm: 120 },
      { id: 'k2', type: 'distance', a: 'cap', b: 'f2', maxKm: 250 },
      { id: 'k3', type: 'distance', a: 'f1', b: 'f3', minKm: 150, maxKm: 220 },
    );
    const r = generate(doc);
    for (const s of r.report) expect(s.ok, s.message).toBe(true);
    for (const p of r.places.filter((p) => p.mode !== 'auto')) expect(p.unmetSites, p.name).toEqual([]);
  });
});

describe('serialisation', () => {
  it('round-trips paint and lock data', () => {
    const doc = withLand(small(1), 200, 200, 400, 400);
    doc.paint.lock.data[123] = 1;
    doc.lockHeights = { w: doc.paint.lock.w, h: doc.paint.lock.h, data: new Float32Array(doc.paint.lock.data.length).fill(321) };
    const back = deserialize(serialize(doc));
    expect(back.paint.landSea.data).toEqual(doc.paint.landSea.data);
    expect(back.paint.lock.data[123]).toBe(1);
    expect(back.lockHeights!.data[5]).toBe(321);
  });
});

describe('many facts at once', () => {
  // A deliberately crowded brief: every kind of site plus all rule types.
  for (const seed of [1, 2, 3, 4]) {
    it(`satisfies everything for seed ${seed}`, () => {
      const doc = withLand(small(seed), 150, 120, 650, 480);
      doc.places.push(
        { id: 'a', name: 'Rivertown', kind: 'town', mode: 'fixed', pos: [380, 260], sites: ['river'] },
        { id: 'b', name: 'Port', kind: 'city', mode: 'fixed', pos: [420, 330], sites: ['coast', 'riverMouth'] },
        { id: 'c', name: 'Eyrie', kind: 'fort', mode: 'fixed', pos: [250, 200], sites: ['ridge'] },
        { id: 'd', name: 'Meadow', kind: 'village', mode: 'fixed', pos: [550, 400], sites: ['plain'] },
        { id: 'e', name: 'Glen', kind: 'village', mode: 'fixed', pos: [300, 400], sites: ['valley'] },
        { id: 'f', name: 'Forks', kind: 'town', mode: 'fixed', pos: [480, 200], sites: ['confluence'] },
        { id: 'g', name: 'Hilltop', kind: 'village', mode: 'free', sites: ['hills'] },
        { id: 'h', name: 'Ferry', kind: 'village', mode: 'free', sites: ['river'] },
      );
      doc.constraints.push(
        { id: 'k1', type: 'mountainsBetween', a: 'd', b: 'a' },
        { id: 'k2', type: 'distance', a: 'g', b: 'a', minKm: 50, maxKm: 100 },
        { id: 'k3', type: 'sameRiver', a: 'h', b: 'f' },
      );
      const r = generate(doc);
      for (const p of r.places.filter((p) => p.mode !== 'auto')) expect(p.unmetSites, p.name).toEqual([]);
      for (const s of r.report) expect(s.ok, s.message).toBe(true);
    });
  }
});

describe('iterating', () => {
  it('locked terrain survives a reroll of the seed', () => {
    const doc = small(11);
    const first = generate(doc);
    const { w, h } = first.grid;
    const lock = doc.paint.lock;
    for (let y = 0; y < h; y++) for (let x = 0; x < w / 2; x++) lock.data[y * w + x] = 1;
    doc.lockHeights = { w, h, data: first.baseHeight.slice() };
    doc.seed = 12345;
    const second = generate(doc);
    let same = 0;
    let total = 0;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w / 2 - 2; x++) {
        const i = y * w + x;
        total++;
        if (Math.abs(second.baseHeight[i] - first.baseHeight[i]) < 1) same++;
      }
    expect(same / total).toBeGreaterThan(0.98);
    // The unlocked half did change.
    let diff = 0;
    for (let i = 0; i < w * h; i++) if (i % w > w / 2 + 3 && Math.abs(second.baseHeight[i] - first.baseHeight[i]) > 1) diff++;
    expect(diff).toBeGreaterThan(1000);
  });

  it('floating places stay put when something unrelated changes', () => {
    const doc = withLand(small(21), 100, 100, 700, 500);
    doc.places.push(
      { id: 'a', name: 'A', kind: 'town', mode: 'free', sites: ['river'] },
      { id: 'b', name: 'B', kind: 'town', mode: 'free', sites: [] },
    );
    doc.constraints.push({ id: 'k', type: 'distance', a: 'a', b: 'b', minKm: 80, maxKm: 150 });
    const first = generate(doc);
    for (const p of first.places) if (p.mode === 'free') doc.hints[p.id] = p.pos;
    // An edit far from both towns.
    const posA = first.places.find((p) => p.id === 'a')!.pos;
    const far: [number, number] = posA[0] < 400 ? [650, 450] : [150, 150];
    doc.ridges.push({ id: 'r', name: 'Far', points: [far, [far[0] + 20, far[1] - 30]], heightM: 1500, widthKm: 20 });
    const second = generate(doc);
    for (const id of ['a', 'b']) {
      const p1 = first.places.find((p) => p.id === id)!.pos;
      const p2 = second.places.find((p) => p.id === id)!.pos;
      expect(Math.hypot(p1[0] - p2[0], p1[1] - p2[1])).toBeLessThan(10);
    }
    expect(second.report[0].ok).toBe(true);
  });
});
