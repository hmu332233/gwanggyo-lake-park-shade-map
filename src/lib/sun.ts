import * as SunCalc from "suncalc";
import type { SunPosition } from "../types/map";

/**
 * Compute sun altitude/azimuth for a given instant and location.
 *
 * NOTE on conventions — suncalc 2.x (used here) returns DEGREES with a
 * north-based clockwise azimuth (0 = N, 90 = E, 180 = S, 270 = W).
 * (suncalc 1.x returned radians with a south-based azimuth; do not mix them.)
 *
 * We expose both degrees and radians; the compass-bearing convention matches
 * Turf.js bearings once mapped to -180..180.
 */
export function getSunPosition(date: Date, lat: number, lng: number): SunPosition {
  const pos = SunCalc.getPosition(date, lat, lng);
  const azimuthDeg = normalizeDeg(pos.azimuth);
  return {
    altitude: toRad(pos.altitude),
    azimuth: toRad(azimuthDeg),
    altitudeDeg: pos.altitude,
    azimuthDeg,
  };
}

/** Direction (compass bearing, degrees -180..180 for Turf) in which shadows fall: opposite of the sun. */
export function shadowBearingDeg(sunAzimuthRad: number): number {
  const deg = normalizeDeg(toDeg(sunAzimuthRad) + 180);
  return deg > 180 ? deg - 360 : deg;
}

/** Interpret the selected date and clock time at the park, independent of browser timezone. */
export function dateAtMinutes(dateISO: string, minutes: number): Date {
  const midnight = new Date(`${dateISO}T00:00:00+09:00`);
  return new Date(midnight.getTime() + minutes * 60_000);
}

/** Seoul uses UTC+9 year round. UTC getters keep these values independent of host timezone. */
export function koreaNow(now: Date = new Date()): { date: string; minutes: number } {
  const local = new Date(now.getTime() + 9 * 60 * 60_000);
  return { date: local.toISOString().slice(0, 10), minutes: local.getUTCHours() * 60 + local.getUTCMinutes() };
}

export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function todayISO(): string {
  return koreaNow().date;
}

function normalizeDeg(d: number) {
  return ((d % 360) + 360) % 360;
}
function toDeg(r: number) {
  return (r * 180) / Math.PI;
}
function toRad(d: number) {
  return (d * Math.PI) / 180;
}
