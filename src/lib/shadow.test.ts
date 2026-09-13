import { describe, it, expect } from "vitest";
import { calculateAllShadows, calculateBuildingShadow, shadowLength } from "./shadow";
import type { ShadeLayers } from "../types/map";
import { dateAtMinutes, getSunPosition, shadowBearingDeg } from "./sun";
import { centroid, area } from "@turf/turf";
import type { Polygon } from "geojson";

const deg = (r: number) => (r * 180) / Math.PI;
const rad = (d: number) => (d * Math.PI) / 180;

describe("canopy source preference", () => {
  it("uses detailed canopy without broad forest fills, retaining individual trees and facilities", () => {
    const empty = { type: "FeatureCollection" as const, features: [] };
    const geometry: Polygon = { type: "Polygon", coordinates: [[[127, 37], [127.001, 37], [127.001, 37.001], [127, 37.001], [127, 37]]] };
    const layers: ShadeLayers = {
      buildings: empty, paths: empty, park: empty, parkGround: empty,
      trees: { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [127, 37] }, properties: { id: "tree", height: 8, crownRadius: 3, heightSource: "osm", species: null } }] },
      structures: { type: "FeatureCollection", features: [{ type: "Feature", geometry, properties: { id: "shelter", kind: "pavilion", height: 3, heightSource: "osm", name: null } }] },
      canopy: { type: "FeatureCollection", features: [{ type: "Feature", geometry, properties: { id: "coarse", height: 12, heightSource: "estimated", name: null } }] },
      canopyChm: { type: "FeatureCollection", features: [{ type: "Feature", geometry, properties: { id: "detailed", height: 6.5, heightSource: "chm", name: null } }] },
    };
    const sun = { altitude: rad(45), altitudeDeg: 45, azimuth: rad(180), azimuthDeg: 180 };
    const ids = (data: ShadeLayers, canopyChm = true) => calculateAllShadows(data, sun, { vegetation: true, canopyChm }).features.map(f => f.properties.sourceId);
    expect(ids(layers)).toEqual(["tree", "shelter", "detailed"]);
    expect(ids(layers, false)).toEqual(["tree", "shelter"]);
    expect(ids({ ...layers, canopyChm: empty })).toEqual(["tree", "coarse", "shelter"]);
  });
});

// ~20m x 20m square near Gwanggyo
const square: Polygon = {
  type: "Polygon",
  coordinates: [[
    [127.0665, 37.2835],
    [127.06673, 37.2835],
    [127.06673, 37.28368],
    [127.0665, 37.28368],
    [127.0665, 37.2835],
  ]],
};

describe("shadowLength", () => {
  it("is h / tan(alt)", () => {
    expect(shadowLength(10, rad(45))).toBeCloseTo(10, 5);
    expect(shadowLength(30, rad(30))).toBeCloseTo(30 / Math.tan(rad(30)), 5);
  });
  it("is 0 when sun is at/below horizon", () => {
    expect(shadowLength(10, 0)).toBe(0);
    expect(shadowLength(10, -0.2)).toBe(0);
  });
  it("is clamped for very low sun", () => {
    expect(shadowLength(100, rad(0.6))).toBeLessThanOrEqual(600);
  });
});

describe("sun azimuth convention", () => {
  it("sun is roughly south at solar noon in Gwanggyo (KST ~12:30)", () => {
    const d = dateAtMinutes("2026-06-21", 12 * 60 + 30); // June 21 12:30 Korea time
    const s = getSunPosition(d, 37.2835, 127.0665);
    expect(s.altitudeDeg).toBeGreaterThan(70);
    expect(Math.abs(s.azimuthDeg - 180)).toBeLessThan(15);
  });
  it("sun is in the west in the late afternoon", () => {
    const d = dateAtMinutes("2026-09-06", 17 * 60);
    const s = getSunPosition(d, 37.2835, 127.0665);
    expect(s.azimuthDeg).toBeGreaterThan(240);
    expect(s.azimuthDeg).toBeLessThan(290);
  });
  it("shadow bearing is opposite of the sun", () => {
    // sun at SW (225°) -> shadow toward NE (45°)
    expect(shadowBearingDeg(rad(225))).toBeCloseTo(45, 5);
    // sun at S (180°) -> shadow N (0°)
    expect(shadowBearingDeg(rad(180))).toBeCloseTo(0, 5);
    // sun at E (90°) -> shadow W (-90° in Turf convention)
    expect(shadowBearingDeg(rad(90))).toBeCloseTo(-90, 5);
  });
});

describe("calculateBuildingShadow", () => {
  it("returns null below horizon", () => {
    expect(calculateBuildingShadow(square, 30, -0.1, 0)).toBeNull();
  });
  it("extends to the north-east when the sun is south-west", () => {
    const s = calculateBuildingShadow(square, 30, rad(45), rad(225));
    expect(s).not.toBeNull();
    const c0 = centroid({ type: "Feature", geometry: square, properties: {} }).geometry.coordinates;
    const c1 = centroid(s!).geometry.coordinates;
    expect(c1[0]).toBeGreaterThan(c0[0]); // east
    expect(c1[1]).toBeGreaterThan(c0[1]); // north
  });
  it("is larger than the footprint and grows as the sun lowers", () => {
    const base = area({ type: "Feature", geometry: square, properties: {} });
    const hi = area(calculateBuildingShadow(square, 30, rad(60), rad(200))!);
    const lo = area(calculateBuildingShadow(square, 30, rad(20), rad(200))!);
    expect(hi).toBeGreaterThan(base);
    expect(lo).toBeGreaterThan(hi);
  });
  it("handles concave (L-shaped) footprints", () => {
    const L: Polygon = {
      type: "Polygon",
      coordinates: [[
        [127.0665, 37.2835],
        [127.0668, 37.2835],
        [127.0668, 37.2836],
        [127.0666, 37.2836],
        [127.0666, 37.2838],
        [127.0665, 37.2838],
        [127.0665, 37.2835],
      ]],
    };
    const s = calculateBuildingShadow(L, 40, rad(30), rad(240));
    expect(s).not.toBeNull();
    expect(area(s!)).toBeGreaterThan(area({ type: "Feature", geometry: L, properties: {} }));
    void deg;
  });
});

