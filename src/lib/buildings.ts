import {
  DEFAULT_HEIGHT_BY_TYPE,
  DEFAULT_HEIGHT_FALLBACK,
  METERS_PER_LEVEL,
} from "./config";
import type { HeightSource } from "../types/map";

export interface NormalizedHeight {
  height: number;
  heightSource: HeightSource;
}

/** Parse OSM height strings like "45", "45 m", "45.5m", "150 ft". */
export function parseOsmHeight(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  const m = s.match(/^(-?\d+(?:\.\d+)?)\s*(m|meters?|ft|feet|')?$/);
  if (!m) return null;
  let v = parseFloat(m[1]);
  if (!Number.isFinite(v) || v <= 0) return null;
  if (m[2] === "ft" || m[2] === "feet" || m[2] === "'") v = v * 0.3048;
  return v;
}

/**
 * Derive a numeric height for a building from OSM tags.
 * Pure function so it can be used both by the fetch script and at runtime.
 */
export function normalizeBuildingHeight(
  tags: Record<string, string | undefined>,
  /** Optional per-type defaults (e.g. local medians) that take precedence over DEFAULT_HEIGHT_BY_TYPE. */
  localDefaults: Record<string, number> = {},
): NormalizedHeight {
  const explicit = parseOsmHeight(tags.height);
  if (explicit !== null) return { height: round1(explicit), heightSource: "osm" };

  const levels = parseFloat(tags["building:levels"] ?? "");
  if (Number.isFinite(levels) && levels > 0) {
    return { height: round1(levels * METERS_PER_LEVEL), heightSource: "levels" };
  }

  const type = (tags.building ?? "yes").toLowerCase();
  const def = localDefaults[type] ?? DEFAULT_HEIGHT_BY_TYPE[type] ?? DEFAULT_HEIGHT_FALLBACK;
  return { height: def, heightSource: "estimated" };
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}
