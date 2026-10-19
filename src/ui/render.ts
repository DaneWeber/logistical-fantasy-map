import { boxBlur, cellCenter, DX8, DY8 } from '../engine/grid';
import { mix } from '../engine/rng';
import {
  LANDFORM_PAINT,
  LANDSEA,
  WATER,
  type PlaceKind,
  type ResolvedPlace,
  type Vec,
  type WorldDoc,
  type WorldResult,
} from '../engine/types';
import { contour } from './contours';
import {
  buildDetailData,
  elevationColor,
  hillshade,
  LAKE_RGB,
  LANDFORM_COLORS,
  nice,
  seaColor,
  TILE,
  tilePxKm,
  type DetailData,
  type TileRequest,
} from './detail';
import { drawHill, drawMountain, GlyphField } from './glyphs';
import { TileCache, tileKey, tilesFor, type Tile } from './tiles';

export interface View {
  cx: number;
  cy: number;
  /** pixels per km */
  k: number;
}

export interface Layers {
  relief: boolean;
  tint: boolean;
  contours: boolean;
  landforms: boolean;
  glyphs: boolean;
  ridges: boolean;
  rivers: boolean;
  labels: boolean;
  rules: boolean;
  features: boolean;
  autoTowns: boolean;
}

export const DEFAULT_LAYERS: Layers = {
  relief: true,
  tint: true,
  contours: true,
  landforms: false,
  glyphs: true,
  ridges: true,
  rivers: true,
  labels: true,
  rules: true,
  features: true,
  autoTowns: true,
};

export const INK = '#3e3125';
export const PAPER = '#f2ead6';
const RIVER_INK = '#3f6f95';
export { LANDFORM_COLORS };

/** Below this many screen pixels per terrain cell the coarse raster is fine. */
const DETAIL_CELL_PX = 2;

interface RiverLine {
  pts: Vec[];
  flow: number[];
  /** Ends in the sea (rather than joining another river). */
  mouth: boolean;
  bbox: [number, number, number, number];
}

/** Everything derived from one WorldResult that's expensive to rebuild per frame. */
export class Scene {
  readonly r: WorldResult;
  base!: HTMLCanvasElement;
  coast = new Path2D();
  lakeEdge = new Path2D();
  ripples: Path2D[] = [];
  minor = new Path2D();
  major = new Path2D();
  rivers: RiverLine[] = [];
  ridges = new Path2D();
  readonly detail: DetailData;
  readonly tiles: TileCache;
  readonly glyphs: GlyphField;
  private bakedFor = '';

  constructor(r: WorldResult) {
    this.r = r;
    const g = r.grid;
    const n = g.w * g.h;

    const oceanF = new Float32Array(n);
    const lakeF = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      oceanF[i] = r.water[i] === WATER.ocean ? 0 : 1;
      lakeF[i] = r.water[i] === WATER.lake ? 1 : 0;
    }
    contour(g, boxBlur(oceanF, g.w, g.h, 1), 0.5, this.coast);
    contour(g, boxBlur(lakeF, g.w, g.h, 1), 0.5, this.lakeEdge);
    const ripple = boxBlur(r.coastDist, g.w, g.h, 1);
    const step = g.cellKm * 1.2;
    for (let k = 1; k <= 3; k++) {
      const p = new Path2D();
      contour(g, ripple, -step * k, p);
      this.ripples.push(p);
    }

    const land = new Float32Array(n);
    for (let i = 0; i < n; i++) land[i] = r.water[i] === WATER.ocean ? -1 : r.height[i];
    const smooth = boxBlur(land, g.w, g.h, 1);
    let maxH = 0;
    for (let i = 0; i < n; i++) if (r.water[i] !== WATER.ocean) maxH = Math.max(maxH, r.height[i]);
    // About fifteen levels whatever the relief, so low country still shows shape.
    const iv = nice(maxH / 15);
    for (let lv = iv; lv < maxH; lv += iv) contour(g, smooth, lv, Math.round(lv / iv) % 5 === 0 ? this.major : this.minor);

    this.rivers = joinRivers(r);

    for (const line of r.ridgeLines) {
      this.ridges.moveTo(line.pts[0][0], line.pts[0][1]);
      for (const p of line.pts.slice(1)) this.ridges.lineTo(p[0], p[1]);
    }

