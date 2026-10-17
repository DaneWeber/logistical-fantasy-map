import { newDoc } from './doc';
import type { WorldDoc } from './types';

/** A small worked example showing each kind of fact the tool understands. */
export function exampleDoc(): WorldDoc {
  const doc = newDoc(20261017);
  doc.name = 'The Wend Marches';
  doc.settings.autoTowns = 8;
  doc.ridges.push({
    id: 'ridge-greyspine',
    name: 'The Greyspine',
    points: [
      [440, 120],
      [470, 250],
      [455, 400],
    ],
    heightM: 2400,
    widthKm: 55,
  });
  doc.rivers.push({
    id: 'river-wend',
    name: 'River Wend',
    points: [
      [330, 110],
      [345, 230],
      [320, 300],
      [298, 362],
    ],
    valleyWidthKm: 8,
  });
  doc.places.push(
    { id: 'kingsport', name: 'Kingsport', kind: 'city', mode: 'fixed', pos: [295, 368], sites: ['riverMouth'] },
    { id: 'highwatch', name: 'Highwatch', kind: 'fort', mode: 'fixed', pos: [468, 235], sites: ['ridge'] },
    { id: 'millbrook', name: 'Millbrook', kind: 'town', mode: 'free', sites: ['river'] },
    { id: 'eastmarch', name: 'Eastmarch', kind: 'city', mode: 'near', pos: [610, 300], radiusKm: 70, sites: ['plain'] },
    { id: 'stonevale', name: 'Stonevale', kind: 'village', mode: 'free', sites: ['valley'] },
  );
  doc.constraints.push(
    { id: 'c1', type: 'distance', a: 'kingsport', b: 'millbrook', minKm: 60, maxKm: 120 },
    { id: 'c2', type: 'sameRiver', a: 'kingsport', b: 'millbrook' },
    { id: 'c3', type: 'mountainsBetween', a: 'kingsport', b: 'eastmarch' },
    { id: 'c4', type: 'distance', a: 'highwatch', b: 'eastmarch', minKm: 150 },
    { id: 'c5', type: 'distance', a: 'highwatch', b: 'stonevale', maxKm: 80 },
  );
  return doc;
}
