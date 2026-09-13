/**
 * Build the static GeoJSON layers for Gwanggyo Lake Park from OpenStreetMap (Overpass API).
 *
 *   npm run fetch:osm            # uses .cache/osm/*.json when present, otherwise downloads
 *   npm run fetch:osm -- --force # ignore cache and re-download
 *
 * Output (public/data/gwanggyo/):
 *   park.geojson        park boundary + the two reservoirs (원천저수지, 신대저수지)
 *   buildings.geojson   buildings whose shadow can reach the park (see "shadow filter" below), with normalized height
 *   paths.geojson       all OSM walking ways clipped to the park boundary
 *   trees.geojson       natural=tree points (height / crownRadius, estimated when untagged)
 *   canopy.geojson      natural=wood|scrub, landuse=forest|orchard polygons (height)
 *   structures.geojson  amenity=shelter (정자/파고라), man_made=pergola|bridge, leisure=bandstand
 *
 * Height rules (shared with runtime in src/lib/buildings.ts):
 *   height tag                     -> as-is                     heightSource = "osm"
 *   building:levels only           -> levels * METERS_PER_LEVEL heightSource = "levels"
 *   neither                        -> per-type default          heightSource = "estimated"
 * For "estimated" we prefer a LOCAL default: the median height of same-type buildings in the
 * AOI that do have height/levels (e.g. apartments here are ~25 floors, not a generic 15 floors).
 *
 * Shadow filter: a building is kept only if it lies inside the park or at least one of its shadows,
 * sampled every SHADOW_FILTER_STEP_MIN minutes 07:00–19:00 on SHADOW_FILTER_DATES (solstices + equinox),
 * intersects the park polygon (park boundary ∪ reservoirs). Everything else is irrelevant to lakeside shade.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import osmtogeojson from "osmtogeojson";
import { booleanIntersects, buffer, featureCollection, union } from "@turf/turf";
import type { Feature, FeatureCollection, LineString, MultiPolygon, Point, Polygon } from "geojson";
import { normalizeBuildingHeight, parseOsmHeight } from "../src/lib/buildings";
import { calculateBuildingShadow } from "../src/lib/shadow";
import { dateAtMinutes, getSunPosition } from "../src/lib/sun";
import { selectParkPaths } from "./select-park-paths";
import type { PathCollection } from "../src/types/map";
import {
  AOI_BUFFER_M,
  GWANGGYO_BBOX,
  GWANGGYO_CENTER,
  TREE_DEFAULTS,
  CANOPY_DEFAULT_HEIGHT_M,
  STRUCTURE_DEFAULT_HEIGHT_M,
  SHADOW_FILTER_DATES,
  SHADOW_FILTER_STEP_MIN,
} from "../src/lib/config";

const FORCE = process.argv.includes("--force");
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const CACHE_DIR = join(process.cwd(), ".cache", "osm");
const OUT_DIR = join(process.cwd(), "public", "data", "gwanggyo");

const { south, west, north, east } = GWANGGYO_BBOX;
const bbox = `${south},${west},${north},${east}`;

const QUERIES = {
  park: `
[out:json][timeout:120];
(
  way["leisure"="park"]["name"~"광교호수"](${bbox});
  relation["leisure"="park"]["name"~"광교호수"](${bbox});
  way["natural"="water"]["name"~"원천|신대"](${bbox});
  relation["natural"="water"]["name"~"원천|신대"](${bbox});
);
out body; >; out skel qt;`,
  buildings: `
[out:json][timeout:180];
(
  way["building"](${bbox});
  relation["building"](${bbox});
);
out body; >; out skel qt;`,
  paths: `
[out:json][timeout:180];
(
  way["highway"~"^(footway|path|pedestrian)$"](${bbox});
);
out body; >; out skel qt;`,
  nature: `
[out:json][timeout:180];
(
  node["natural"="tree"](${bbox});
  way["natural"="tree_row"](${bbox});
  way["natural"~"^(wood|scrub)$"](${bbox});
  relation["natural"~"^(wood|scrub)$"](${bbox});
  way["landuse"~"^(forest|orchard)$"](${bbox});
  relation["landuse"~"^(forest|orchard)$"](${bbox});
  way["leisure"="garden"](${bbox});
  node["amenity"="shelter"](${bbox});
  way["amenity"="shelter"](${bbox});
  way["man_made"~"^(pergola|bridge)$"](${bbox});
  way["leisure"="bandstand"](${bbox});
  way["shelter_type"](${bbox});
);
out body; >; out skel qt;`,
};

async function overpass(name: keyof typeof QUERIES): Promise<unknown> {
  const cacheFile = join(CACHE_DIR, `${name}.json`);
  if (!FORCE && existsSync(cacheFile)) {
    console.log(`[${name}] using cache ${cacheFile}`);
    return JSON.parse(readFileSync(cacheFile, "utf8"));
  }
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    for (const url of OVERPASS_ENDPOINTS) {
      try {
        console.log(`[${name}] fetching from ${url} (attempt ${attempt + 1})`);
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
            "User-Agent": "gwanggyo-lake-park-shade-map/0.1 (OSM data fetch for a local shade-map MVP)",
          },
          body: "data=" + encodeURIComponent(QUERIES[name]),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { elements?: unknown[] };
        if (!Array.isArray(json.elements)) throw new Error("no elements in response");
        mkdirSync(CACHE_DIR, { recursive: true });
        writeFileSync(cacheFile, JSON.stringify(json));
        return json;
      } catch (e) {
        console.warn(`[${name}] failed at ${url}: ${(e as Error).message}`);
        lastErr = e;
      }
    }
    await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
  }
  throw lastErr;
}

type PolyFeature = Feature<Polygon | MultiPolygon>;
const isPoly = (f: Feature): f is PolyFeature =>
  f.geometry?.type === "Polygon" || f.geometry?.type === "MultiPolygon";
const tagsOf = (f: Feature) => (f.properties ?? {}) as Record<string, string | undefined>;

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  // 1. Park boundary + reservoirs -> area of interest
  const parkGeo = osmtogeojson((await overpass("park")) as never) as FeatureCollection;
  const parkPolys = parkGeo.features.filter(
    (f) => isPoly(f) && /광교호수공원|원천저수지|신대저수지/.test(tagsOf(f).name ?? ""),
  ) as PolyFeature[];
  if (parkPolys.length === 0) throw new Error("park polygon not found in Overpass result");
  const parkOut: FeatureCollection<Polygon | MultiPolygon> = {
    type: "FeatureCollection",
    features: parkPolys.map((f) => ({
      type: "Feature",
      geometry: f.geometry,
      properties: {
        id: String(f.id ?? ""),
        name: tagsOf(f).name ?? null,
        kind: tagsOf(f).natural === "water" ? "water" : "park",
      },
    })),
  };
  writeFileSync(join(OUT_DIR, "park.geojson"), JSON.stringify(parkOut));
  console.log(`park.geojson: ${parkOut.features.length} features (${parkPolys.map((f) => tagsOf(f).name).join(", ")})`);

  const parkUnion = parkPolys.length > 1 ? union(featureCollection(parkPolys))! : parkPolys[0];
  const aoi = buffer(parkUnion, AOI_BUFFER_M, { units: "meters" })!;
  writeFileSync(join(OUT_DIR, "aoi.geojson"), JSON.stringify(aoi));

  // 2. Buildings
  const buildingsGeo = osmtogeojson((await overpass("buildings")) as never) as FeatureCollection;
  const candidates = buildingsGeo.features.filter(
    (f) => isPoly(f) && !!tagsOf(f).building && booleanIntersects(f as PolyFeature, aoi),
  ) as PolyFeature[];

  // Local per-type default heights from buildings that DO have height/levels.
  const knownByType = new Map<string, number[]>();
  for (const f of candidates) {
    const tags = tagsOf(f);
    const h = normalizeBuildingHeight(tags);
    if (h.heightSource === "estimated") continue;
    const type = (tags.building ?? "yes").toLowerCase();
    knownByType.set(type, [...(knownByType.get(type) ?? []), h.height]);
  }
  const localDefaults: Record<string, number> = {};
  for (const [type, hs] of knownByType) {
    if (hs.length >= 5) localDefaults[type] = Math.round(median(hs)!);
  }
  console.log("local default heights (median of tagged buildings, n>=5):", localDefaults);

  // Sun positions used by the shadow filter (park center is accurate enough for a 3 km area).
  const [cLng, cLat] = GWANGGYO_CENTER;
  const sunSamples = SHADOW_FILTER_DATES.flatMap((iso) => {
    const out = [];
    for (let min = 7 * 60; min <= 19 * 60; min += SHADOW_FILTER_STEP_MIN) {
      const sun = getSunPosition(dateAtMinutes(iso, min), cLat, cLng);
      if (sun.altitudeDeg > 0.5) out.push(sun);
    }
    return out;
  });
  const affectsPark = (f: PolyFeature, height: number): boolean => {
    if (booleanIntersects(f, parkUnion)) return true;
    for (const sun of sunSamples) {
      const sh = calculateBuildingShadow(f.geometry, height, sun.altitude, sun.azimuth);
      if (sh && booleanIntersects(sh, parkUnion)) return true;
    }
    return false;
  };

  const counts: Record<string, number> = { osm: 0, levels: 0, estimated: 0 };
  const buildings: Feature[] = [];
  let dropped = 0;
  for (const f of candidates) {
    const tags = tagsOf(f);
    const h = normalizeBuildingHeight(tags, localDefaults);
    if (!affectsPark(f, h.height)) {
      dropped++;
      continue;
    }
    counts[h.heightSource]++;
    const levels = tags["building:levels"] ? Number(tags["building:levels"]) : NaN;
    buildings.push({
      type: "Feature",
      id: f.id,
      geometry: f.geometry,
      properties: {
        id: String(f.id ?? ""),
        building: tags.building,
        name: tags.name ?? tags["name:ko"] ?? null,
        levels: Number.isFinite(levels) ? levels : null,
        height: h.height,
        heightSource: h.heightSource,
      },
    });
  }
  writeFileSync(join(OUT_DIR, "buildings.geojson"), JSON.stringify({ type: "FeatureCollection", features: buildings }));
  // All AOI footprints (kept or not) for masking roofs out of the satellite canopy layer.
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(
    join(CACHE_DIR, "buildings_aoi_footprints.geojson"),
    JSON.stringify({ type: "FeatureCollection", features: candidates.map((f) => ({ type: "Feature", geometry: f.geometry, properties: {} })) }),
  );
  console.log(`buildings.geojson: ${buildings.length} features (dropped ${dropped} that never shade the park)`, counts);

  // 3. Walking paths
  const pathsGeo = osmtogeojson((await overpass("paths")) as never) as FeatureCollection;
  const paths: Feature<LineString>[] = [];
  for (const f of pathsGeo.features) {
    if (f.geometry.type !== "LineString") continue;
    const tags = tagsOf(f);
    if (!tags.highway) continue;
    if (!booleanIntersects(f as Feature<LineString>, aoi)) continue;
    paths.push({
      type: "Feature",
      id: f.id,
      geometry: f.geometry,
      properties: {
        id: String(f.id ?? ""),
        highway: tags.highway,
        name: tags.name ?? null,
        surface: tags.surface ?? null,
      },
    });
  }
  const allPaths = { type: "FeatureCollection", features: paths } as PathCollection;
  writeFileSync(join(CACHE_DIR, "paths_aoi.geojson"), JSON.stringify(allPaths));
  const parkPaths = selectParkPaths(allPaths, parkOut);
  writeFileSync(join(OUT_DIR, "paths.geojson"), JSON.stringify(parkPaths));
  console.log(`paths.geojson: ${parkPaths.features.length} park paths (from ${paths.length} OSM ways)`);

  // 4. Trees / canopy / structures
  const natureGeo = osmtogeojson((await overpass("nature")) as never) as FeatureCollection;
  const trees: Feature<Point>[] = [];
  const canopy: Feature<Polygon | MultiPolygon>[] = [];
  const structures: Feature<Polygon | MultiPolygon>[] = [];
  for (const f of natureGeo.features) {
    const tags = tagsOf(f);
    let hit = false;
    try {
      hit = booleanIntersects(f as never, aoi);
    } catch {
      hit = false;
    }
    if (!hit) continue;
    const id = String(f.id ?? "");
    if (f.geometry.type === "Point" && tags.natural === "tree") {
      const height = parseOsmHeight(tags.height);
      const crown = parseOsmHeight(tags.diameter_crown);
      trees.push({
        type: "Feature",
        geometry: f.geometry,
        properties: {
          id,
          height: height ?? TREE_DEFAULTS.height,
          crownRadius: crown ? crown / 2 : TREE_DEFAULTS.crownRadius,
          heightSource: height ? "osm" : "estimated",
          species: tags.species ?? tags.genus ?? null,
        },
      });
      continue;
    }
    if (!isPoly(f)) continue;
    const isCanopy = /^(wood|scrub)$/.test(tags.natural ?? "") || /^(forest|orchard)$/.test(tags.landuse ?? "");
    if (isCanopy) {
      const height = parseOsmHeight(tags.height);
      canopy.push({
        type: "Feature",
        geometry: f.geometry,
        properties: { id, height: height ?? CANOPY_DEFAULT_HEIGHT_M, heightSource: height ? "osm" : "estimated", name: tags.name ?? null },
      });
      continue;
    }
    const kind = tags.amenity === "shelter"
      ? (tags.shelter_type === "pergola" ? "pergola" : "pavilion")
      : tags.man_made === "pergola" ? "pergola"
      : tags.man_made === "bridge" ? "bridge"
      : tags.leisure === "bandstand" ? "pavilion"
      : null;
    if (!kind) continue;
    const height = parseOsmHeight(tags.height);
    structures.push({
      type: "Feature",
      geometry: f.geometry,
      properties: { id, kind, height: height ?? STRUCTURE_DEFAULT_HEIGHT_M[kind], heightSource: height ? "osm" : "estimated", name: tags.name ?? null },
    });
  }
  writeFileSync(join(OUT_DIR, "trees.geojson"), JSON.stringify({ type: "FeatureCollection", features: trees }));
  writeFileSync(join(OUT_DIR, "canopy.geojson"), JSON.stringify({ type: "FeatureCollection", features: canopy }));
  writeFileSync(join(OUT_DIR, "structures.geojson"), JSON.stringify({ type: "FeatureCollection", features: structures }));
  console.log(`trees.geojson: ${trees.length} · canopy.geojson: ${canopy.length} · structures.geojson: ${structures.length}`);
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
