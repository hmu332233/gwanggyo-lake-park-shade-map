import { useState } from "react";
import { MIN_SUN_ALTITUDE_RAD, PATH_SHADE_COLORS } from "@/lib/config";
import type { LayerVisibility, SunPosition } from "@/types/map";
import styles from "./MapControls.module.css";

export interface ShadeStats {
  parkAreaM2: number;
  parkShadedM2: number;
  pathShade: number;
  buildings: number;
  vegetation: number;
  canopyChm: number;
  parkShade: number;
  parkPathKm: number;
  /** Deciduous leaf fraction 0..1 on the selected date. */
  deciduousLeaf: number;
}
interface Props {
  visibility: LayerVisibility;
  onChange: (v: LayerVisibility) => void;
  sun: SunPosition | null;
  dateLabel: string;
  stats: ShadeStats | null;
  isComputing: boolean;
  defaultCollapsed?: boolean;
}
const LABELS: Record<keyof LayerVisibility, string> = {
  buildings: "건물", shadows: "그림자", vegetation: "수목·시설", canopyChm: "위성 수목", paths: "공원 산책길", buildings3d: "입체 지도",
};
export default function MapControls({ visibility, onChange, sun, dateLabel, stats, isComputing, defaultCollapsed = false }: Props) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const belowHorizon = !sun || sun.altitude <= MIN_SUN_ALTITUDE_RAD;
  const pct = stats && !belowHorizon ? Math.round(stats.parkShade * 100) : null;
  return (
    <div className={styles.panel}>
      <div className={styles.eyebrow}>GWANGGYO LAKE PARK</div>
      <button type="button" className={styles.header} onClick={() => setCollapsed((c) => !c)} aria-expanded={!collapsed} aria-controls="gw-panel-body">
        <span className={styles.title}>광교호수공원 그늘 지도</span>
        <span className={styles.chevron} aria-hidden>{collapsed ? "+" : "−"}</span>
      </button>
      <p className={styles.subtitle}>호수와 숲, 공원 전체의 그늘을 살펴보세요</p>
      <div className={styles.legend} aria-label="산책길 색상: 주황은 햇빛, 파랑은 그늘">
        <span>햇빛</span>
        <span className={styles.ramp} style={{ background: `linear-gradient(90deg, ${PATH_SHADE_COLORS.sun}, ${PATH_SHADE_COLORS.mid}, ${PATH_SHADE_COLORS.shade})` }} />
        <span>그늘</span>
      </div>
      {belowHorizon ? <p className={styles.note}>태양이 너무 낮거나 해가 진 시간입니다. 그늘 비율을 표시하지 않습니다.</p> :
        <div className={styles.summary}><span>공원 육지의 예상 그늘{isComputing ? " · 갱신 중" : ""}</span><strong>{pct === null ? "계산 중…" : `${pct}%`}</strong></div>}
      {!collapsed && <div id="gw-panel-body" className={styles.body}>
        {stats && !belowHorizon && <>
          <p className={styles.detail}>호수·건물을 제외한 {(stats.parkAreaM2 / 10000).toFixed(1)} ha 중 약 {(stats.parkShadedM2 / 10000).toFixed(1)} ha가 그늘</p>
          <div className={styles.lakes}><div><span>공원 산책길 <small>{stats.parkPathKm.toFixed(1)} km</small></span><strong>{Math.round(stats.pathShade * 100)}%</strong></div></div>
          {stats.deciduousLeaf < 1 && <p className={styles.detail}>{stats.deciduousLeaf === 0 ? "낙엽수의 잎이 진 시기예요." : `낙엽수 잎이 약 ${Math.round(stats.deciduousLeaf * 100)}%인 시기예요.`} 잎이 적은 나무 아래는 옅은 그늘로 보고 일부만 그늘 비율에 반영해요.</p>}
          <p className={styles.detail}>공원 어디든 눌러 그늘을 확인해 보세요. 산책길은 구간별 그늘 비율을 보여드려요.</p>
        </>}
        <p className={styles.note}>날짜와 시간을 바꿔 그늘의 변화를 살펴보세요. 실제 그늘은 수목 상태와 날씨에 따라 달라질 수 있어요.</p>
        <details className={styles.settings}>
          <summary>지도 설정 · 데이터 안내</summary>
          <div className={styles.layers}>{(Object.keys(LABELS) as (keyof LayerVisibility)[]).map((key) => (
            <label key={key} className={styles.check}><input type="checkbox" checked={visibility[key]} onChange={(e) => onChange({ ...visibility, [key]: e.target.checked })} /><span>{LABELS[key]}</span></label>
          ))}</div>
          <p className={styles.note}>호수·건물을 제외한 분석 영역이며 실제 통행 가능 여부는 다를 수 있어요. 수목 입체 표현은 추정 높이를 나타냅니다. 초록색은 공원 육지, 파란 음영은 예상 그늘입니다. 산책길은 주황(햇빛)에서 파랑(그늘)으로 표시합니다. 수목 설정을 끄면 해당 수목을 그늘 계산에서도 제외합니다. 위성 수목 자료가 있으면 수림대는 위성 자료를 우선 사용합니다.</p>
          <p className={styles.note}>선택 시간 {dateLabel}<br />태양 고도 {sun?.altitudeDeg.toFixed(1) ?? "–"}° · 방위각 {sun ? Math.round(sun.azimuthDeg) : "–"}°</p>
          <p className={styles.note}>OpenStreetMap 건물·수목과 Meta·WRI 위성 수관 높이 v2(2019년 2월 위성 영상, CC BY 4.0)를 이용한 추정입니다. 그 뒤의 성장·식재·벌목은 반영되지 않았고, 작은 나무일수록 오차가 큽니다.</p>
          <p className={styles.note}>상록·낙엽 비율과 계절별 잎 변화는 Sentinel-2 영상의 계절 NDVI로 추정했어요. 10 m 해상도라 작은 나무와 숲 가장자리는 주변 잔디와 섞여 추정됩니다. Contains modified Copernicus Sentinel data 2023–2025.</p>
          {stats && <p className={styles.note}>건물 {stats.buildings.toLocaleString()} · 수목·시설 {stats.vegetation.toLocaleString()} · 위성 수관 {stats.canopyChm.toLocaleString()}</p>}
        </details>
        <a
          className={styles.github}
          href="https://github.com/hmu332233/gwanggyo-lake-park-shade-map"
          target="_blank"
          rel="noreferrer"
        >
          GitHub ↗
        </a>
      </div>}
    </div>
  );
}
