import { readFileSync } from "node:fs";
import { computeShadowResult, createShadowEngine } from "../src/lib/shadow-engine";
import { dateAtMinutes, getSunPosition } from "../src/lib/sun";
import { deciduousLeafFraction } from "../src/lib/leaf";
import { GWANGGYO_CENTER } from "../src/lib/config";
import { createParkGround } from "../src/lib/parkShade";
import { initClipper } from "../src/lib/clipper";
import type { ShadeLayers } from "../src/types/map";

// CLIPPER=0 measures the polygon-clipping fallback. Node loads the universal build of the same WebAssembly library.
const wasm = process.env.CLIPPER !== "0" && (await initClipper(() => import("js-angusj-clipper") as never));
console.log(`union: ${wasm ? "WebAssembly Clipper" : "polygon-clipping"}`);

const files = { buildings: "buildings", paths: "paths", trees: "trees", canopy: "canopy", canopyChm: "canopy_chm", structures: "structures", park: "park" };
const layers = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, JSON.parse(readFileSync(`public/data/gwanggyo/${file}.geojson`, "utf8"))])) as unknown as ShadeLayers;
layers.parkGround = createParkGround(layers.park, layers.buildings);
const engine = createShadowEngine(layers);
const [lng, lat] = GWANGGYO_CENTER;
for (const date of ["2026-09-07", "2026-01-15"]) {
  const deciduousLeaf = deciduousLeafFraction(date);
  for (const minutes of [9 * 60, 12 * 60, 17 * 60, 18 * 60 + 30]) {
    const sun = getSunPosition(dateAtMinutes(date, minutes), lat, lng);
    const result = computeShadowResult(engine, sun, { vegetation: true, canopyChm: true, deciduousLeaf });
    const ms = result.ms;
    console.log(`${date} ${minutes / 60}h KST leaf=${deciduousLeaf.toFixed(2)} alt=${sun.altitudeDeg.toFixed(1)} shadows=${result.shadows.features.length} path=${(100 * result.pathShade.all.ratio).toFixed(1)}% park=${(100 * result.parkShade.ratio).toFixed(1)}% shadows/union/paths=${[ms.shadows, ms.union, ms.paths].map(Math.round).join("/")}ms`);
  }
}
