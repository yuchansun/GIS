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
  const suitableShelters = getFloodSuitableShelters();
  if (!suitableShelters.length) {
    alert('目前無符合淹水適用的避難所資料，請稍後再試。');
    return;
  }

  let nearestShelter = suitableShelters[0];
  let minDistance = Infinity;

  suitableShelters.forEach(shelter => {
    const dist = Math.pow(originLatLng.lat() - shelter.lat, 2) + Math.pow(originLatLng.lng() - shelter.lng, 2);
    if (dist < minDistance) {
      minDistance = dist;
      nearestShelter = shelter;
    }
  });

  const request = {
    origin: originLatLng,
    destination: { lat: nearestShelter.lat, lng: nearestShelter.lng },
    travelMode: google.maps.TravelMode.WALKING
  };

  directionsService.route(request, function(result, status) {
    if (status === google.maps.DirectionsStatus.OK) {
      directionsRenderer.setDirections(result);
      
      const evapBox = document.getElementById("evacuation-box");
      const originText = document.getElementById("origin-spot-name");
      const targetText = document.getElementById("target-shelter-name");
      const distanceText = document.getElementById("walk-distance");
      const timeText = document.getElementById("walk-time");

      if (evapBox) {
        evapBox.style.display = "block";
        if (originText) originText.innerText = originName;
        if (targetText) targetText.innerText = nearestShelter.name;
        if (distanceText) distanceText.innerText = result.routes[0].legs[0].distance.text;
        if (timeText) timeText.innerText = result.routes[0].legs[0].duration.text;
      }
    }
  });
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
      lat,
      lng,
      suit_for_f: feature.properties?.suit_for_f || feature.properties?.suit_for_F || ''
    };
  }).filter(isFloodSuitableShelter);
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
  setupLocateMeButton();
  setupGeoJsonUpload();
  setupRiverJumpControls();
  document.getElementById('btn-show-river-list')?.addEventListener('click', () => setSidebarMode('rivers'));
  document.getElementById('btn-show-shelter-list')?.addEventListener('click', () => setSidebarMode('shelters'));

  // =========================================================================
  // 🎛 Ext: 右側控制面板事件監聽
  // =========================================================================
  document.getElementById('chk-basin').addEventListener('change', function(e) {
    basinLayer.setMap(e.target.checked ? map : null);
  });

  document.getElementById('chk-rivers').addEventListener('change', function(e) {
    realRiversLayer.setMap(e.target.checked ? map : null);
    if(!e.target.checked) directionsRenderer.setDirections({ routes: [] });
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