    this.detail = buildDetailData(r);
    this.tiles = new TileCache(this.detail);
    this.glyphs = new GlyphField(r, this.tiles.field);
  }

  dispose() {
    this.tiles.dispose();
  }

  /** Raster underlay: sea, land colour, relief shading, landform tint. */
  bake(layers: Layers): HTMLCanvasElement {
    const key = `${layers.relief}${layers.tint}${layers.landforms}`;
    if (this.base && key === this.bakedFor) return this.base;
    this.bakedFor = key;
    const r = this.r;
    const g = r.grid;
    const c = document.createElement('canvas');
    c.width = g.w;
    c.height = g.h;
    const cx = c.getContext('2d')!;
    const img = cx.createImageData(g.w, g.h);
    const lf = layers.landforms ? hexMap(LANDFORM_COLORS) : null;
    for (let y = 0; y < g.h; y++) {
      for (let x = 0; x < g.w; x++) {
        const i = y * g.w + x;
        let col: number[];
        if (r.water[i] === WATER.ocean) {
          col = seaColor(-r.coastDist[i], g.cellKm);
        } else if (r.water[i] === WATER.lake) {
          col = LAKE_RGB;
        } else {
          const h = r.height[i];
          col = layers.tint ? elevationColor(h) : [242, 234, 214];
          if (lf && lf[r.landform[i]]) col = mixRGB(col, lf[r.landform[i]], 0.55);
          if (layers.relief) {
            const s = shade(r, x, y);
            col = col.map((v) => v * s);
          }
        }
        img.data[i * 4] = col[0];
        img.data[i * 4 + 1] = col[1];
        img.data[i * 4 + 2] = col[2];
        img.data[i * 4 + 3] = 255;
      }
    }
    cx.putImageData(img, 0, 0);
    this.base = c;
    return c;
  }
}

function hexMap(m: Record<number, string>): Record<number, number[]> {
  const out: Record<number, number[]> = {};
  for (const [k, v] of Object.entries(m)) out[+k] = [1, 3, 5].map((o) => parseInt(v.slice(o, o + 2), 16));
  return out;
}

function mixRGB(a: number[], b: number[], t: number): number[] {
  return a.map((v, i) => v + (b[i] - v) * t);
}

function shade(r: WorldResult, x: number, y: number): number {
  const g = r.grid;
  const H = (xx: number, yy: number) => {
    const i = Math.min(g.h - 1, Math.max(0, yy)) * g.w + Math.min(g.w - 1, Math.max(0, xx));
    return r.water[i] === WATER.ocean ? 0 : r.height[i];
  };
  const ex = 3.5 / (g.cellKm * 1000);
  return hillshade((H(x + 1, y) - H(x - 1, y)) * ex, (H(x, y + 1) - H(x, y - 1)) * ex);
}

/**
 * River polylines with each tributary's end snapped onto a vertex of the
 * river it joins, so the two still meet when drawn at street-map zoom.
 */
