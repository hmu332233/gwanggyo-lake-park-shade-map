/**
 * Estimate how evergreen the canopy is from the seasonal NDVI of Copernicus Sentinel-2 L2A.
 *
 * Source: Copernicus Sentinel-2 L2A COGs on AWS Open Data (Element 84 Earth Search STAC),
 * free and open under the Copernicus data licence ("Contains modified Copernicus Sentinel data").
 *
 * 1. Read the AOI window (10 m red/NIR, 20 m SCL) for every low-cloud scene of tile 52SCG.
 *    Only pixels classified as vegetation / bare soil are kept (no cloud, shadow or snow).
 * 2. Per pixel, take the winter (Dec–Feb) and summer (Jun–Sep) median NDVI.
 * 3. Among tall-canopy pixels (CHM >= 8 m, summer NDVI >= 0.6), the low and high winter NDVI
 *    percentiles act as deciduous and evergreen end-members; evergreen share is the linear
 *    position of a pixel's winter NDVI between them.
 * 4. Write `evergreenShare` onto canopy_chm / canopy / trees (area mean of pixel centres inside a
 *    polygon, or the pixel under a point/small polygon). OSM leaf_cycle / leaf_type tags win for trees.
 *
 * Run after fetch:osm and fetch:canopy, which rewrite those files:
 *   npm run fetch:leaf
 * The deciduous leaf-out/fall curve printed at the end is what DECIDUOUS_LEAF_CURVE in config.ts encodes.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fromUrl } from "geotiff";
import proj4 from "proj4";
import { bbox as turfBbox, centroid } from "@turf/turf";
import type { Feature, FeatureCollection, MultiPolygon, Point, Polygon, Position } from "geojson";
import { pointInGeometry } from "../src/lib/shade";

const STAC = "https://earth-search.aws.element84.com/v1/search";
const TILE = "MGRS-52SCG";
const YEARS = [2023, 2024, 2025];
const MAX_CLOUD = 40;
const OUT_DIR = join(process.cwd(), "public", "data", "gwanggyo");
const CACHE_DIR = join(process.cwd(), ".cache", "s2");
/** Written by fetch-canopy-chm.ts. */
const CHM_CACHE = join(process.cwd(), ".cache", "chm", "v2_1321103203_window.json");
const PIXEL = 10;
/** SCL classes kept: 4 vegetation, 5 not vegetated. Clouds, shadows, water and snow are dropped. */
const VALID_SCL = new Set([4, 5]);
const WINTER = new Set([12, 1, 2]);
const SUMMER = new Set([6, 7, 8, 9]);
const MIN_OBS = 3;
const NODATA = -32768;

const utm = proj4("+proj=utm +zone=52 +datum=WGS84 +units=m +no_defs");
const toUtm = (p: Position) => utm.forward([p[0], p[1]]);
const toLngLat = (x: number, y: number) => utm.inverse([x, y]);

interface Scene {
  id: string;
  date: string;
  red: string;
  nir: string;
  scl: string;
  offsetApplied: boolean;
  baseline: string;
}

interface Grid {
  /** Top-left corner in UTM 52N and size in 10 m pixels. */
  x0: number;
  y0: number;
  width: number;
  height: number;
}

