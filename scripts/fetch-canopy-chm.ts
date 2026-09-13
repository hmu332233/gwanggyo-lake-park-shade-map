/**
 * Estimate tree canopy around Gwanggyo Lake Park from satellite imagery.
 *
 * Source: Meta & WRI "High Resolution Canopy Height Maps" (Tolan et al. 2024),
 * Canopy height estimates derived from Maxar imagery, CC BY 4.0, public COGs on AWS Open Data:
 *   https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float/chm/<quadkey>.tif
 *
 * Read the native-resolution AOI window (HTTP range requests, or a cached tile).
 * Contour nested height thresholds every 3 m starting at 2 m, simplify (~1 m),
 * subtract buildings and lake water, clip to the AOI and write canopy_chm.geojson.
 * Native pixels preserve small crowns that averaging with adjacent ground erased.
 * These are historical satellite estimates, not a current individual-tree inventory.
 * Heights are band representatives → heightSource "chm".
 *
 *   npm run fetch:canopy
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fromUrl, fromFile } from "geotiff";
import { contours } from "d3-contour";
import polygonClipping from "polygon-clipping";
import { area, simplify, bbox as turfBbox } from "@turf/turf";
import type { Feature, FeatureCollection, MultiPolygon, Polygon, Position } from "geojson";

const TILE = "132110320"; // z9 quadkey covering Gwanggyo (from tiles.geojson)
const URL_ = `https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float/chm/${TILE}.tif`;
const OUT_DIR = join(process.cwd(), "public", "data", "gwanggyo");
const CACHE = join(process.cwd(), ".cache", "chm", `${TILE}_window.json`);

/** Canopy height bands: [min, representative height]. */
const BANDS: [number, number][] = [
  [2, 3.5], // low woody vegetation, including young trees and tall shrubs
  [5, 6.5],
  [8, 9.5],
  [11, 12.5],
  [14, 15.5],
  [17, 18.5],
  [20, 21.5],
  [23, 24.5],
  [26, 27.5],
];
const MIN_AREA_M2 = 4;
/** About one source pixel: preserve crowns while keeping interactive shadow sweeps practical. */
const SIMPLIFY_TOL = 0.00001;
/** Polygons larger than this are cut by a grid so a single huge stand doesn't dominate compute. */
const SPLIT_AREA_M2 = 20000;
const SPLIT_CELL_M = 150;

// --- Web Mercator helpers ---
const R = 6378137;
const lngToX = (lng: number) => (lng * Math.PI * R) / 180;
const latToY = (lat: number) => R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const xToLng = (x: number) => (x / R) * (180 / Math.PI);
const yToLat = (y: number) => (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI);

interface Window {
  width: number;
  height: number;
  /** top-left in EPSG:3857 meters and pixel size */
  originX: number;
  originY: number;
  pixel: number;
  values: number[];
}

async function readWindow(aoiBbox: [number, number, number, number]): Promise<Window> {
  if (existsSync(CACHE)) {
    console.log("using cached window", CACHE);
    return JSON.parse(readFileSync(CACHE, "utf8")) as Window;
  }
  const localTif = join(process.cwd(), ".cache", "chm", `${TILE}.tif`);
  const tiff = existsSync(localTif) ? await fromFile(localTif) : await fromUrl(URL_, { allowFullFile: false });
  const image = await tiff.getImage();
  const [ox, oy] = image.getOrigin();
  const [rx, ry] = image.getResolution();
  const geoKeys = image.getGeoKeys() as Record<string, number>;
  console.log("CHM tile:", image.getWidth(), "x", image.getHeight(), "origin", ox, oy, "res", rx, ry, "epsg", geoKeys.ProjectedCSTypeGeoKey ?? geoKeys.GeographicTypeGeoKey);
  if (geoKeys.ProjectedCSTypeGeoKey !== 3857) throw new Error("expected EPSG:3857 tile");

  const [w, s, e, n] = aoiBbox;
  const x0 = Math.floor((lngToX(w) - ox) / rx);
  const x1 = Math.ceil((lngToX(e) - ox) / rx);
  const y0 = Math.floor((latToY(n) - oy) / ry); // ry is negative
  const y1 = Math.ceil((latToY(s) - oy) / ry);
  console.log(`reading window px [${x0},${y0}] -> [${x1},${y1}] (${x1 - x0} x ${y1 - y0})`);
  const raster = (await image.readRasters({ window: [x0, y0, x1, y1], samples: [0] })) as unknown as Float32Array[] & { width: number; height: number };
  const values = Array.from(raster[0] as unknown as Float32Array);
  const win: Window = { width: raster.width, height: raster.height, originX: ox + x0 * rx, originY: oy + y0 * ry, pixel: rx, values };
  mkdirSync(join(process.cwd(), ".cache", "chm"), { recursive: true });
  writeFileSync(CACHE, JSON.stringify(win));
  return win;
}

