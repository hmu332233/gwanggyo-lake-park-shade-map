import { describe, expect, it } from "vitest";
import { parseOsmHeight } from "./buildings";

describe("parseOsmHeight", () => {
  it("parses metric and feet values in meters", () => {
    expect(parseOsmHeight("45.5m")).toBeCloseTo(45.5);
    expect(parseOsmHeight("150 ft")).toBeCloseTo(45.72);
  });

  it("rejects missing, non-numeric and non-positive values", () => {
    for (const value of [undefined, null, "", "unknown", "0", "-2 m"]) {
      expect(parseOsmHeight(value)).toBeNull();
    }
  });
});
