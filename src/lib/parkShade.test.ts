import { describe, expect, it } from "vitest";
import type { FeatureCollection, Polygon } from "geojson";
import type { BuildingCollection, ShadowCollection } from "../types/map";
import { pointInGeometry } from "./shade";
import { buildParkGroundGrid, computeParkGroundShade, createParkGround } from "./parkShade";

const metersPerDegree = 6371008.8 * Math.PI / 180;
const p = (x: number, y: number) => [127 + x / (metersPerDegree * Math.cos(37 * Math.PI / 180)), 37 + y / metersPerDegree];
const square = (x: number, y: number, w: number, h: number): Polygon => ({
  type: "Polygon", coordinates: [[p(x, y), p(x + w, y), p(x + w, y + h), p(x, y + h), p(x, y)]],
});
const collection = (geometry: Polygon, kind = "park"): FeatureCollection<Polygon> => ({
  type: "FeatureCollection", features: [{ type: "Feature", geometry, properties: { kind } }],
});
const emptyBuildings: BuildingCollection = { type: "FeatureCollection", features: [] };
const shadows = (geometry?: Polygon): ShadowCollection => ({ type: "FeatureCollection", features: geometry ? [{
  type: "Feature", geometry, properties: { sourceId: "test", kind: "building", height: 10, shadowLength: 10, shade: 1 },
}] : [] });

describe("park land shade", () => {
  it("removes water, buildings and park holes without double-counting overlapping park boundaries", () => {
    const boundary = square(0, 0, 100, 100);
    boundary.coordinates.push(square(10, 10, 10, 10).coordinates[0]);
    const park = collection(boundary);
    park.features.push(park.features[0], collection(square(30, 30, 20, 50), "water").features[0]);
    const buildings: BuildingCollection = { type: "FeatureCollection", features: [{
      type: "Feature", geometry: square(60, 60, 20, 20), properties: {
        id: "one", building: "yes", name: null, levels: null, height: 10, heightSource: "estimated",
      },
    }] };
    const ground = createParkGround(park, buildings);
    const grid = buildParkGroundGrid(ground, 4);
    expect(grid.areaM2).toBeGreaterThan(8499);
    expect(grid.areaM2).toBeLessThan(8501);
    for (const position of [p(15, 15), p(35, 35), p(65, 65)]) {
      expect(ground.features.some(f => pointInGeometry(position, f.geometry))).toBe(false);
    }
    expect(grid.points.every(position => ground.features.some(f => pointInGeometry(position, f.geometry)))).toBe(true);
    expect(computeParkGroundShade(grid, shadows(square(30, 30, 20, 50))).ratio).toBe(0);
    expect(computeParkGroundShade(grid, shadows(square(-1, -1, 102, 102))).ratio).toBe(1);
  });

  it("estimates half coverage and respects holes in shadow geometry", () => {
    const grid = buildParkGroundGrid(createParkGround(collection(square(0, 0, 100, 100)), emptyBuildings), 5);
    const half = computeParkGroundShade(grid, shadows(square(0, 0, 50, 100)));
    expect(half.ratio).toBeCloseTo(0.5, 2);
    expect(half.shadedM2).toBeCloseTo(half.areaM2 * half.ratio, 6);
    const shadow = square(-1, -1, 102, 102);
    shadow.coordinates.push(square(25, 25, 50, 50).coordinates[0]);
    expect(computeParkGroundShade(grid, shadows(shadow)).ratio).toBeCloseTo(0.75, 2);
    expect(computeParkGroundShade(grid, shadows()).shadedM2).toBe(0);
  });

  it("returns finite zeros for empty land", () => {
    const ground = createParkGround(collection(square(0, 0, 10, 10), "water"), emptyBuildings);
    expect(computeParkGroundShade(buildParkGroundGrid(ground), shadows())).toEqual({ areaM2: 0, shadedM2: 0, ratio: 0 });
    expect(() => buildParkGroundGrid(ground, 0)).toThrow();
  });
});
