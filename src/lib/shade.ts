/**
 * Shade analysis on top of shadow polygons: point-in-shadow tests with a grid index,
 * union of all shadows for uniform rendering, and per-path shaded-length ratios.
 * Pure functions; runs inside the Web Worker.
 */
import polygonClipping from "polygon-clipping";
import type { Feature, LineString, MultiPolygon, Polygon, Position } from "geojson";
import type { PathCollection, ShadeSegmentCollection, ShadowCollection } from "../types/map";
import { clipperUnion } from "./clipper";

type Ring = Position[];

const R = 6378137;
/** Fast equirectangular distance in meters (fine for < a few km). */
export function distanceM(a: Position, b: Position): number {
  const lat = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  const dx = (b[0] - a[0]) * (Math.PI / 180) * R * Math.cos(lat);
  const dy = (b[1] - a[1]) * (Math.PI / 180) * R;
  return Math.hypot(dx, dy);
}

/** Even-odd ray casting for a single ring. */
export function pointInRing(p: Position, ring: Ring): boolean {
  let inside = false;
  const [x, y] = p;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Point in Polygon (outer ring minus holes). */
export function pointInPolygon(p: Position, poly: Ring[]): boolean {
  if (!pointInRing(p, poly[0])) return false;
  for (let i = 1; i < poly.length; i++) if (pointInRing(p, poly[i])) return false;
  return true;
}

export function pointInGeometry(p: Position, g: Polygon | MultiPolygon): boolean {
  if (g.type === "Polygon") return pointInPolygon(p, g.coordinates);
  for (const poly of g.coordinates) if (pointInPolygon(p, poly)) return true;
  return false;
}

type BBox = [number, number, number, number];
function bboxOf(g: Polygon | MultiPolygon): BBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  for (const poly of polys)
    for (const [x, y] of poly[0]) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  return [minX, minY, maxX, maxY];
}

/**
 * Uniform grid over polygon bboxes for fast candidate lookup.
 * cellDeg ≈ 0.0005° ≈ 45–55 m at this latitude.
 */
export type PolygonIndex = (point: Position) => boolean;
/** Strongest weight among the polygons containing a point, 0 outside all of them. */
export type WeightIndex = (point: Position) => number;

/** Create a point-in-polygon lookup over polygon bounding boxes. */
export function createPolygonIndex(geoms: (Polygon | MultiPolygon)[], cellDeg = 0.0005): PolygonIndex {
  const weight = createWeightIndex(geoms, geoms.map(() => 1), cellDeg);
  return (point) => weight(point) > 0;
}

/** Point lookup returning the maximum weight (0..1) of the containing polygons; stops at 1. */
export function createWeightIndex(
  geoms: (Polygon | MultiPolygon)[],
  weights: number[],
  cellDeg = 0.0005,
): WeightIndex {
  const cells = new Map<string, number[]>();
  const boxes = geoms.map(bboxOf);
  const cellRange = (b: BBox): [number, number, number, number] => [
    Math.floor(b[0] / cellDeg),
    Math.floor(b[1] / cellDeg),
    Math.floor(b[2] / cellDeg),
    Math.floor(b[3] / cellDeg),
  ];

  boxes.forEach((b, i) => {
    const [x0, y0, x1, y1] = cellRange(b);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const key = `${cx}:${cy}`;
        const candidates = cells.get(key);
        if (candidates) candidates.push(i);
        else cells.set(key, [i]);
      }
    }
  });

  return (point) => {
    const key = `${Math.floor(point[0] / cellDeg)}:${Math.floor(point[1] / cellDeg)}`;
    const candidates = cells.get(key);
    if (!candidates) return 0;
    let best = 0;
    for (const i of candidates) {
      if (weights[i] <= best) continue;
      const b = boxes[i];
      if (point[0] < b[0] || point[0] > b[2] || point[1] < b[1] || point[1] > b[3]) continue;
      if (pointInGeometry(point, geoms[i])) {
        best = weights[i];
        if (best >= 1) break;
      }
    }
    return best;
  };
}