function joinRivers(r: WorldResult): RiverLine[] {
  const g = r.grid;
  const hash = new Map<number, { line: number; k: number }[]>();
  const cellKey = (p: Vec) => Math.floor(p[1] / g.cellKm) * g.w + Math.floor(p[0] / g.cellKm);
  r.rivers.forEach((line, li) =>
    line.pts.forEach((p, k) => {
      const c = cellKey(p);
      if (!hash.has(c)) hash.set(c, []);
      hash.get(c)!.push({ line: li, k });
    }),
  );
  return r.rivers.map((line, li) => {
    const pts = line.pts.slice();
    const flow = line.flow ? line.flow.slice() : pts.map(() => r.riverThresholdKm2);
    // A lake's outflow starts at the outlet cell; reach back into the lake so
    // it still leaves from the shore once the shore is drawn in detail.
    const headCell = Math.min(g.w * g.h - 1, Math.max(0, cellKey(pts[0])));
    if (r.water[headCell] === WATER.lake) {
      let c = headCell;
      for (let step = 0; step < 2; step++) {
        let best = -1;
        let bestN = -1;
        const x = c % g.w;
        const y = Math.floor(c / g.w);
        for (let d = 0; d < 8; d++) {
          const nx = x + DX8[d];
          const ny = y + DY8[d];
          if (nx < 0 || ny < 0 || nx >= g.w || ny >= g.h) continue;
          const ni = ny * g.w + nx;
          if (r.water[ni] !== WATER.lake) continue;
          let wet = 0;
          for (let e = 0; e < 8; e++) {
            const ex = nx + DX8[e];
            const ey = ny + DY8[e];
            if (ex >= 0 && ey >= 0 && ex < g.w && ey < g.h && r.water[ey * g.w + ex] === WATER.lake) wet++;
          }
          if (wet > bestN) {
            bestN = wet;
            best = ni;
          }
        }
        if (best < 0) break;
        pts.unshift(cellCenter(g, best));
        flow.unshift(flow[0]);
        c = best;
      }
    }
    const end = pts[pts.length - 1];
    const endCell = Math.min(g.w * g.h - 1, Math.max(0, cellKey(end)));
    const mouth = r.water[endCell] === WATER.ocean;
    if (!mouth) {
      let best: Vec | null = null;
      let bd = g.cellKm * 1.5;
      const cx = Math.floor(end[0] / g.cellKm);
      const cy = Math.floor(end[1] / g.cellKm);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          for (const h of hash.get((cy + dy) * g.w + cx + dx) ?? []) {
            if (h.line === li) continue;
            const q = r.rivers[h.line].pts[h.k];
            const d = Math.hypot(q[0] - end[0], q[1] - end[1]);
            if (d < bd) {
              bd = d;
              best = q;
            }
          }
      if (best) {
        pts.push(best);
        flow.push(flow[flow.length - 1]);
      }
    }
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of pts) {
      x0 = Math.min(x0, p[0]);
      y0 = Math.min(y0, p[1]);
      x1 = Math.max(x1, p[0]);
      y1 = Math.max(y1, p[1]);
    }
    return { pts, flow, mouth, bbox: [x0, y0, x1, y1] };
  });
}

/**
 * Midpoint displacement between two river vertices, deterministic in world
 * position so a reach looks the same every frame and at every zoom.
 */
function refine(a: Vec, b: Vec, depth: number, out: Vec[]) {
  if (depth <= 0) {
    out.push(b);
    return;
  }
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  const h = mix(mix(Math.round(a[0] * 4096), Math.round(a[1] * 4096)), mix(Math.round(b[0] * 4096), Math.round(b[1] * 4096)));
  const off = (((h >>> 8) / 16777216) * 2 - 1) * 0.22;
  const m: Vec = [(a[0] + b[0]) / 2 - dy * off, (a[1] + b[1]) / 2 + dx * off];
  if (len < 1e-9) {
    out.push(b);
    return;
  }
  refine(a, m, depth - 1, out);
  refine(m, b, depth - 1, out);
}

// ---------------------------------------------------------------------------
// Drawing

export function worldToScreen(v: View, W: number, H: number, p: Vec): Vec {
  return [(p[0] - v.cx) * v.k + W / 2, (p[1] - v.cy) * v.k + H / 2];
}
export function screenToWorld(v: View, W: number, H: number, s: Vec): Vec {
  return [(s[0] - W / 2) / v.k + v.cx, (s[1] - H / 2) / v.k + v.cy];
}

/** Sets a transform so subsequent drawing is in km. */
function worldSpace(ctx: CanvasRenderingContext2D, v: View, W: number, H: number, dpr: number) {
  ctx.setTransform(v.k * dpr, 0, 0, v.k * dpr, (W / 2 - v.cx * v.k) * dpr, (H / 2 - v.cy * v.k) * dpr);
}

/** True once the view is zoomed in far enough to use detail tiles. */
export function detailed(scene: Scene, v: View): boolean {
  return scene.r.grid.cellKm * v.k >= DETAIL_CELL_PX;
}

/**
 * Draws the terrain. Zoomed out it's the engine's grid as is; zoomed in,
 * detail tiles (rendered in workers) take over as they arrive. `sync`
 * renders any missing tiles immediately instead (for exports).
 */
