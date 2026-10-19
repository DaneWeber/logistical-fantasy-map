import { lengthScale, makeGrid } from './grid';
import type { PaintLayer, WorldDoc, WorldSettings } from './types';

export const DEFAULT_SETTINGS: WorldSettings = {
  widthKm: 800,
  heightKm: 600,
  resolution: 320,
  seaEdges: { n: true, e: true, s: true, w: true },
  landFraction: 0.5,
  mountainousness: 0.45,
  roughness: 0.5,
  maxElevationM: 3000,
  erosion: 0.6,
  riverDensity: 0.5,
  lakes: true,
  autoTowns: 0,
  minTownSpacingKm: 20,
};

/** Sensible size for a newly drawn ridge on this map: 40 km wide, 2000 m on big maps. */
export function defaultRidge(settings: WorldSettings): { heightM: number; widthKm: number } {
  const s = lengthScale(settings.widthKm, settings.heightKm);
  const cellKm = settings.widthKm / settings.resolution;
  return {
    heightM: Math.round((2000 * Math.sqrt(s)) / 10) * 10,
    widthKm: Math.max(Math.round(40 * s * 10) / 10, Math.round(cellKm * 6 * 10) / 10),
  };
}

/** Rounds to the nearest 1, 2 or 5 × a power of ten. */
export function niceKm(v: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

/**
 * A km slider range tuned for an 800 km map, rescaled for this one. Distances
 * scale with the map's size; terrain features (`feature`) with lengthScale.
 */
export function kmRange(settings: WorldSettings, min: number, max: number, step: number, feature = false): { min: number; max: number; step: number } {
  const k = feature ? lengthScale(settings.widthKm, settings.heightKm) : Math.max(settings.widthKm, settings.heightKm) / 800;
  if (k === 1) return { min, max, step };
  const st = niceKm(step * k);
  const snap = (v: number) => Math.round(v / st) * st;
  return { min: Math.max(min === 0 ? 0 : st, snap(min * k)), max: snap(max * k), step: st };
}

export function emptyLayer(w: number, h: number): PaintLayer {
  return { w, h, data: new Uint8Array(w * h) };
}

export function newDoc(seed = Math.floor(Math.random() * 1e9), settings: Partial<WorldSettings> = {}): WorldDoc {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const g = makeGrid(s.widthKm, s.heightKm, s.resolution);
  return {
    version: 1,
    name: 'Untitled world',
    seed,
    settings: s,
    ridges: [],
    rivers: [],
    places: [],
    constraints: [],
    paint: { landSea: emptyLayer(g.w, g.h), landform: emptyLayer(g.w, g.h), lock: emptyLayer(g.w, g.h) },
    hints: {},
  };
}

export function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

/** Nearest-neighbour resample so paint survives a change of resolution or size. */
export function resampleLayer(l: PaintLayer, w: number, h: number): PaintLayer {
  if (l.w === w && l.h === h) return l;
  const out = emptyLayer(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx = Math.min(l.w - 1, Math.floor(((x + 0.5) / w) * l.w));
      const sy = Math.min(l.h - 1, Math.floor(((y + 0.5) / h) * l.h));
      out.data[y * w + x] = l.data[sy * l.w + sx];
    }
  return out;
}

/** Keeps paint layers and lock snapshot in step with the current grid. */
export function conformDoc(doc: WorldDoc): WorldDoc {
  const g = makeGrid(doc.settings.widthKm, doc.settings.heightKm, doc.settings.resolution);
  const p = doc.paint;
  if (p.landSea.w === g.w && p.landSea.h === g.h && p.landform.w === g.w && p.lock.w === g.w && p.lock.h === g.h) return doc;
  let lockHeights = doc.lockHeights;
  if (lockHeights && (lockHeights.w !== g.w || lockHeights.h !== g.h)) {
    const src = lockHeights;
    const data = new Float32Array(g.w * g.h);
    for (let y = 0; y < g.h; y++)
      for (let x = 0; x < g.w; x++) {
        const sx = Math.min(src.w - 1, Math.floor(((x + 0.5) / g.w) * src.w));
        const sy = Math.min(src.h - 1, Math.floor(((y + 0.5) / g.h) * src.h));
        data[y * g.w + x] = src.data[sy * src.w + sx];
      }
    lockHeights = { w: g.w, h: g.h, data };
  }
  return {
    ...doc,
    paint: {
      landSea: resampleLayer(p.landSea, g.w, g.h),
      landform: resampleLayer(p.landform, g.w, g.h),
      lock: resampleLayer(p.lock, g.w, g.h),
    },
    lockHeights,
  };
}

// ---------------------------------------------------------------------------
// JSON serialisation. Paint layers are run-length encoded (mostly empty);
// the lock snapshot is stored as whole metres.

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function rle(data: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < data.length; ) {
    let j = i;
    while (j < data.length && data[j] === data[i]) j++;
    out.push(data[i], j - i);
    i = j;
  }
  return out;
}
function unrle(runs: number[], n: number): Uint8Array {
  const out = new Uint8Array(n);
  let k = 0;
  for (let i = 0; i < runs.length; i += 2) {
    out.fill(runs[i], k, k + runs[i + 1]);
    k += runs[i + 1];
  }
  return out;
}

interface SerialLayer {
  w: number;
  h: number;
  rle: number[];
}

export function serialize(doc: WorldDoc): string {
  const layer = (l: PaintLayer): SerialLayer => ({ w: l.w, h: l.h, rle: rle(l.data) });
  const out = {
    ...doc,
    paint: { landSea: layer(doc.paint.landSea), landform: layer(doc.paint.landform), lock: layer(doc.paint.lock) },
    lockHeights: doc.lockHeights
      ? {
          w: doc.lockHeights.w,
          h: doc.lockHeights.h,
          int16: toB64(new Uint8Array(Int16Array.from(doc.lockHeights.data, (v) => Math.round(v)).buffer)),
        }
      : undefined,
  };
  return JSON.stringify(out);
}

export function deserialize(text: string): WorldDoc {
  const raw = JSON.parse(text);
  if (raw.version !== 1) throw new Error('Unsupported file version');
  const layer = (l: SerialLayer): PaintLayer => ({ w: l.w, h: l.h, data: unrle(l.rle, l.w * l.h) });
  const base = newDoc(raw.seed);
  const doc: WorldDoc = {
    ...base,
    ...raw,
    settings: { ...DEFAULT_SETTINGS, ...raw.settings, seaEdges: { ...DEFAULT_SETTINGS.seaEdges, ...raw.settings?.seaEdges } },
    paint: { landSea: layer(raw.paint.landSea), landform: layer(raw.paint.landform), lock: layer(raw.paint.lock) },
    lockHeights: raw.lockHeights
      ? {
          w: raw.lockHeights.w,
          h: raw.lockHeights.h,
          data: Float32Array.from(new Int16Array(fromB64(raw.lockHeights.int16).buffer)),
        }
      : undefined,
    hints: raw.hints ?? {},
  };
  return conformDoc(doc);
}
