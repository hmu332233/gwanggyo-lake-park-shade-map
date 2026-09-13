import { readFileSync } from "node:fs";
import { computeShadowResult, createShadowEngine } from "../src/lib/shadow-engine";
import { dateAtMinutes, getSunPosition } from "../src/lib/sun";
import { GWANGGYO_CENTER } from "../src/lib/config";
import { createParkGround } from "../src/lib/parkShade";
import type { ShadeLayers } from "../src/types/map";

const files = { buildings: "buildings", paths: "paths", trees: "trees", canopy: "canopy", canopyChm: "canopy_chm", structures: "structures", park: "park" };
const layers = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, JSON.parse(readFileSync(`public/data/gwanggyo/${file}.geojson`, "utf8"))])) as unknown as ShadeLayers;
layers.parkGround = createParkGround(layers.park, layers.buildings);
const engine = createShadowEngine(layers);
const [lng, lat] = GWANGGYO_CENTER;
for (const minutes of [9 * 60, 12 * 60, 17 * 60, 18 * 60 + 30]) {
  const sun = getSunPosition(dateAtMinutes("2026-09-07", minutes), lat, lng);
  const result = computeShadowResult(engine, sun, { vegetation: true, canopyChm: true });
  const ms = result.ms;
  console.log(`${minutes / 60}h KST alt=${sun.altitudeDeg.toFixed(1)} shadows=${result.shadows.features.length} segments=${result.segmentPaths.features.length} shade=${(100 * result.pathShade.all.ratio).toFixed(1)}% shadows/union/paths=${[ms.shadows, ms.union, ms.paths].map(Math.round).join("/")}ms`);
}
