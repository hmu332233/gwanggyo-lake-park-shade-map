import { useEffect, useRef } from "react";
import * as maplibregl from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import type { Map as MLMap, GeoJSONSource, StyleSpecification, MapMouseEvent, MapGeoJSONFeature } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Feature, FeatureCollection, MultiPolygon } from "geojson";
import { pointInGeometry } from "@/lib/shade";
import { GWANGGYO_CENTER, GWANGGYO_PARK_BOUNDS, INITIAL_ZOOM, PATH_SHADE_COLORS } from "@/lib/config";
import type {
  BuildingCollection,
  CanopyCollection,
  LayerVisibility,
  PathCollection,
  ShadeSegmentCollection,
  StructureCollection,
  TreeCollection,
} from "@/types/map";

const EMPTY_FC: FeatureCollection = { type: "FeatureCollection", features: [] };

const MAP_STYLE: string | StyleSpecification = "https://tiles.openfreemap.org/styles/positron";

type CompassOrientationEvent = DeviceOrientationEvent & { webkitCompassHeading?: number };
type CompassOrientationEventConstructor = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<"granted" | "denied">;
};

function addUserHeading(map: MLMap, geolocate: maplibregl.GeolocateControl) {
  const button = map.getContainer().querySelector<HTMLButtonElement>(".maplibregl-ctrl-geolocate");
  if (!button) return () => {};
  let listening = false;
  let heading: number | null = null;
  const update = () => {
    const dot = map.getContainer().querySelector<HTMLElement>(".maplibregl-user-location-dot");
    if (!dot || heading === null) return;
    let cone = dot.querySelector<HTMLElement>(".gw-user-heading");
    if (!cone) {
      cone = document.createElement("span");
      cone.className = "gw-user-heading";
      dot.append(cone);
    }
    cone.style.transform = `translateX(-50%) rotate(${heading - map.getBearing()}deg)`;
  };
  const onOrientation = (rawEvent: Event) => {
    const event = rawEvent as CompassOrientationEvent;
    heading = event.webkitCompassHeading ?? (
      event.absolute && event.alpha !== null
        ? (360 - event.alpha + (screen.orientation?.angle ?? 0)) % 360
        : null
    );
    update();
  };
  const stop = () => {
    window.removeEventListener("deviceorientationabsolute", onOrientation);
    window.removeEventListener("deviceorientation", onOrientation);
    listening = false;
    heading = null;
    map.getContainer().querySelector(".gw-user-heading")?.remove();
  };
  const start = async () => {
    const orientation = window.DeviceOrientationEvent as CompassOrientationEventConstructor | undefined;
    if (!orientation) return;
    try {
      if (orientation.requestPermission && await orientation.requestPermission() !== "granted") return;
    } catch {
      return;
    }
    window.addEventListener("deviceorientationabsolute", onOrientation);
    window.addEventListener("deviceorientation", onOrientation);
    listening = true;
  };
  const onClick = () => {
    const turningOff = button.classList.contains("maplibregl-ctrl-geolocate-active") &&
      !button.classList.contains("maplibregl-ctrl-geolocate-background");
    if (turningOff) stop();
    else if (!listening) void start();
  };
  button.addEventListener("click", onClick);
  map.on("rotate", update);
  geolocate.on("geolocate", update);
  geolocate.on("error", stop);
  return () => {
    stop();
    button.removeEventListener("click", onClick);
    map.off("rotate", update);
    geolocate.off("geolocate", update);
    geolocate.off("error", stop);
  };
}

export interface GwanggyoMapProps {
  park: FeatureCollection | null;
  parkGround: FeatureCollection | null;
  buildings: BuildingCollection | null;
  paths: PathCollection | null;
  trees: TreeCollection | null;
  canopy: CanopyCollection | null;
  canopyChm: CanopyCollection | null;
  structures: StructureCollection | null;
  /** Union of all shadows — drawn as one fill so overlaps don't darken. */
  shadowUnion: MultiPolygon | null;
  /** Short sections with individually sampled shade. */
  segmentPaths: ShadeSegmentCollection | null;
  visibility: LayerVisibility;
  daylight: boolean;
  isComputing: boolean;
}

