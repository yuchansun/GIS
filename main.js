let map;
let basinLayer;        // 圖層一：流域集水區大背景面
let realRiversLayer;   // 圖層二：100%地形貼合的五大支流溢流危險面（Polygon視覺化）
let realTributariesLayer; // 圖層二 A：真實支流河道線（LineString）
let riverLabelLayer;   // 新莊五大水系標記點
let customGeoJsonLayer; // 自訂上傳的 GeoJSON 圖層
const shelterMarkers = []; // 儲存官方避難所標記
let sheltersData = []; // 從 xinzhuang_shelters.json 動態載入
let selectedItem = null;let selectedPinMarker = null;let currentSidebarMode = 'rivers';

let directionsService;
let directionsRenderer;
let safeRouteLine = null;     // 自訂避災路徑的折線
let dangerPointsCache = null; // 河岸/河道危險點快取（A* 成本用）
let lastEvacuation = null;    // 記住目前避難起點，供降雨更新時自動重算

// 💡 智慧導航與左側面板更新核心演算法
function isFloodSuitableShelter(shelter) {
  return String(shelter.suit_for_f || shelter.suitForFlood || '').trim() === '是';
}

function getFloodSuitableShelters() {
  return sheltersData.filter(isFloodSuitableShelter);
}

function getGoogleMapsUrl(shelter) {
  const query = encodeURIComponent(`${shelter.lat},${shelter.lng}`);
  return `https://www.google.com/maps/search/?api=1&query=${query}`;
}

function triggerEvacuationGuidance(originLatLng, originName) {
  runEvacuation({ lat: originLatLng.lat(), lng: originLatLng.lng() }, originName);
}

function runEvacuation(origin, originName) {
  const suitableShelters = getFloodSuitableShelters();
  if (!suitableShelters.length) {
    alert('目前無符合淹水適用的避難所資料，請稍後再試。');
    return;
  }

  // 記住目前避難起點，降雨更新時可自動重算路線
  lastEvacuation = { origin, name: originName };

  // 先用直線距離挑出最近的避難所當作目的地
  let nearestShelter = suitableShelters[0];
  let minDistance = Infinity;
  suitableShelters.forEach(shelter => {
    const dist = approxMeters(origin.lat, origin.lng, shelter.lat, shelter.lng);
    if (dist < minDistance) {
      minDistance = dist;
      nearestShelter = shelter;
    }
  });

  // 用自訂成本演算法（A*）算出「避開河岸/淹水範圍」的安全路徑
  const destination = { lat: nearestShelter.lat, lng: nearestShelter.lng };
  const route = computeSafeRoute(origin, destination);
  drawSafeRoute(route.path);

  const distanceMeters = computePathDistance(route.path);
  const walkMinutes = Math.max(1, Math.round(distanceMeters / 1.33 / 60)); // 步行約 1.33 m/s

  const evapBox = document.getElementById("evacuation-box");
  const originText = document.getElementById("origin-spot-name");
  const targetText = document.getElementById("target-shelter-name");
  const distanceText = document.getElementById("walk-distance");
  const timeText = document.getElementById("walk-time");

  if (evapBox) {
    evapBox.style.display = "block";
    if (originText) originText.innerText = originName;
    if (targetText) targetText.innerText = nearestShelter.name;
    if (distanceText) {
      distanceText.innerText = distanceMeters >= 1000
        ? (distanceMeters / 1000).toFixed(2) + ' 公里'
        : Math.round(distanceMeters) + ' 公尺';
    }
    if (timeText) timeText.innerText = '約 ' + walkMinutes + ' 分鐘';
  }
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    console.error('載入 GeoJSON 失敗：', url, response.status);
    return null;
  }
  return response.json();
}

function isTwd97Coordinate(coord) {
  return Array.isArray(coord) && coord.length >= 2 && typeof coord[0] === 'number' && typeof coord[1] === 'number' && coord[0] > 180 && coord[0] < 500000 && coord[1] > 2000000 && coord[1] < 3100000;
}

function findFirstCoordinate(value) {
  if (isTwd97Coordinate(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const coord = findFirstCoordinate(item);
      if (coord) return coord;
    }
  } else if (value && typeof value === 'object') {
    for (const key in value) {
      const coord = findFirstCoordinate(value[key]);
      if (coord) return coord;
    }
  }
  return null;
}

function shouldProjectGeoJson(geojson) {
  if (!geojson) return false;
  const coordinate = findFirstCoordinate(geojson);
  return isTwd97Coordinate(coordinate);
}

async function loadGeoJsonSource(url, dataLayer, convertProjected = false) {
  const geojson = await fetchJson(url);
  if (!geojson) return;

  const needsConversion = convertProjected || shouldProjectGeoJson(geojson);
  const data = needsConversion ? {
    type: 'FeatureCollection',
    features: geojson.features.map(feature => ({
      type: 'Feature',
      properties: feature.properties,
      geometry: convertProjectedGeometry(feature.geometry)
    }))
  } : geojson;

  dataLayer.addGeoJson(data);
}

const riverColorMap = {
  '中港大排': '#00ecc6',
  '中港大大排': '#00ecc6',
  '塔寮坑溪': '#0984e3',
  '潭底溝': '#f1c40f',
  '十八份坑溪': '#e74c3c',
  '啞口坑溪': '#9b59b6',
  '大漢溪': '#1e90ff'
};

function normalizeRiverName(name) {
  return (name || '').toString().trim().replace(/大大排/g, '大排');
}

function collectRiverNames(layer) {
  const names = new Set();
  if (!layer) return names;
  layer.forEach(feature => {
    const name = feature.getProperty('NAME') || feature.getProperty('name') || feature.getProperty('RIVER_NAME');
    if (name) names.add(name.toString().trim());
  });
  return names;
}

function getLoadedRiverNames() {
  return Array.from(new Set([
    ...collectRiverNames(realRiversLayer),
    ...collectRiverNames(realTributariesLayer)
  ]));
}

function getRiverColor(name, index) {
  if (riverColorMap[name]) return riverColorMap[name];
  const palette = ['#00b894', '#0984e3', '#f1c40f', '#e74c3c', '#9b59b6', '#16a085', '#e67e22', '#6c5ce7'];
  return palette[index % palette.length];
}

