/**
 * Pure shadow-geometry functions. No MapLibre dependency so they can be unit-tested
 * and later reused for trees / canopy / structures.
 *
 * Model: a building is a vertical prism over its footprint. Its ground shadow is the
 * footprint swept along the shadow direction by shadowLength = h / tan(altitude)
 * (Minkowski sum of footprint and a segment).
 *
 *   convex footprint  -> convex hull of (footprint ∪ translated footprint)      [exact, ~µs]
 *   concave footprint -> union(footprint, translated footprint, one quad per edge) [exact]
 *
 * The union uses `polygon-clipping` directly rather than Turf's union (polyclip-ts),
 * which is ~10x slower for this workload.
 */
import polygonClipping from "polygon-clipping";
import type { Feature, MultiPolygon, Polygon, Position } from "geojson";
import { CROWN_BASE_RATIO, MAX_SHADOW_LENGTH_M, MIN_SUN_ALTITUDE_RAD } from "./config";
import { crownShade } from "./leaf";
import { offsetPosition, toPolygons } from "./geo";
import { shadowBearingDeg } from "./sun";
import type {
  BuildingCollection,
  CanopyCollection,
  CasterFlags,
  ShadeLayers,
  ShadowCollection,
  ShadowFeature,
  ShadowKind,
  StructureCollection,
  SunPosition,
  TreeCollection,
} from "../types/map";

type Ring = Position[];

/** shadowLength = h / tan(altitude), clamped. Returns 0 when the sun is too low. */
export function shadowLength(heightM: number, sunAltitudeRad: number): number {
  if (!(heightM > 0) || sunAltitudeRad <= MIN_SUN_ALTITUDE_RAD) return 0;
  const len = heightM / Math.tan(sunAltitudeRad);
  return Math.min(len, MAX_SHADOW_LENGTH_M);
}

/** Signed area (shoelace) in coordinate units. Positive = CCW. */
function signedArea(ring: Ring): number {
  let a = 0;
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return a / 2;
}

/** Andrew's monotone chain convex hull. Returns a closed CCW ring. */
export function convexHull(points: Position[]): Ring | null {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const n = pts.length;
  if (n < 3) return null;
  const cross = (o: Position, a: Position, b: Position) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Position[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Position[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  const hull = [...lower, ...upper];
  if (hull.length < 3) return null;
  hull.push(hull[0]);
  return hull;
}

function closeRing(ring: Ring): Ring {
  const f = ring[0];
  const l = ring[ring.length - 1];
  return f[0] === l[0] && f[1] === l[1] ? ring : [...ring, f];
}

/** Ratio footprint-area / hull-area. 1 = convex. */
export function convexity(ring: Ring): number {
  const closed = closeRing(ring);
  const hull = convexHull(closed);
  if (!hull) return 1;
  const a = Math.abs(signedArea(closed));
  const h = Math.abs(signedArea(hull));
  return h > 0 ? a / h : 1;
}

/** Fast path: convex hull of original + translated footprint. Exact for convex rings. */
export function hullSweep(ring: Ring, lengthM: number, bearingDeg: number): Polygon | null {
  const moved = ring.map((p) => offsetPosition(p, lengthM, bearingDeg));
  const hull = convexHull([...ring, ...moved]);
  return hull ? { type: "Polygon", coordinates: [hull] } : null;
}

/**
 * Sweep the entire polygon, including hole boundaries, so clearings the shadow does not reach stay lit.
 *
 * Every swept point p + t·v either stays inside the polygon or last leaves it through an edge whose
 * outward normal faces v. So the sweep is the polygon plus the strips swept by those front-facing
 * edges. A run of consecutive front-facing edges is monotone across v, so each run sweeps one simple
 * strip: the run followed by its translated copy in reverse. A few strips per ring replace one quad
 * per edge in the union.
 */
export function sweepPolygon(polygon: Polygon, lengthM: number, bearingDeg: number): Polygon | MultiPolygon | null {
  const rings = polygon.coordinates.filter((ring) => ring.length >= 4).map(closeRing);
  if (rings.length === 0) return null;
  if (!(lengthM > 0)) return { type: "Polygon", coordinates: rings };
  const br = (bearingDeg * Math.PI) / 180;
  const vx = Math.sin(br), vy = Math.cos(br);
  // Longitude degrees are shorter than latitude degrees; compare directions in local metres.
  const k = Math.cos((rings[0][0][1] * Math.PI) / 180);
  const pieces: Ring[][] = [rings];
  rings.forEach((ring, r) => {
    // Outer rings enclose the region on their left when counter-clockwise, holes when clockwise.
    const ccw = signedArea(ring) > 0;
    const side = (r === 0) === ccw ? 1 : -1;
    const n = ring.length - 1;
    const front = (i: number) => {
      const a = ring[i % n], b = ring[(i % n) + 1];
      return side * ((b[1] - a[1]) * vx - (b[0] - a[0]) * k * vy) > 0;
    };
    const start = [...Array(n).keys()].find((i) => front(i) && !front(i + n - 1));
    if (start === undefined) return;
    for (let i = start; i < start + n; ) {
      if (!front(i)) { i++; continue; }
      const run: Position[] = [ring[i % n]];
      while (i < start + n && front(i)) run.push(ring[(i++ % n) + 1]);
      const moved = run.map((p) => offsetPosition(p, lengthM, bearingDeg)).reverse();
      pieces.push([[...run, ...moved, run[0]]]);
    }
  });
  try {
    const out = polygonClipping.union(...(pieces as Parameters<typeof polygonClipping.union>));
    if (out.length === 0) return null;
    if (out.length === 1) return { type: "Polygon", coordinates: out[0] as unknown as Ring[] };
    return { type: "MultiPolygon", coordinates: out as unknown as Ring[][] };
  } catch {
    // Malformed source geometry must not turn a sunlit clearing into a hull shadow.
    // Retain only the footprint if its swept boundary cannot be resolved.
    return { type: "Polygon", coordinates: rings };
  }
}

/** Exact sweep of a footprint without holes. */
export function sweepRing(ring: Ring, lengthM: number, bearingDeg: number): Polygon | MultiPolygon | null {
  return sweepPolygon({ type: "Polygon", coordinates: [ring] }, lengthM, bearingDeg);
}

/** A turn-sign test avoids area-rounding errors on small geographic footprints. */
function isConvex(ring: Ring): boolean {
  let sign = 0;
  const n = ring.length - 1;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n], c = ring[(i + 2) % n];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (cross === 0) continue;
    const turn = Math.sign(cross);
    if (sign && sign !== turn) return false;
    sign = turn;
  }
  return true;
}

