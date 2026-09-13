import { afterEach, describe, expect, it, vi } from "vitest";
import { readUrlState } from "./urlState";

afterEach(() => vi.unstubAllGlobals());
describe("shared map date", () => {
  it.each(["2026-02-30", "2026-13-01", "2026-00-00"])("ignores invalid date %s before it reaches the shade engine", (date) => {
    vi.stubGlobal("window", { location: { search: `?d=${date}&t=960` } });
    expect(readUrlState()).toEqual({ minutes: 960 });
  });
  it("accepts leap days", () => {
    vi.stubGlobal("window", { location: { search: "?d=2028-02-29&t=960" } });
    expect(readUrlState()).toEqual({ date: "2028-02-29", minutes: 960 });
  });
});