export function drawTerrain(ctx: CanvasRenderingContext2D, scene: Scene, v: View, W: number, H: number, dpr: number, layers: Layers, sync = false) {
  const r = scene.r;
  const g = r.grid;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#d9d2c0';
  ctx.fillRect(0, 0, W, H);
  const [mx0, my0] = worldToScreen(v, W, H, [0, 0]);
  const [mx1, my1] = worldToScreen(v, W, H, [g.widthKm, g.heightKm]);
  ctx.save();
  ctx.beginPath();
  ctx.rect(mx0, my0, mx1 - mx0, my1 - my0);
  ctx.clip();

  worldSpace(ctx, v, W, H, dpr);
  const px = 1 / v.k;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(scene.bake(layers), 0, 0, g.w * g.cellKm, g.h * g.cellKm);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const strokeRipples = (paths: Path2D[]) => {
    ctx.strokeStyle = 'rgba(70, 100, 120, 0.35)';
    paths.forEach((p, k) => {
      ctx.lineWidth = px * (0.9 - k * 0.2);
      ctx.globalAlpha = 1 - k * 0.28;
      ctx.stroke(p);
    });
    ctx.globalAlpha = 1;
  };
  const strokeContours = (minor: Path2D, major: Path2D, strong: boolean) => {
    if (!layers.contours) return;
    ctx.strokeStyle = strong ? 'rgba(120, 80, 45, 0.45)' : 'rgba(120, 85, 50, 0.32)';
    ctx.lineWidth = px * (strong ? 0.7 : 0.6);
    ctx.stroke(minor);
    ctx.strokeStyle = strong ? 'rgba(105, 70, 40, 0.7)' : 'rgba(110, 75, 45, 0.55)';
    ctx.lineWidth = px * (strong ? 1.1 : 1.0);
    ctx.stroke(major);
  };
  strokeRipples(scene.ripples);
  strokeContours(scene.minor, scene.major, false);

  const [vx0, vy0] = screenToWorld(v, W, H, [0, 0]);
  const [vx1, vy1] = screenToWorld(v, W, H, [W, H]);
  const tiles: Tile[] = [];
  let pxKm = 0;
  if (detailed(scene, v)) {
    const rd = Math.min(dpr, 1.5);
    const need = tilesFor(v.k, rd, vx0, vy0, vx1, vy1, g.widthKm, g.heightKm);
    pxKm = tilePxKm(need.z);
    const want: { key: string; req: TileRequest }[] = [];
    const flags = { relief: layers.relief, tint: layers.tint, landforms: layers.landforms };
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const dev = (x: number, y: number) => worldToScreen(v, W, H, [x, y]).map((q) => Math.round(q * dpr));
    for (const [tx, ty] of need.tiles) {
      const req: TileRequest = { z: need.z, tx, ty, dpr: rd, flags };
      const key = tileKey(need.z, tx, ty, flags, rd);
      const t = sync ? scene.tiles.renderNow(key, req) : scene.tiles.get(key);
      const [X0, Y0] = dev(tx * need.s, ty * need.s);
      const [X1, Y1] = dev((tx + 1) * need.s, (ty + 1) * need.s);
      if (t) {
        ctx.drawImage(t.img, X0, Y0, X1 - X0, Y1 - Y0);
        tiles.push(t);
        continue;
      }
      want.push({ key, req });
      // Meanwhile, a coarser tile that's already cached, if there is one.
      for (let m = 1; m <= 4; m++) {
        const f = 2 ** m;
        const p = scene.tiles.get(tileKey(need.z - m, tx >> m, ty >> m, flags, rd));
        if (!p) continue;
        const sub = TILE / f;
        ctx.drawImage(p.img, (tx % f) * sub, (ty % f) * sub, sub, sub, X0, Y0, X1 - X0, Y1 - Y0);
        break;
      }
    }
    if (!sync) scene.tiles.want(want);
    worldSpace(ctx, v, W, H, dpr);
    for (const t of tiles) strokeRipples(t.ripples);
    for (const t of tiles) strokeContours(t.minor, t.major, true);
  }

  if (layers.ridges) {
    ctx.strokeStyle = 'rgba(80, 55, 35, 0.75)';
    ctx.lineWidth = px * 1.4;
    ctx.setLineDash([px * 5, px * 2.5]);
    ctx.stroke(scene.ridges);
    ctx.setLineDash([]);
  }

  if (layers.glyphs) drawGlyphs(ctx, scene, v, W, H, dpr, layers.labels);

  worldSpace(ctx, v, W, H, dpr);
  if (layers.rivers) drawRivers(ctx, scene, v, [vx0, vy0, vx1, vy1], pxKm);

  // Zoomed in, shorelines come from the tiles (a tile still loading shows
  // the coarse raster without one, briefly).
  const coarse = pxKm === 0;
  ctx.strokeStyle = RIVER_INK;
  ctx.lineWidth = px * 1;
  if (coarse) ctx.stroke(scene.lakeEdge);
  for (const t of tiles) ctx.stroke(t.lake);
  ctx.strokeStyle = INK;
  ctx.lineWidth = px * 1.6;
  if (coarse) ctx.stroke(scene.coast);
  for (const t of tiles) ctx.stroke(t.coast);
  ctx.restore();
}

