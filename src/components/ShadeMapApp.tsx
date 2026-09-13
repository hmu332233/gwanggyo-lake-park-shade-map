import { useEffect, useMemo, useState } from "react";
import GwanggyoMap from "./GwanggyoMap";
import TimeSlider from "./TimeSlider";
import MapControls, { type ShadeStats } from "./MapControls";
import { loadGwanggyoData, type GwanggyoData } from "@/lib/data";
import { GWANGGYO_CENTER, TIME_RANGE, MIN_SUN_ALTITUDE_RAD } from "@/lib/config";
import { dateAtMinutes, formatMinutes, getSunPosition, todayISO, koreaNow } from "@/lib/sun";
import { useShadows } from "@/lib/useShadows";
import { readUrlState, writeUrlState } from "@/lib/urlState";
import type { CasterFlags, LayerVisibility, SunPosition } from "@/types/map";
import styles from "./ShadeMapApp.module.css";

const DEFAULT_VISIBILITY: LayerVisibility = {
  buildings: true,
  shadows: true,
  vegetation: true,
  canopyChm: true,
  paths: true,
  buildings3d: true,
};

function defaultMinutes(): number {
  const m = Math.round(koreaNow().minutes / TIME_RANGE.stepMinutes) * TIME_RANGE.stepMinutes;
  return Math.min(TIME_RANGE.endMinutes, Math.max(TIME_RANGE.startMinutes, m));
}

export default function ShadeMapApp() {
  // Initial state comes from the URL when present (shareable links), else "now".
  const [initialState] = useState(readUrlState);
  const [date, setDate] = useState(() => initialState.date ?? todayISO());
  const [minutes, setMinutes] = useState(() => initialState.minutes ?? defaultMinutes());
  const [visibility, setVisibility] = useState<LayerVisibility>(() => ({ ...DEFAULT_VISIBILITY, ...initialState.visibility }));
  const [data, setData] = useState<GwanggyoData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSmallScreen] = useState(() => window.innerWidth < 640);

  // Load static data once
  useEffect(() => {
    let cancelled = false;
    loadGwanggyoData()
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep the URL in sync (debounced) so the current view can be shared.
  useEffect(() => {
    const t = setTimeout(() => writeUrlState(date, minutes, visibility), 250);
    return () => clearTimeout(t);
  }, [date, minutes, visibility]);

  const sun: SunPosition | null = useMemo(() => {
    const [lng, lat] = GWANGGYO_CENTER;
    return getSunPosition(dateAtMinutes(date, minutes), lat, lng);
  }, [date, minutes]);

  // Shadows + shade ratios are recomputed (in a Web Worker) whenever the sun or the data changes.
  // Toggling a caster layer also removes it from the shadow/shade computation.
  const flags: CasterFlags = useMemo(
    () => ({ vegetation: visibility.vegetation, canopyChm: visibility.canopyChm }),
    [visibility.vegetation, visibility.canopyChm],
  );
  const { result, isComputing } = useShadows(data, sun, flags);

  const stats: ShadeStats | null =
    data && result
      ? {
          buildings: data.buildings.features.length,
          vegetation: data.trees.features.length + (data.canopyChm.features.length ? 0 : data.canopy.features.length) + data.structures.features.length,
          canopyChm: data.canopyChm.features.length,
          parkShade: result.parkShade.ratio,
          parkAreaM2: result.parkShade.areaM2,
          parkShadedM2: result.parkShade.shadedM2,
          pathShade: result.pathShade.all.ratio,
          parkPathKm: result.pathShade.all.lengthM / 1000,
        }
      : null;

  return (
    <div className={styles.root}>
      <GwanggyoMap
        park={data?.park ?? null}
        parkGround={data?.parkGround ?? null}
        buildings={data?.buildings ?? null}
        paths={data?.paths ?? null}
        trees={data?.trees ?? null}
        canopy={data?.canopy ?? null}
        canopyChm={data?.canopyChm ?? null}
        structures={data?.structures ?? null}
        shadowUnion={result?.shadowUnion ?? null}
        segmentPaths={sun && sun.altitude > MIN_SUN_ALTITUDE_RAD ? result?.segmentPaths ?? null : null}
        visibility={visibility}
        daylight={!!sun && sun.altitude > MIN_SUN_ALTITUDE_RAD}
        isComputing={isComputing}
      />

      <aside className={styles.controls}>
        <MapControls
          visibility={visibility}
          onChange={setVisibility}
          sun={sun}
          dateLabel={`${date} ${formatMinutes(minutes)}`}
          stats={stats}
          isComputing={isComputing}
          defaultCollapsed={isSmallScreen}
        />
        {!data && !error && <div className={styles.loading}>데이터 불러오는 중…</div>}
        {error && <div className={styles.error}>{error}</div>}
      </aside>

      <footer className={styles.footer}>
        <TimeSlider date={date} minutes={minutes} onDateChange={setDate} onMinutesChange={setMinutes} />
      </footer>
    </div>
  );
}