const SRC = {
  park: "gw-park",
  parkGround: "gw-park-ground",
  buildings: "gw-buildings",
  shadows: "gw-shadows",
  paths: "gw-paths",
  trees: "gw-trees",
  canopy: "gw-canopy",
  canopyChm: "gw-canopy-chm",
  structures: "gw-structures",
} as const;
const LYR = {
  park: "gw-park-line",
  parkGround: "gw-park-ground-fill",
  canopy3d: "gw-canopy-3d",
  canopyChm3d: "gw-canopy-chm-3d",
  water: "gw-water-fill",
  shadows: "gw-shadows-fill",
  canopy: "gw-canopy-fill",
  canopyChm: "gw-canopy-chm-fill",
  canopyChmOutline: "gw-canopy-chm-line",
  trees: "gw-trees-circle",
  structures: "gw-structures-fill",
  buildings: "gw-buildings-fill",
  buildingsOutline: "gw-buildings-line",
  buildings3d: "gw-buildings-3d",
  paths: "gw-paths-line",
  pathsCasing: "gw-paths-casing",
} as const;

/** Find the first symbol (label) layer id so our layers render beneath labels. */
function firstSymbolLayer(map: MLMap): string | undefined {
  const layers = map.getStyle()?.layers ?? [];
  return layers.find((l) => l.type === "symbol")?.id;
}

const HEIGHT_SRC_LABEL: Record<string, string> = { osm: "OSM height", levels: "층수 × 3m", estimated: "추정값" };

type ShadeState = Pick<GwanggyoMapProps, "shadowUnion" | "segmentPaths" | "daylight" | "isComputing">;

const popupHtml = (title: string, lines: string[]) =>
  `<div style="font:12px/1.4 system-ui"><b>${title}</b><br/>${lines.join("<br/>")}</div>`;

function addMapPopups(map: MLMap, shadeState: { current: ShadeState }) {
  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: true, maxWidth: "260px" });
  const hitsPath = (e: MapMouseEvent) => map.queryRenderedFeatures(e.point, { layers: [LYR.pathsCasing] }).length > 0;
  const onBuilding = (e: MapMouseEvent & { features?: MapGeoJSONFeature[] }) => {
    if (hitsPath(e)) return;
    const p = e.features?.[0]?.properties as Record<string, string | number | null> | undefined;
    if (!p) return;
    const lines = [`높이 ${p.height} m <span style="color:#888">(${HEIGHT_SRC_LABEL[String(p.heightSource)] ?? ""})</span>`];
    if (p.levels) lines.push(`${p.levels}층`);
    popup.setLngLat(e.lngLat).setHTML(popupHtml(String(p.name ?? p.building ?? "건물"), lines)).addTo(map);
  };
  const onPath = (e: MapMouseEvent & { features?: MapGeoJSONFeature[] }) => {
    const p = e.features?.[0]?.properties as Record<string, string | number | null> | undefined;
    if (!p) return;
    const shade = typeof p.shadeRatio === "number" ? Math.round(p.shadeRatio * 100) : null;
    const lines = [typeof p.lengthM === "number" ? `이 구간 약 ${Math.round(p.lengthM)} m` : "공원 산책길"];
    if (shade !== null) lines.push(`이 구간의 예상 그늘 <b>${shade}%</b>`);
    if (shade === null) lines.push("그늘 비율 계산 전 또는 해가 진 시간");
    popup.setLngLat(e.lngLat).setHTML(popupHtml(String(p.name ?? "공원 산책길"), lines)).addTo(map);
  };
  const onVeg = (label: string) => (e: MapMouseEvent & { features?: MapGeoJSONFeature[] }) => {
    if (hitsPath(e)) return;
    const p = e.features?.[0]?.properties as Record<string, string | number | null> | undefined;
    if (!p) return;
    const lines = [`높이 ${p.height} m <span style="color:#888">(${HEIGHT_SRC_LABEL[String(p.heightSource)] ?? ""})</span>`];
    if (p.crownRadius) lines.push(`수관 반경 ${p.crownRadius} m`);
    if (p.kind) lines.push(`종류 ${p.kind}`);
    popup.setLngLat(e.lngLat).setHTML(popupHtml(String(p.name ?? label), lines)).addTo(map);
  };

  map.on("click", LYR.buildings, onBuilding);
  map.on("click", LYR.buildings3d, onBuilding);
  map.on("click", LYR.pathsCasing, onPath);
  map.on("click", LYR.trees, onVeg("나무"));
  map.on("click", LYR.canopy, onVeg("수림대"));
  map.on("click", LYR.canopy3d, onVeg("수림대 · 수관 높이 추정"));
  map.on("click", LYR.canopyChm3d, onVeg("위성 수목 · 수관 높이 추정"));
  map.on("click", LYR.canopyChm, (e) => {
    if (hitsPath(e)) return;
    const p = e.features?.[0]?.properties as Record<string, string | number | null> | undefined;
    if (!p) return;
    popup
      .setLngLat(e.lngLat)
      .setHTML(
        popupHtml("수목 (위성 추정)", [
          `수관 높이 ${p.heightMin}~ m 구간 → ${p.height} m로 계산`,
          `면적 약 ${Number(p.areaM2).toLocaleString()} m²`,
          `<span style="color:#888">Meta·WRI Canopy Height Map (CC BY 4.0)</span>`,
        ]),
      )
      .addTo(map);
  });
  map.on("click", LYR.structures, onVeg("시설물"));
  map.on("click", LYR.parkGround, (e) => {
    if (map.queryRenderedFeatures(e.point, { layers: [LYR.pathsCasing, LYR.buildings, LYR.buildings3d] }).length) return;
    const state = shadeState.current;
    let label: string;
    if (!state.daylight) label = "태양이 낮거나 해가 져 계산할 수 없는 시간입니다.";
    else if (state.isComputing || !state.segmentPaths) label = "선택한 시간의 그늘을 계산 중입니다.";
    else label = state.shadowUnion && pointInGeometry([e.lngLat.lng, e.lngLat.lat], state.shadowUnion)
      ? "이 위치는 <b>예상 그늘</b>입니다."
      : "이 위치는 <b>예상 햇빛</b>입니다.";
    popup.setLngLat(e.lngLat).setHTML(popupHtml("공원 육지", [label, "실제 통행 가능 여부는 현장을 확인해 주세요."])).addTo(map);
  });
  for (const id of [LYR.parkGround, LYR.buildings, LYR.buildings3d, LYR.paths, LYR.trees, LYR.canopy, LYR.canopyChm, LYR.structures]) {
    map.on("mouseenter", id, () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", id, () => (map.getCanvas().style.cursor = ""));
  }
  return popup;
}

