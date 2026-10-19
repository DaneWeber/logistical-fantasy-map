// Detail tiles for zoomed-in views: requested per frame, rendered in a pool
// of workers, cached (LRU) per scene. A view first draws whatever tiles are
// ready, falling back to a coarser cached tile, then to the base raster.

import { DetailField, renderTile, TILE, tileKm, type DetailData, type TileFlags, type TileRequest } from './detail';

export interface Tile {
  z: number;
  tx: number;
  ty: number;
  img: CanvasImageSource;
  coast: Path2D;
  lake: Path2D;
  ripples: Path2D[];
  minor: Path2D;
  major: Path2D;
}

function segPath(a: Float32Array): Path2D {
  const p = new Path2D();
  for (let i = 0; i < a.length; i += 4) {
    p.moveTo(a[i], a[i + 1]);
    p.lineTo(a[i + 2], a[i + 3]);
  }
  return p;
}

interface Vectors {
  coast: Float32Array;
  lake: Float32Array;
  ripples: Float32Array[];
  minor: Float32Array;
  major: Float32Array;
}

function toTile(req: TileRequest, img: CanvasImageSource, v: Vectors): Tile {
  return {
    z: req.z,
    tx: req.tx,
    ty: req.ty,
    img,
    coast: segPath(v.coast),
    lake: segPath(v.lake),
    ripples: v.ripples.map(segPath),
    minor: segPath(v.minor),
    major: segPath(v.major),
  };
}

export function tileKey(z: number, tx: number, ty: number, flags: TileFlags, dpr: number): string {
  return `${z}/${tx}/${ty}/${+flags.relief}${+flags.tint}${+flags.landforms}/${dpr}`;
}

let nextId = 1;
/** The cache for the map on screen; idle workers pick up its queue. */
let active: TileCache | null = null;
const pool: { w: Worker; busy: boolean; fieldId: number }[] = [];
function workers() {
  if (!pool.length && typeof Worker !== 'undefined') {
    const n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
    for (let i = 0; i < n; i++) pool.push({ w: new Worker(new URL('./tileWorker.ts', import.meta.url), { type: 'module' }), busy: false, fieldId: -1 });
  }
  return pool;
}

export class TileCache {
  readonly id = nextId++;
  readonly field: DetailField;
  private tiles = new Map<string, Tile>();
  private pending = new Map<string, TileRequest>();
  private queue: { key: string; req: TileRequest }[] = [];
  private onReady: () => void = () => {};
  private disposed = false;

  constructor(data: DetailData) {
    this.field = new DetailField(data);
    active = this;
  }

  setListener(fn: () => void) {
    this.onReady = fn;
  }

  get(key: string): Tile | undefined {
    const t = this.tiles.get(key);
    if (t) {
      // Refresh LRU order.
      this.tiles.delete(key);
      this.tiles.set(key, t);
    }
    return t;
  }

  /** Replaces the work queue with what the current view needs, nearest first. */
  want(list: { key: string; req: TileRequest }[]) {
    // A disposed cache comes back to life if it's drawn again (React's
    // StrictMode unmounts and remounts effects in development).
    this.disposed = false;
    active = this;
    this.queue = list.filter((j) => !this.tiles.has(j.key) && !this.pending.has(j.key));
    this.pump();
  }

  /** Renders a tile on this thread (for exports). */
  renderNow(key: string, req: TileRequest): Tile {
    const have = this.tiles.get(key);
    if (have) return have;
    const out = renderTile(this.field, req);
    const c = document.createElement('canvas');
    c.width = TILE;
    c.height = TILE;
    c.getContext('2d')!.putImageData(new ImageData(out.rgba, TILE, TILE), 0, 0);
    const t = toTile(req, c, out);
    this.store(key, t);
    return t;
  }

  dispose() {
    this.disposed = true;
    if (active === this) active = null;
    this.queue = [];
    for (const t of this.tiles.values()) if (typeof ImageBitmap !== 'undefined' && t.img instanceof ImageBitmap) t.img.close();
    this.tiles.clear();
  }

  private store(key: string, t: Tile) {
    this.tiles.set(key, t);
    while (this.tiles.size > 220) {
      const [k, old] = this.tiles.entries().next().value as [string, Tile];
      if (typeof ImageBitmap !== 'undefined' && old.img instanceof ImageBitmap) old.img.close();
      this.tiles.delete(k);
    }
  }

  pump() {
    for (const wk of workers()) {
      if (wk.busy) continue;
      const job = this.queue.shift();
      if (!job) return;
      if (wk.fieldId !== this.id) {
        wk.w.postMessage({ init: { id: this.id, data: this.field.d } });
        wk.fieldId = this.id;
      }
      wk.busy = true;
      this.pending.set(job.key, job.req);
      wk.w.onmessage = (e) => {
        wk.busy = false;
        const m = e.data;
        this.pending.delete(m.key);
        if (this.disposed) {
          m.bitmap?.close?.();
          // Hand the worker to whichever cache is live now.
          active?.pump();
          return;
        }
        if (!m.stale) {
          this.store(m.key, toTile(job.req, m.bitmap, m));
          this.onReady();
        }
        this.pump();
      };
      wk.w.postMessage({ job: { id: this.id, key: job.key, req: job.req } });
    }
  }
}

/** Tile grid level and the tiles covering a view rectangle (km). */
export function tilesFor(k: number, dpr: number, x0: number, y0: number, x1: number, y1: number, maxX: number, maxY: number) {
  const z = Math.round(Math.log2(k * dpr));
  const s = tileKm(z);
  const out: [number, number][] = [];
  const tx0 = Math.max(0, Math.floor(x0 / s));
  const ty0 = Math.max(0, Math.floor(y0 / s));
  const tx1 = Math.min(Math.ceil(maxX / s) - 1, Math.floor(x1 / s));
  const ty1 = Math.min(Math.ceil(maxY / s) - 1, Math.floor(y1 / s));
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) out.push([tx, ty]);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  out.sort((a, b) => Math.hypot((a[0] + 0.5) * s - cx, (a[1] + 0.5) * s - cy) - Math.hypot((b[0] + 0.5) * s - cx, (b[1] + 0.5) * s - cy));
  return { z, s, tiles: out };
}
