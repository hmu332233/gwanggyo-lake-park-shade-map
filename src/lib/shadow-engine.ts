import { calculateAllShadows } from "./shadow";
import { buildParkGroundGrid, computeParkGroundShade, type ParkGroundGrid, type ParkGroundShade } from "./parkShade";
import {
  aggregatePathShade,
  buildSegmentGraph,
  computeSegmentShade,
  flagPathsInPark,
  unionShadows,
  shadeSegmentPaths,
  type PathShadeResult,
  type SegmentGraph,
} from "./shade";
import { PATH_SAMPLE_STEP_M } from "./config";
import type { MultiPolygon } from "geojson";
import type { CasterFlags, ShadeLayers, ShadeSegmentCollection, ShadowCollection, SunPosition } from "../types/map";

export interface ShadeResult {
  /** Individual shadow polygons (buildings + vegetation + structures). */
  shadows: ShadowCollection;
  /** Union of all shadows — what gets drawn, so overlaps don't double-darken. */
  shadowUnion: MultiPolygon | null;
  /** Per-path shade ratios aligned with layers.paths.features. */
  pathShade: PathShadeResult;
  segmentPaths: ShadeSegmentCollection;
  parkShade: ParkGroundShade;
  ms: { shadows: number; union: number; paths: number };
}

export interface ShadowEngine {
  layers: ShadeLayers;
  graph: SegmentGraph;
  inPark: boolean[];
  groundGrid: ParkGroundGrid;
}

export function createShadowEngine(layers: ShadeLayers): ShadowEngine {
  return {
    layers,
    graph: buildSegmentGraph(layers.paths.features, 10),
    inPark: flagPathsInPark(layers.paths.features, layers.park.features.map((f) => f.geometry)),
    groundGrid: buildParkGroundGrid(layers.parkGround),
  };
}

export function emptyShadeResult(): ShadeResult {
  const empty: ShadowCollection = { type: "FeatureCollection", features: [] };
  const zero = { lengthM: 0, shadedM: 0, ratio: 0 };
  return {
    shadows: empty,
    shadowUnion: null,
    pathShade: { ratios: [], park: zero, all: zero },
    parkShade: { areaM2: 0, shadedM2: 0, ratio: 0 },
    segmentPaths: { type: "FeatureCollection", features: [] },
    ms: { shadows: 0, union: 0, paths: 0 },
  };
}

export function computeShadowResult(engine: ShadowEngine | null, sun: SunPosition, flags: CasterFlags): ShadeResult {
  if (!engine) return emptyShadeResult();
  const { layers, graph, inPark, groundGrid } = engine;
  const t0 = performance.now();
  const shadows = calculateAllShadows(layers, sun, flags);
  const t1 = performance.now();
  const shadowUnion = unionShadows(shadows);
  const t2 = performance.now();
  const segmentShade = computeSegmentShade(graph, shadows, PATH_SAMPLE_STEP_M);
  const pathShade = aggregatePathShade(graph, segmentShade, inPark);
  const parkShade = computeParkGroundShade(groundGrid, shadows);
  const t3 = performance.now();
  return {
    shadows,
    shadowUnion,
    pathShade,
    parkShade,
    segmentPaths: shadeSegmentPaths(layers.paths, graph, segmentShade),
    ms: { shadows: t1 - t0, union: t2 - t1, paths: t3 - t2 },
  };
}
