/** Keep mapped walking paths throughout the park, clipping away their city-side tails. */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { along, booleanPointInPolygon, featureCollection, length, lineSplit, union } from "@turf/turf";
import type { FeatureCollection, MultiPolygon, Polygon } from "geojson";
import type { PathCollection } from "../src/types/map";

export function selectParkPaths(paths: PathCollection, park: FeatureCollection<Polygon | MultiPolygon>): PathCollection {
  const boundaries = park.features.filter(f => f.properties?.kind === "park");
  if (!boundaries.length) throw new Error("Park boundary is required before publishing walking paths");
  const boundary = boundaries.length === 1 ? boundaries[0] : union(featureCollection(boundaries))!;
  return featureCollection(paths.features.flatMap(path => {
    const split = lineSplit(path, boundary).features;
    return (split.length ? split : [path]).filter(part => {
      const km = length(part);
      return km > 0.0001 && booleanPointInPolygon(along(part, km / 2), boundary);
    }).map((part, i) => ({
      ...part,
      id: `${path.properties.id}/park/${i}`,
      properties: { ...path.properties, id: `${path.properties.id}/park/${i}`, name: path.properties.name ?? "공원 산책길" },
    }));
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const paths = JSON.parse(readFileSync(process.argv[2] ?? ".cache/osm/paths_aoi.geojson", "utf8"));
  const park = JSON.parse(readFileSync("public/data/gwanggyo/park.geojson", "utf8"));
  const result = selectParkPaths(paths, park);
  writeFileSync("public/data/gwanggyo/paths.geojson", JSON.stringify(result));
  console.log(`${result.features.length} park paths, ${length(result).toFixed(2)} km`);
}