/** Shade lookup over shadow polygons, weighted by each shadow's relative shade. */
export function createShadeIndex(shadows: ShadowCollection): WeightIndex {
  return createWeightIndex(shadows.features.map((f) => f.geometry), shadows.features.map((f) => f.properties.shade ?? 1));
}

/**
 * Union of all shadow geometries into one MultiPolygon (for uniform rendering).
 * Uses WebAssembly Clipper when it has loaded, otherwise polygon-clipping.
 */
export function unionShadows(shadows: ShadowCollection): MultiPolygon | null {
  if (shadows.features.length === 0) return null;
  const fast = clipperUnion(shadows.features.flatMap(({ geometry }) => (geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates)));
  if (fast) return { type: "MultiPolygon", coordinates: fast };
  const geoms = shadows.features.map((f) => f.geometry.coordinates);
  try {
    const out = polygonClipping.union(...(geoms as Parameters<typeof polygonClipping.union>));
    return { type: "MultiPolygon", coordinates: out as unknown as Ring[][] };
  } catch {
    // Swept height bands can share nearly collinear edges at floating-point
    // precision. Retry on a ~1 mm coordinate grid so clipping can order them;
    // retain every ring rather than filling canopy clearings with a hull.
    const snapped = shadows.features.map(({ geometry }) => {
      const polygon = (rings: Ring[]) => rings.map(ring => ring.map(([x, y]) => [Math.round(x * 1e8) / 1e8, Math.round(y * 1e8) / 1e8]));
      return geometry.type === "Polygon" ? polygon(geometry.coordinates) : geometry.coordinates.map(polygon);
    });
    try {
      const out = polygonClipping.union(...(snapped as Parameters<typeof polygonClipping.union>));
      return { type: "MultiPolygon", coordinates: out as unknown as Ring[][] };
    } catch {
      return null;
    }
  }
}

/** Sample positions along a line every `stepM` meters (always includes both endpoints). */
export function samplePath(line: LineString, stepM = 5): Position[] {
  const c = line.coordinates;
  if (c.length === 0) return [];
  const out: Position[] = [c[0]];
  let carry = 0;
  for (let i = 0; i < c.length - 1; i++) {
    const a = c[i], b = c[i + 1];
    const segLen = distanceM(a, b);
    if (segLen === 0) continue;
    let d = stepM - carry;
    while (d < segLen) {
      const t = d / segLen;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      d += stepM;
    }
    carry = segLen - (d - stepM);
  }
  out.push(c[c.length - 1]);
  return out;
}

export function lineLengthM(line: LineString): number {
  let len = 0;
  const c = line.coordinates;
  for (let i = 0; i < c.length - 1; i++) len += distanceM(c[i], c[i + 1]);
  return len;
}

export interface Segment {
  a: number;
  b: number;
  lengthM: number;
}

/** Paths split into node-indexed segments so shade can vary along a way. */
export interface SegmentGraph {
  nodes: Position[];
  segments: Segment[];
  /** segment ids per path, in path order */
  pathSegments: number[][];
}

