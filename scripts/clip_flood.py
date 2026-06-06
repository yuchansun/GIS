"""把水利署全台淹水潛勢圖（TWD97 GeometryCollection）裁切成新莊範圍、
轉成 WGS84 的標準 GeoJSON FeatureCollection，並縮小檔案。

用法: python3 scripts/clip_flood.py <輸入檔> <輸出檔> <情境標籤>
"""
import json
import math
import sys

# --- TWD97 (TM2, EPSG:3826) -> WGS84 反算，與前端 main.js 同公式 ---
def twd97_to_wgs84(x, y):
    a = 6378137.0
    b = 6356752.314245
    e = math.sqrt(1 - (b * b) / (a * a))
    e2 = e * e / (1 - e * e)
    k0 = 0.9999
    dx = 250000.0
    lon0 = math.radians(121)

    x0 = x - dx
    M = y / k0
    mu = M / (a * (1 - e * e / 4 - 3 * e**4 / 64 - 5 * e**6 / 256))
    e1 = (1 - math.sqrt(1 - e * e)) / (1 + math.sqrt(1 - e * e))
    J1 = (3 * e1 / 2) - (27 * e1**3 / 32)
    J2 = (21 * e1**2 / 16) - (55 * e1**4 / 32)
    J3 = (151 * e1**3 / 96)
    J4 = (1097 * e1**4 / 512)
    fp = mu + J1 * math.sin(2*mu) + J2 * math.sin(4*mu) + J3 * math.sin(6*mu) + J4 * math.sin(8*mu)
    C1 = e2 * math.cos(fp)**2
    T1 = math.tan(fp)**2
    N1 = a / math.sqrt(1 - e * e * math.sin(fp)**2)
    R1 = a * (1 - e * e) / (1 - e * e * math.sin(fp)**2)**1.5
    D = x0 / (N1 * k0)
    lat = fp - (N1 * math.tan(fp) / R1) * (D*D/2 - (5 + 3*T1 + 10*C1 - 4*C1*C1 - 9*e2)*D**4/24
            + (61 + 90*T1 + 298*C1 + 45*T1*T1 - 252*e2 - 3*C1*C1)*D**6/720)
    lon = lon0 + (D - (1 + 2*T1 + C1)*D**3/6
            + (5 - 2*C1 + 28*T1 - 3*C1*C1 + 8*e2 + 24*T1*T1)*D**5/120) / math.cos(fp)
    return [round(math.degrees(lon), 6), round(math.degrees(lat), 6)]

# 新莊範圍（WGS84）+ 緩衝
LNG_MIN, LNG_MAX = 121.40, 121.50
LAT_MIN, LAT_MAX = 24.98, 25.08
# 對應的 TWD97 粗略預過濾框（先用原始數值篩掉非新莊，避免全部換算）
TWD_X_MIN, TWD_X_MAX = 288000, 302000
TWD_Y_MIN, TWD_Y_MAX = 2760000, 2777000


def ring_in_twd_bbox(ring):
    for x, y in ring:
        if TWD_X_MIN <= x <= TWD_X_MAX and TWD_Y_MIN <= y <= TWD_Y_MAX:
            return True
    return False


def convert_ring(ring):
    return [twd97_to_wgs84(x, y) for x, y in ring]


def main(inp, outp, label):
    with open(inp) as f:
        data = json.load(f)

    geoms = data.get('geometries') or data.get('features') or []
    kept = []
    for g in geoms:
        geom = g.get('geometry', g)
        gtype = geom.get('type')
        coords = geom.get('coordinates')
        if gtype == 'Polygon':
            polys = [coords]
        elif gtype == 'MultiPolygon':
            polys = coords
        else:
            continue
        new_polys = []
        for poly in polys:
            outer = poly[0]
            if ring_in_twd_bbox(outer):
                new_polys.append([convert_ring(r) for r in poly])
        if new_polys:
            kept.append(new_polys)

    features = [{
        'type': 'Feature',
        'properties': {'scenario': label},
        'geometry': {'type': 'MultiPolygon', 'coordinates': new_polys}
    } for new_polys in kept]

    fc = {'type': 'FeatureCollection', 'features': features}
    with open(outp, 'w') as f:
        json.dump(fc, f, ensure_ascii=False)

    print(f'{inp} -> {outp}: kept {len(features)} polygons (label={label})')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], sys.argv[3])