function populateRiverLegend() {
  const legendContainer = document.getElementById('river-legend');
  if (!legendContainer) return;

  const loadedNames = getLoadedRiverNames();
  legendContainer.innerHTML = '';

  if (!loadedNames.length) {
    legendContainer.innerHTML = '<div class="legend-loading">資料載入中，請稍候…</div>';
    return;
  }

  loadedNames.sort((a, b) => a.localeCompare(b, 'zh-Hant-u-co-pinyin'));
  loadedNames.forEach((name, index) => {
    const item = document.createElement('div');
    item.className = 'legend-item clickable';
    item.setAttribute('data-river', name);

    const colorBar = document.createElement('div');
    colorBar.className = 'legend-color-bar';
    colorBar.style.background = getRiverColor(name, index);

    const label = document.createElement('span');
    label.textContent = name;

    item.appendChild(colorBar);
    item.appendChild(label);
    item.addEventListener('click', () => zoomToRiver(name));
    legendContainer.appendChild(item);
  });

  const note = document.createElement('div');
  note.className = 'legend-loading';
  note.textContent = '若未看到欲查詢支流，表示目前資料中尚未包含該支流名稱。';
  legendContainer.appendChild(note);
}

function extendBoundsWithGeometry(bounds, geometry) {
  const type = geometry.getType();
  if (type === 'Point') {
    bounds.extend(geometry.get());
    return;
  }

  if (type === 'MultiPoint' || type === 'LineString') {
    geometry.getArray().forEach(point => bounds.extend(point));
    return;
  }

  if (type === 'MultiLineString' || type === 'Polygon') {
    geometry.getArray().forEach(part => part.getArray().forEach(point => bounds.extend(point)));
    return;
  }

  if (type === 'MultiPolygon') {
    geometry.getArray().forEach(polygon => polygon.getArray().forEach(ring => ring.getArray().forEach(point => bounds.extend(point))));
    return;
  }
}

function findRiverBounds(layer, targetName) {
  const bounds = new google.maps.LatLngBounds();
  let found = false;
  const target = normalizeRiverName(targetName);

  layer.forEach(feature => {
    const name = normalizeRiverName(feature.getProperty('NAME') || feature.getProperty('name') || feature.getProperty('RIVER_NAME'));
    if (!name || !target) return;
    if (name.includes(target) || target.includes(name)) {
      const geometry = feature.getGeometry();
      if (geometry) {
        extendBoundsWithGeometry(bounds, geometry);
        found = true;
      }
    }
  });

  return found ? bounds : null;
}

function collectGeometryVertices(geometry) {
  const type = geometry.getType();
  const points = [];

  if (type === 'Point') {
    points.push(geometry.get());
  } else if (type === 'MultiPoint' || type === 'LineString') {
    geometry.getArray().forEach(point => points.push(point));
  } else if (type === 'MultiLineString' || type === 'Polygon') {
    geometry.getArray().forEach(part => part.getArray().forEach(point => points.push(point)));
  } else if (type === 'MultiPolygon') {
    geometry.getArray().forEach(polygon => polygon.getArray().forEach(ring => ring.getArray().forEach(point => points.push(point))));
  }

  return points;
}

function getClosestRiverNameByPoint(latLng) {
  let nearest = { dist: Infinity, name: '' };

  [realRiversLayer, realTributariesLayer].forEach(layer => {
    if (!layer) return;
    layer.forEach(feature => {
      const name = normalizeRiverName(feature.getProperty('Name') || feature.getProperty('NAME') || feature.getProperty('name') || feature.getProperty('RIVER_NAME'));
      if (!name) return;
      const geometry = feature.getGeometry();
      if (!geometry) return;
      collectGeometryVertices(geometry).forEach(point => {
        const dist = Math.pow(latLng.lat() - point.lat(), 2) + Math.pow(latLng.lng() - point.lng(), 2);
        if (dist < nearest.dist) {
          nearest = { dist, name };
        }
      });
    });
  });

  return nearest.name || '新莊河流';
}

function getRiverLabelDisplayName(feature) {
  const text = feature.getProperty('Name') || feature.getProperty('name') || feature.getProperty('NAME');
  if (text && String(text).trim()) return String(text).trim();
  return feature.getProperty('id') || feature.getProperty('ID') || '河流標記';
}

function setSidebarMode(mode) {
  currentSidebarMode = mode;
  selectedItem = null;
  updateSidebarPanel();
}

function clearSelectedPin() {
  if (selectedPinMarker) {
    selectedPinMarker.setMap(null);
    selectedPinMarker = null;
  }
}

function showSelectedPin(position) {
  clearSelectedPin();
  if (!map || !position) return;

  selectedPinMarker = new google.maps.Marker({
    position,
    map,
    icon: {
      path: google.maps.SymbolPath.BACKWARD_CLOSED_ARROW,
      scale: 9,
      fillColor: '#ff5252',
      fillOpacity: 1,
      strokeColor: '#ffffff',
      strokeWeight: 3
    }
  });
}

function clearSelection() {
  selectedItem = null;
  clearSelectedPin();
  updateSidebarPanel();
}

function updateSidebarButtons() {
  const riverBtn = document.getElementById('btn-show-river-list');
  const shelterBtn = document.getElementById('btn-show-shelter-list');
  if (riverBtn) riverBtn.classList.toggle('active', currentSidebarMode === 'rivers');
  if (shelterBtn) shelterBtn.classList.toggle('active', currentSidebarMode === 'shelters');
}