function drawGlyphs(ctx: CanvasRenderingContext2D, scene: Scene, v: View, W: number, H: number, dpr: number, labels: boolean) {
  const cellPx = scene.r.grid.cellKm * v.k;
  // Symbols grow a little in close-up views, where there's room for them.
  const size = Math.min(13, 7.5 + 1.5 * Math.log2(Math.max(1, cellPx / 2)));
  const L = scene.glyphs.levelFor(v.k, size * 2.6);
  const m = (size * 3) / v.k;
  const [x0, y0] = screenToWorld(v, W, H, [0, 0]);
  const [x1, y1] = screenToWorld(v, W, H, [W, H]);
  const list = scene.glyphs.visible(L, x0 - m, y0 - m, x1 + m, y1 + m * 2);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const paper = 'rgba(242, 234, 214, 0.9)';
  for (const gl of list) {
    const [sx, sy] = worldToScreen(v, W, H, [gl.x, gl.y]);
    if (gl.kind === 'mountain') drawMountain(ctx, sx, sy + size * 0.4, size, gl, INK, paper);
    else drawHill(ctx, sx, sy + size * 0.3, size * 0.95, gl, INK, 'rgba(242, 234, 214, 0.6)');
  }
  // Spot heights on the most prominent summits once there's room to read them.
  if (labels && cellPx >= 8) {
    ctx.font = 'italic 10px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const gl of list) {
      if (gl.kind !== 'mountain' || gl.level > L - 3) continue;
      const [sx, sy] = worldToScreen(v, W, H, [gl.x, gl.y]);
      const t = `${Math.round(gl.heightM / 10) * 10}`;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(242, 234, 214, 0.85)';
      ctx.strokeText(t, sx, sy + size * 0.6);
      ctx.fillStyle = '#5a3c25';
      ctx.fillText(t, sx, sy + size * 0.6);
    }
  }
}

function drawRivers(ctx: CanvasRenderingContext2D, scene: Scene, v: View, view: number[], pxKm: number) {
  const r = scene.r;
  const g = r.grid;
  const marg = g.cellKm;
  const [x0, y0, x1, y1] = [view[0] - marg, view[1] - marg, view[2] + marg, view[3] + marg];
  // Subdivide until segments are a few pixels long.
  const depth = Math.max(0, Math.min(8, Math.ceil(Math.log2((g.cellKm * 0.5 * v.k) / 4))));
  const buckets = new Map<number, Path2D>();
  const field = scene.tiles.field;
  for (const line of scene.rivers) {
    const b = line.bbox;
    if (b[2] < x0 || b[0] > x1 || b[3] < y0 || b[1] > y1) continue;
    const { pts, flow } = line;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const c = pts[i];
      if (Math.max(a[0], c[0]) < x0 || Math.min(a[0], c[0]) > x1 || Math.max(a[1], c[1]) < y0 || Math.min(a[1], c[1]) > y1) continue;
      const f = flow[i];
      const thin = Math.min(3.5, 0.7 + 0.8 * Math.log2(1 + f / r.riverThresholdKm2));
      // Up close a big river is drawn at a plausible true width.
      const trueW = (Math.sqrt(f) / 1000) * v.k;
      const wpx = Math.round(Math.max(thin, trueW) * 2) / 2;
      let p = buckets.get(wpx);
      if (!p) buckets.set(wpx, (p = new Path2D()));
      const seg: Vec[] = [a];
      refine(a, c, depth, seg);
      for (let k = 0; k < seg.length; k++) seg[k] = field.riverWarp(seg[k][0], seg[k][1]);
      // Stop where the detailed coastline is, rather than at a cell centre.
      if (line.mouth && pxKm > 0 && i >= pts.length - 3) {
        for (let k = 1; k < seg.length; k++) {
          if (field.sea(seg[k][0], seg[k][1], pxKm) >= 0) continue;
          let lo = seg[k - 1];
          let hi = seg[k];
          if (field.sea(lo[0], lo[1], pxKm) < 0) {
            seg.length = k;
            break;
          }
          for (let it = 0; it < 12; it++) {
            const mid: Vec = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2];
            if (field.sea(mid[0], mid[1], pxKm) >= 0) lo = mid;
            else hi = mid;
          }
          seg.length = k;
          seg.push(hi);
          break;
        }
      }
      if (seg.length < 2) continue;
      // Rivers aren't drawn across open water.
      const inLake = (q: Vec) =>
        pxKm > 0 ? field.lake(q[0], q[1], pxKm) < 0 : r.water[Math.floor(q[1] / g.cellKm) * g.w + Math.floor(q[0] / g.cellKm)] === WATER.lake;
      let wet = inLake(seg[0]);
      if (!wet) p.moveTo(seg[0][0], seg[0][1]);
      for (let k = 1; k < seg.length; k++) {
        const w2 = inLake(seg[k]);
        if (!w2 && wet) p.moveTo(seg[k - 1][0], seg[k - 1][1]);
        if (!w2 || !wet) p.lineTo(seg[k][0], seg[k][1]);
        wet = w2;
      }
    }
  }
  ctx.strokeStyle = RIVER_INK;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const [w, p] of [...buckets].sort((a, b) => a[0] - b[0])) {
    ctx.lineWidth = w / v.k;
    ctx.stroke(p);
  }
}