async function searchScenes(): Promise<Scene[]> {
  const scenes: Scene[] = [];
  for (const year of YEARS) {
    let body: Record<string, unknown> | null = {
      collections: ["sentinel-2-l2a"],
      datetime: `${year}-01-01T00:00:00Z/${year}-12-31T23:59:59Z`,
      query: { "grid:code": { eq: TILE }, "eo:cloud_cover": { lt: MAX_CLOUD } },
      limit: 100,
    };
    while (body) {
      const res = await fetch(STAC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`STAC HTTP ${res.status}`);
      const page = (await res.json()) as {
        features: { id: string; properties: Record<string, unknown>; assets: Record<string, { href: string }> }[];
        links: { rel: string; body?: Record<string, unknown> }[];
      };
      for (const f of page.features) {
        scenes.push({
          id: f.id,
          date: String(f.properties.datetime).slice(0, 10),
          red: f.assets.red.href,
          nir: f.assets.nir.href,
          scl: f.assets.scl.href,
          offsetApplied: f.properties["earthsearch:boa_offset_applied"] === true,
          baseline: String(f.properties["s2:processing_baseline"] ?? "0"),
        });
      }
      body = page.links.find((l) => l.rel === "next")?.body ?? null;
    }
  }
  // Both S2A and S2B/S2C can image the same day; keep one scene per date.
  const byDate = new Map<string, Scene>();
  for (const s of scenes) if (!byDate.has(s.date)) byDate.set(s.date, s);
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

async function readBand(url: string, grid: Grid, scale: number): Promise<{ values: ArrayLike<number>; width: number }> {
  const image = await (await fromUrl(url, { allowFullFile: false })).getImage();
  const [ox, oy] = image.getOrigin();
  const px = PIXEL * scale;
  const c0 = Math.floor((grid.x0 - ox) / px);
  const r0 = Math.floor((oy - grid.y0) / px);
  const c1 = Math.ceil((grid.x0 + grid.width * PIXEL - ox) / px);
  const r1 = Math.ceil((oy - (grid.y0 - grid.height * PIXEL)) / px);
  if ((grid.x0 - ox) % px || (oy - grid.y0) % px) throw new Error("AOI grid is not aligned to the tile grid");
  const raster = (await image.readRasters({ window: [c0, r0, c1, r1], samples: [0] })) as unknown as ArrayLike<number>[];
  return { values: raster[0], width: c1 - c0 };
}

/** NDVI ×10000 per 10 m pixel, NODATA where the SCL class is not clear land. */
async function sceneNdvi(scene: Scene, grid: Grid): Promise<Int16Array> {
  const file = join(CACHE_DIR, `${scene.id}.bin`);
  if (existsSync(file)) return new Int16Array(readFileSync(file).buffer.slice(0));
  const [red, nir, scl] = await Promise.all([readBand(scene.red, grid, 1), readBand(scene.nir, grid, 1), readBand(scene.scl, grid, 2)]);
  // Baseline 04.00+ stores reflectance with a +1000 offset unless the catalogue already removed it.
  const offset = !scene.offsetApplied && Number(scene.baseline) >= 4 ? 1000 : 0;
  const out = new Int16Array(grid.width * grid.height).fill(NODATA);
  for (let r = 0; r < grid.height; r++) {
    for (let c = 0; c < grid.width; c++) {
      const i = r * grid.width + c;
      const cls = scl.values[(r >> 1) * scl.width + (c >> 1)];
      if (!VALID_SCL.has(cls)) continue;
      const R = red.values[r * red.width + c] - offset, N = nir.values[r * nir.width + c] - offset;
      if (R <= 0 || N <= 0) continue;
      out[i] = Math.round(((N - R) / (N + R)) * 10000);
    }
  }
  writeFileSync(file, Buffer.from(out.buffer));
  return out;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function percentile(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];
}

/** CHM height at a UTM position from the cached Meta/WRI CHMv2 window (EPSG:3857). */
function chmSampler(): (x: number, y: number) => number {
  const win = JSON.parse(readFileSync(CHM_CACHE, "utf8")) as { width: number; height: number; originX: number; originY: number; pixel: number; values: number[] };
  const R = 6378137;
  return (x, y) => {
    const [lng, lat] = toLngLat(x, y);
    const mx = (lng * Math.PI * R) / 180;
    const my = R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
    const c = Math.floor((mx - win.originX) / win.pixel), r = Math.floor((win.originY - my) / win.pixel);
    const v = win.values[r * win.width + c];
    return c >= 0 && r >= 0 && c < win.width && r < win.height && Number.isFinite(v) ? v : 0;
  };
}

async function main() {
  mkdirSync(CACHE_DIR, { recursive: true });
  const aoi = JSON.parse(readFileSync(join(OUT_DIR, "aoi.geojson"), "utf8")) as Feature<Polygon>;
  const [w, s, e, n] = turfBbox(aoi);
  const corners = [[w, s], [w, n], [e, s], [e, n]].map(toUtm);
  // Snap to 20 m so the 10 m bands and the 20 m SCL share one window origin.
  const snap = (v: number, up: boolean) => (up ? Math.ceil(v / (2 * PIXEL)) : Math.floor(v / (2 * PIXEL))) * 2 * PIXEL;
  const x0 = snap(Math.min(...corners.map((p) => p[0])), false), x1 = snap(Math.max(...corners.map((p) => p[0])), true);
  const y1 = snap(Math.min(...corners.map((p) => p[1])), false), y0 = snap(Math.max(...corners.map((p) => p[1])), true);
  const grid: Grid = { x0, y0, width: (x1 - x0) / PIXEL, height: (y0 - y1) / PIXEL };
  const size = grid.width * grid.height;
  console.log(`AOI grid ${grid.width}x${grid.height} px (10 m)`);

  const scenes = await searchScenes();
  console.log(`${scenes.length} scenes (${YEARS[0]}–${YEARS[YEARS.length - 1]}, tile cloud < ${MAX_CLOUD}%)`);
  const ndvi: { scene: Scene; values: Int16Array; valid: number }[] = [];
  for (let i = 0; i < scenes.length; i += 4) {
    const batch = scenes.slice(i, i + 4);
    const results = await Promise.all(batch.map(async (scene) => {
      for (let attempt = 1; ; attempt++) {
        try {
          return { scene, values: await sceneNdvi(scene, grid) };
        } catch (err) {
          if (attempt < 3) continue;
          console.warn(`skip ${scene.id}: ${(err as Error).message}`);
          return null;
        }
      }
    }));
    for (const r of results) {
      if (!r) continue;
      let valid = 0;
      for (const v of r.values) if (v !== NODATA) valid++;
      // Mostly cloudy or snowy over the park: its clear pixels are unreliable too.
      if (valid / size >= 0.5) ndvi.push({ ...r, valid });
    }
    process.stdout.write(`\rread ${Math.min(i + 4, scenes.length)}/${scenes.length}`);
  }
  console.log(`\n${ndvi.length} scenes with >= 50% clear land`);

  const month = (d: string) => Number(d.slice(5, 7));
  const composite = (months: Set<number>) => {
    const out = new Float32Array(size).fill(NaN);
    const picked = ndvi.filter((x) => months.has(month(x.scene.date)));
    for (let i = 0; i < size; i++) {
      const vals: number[] = [];
      for (const x of picked) if (x.values[i] !== NODATA) vals.push(x.values[i] / 10000);
      if (vals.length >= MIN_OBS) out[i] = median(vals);
    }
    return { values: out, scenes: picked.length };
  };
  const winter = composite(WINTER);
  const summer = composite(SUMMER);
  console.log(`winter composite from ${winter.scenes} scenes, summer from ${summer.scenes}`);

  // End-members from tall canopy only, so lawns and shrubs do not define "deciduous".
  const chm = chmSampler();
  const center = (i: number) => [x0 + ((i % grid.width) + 0.5) * PIXEL, y0 - (Math.floor(i / grid.width) + 0.5) * PIXEL];
  const treeWinter: number[] = [];
  const isTree = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    const [x, y] = center(i);
    if (summer.values[i] >= 0.6 && Number.isFinite(winter.values[i]) && chm(x, y) >= 8) {
      isTree[i] = 1;
      treeWinter.push(winter.values[i]);
    }
  }
  const deciduous = percentile(treeWinter, 5);
  const evergreen = percentile(treeWinter, 95);
  console.log(`tall-canopy pixels ${treeWinter.length}; winter NDVI p5=${deciduous.toFixed(3)} p50=${percentile(treeWinter, 50).toFixed(3)} p95=${evergreen.toFixed(3)}`);
  const share = new Float32Array(size).fill(NaN);
  for (let i = 0; i < size; i++) {
    if (!Number.isFinite(winter.values[i]) || !(summer.values[i] >= 0.3)) continue;
    share[i] = Math.min(1, Math.max(0, (winter.values[i] - deciduous) / (evergreen - deciduous)));
  }

  // Seasonal curve of clearly deciduous tall canopy, normalised between its winter and summer levels.
  const decid = [...Array(size).keys()].filter((i) => isTree[i] && share[i] <= 0.15);
  const profile: { date: string; doy: number; leaf: number }[] = [];
  const base = median(decid.map((i) => winter.values[i]));
  const top = median(decid.map((i) => summer.values[i]));
  for (const x of ndvi) {
    const vals = decid.filter((i) => x.values[i] !== NODATA).map((i) => x.values[i] / 10000);
    if (vals.length < decid.length * 0.5) continue;
    const d = new Date(`${x.scene.date}T00:00:00Z`);
    const doy = Math.round((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000) + 1;
    profile.push({ date: x.scene.date, doy, leaf: (median(vals) - base) / (top - base) });
  }
  profile.sort((a, b) => a.doy - b.doy);
  console.log(`deciduous profile (${decid.length} px, NDVI ${base.toFixed(3)} → ${top.toFixed(3)}):`);
  for (const p of profile) console.log(`  ${p.date}  doy ${String(p.doy).padStart(3)}  leaf ${p.leaf.toFixed(2)}`);

  // Annotate layers.
  const pixelAt = (p: Position) => {
    const [x, y] = toUtm(p);
    const c = Math.floor((x - x0) / PIXEL), r = Math.floor((y0 - y) / PIXEL);
    return c >= 0 && r >= 0 && c < grid.width && r < grid.height ? share[r * grid.width + c] : NaN;
  };
  const round = (v: number) => (Number.isFinite(v) ? Math.round(v * 20) / 20 : null);
  const polygonShare = (g: Polygon | MultiPolygon) => {
    const [bw, bs, be, bn] = turfBbox(g);
    const a = toUtm([bw, bs]), b = toUtm([be, bn]);
    const c0 = Math.max(0, Math.floor((Math.min(a[0], b[0]) - x0) / PIXEL)), c1 = Math.min(grid.width - 1, Math.floor((Math.max(a[0], b[0]) - x0) / PIXEL));
    const r0 = Math.max(0, Math.floor((y0 - Math.max(a[1], b[1])) / PIXEL)), r1 = Math.min(grid.height - 1, Math.floor((y0 - Math.min(a[1], b[1])) / PIXEL));
    let sum = 0, count = 0;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const v = share[r * grid.width + c];
        if (!Number.isFinite(v)) continue;
        const [lng, lat] = toLngLat(x0 + (c + 0.5) * PIXEL, y0 - (r + 0.5) * PIXEL);
        if (!pointInGeometry([lng, lat], g)) continue;
        sum += v;
        count++;
      }
    }
    return count ? sum / count : pixelAt(centroid(g).geometry.coordinates);
  };

  const annotate = (file: string, fn: (f: Feature) => number | null) => {
    const path = join(OUT_DIR, file);
    const fc = JSON.parse(readFileSync(path, "utf8")) as FeatureCollection;
    let known = 0;
    for (const f of fc.features) {
      const v = fn(f);
      f.properties = { ...f.properties, evergreenShare: v };
      if (v !== null) known++;
    }
    writeFileSync(path, JSON.stringify(fc));
    console.log(`${file}: evergreenShare on ${known}/${fc.features.length}`);
    return fc;
  };
  annotate("canopy_chm.geojson", (f) => round(polygonShare((f as Feature<Polygon | MultiPolygon>).geometry)));
  const canopy = annotate("canopy.geojson", (f) => {
    const tagged = shareFromTags(f.properties?.leafType, f.properties?.leafCycle);
    return tagged ?? round(polygonShare((f as Feature<Polygon | MultiPolygon>).geometry));
  });
  annotate("trees.geojson", (f) => {
    const tagged = shareFromTags(f.properties?.leafType, f.properties?.leafCycle);
    return tagged ?? round(pixelAt((f as Feature<Point>).geometry.coordinates));
  });
  // Sanity check: OSM stands tagged with a leaf type next to the satellite estimate.
  for (const f of canopy.features) {
    if (!f.properties?.leafType) continue;
    console.log(`  check ${f.properties.id} leaf_type=${f.properties.leafType}: satellite ${round(polygonShare((f as Feature<Polygon | MultiPolygon>).geometry))}`);
  }
}

/**
 * OSM leaf_cycle wins over leaf_type. Around Suwon, needle-leaved trees are overwhelmingly evergreen
 * pines and broad-leaved evergreens are not hardy, so leaf_type alone is a reliable proxy.
 */
function shareFromTags(leafType?: string | null, leafCycle?: string | null): number | null {
  if (leafCycle === "evergreen") return 1;
  if (leafCycle === "deciduous") return 0;
  if (leafCycle === "semi_evergreen" || leafCycle === "semi_deciduous" || leafCycle === "mixed") return 0.5;
  if (leafType === "needleleaved") return 1;
  if (leafType === "broadleaved") return 0;
  return null;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