export function buildSegmentGraph(paths: Feature<LineString>[], maxLengthM = Infinity): SegmentGraph {
  if (maxLengthM <= 0 || Number.isNaN(maxLengthM)) throw new Error("Segment length must be positive");
  const nodes: Position[] = [];
  const index = new Map<string, number>();
  const segments: Segment[] = [];
  const pathSegments: number[][] = [];
  const nodeId = (p: Position) => {
    const k = `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
    let id = index.get(k);
    if (id === undefined) {
      id = nodes.length;
      nodes.push([p[0], p[1]]);
      index.set(k, id);
    }
    return id;
  };
  for (const f of paths) {
    const c = f.geometry.coordinates;
    const ids: number[] = [];
    for (let i = 0; i < c.length - 1; i++) {
      const start = c[i], end = c[i + 1];
      const pieces = Math.max(1, Math.ceil(distanceM(start, end) / maxLengthM));
      let previous = start;
      for (let j = 1; j <= pieces; j++) {
        const next = j === pieces ? end : [start[0] + (end[0] - start[0]) * j / pieces, start[1] + (end[1] - start[1]) * j / pieces];
        const a = nodeId(previous), b = nodeId(next);
        const lengthM = distanceM(previous, next);
        if (a !== b && lengthM > 0) {
          ids.push(segments.length);
          segments.push({ a, b, lengthM });
        }
        previous = next;
      }
    }
    pathSegments.push(ids);
  }
  return { nodes, segments, pathSegments };
}

/** Draw exactly the same short segments that contribute to the lake totals. */
export function shadeSegmentPaths(paths: PathCollection, graph: SegmentGraph, shade: ArrayLike<number>): ShadeSegmentCollection {
  return {
    type: "FeatureCollection",
    features: graph.pathSegments.flatMap((ids, pathIndex) => ids.map(id => {
      const segment = graph.segments[id];
      return {
        type: "Feature" as const,
        id,
        geometry: { type: "LineString" as const, coordinates: [graph.nodes[segment.a], graph.nodes[segment.b]] },
        properties: { ...paths.features[pathIndex].properties, shadeRatio: shade[id], lengthM: segment.lengthM },
      };
    })),
  };
}

/**
 * Shade ratio per segment, sampling every `stepM` meters along the segment.
 * Equal-length cells use their midpoints, avoiding double-counted boundary nodes.
 * A midpoint counts with the strongest shade covering it (partial under leafless crowns).
 */
export function computeSegmentShade(graph: SegmentGraph, shadows: ShadowCollection, stepM = 5): Float64Array {
  const { nodes, segments } = graph;
  const shadeAt = createShadeIndex(shadows);
  const out = new Float64Array(segments.length);
  for (let i = 0; i < segments.length; i++) {
    const e = segments[i];
    const a = nodes[e.a], b = nodes[e.b];
    const n = Math.max(1, Math.ceil(e.lengthM / stepM));
    let hit = 0;
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      hit += shadeAt([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
    out[i] = hit / n;
  }
  return out;
}

/** Length-weighted shade ratio per path from its segments. */
export function aggregatePathShade(graph: SegmentGraph, segmentShade: ArrayLike<number>, inPark: boolean[]): PathShadeResult {
  const { pathSegments, segments } = graph;
  const ratios: number[] = new Array(pathSegments.length);
  let parkLen = 0, parkShaded = 0, allLen = 0, allShaded = 0;
  for (let i = 0; i < pathSegments.length; i++) {
    let len = 0, shaded = 0;
    for (const sid of pathSegments[i]) {
      const l = segments[sid].lengthM;
      len += l;
      shaded += l * segmentShade[sid];
    }
    ratios[i] = len ? shaded / len : 0;
    allLen += len;
    allShaded += shaded;
    if (inPark[i]) {
      parkLen += len;
      parkShaded += shaded;
    }
  }
  return {
    ratios,
    park: { lengthM: parkLen, shadedM: parkShaded, ratio: parkLen ? parkShaded / parkLen : 0 },
    all: { lengthM: allLen, shadedM: allShaded, ratio: allLen ? allShaded / allLen : 0 },
  };
}

export interface PathShadeResult {
  /** Shaded fraction (0..1) per path, aligned with the input feature order. */
  ratios: number[];
  /** Aggregate over paths flagged `inPark`. */
  park: { lengthM: number; shadedM: number; ratio: number };
  /** Aggregate over all paths. */
  all: { lengthM: number; shadedM: number; ratio: number };
}

/** A path counts as "in park" if at least half of its sample points fall inside any park polygon. */
export function flagPathsInPark(paths: Feature<LineString>[], parkGeoms: (Polygon | MultiPolygon)[]): boolean[] {
  return paths.map((p) => {
    const pts = samplePath(p.geometry, 20);
    let inside = 0;
    for (const pt of pts) if (parkGeoms.some((g) => pointInGeometry(pt, g))) inside++;
    return pts.length > 0 && inside / pts.length >= 0.5;
  });
}