// ---------------------------------------------------------------------------
// Places and labels (screen space)

export function drawPlaceIcon(ctx: CanvasRenderingContext2D, kind: PlaceKind, x: number, y: number, auto: boolean) {
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = auto ? '#6b5a48' : INK;
  ctx.fillStyle = auto ? '#6b5a48' : INK;
  ctx.beginPath();
  switch (kind) {
    case 'city':
      ctx.arc(x, y, 5.5, 0, Math.PI * 2);
      ctx.fillStyle = PAPER;
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 2.6, 0, Math.PI * 2);
      ctx.fillStyle = INK;
      ctx.fill();
      break;
    case 'town':
      ctx.arc(x, y, 3.8, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'village':
      ctx.arc(x, y, 2.8, 0, Math.PI * 2);
      ctx.fillStyle = PAPER;
      ctx.fill();
      ctx.stroke();
      break;
    case 'fort':
      ctx.rect(x - 4, y - 4, 8, 8);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x, y - 4);
      ctx.lineTo(x, y - 11);
      ctx.lineTo(x + 6, y - 9);
      ctx.lineTo(x, y - 7);
      ctx.stroke();
      break;
    case 'landmark':
      ctx.moveTo(x, y - 5.5);
      ctx.lineTo(x + 5, y + 3.5);
      ctx.lineTo(x - 5, y + 3.5);
      ctx.closePath();
      ctx.fill();
      break;
  }
}