export interface ShadowOptions {
  /** Rings with convexity >= threshold use the fast hull sweep. Default 0.97 */
  convexThreshold?: number;
  /** Preserve canopy clearings and concavities instead of approximating their hull. */
  preserveVoids?: boolean;
  /** Height of the caster's underside (crown base); the ground-level band below it stays sunlit. */
  baseM?: number;
}

/**
 * Compute the ground shadow of a building footprint.
 * Returns null if the sun is below the horizon or the footprint is degenerate.
 * Building courtyards are approximated as solid; preserveVoids retains canopy clearings.
 * With baseM, the caster floats from baseM to heightM: its footprint is first shifted by the
 * base's shadow length, so the sun-side strip under a crown is lit through the trunk zone.
 */
export function calculateBuildingShadow(
  footprint: Polygon | MultiPolygon,
  heightM: number,
  sunAltitudeRad: number,
  sunAzimuthRad: number,
  opts: ShadowOptions = {},
): Feature<Polygon | MultiPolygon> | null {
  const total = shadowLength(heightM, sunAltitudeRad);
  if (total <= 0) return null;
  const bearing = shadowBearingDeg(sunAzimuthRad);
  const threshold = opts.convexThreshold ?? 0.97;
  const lift = opts.baseM ? Math.min(shadowLength(opts.baseM, sunAltitudeRad), total) : 0;
  const len = total - lift;

  const parts: (Polygon | MultiPolygon)[] = [];
  for (const footprintPoly of toPolygons(footprint)) {
    const poly: Polygon = lift
      ? { type: "Polygon", coordinates: footprintPoly.coordinates.map((ring) => ring.map((p) => offsetPosition(p, lift, bearing))) }
      : footprintPoly;
    const outer = poly.coordinates[0];
    if (!outer || outer.length < 4) continue;
    const g = opts.preserveVoids
      ? poly.coordinates.length === 1 && isConvex(outer)
        ? hullSweep(outer, len, bearing)
        : sweepPolygon(poly, len, bearing)
      : convexity(outer) >= threshold ? hullSweep(outer, len, bearing) : sweepRing(outer, len, bearing);
    if (g) parts.push(g);
  }
  if (parts.length === 0) return null;

  let geometry: Polygon | MultiPolygon;
  if (parts.length === 1) {
    geometry = parts[0];
  } else {
    try {
      const out = polygonClipping.union(
        ...(parts.map((p) => p.coordinates) as Parameters<typeof polygonClipping.union>),
      );
      geometry =
        out.length === 1
          ? { type: "Polygon", coordinates: out[0] as unknown as Ring[] }
          : { type: "MultiPolygon", coordinates: out as unknown as Ring[][] };
    } catch {
      geometry = { type: "MultiPolygon", coordinates: parts.flatMap((p) => (p.type === "Polygon" ? [p.coordinates] : p.coordinates)) };
    }
  }
  return { type: "Feature", geometry, properties: {} };
}

/** Circle polygon (lng/lat) of `radiusM` around `center`. */
export function circlePolygon(center: Position, radiusM: number, steps = 12): Polygon {
  const ring: Position[] = [];
  for (let i = 0; i < steps; i++) {
    ring.push(offsetPosition(center, radiusM, (360 / steps) * i));
  }
  ring.push(ring[0]);
  return { type: "Polygon", coordinates: [ring] };
}