function runWhenReady(mapRef: { current: MLMap | null }, readyRef: { current: boolean }, fn: (map: MLMap) => void) {
  const map = mapRef.current;
  if (!map) return;
  if (readyRef.current) fn(map);
  else map.once("load", () => fn(map));
}

function setSourceData(map: MLMap, id: string, data: FeatureCollection | Feature | null) {
  if (data) (map.getSource(id) as GeoJSONSource | undefined)?.setData(data);
}

export default function GwanggyoMap({
  park,
  parkGround,
  buildings,
  paths,
  trees,
  canopy,
  canopyChm,
  structures,
  shadowUnion,
  segmentPaths,
  visibility,
  daylight,
  isComputing,
}: GwanggyoMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const readyRef = useRef(false);
  const initial3d = useRef(visibility.buildings3d);
  const shadeState = useRef({ shadowUnion, segmentPaths, daylight, isComputing });
  const popupRef = useRef<maplibregl.Popup | null>(null);
  useEffect(() => {
    shadeState.current = { shadowUnion, segmentPaths, daylight, isComputing };
    popupRef.current?.remove();
  }, [shadowUnion, segmentPaths, daylight, isComputing]);

  // Create map once
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    maplibregl.setWorkerUrl(maplibreWorkerUrl);
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE,
      center: GWANGGYO_CENTER,
      zoom: INITIAL_ZOOM,
      bounds: GWANGGYO_PARK_BOUNDS,
      fitBoundsOptions: { padding: window.innerWidth < 640
        ? { top: 205, bottom: 155, left: 35, right: 35 }
        : { top: 50, bottom: 180, left: 370, right: 70 } },
      hash: "map",
      pitch: initial3d.current ? 45 : 0,
      maxPitch: 60,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    const geolocate = new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: true,
      showUserLocation: true,
      showAccuracyCircle: true,
    });
    map.addControl(geolocate, "top-right");
    const removeUserHeading = addUserHeading(map, geolocate);
    map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

    map.on("load", () => {
      // Quiet the surrounding city so the two lake walks remain the focus.
      for (const layer of map.getStyle().layers) {
        if (layer.type === "symbol" && /poi|transit|road|housenumber/i.test(layer.id)) {
          map.setLayoutProperty(layer.id, "visibility", "none");
        }
      }
      const beforeId = firstSymbolLayer(map);

      for (const id of Object.values(SRC)) map.addSource(id, { type: "geojson", data: EMPTY_FC });

      map.addLayer({
        id: LYR.parkGround,
        type: "fill",
        source: SRC.parkGround,
        paint: { "fill-color": "#dce8c8", "fill-opacity": 0.85 },
      }, beforeId);
      map.addLayer({
        id: LYR.water,
        type: "fill",
        source: SRC.park,
        filter: ["==", ["get", "kind"], "water"],
        paint: { "fill-color": "#b7d7df", "fill-opacity": 0.95, "fill-outline-color": "#96bdc8" },
      }, beforeId);

      // Bottom → top: park outline, canopy stands, shadow union, structures, paths, trees, buildings.
      map.addLayer(
        {
          id: LYR.park,
          type: "line",
          source: SRC.park,
          filter: ["==", ["get", "kind"], "park"],
          paint: { "line-color": "#2f8f5b", "line-width": 1.5, "line-dasharray": [3, 2], "line-opacity": 0.25 },
        },
        beforeId,
      );
      map.addLayer(
        {
          id: LYR.canopy,
          type: "fill",
          source: SRC.canopy,
          paint: { "fill-color": "#4f9a5c", "fill-opacity": 0.13, "fill-outline-color": "#3b7a48" },
        },
        beforeId,
      );
      // Satellite-estimated canopy: greener with height, dashed outline to signal "estimated".
      map.addLayer(
        {
          id: LYR.canopyChm,
          type: "fill",
          source: SRC.canopyChm,
          paint: {
            "fill-color": ["interpolate", ["linear"], ["get", "height"], 5, "#a8d5a2", 9, "#7fbf7b", 14, "#4f9a5c", 21, "#2f6f3a"],
            "fill-opacity": 0.18,
          },
        },
        beforeId,
      );
      map.addLayer(
        {
          id: LYR.canopyChmOutline,
          type: "line",
          source: SRC.canopyChm,
          minzoom: 15,
          paint: { "line-color": "#2f6f3a", "line-width": 0.6, "line-dasharray": [2, 2], "line-opacity": 0.25 },
        },
        beforeId,
      );
      map.addLayer(
        {
          id: LYR.shadows,
          type: "fill",
          source: SRC.shadows,
          paint: { "fill-color": "#1e2a44", "fill-opacity": 0.23, "fill-antialias": false },
        },
        beforeId,
      );
      map.addLayer(
        {
          id: LYR.structures,
          type: "fill",
          source: SRC.structures,
          paint: { "fill-color": "#8a5a2b", "fill-opacity": 0.8, "fill-outline-color": "#5a3a18" },
        },
        beforeId,
      );
      map.addLayer(
        {
          id: LYR.pathsCasing,
          type: "line",
          source: SRC.paths,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": "#ffffff",
            "line-width": ["interpolate", ["linear"], ["zoom"], 13, 3, 15, 4.5, 17, 7],
            "line-opacity": 0.85,
          },
        },
        beforeId,
      );
      map.addLayer(
        {
          id: LYR.paths,
          type: "line",
          source: SRC.paths,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": ["case", ["has", "shadeRatio"], [
              "interpolate",
              ["linear"],
              ["get", "shadeRatio"],
              0,
              PATH_SHADE_COLORS.sun,
              0.5,
              PATH_SHADE_COLORS.mid,
              1,
              PATH_SHADE_COLORS.shade,
            ], "#8b9891"],
            "line-width": ["interpolate", ["linear"], ["zoom"], 13, 1.8, 15, 2.6, 17, 4.5],
            "line-opacity": ["interpolate", ["linear"], ["zoom"], 13, 1, 16, 1],
          },
        },
        beforeId,
      );
      map.addLayer(
        {
          id: LYR.trees,
          type: "circle",
          source: SRC.trees,
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 14, 2, 17, 6],
            "circle-color": "#2e7d32",
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": 1,
            "circle-opacity": 0.55,
          },
        },
        beforeId,
      );
      map.addLayer(
        {
          id: LYR.buildings,
          type: "fill",
          source: SRC.buildings,
          paint: {
            "fill-color": ["match", ["get", "heightSource"], "osm", "#5b6b8c", "levels", "#7d8aa8", /* estimated */ "#a9b0c2"],
            "fill-opacity": 0.3,
          },
        },
        beforeId,
      );
      map.addLayer(
        {
          id: LYR.buildingsOutline,
          type: "line",
          source: SRC.buildings,
          paint: { "line-color": "#3d4a66", "line-width": 0.5, "line-opacity": 0.25 },
        },
        beforeId,
      );
      map.addLayer(
        {
          id: LYR.buildings3d,
          type: "fill-extrusion",
          source: SRC.buildings,
          layout: { visibility: "none" },
          paint: {
            "fill-extrusion-color": ["interpolate", ["linear"], ["get", "height"], 0, "#c9d0e0", 30, "#8e9bb8", 90, "#5b6b8c"],
            "fill-extrusion-height": ["get", "height"],
            "fill-extrusion-base": 0,
            "fill-extrusion-opacity": 0.85,
          },
        },
        beforeId,
      );

      for (const [id, source] of [[LYR.canopy3d, SRC.canopy], [LYR.canopyChm3d, SRC.canopyChm]]) {
        map.addLayer({
          id,
          type: "fill-extrusion",
          source,
          layout: { visibility: "none" },
          paint: {
            "fill-extrusion-color": ["interpolate", ["linear"], ["get", "height"], 3, "#9bb97a", 9, "#729861", 18, "#486f4b"],
            "fill-extrusion-height": ["get", "height"],
            "fill-extrusion-base": 0,
            "fill-extrusion-opacity": 0.72,
          },
        }, beforeId);
      }

      map.moveLayer(LYR.pathsCasing, beforeId);
      map.moveLayer(LYR.paths, beforeId);

      popupRef.current = addMapPopups(map, shadeState);

      readyRef.current = true;
    });

    mapRef.current = map;
    if (import.meta.env.DEV) {
      (window as unknown as { __gwMap?: MLMap }).__gwMap = map; // debugging hook (dev only)
    }
    return () => {
      removeUserHeading();
      popupRef.current?.remove();
      popupRef.current = null;
      map.remove();
      mapRef.current = null;
      readyRef.current = false;
    };
  }, []);

  // Static layers
  useEffect(() => {
    runWhenReady(mapRef, readyRef, (map) => {
      setSourceData(map, SRC.park, park);
      setSourceData(map, SRC.parkGround, parkGround);
      setSourceData(map, SRC.buildings, buildings);
      setSourceData(map, SRC.trees, trees);
      setSourceData(map, SRC.canopy, canopy);
      setSourceData(map, SRC.canopyChm, canopyChm);
      setSourceData(map, SRC.structures, structures);
    });
  }, [park, parkGround, buildings, trees, canopy, canopyChm, structures]);

  // Paths with per-feature shade ratio
  useEffect(() => {
    runWhenReady(mapRef, readyRef, (map) => {
      if (!paths) return;
      const fc: FeatureCollection = segmentPaths ?? paths;
      setSourceData(map, SRC.paths, fc);
    });
  }, [paths, segmentPaths]);

  // Shadow union
  useEffect(() => {
    runWhenReady(mapRef, readyRef, (map) => {
      setSourceData(map, SRC.shadows, shadowUnion ? { type: "Feature", geometry: shadowUnion, properties: {} } : EMPTY_FC);
    });
  }, [shadowUnion]);

  // Layer visibility + 3D toggle
  useEffect(() => {
    runWhenReady(mapRef, readyRef, (map) => {
      const set = (id: string, on: boolean) => {
        if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
      };
      set(LYR.shadows, visibility.shadows);
      set(LYR.paths, visibility.paths);
      set(LYR.pathsCasing, visibility.paths);
      set(LYR.trees, visibility.vegetation);
      set(LYR.canopy, visibility.vegetation && !canopyChm?.features.length);
      set(LYR.canopy3d, visibility.vegetation && visibility.buildings3d && !canopyChm?.features.length);
      set(LYR.canopyChm3d, visibility.canopyChm && visibility.buildings3d);
      set(LYR.structures, visibility.vegetation);
      set(LYR.canopyChm, visibility.canopyChm);
      set(LYR.canopyChmOutline, visibility.canopyChm);
      set(LYR.buildings, visibility.buildings && !visibility.buildings3d);
      set(LYR.buildingsOutline, visibility.buildings && !visibility.buildings3d);
      set(LYR.buildings3d, visibility.buildings && visibility.buildings3d);
      const targetPitch = visibility.buildings3d ? 45 : 0;
      if (Math.abs(map.getPitch() - targetPitch) > 1) map.easeTo({ pitch: targetPitch, duration: 600 });
    });
  }, [visibility, canopyChm]);

  return <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />;
}