describe("sweep geometry sanity", () => {
  it("concave shadow contains the footprint and the translated footprint", async () => {
    const { booleanContains, buffer } = await import("@turf/turf");
    const { offsetPosition } = await import("./geo");
    const L: Polygon = {
      type: "Polygon",
      coordinates: [[
        [127.0665, 37.2835],
        [127.0668, 37.2835],
        [127.0668, 37.2836],
        [127.0666, 37.2836],
        [127.0666, 37.2838],
        [127.0665, 37.2838],
        [127.0665, 37.2835],
      ]],
    };
    const s = calculateBuildingShadow(L, 40, rad(30), rad(240))!;
    expect(s.geometry.type).toBe("Polygon"); // union must collapse to a single simple polygon
    const foot = { type: "Feature" as const, geometry: L, properties: {} };
    // shadow bearing for sun at 240° is 60°; length = 40/tan(30°) ≈ 69.3 m
    const len = 40 / Math.tan(rad(30));
    const moved = {
      type: "Feature" as const,
      properties: {},
      geometry: { type: "Polygon" as const, coordinates: [L.coordinates[0].map((p) => offsetPosition(p, len, 60))] },
    };
    // Shrink by 0.5 m so shared boundaries don't trip the containment predicate.
    const shrink = (f: typeof foot) => buffer(f, -0.5, { units: "meters" })!;
    expect(booleanContains(s as never, shrink(foot) as never)).toBe(true);
    expect(booleanContains(s as never, shrink(moved) as never)).toBe(true);
  });
});

describe("calculateTreeShadow", () => {
  it("makes an elongated shadow from a crown circle toward the shadow bearing", async () => {
    const { calculateTreeShadow } = await import("./shadow");
    const { centroid } = await import("@turf/turf");
    const c: [number, number] = [127.0665, 37.2835];
    const s = calculateTreeShadow(c, 8, 3, rad(30), rad(225)); // sun SW -> shadow NE
    expect(s).not.toBeNull();
    const cc = centroid(s!).geometry.coordinates;
    expect(cc[0]).toBeGreaterThan(c[0]);
    expect(cc[1]).toBeGreaterThan(c[1]);
  });
});

describe("canopy clearings", () => {
  // Meter-based fixtures make the intended sunlit/shaded locations explicit.
  const origin = [127.0665, 37.2835];
  const position = (x: number, y: number) => [
    origin[0] + x / (6378137 * Math.cos(rad(origin[1]))) * 180 / Math.PI,
    origin[1] + y / 6378137 * 180 / Math.PI,
  ];
  const ring = (points: number[][]) => points.map(([x, y]) => position(x, y));
  const clearing: Polygon = {
    type: "Polygon",
    coordinates: [
      ring([[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]]),
      ring([[20, 20], [20, 80], [80, 80], [80, 20], [20, 20]]),
    ],
  };

  it("keeps the center of a clearing sunny while its southern edge receives shadow", async () => {
    const { booleanPointInPolygon } = await import("@turf/turf");
    const { calculateCanopyShadows } = await import("./shadow");
    const shadows = calculateCanopyShadows({
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: clearing, properties: {
        id: "clearing", height: 10, heightSource: "chm", name: null,
      } }],
    }, { altitude: rad(45), azimuth: rad(180), altitudeDeg: 45, azimuthDeg: 180 });
    expect(shadows.features).toHaveLength(1);
    expect(booleanPointInPolygon(position(50, 50), shadows.features[0])).toBe(false);
    expect(booleanPointInPolygon(position(50, 25), shadows.features[0])).toBe(true);
    expect(booleanPointInPolygon(position(10, 105), shadows.features[0])).toBe(true);
  });

  it("lets a sufficiently long shadow cover a clearing", async () => {
    const { booleanPointInPolygon } = await import("@turf/turf");
    const shadow = calculateBuildingShadow(clearing, 80, rad(45), rad(180), { preserveVoids: true })!;
    expect(booleanPointInPolygon(position(50, 50), shadow)).toBe(true);
  });

  it("retains a shallow concavity even above the building hull threshold", async () => {
    const { booleanPointInPolygon } = await import("@turf/turf");
    const footprint: Polygon = { type: "Polygon", coordinates: [ring([
      [0, 0], [100, 0], [100, 100], [60, 100], [60, 90], [40, 90], [40, 100], [0, 100], [0, 0],
    ])] };
    const shadow = calculateBuildingShadow(footprint, 2, rad(45), rad(180), { preserveVoids: true })!;
    expect(booleanPointInPolygon(position(50, 97), shadow)).toBe(false);
    expect(booleanPointInPolygon(position(50, 91), shadow)).toBe(true);
  });
});
