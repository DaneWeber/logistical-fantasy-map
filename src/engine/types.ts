// Shared data model. The WorldDoc is everything the map-maker has decided;
// the WorldResult is everything the generator derived from it. Regenerating
// from the same doc always gives the same result.

export type Vec = [number, number]; // km from the map's top-left corner

export const SITE_KINDS = [
  'river',
  'coast',
  'riverMouth',
  'confluence',
  'lakeshore',
  'ridge',
  'mountains',
  'hills',
  'valley',
  'plain',
] as const;
export type SiteKind = (typeof SITE_KINDS)[number];

export const SITE_LABELS: Record<SiteKind, string> = {
  river: 'on a river',
  coast: 'on the coast',
  riverMouth: 'at a river mouth',
  confluence: 'at a confluence',
  lakeshore: 'on a lakeshore',
  ridge: 'on a ridge',
  mountains: 'in mountains',
  hills: 'in hills',
  valley: 'in a valley',
  plain: 'on a plain',
};

export type PlaceKind = 'city' | 'town' | 'village' | 'fort' | 'landmark';

/**
 * fixed: exactly at `pos`; terrain is shaped to satisfy its sites.
 * near:  within `radiusKm` of `pos`; the solver picks the spot.
 * free:  anywhere; the solver picks the spot.
 */
export type PlaceMode = 'fixed' | 'near' | 'free';

export interface Place {
  id: string;
  name: string;
  kind: PlaceKind;
  mode: PlaceMode;
  pos?: Vec;
  radiusKm?: number;
  sites: SiteKind[];
}

export type Constraint =
  | { id: string; type: 'distance'; a: string; b: string; minKm?: number; maxKm?: number }
  | { id: string; type: 'mountainsBetween'; a: string; b: string }
  | { id: string; type: 'sameRiver'; a: string; b: string };

export type ConstraintType = Constraint['type'];

export interface RidgeFeature {
  id: string;
  name: string;
  points: Vec[];
  heightM: number;
  widthKm: number;
}

export interface RiverFeature {
  id: string;
  name: string;
  points: Vec[];
  /** 0 = narrow channel; larger values carve a broad valley around the river. */
  valleyWidthKm: number;
}

/** A per-cell byte layer at the terrain grid's resolution. */
export interface PaintLayer {
  w: number;
  h: number;
  data: Uint8Array;
}

export const LANDSEA = { none: 0, land: 1, sea: 2 } as const;
export const LANDFORM_PAINT = { none: 0, plains: 1, hills: 2, mountains: 3 } as const;

export interface WorldSettings {
  widthKm: number;
  heightKm: number;
  /** Terrain cells across the map's width. */
  resolution: number;
  seaEdges: { n: boolean; e: boolean; s: boolean; w: boolean };
  landFraction: number; // 0..1
  mountainousness: number; // 0..1
  roughness: number; // 0..1
  maxElevationM: number;
  erosion: number; // 0..1
  riverDensity: number; // 0..1
  lakes: boolean;
  autoTowns: number;
  minTownSpacingKm: number;
}

export interface WorldDoc {
  version: 1;
  name: string;
  seed: number;
  settings: WorldSettings;
  ridges: RidgeFeature[];
  rivers: RiverFeature[];
  places: Place[];
  constraints: Constraint[];
  paint: { landSea: PaintLayer; landform: PaintLayer; lock: PaintLayer };
  /** Elevation snapshot for locked cells (same size as paint layers). */
  lockHeights?: { w: number; h: number; data: Float32Array };
  /** Where free/near places landed last time; keeps them stable across edits. */
  hints: Record<string, Vec>;
}

export interface Grid {
  w: number;
  h: number;
  cellKm: number;
  widthKm: number;
  heightKm: number;
}

export const WATER = { land: 0, ocean: 1, lake: 2 } as const;

export const LANDFORM = {
  ocean: 0,
  lake: 1,
  plain: 2,
  valley: 3,
  hills: 4,
  mountains: 5,
  plateau: 6,
} as const;
export const LANDFORM_NAMES = ['ocean', 'lake', 'plain', 'valley', 'hills', 'mountains', 'plateau'];

export interface Polyline {
  pts: Vec[];
  /** Per-point catchment area (km²), rivers only. */
  flow?: number[];
}

export interface ResolvedPlace {
  id: string;
  name: string;
  kind: PlaceKind;
  mode: PlaceMode | 'auto';
  pos: Vec;
  sites: SiteKind[];
  /** Site requirements that the final terrain does not satisfy. */
  unmetSites: SiteKind[];
}

export interface ConstraintStatus {
  id: string;
  ok: boolean;
  message: string;
}

export interface ImplicitFeatures {
  ridges: RidgeFeature[];
  rivers: RiverFeature[];
  seaStrokes: { points: Vec[]; widthKm: number }[];
  landBlobs: { pos: Vec; radiusKm: number }[];
  landformCircles: { pos: Vec; radiusKm: number; kind: 'plains' | 'hills' }[];
  notes: string[];
}

export interface WorldResult {
  grid: Grid;
  /** Final surface elevation in metres (lake cells hold the lake level). */
  height: Float32Array;
  /** Elevation before depression filling; used to snapshot locked terrain. */
  baseHeight: Float32Array;
  water: Uint8Array;
  flowTo: Int32Array;
  catchment: Float32Array;
  river: Uint8Array;
  ridge: Uint8Array;
  landform: Uint8Array;
  coastDist: Float32Array;
  siteMask: Uint16Array;
  rivers: Polyline[];
  ridgeLines: Polyline[];
  places: ResolvedPlace[];
  report: ConstraintStatus[];
  implicit: ImplicitFeatures;
  warnings: string[];
  riverThresholdKm2: number;
  ms: number;
}