function renderSelectedRiverDetail(feature, nearestName) {
  const container = document.getElementById('sidebar-info');
  if (!container) return;
  const labelName = getRiverLabelDisplayName(feature);
  const location = feature.getGeometry().get();
  const description = feature.getProperty('descriptio') || feature.getProperty('description') || '無額外資訊';
  container.innerHTML = `
    <div class="sidebar-info-card">
      <div class="info-title">☑️ 河流標記細節</div>
      <div><strong>標記名稱：</strong>${labelName}</div>
      <div><strong>最近河流：</strong>${nearestName}</div>
      <div><strong>類型／說明：</strong>${description}</div>
      <div><strong>座標：</strong>${location.lat().toFixed(6)}, ${location.lng().toFixed(6)}</div>
      <div style="margin-top: 10px; color:#525f7f; font-size:13px; line-height:1.5;">點選左上方按鈕可切換列表；或點選地圖上其他河流標記查看資訊。</div>
    </div>
    <button id="btn-clear-selection" class="sidebar-action-btn" style="width:100%; margin-top:12px;">返回列表</button>
  `;
  const clearButton = document.getElementById('btn-clear-selection');
  if (clearButton) clearButton.addEventListener('click', clearSelection);
}

function renderSelectedShelterDetail(shelter) {
  const container = document.getElementById('sidebar-info');
  if (!container) return;
  container.innerHTML = `
    <div class="sidebar-info-card">
      <div class="info-title">🏡 避難所詳細資訊</div>
      <div><strong>名稱：</strong>${shelter.name}</div>
      <div><strong>地址：</strong>${shelter.address}</div>
      <div><strong>聯絡：</strong>${shelter.phone}</div>
      <div><strong>是否淹水適用：</strong>是</div>
      <a href="${getGoogleMapsUrl(shelter)}" target="_blank" rel="noopener" style="display:inline-block; margin-top:8px; color:#0d6efd; font-size:13px;">在 Google Maps 中檢視</a>
      <div style="margin-top: 10px; color:#525f7f; font-size:13px; line-height:1.5;">點選列表或地圖上的其他避難所，即可更新此區資訊。</div>
    </div>
    <button id="btn-clear-selection" class="sidebar-action-btn" style="width:100%; margin-top:12px;">返回列表</button>
  `;
  const clearButton = document.getElementById('btn-clear-selection');
  if (clearButton) clearButton.addEventListener('click', clearSelection);
}

function updateSidebarPanel() {
  updateSidebarButtons();
  if (selectedItem) {
    if (selectedItem.type === 'river') {
      renderSelectedRiverDetail(selectedItem.feature, selectedItem.nearestName);
    } else if (selectedItem.type === 'shelter') {
      renderSelectedShelterDetail(selectedItem.shelter);
    }
    return;
  }

  if (currentSidebarMode === 'rivers') {
    renderRiverLabelList();
  } else {
    renderShelterList();
  }
}

function renderRiverLabelList() {
  const container = document.getElementById('sidebar-info');
  if (!container) return;

  const features = [];
  riverLabelLayer.forEach(feature => features.push(feature));
  container.innerHTML = '';

  if (!features.length) {
    container.innerHTML = '<div class="legend-loading">新莊五大水系標記載入中，請稍後...</div>';
    return;
  }

  features.forEach((feature, index) => {
    const labelName = getRiverLabelDisplayName(feature);
    const location = feature.getGeometry().get();
    const description = feature.getProperty('descriptio') || feature.getProperty('description') || '河流監測點';
    const nearestName = labelName || getClosestRiverNameByPoint(location);
    const item = document.createElement('div');
    item.className = 'legend-item clickable';
    item.style.justifyContent = 'space-between';
    item.style.alignItems = 'flex-start';
    item.style.gap = '10px';
    item.innerHTML = `
      <div style="flex: 1; min-width: 0;">
        <div style="font-weight: 700; color: #1e90ff;">${labelName}</div>
        <div style="font-size: 12px; color: #555; margin-top: 3px; line-height: 1.4;">${description}</div>
        <div style="font-size: 12px; color: #555; margin-top: 3px;">座標：${location.lat().toFixed(6)}, ${location.lng().toFixed(6)}</div>
      </div>
    `;

    item.addEventListener('click', () => {
      map.panTo(location);
      map.setZoom(14);
      showSelectedRiverInfo(feature, nearestName);
    });

    container.appendChild(item);
  });
}

function renderShelterList() {
  const container = document.getElementById('sidebar-info');
  if (!container) return;

  const suitableShelters = getFloodSuitableShelters();
  container.innerHTML = '';

  if (!suitableShelters.length) {
    container.innerHTML = '<div class="legend-loading">目前無符合「淹水適用」的避難所資料。</div>';
    return;
  }

  suitableShelters.forEach(shelter => {
    const item = document.createElement('div');
    item.className = 'legend-item clickable';
    item.style.justifyContent = 'space-between';
    item.style.alignItems = 'flex-start';
    item.style.gap = '10px';
    item.innerHTML = `
      <div style="flex:1; min-width:0;">
        <div style="font-weight: 700; color: #1e90ff;">${shelter.name}</div>
        <div style="font-size: 12px; color: #555; margin-top: 3px; line-height: 1.4;">${shelter.address}</div>
        <div style="font-size: 12px; color: #555; margin-top: 3px;">聯絡：${shelter.phone}</div>
      </div>
      <a href="${getGoogleMapsUrl(shelter)}" target="_blank" rel="noopener" style="font-size:12px; color:#0d6efd; text-decoration:none; white-space:nowrap;">Google Map</a>
    `;

    item.addEventListener('click', () => {
      if (map && typeof shelter.lat === 'number' && typeof shelter.lng === 'number') {
        map.panTo({ lat: shelter.lat, lng: shelter.lng });
        map.setZoom(15);
      }
      showSelectedShelterInfo(shelter);
    });

    container.appendChild(item);
  });
}

function showSelectedRiverInfo(feature, nearestName) {
  selectedItem = { type: 'river', feature, nearestName };
  const location = feature.getGeometry().get();
  showSelectedPin(location);
  updateSidebarPanel();
}

function showSelectedShelterInfo(shelter) {
  selectedItem = { type: 'shelter', shelter };
  showSelectedPin({ lat: shelter.lat, lng: shelter.lng });
  updateSidebarPanel();
}

function loadRiverLabelPoints(url) {
  return loadGeoJsonSource(url, riverLabelLayer);
}

function updateShelterList() {
  if (currentSidebarMode === 'shelters' && !selectedItem) {
    renderShelterList();
  }
}

function updateRiverList() {
  if (currentSidebarMode === 'rivers' && !selectedItem) {
    renderRiverLabelList();
  }
}

