import { describe, expect, it } from "vitest";
import type { Polygon } from "geojson";
import type { ShadeLayers } from "../types/map";
import { computeShadowResult, createShadowEngine, emptyShadeResult } from "./shadow-engine";

const empty = { type: "FeatureCollection" as const, features: [] };
const sun = { altitude: Math.PI / 4, altitudeDeg: 45, azimuth: Math.PI, azimuthDeg: 180 };
const flags = { vegetation: true, canopyChm: true, deciduousLeaf: 1 };
const layers: ShadeLayers = {
  buildings: empty,
  paths: empty,
  trees: empty,
  canopy: empty,
  canopyChm: empty,
  structures: empty,
  park: empty,
  parkGround: empty,
};

const square: Polygon = {
  type: "Polygon",
  coordinates: [[[127, 37], [127.0002, 37], [127.0002, 37.0002], [127, 37.0002], [127, 37]]],
};
const simpleLayers: ShadeLayers = {
  ...layers,
  buildings: {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      geometry: square,
      properties: { id: "building", building: "yes", name: null, levels: null, height: 10, heightSource: "estimated" },
    }],
  },
  paths: {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      geometry: { type: "LineString", coordinates: [[127, 37.00025], [127.0004, 37.00025]] },
      properties: { id: "path", highway: "footway", name: null, surface: null },
    }],
  },
  trees: {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      geometry: { type: "Point", coordinates: [127.0005, 37.0005] },
      properties: { id: "tree", height: 8, crownRadius: 3, heightSource: "estimated", species: null },
    }],
  },
  park: { type: "FeatureCollection", features: [{ type: "Feature", geometry: square, properties: {} }] },
  parkGround: { type: "FeatureCollection", features: [{ type: "Feature", geometry: square, properties: {} }] },
};

describe("shadow engine", () => {
  it("returns a fresh empty result when no engine has been initialized", () => {
    expect(computeShadowResult(null, sun, flags)).toEqual(emptyShadeResult());
  });

  it("precomputes path and park indexes and returns aligned empty output", () => {
    const result = computeShadowResult(createShadowEngine(layers), sun, flags);
    expect(result.shadows.features).toHaveLength(0);
    expect(result.pathShade).toEqual({ ratios: [], park: { lengthM: 0, shadedM: 0, ratio: 0 }, all: { lengthM: 0, shadedM: 0, ratio: 0 } });
    expect(result.segmentPaths.features).toHaveLength(0);
    expect(result.parkShade).toEqual({ areaM2: 0, shadedM2: 0, ratio: 0 });
  });

  it("reuses its indexes while applying caster flags to real geometry", () => {
    const engine = createShadowEngine(simpleLayers);
    const buildingsOnly = computeShadowResult(engine, sun, { vegetation: false, canopyChm: false, deciduousLeaf: 1 });
    const withTrees = computeShadowResult(engine, sun, { vegetation: true, canopyChm: false, deciduousLeaf: 1 });

    expect(buildingsOnly.shadows.features.map((f) => f.properties.sourceId)).toEqual(["building"]);
    expect(withTrees.shadows.features.map((f) => f.properties.sourceId)).toEqual(["building", "tree"]);
    expect(buildingsOnly.pathShade.ratios).toHaveLength(1);
    expect(buildingsOnly.segmentPaths.features.length).toBeGreaterThan(0);
    expect(buildingsOnly.pathShade.all.lengthM).toBeGreaterThan(0);
    expect(buildingsOnly.pathShade.all.ratio).toBeGreaterThan(0);
    expect(withTrees.pathShade.all.lengthM).toBe(buildingsOnly.pathShade.all.lengthM);
  });
});
