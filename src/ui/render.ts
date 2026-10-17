import { boxBlur } from '../engine/grid';
import { Rng } from '../engine/rng';
import {
  LANDFORM,
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
const SEA = [200, 216, 218];
const LAKE = [186, 210, 220];
const RIVER_INK = '#3f6f95';

export const LANDFORM_COLORS: Record<number, string> = {
  [LANDFORM.plain]: '#e9dc8a',
  [LANDFORM.valley]: '#8fcf8a',
  [LANDFORM.hills]: '#e2a95e',
  [LANDFORM.mountains]: '#a8704f',
  [LANDFORM.plateau]: '#c49ad6',
};

interface Glyph {
  x: number;
  y: number;
  s: number;
  hgt: number;
  kind: 'mountain' | 'hill';
  lean: number;
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
  rivers: { width: number; path: Path2D }[] = [];
  ridges = new Path2D();
  glyphs: Glyph[] = [];
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
    const step = Math.max(2.5, g.cellKm * 1.3);
    for (let k = 1; k <= 3; k++) {
      const p = new Path2D();
      contour(g, ripple, -step * k, p);
      this.ripples.push(p);
    }

    const land = new Float32Array(n);
    for (let i = 0; i < n; i++) land[i] = r.water[i] === WATER.ocean ? -1 : r.height[i];
    const smooth = boxBlur(land, g.w, g.h, 1);
    let maxH = 0;
    for (let i = 0; i < n; i++) maxH = Math.max(maxH, r.height[i]);
    for (let lv = 200; lv < maxH; lv += 200) contour(g, smooth, lv, lv % 1000 === 0 ? this.major : this.minor);

    const buckets = new Map<number, Path2D>();
    for (const line of r.rivers) {
      const { pts, flow } = line;
      for (let i = 1; i < pts.length; i++) {
        const f = flow ? flow[i] : r.riverThresholdKm2;
        const wpx = Math.round((0.7 + 0.9 * Math.log2(1 + f / r.riverThresholdKm2)) * 2) / 2;
        let p = buckets.get(wpx);
        if (!p) buckets.set(wpx, (p = new Path2D()));
        p.moveTo(pts[i - 1][0], pts[i - 1][1]);
        p.lineTo(pts[i][0], pts[i][1]);
      }
    }
    this.rivers = [...buckets].sort((a, b) => a[0] - b[0]).map(([width, path]) => ({ width, path }));

    for (const line of r.ridgeLines) {
      this.ridges.moveTo(line.pts[0][0], line.pts[0][1]);
      for (const p of line.pts.slice(1)) this.ridges.lineTo(p[0], p[1]);
    }

    this.glyphs = placeGlyphs(r);
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
          const deep = Math.min(1, -r.coastDist[i] / 60);
          col = SEA.map((v) => v - 14 * deep);
        } else if (r.water[i] === WATER.lake) {
          col = LAKE;
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

const RAMP: [number, number[]][] = [
  [0, [228, 230, 196]],
  [300, [236, 232, 200]],
  [800, [232, 218, 182]],
  [1500, [214, 192, 160]],
  [2300, [206, 190, 176]],
  [3200, [246, 244, 240]],
];
function elevationColor(h: number): number[] {
  for (let k = 1; k < RAMP.length; k++) {
    if (h <= RAMP[k][0]) {
      const t = (h - RAMP[k - 1][0]) / (RAMP[k][0] - RAMP[k - 1][0]);
      return mixRGB(RAMP[k - 1][1], RAMP[k][1], Math.max(0, t));
    }
  }
  return RAMP[RAMP.length - 1][1];
}

function shade(r: WorldResult, x: number, y: number): number {
  const g = r.grid;
  const H = (xx: number, yy: number) => {
    const i = Math.min(g.h - 1, Math.max(0, yy)) * g.w + Math.min(g.w - 1, Math.max(0, xx));
    return r.water[i] === WATER.ocean ? 0 : r.height[i];
  };
  const ex = 3.5 / (g.cellKm * 1000);
  const dx = (H(x + 1, y) - H(x - 1, y)) * ex;
  const dy = (H(x, y + 1) - H(x, y - 1)) * ex;
  // Light from the north-west, as on most maps.
  const nl = Math.hypot(dx, dy, 2);
  const L = [-0.55, -0.55, 0.63];
  const d = (-dx * L[0] - dy * L[1] + 2 * L[2]) / nl;
  return Math.max(0.62, Math.min(1.08, 0.38 + 0.72 * d));
}

function placeGlyphs(r: WorldResult): Glyph[] {
  const g = r.grid;
  const n = g.w * g.h;
  const rng = new Rng(97531);
  const spacing = Math.max(6, Math.max(g.widthKm, g.heightKm) / 85);
  const cell = spacing;
  const hash = new Map<string, Vec[]>();
  const key = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  const free = (x: number, y: number, d: number) => {
    const bx = Math.floor(x / cell);
    const by = Math.floor(y / cell);
    for (let j = -2; j <= 2; j++)
      for (let i = -2; i <= 2; i++) {
        for (const p of hash.get(`${bx + i},${by + j}`) ?? []) if (Math.hypot(p[0] - x, p[1] - y) < d) return false;
      }
    return true;
  };
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  // Highest cells first, so peaks claim space before foothills.
  order.sort((a, b) => r.height[b] - r.height[a]);
  const out: Glyph[] = [];
  for (const i of order) {
    const lf = r.landform[i];
    if (lf !== LANDFORM.mountains && lf !== LANDFORM.hills) continue;
    if (r.river[i] || r.water[i] !== WATER.land) continue;
    const mountain = lf === LANDFORM.mountains;
    const x = ((i % g.w) + rng.next()) * g.cellKm;
    const y = (Math.floor(i / g.w) + rng.next()) * g.cellKm;
    const d = mountain ? spacing : spacing * 1.35;
    if (!free(x, y, d)) continue;
    const hf = Math.min(1, Math.max(0, (r.height[i] - 600) / 2200));
    const s = mountain ? spacing * (0.62 + 0.35 * hf) : spacing * 0.55;
    out.push({ x, y, s, hgt: mountain ? s * (0.9 + 0.7 * hf) : s * 0.5, kind: mountain ? 'mountain' : 'hill', lean: rng.range(-0.25, 0.25) });
    const k = key(x, y);
    if (!hash.has(k)) hash.set(k, []);
    hash.get(k)!.push([x, y]);
  }
  out.sort((a, b) => a.y - b.y);
  return out;
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

export function drawTerrain(ctx: CanvasRenderingContext2D, scene: Scene, v: View, W: number, H: number, dpr: number, layers: Layers) {
  const r = scene.r;
  const g = r.grid;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#d9d2c0';
  ctx.fillRect(0, 0, W, H);
  worldSpace(ctx, v, W, H, dpr);
  const px = 1 / v.k;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(scene.bake(layers), 0, 0, g.w * g.cellKm, g.h * g.cellKm);

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(70, 100, 120, 0.35)';
  scene.ripples.forEach((p, k) => {
    ctx.lineWidth = px * (0.9 - k * 0.2);
    ctx.globalAlpha = 1 - k * 0.28;
    ctx.stroke(p);
  });
  ctx.globalAlpha = 1;

  if (layers.contours) {
    ctx.strokeStyle = 'rgba(120, 85, 50, 0.32)';
    ctx.lineWidth = px * 0.6;
    ctx.stroke(scene.minor);
    ctx.strokeStyle = 'rgba(110, 75, 45, 0.55)';
    ctx.lineWidth = px * 1.0;
    ctx.stroke(scene.major);
  }

  if (layers.ridges) {
    ctx.strokeStyle = 'rgba(80, 55, 35, 0.75)';
    ctx.lineWidth = px * 1.4;
    ctx.setLineDash([px * 5, px * 2.5]);
    ctx.stroke(scene.ridges);
    ctx.setLineDash([]);
  }

  if (layers.glyphs) {
    const [x0, y0] = screenToWorld(v, W, H, [-40, -40]);
    const [x1, y1] = screenToWorld(v, W, H, [W + 40, H + 40]);
    ctx.lineWidth = px * 1.1;
    ctx.strokeStyle = INK;
    for (const gl of scene.glyphs) {
      if (gl.x < x0 || gl.x > x1 || gl.y < y0 || gl.y > y1) continue;
      drawGlyph(ctx, gl, px);
    }
  }

  if (layers.rivers) {
    ctx.strokeStyle = RIVER_INK;
    for (const b of scene.rivers) {
      ctx.lineWidth = px * b.width;
      ctx.stroke(b.path);
    }
  }
  ctx.strokeStyle = RIVER_INK;
  ctx.lineWidth = px * 1;
  ctx.stroke(scene.lakeEdge);

  ctx.strokeStyle = INK;
  ctx.lineWidth = px * 1.6;
  ctx.stroke(scene.coast);
}

function drawGlyph(ctx: CanvasRenderingContext2D, gl: Glyph, px: number) {
  const { x, y, s, hgt } = gl;
  ctx.beginPath();
  if (gl.kind === 'mountain') {
    const peakX = x + gl.lean * s;
    const peakY = y - hgt;
    ctx.moveTo(x - s, y);
    ctx.lineTo(peakX, peakY);
    ctx.lineTo(x + s, y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(242, 234, 214, 0.92)';
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x - s, y);
    ctx.lineTo(peakX, peakY);
    ctx.lineTo(x + s, y);
    ctx.stroke();
    // Hatching on the shadow (east) face.
    ctx.beginPath();
    ctx.lineWidth = px * 0.7;
    for (let k = 1; k <= 3; k++) {
      const t = k / 4;
      const sx = peakX + (x + s - peakX) * t;
      const sy = peakY + (y - peakY) * t;
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx - (sx - peakX) * 0.55, y - (y - sy) * 0.15);
    }
    ctx.stroke();
    ctx.lineWidth = px * 1.1;
  } else {
    ctx.moveTo(x - s, y);
    ctx.quadraticCurveTo(x, y - hgt * 2, x + s, y);
    ctx.fillStyle = 'rgba(242, 234, 214, 0.6)';
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x - s, y);
    ctx.quadraticCurveTo(x, y - hgt * 2, x + s, y);
    ctx.stroke();
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

export function drawScaleBar(ctx: CanvasRenderingContext2D, v: View, H: number) {
  const target = 140 / v.k;
  const nice = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
  const len = nice * v.k;
  const x = 18;
  const y = H - 22;
  ctx.fillStyle = 'rgba(242,234,214,0.85)';
  ctx.fillRect(x - 8, y - 20, len + 60, 32);
  ctx.strokeStyle = INK;
  ctx.fillStyle = INK;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, y - 5);
  ctx.lineTo(x, y);
  ctx.lineTo(x + len, y);
  ctx.lineTo(x + len, y - 5);
  ctx.moveTo(x + len / 2, y);
  ctx.lineTo(x + len / 2, y - 3);
  ctx.stroke();
  ctx.font = '12px Georgia, serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(`${nice} km`, x + len + 6, y);
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