/**
 * Tree shadow: the crown is a cylinder of radius `crownRadius` from `crownBaseM` up to
 * `height`. The trunk itself is ignored, so the open zone below the crown is fully lit.
 */
export function calculateTreeShadow(
  center: Position,
  heightM: number,
  crownRadiusM: number,
  sunAltitudeRad: number,
  sunAzimuthRad: number,
  crownBaseM = 0,
): Feature<Polygon | MultiPolygon> | null {
  const crown = circlePolygon(center, Math.max(crownRadiusM, 0.5));
  return calculateBuildingShadow(crown, heightM, sunAltitudeRad, sunAzimuthRad, { convexThreshold: 0, baseM: crownBaseM });
}

function pushShadow(
  features: ShadowFeature[],
  shadow: Feature<Polygon | MultiPolygon> | null,
  sourceId: string,
  kind: ShadowKind,
  h: number,
  sun: SunPosition,
  shade = 1,
) {
  if (!shadow) return;
  features.push({
    type: "Feature",
    geometry: shadow.geometry,
    properties: { sourceId, kind, height: h, shadowLength: Math.round(shadowLength(h, sun.altitude)), shade },
  });
}

/** Compute shadows for every building in the collection. */
export function calculateShadows(buildings: BuildingCollection, sun: SunPosition): ShadowCollection {
  const features: ShadowFeature[] = [];
  if (sun.altitude <= MIN_SUN_ALTITUDE_RAD) return { type: "FeatureCollection", features };
  for (const b of buildings.features) {
    const h = b.properties.height;
    pushShadow(features, calculateBuildingShadow(b.geometry, h, sun.altitude, sun.azimuth), b.properties.id, "building", h, sun);
  }
  return { type: "FeatureCollection", features };
}

function pushCanopyShadows(features: ShadowFeature[], canopy: CanopyCollection, sun: SunPosition, deciduousLeaf: number) {
  for (const c of canopy.features) {
    const h = c.properties.height;
    const shadow = calculateBuildingShadow(c.geometry, h, sun.altitude, sun.azimuth, { preserveVoids: true, baseM: h * CROWN_BASE_RATIO });
    pushShadow(features, shadow, c.properties.id, "canopy", h, sun, crownShade(c.properties.evergreenShare, deciduousLeaf));
  }
}

/** Shadows of trees, canopy stands and park structures (정자/파고라/교량). */
export function calculateVegetationShadows(
  trees: TreeCollection,
  canopy: CanopyCollection,
  structures: StructureCollection,
  sun: SunPosition,
  deciduousLeaf = 1,
): ShadowCollection {
  const features: ShadowFeature[] = [];
  if (sun.altitude <= MIN_SUN_ALTITUDE_RAD) return { type: "FeatureCollection", features };
  for (const t of trees.features) {
    const { height, crownRadius, id, evergreenShare } = t.properties;
    const shadow = calculateTreeShadow(t.geometry.coordinates, height, crownRadius, sun.altitude, sun.azimuth, height * CROWN_BASE_RATIO);
    pushShadow(features, shadow, id, "tree", height, sun, crownShade(evergreenShare, deciduousLeaf));
  }
  pushCanopyShadows(features, canopy, sun, deciduousLeaf);
  for (const st of structures.features) {
    const h = st.properties.height;
    pushShadow(features, calculateBuildingShadow(st.geometry, h, sun.altitude, sun.azimuth), st.properties.id, "structure", h, sun);
  }
  return { type: "FeatureCollection", features };
}

/** Shadows of satellite-estimated canopy polygons (kind "canopy", heightSource "chm"). */
export function calculateCanopyShadows(canopy: CanopyCollection, sun: SunPosition, deciduousLeaf = 1): ShadowCollection {
  const features: ShadowFeature[] = [];
  if (sun.altitude <= MIN_SUN_ALTITUDE_RAD) return { type: "FeatureCollection", features };
  pushCanopyShadows(features, canopy, sun, deciduousLeaf);
  return { type: "FeatureCollection", features };
}

/** All enabled shadow casters in one collection (buildings + OSM vegetation/structures + satellite canopy). */
export function calculateAllShadows(
  layers: ShadeLayers,
  sun: SunPosition,
  flags: CasterFlags = { vegetation: true, canopyChm: true, deciduousLeaf: 1 },
): ShadowCollection {
  const features = [...calculateShadows(layers.buildings, sun).features];
  // The local CHM raster covers the entire AOI. Broad OSM forest boundaries must
  // not fill its measured canopy gaps or override smaller trees with a flat 12 m height.
  // If detailed canopy is unavailable, the OSM stands remain a fallback source.
  const canopy = layers.canopyChm.features.length ? { type: "FeatureCollection" as const, features: [] } : layers.canopy;
  if (flags.vegetation) features.push(...calculateVegetationShadows(layers.trees, canopy, layers.structures, sun, flags.deciduousLeaf).features);
  if (flags.canopyChm) features.push(...calculateCanopyShadows(layers.canopyChm, sun, flags.deciduousLeaf).features);
  return { type: "FeatureCollection", features };
}