function loadRiverLabelLegend() {
  if (currentSidebarMode === 'rivers') {
    updateRiverList();
  }
}

function zoomToRiver(name) {
  if (!map) return;
  let bounds = findRiverBounds(realRiversLayer, name);
  if (!bounds) bounds = findRiverBounds(realTributariesLayer, name);
  if (bounds) {
    map.fitBounds(bounds, 80);
    return;
  }
  const available = getLoadedRiverNames();
  alert(`找不到：${name}。
目前已載入支流：${available.length ? available.join('、') : '尚無可用資料'}。`);
}

function setupRiverJumpControls() {
  const items = document.querySelectorAll('.legend-item[data-river]');
  if (!items.length) return;
  items.forEach(item => {
    item.addEventListener('click', () => {
      const riverName = item.getAttribute('data-river');
      zoomToRiver(riverName);
    });
  });
}

async function loadShelters(url) {
  const geojson = await fetchJson(url);
  if (!geojson || !geojson.features) return;

  sheltersData = geojson.features.map(feature => {
    const [lng, lat] = feature.geometry.coordinates || [];
    return {
      name: feature.properties?.Name || feature.properties?.name2 || feature.properties?.name || '官方避難收容所',
      address: feature.properties?.address || feature.properties?.add || '地址未知',
      phone: feature.properties?.contact_ce || feature.properties?.contact_pe || '無聯絡資料',
      district: feature.properties?.district || '',
      lat,
      lng,
      suit_for_f: feature.properties?.suit_for_f || feature.properties?.suit_for_F || ''
    };
  }).filter(shelter => shelter.district === '新莊區' && isFloodSuitableShelter(shelter));
}

function renderShelterMarkers() {
  shelterMarkers.forEach(marker => marker.setMap(null));
  shelterMarkers.length = 0;

  sheltersData.forEach(shelter => {
    const shelterMarker = new google.maps.Marker({
      position: { lat: shelter.lat, lng: shelter.lng },
      map,
      title: shelter.name,
      icon: {
        path: google.maps.SymbolPath.BACKWARD_CLOSED_ARROW,
        scale: 7,
        fillColor: '#2ecc71',
        fillOpacity: 1,
        strokeColor: '#ffffff',
        strokeWeight: 2.5
      }
    });

    const shelterInfo = new google.maps.InfoWindow({
      content: `<div style="padding: 8px; font-family: sans-serif; max-width:240px;"><div style="font-weight: bold; color: #27ae60; font-size: 14px;">🏡 官方避難收容所</div><div style="font-size: 13px; font-weight: bold; margin-top:6px;">${shelter.name}</div><div style="font-size: 12px; color: #555; margin-top:6px;">${shelter.address}</div><div style="font-size: 12px; color: #555;">聯絡：${shelter.phone}</div><a href="${getGoogleMapsUrl(shelter)}" target="_blank" rel="noopener" style="display:inline-block; margin-top:8px; color:#0d6efd; font-size:12px;">在 Google Maps 查看</a></div>`
    });

    shelterMarker.addListener('click', () => {
      shelterInfo.open(map, shelterMarker);
      showSelectedShelterInfo(shelter);
    });
    shelter.marker = shelterMarker;
    shelterMarkers.push(shelterMarker);
  });
  updateShelterList();
}

// =========================================================================
// 🌧️ 中央氣象署即時降雨（只呈現雨量數字，不做風險判定）
// =========================================================================
const RAINFALL_DATASET = 'O-A0002-001'; // 自動雨量站-雨量觀測資料
const RAINFALL_STATION_ID = 'C0ACA0';   // 新莊雨量站（氣象署 O-A0002-001）
let currentRainfall = 0;                 // 供路徑成本動態調整使用（第 4 步）
let stormSimulation = false;             // 模擬暴雨測試模式
const STORM_RAINFALL = 50;               // 模擬暴雨時雨量 (mm/hr)

