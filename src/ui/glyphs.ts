// Mountain and hill symbols that stay the same size on screen at any zoom.
// They sit on a quadtree of lattices: level L has one candidate slot per
// square of side 1024 / 2^L km. A slot at a finer level keeps its parent's
// symbol if the parent falls inside it, so zooming in only ever adds
// symbols between the existing ones; nothing jumps.

import { lengthScale } from '../engine/grid';
import { mix } from '../engine/rng';
import { LANDFORM, WATER, type WorldResult } from '../engine/types';
import type { DetailField } from './detail';

export interface Glyph {
  /** km */
  x: number;
  y: number;
  /** 0 (foothill) .. 1 (highest peaks) */
  hf: number;
  heightM: number;
  kind: 'mountain' | 'hill';
  lean: number;
  /** The coarsest level this symbol appears at; lower = more prominent. */
  level: number;
  seed: number;
}

const ROOT_KM = 1024;
export const spacingKm = (L: number) => ROOT_KM / 2 ** L;

function rand(h: number): number {
  return (mix(h, 0x51ed27) >>> 8) / 16777216;
}

export class GlyphField {
  private cache = new Map<string, Glyph | null>();
  private L0: number;
  private maxH = 1;

  constructor(
    private r: WorldResult,
    private field: DetailField,
  ) {
    const g = r.grid;
    this.L0 = Math.floor(Math.log2(ROOT_KM / Math.max(g.widthKm, g.heightKm)));
    for (let i = 0; i < r.height.length; i++) if (r.water[i] === WATER.land) this.maxH = Math.max(this.maxH, r.height[i]);
  }

  /**
   * Level whose spacing is at least `minPx` screen pixels, but never finer
   * than the terrain grid: past that, a symbol would mark a mere knoll, and
   * shading and contours describe the ground better.
   */
  levelFor(k: number, minPx: number): number {
    const bySize = Math.floor(Math.log2((ROOT_KM * k) / minPx));
    const g = this.r.grid;
    const minKm = Math.max(g.cellKm * 1.5, 4 * lengthScale(g.widthKm, g.heightKm));
    const byGrid = Math.floor(Math.log2(ROOT_KM / minKm));
    return Math.max(this.L0, Math.min(bySize, byGrid));
  }

  visible(L: number, x0: number, y0: number, x1: number, y1: number): Glyph[] {
    const s = spacingKm(L);
    const out: Glyph[] = [];
    const seen = new Set<Glyph>();
    for (let j = Math.floor(y0 / s); j <= Math.floor(y1 / s); j++)
      for (let i = Math.floor(x0 / s); i <= Math.floor(x1 / s); i++) {
        const gl = this.at(L, i, j);
        if (gl && !seen.has(gl)) {
          seen.add(gl);
          out.push(gl);
        }
      }
    return out.sort((a, b) => a.y - b.y);
  }

