"""
Check the satellite canopy heights against NASA GEDI lidar footprints (GEDI L2A, public domain).

GEDI shots are fetched anonymously through the SlideRule public cluster; no Earthdata login is needed.
Each ~25 m footprint's rh98 is compared with the 98th-percentile CHM height inside a circle around it.
Footprints within 25 m of a building or near water are dropped (they mix roofs or water into the
waveform), as are low-sensitivity shots and slopes over 10° (terrain relief inflates rh98).
GEDI's ~10 m geolocation error mixes neighbouring crowns into sparse-canopy footprints, so the
script reports both a 12.5 m and a 22.5 m comparison radius.

    python3 -m venv .venv && .venv/bin/pip install sliderule geopandas rasterio pandas
    npm run fetch:osm && npm run fetch:canopy      # builds the CHM window cache and building footprints
    .venv/bin/python scripts/validate_canopy_gedi.py
"""
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
import rasterio
from rasterio.windows import from_bounds
from shapely.geometry import shape
from shapely.strtree import STRtree
from sliderule import gedi, sliderule

ROOT = Path(__file__).resolve().parent.parent
CHM_WINDOW = ROOT / ".cache/chm/v2_1321103203_window.json"  # written by fetch-canopy-chm.ts
BBOX = (127.052, 37.268, 127.085, 37.298)
DEM = "/vsicurl/https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N37_00_E127_00_DEM/Copernicus_DSM_COG_10_N37_00_E127_00_DEM.tif"
EARTH = 6378137


def main():
    w, s, e, n = BBOX
    sliderule.init("slideruleearth.io", verbose=False)
    poly = [{"lon": x, "lat": y} for x, y in [(w, s), (e, s), (e, n), (w, n), (w, s)]]
    shots = gedi.gedi02ap({"poly": poly, "degrade_filter": True, "l2_quality_filter": True,
                           "beams": [0, 1, 2, 3, 5, 6, 8, 11], "anc_fields": ["rh"]})
    shots["rh98"] = [rh[98] for rh in shots.rh]

    win = json.loads(CHM_WINDOW.read_text())
    chm = np.array(win["values"], dtype=np.float32).reshape(win["height"], win["width"])
    chm[~np.isfinite(chm) | (chm < 0) | (chm > 200)] = np.nan
    ground_m = win["pixel"] * math.cos(math.radians((s + n) / 2))

    buildings = STRtree([shape(f["geometry"]) for f in json.loads((ROOT / ".cache/osm/buildings_aoi_footprints.geojson").read_text())["features"]])
    park = json.loads((ROOT / "public/data/gwanggyo/park.geojson").read_text())
    water = STRtree([shape(f["geometry"]) for f in park["features"] if f["properties"]["kind"] == "water"])

    dem = rasterio.open(DEM)
    window = from_bounds(w - 0.01, s - 0.01, e + 0.01, n + 0.01, dem.transform)
    z = dem.read(1, window=window).astype(float)
    t = rasterio.windows.transform(window, dem.transform)
    gy, gx = np.gradient(z, abs(t.e) * 110574, t.a * 111320 * math.cos(math.radians((s + n) / 2)))
    slope = np.degrees(np.arctan(np.hypot(gx, gy)))

    deg25 = 25 / (111320 * math.cos(math.radians((s + n) / 2)))
    rows = []
    for _, shot in shots.iterrows():
        p = shot.geometry
        if shot.sensitivity < 0.95 or len(buildings.query(p.buffer(deg25), predicate="intersects")) or len(water.query(p.buffer(deg25 * 0.6), predicate="intersects")):
            continue
        if slope[int((p.y - t.f) / t.e), int((p.x - t.c) / t.a)] >= 10:
            continue
        mx = p.x * math.pi * EARTH / 180
        my = EARTH * math.log(math.tan(math.pi / 4 + p.y * math.pi / 360))
        col, row = int((mx - win["originX"]) / win["pixel"]), int((win["originY"] - my) / win["pixel"])
        row_out = {"year": str(_)[:4], "rh98": shot.rh98}
        for radius in (12.5, 22.5):
            r = int(radius / ground_m) + 1
            if row - r < 0 or col - r < 0 or row + r >= chm.shape[0] or col + r >= chm.shape[1]:
                break
            yy, xx = np.ogrid[-r:r + 1, -r:r + 1]
            vals = chm[row - r:row + r + 1, col - r:col + r + 1][(xx ** 2 + yy ** 2) <= (radius / ground_m) ** 2]
            vals = vals[np.isfinite(vals)]
            row_out[f"chm_{radius}"] = float(np.percentile(vals, 98)) if len(vals) else np.nan
            row_out[f"cover_{radius}"] = float((vals >= 3).mean()) if len(vals) else np.nan
        else:
            rows.append(row_out)

    d = pd.DataFrame(rows).dropna()
    print(f"GEDI shots {len(shots)}, kept {len(d)} (sensitivity >= 0.95, slope < 10°, away from roofs and water)")
    for radius in (12.5, 22.5):
        for label, sub in (("all", d), ("canopy cover >= 30%", d[d[f"cover_{radius}"] >= 0.3])):
            err = sub[f"chm_{radius}"] - sub.rh98
            print(f"r={radius:4} m {label:20s} n={len(sub):4d}  GEDI rh98 median {sub.rh98.median():5.1f} m  "
                  f"CHM median {sub[f'chm_{radius}'].median():5.1f} m  bias median {err.median():+5.1f} m  MAE {err.abs().mean():4.1f} m")
    by_year = d.assign(err=d["chm_22.5"] - d.rh98).groupby("year").err.agg(["count", "median"]).round(1)
    print("bias (CHM − GEDI, 22.5 m) by GEDI year:\n" + by_year.to_string())


if __name__ == "__main__":
    main()
