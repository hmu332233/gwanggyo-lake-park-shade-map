# 데이터와 계산 방법

이 문서는 광교호수공원 그늘 지도가 어떤 자료를 사용하고, 그 자료를 어떤 규칙으로 그림자와 그늘 비율로 바꾸는지 설명합니다. 화면 사용법은 루트 [README](../README.md)를 참고하세요.

## 분석 범위

- 분석 대상은 광교호수공원의 공원 육지와 공원 안 보행로입니다.
- 호수 수면과 건물 footprint는 공원 육지에서 제외합니다.
- 그림자를 만들 수 있는 건물·수목·시설은 공원과 주변 500 m 범위(AOI)에서 수집합니다.
- 공원 경계와 저수지는 [scripts/fetch-osm.ts](../scripts/fetch-osm.ts)가 OSM 자료에서 만듭니다.
- 보행로는 AOI에서 받은 뒤 [scripts/select-park-paths.ts](../scripts/select-park-paths.ts)가 공원 경계 안쪽만 남깁니다.
- 결과 GeoJSON은 `public/data/gwanggyo/`에 저장됩니다.

## 자료 출처와 라이선스

기본 경계, 건물, 보행로, 개별 수목, 수림대, 시설물은 [OpenStreetMap](https://www.openstreetmap.org/) 자료를 Overpass API로 조회합니다. OSM 데이터는 [ODbL](https://www.openstreetmap.org/copyright)의 적용을 받으므로 재배포하거나 가공 자료를 공개할 때 OSM 저작권 고지를 지켜야 합니다.

위성 수관 높이 자료는 Meta와 WRI의 [High Resolution Canopy Height Maps](https://registry.opendata.aws/dataforgood-fb-forests/)입니다. 이 프로젝트가 사용하는 공개 COG 자료의 라이선스 표기는 CC BY 4.0입니다. 재사용할 때 원 자료의 저작자 표시와 라이선스 조건을 확인하세요.

지도 배경은 [OpenFreeMap](https://openfreemap.org)의 Positron 스타일입니다. 타일 제공자의 최신 이용 조건과 필요한 출처 표기를 따르세요.

## 데이터 생성

```bash
npm install
npm run fetch:osm                 # OSM 조회와 정적 레이어 생성
npm run fetch:osm -- --force      # Overpass 캐시 무시
npm run fetch:canopy              # CHM 수관 레이어 생성
```

Overpass 응답은 `.cache/osm/`에 캐시됩니다. `fetch:osm`은 공원 경계와 AOI, 건물, 보행로, 개별 나무, OSM 수림대, 시설물 GeoJSON을 생성하고, CHM 마스킹용 AOI 전체 건물 footprint도 캐시합니다.

`fetch:canopy`는 OSM 생성이 끝난 뒤 실행합니다. Meta·WRI COG에서 AOI 창을 읽어 `canopy_chm.geojson`을 만들고 읽은 래스터 창을 `.cache/chm/`에 캐시합니다.

공원 보행로만 다시 만들 때는 캐시된 AOI 보행망과 공원 경계를 사용합니다.

```bash
node --import tsx scripts/select-park-paths.ts
```

상류 자료가 바뀌면 결과도 달라질 수 있습니다. 생성 스크립트는 정적 데이터를 덮어쓰므로, 이전 결과가 필요하면 `public/data/gwanggyo/`를 별도로 보관하세요.

## 생성되는 레이어

| 파일 | 내용 |
| --- | --- |
| `park.geojson` | 공원 경계와 원천·신대 저수지 |
| `aoi.geojson` | 공원·저수지 주변 500 m 버퍼 |
| `buildings.geojson` | 공원에 그림자가 닿을 수 있는 건물 |
| `paths.geojson` | 공원 안으로 잘라낸 OSM 보행로 |
| `trees.geojson` | `natural=tree` 점 자료 |
| `canopy.geojson` | OSM 수림대·숲 폴리곤 |
| `structures.geojson` | 정자·파고라·교량 등 시설물 |
| `canopy_chm.geojson` | CHM 높이 구간에서 만든 수관 폴리곤 |

CHM 폴리곤은 개별 나무 목록이 아닙니다. 같은 위치에 여러 높이 구간이 겹칠 수 있고, 계산에서는 겹친 영역을 하나의 그늘로 처리합니다.

## 높이 정규화

[src/lib/buildings.ts](../src/lib/buildings.ts)의 `normalizeBuildingHeight()`가 건물 높이를 다음 순서로 정합니다.

1. `height` 태그를 사용합니다. 미터와 feet 표기를 읽어 미터로 변환합니다.
2. 높이가 없으면 `building:levels × 3 m`를 사용합니다.
3. 둘 다 없으면 건물 유형별 기본값을 사용합니다.

AOI 안에서 높이 또는 층수가 확인된 같은 유형 건물이 5개 이상이면 그 유형의 중앙값을 지역 기본값으로 우선 사용합니다. 그 밖에는 [src/lib/config.ts](../src/lib/config.ts)의 기본값을 사용합니다.

`heightSource`에는 `osm`, `levels`, `estimated`, `chm`을 기록합니다. OSM 나무와 시설물의 `height`, 나무의 `diameter_crown`도 같은 단위 파서로 미터로 변환합니다.

## 건물 그림자 필터

생성 단계에서 모든 AOI 건물을 매번 계산하지 않도록 다음 규칙으로 줄입니다.

- 하지, 추분, 동지 날짜를 사용합니다.
- 각 날짜의 07:00부터 19:00까지 30분 간격으로 태양 위치를 계산합니다.
- 건물 자체가 공원과 겹치거나, 샘플 시각 중 하나의 그림자가 공원과 겹치면 보존합니다.
- 나머지 건물은 결과에서 제외합니다.

이 필터는 데이터 크기를 줄이기 위한 선택 규칙입니다. 모든 날짜와 시각에 그림자가 닿지 않는다는 것을 증명하는 판정은 아닙니다.

## 태양과 그림자 형상

[src/lib/sun.ts](../src/lib/sun.ts)는 SunCalc 2.x의 북쪽 기준 시계방향 방위각을 받아 라디안으로 보관합니다. 태양 위치는 공원 중심 한 좌표에서 계산하고, 선택한 시각은 한국 표준시(UTC+9)로 해석합니다.

[src/lib/shadow.ts](../src/lib/shadow.ts)의 건물 모델은 footprint를 지면에서 수직으로 올린 기둥입니다. 그림자 길이는 다음 식으로 계산합니다.

```text
shadowLength = height / tan(sunAltitude)
```

그림자는 태양의 반대 bearing 방향으로 footprint를 이동시키며 쓸어 만든 영역입니다. 태양 고도가 0.5도 이하이면 그림자를 만들지 않고, 매우 낮은 고도에서의 길이는 600 m로 제한합니다.

볼록한 footprint는 원래 꼭짓점과 이동한 꼭짓점의 convex hull을 사용합니다. 오목한 footprint와 내부 구멍이 있는 수관은 양 끝 영역과 각 경계 변의 사각형을 `polygon-clipping`으로 합쳐 경계를 보존합니다.

나무는 중심점 주변의 12각형 수관으로 근사한 뒤 같은 sweep을 적용합니다. 현재 모델은 수관을 지면부터 높이까지 이어진 원기둥으로 보므로 열린 줄기 아래나 수관 하단의 빈 공간은 표현하지 않습니다.

## 수관 높이 지도 처리

[scripts/fetch-canopy-chm.ts](../scripts/fetch-canopy-chm.ts)는 CHM 래스터를 `2, 5, 8, 11, 14, 17, 20, 23, 26 m` 기준으로 등고선화합니다. 각 기준 높이에는 기준값보다 1.5 m 높은 대표 높이를 기록하므로 낮은 기준의 수관 안에 높은 기준의 수관이 겹칩니다.

처리 순서는 래스터 창 읽기, 등고선 생성, 약 1 m 허용치 단순화, AOI 클리핑, AOI 전체 건물 footprint와 호수 수면 마스킹입니다. 20,000 m²보다 큰 폴리곤은 150 m 격자로 나누고 4 m²보다 작은 결과는 버립니다.

CHM 자료가 있으면 넓은 OSM 수림대는 같은 영역을 중복해서 채우지 않도록 대체 자료로만 사용합니다. 개별 OSM 나무와 시설물은 유지합니다. CHM 폴리곤 수를 나무 그루 수로 해석하지 않습니다.

## 공원 육지 그늘

[src/lib/parkShade.ts](../src/lib/parkShade.ts)의 `createParkGround()`는 공원 경계 합집합에서 물과 건물 footprint를 뺍니다. 결과는 통행 가능 구역이 아니라 분석 대상에서 수면과 건물을 제외한 지면입니다.

`buildParkGroundGrid()`는 지면 폴리곤 면적을 별도로 계산하고 8 m 간격 중점 격자를 만듭니다. 격자점이 지면 안에 있을 때만 보관하고 위도에 따른 경도 방향 면적 차이를 cosine 가중치로 반영합니다.

그림자 안에 들어간 격자 가중치의 합을 전체 격자 가중치의 합으로 나누고, 그 비율을 지면 폴리곤 면적에 곱합니다. 8 m보다 좁은 띠, 경계, 작은 빈 공간은 격자 해상도 때문에 근사됩니다.

## 산책길 그늘

[src/lib/shade.ts](../src/lib/shade.ts)의 `buildSegmentGraph()`는 보행로를 최대 10 m 길이의 연결된 구간으로 나눕니다. `flagPathsInPark()`는 20 m 간격 표본의 절반 이상이 공원 안에 있는 경로를 공원 경로로 표시합니다.

각 구간은 최대 5 m 길이의 동일한 셀로 나누고 셀 중점이 그림자 안인지 검사합니다. 구간별 비율은 적중한 중점의 비율이며, 전체 산책길 비율은 구간 길이를 가중치로 한 평균입니다. 공원 육지 면적 비율과 산책길 길이 비율은 서로 다른 지표입니다.

`createPolygonIndex()`가 반환하는 함수형 공간 인덱스는 폴리곤 bounding box를 약 50 m 셀에 넣어 후보를 줄인 뒤 실제 point-in-polygon 검사를 수행합니다.

## 실행 시 계산 흐름

태양 위치나 레이어 선택이 바뀌면 건물·수목 그림자를 만들고 그림자 합집합, 산책길 비율, 공원 육지 비율을 차례로 계산합니다. [src/lib/shadow-engine.ts](../src/lib/shadow-engine.ts)가 초기 격자와 경로 구조를 한 번 준비하고, [src/workers/shadow.worker.ts](../src/workers/shadow.worker.ts)가 반복 계산을 Web Worker에서 실행합니다. Worker를 사용할 수 없으면 같은 계산 함수를 메인 스레드에서 사용합니다.

## 정확도와 해석의 한계

- OSM 태그가 없는 건물은 추정 높이를 사용하므로 실제 높이와 다를 수 있습니다.
- CHM은 과거 위성 영상과 모델에서 나온 추정치라 최근 식재·벌목, 위치와 높이 변화가 반영되지 않을 수 있습니다.
- 건물은 평평한 지면 위의 수직 기둥으로 계산하므로 지붕, 옥탑, 필로티, 층별 셋백을 표현하지 않습니다.
- 나무와 수관은 단순한 원기둥·높이층 모델이라 실제 수관 형태와 줄기 아래의 햇빛을 표현하지 않습니다.
- 건물·수면 마스크가 물이나 지붕 위에 뻗은 실제 수관 일부까지 제거할 수 있습니다.
- 지형의 높낮이는 사용하지 않고 태양 위치는 공원 중심 한 점에서 계산합니다.
- 좌표 이동은 짧은 거리용 등거리 근사이며 600 m 상한과 0.5도 고도 하한이 있습니다.
- 공원 면적은 8 m 격자, 산책길은 5 m 중점 표본을 사용하므로 그보다 작은 그림자와 경계는 정확히 측정하지 않습니다.
- 결과는 현장 측량이나 보행 안전·접근성 판정이 아닙니다. 공원 육지 지표에는 숲과 관리 제한 구역이 포함될 수 있습니다.

생성 데이터와 계산 규칙을 바꾼 뒤에는 `npm test`, `npm run typecheck`, 필요하면 `npm run bench`로 결과와 성능을 확인하세요.
