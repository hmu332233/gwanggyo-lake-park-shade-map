import { describe, expect, it } from "vitest";
import { dateAtMinutes, koreaNow } from "./sun";

describe("park local time", () => {
  it("interprets selected times as Korea time", () => {
    expect(dateAtMinutes("2026-06-21", 12 * 60).toISOString()).toBe("2026-06-21T03:00:00.000Z");
    expect(dateAtMinutes("2026-01-01", 0).toISOString()).toBe("2025-12-31T15:00:00.000Z");
  });
  it("uses the Korean calendar day and clock across UTC midnight", () => {
    expect(koreaNow(new Date("2026-12-31T16:23:00Z"))).toEqual({ date: "2027-01-01", minutes: 83 });
  });
});
