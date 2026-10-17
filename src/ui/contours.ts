import type { Grid } from '../engine/types';

/**
 * Marching squares over a cell-centred field. Appends iso-line segments, in
 * km, to a Path2D-like sink. Saddles are resolved by the square's mean.
 */
export function contour(
  g: Grid,
  f: ArrayLike<number>,
  level: number,
  sink: { moveTo(x: number, y: number): void; lineTo(x: number, y: number): void },
): void {
  const { w, h, cellKm } = g;
  const k = cellKm;
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const i = y * w + x;
      const a = f[i];
      const b = f[i + 1];
      const c = f[i + w + 1];
      const d = f[i + w];
      const idx = (a > level ? 8 : 0) | (b > level ? 4 : 0) | (c > level ? 2 : 0) | (d > level ? 1 : 0);
      if (idx === 0 || idx === 15) continue;
      const x0 = (x + 0.5) * k;
      const y0 = (y + 0.5) * k;
      const t = (p: number, q: number) => (level - p) / (q - p);
      const top = () => [x0 + t(a, b) * k, y0] as const;
      const right = () => [x0 + k, y0 + t(b, c) * k] as const;
      const bottom = () => [x0 + t(d, c) * k, y0 + k] as const;
      const left = () => [x0, y0 + t(a, d) * k] as const;
      const seg = (p: readonly [number, number], q: readonly [number, number]) => {
        sink.moveTo(p[0], p[1]);
        sink.lineTo(q[0], q[1]);
      };
      const center = (a + b + c + d) / 4 > level;
      switch (idx) {
        case 1:
        case 14:
          seg(left(), bottom());
          break;
        case 2:
        case 13:
          seg(bottom(), right());
          break;
        case 3:
        case 12:
          seg(left(), right());
          break;
        case 4:
        case 11:
          seg(top(), right());
          break;
        case 6:
        case 9:
          seg(top(), bottom());
          break;
        case 7:
        case 8:
          seg(left(), top());
          break;
        case 5:
          if (center) {
            seg(left(), top());
            seg(bottom(), right());
          } else {
            seg(top(), right());
            seg(left(), bottom());
          }
          break;
        case 10:
          if (center) {
            seg(top(), right());
            seg(left(), bottom());
          } else {
            seg(left(), top());
            seg(bottom(), right());
          }
          break;
      }
    }
  }
}