export function drawLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, font: string, color = INK, align: CanvasTextAlign = 'left') {
  ctx.font = font;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(242, 234, 214, 0.9)';
  ctx.lineWidth = 3.5;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

export const PLACE_FONT: Record<PlaceKind, string> = {
  city: '600 14px Georgia, serif',
  town: '13px Georgia, serif',
  village: '12px Georgia, serif',
  fort: 'italic 12px Georgia, serif',
  landmark: 'italic 12px Georgia, serif',
};

export function drawPlaces(
  ctx: CanvasRenderingContext2D,
  places: ResolvedPlace[],
  v: View,
  W: number,
  H: number,
  opts: { labels: boolean; autoTowns: boolean; selected?: string; failing: Set<string> },
) {
  for (const p of places) {
    const auto = p.mode === 'auto';
    if (auto && !opts.autoTowns) continue;
    const [x, y] = worldToScreen(v, W, H, p.pos);
    if (x < -50 || y < -50 || x > W + 50 || y > H + 50) continue;
    if (p.id === opts.selected) {
      ctx.beginPath();
      ctx.arc(x, y, 11, 0, Math.PI * 2);
      ctx.strokeStyle = '#c0562b';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    if (opts.failing.has(p.id)) {
      ctx.beginPath();
      ctx.arc(x, y, 8.5, 0, Math.PI * 2);
      ctx.strokeStyle = '#c62828';
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 2]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    drawPlaceIcon(ctx, p.kind, x, y, auto);
    if (opts.labels) drawLabel(ctx, p.name, x + 9, y, PLACE_FONT[p.kind], auto ? '#5b4a39' : INK);
  }
}

/** Places a label along a polyline's middle, kept upright. */
export function drawLineLabel(ctx: CanvasRenderingContext2D, pts: Vec[], text: string, v: View, W: number, H: number, font: string, color: string) {
  if (pts.length < 2) return;
  const mid = Math.floor((pts.length - 1) / 2);
  const a = worldToScreen(v, W, H, pts[mid]);
  const b = worldToScreen(v, W, H, pts[mid + 1]);
  let ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
  if (ang > Math.PI / 2) ang -= Math.PI;
  if (ang < -Math.PI / 2) ang += Math.PI;
  ctx.save();
  ctx.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
  ctx.rotate(ang);
  drawLabel(ctx, text, 0, -9, font, color, 'center');
  ctx.restore();
}

const KM_STEPS = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000];
const MI_KM = 1.609344;

/** Scale bar in kilometres with a matching one in miles beneath it. */
export function drawScaleBar(ctx: CanvasRenderingContext2D, v: View, H: number) {
  const pick = (unitKm: number) => {
    const target = 130 / (v.k * unitKm);
    return KM_STEPS.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
  };
  const km = pick(1);
  const mi = pick(MI_KM);
  const fmt = (n: number, big: string, small: string, perBig: number) => (n < 1 ? `${Math.round(n * perBig)} ${small}` : `${n} ${big}`);
  const bars = [
    { len: km * v.k, text: fmt(km, 'km', 'm', 1000) },
    { len: mi * MI_KM * v.k, text: fmt(mi, 'mi', 'ft', 5280) },
  ];
  const x = 18;
  const y = H - 36;
  const wMax = Math.max(...bars.map((b) => b.len));
  ctx.fillStyle = 'rgba(242,234,214,0.85)';
  ctx.fillRect(x - 8, y - 18, wMax + 72, 44);
  ctx.strokeStyle = INK;
  ctx.fillStyle = INK;
  ctx.lineWidth = 1.5;
  ctx.font = '12px Georgia, serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  bars.forEach((b, k) => {
    const yy = y + k * 16;
    const dir = k === 0 ? -1 : 1;
    ctx.beginPath();
    ctx.moveTo(x, yy + 5 * dir);
    ctx.lineTo(x, yy);
    ctx.lineTo(x + b.len, yy);
    ctx.lineTo(x + b.len, yy + 5 * dir);
    ctx.moveTo(x + b.len / 2, yy);
    ctx.lineTo(x + b.len / 2, yy + 3 * dir);
    ctx.stroke();
    ctx.fillText(b.text, x + wMax + 6, yy);
  });
}

// ---------------------------------------------------------------------------
// Edit overlays

/** Semi-transparent picture of what has been painted. */
export function paintOverlay(doc: WorldDoc): HTMLCanvasElement {
  const { w, h } = doc.paint.landSea;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const cx = c.getContext('2d')!;
  const img = cx.createImageData(w, h);
  const ls = doc.paint.landSea.data;
  const lf = doc.paint.landform.data;
  const lk = doc.paint.lock.data;
  for (let i = 0; i < w * h; i++) {
    let col: number[] | null = null;
    if (ls[i] === LANDSEA.land) col = [70, 150, 60, 70];
    else if (ls[i] === LANDSEA.sea) col = [40, 90, 180, 80];
    if (lf[i] === LANDFORM_PAINT.plains) col = [230, 200, 40, 80];
    else if (lf[i] === LANDFORM_PAINT.hills) col = [220, 130, 40, 80];
    else if (lf[i] === LANDFORM_PAINT.mountains) col = [140, 70, 40, 90];
    const x = i % w;
    const y = Math.floor(i / w);
    if (lk[i] && (x + y) % 4 < 2) col = [120, 60, 160, 110];
    if (col) img.data.set(col, i * 4);
  }
  cx.putImageData(img, 0, 0);
  return c;
}

export function strokePolyline(ctx: CanvasRenderingContext2D, pts: Vec[], v: View, W: number, H: number) {
  ctx.beginPath();
  pts.forEach((p, i) => {
    const [x, y] = worldToScreen(v, W, H, p);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}
