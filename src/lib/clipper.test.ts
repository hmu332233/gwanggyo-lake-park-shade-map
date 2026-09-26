import { beforeEach, describe, expect, it, vi } from "vitest";
import polygonClipping from "polygon-clipping";
import { area } from "@turf/turf";
import type { MultiPolygon, Position } from "geojson";

// The web build targets browsers and workers; tests load the universal (Node-capable) build of the same library.
const universal = () => import("js-angusj-clipper") as never;
const load = async () => {
  vi.resetModules();
  return import("./clipper");
};

const o = [127.0665, 37.2835];
const at = (x: number, y: number): Position => [o[0] + x / (6378137 * Math.cos((o[1] * Math.PI) / 180)) * 180 / Math.PI, o[1] + y / 6378137 * 180 / Math.PI];
const square = (x: number, y: number, s: number, clockwise = false) => {
  const r = [at(x, y), at(x + s, y), at(x + s, y + s), at(x, y + s), at(x, y)];
  return clockwise ? r.reverse() : r;
};
// Overlapping squares with mixed orientation, one with a hole the other square partly fills.
const polygons: MultiPolygon["coordinates"] = [
  [square(0, 0, 40), square(10, 10, 20, true)],
  [square(25, 25, 30, true)],
  [square(100, 0, 10)],
];
const m2 = (coordinates: MultiPolygon["coordinates"]) => area({ type: "MultiPolygon", coordinates });

describe("clipper", () => {
  beforeEach(() => vi.useRealTimers());

  it("returns null until the WebAssembly build has loaded", async () => {
    const clipper = await load();
    expect(clipper.clipperReady()).toBe(false);
    expect(clipper.clipperUnion(polygons)).toBeNull();
  });

  it("reports failure and keeps the fallback when loading fails", async () => {
    const clipper = await load();
    expect(await clipper.initClipper(() => Promise.reject(new Error("blocked")))).toBe(false);
    expect(clipper.clipperUnion(polygons)).toBeNull();
  });

  it("matches polygon-clipping for union and difference", async () => {
    const clipper = await load();
    expect(await clipper.initClipper(universal)).toBe(true);
    const union = clipper.clipperUnion(polygons)!;
    const reference = polygonClipping.union(...(polygons as Parameters<typeof polygonClipping.union>));
    expect(m2(union) / m2(reference as never)).toBeCloseTo(1, 3); // 1 cm integer grid
    expect(union).toHaveLength(reference.length);

    const cut = [[square(20, -10, 10)]];
    const diff = clipper.clipperDifference(union, cut)!;
    const refDiff = polygonClipping.difference(reference, cut as never);
    expect(m2(diff) / m2(refDiff as never)).toBeCloseTo(1, 3); // 1 cm integer grid
    expect(clipper.clipperDifference(union, [])).toBe(union);
  });
});
