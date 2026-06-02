let map;

// 🌊 五條溪 GeoJSON（純 JS 物件，開頭千萬不能有 <script>）
const riverGeoJson = {
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": { "name": "中港大排" },
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [121.4475, 25.0368],
          [121.4498, 25.0340],
          [121.4525, 25.0310]
        ]
      }
    },
    {
      "type": "Feature",
      "properties": { "name": "塔寮坑溪" },
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [121.4145, 25.0220],
          [121.4190, 25.0245],
          [121.4250, 25.0280]
        ]
      }
    },
    {
      "type": "Feature",
      "properties": { "name": "潭底溝" },
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [121.4270, 25.0190],
          [121.4300, 25.0210],
          [121.4330, 25.0230]
        ]
      }
    },
    {
      "type": "Feature",
      "properties": { "name": "十八份坑溪" },
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [121.4075, 25.0165],
          [121.4110, 25.0190],
          [121.4150, 25.0215]
        ]
      }
    },
    {
      "type": "Feature",
      "properties": { "name": "啞口坑溪" },
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [121.4015, 25.0140],
          [121.4050, 25.0160],
          [121.4090, 25.0185]
        ]
      }
    }
  ]
};

// 📍 導覽點（15個）
const spots = [
  {name:"中港大排親水步道",lat:25.0352,lng:121.4498,river:"中港大排",desc:"都市親水空間"},
  {name:"中港大排滯洪公園",lat:25.0336,lng:121.4512,river:"中港大排",desc:"防洪滯洪設施"},
  {name:"中港大排出口",lat:25.0318,lng:121.4525,river:"中港大排",desc:"匯入大漢溪"},
  {name:"塔寮坑溪山坡段",lat:25.0224,lng:121.4156,river:"塔寮坑溪",desc:"坡地逕流快速"},
  {name:"塔寮坑溪都市段",lat:25.0251,lng:121.4198,river:"塔寮坑溪",desc:"都市化流域"},
  {name:"塔寮坑溪匯流口",lat:25.0280,lng:121.4240,river:"塔寮坑溪",desc:"進入主河道"},
  {name:"潭底溝上游",lat:25.0196,lng:121.4275,river:"潭底溝",desc:"住宅排水"},
  {name:"潭底溝淤積區",lat:25.0208,lng:121.4301,river:"潭底溝",desc:"排水瓶頸"},
  {name:"潭底溝轉折點",lat:25.0220,lng:121.4323,river:"潭底溝",desc:"水理限制"},
  {name:"十八份坑溪坡地",lat:25.0172,lng:121.4089,river:"十八份坑溪",desc:"土砂輸出"},
  {name:"十八份坑溪聚落",lat:25.0190,lng:121.4115,river:"十八份坑溪",desc:"土地利用混合"},
  {name:"十八份坑溪匯流",lat:25.0210,lng:121.4148,river:"十八份坑溪",desc:"支流匯入"},
  {name:"啞口坑溪源頭",lat:25.0145,lng:121.4023,river:"啞口坑溪",desc:"山區逕流"},
  {name:"啞口坑溪道路段",lat:25.0160,lng:121.4058,river:"啞口坑溪",desc:"排水交會"},
  {name:"啞口坑溪下游",lat:25.0183,lng:121.4099,river:"啞口坑溪",desc:"匯入塔寮坑溪"}
];

function initMap() {
  map = new google.maps.Map(document.getElementById("map"), {
    center: { lat: 25.03, lng: 121.43 },
    zoom: 13
  });

  // 🌊 畫河川
  map.data.addGeoJson(riverGeoJson);

  map.data.setStyle(function(feature) {
    const name = feature.getProperty("name");
    let color = "blue";
    if(name==="中港大排") color="#1e90ff";
    if(name==="塔寮坑溪") color="#00b894";
    if(name==="潭底溝") color="#fdcb6e";
    if(name==="十八份坑溪") color="#e17055";
    if(name==="啞口坑溪") color="#6c5ce7";

    return { strokeColor: color, strokeWeight: 4 };
  });

  // 📍 導覽點
  spots.forEach(s => {
    const marker = new google.maps.Marker({
      position: {lat:s.lat,lng:s.lng},
      map,
      title: s.name
    });

    const info = new google.maps.InfoWindow({
      content: `
        <div>
          <div class="info-title">${s.name}</div>
          <p>${s.desc}</p>
          <button onclick="window.openStreet(${s.lat},${s.lng})">看街景</button>
        </div>
      `
    });

    marker.addListener("click", ()=>info.open(map,marker));
  });
}

// 修正後的街景開啟 function
window.openStreet = function(lat, lng){
  window.open(`https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng}`);
};

// ⚡ 動態從環境變數載入 Google Maps Script
function loadGoogleMapsScript() {
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY; 
  
  if (!apiKey) {
    console.error("找不到 Google Maps API Key，請檢查 .env 檔案設定。");
    return;
  }

  window.initMap = initMap;

  const script = document.createElement("script");
  script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&callback=initMap`;
  script.async = true;
  script.defer = true;
  document.head.appendChild(script);
}

loadGoogleMapsScript(); // 👈 結尾乾淨，絕對不能有 </script>