/** Cut a polygon by a SPLIT_CELL_M grid (in lng/lat) and return the intersected pieces. */
function gridSplit(poly: Position[][]): Position[][][] {
  const xs = poly[0].map((p) => p[0]), ys = poly[0].map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const midLat = (minY + maxY) / 2;
  const dLng = SPLIT_CELL_M / (111320 * Math.cos((midLat * Math.PI) / 180));
  const dLat = SPLIT_CELL_M / 110574;
  const out: Position[][][] = [];
  for (let x = Math.floor(minX / dLng) * dLng; x < maxX; x += dLng) {
    for (let y = Math.floor(minY / dLat) * dLat; y < maxY; y += dLat) {
      const cell: Position[][] = [[[x, y], [x + dLng, y], [x + dLng, y + dLat], [x, y + dLat], [x, y]]];
      // A failed cell must abort generation rather than silently remove part of a stand.
      const r = polygonClipping.intersection([poly] as never, [cell] as never) as unknown as Position[][][];
      out.push(...r);
    }
  }
  return out.length ? out : [poly];
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const aoi = JSON.parse(readFileSync(join(OUT_DIR, "aoi.geojson"), "utf8")) as Feature<Polygon | MultiPolygon>;
  const park = JSON.parse(readFileSync(join(OUT_DIR, "park.geojson"), "utf8")) as FeatureCollection<Polygon | MultiPolygon>;
  // Mask roofs with EVERY building in the AOI (fetch-osm keeps only park-shading buildings in public/).
  const allFootprints = join(process.cwd(), ".cache", "osm", "buildings_aoi_footprints.geojson");
  const buildings = JSON.parse(
    readFileSync(existsSync(allFootprints) ? allFootprints : join(OUT_DIR, "buildings.geojson"), "utf8"),
  ) as FeatureCollection<Polygon | MultiPolygon>;
  const bb = turfBbox(aoi) as [number, number, number, number];

  const win = await readWindow(bb);
  let valid = 0, trees = 0, maxH = 0;
  for (const v of win.values) if (Number.isFinite(v) && v >= 0 && v < 200) { valid++; if (v >= 3) trees++; if (v > maxH) maxH = v; }
  console.log(`window ${win.width}x${win.height}: valid=${valid} canopy(>=3m)=${trees} px max=${maxH.toFixed(1)} m`);

  const grid = win.values.map((v) => Number.isFinite(v) && v >= 0 && v < 200 ? v : 0);
  const toLngLat = ([gx, gy]: Position): Position => [xToLng(win.originX + gx * win.pixel), yToLat(win.originY - gy * win.pixel)];

  // Exclude known roofs and lake water; low vegetation thresholds otherwise admit false water detections.
  const maskGeoms = [...buildings.features, ...park.features.filter(f => f.properties?.kind === "water")]
    .map((f) => f.geometry.coordinates) as Parameters<typeof polygonClipping.union>;
  const maskUnion = maskGeoms.length ? polygonClipping.union(...maskGeoms) : [];
  const aoiGeom = (aoi.geometry.type === "Polygon" ? [aoi.geometry.coordinates] : aoi.geometry.coordinates) as Parameters<typeof polygonClipping.union>[0];

  const gen = contours().size([win.width, win.height]).thresholds(BANDS.map((b) => b[0])).smooth(true);
  const features: Feature<Polygon | MultiPolygon>[] = [];
  const stats: Record<string, { n: number; ha: number }> = {};
  gen(grid).forEach((mp, bi) => {
    const [minH, repH] = BANDS[bi];
    const polysLL = mp.coordinates.map((poly) => poly.map((ring) => ring.map(toLngLat)))
      // Exact integer thresholds can produce zero-area rings at a raster maximum.
      .filter(poly => area({ type: "Polygon", coordinates: [poly[0]] }) >= MIN_AREA_M2)
      .map(poly => [poly[0], ...poly.slice(1).filter(ring => area({ type: "Polygon", coordinates: [ring] }) > 0.01)]) as Position[][][];
    if (!polysLL.length) { stats[`>=${minH}m`] = { n: 0, ha: 0 }; return; }
    // Simplify before clipping so final boundaries cannot creep back onto water or roofs.
    const simplified = simplify({ type: "Feature", geometry: { type: "MultiPolygon", coordinates: polysLL }, properties: {} },
      { tolerance: SIMPLIFY_TOL, highQuality: true });
    // Fail without overwriting the output if masking fails; never publish unmasked roofs.
    const inAoi = polygonClipping.intersection(simplified.geometry.coordinates as never, aoiGeom as never);
    const clipped = polygonClipping.difference(inAoi as never, maskUnion as never) as unknown as Position[][][];
    let n = 0, ha = 0;
    const pieces: Position[][][] = [];
    for (const poly of clipped) {
      const f: Feature<Polygon> = { type: "Feature", geometry: { type: "Polygon", coordinates: poly }, properties: {} };
      if (area(f) > SPLIT_AREA_M2) pieces.push(...gridSplit(poly)); else pieces.push(poly);
    }
    for (const poly of pieces) {
      const f: Feature<Polygon> = { type: "Feature", geometry: { type: "Polygon", coordinates: poly }, properties: {} };
      const a = area(f);
      if (a < MIN_AREA_M2) continue;
      n++;
      const outputArea = a;
      ha += outputArea / 1e4;
      features.push({
        type: "Feature",
        geometry: f.geometry,
        properties: {
          id: `chm/${minH}/${n}`,
          height: repH,
          heightMin: minH,
          heightSource: "chm",
          source: "meta-wri-chm-v6",
          areaM2: Math.round(outputArea),
          name: null,
        },
      });
    }
    stats[`>=${minH}m`] = { n, ha: Math.round(ha * 10) / 10 };
  });
  const fc: FeatureCollection = { type: "FeatureCollection", features };
  writeFileSync(join(OUT_DIR, "canopy_chm.geojson"), JSON.stringify(fc));
  console.log("canopy_chm.geojson:", features.length, "polygons", stats, `${(JSON.stringify(fc).length / 1e6).toFixed(2)} MB`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