function parseRainfallValue(value) {
  const n = parseFloat(value);
  // 氣象署以 -99 / -990 等負值表示「無觀測資料」
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function describeRainfall(mm) {
  // 採用氣象署「時雨量」客觀描述用語，僅描述雨量大小，非風險等級
  if (mm >= 40) return '大雨以上';
  if (mm >= 10) return '較大雨勢';
  if (mm > 0) return '降雨中';
  return '目前無降雨';
}

function updateRainfallDisplay(mm, stationName) {
  currentRainfall = mm;
  const text = document.getElementById('rainfall-text');
  if (text) text.innerText = mm.toFixed(1);

  const badge = document.getElementById('risk-badge');
  if (badge) badge.innerText = describeRainfall(mm);

  const stationLabel = document.getElementById('station-name');
  if (stationLabel && stationName) stationLabel.innerText = stationName;

  // 若目前已有避難路線，依最新雨量重算（雨越大越遠離河川）
  if (lastEvacuation) {
    runEvacuation(lastEvacuation.origin, lastEvacuation.name);
  }
}

async function fetchRainfall() {
  if (stormSimulation) return; // 模擬暴雨模式下不被真實資料覆蓋
  const key = import.meta.env.VITE_CWA_API_KEY;
  if (!key || key.startsWith('請貼上')) {
    console.warn('尚未設定中央氣象署授權碼（VITE_CWA_API_KEY），略過降雨更新。');
    const badge = document.getElementById('risk-badge');
    if (badge) badge.innerText = '待設定授權碼';
    return;
  }

  const url = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/${RAINFALL_DATASET}`
    + `?Authorization=${encodeURIComponent(key)}&StationId=${RAINFALL_STATION_ID}`;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();

    const stations = data?.records?.Station || [];
    const station = stations.find(s => s.StationId === RAINFALL_STATION_ID) || stations[0];
    if (!station) {
      console.warn('找不到測站資料：', RAINFALL_STATION_ID);
      return;
    }

    const el = station.RainfallElement || {};
    // 優先取「過去 1 小時雨量」當作時雨量，其次取即時值
    const rainfall =
      parseRainfallValue(el.Past1hr?.Precipitation) ??
      parseRainfallValue(el.Now?.Precipitation) ??
      0;

    updateRainfallDisplay(rainfall, station.StationName);
  } catch (err) {
    console.error('降雨資料載入失敗：', err);
  }
}

function setupRainfall() {
  fetchRainfall();
  // 每 5 分鐘自動更新一次
  setInterval(fetchRainfall, 5 * 60 * 1000);
}

// 🌧️ 模擬暴雨測試按鈕：一鍵切換高雨量 / 真實雨量，用於展示動態避災
function setupStormSimulation() {
  const btn = document.getElementById('btn-simulate-storm');
  if (!btn) return;

  btn.addEventListener('click', () => {
    stormSimulation = !stormSimulation;
    if (stormSimulation) {
      btn.innerText = '☀️ 還原真實雨量';
      btn.style.background = '#27ae60';
      updateRainfallDisplay(STORM_RAINFALL, '模擬暴雨（測試）');
    } else {
      btn.innerText = '🌧️ 模擬暴雨（測試）';
      btn.style.background = '#e74c3c';
      fetchRainfall();
    }
  });
}

// 🔍 地點搜尋（Google Places Autocomplete）：搜尋地點即以該處為受災起點規劃避難
async function setupPlaceSearch() {
  const input = document.getElementById('place-search');
  if (!input) return;

  const { Autocomplete } = await google.maps.importLibrary("places");
  const autocomplete = new Autocomplete(input, {
    fields: ['geometry', 'name', 'formatted_address'],
    componentRestrictions: { country: 'tw' }
  });
  autocomplete.bindTo('bounds', map);

  autocomplete.addListener('place_changed', () => {
    const place = autocomplete.getPlace();
    if (!place.geometry || !place.geometry.location) {
      alert('找不到該地點，請從下拉選單選擇一個建議結果。');
      return;
    }
    const location = place.geometry.location;
    map.panTo(location);
    map.setZoom(15);
    showUserLocation(location);
    triggerEvacuationGuidance(location, place.name || '搜尋地點');
  });
}

let userLocationMarker = null;

function showUserLocation(position) {
  if (userLocationMarker) {
    userLocationMarker.setPosition(position);
    return;
  }
  userLocationMarker = new google.maps.Marker({
    position,
    map,
    title: '我的目前位置',
    zIndex: 999,
    icon: {
      path: google.maps.SymbolPath.CIRCLE,
      scale: 8,
      fillColor: '#1a73e8',
      fillOpacity: 1,
      strokeColor: '#ffffff',
      strokeWeight: 3
    }
  });
}

function setupLocateMeButton() {
  const btn = document.getElementById('btn-mylocation');
  if (!btn) return;

  btn.addEventListener('click', () => {
    if (!navigator.geolocation) {
      alert('您的瀏覽器不支援定位功能。');
      return;
    }

    btn.disabled = true;
    btn.innerText = '定位中，請稍候...';

    navigator.geolocation.getCurrentPosition(
      position => {
        btn.disabled = false;
        btn.innerText = '📍 偵測我目前位置（立即避難）';
        const origin = new google.maps.LatLng(position.coords.latitude, position.coords.longitude);
        map.panTo(origin);
        map.setZoom(14);
        showUserLocation(origin);
        triggerEvacuationGuidance(origin, '我的目前位置');
      },
      error => {
        btn.disabled = false;
        btn.innerText = '📍 偵測我目前位置（立即避難）';
        alert('無法取得定位：' + error.message);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
}

function loadGeoJsonFromLocal(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const geojson = JSON.parse(reader.result);
        const needsConversion = shouldProjectGeoJson(geojson);
        const data = needsConversion ? {
          type: 'FeatureCollection',
          features: geojson.features.map(feature => ({
            type: 'Feature',
            properties: feature.properties,
            geometry: convertProjectedGeometry(feature.geometry)
          }))
        } : geojson;
        customGeoJsonLayer.forEach(feature => customGeoJsonLayer.remove(feature));
        customGeoJsonLayer.addGeoJson(data);
        resolve();
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

function setupGeoJsonUpload() {
  const input = document.getElementById('geojson-upload');
  if (!input) return;

  input.addEventListener('change', async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      await loadGeoJsonFromLocal(file);
      alert('已成功載入自訂 GeoJSON。');
    } catch (err) {
      console.error('載入自訂 GeoJSON 失敗：', err);
      alert('無法解析自訂 GeoJSON 檔案，請確認檔案格式正確。');
    }
  });
}

// =========================================================================
// 🧭 避災路徑演算法（格網 + A*）：安全優先、避開河岸與淹水範圍
// =========================================================================

// 經緯度近似距離（公尺），在新莊小範圍內足夠精準
function approxMeters(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * 110540;
  const dLng = (lng2 - lng1) * 111320 * Math.cos((lat1 + lat2) / 2 * Math.PI / 180);
  return Math.hypot(dLat, dLng);
}

// 最小堆積，供 A* 取出成本最低節點
class MinHeap {
  constructor() { this.items = []; }
  isEmpty() { return this.items.length === 0; }
  push(value, priority) {
    const items = this.items;
    items.push({ value, priority });
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent].priority <= items[i].priority) break;
      [items[parent], items[i]] = [items[i], items[parent]];
      i = parent;
    }
  }
  pop() {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      const n = items.length;
      while (true) {
        let smallest = i;
        const l = 2 * i + 1, r = 2 * i + 2;
        if (l < n && items[l].priority < items[smallest].priority) smallest = l;
        if (r < n && items[r].priority < items[smallest].priority) smallest = r;
        if (smallest === i) break;
        [items[smallest], items[i]] = [items[i], items[smallest]];
        i = smallest;
      }
    }
    return top.value;
  }
}

// 蒐集所有河岸/河道頂點作為「危險點」，用來計算每格的危險成本
function buildDangerPoints() {
  if (dangerPointsCache) return dangerPointsCache;
  const points = [];
  [realRiversLayer, realTributariesLayer].forEach(layer => {
    if (!layer) return;
    layer.forEach(feature => {
      const geometry = feature.getGeometry();
      if (!geometry) return;
      collectGeometryVertices(geometry).forEach(p => points.push({ lat: p.lat(), lng: p.lng() }));
    });
  });

  // 點數過多時抽樣，避免成本計算過慢
  const MAX = 1200;
  if (points.length > MAX) {
    const stride = Math.ceil(points.length / MAX);
    dangerPointsCache = points.filter((_, i) => i % stride === 0);
  } else {
    dangerPointsCache = points;
  }
  return dangerPointsCache;
}

// 主演算法：回傳 { path: [{lat,lng}...], blocked }
function computeSafeRoute(origin, dest) {
  const danger = buildDangerPoints();
  if (!danger.length) {
    return { path: [origin, dest], blocked: false };
  }

  // 1. 計算含起終點的範圍框（留白讓路徑有空間繞行）
  let south = Math.min(origin.lat, dest.lat);
  let north = Math.max(origin.lat, dest.lat);
  let west = Math.min(origin.lng, dest.lng);
  let east = Math.max(origin.lng, dest.lng);
  const padLat = Math.max((north - south) * 0.6, 0.012);
  const padLng = Math.max((east - west) * 0.6, 0.012);
  south -= padLat; north += padLat; west -= padLng; east += padLng;

  // 2. 依實際尺寸決定格網解析度（每格約 60 公尺，上限 90x90）
  const heightM = approxMeters(south, west, north, west);
  const widthM = approxMeters(south, west, south, east);
  const rows = Math.min(90, Math.max(20, Math.round(heightM / 60)));
  const cols = Math.min(90, Math.max(20, Math.round(widthM / 60)));
  const cellH = (north - south) / rows;
  const cellW = (east - west) / cols;
  const latOf = r => south + (r + 0.5) * cellH;
  const lngOf = c => west + (c + 0.5) * cellW;

  // 3. 預算每格「進入成本」= 基礎(1) + 危險加成 ×（即時降雨係數）
  const NEAR_M = 50;   // 河道本體/淹水核心 → +20
  const BANK_M = 120;  // 近河岸 → +10
  // 降雨係數：0mm → 1 倍；40mm/hr 以上 → 3 倍，雨越大越會遠離河川
  const rainFactor = 1 + Math.min(currentRainfall, 40) / 20;
  const enterCost = new Float32Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    const lat = latOf(r);
    for (let c = 0; c < cols; c++) {
      const lng = lngOf(c);
      let minD = Infinity;
      for (let i = 0; i < danger.length; i++) {
        const d = approxMeters(lat, lng, danger[i].lat, danger[i].lng);
        if (d < minD) { minD = d; if (minD <= NEAR_M) break; }
      }
      let cost = 1;
      if (minD <= NEAR_M) cost += 20 * rainFactor;
      else if (minD <= BANK_M) cost += 10 * rainFactor;
      enterCost[r * cols + c] = cost;
    }
  }

  // 4. A* 搜尋
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const startR = clamp(Math.floor((origin.lat - south) / cellH), 0, rows - 1);
  const startC = clamp(Math.floor((origin.lng - west) / cellW), 0, cols - 1);
  const goalR = clamp(Math.floor((dest.lat - south) / cellH), 0, rows - 1);
  const goalC = clamp(Math.floor((dest.lng - west) / cellW), 0, cols - 1);
  const startIdx = startR * cols + startC;
  const goalIdx = goalR * cols + goalC;

  const gScore = new Float32Array(rows * cols).fill(Infinity);
  const cameFrom = new Int32Array(rows * cols).fill(-1);
  gScore[startIdx] = 0;

  const heuristic = (r, c) => Math.hypot(r - goalR, c - goalC); // 最小進入成本=1，可採用
  const open = new MinHeap();
  open.push(startIdx, heuristic(startR, startC));

  const neighbors = [
    [-1, 0, 1], [1, 0, 1], [0, -1, 1], [0, 1, 1],
    [-1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [1, 1, Math.SQRT2]
  ];

  let found = false;
  while (!open.isEmpty()) {
    const current = open.pop();
    if (current === goalIdx) { found = true; break; }
    const cr = Math.floor(current / cols);
    const cc = current % cols;
    for (const [dr, dc, step] of neighbors) {
      const nr = cr + dr, nc = cc + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      const nIdx = nr * cols + nc;
      const tentative = gScore[current] + enterCost[nIdx] * step;
      if (tentative < gScore[nIdx]) {
        gScore[nIdx] = tentative;
        cameFrom[nIdx] = current;
        open.push(nIdx, tentative + heuristic(nr, nc));
      }
    }
  }

  // 5. 回溯路徑
  if (!found) return { path: [origin, dest], blocked: true };
  const path = [];
  let cur = goalIdx;
  while (cur !== -1) {
    const r = Math.floor(cur / cols);
    const c = cur % cols;
    path.unshift({ lat: latOf(r), lng: lngOf(c) });
    if (cur === startIdx) break;
    cur = cameFrom[cur];
  }
  path.unshift(origin); // 用精確起點收邊
  path.push(dest);       // 用精確終點收邊
  return { path, blocked: false };
}

function drawSafeRoute(path) {
  if (safeRouteLine) { safeRouteLine.setMap(null); safeRouteLine = null; }
  if (directionsRenderer) directionsRenderer.setDirections({ routes: [] });
  if (!path || path.length < 2) return;

  safeRouteLine = new google.maps.Polyline({
    path: path.map(p => ({ lat: p.lat, lng: p.lng })),
    map,
    strokeColor: '#00ff7f',
    strokeWeight: 7,
    strokeOpacity: 0.95,
    geodesic: true
  });
}

function computePathDistance(path) {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += approxMeters(path[i - 1].lat, path[i - 1].lng, path[i].lat, path[i].lng);
  }
  return total;
}

// =========================================================================
// 🗺️ 地圖初始化
// =========================================================================
async function initMap() {
  await google.maps.importLibrary("maps");
  const { DirectionsService, DirectionsRenderer } = await google.maps.importLibrary("routes");

  const mapStyle = [
    { featureType: "poi", elementType: "labels", stylers: [{ visibility: "off" }] },
    { featureType: "road", elementType: "geometry", stylers: [{ color: "#ffffff" }] },
    { featureType: "water", elementType: "geometry", stylers: [{ color: "#b3e5fc" }] } // 強化原生大漢溪水體顏色
  ];

  map = new google.maps.Map(document.getElementById("map"), {
    center: { lat: 25.03, lng: 121.43 },
    zoom: 13,
    styles: mapStyle
  });

  directionsService = new DirectionsService();
  directionsRenderer = new DirectionsRenderer({
    map: map,
    suppressMarkers: true, 
    polylineOptions: { 
      strokeColor: "#00ff7f", // 螢光綠導航線
      strokeWeight: 8, 
      strokeOpacity: 0.95 
    }
  });

  // ---- 🟢 1. 流域集水區大背景 (最底層大面) ----
  basinLayer = new google.maps.Data();
  basinLayer.setMap(map);
  await loadGeoJsonSource('/xinzhuang_basin.json', basinLayer, true);
  basinLayer.setStyle({
    fillColor: "#2c3e50",
    fillOpacity: 0.08,
    strokeColor: "#7f8c8d",
    strokeWeight: 1,
    clickable: false
  });

  // ---- 🔵 2. 重點改造：將河流曲線直接拓寬為「氾濫水域範圍面（Polygon 視覺）」 ----
  realRiversLayer = new google.maps.Data();
  realRiversLayer.setMap(map);
  await loadGeoJsonSource('/xinzhuang_river_polygons.json', realRiversLayer);
  realRiversLayer.setStyle(function(feature) {
    const name = feature.getProperty("NAME") || feature.getProperty("name") || feature.getProperty("RIVER_NAME");
    let color = "#1e90ff";
    if(name === "中港大大排" || name === "中港大排") color = "#00ecc6";
    if(name === "塔寮坑溪") color = "#0984e3";
    if(name === "潭底溝") color = "#f1c40f";
    if(name === "十八份坑溪") color = "#e74c3c";
    if(name === "啞口坑溪") color = "#9b59b6";

    return {
      fillColor: color,
      fillOpacity: 0.28,
      strokeColor: color,
      strokeWeight: 4,
      strokeOpacity: 0.85,
      clickable: true
    };
  });

  realRiversLayer.addListener('click', function(event) {
    const riverName = event.feature.getProperty("NAME") || event.feature.getProperty("name") || event.feature.getProperty("RIVER_NAME") || "新莊支流";
    triggerEvacuationGuidance(event.latLng, `${riverName} 防汛範圍`);
  });

  // ---- 🟢 2A. 真實支流河道線 (LineString) ----
  realTributariesLayer = new google.maps.Data();
  realTributariesLayer.setMap(map);
  realTributariesLayer.setStyle(function(feature) {
    const name = feature.getProperty("NAME") || feature.getProperty("name") || feature.getProperty("RIVER_NAME") || "支流";
    let strokeColor = "#2980b9";
    if (name.includes("十八份坑溪")) strokeColor = "#e74c3c";
    if (name.includes("啞口坑溪")) strokeColor = "#9b59b6";
    if (name.includes("塔寮坑溪")) strokeColor = "#0984e3";
    if (name.includes("中港大大排")) strokeColor = "#00ecc6";
    if (name.includes("潭底溝")) strokeColor = "#f1c40f";

    return {
      strokeColor,
      strokeWeight: 4,
      strokeOpacity: 0.95,
      clickable: true
    };
  });

  realTributariesLayer.addListener('click', function(event) {
    const name = event.feature.getProperty("NAME") || event.feature.getProperty("name") || event.feature.getProperty("RIVER_NAME") || "支流";
    triggerEvacuationGuidance(event.latLng, `${name} 支流節點`);
  });

  await loadGeoJsonSource('/xinzhuang_real_rivers.json', realTributariesLayer, true);
  populateRiverLegend();

  // ---- � 2C. 新增：新莊五大水系標記點 ----
  riverLabelLayer = new google.maps.Data();
  riverLabelLayer.setMap(map);
  riverLabelLayer.setStyle(function(feature) {
    return {
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 8,
        fillColor: '#1e90ff',
        fillOpacity: 0.9,
        strokeColor: '#ffffff',
        strokeWeight: 2
      }
    };
  });
  await loadRiverLabelPoints('/xinzhuang_real_spots.json');
  riverLabelLayer.addListener('click', function(event) {
    const pointName = event.feature.getProperty('Name') || event.feature.getProperty('name') || event.feature.getProperty('NAME');
    const nearestName = pointName || getClosestRiverNameByPoint(event.latLng);
    showSelectedRiverInfo(event.feature, nearestName);
    if (map) {
      map.panTo(event.latLng);
      map.setZoom(14);
    }
  });
  updateSidebarPanel();

  // ---- �🟡 2B. 使用者上傳的自訂 GeoJSON (可選顯示) ----
  customGeoJsonLayer = new google.maps.Data();
  customGeoJsonLayer.setMap(map);
  customGeoJsonLayer.setStyle(function(feature) {
    const geomType = feature.getGeometry().getType();
    switch (geomType) {
      case 'Point':
        return {
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: 7,
            fillColor: '#f39c12',
            fillOpacity: 0.9,
            strokeColor: '#ffffff',
            strokeWeight: 2
          }
        };
      case 'LineString':
      case 'MultiLineString':
        return {
          strokeColor: '#f39c12',
          strokeWeight: 5,
          strokeOpacity: 0.85
        };
      default:
        return {
          fillColor: '#f39c12',
          fillOpacity: 0.2,
          strokeColor: '#d35400',
          strokeWeight: 3
        };
    }
  });

  customGeoJsonLayer.addListener('click', function(event) {
    triggerEvacuationGuidance(event.latLng, '自訂 GeoJSON 節點');
  });

  // ---- 🏡 3. 渲染官方安全避難收容所 ----
  await loadShelters('/xinzhuang_shelters.json');
  renderShelterMarkers();
  setupRainfall();
  setupStormSimulation();
  setupPlaceSearch();
  setupLocateMeButton();
  setupGeoJsonUpload();
  setupRiverJumpControls();
  document.getElementById('btn-show-river-list')?.addEventListener('click', () => setSidebarMode('rivers'));
  document.getElementById('btn-show-shelter-list')?.addEventListener('click', () => setSidebarMode('shelters'));

  // 🖱️ 點地圖任一處 → 把該點當成「受災點」起算避難路線（方便測試不同地點）
  map.addListener('click', function(event) {
    showUserLocation(event.latLng);
    triggerEvacuationGuidance(event.latLng, '測試受災點');
  });

  // =========================================================================
  // 🎛 Ext: 右側控制面板事件監聽
  // =========================================================================
  document.getElementById('chk-basin').addEventListener('change', function(e) {
    basinLayer.setMap(e.target.checked ? map : null);
  });

  document.getElementById('chk-rivers').addEventListener('change', function(e) {
    realRiversLayer.setMap(e.target.checked ? map : null);
    if(!e.target.checked && safeRouteLine) { safeRouteLine.setMap(null); safeRouteLine = null; }
  });

  document.getElementById('chk-tributaries').addEventListener('change', function(e) {
    realTributariesLayer.setMap(e.target.checked ? map : null);
  });

  document.getElementById('chk-shelters').addEventListener('change', function(e) {
    const isChecked = e.target.checked;
    shelterMarkers.forEach(marker => marker.setMap(isChecked ? map : null));
  });
}

function convertTwd97ToLatLng(x, y) {
  const a = 6378137.0;
  const b = 6356752.314245;
  const e = Math.sqrt(1 - (b * b) / (a * a));
  const e2 = e * e / (1 - e * e);
  const k0 = 0.9999;
  const dx = 250000;
  const lon0 = 121 * Math.PI / 180;

  const x0 = x - dx;
  const y0 = y;
  const M = y0 / k0;
  const mu = M / (a * (1 - e * e / 4 - 3 * Math.pow(e, 4) / 64 - 5 * Math.pow(e, 6) / 256));

  const e1 = (1 - Math.sqrt(1 - e * e)) / (1 + Math.sqrt(1 - e * e));
  const J1 = (3 * e1 / 2) - (27 * Math.pow(e1, 3) / 32);
  const J2 = (21 * Math.pow(e1, 2) / 16) - (55 * Math.pow(e1, 4) / 32);
  const J3 = (151 * Math.pow(e1, 3) / 96);
  const J4 = (1097 * Math.pow(e1, 4) / 512);

  const fp = mu + J1 * Math.sin(2 * mu) + J2 * Math.sin(4 * mu) + J3 * Math.sin(6 * mu) + J4 * Math.sin(8 * mu);
  const sinFp = Math.sin(fp);
  const cosFp = Math.cos(fp);
  const tanFp = Math.tan(fp);
  const C1 = e2 * cosFp * cosFp;
  const T1 = tanFp * tanFp;
  const N1 = a / Math.sqrt(1 - e * e * sinFp * sinFp);
  const R1 = a * (1 - e * e) / Math.pow(1 - e * e * sinFp * sinFp, 1.5);
  const D = x0 / (N1 * k0);

  const Q1 = N1 * tanFp / R1;
  const Q2 = (D * D) / 2;
  const Q3 = (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * e2) * Math.pow(D, 4) / 24;
  const Q4 = (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * e2 - 3 * C1 * C1) * Math.pow(D, 6) / 720;

  const lat = fp - Q1 * (Q2 - Q3 + Q4);

  const Q5 = D;
  const Q6 = (1 + 2 * T1 + C1) * Math.pow(D, 3) / 6;
  const Q7 = (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * e2 + 24 * T1 * T1) * Math.pow(D, 5) / 120;
  const lon = lon0 + (Q5 - Q6 + Q7) / cosFp;

  return { lat: lat * 180 / Math.PI, lng: lon * 180 / Math.PI };
}

function convertProjectedGeometry(geometry) {
  if (!geometry) return geometry;

  switch (geometry.type) {
    case 'Point': {
      const [x, y] = geometry.coordinates;
      const pos = convertTwd97ToLatLng(x, y);
      return { type: 'Point', coordinates: [pos.lng, pos.lat] };
    }
    case 'LineString':
    case 'MultiPoint':
      return {
        type: geometry.type,
        coordinates: geometry.coordinates.map(([x, y]) => {
          const pos = convertTwd97ToLatLng(x, y);
          return [pos.lng, pos.lat];
        })
      };
    case 'Polygon':
    case 'MultiLineString':
      return {
        type: geometry.type,
        coordinates: geometry.coordinates.map(ring => ring.map(([x, y]) => {
          const pos = convertTwd97ToLatLng(x, y);
          return [pos.lng, pos.lat];
        }))
      };
    case 'MultiPolygon':
      return {
        type: geometry.type,
        coordinates: geometry.coordinates.map(polygon => polygon.map(ring => ring.map(([x, y]) => {
          const pos = convertTwd97ToLatLng(x, y);
          return [pos.lng, pos.lat];
        })))
      };
    default:
      return geometry;
  }
}

async function loadProjectedGeoJson(url, dataLayer) {
  const response = await fetch(url);
  if (!response.ok) {
    console.error('載入投影 GeoJSON 失敗：', url, response.status);
    return;
  }

  const geojson = await response.json();
  const convertedGeoJson = {
    type: 'FeatureCollection',
    features: geojson.features.map(feature => ({
      type: 'Feature',
      properties: feature.properties,
      geometry: convertProjectedGeometry(feature.geometry)
    }))
  };

  dataLayer.addGeoJson(convertedGeoJson);
}

function loadGoogleMapsScript() {
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY; 
  if (!apiKey) return;
  window.initMap = initMap;
  const script = document.createElement("script");
  script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&callback=initMap`;
  script.async = true; script.defer = true;
  document.head.appendChild(script);
}

loadGoogleMapsScript();
// ================================
// ⚙️ 右側設定面板開關
// ================================

document.addEventListener("DOMContentLoaded", () => {

  const toggleBtn =
    document.getElementById("toggle-control-panel");

  const controlPanel =
    document.querySelector(".control-panel");

  if (toggleBtn && controlPanel) {

    toggleBtn.addEventListener("click", () => {

      controlPanel.classList.toggle("open");

    });

  }

});