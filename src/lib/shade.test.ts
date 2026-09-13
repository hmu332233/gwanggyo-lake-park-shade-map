import { describe, it, expect } from "vitest";
import { aggregatePathShade, buildSegmentGraph, computeSegmentShade, lineLengthM, pointInGeometry, samplePath, shadeSegmentPaths, unionShadows } from "./shade";
import type { LineString, Polygon } from "geojson";
import type { PathCollection, ShadowCollection } from "../types/map";

const sq = (x0: number, y0: number, x1: number, y1: number): Polygon => ({
  type: "Polygon",
  coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]],
});

describe("pointInGeometry", () => {
  it("handles holes", () => {
    const withHole: Polygon = { type: "Polygon", coordinates: [sq(0, 0, 10, 10).coordinates[0], sq(4, 4, 6, 6).coordinates[0]] };
    expect(pointInGeometry([1, 1], withHole)).toBe(true);
    expect(pointInGeometry([5, 5], withHole)).toBe(false);
    expect(pointInGeometry([11, 5], withHole)).toBe(false);
  });
});

describe("samplePath / lineLengthM", () => {
  it("samples roughly every step and keeps endpoints", () => {
    // ~100 m east-west line at lat 37.28
    const line: LineString = { type: "LineString", coordinates: [[127.0665, 37.2835], [127.06763, 37.2835]] };
    const len = lineLengthM(line);
    expect(len).toBeGreaterThan(95);
    expect(len).toBeLessThan(105);
    const pts = samplePath(line, 5);
    expect(pts.length).toBeGreaterThanOrEqual(20);
    expect(pts[0]).toEqual(line.coordinates[0]);
    expect(pts[pts.length - 1]).toEqual(line.coordinates[1]);
  });
});

describe("segment shade", () => {
  it("shows local sun and shade on a long way while preserving its length and bends", () => {
    const paths: PathCollection = { type: "FeatureCollection", features: [{
      type: "Feature", properties: { id: "loop", name: "호수 둘레길", lake: "호수", highway: "footway", surface: null },
      geometry: { type: "LineString", coordinates: [[127.0665, 37.2835], [127.0675, 37.2835], [127.0675, 37.2840]] },
    }] };
    const shadows: ShadowCollection = { type: "FeatureCollection", features: [{ type: "Feature", geometry: sq(127.0660, 37.2830, 127.0670, 37.2840), properties: { sourceId: "a", kind: "building", height: 10, shadowLength: 10 } }] };
    const graph = buildSegmentGraph(paths.features, 10);
    const shade = computeSegmentShade(graph, shadows, 5);
    const display = shadeSegmentPaths(paths, graph, shade);
    expect(graph.segments.every(s => s.lengthM <= 10.01)).toBe(true);
    expect(display.features[0].properties.shadeRatio).toBe(1);
    expect(display.features.at(-1)!.properties.shadeRatio).toBe(0);
    expect(graph.nodes).toContainEqual([127.0675, 37.2835]);
    expect(display.features.reduce((sum, f) => sum + f.properties.lengthM, 0)).toBeCloseTo(lineLengthM(paths.features[0].geometry), 4);
    const total = aggregatePathShade(graph, shade, [true]);
    expect(total.all.shadedM).toBeCloseTo(display.features.reduce((sum, f) => sum + f.properties.lengthM * f.properties.shadeRatio, 0), 5);
  });
  it("returns the shaded fraction of a path", () => {
    // Shadow covers the western half of the line.
    const shadows: ShadowCollection = {
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: sq(127.0660, 37.2830, 127.0670, 37.2840), properties: { sourceId: "a", kind: "building", height: 10, shadowLength: 10 } }],
    };
    const line: LineString = { type: "LineString", coordinates: [[127.0665, 37.2835], [127.0675, 37.2835]] };
    const graph = buildSegmentGraph([{ type: "Feature", geometry: line, properties: {} }]);
    const res = aggregatePathShade(graph, computeSegmentShade(graph, shadows, 5), [true]);
    expect(res.park.lengthM).toBeCloseTo(lineLengthM(line), 3);
    expect(res.ratios[0]).toBeGreaterThan(0.4);
    expect(res.ratios[0]).toBeLessThan(0.6);
    expect(res.park.ratio).toBeCloseTo(res.ratios[0], 5);
  });
  it("shares nodes between ways and splits into segments", () => {
    const a: LineString = { type: "LineString", coordinates: [[127.0665, 37.2835], [127.0670, 37.2835], [127.0675, 37.2835]] };
    const b: LineString = { type: "LineString", coordinates: [[127.0670, 37.2835], [127.0670, 37.2840]] };
    const g = buildSegmentGraph([a, b].map((geometry) => ({ type: "Feature" as const, geometry, properties: {} })));
    expect(g.nodes.length).toBe(4);
    expect(g.segments.length).toBe(3);
    expect(g.pathSegments).toEqual([[0, 1], [2]]);
  });
  it("unions overlapping shadows", () => {
    const shadows: ShadowCollection = {
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: sq(0, 0, 2, 2), properties: { sourceId: "a", kind: "building", height: 1, shadowLength: 1 } },
        { type: "Feature", geometry: sq(1, 1, 3, 3), properties: { sourceId: "b", kind: "building", height: 1, shadowLength: 1 } },
      ],
    };
    const u = unionShadows(shadows)!;
    expect(u.coordinates.length).toBe(1);
  });
});
