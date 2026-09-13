import { TIME_RANGE } from "./config";
import type { LayerVisibility } from "../types/map";

/**
 * Shareable state in the query string:  ?d=2026-09-06&t=1020&l=b,s,v,c,p,3
 * (camera position is handled by MapLibre's own `hash: "map"`).
 */
export interface UrlState {
  date?: string;
  minutes?: number;
  visibility?: Partial<LayerVisibility>;
}

const LAYER_CODES: [keyof LayerVisibility, string][] = [
  ["buildings", "b"],
  ["shadows", "s"],
  ["vegetation", "v"],
  ["canopyChm", "c"],
  ["paths", "p"],
  ["buildings3d", "3"],
];

export function readUrlState(): UrlState {
  if (typeof window === "undefined") return {};
  const q = new URLSearchParams(window.location.search);
  const out: UrlState = {};
  const d = q.get("d");
  if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
    const parsed = new Date(`${d}T00:00:00Z`);
    if (Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === d) out.date = d;
  }
  const t = Number(q.get("t"));
  if (Number.isFinite(t) && t >= TIME_RANGE.startMinutes && t <= TIME_RANGE.endMinutes) {
    out.minutes = Math.round(t / TIME_RANGE.stepMinutes) * TIME_RANGE.stepMinutes;
  }
  const l = q.get("l");
  if (l !== null) {
    const codes = new Set(l.split(",").filter(Boolean));
    out.visibility = Object.fromEntries(LAYER_CODES.map(([k, c]) => [k, codes.has(c)])) as Partial<LayerVisibility>;
  }
  return out;
}

export function writeUrlState(date: string, minutes: number, visibility: LayerVisibility) {
  if (typeof window === "undefined") return;
  const q = new URLSearchParams(window.location.search);
  q.set("d", date);
  q.set("t", String(minutes));
  q.set("l", LAYER_CODES.filter(([k]) => visibility[k]).map(([, c]) => c).join(","));
  const url = `${window.location.pathname}?${q.toString()}${window.location.hash}`;
  window.history.replaceState(null, "", url);
}
