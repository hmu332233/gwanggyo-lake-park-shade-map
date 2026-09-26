/**
 * Gwanggyo Lake Park (광교호수공원) project constants.
 * Single-site project: everything is anchored on this one location.
 */

/** Approximate center of Gwanggyo Lake Park (between Wonchon and Sindae reservoirs). */
export const GWANGGYO_CENTER: [number, number] = [127.0665, 37.2835]; // [lng, lat]

/** Data extraction bbox: park + ~300-500 m ring of surrounding apartments. */
export const GWANGGYO_BBOX = {
  south: 37.25,
  west: 127.03,
  north: 37.31,
  east: 127.10,
};

/** Ring around the park used to collect shadow casters; walking paths are clipped to the park. */
export const AOI_BUFFER_M = 500;

/**
 * Building shadow filter (scripts/fetch-osm.ts): keep a building only if one of its shadows on these
 * dates (07:00–19:00, every SHADOW_FILTER_STEP_MIN minutes) touches the park polygon.
 * Summer/winter solstice + autumn equinox cover the shortest and longest shadow geometries.
 */
export const SHADOW_FILTER_DATES = ["2026-06-21", "2026-09-22", "2026-12-21"];
export const SHADOW_FILTER_STEP_MIN = 30;

/** Park bounding box (from OSM way 480953426) used for the initial camera. */
export const GWANGGYO_PARK_BOUNDS: [[number, number], [number, number]] = [
  [127.0583, 37.2731],
  [127.0788, 37.2935],
];

export const INITIAL_ZOOM = 14.6;

/** Meters of height assumed per floor when only building:levels is available. */
export const METERS_PER_LEVEL = 3;

/** Default heights (m) when no height/levels tag exists, by OSM building type. */
export const DEFAULT_HEIGHT_BY_TYPE: Record<string, number> = {
  apartments: 45,
  residential: 12,
  house: 8,
  detached: 8,
  commercial: 15,
  retail: 12,
  office: 24,
  school: 15,
  hospital: 20,
  church: 12,
  garage: 3,
  garages: 3,
  shed: 3,
  hut: 3,
  roof: 4,
  greenhouse: 4,
  industrial: 10,
  warehouse: 10,
  public: 12,
  civic: 12,
  university: 20,
  hotel: 40,
  dormitory: 24,
  kindergarten: 8,
  toilets: 3,
  service: 4,
};
export const DEFAULT_HEIGHT_FALLBACK = 10;

/** Defaults for vegetation / park structures when OSM has no height tags. */
export const TREE_DEFAULTS = { height: 8, crownRadius: 3 }; // typical mature street tree
export const CANOPY_DEFAULT_HEIGHT_M = 12; // wood / forest stands
export const STRUCTURE_DEFAULT_HEIGHT_M: Record<string, number> = {
  pavilion: 3.5,
  pergola: 3,
  bridge: 5,
  shade_sail: 3,
  other: 3,
};

/**
 * Leaf fraction of deciduous canopy by day of year, piecewise linear [dayOfYear, 0..1].
 * Fitted to the 2023–2025 Sentinel-2 NDVI of the park's deciduous tall canopy
 * (`npm run fetch:leaf` prints the per-scene samples): leaf-out from early April,
 * full leaf by mid-May, leaf fall from late October, bare by early December.
 */
export const DECIDUOUS_LEAF_CURVE: [number, number][] = [
  [90, 0],
  [105, 0.5],
  [130, 1],
  [300, 1],
  [320, 0.5],
  [338, 0],
];
/** Shade of a leafless deciduous crown (branches only), relative to full leaf. Model assumption. */
export const LEAFLESS_CROWN_SHADE = 0.3;
/** Crown base as a share of tree height: the open trunk zone below lets low sun through. Model assumption. */
export const CROWN_BASE_RATIO = 0.3;

/** Sample spacing (m) along paths when measuring shade ratio. */
export const PATH_SAMPLE_STEP_M = 5;

/** Cap on shadow length so low-sun cases don't produce absurd geometry. */
export const MAX_SHADOW_LENGTH_M = 600;

/** Ignore shadows when the sun is below this altitude (radians). */
export const MIN_SUN_ALTITUDE_RAD = (0.5 * Math.PI) / 180;

export const TIME_RANGE = { startMinutes: 7 * 60, endMinutes: 19 * 60, stepMinutes: 5 };


/** Path colors shared by the map and its legend (sun → shade). */
export const PATH_SHADE_COLORS = { sun: "#f2a541", mid: "#9d8f7a", shade: "#2f5d9e" };
