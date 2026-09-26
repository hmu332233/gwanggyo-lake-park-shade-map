/**
 * Optional WebAssembly polygon clipping (Angus Johnson's Clipper via js-angusj-clipper) for the
 * per-frame shadow union and difference, ~10x faster than polygon-clipping on this data.
 *
 * Loading is asynchronous and may fail (no WebAssembly, blocked module, unsupported runtime).
 * Until `initClipper()` succeeds every function here returns null, and callers keep using
 * polygon-clipping. Coordinates are shifted to a local origin and scaled to integers (1e-7° ≈ 1 cm).
 */
import type * as ClipperModule from "js-angusj-clipper/web";
import type { MultiPolygon, Position } from "geojson";
import { GWANGGYO_CENTER } from "./config";

type Lib = ClipperModule.ClipperLibWrapper;
type Api = typeof ClipperModule;
type Coords = MultiPolygon["coordinates"];

const SCALE = 1e7;
const [OX, OY] = GWANGGYO_CENTER;

let loaded: { lib: Lib; api: Api } | null = null;
let loading: Promise<boolean> | null = null;

/** Give up on WebAssembly if it has not loaded by then, so the first shadows are not held back. */
const LOAD_TIMEOUT_MS = 5000;

/** Load the WebAssembly build once; resolves false (and stays on polygon-clipping) when unavailable. */
export function initClipper(load: () => Promise<Api> = () => import("js-angusj-clipper/web")): Promise<boolean> {
  loading ??= (async () => {
    try {
      if (typeof WebAssembly === "undefined") return false;
      const api = await load();
      const lib = await api.loadNativeClipperLibInstanceAsync(api.NativeClipperLibRequestedFormat.WasmOnly);
      loaded = { lib, api };
      return true;
    } catch {
      return false;
    }
  })();
  return Promise.race([loading, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), LOAD_TIMEOUT_MS))]);
}

export function clipperReady(): boolean {
  return loaded !== null;
}

/** Integer paths with outer rings counter-clockwise and holes clockwise, as the NonZero rule needs. */
function toPaths(polygons: Coords): ClipperModule.Path[] {
  const paths: ClipperModule.Path[] = [];
  for (const polygon of polygons) {
    polygon.forEach((ring, index) => {
      const path = ring.slice(0, -1).map(([x, y]) => ({ x: Math.round((x - OX) * SCALE), y: Math.round((y - OY) * SCALE) }));
      if (path.length < 3) return;
      let twiceArea = 0;
      for (let i = 0; i < path.length; i++) {
        const a = path[i], b = path[(i + 1) % path.length];
        twiceArea += a.x * b.y - b.x * a.y;
      }
      if (twiceArea > 0 !== (index === 0)) path.reverse();
      paths.push(path);
    });
  }
  return paths;
}

function toCoords(tree: ClipperModule.PolyTree): Coords {
  const out: Coords = [];
  const ring = (contour: ClipperModule.ReadonlyPath): Position[] => {
    const r = contour.map((p) => [p.x / SCALE + OX, p.y / SCALE + OY]);
    r.push(r[0]);
    return r;
  };
  const visit = (node: ClipperModule.PolyNode) => {
    for (const outer of node.childs) {
      const rings = [ring(outer.contour)];
      for (const hole of outer.childs) {
        rings.push(ring(hole.contour));
        visit(hole); // islands inside holes
      }
      out.push(rings);
    }
  };
  visit(tree);
  return out;
}

function clip(clipType: "union" | "difference", subject: Coords, clipBy: Coords = []): Coords | null {
  if (!loaded) return null;
  if (clipType === "difference" && clipBy.length === 0) return subject;
  const { lib, api } = loaded;
  try {
    const tree = lib.clipToPolyTree({
      clipType: clipType === "union" ? api.ClipType.Union : api.ClipType.Difference,
      subjectFillType: api.PolyFillType.NonZero,
      subjectInputs: [{ data: toPaths(subject), closed: true }],
      clipInputs: clipBy.length ? [{ data: toPaths(clipBy) }] : undefined,
    });
    return toCoords(tree);
  } catch {
    return null;
  }
}

/** Union of polygons (each given as Polygon coordinates), or null when the WebAssembly path is unavailable. */
export function clipperUnion(polygons: Coords): Coords | null {
  return clip("union", polygons);
}

/** a − b, or null when the WebAssembly path is unavailable. */
export function clipperDifference(a: Coords, b: Coords): Coords | null {
  return clip("difference", a, b);
}
