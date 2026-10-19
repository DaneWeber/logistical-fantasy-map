// Dev aid: renders a generated world to a PNG without the browser.
// Usage: npx vite-node scripts/preview.ts -- [seed] [out.png] [widthKm] [heightKm]
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { newDoc } from '../src/engine/doc';
import { generate } from '../src/engine/generate';
import { LANDFORM } from '../src/engine/types';

function png(w: number, h: number, rgb: Uint8Array): Buffer {
  const crcT = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc = (b: Buffer) => {
    let c = -1;
    for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (t: string, d: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t), d]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const args = process.argv.slice(2).filter((a) => a !== '--');
const seed = Number(args[0] ?? 12345);
const out = args[1] ?? 'preview.png';
const widthKm = Number(args[2] ?? 800);
const doc = newDoc(seed, { widthKm, heightKm: Number(args[3] ?? (widthKm * 3) / 4) });
const r = generate(doc);
const { w, h } = r.grid;
const S = 3;
const rgb = new Uint8Array(w * S * h * S * 3);
const colors: Record<number, number[]> = {
  [LANDFORM.ocean]: [70, 110, 160],
  [LANDFORM.lake]: [90, 140, 190],
  [LANDFORM.plain]: [150, 190, 110],
  [LANDFORM.valley]: [110, 170, 90],
  [LANDFORM.hills]: [190, 180, 120],
  [LANDFORM.mountains]: [150, 120, 100],
  [LANDFORM.plateau]: [200, 170, 140],
};
for (let y = 0; y < h * S; y++)
  for (let x = 0; x < w * S; x++) {
    const i = Math.floor(y / S) * w + Math.floor(x / S);
    let c = colors[r.landform[i]];
    const shade = Math.max(0.5, Math.min(1.2, 1 + (r.height[i] - (r.height[i - 1] ?? r.height[i])) / 120));
    c = c.map((v) => Math.min(255, v * (r.water[i] ? 1 : shade)));
    if (r.ridge[i]) c = [90, 50, 30];
    if (r.river[i] && !r.water[i]) c = [20, 60, 200];
    const o = (y * w * S + x) * 3;
    rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2];
  }
writeFileSync(out, png(w * S, h * S, rgb));
const counts = new Map<number, number>();
for (const v of r.landform) counts.set(v, (counts.get(v) ?? 0) + 1);
console.log(`${r.ms} ms, rivers ${r.rivers.length}, ridgeLines ${r.ridgeLines.length}, maxH ${Math.max(...r.height).toFixed(0)}`);
console.log([...counts].map(([k, v]) => `${Object.keys(LANDFORM)[k]}=${((v / r.landform.length) * 100).toFixed(1)}%`).join(' '));
console.log(r.warnings);
