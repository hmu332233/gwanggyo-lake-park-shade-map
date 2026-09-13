/**
 * Data access layer. Everything the map needs is loaded once from static GeoJSON
 * and kept in memory; only derived geometry (shadows, shade ratios) is recomputed.
 *
 * To swap OSM buildings for a government dataset (건축물대장 / 국토부 GIS 건물통합정보),
 * regenerate buildings.geojson with the same `BuildingProperties` schema — nothing
 * in the UI or shadow logic needs to change. Same for trees/canopy/structures.
 */
import type { FeatureCollection, MultiPolygon, Polygon } from "geojson";
import { createParkGround } from "./parkShade";
import type {
  BuildingCollection,
  CanopyCollection,
  PathCollection,
  ShadeLayers,
  StructureCollection,
  TreeCollection,
} from "../types/map";

const BASE = `${import.meta.env.BASE_URL}data/gwanggyo`;

async function loadJSON<T>(name: string): Promise<T> {
  const res = await fetch(`${BASE}/${name}`);
  if (!res.ok) throw new Error(`Failed to load ${name}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export type GwanggyoData = ShadeLayers;

export async function loadGwanggyoData(): Promise<GwanggyoData> {
  const empty: CanopyCollection = { type: "FeatureCollection", features: [] };
  const [park, buildings, paths, trees, canopy, structures, canopyChm] = await Promise.all([
    loadJSON<FeatureCollection<Polygon | MultiPolygon>>("park.geojson"),
    loadJSON<BuildingCollection>("buildings.geojson"),
    loadJSON<PathCollection>("paths.geojson"),
    loadJSON<TreeCollection>("trees.geojson"),
    loadJSON<CanopyCollection>("canopy.geojson"),
    loadJSON<StructureCollection>("structures.geojson"),
    // Optional: satellite canopy may not have been generated yet.
    loadJSON<CanopyCollection>("canopy_chm.geojson").catch(() => empty),
  ]);
  return { park, parkGround: createParkGround(park, buildings), buildings, paths, trees, canopy, structures, canopyChm };
}
