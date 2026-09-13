import type { Feature, FeatureCollection, LineString, MultiPolygon, Polygon, Point } from "geojson";

export type HeightSource = "osm" | "levels" | "estimated" | "chm";

export interface BuildingProperties {
  id: string;
  building: string;
  name: string | null;
  levels: number | null;
  height: number;
  heightSource: HeightSource;
}

export type BuildingFeature = Feature<Polygon | MultiPolygon, BuildingProperties>;
export type BuildingCollection = FeatureCollection<Polygon | MultiPolygon, BuildingProperties>;

export interface PathProperties {
  id: string;
  highway: string;
  name: string | null;
  surface: string | null;
  lake?: string;
}
export type PathFeature = Feature<LineString, PathProperties>;
export type PathCollection = FeatureCollection<LineString, PathProperties>;
export type ShadeSegmentCollection = FeatureCollection<LineString, PathProperties & { shadeRatio: number; lengthM: number }>;

export type ShadowKind = "building" | "tree" | "canopy" | "structure";

export interface ShadowProperties {
  sourceId: string;
  kind: ShadowKind;
  height: number;
  shadowLength: number;
}
export type ShadowFeature = Feature<Polygon | MultiPolygon, ShadowProperties>;
export type ShadowCollection = FeatureCollection<Polygon | MultiPolygon, ShadowProperties>;

export interface TreeProperties {
  id: string;
  height: number;
  crownRadius: number;
  heightSource: HeightSource;
  species: string | null;
}
export type TreeCollection = FeatureCollection<Point, TreeProperties>;

export interface CanopyProperties {
  id: string;
  height: number;
  heightSource: HeightSource;
  name: string | null;
  /** Lower bound of the canopy-height band (satellite-derived canopy only). */
  heightMin?: number;
  source?: string;
  areaM2?: number;
}
export type CanopyCollection = FeatureCollection<Polygon | MultiPolygon, CanopyProperties>;

export type StructureKind = "pavilion" | "pergola" | "bridge" | "shade_sail" | "other";
export interface StructureProperties {
  id: string;
  kind: StructureKind;
  height: number;
  heightSource: HeightSource;
  name: string | null;
}
export type StructureCollection = FeatureCollection<Polygon | MultiPolygon, StructureProperties>;

/** Everything the shade engine needs, loaded once. */
export interface ShadeLayers {
  buildings: BuildingCollection;
  paths: PathCollection;
  trees: TreeCollection;
  canopy: CanopyCollection;
  /** Tree canopy estimated from satellite imagery (Meta/WRI canopy height map). Uncertain → separately toggleable. */
  canopyChm: CanopyCollection;
  structures: StructureCollection;
  park: FeatureCollection<Polygon | MultiPolygon>;
  /** Park land minus water and building footprints; does not imply public accessibility. */
  parkGround: FeatureCollection<Polygon | MultiPolygon>;
}

/** Which shadow casters take part in the computation (mirrors the layer toggles). */
export interface CasterFlags {
  vegetation: boolean;
  canopyChm: boolean;
}

export interface SunPosition {
  /** radians, above horizon positive */
  altitude: number;
  /** radians, compass bearing (0 = north, clockwise) */
  azimuth: number;
  altitudeDeg: number;
  azimuthDeg: number;
}

export interface LayerVisibility {
  buildings: boolean;
  shadows: boolean;
  vegetation: boolean;
  /** Satellite-estimated tree canopy (uncertain; default on but user-toggleable). */
  canopyChm: boolean;
  paths: boolean;
  buildings3d: boolean;
}
