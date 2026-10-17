import type { Rng } from './rng';
import type { SiteKind } from './types';

const STARTS = [
  'Ash', 'Bel', 'Bram', 'Cor', 'Dun', 'El', 'Fen', 'Gal', 'Har', 'Ives', 'Kel', 'Lor', 'Mar', 'Nor', 'Ost',
  'Pen', 'Quel', 'Ros', 'Sel', 'Tor', 'Ul', 'Vor', 'Wyn', 'Yar', 'Zan', 'Al', 'Bry', 'Cael', 'Dra', 'Eld',
  'Gar', 'Hal', 'Lin', 'Mor', 'Oak', 'Red', 'Stan', 'Thorn', 'Wex', 'Whit',
];
const MIDS = ['', '', '', 'a', 'e', 'i', 'o', 'en', 'er', 'in', 'an', 'el'];

const BY_SITE: Partial<Record<SiteKind, string[]>> = {
  riverMouth: ['mouth', 'haven', 'port', 'quay'],
  coast: ['haven', 'port', 'sea', 'strand', 'cliff', 'bay'],
  confluence: ['meet', 'fork', 'wick', 'ford'],
  river: ['ford', 'bridge', 'brook', 'wick', 'mill'],
  lakeshore: ['mere', 'water', 'lake'],
  mountains: ['crag', 'hold', 'peak', 'fell'],
  ridge: ['crest', 'edge', 'hold'],
  hills: ['hill', 'down', 'barrow', 'knoll'],
  valley: ['dale', 'vale', 'combe', 'glen'],
  plain: ['field', 'stead', 'ham', 'ton', 'by'],
};
const GENERIC = ['ton', 'by', 'ham', 'wick', 'stead', 'burg', 'gate', 'wall', 'moor'];

export function makeName(rng: Rng, sites: SiteKind[]): string {
  const pool = sites.length ? (BY_SITE[rng.pick(sites)] ?? GENERIC) : GENERIC;
  const end = rng.next() < 0.75 ? rng.pick(pool) : rng.pick(GENERIC);
  let mid = rng.pick(MIDS);
  const start = rng.pick(STARTS);
  if (/[aeiou]$/.test(start) && /^[aeiou]/.test(mid)) mid = '';
  if (/[aeiou]$/.test(start + mid) && /^[aeiou]/.test(end)) mid += 'n';
  return start + mid + end;
}