  private at(L: number, i: number, j: number): Glyph | null {
    const key = `${L},${i},${j}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const s = spacingKm(L);
    let gl: Glyph | null = null;
    const parent = L > this.L0 ? this.at(L - 1, i >> 1, j >> 1) : null;
    if (parent && Math.floor(parent.x / s) === i && Math.floor(parent.y / s) === j) gl = parent;
    else gl = this.fresh(L, i, j, s, parent);
    this.cache.set(key, gl);
    return gl;
  }

  private fresh(L: number, i: number, j: number, s: number, parent: Glyph | null): Glyph | null {
    const g = this.r.grid;
    if (i < 0 || j < 0 || i * s > g.widthKm || j * s > g.heightKm) return null;
    const seed = mix(mix(L + 1000, i), j) >>> 0;
    const pxKm = s / 10;
    let best: { x: number; y: number; h: number; lf: number } | null = null;
    // Several tries per slot, keeping the highest: symbols land on summits.
    for (let t = 0; t < 5; t++) {
      const x = (i + 0.15 + 0.7 * rand(seed + t * 2)) * s;
      const y = (j + 0.15 + 0.7 * rand(seed + t * 2 + 1)) * s;
      if (x >= g.widthKm || y >= g.heightKm) continue;
      const c = Math.floor(y / g.cellKm) * g.w + Math.floor(x / g.cellKm);
      const lf = this.r.landform[c];
      if (lf !== LANDFORM.mountains && lf !== LANDFORM.hills) continue;
      if (this.r.water[c] !== WATER.land || this.r.river[c]) continue;
      if (this.field.sea(x, y, pxKm) < g.cellKm * 0.3 || this.field.lake(x, y, pxKm) < 0) continue;
      const h = this.field.height(x, y, pxKm);
      if (!best || h > best.h) best = { x, y, h, lf };
    }
    if (!best) return null;
    if (parent && Math.hypot(parent.x - best.x, parent.y - best.y) < s * 0.55) return null;
    const mountain = best.lf === LANDFORM.mountains;
    // Hills are drawn sparser than mountains.
    if (!mountain && rand(seed + 99) < 0.45) return null;
    return {
      x: best.x,
      y: best.y,
      hf: Math.min(1, Math.max(0, best.h / this.maxH)),
      heightM: best.h,
      kind: mountain ? 'mountain' : 'hill',
      lean: (rand(seed + 50) - 0.5) * 0.5,
      level: L,
      seed,
    };
  }
}

// ---------------------------------------------------------------------------
// Drawing (screen space, CSS pixels)

/**
 * A pen-and-ink peak: two slightly bowed flanks, a nick of a shoulder on one
 * side, the shadowed east face toned and hatched, and a short ground stroke.
 */
export function drawMountain(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, gl: Glyph, ink: string, paper: string) {
  const w = size * (0.85 + 0.25 * rand(gl.seed + 7));
  const hgt = size * (0.95 + 0.85 * gl.hf);
  const px = x + gl.lean * w;
  const py = y - hgt;
  const sh = rand(gl.seed + 3) < 0.5 ? -1 : 1;
  const shT = 0.45 + 0.2 * rand(gl.seed + 4);
  // Shoulder point on one flank.
  const fx = sh < 0 ? x - w : x + w;
  const sxp = px + (fx - px) * shT + sh * w * 0.08;
  const syp = py + (y - py) * shT - hgt * 0.1;

  const left = sh < 0 ? [x - w, y, sxp, syp] : [x - w, y];
  const right = sh > 0 ? [sxp, syp, x + w, y] : [x + w, y];
  const outline = () => {
    ctx.beginPath();
    ctx.moveTo(left[0], left[1]);
    if (left.length > 2) {
      ctx.quadraticCurveTo((left[0] + left[2]) / 2 + w * 0.05, (left[1] + left[3]) / 2, left[2], left[3]);
    }
    const lx = left.length > 2 ? left[2] : left[0];
    const ly = left.length > 2 ? left[3] : left[1];
    ctx.quadraticCurveTo((lx + px) / 2 + w * 0.06, (ly + py) / 2 + hgt * 0.04, px, py);
    if (right.length > 2) {
      ctx.quadraticCurveTo((px + right[0]) / 2 + w * 0.04, (py + right[1]) / 2 + hgt * 0.04, right[0], right[1]);
      ctx.quadraticCurveTo((right[0] + right[2]) / 2 + w * 0.05, (right[1] + right[3]) / 2, right[2], right[3]);
    } else {
      ctx.quadraticCurveTo((px + right[0]) / 2 + w * 0.06, (py + right[1]) / 2 + hgt * 0.04, right[0], right[1]);
    }
  };

  outline();
  ctx.fillStyle = paper;
  ctx.fill();

  // Shadowed east face: from the peak down to a point inside the base.
  const footX = x + w * (0.05 + 0.15 * rand(gl.seed + 9));
  ctx.beginPath();
  ctx.moveTo(px, py);
  if (right.length > 2) {
    ctx.lineTo(right[0], right[1]);
    ctx.lineTo(right[2], right[3]);
  } else ctx.lineTo(right[0], right[1]);
  ctx.lineTo(footX, y);
  ctx.closePath();
  ctx.fillStyle = 'rgba(62, 49, 37, 0.16)';
  ctx.fill();

  ctx.strokeStyle = ink;
  ctx.lineWidth = 1.15;
  outline();
  ctx.stroke();

  // Hatching on the shadow side, roughly parallel to the fall line.
  ctx.lineWidth = 0.7;
  ctx.beginPath();
  const n = size > 14 ? 4 : 3;
  for (let k = 1; k <= n; k++) {
    const t = k / (n + 1);
    const ax = px + (x + w - px) * t;
    const ay = py + (y - py) * t;
    ctx.moveTo(ax - w * 0.04, ay + hgt * 0.04);
    ctx.lineTo(ax - (ax - footX) * 0.45, ay + (y - ay) * 0.62);
  }
  // Ridge line from the summit down the middle of the massif.
  ctx.moveTo(px, py);
  ctx.quadraticCurveTo(px + w * 0.05, py + hgt * 0.5, footX, y - hgt * 0.06);
  ctx.stroke();

  // Snow line on the highest peaks.
  if (gl.hf > 0.72) {
    ctx.beginPath();
    const t = 0.3;
    ctx.moveTo(px + (x - w - px) * t, py + (y - py) * t);
    ctx.lineTo(px - w * 0.08, py + hgt * 0.22);
    ctx.lineTo(px + w * 0.06, py + hgt * 0.36);
    ctx.lineTo(px + (x + w - px) * t * 0.8, py + (y - py) * t * 0.8);
    ctx.lineWidth = 0.6;
    ctx.stroke();
  }

  // Ground stroke.
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  ctx.moveTo(x - w * 1.15, y + 0.5);
  ctx.lineTo(x - w * 0.8, y + 0.5);
  ctx.moveTo(x + w * 0.8, y + 0.5);
  ctx.lineTo(x + w * 1.2, y + 0.5);
  ctx.stroke();
}

export function drawHill(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, gl: Glyph, ink: string, paper: string) {
  const w = size * (0.95 + 0.3 * rand(gl.seed + 7));
  const hgt = size * (0.45 + 0.35 * gl.hf);
  const px = x + gl.lean * w * 0.5;
  ctx.beginPath();
  ctx.moveTo(x - w, y);
  ctx.bezierCurveTo(x - w * 0.55, y - hgt * 0.9, px - w * 0.3, y - hgt * 1.05, px, y - hgt);
  ctx.bezierCurveTo(px + w * 0.35, y - hgt * 0.95, x + w * 0.6, y - hgt * 0.7, x + w, y);
  ctx.fillStyle = paper;
  ctx.fill();
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1.05;
  ctx.stroke();
  ctx.lineWidth = 0.65;
  ctx.beginPath();
  for (let k = 0; k < 2; k++) {
    const ax = px + w * (0.3 + 0.22 * k);
    ctx.moveTo(ax, y - hgt * (0.7 - 0.25 * k));
    ctx.lineTo(ax + w * 0.05, y - hgt * (0.25 - 0.1 * k));
  }
  ctx.stroke();
}
