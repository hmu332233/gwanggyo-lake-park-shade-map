import { describe, expect, it } from "vitest";
import { featureCollection, lineString, polygon } from "@turf/turf";
import { selectParkPaths } from "../../scripts/select-park-paths";

const park = featureCollection([polygon([[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]], { kind: "park" })]);
const paths = (lines: number[][][]) => featureCollection(lines.map((c, i) => lineString(c, { id: String(i), highway: "footway", name: null, surface: null })));

describe("park walking paths", () => {
  it("retains inland park paths and clips city-side portions of a crossing path", () => {
    const result = selectParkPaths(paths([[[1, 1], [2, 1]], [[-1, 2], [5, 2]], [[6, 0], [7, 1]]]), park);
    expect(result.features).toHaveLength(2);
    expect(result.features[0].geometry.coordinates).toEqual([[1, 1], [2, 1]]);
    for (const [x, y] of result.features[1].geometry.coordinates) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(4);
      expect(y).toBeCloseTo(2);
    }
  });
  it("excludes paths in holes of the park boundary", () => {
    const withHole = featureCollection([polygon([...park.features[0].geometry.coordinates, [[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]]], { kind: "park" })]);
    const result = selectParkPaths(paths([[[1.5, 2], [2.5, 2]]]), withHole);
    expect(result.features).toHaveLength(0);
  });
});
