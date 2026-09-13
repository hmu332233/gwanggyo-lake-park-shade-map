/** Park land coverage, excluding water and building footprints, not an accessibility map. */
import { area, bbox } from "@turf/turf";
import polygonClipping from "polygon-clipping";
import type { FeatureCollection, MultiPolygon, Polygon, Position } from "geojson";
import type { BuildingCollection, ShadowCollection } from "../types/map";
import { createPolygonIndex } from "./shade";

type Ground = FeatureCollection<Polygon | MultiPolygon>;

/** Union the park boundary, then remove water and buildings (including their holes). */
export function createParkGround(park: Ground, buildings: BuildingCollection): Ground {
  const boundaries = park.features.filter(f => f.properties?.kind === "park");
  if (boundaries.length === 0) return { type: "FeatureCollection", features: [] };
  const union = polygonClipping.union(...(boundaries.map(f => f.geometry.coordinates) as Parameters<typeof polygonClipping.union>));
  const excluded = [
    ...park.features.filter(f => f.properties?.kind === "water"),
    ...buildings.features,
  ];
  const coordinates = excluded.length
    ? polygonClipping.difference(union, ...excluded.map(f => f.geometry.coordinates) as polygonClipping.Geom[])
    : union;
  return {
    type: "FeatureCollection",
    features: coordinates.length ? [{
      type: "Feature", properties: { kind: "park-ground" },
      geometry: { type: "MultiPolygon", coordinates },
    }] : [],
  };
}

export interface ParkGroundGrid {
  /** Polygon area, not rounded to grid cells. */
  areaM2: number;
  stepM: number;
  points: Position[];
  weights: number[];
  totalWeight: number;
}

export interface ParkGroundShade {
  areaM2: number;
  shadedM2: number;
  ratio: number;
}

/**
 * Precompute an 8 m midpoint grid once. Cells whose centers fall in water,
 * buildings, or boundary holes are excluded. Narrow strips and shade boundaries
 * below the grid spacing are approximate; this does not identify walkable land.
 */
export function buildParkGroundGrid(ground: Ground, stepM = 8): ParkGroundGrid {
  if (!(stepM > 0) || !Number.isFinite(stepM)) throw new Error("Grid spacing must be finite and positive");
  const grid: ParkGroundGrid = { areaM2: area(ground), stepM, points: [], weights: [], totalWeight: 0 };
  if (grid.areaM2 === 0 || ground.features.length === 0) return grid;
  const [west, south, east, north] = bbox(ground);
  const radians = Math.PI / 180;
  const metersPerDegree = 6371008.8 * radians;
  const dx = stepM / (metersPerDegree * Math.cos((south + north) / 2 * radians));
  const dy = stepM / metersPerDegree;
  const isLand = createPolygonIndex(ground.features.map(f => f.geometry));
  for (let y = south + dy / 2; y < north; y += dy) {
    // Longitude cells become slightly narrower toward the north.
    const weight = Math.cos(y * radians);
    for (let x = west + dx / 2; x < east; x += dx) {
      const point = [x, y];
      if (!isLand(point)) continue;
      grid.points.push(point);
      grid.weights.push(weight);
      grid.totalWeight += weight;
    }
  }
  return grid;
}

/** Approximate shaded land area from the grid; exact polygon area sets the denominator. */
export function computeParkGroundShade(grid: ParkGroundGrid, shadows: ShadowCollection): ParkGroundShade {
  const isInShadow = createPolygonIndex(shadows.features.map(f => f.geometry));
  let shadedWeight = 0;
  for (let i = 0; i < grid.points.length; i++) {
    if (isInShadow(grid.points[i])) shadedWeight += grid.weights[i];
  }
  const ratio = grid.totalWeight ? Math.min(1, shadedWeight / grid.totalWeight) : 0;
  return { areaM2: grid.areaM2, shadedM2: grid.areaM2 * ratio, ratio };
}
