let map;

const riverGeoJson = { /* 你的 5 條溪資料 */ };
const spots = [ /* 你的 15 個導覽點資料 */ ];

function initMap() {
  map = new google.maps.Map(document.getElementById("map"), {
    center: { lat: 25.03, lng: 121.43 },
    zoom: 13
  });

  map.data.addGeoJson(riverGeoJson);
  map.data.setStyle(feature => {
    const name = feature.getProperty("name");
    let color = "blue";
    if(name==="中港大排") color="#1e90ff";
    if(name==="塔寮坑溪") color="#00b894";
    if(name==="潭底溝") color="#fdcb6e";
    if(name==="十八份坑溪") color="#e17055";
    if(name==="啞口坑溪") color="#6c5ce7";
    return { strokeColor: color, strokeWeight: 4 };
  });

  spots.forEach(s => {
    const marker = new google.maps.Marker({ position: {lat:s.lat, lng:s.lng}, map, title: s.name });
    const info = new google.maps.InfoWindow({
      content: `
        <div>
          <div class="info-title">${s.name}</div>
          <p>${s.desc}</p>
          <button onclick="window.openStreet(${s.lat},${s.lng})">看街景</button>
        </div>`
    });
    marker.addListener("click", () => info.open(map, marker));
  });
}

window.openStreet = function(lat, lng) {
  window.open(`https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng}`);
};

// ⚡ 動態讀取環境變數並注入 Script
function loadGoogleMaps() {
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
  
  if (!apiKey) {
    console.error("錯誤：找不到 VITE_GOOGLE_MAPS_API_KEY，請確認 .env 檔案是否存在。");
    return;
  }

  window.initMap = initMap; // 將 initMap 綁定到全域以便 API 回呼
  const script = document.createElement("script");
  script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&callback=initMap`;
  script.async = true;
  script.defer = true;
  document.head.appendChild(script);
}

loadGoogleMaps();