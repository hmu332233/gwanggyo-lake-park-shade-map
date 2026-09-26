import { describe, expect, it } from "vitest";
import { crownShade, deciduousLeafFraction } from "./leaf";
import { LEAFLESS_CROWN_SHADE } from "./config";

describe("deciduousLeafFraction", () => {
  it("is bare in winter, full in summer and interpolates spring and fall", () => {
    expect(deciduousLeafFraction("2026-01-15")).toBe(0);
    expect(deciduousLeafFraction("2026-07-15")).toBe(1);
    expect(deciduousLeafFraction("2026-12-20")).toBe(0);
    const april = deciduousLeafFraction("2026-04-15"); // day 105
    expect(april).toBeCloseTo(0.5, 5);
    expect(deciduousLeafFraction("2026-11-16")).toBeCloseTo(0.5, 1);
  });
  it("uses the calendar day independent of the host timezone", () => {
    expect(deciduousLeafFraction("2026-04-15")).toBe(deciduousLeafFraction("2025-04-15"));
  });
});

describe("crownShade", () => {
  it("keeps full shade for evergreen, unknown and full-leaf crowns", () => {
    expect(crownShade(1, 0)).toBe(1);
    expect(crownShade(null, 0)).toBe(1);
    expect(crownShade(undefined, 0)).toBe(1);
    expect(crownShade(0, 1)).toBe(1);
  });
  it("reduces leafless deciduous crowns to branch shade and mixes by evergreen share", () => {
    expect(crownShade(0, 0)).toBeCloseTo(LEAFLESS_CROWN_SHADE, 10);
    expect(crownShade(0.5, 0)).toBeCloseTo(0.5 + 0.5 * LEAFLESS_CROWN_SHADE, 10);
  });
});
