import { describe, expect, it } from 'vitest';
import { exampleDoc } from '../src/engine/example';
import { generate } from '../src/engine/generate';
import { WATER } from '../src/engine/types';
import { buildDetailData, DetailField, renderTile, tileKm } from '../src/ui/detail';

const r = generate(exampleDoc());
const field = new DetailField(buildDetailData(r));
const g = r.grid;

describe('detail terrain', () => {
  it('agrees with the engine about land and sea away from the coast', () => {
    let wrong = 0;
    let checked = 0;
    for (let i = 0; i < g.w * g.h; i += 7) {
      if (Math.abs(r.coastDist[i]) < 2.5 * g.cellKm) continue;
      const x = ((i % g.w) + 0.5) * g.cellKm;
      const y = (Math.floor(i / g.w) + 0.5) * g.cellKm;
      const land = field.sea(x, y, 0.01) >= 0;
      if (land !== (r.water[i] !== WATER.ocean)) wrong++;
      checked++;
    }
    expect(checked).toBeGreaterThan(1000);
    expect(wrong).toBe(0);
  });

  it('stays close to engine elevation at cell centres', () => {
    let err = 0;
    let n = 0;
    for (let i = 0; i < g.w * g.h; i += 13) {
      if (r.water[i] !== WATER.land) continue;
      const x = ((i % g.w) + 0.5) * g.cellKm;
      const y = (Math.floor(i / g.w) + 0.5) * g.cellKm;
      err += Math.abs(field.height(x, y, 0.01) - r.height[i]);
      n++;
    }
    expect(err / n).toBeLessThan(60);
  });

  it('renders adjacent tiles whose contours meet at the seam', () => {
    const z = 4;
    const tx = Math.floor(450 / tileKm(z));
    const ty = Math.floor(300 / tileKm(z));
    const flags = { relief: true, tint: true, landforms: false };
    const a = renderTile(field, { z, tx, ty, dpr: 1, flags });
    const b = renderTile(field, { z, tx: tx + 1, ty, dpr: 1, flags });
    expect(a.interval).toBe(b.interval);
    // Every major-contour endpoint on A's right edge is matched by one of B's.
    const seam = (tx + 1) * tileKm(z) - 0.5 / 2 ** z;
    const ends = (s: Float32Array) => {
      const out: number[] = [];
      for (let i = 0; i < s.length; i += 2) if (Math.abs(s[i] - seam) < 1e-6) out.push(s[i + 1]);
      return out;
    };
    const ea = ends(a.major);
    const eb = ends(b.major);
    expect(ea.length).toBeGreaterThan(0);
    for (const y of ea) expect(eb.some((v) => Math.abs(v - y) < 1e-4)).toBe(true);
  });
});
