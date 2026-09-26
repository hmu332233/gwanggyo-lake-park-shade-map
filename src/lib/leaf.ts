import { DECIDUOUS_LEAF_CURVE, LEAFLESS_CROWN_SHADE } from "./config";

/** Deciduous leaf fraction (0..1) on a KST calendar date (YYYY-MM-DD). */
export function deciduousLeafFraction(dateISO: string, curve: [number, number][] = DECIDUOUS_LEAF_CURVE): number {
  const [y, m, d] = dateISO.split("-").map(Number);
  const doy = (Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86_400_000 + 1;
  if (doy <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    const [x1, y1] = curve[i];
    if (doy <= x1) {
      const [x0, y0] = curve[i - 1];
      return y0 + ((y1 - y0) * (doy - x0)) / (x1 - x0);
    }
  }
  return curve[curve.length - 1][1];
}

/**
 * Relative shade (0..1) of a crown whose evergreen share is known.
 * Unknown share keeps the year-round full shade used before seasonal data existed.
 */
export function crownShade(evergreenShare: number | null | undefined, deciduousLeaf: number): number {
  if (evergreenShare === null || evergreenShare === undefined) return 1;
  const deciduous = LEAFLESS_CROWN_SHADE + (1 - LEAFLESS_CROWN_SHADE) * deciduousLeaf;
  return evergreenShare + (1 - evergreenShare) * deciduous;
}
