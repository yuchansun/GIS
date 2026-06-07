"""抓取新莊區可步行道路網（OSM via Overpass），輸出成精簡的圖結構供前端 A* 使用。

輸出 public/road_network.json:
{
  "nodes": [[lat, lng], ...],   # 以索引為節點編號
  "edges": [[a, b], ...]        # 無向邊（兩端為節點索引）
}

用法: python3 scripts/build_road_network.py
"""
import json
import os
import urllib.parse
import urllib.request

# 新莊範圍（WGS84），與 clip_flood.py 一致並略縮以聚焦市區
LAT_MIN, LAT_MAX = 25.00, 25.075
LNG_MIN, LNG_MAX = 121.41, 121.49

# 可步行的道路類型（排除高速公路/匝道）
HIGHWAY = (
    "primary|secondary|tertiary|residential|living_street|service|"
    "unclassified|pedestrian|footway|path|steps|track|road|"
    "primary_link|secondary_link|tertiary_link"
)

QUERY = f"""
[out:json][timeout:180];
way["highway"~"^({HIGHWAY})$"]
  ({LAT_MIN},{LNG_MIN},{LAT_MAX},{LNG_MAX});
(._;>;);
out body;
"""

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]


def fetch():
    last_err = None
    for url in ENDPOINTS:
        try:
            print(f"嘗試 Overpass 端點: {url}")
            data = urllib.parse.urlencode({"data": QUERY}).encode()
            req = urllib.request.Request(url, data=data, headers={"User-Agent": "xinzhuang-evac/1.0"})
            with urllib.request.urlopen(req, timeout=200) as resp:
                return json.loads(resp.read().decode())
        except Exception as e:  # noqa: BLE001
            print(f"  失敗: {e}")
            last_err = e
    raise SystemExit(f"所有 Overpass 端點都失敗: {last_err}")


def main():
    raw = fetch()
    elements = raw.get("elements", [])

    osm_nodes = {}  # osm_id -> (lat, lng)
    ways = []       # list of [osm_id, ...]
    for el in elements:
        if el["type"] == "node":
            osm_nodes[el["id"]] = (el["lat"], el["lon"])
        elif el["type"] == "way":
            nds = el.get("nodes", [])
            if len(nds) >= 2:
                ways.append(nds)

    # 只保留實際被使用、且落在範圍內的節點
    used = set()
    for w in ways:
        for nid in w:
            used.add(nid)

    id_map = {}        # osm_id -> new index
    nodes_out = []
    for nid in used:
        if nid not in osm_nodes:
            continue
        lat, lng = osm_nodes[nid]
        if not (LAT_MIN <= lat <= LAT_MAX and LNG_MIN <= lng <= LNG_MAX):
            continue
        id_map[nid] = len(nodes_out)
        nodes_out.append([round(lat, 6), round(lng, 6)])

    edge_set = set()
    for w in ways:
        for a, b in zip(w, w[1:]):
            if a in id_map and b in id_map:
                ia, ib = id_map[a], id_map[b]
                if ia == ib:
                    continue
                key = (ia, ib) if ia < ib else (ib, ia)
                edge_set.add(key)

    edges_out = [[a, b] for a, b in edge_set]

    out_path = os.path.join(os.path.dirname(__file__), "..", "public", "road_network.json")
    out_path = os.path.abspath(out_path)
    with open(out_path, "w") as f:
        json.dump({"nodes": nodes_out, "edges": edges_out}, f, separators=(",", ":"))

    size_kb = os.path.getsize(out_path) / 1024
    print(f"完成: {len(nodes_out)} 個節點, {len(edges_out)} 條邊 -> {out_path} ({size_kb:.0f} KB)")


if __name__ == "__main__":
    main()
