import type { MultiPolygon, Polygon, Position } from "geojson";

/** Split a MultiPolygon feature into individual Polygon geometries (outer rings preserved with holes). */
export function toPolygons(geom: Polygon | MultiPolygon): Polygon[] {
  if (geom.type === "Polygon") return [geom];
  return geom.coordinates.map((c) => ({ type: "Polygon", coordinates: c }));
}

/**
 * Offset a lng/lat position by `distance` meters along `bearingDeg` (compass, 0 = north, clockwise).
 * Uses a local equirectangular approximation — accurate to well under a meter at these distances.
 */
export function offsetPosition(p: Position, distanceM: number, bearingDeg: number): Position {
  const R = 6378137;
  const br = (bearingDeg * Math.PI) / 180;
  const lat = (p[1] * Math.PI) / 180;
  const dNorth = distanceM * Math.cos(br);
  const dEast = distanceM * Math.sin(br);
  const dLat = (dNorth / R) * (180 / Math.PI);
  const dLng = (dEast / (R * Math.cos(lat))) * (180 / Math.PI);
  return [p[0] + dLng, p[1] + dLat];
}
