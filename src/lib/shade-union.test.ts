import { expect, it } from "vitest";
import type { Polygon } from "geojson";
import { pointInGeometry, unionShadows } from "./shade";

it("unions nearly collinear height-band shadows instead of dropping all map shade", () => {
  // Minimized from the 2026-09-07 18:00 KST canopy shadows. The clipping
  // library cannot order their shared edge events at full double precision.
  const coordinates: Polygon["coordinates"][] = [[[[127.05437412652037, 37.27820283249227], [127.05460663386097, 37.278201895002965], [127.05454771971951, 37.27916989858239], [127.05437412652037, 37.27820283249227]]], [[[127.05437412652037, 37.27820283249227], [127.0548059258672, 37.2782010914407], [127.05403625965116, 37.27903709169443], [127.05437412652037, 37.27820283249227]]], [[[127.05437412652037, 37.27820283249227], [127.05500521787341, 37.278200287878434], [127.05410063266753, 37.2789147296092], [127.05437412652037, 37.27820283249227]]], [[[127.05466926097868, 37.27740705101173], [127.0550632993101, 37.278201503253776], [127.05459555572645, 37.27820282143396], [127.0545928131479, 37.27820283249227], [127.05466926097868, 37.27740705101173]]]];
  const result = unionShadows({ type: "FeatureCollection", features: coordinates.map((rings, i) => ({
    type: "Feature", geometry: { type: "Polygon", coordinates: rings },
    properties: { sourceId: String(i), kind: "canopy", height: 10, shadowLength: 50, shade: 1 },
  })) });
  expect(result).not.toBeNull();
  for (const rings of coordinates.slice(0, 4)) {
    const vertices = rings[0].slice(0, 3);
    const center = [0, 1].map(axis => vertices.reduce((sum, p) => sum + p[axis], 0) / 3);
    expect(pointInGeometry(center, result!)).toBe(true);
  }
});
