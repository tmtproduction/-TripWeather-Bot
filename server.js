require("dotenv").config();
const express = require("express");
const { Client, middleware } = require("@line/bot-sdk");
const axios = require("axios");
const path = require("path");

const app = express();

// ─── Line Client ───────────────────────────────────────────────
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new Client(lineConfig);

// ─── In-memory store ──────────────────────────────────────────
// trips[tripCode].origin / .destination = { name, lat, lon }
// trips[tripCode].waypoints = [{ name, lat, lon }]
const trips = {};
const sessions = {};
const districtCache = {};  // userId -> { district, sentAt }

// ─── Static files (LIFF pages) ────────────────────────────────
app.use("/liff", express.static(path.join(__dirname, "liff")));

// ─── Line Webhook ─────────────────────────────────────────────
app.post("/webhook", middleware(lineConfig), async (req, res) => {
  res.sendStatus(200);
  for (const event of req.body.events || []) {
    try { await handleEvent(event); }
    catch (e) { console.error("Event error:", e.message); }
  }
});

async function handleEvent(event) {
  if (event.type === "join") {
    const groupId = event.source.groupId;
    console.log("Bot joined group:", groupId);
    await client.pushMessage(groupId, {
      type: "text",
      text: `สวัสดีครับ TripWeather Bot พร้อมแล้ว!\n\nสร้าง trip ได้ที่:\n${process.env.BASE_URL}/liff/setup.html?liffId=${process.env.LIFF_ID}&groupId=${groupId}`,
    });
  }

  if (event.type === "message" && event.message.type === "text") {
    const text = event.message.text.trim().toUpperCase();
    const userId = event.source.userId;

    if (text === "STOP" || text === "หยุด") {
      delete sessions[userId];
      delete districtCache[userId];
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "หยุดติดตาม GPS แล้วครับ ขอบคุณที่ใช้งาน TripWeather!",
      });
    }
  }
}

// ─── Config API (ส่ง public keys ให้ frontend) ────────────────
app.get("/api/config", (req, res) => {
  res.json({ mapsKey: process.env.GOOGLE_MAPS_KEY || "" });
});

// ─── GPS Webhook จาก LIFF ─────────────────────────────────────
app.use(express.json());

app.post("/api/location", async (req, res) => {
  const { userId, groupId, tripCode, carId, lat, lon } = req.body;
  if (!userId || !lat || !lon || !groupId) {
    return res.status(400).json({ error: "missing fields" });
  }

  try {
    // 1. Reverse geocode → หาชื่ออำเภอ
    const district = await getDistrict(lat, lon);
    if (!district) return res.json({ status: "no_district" });

    // 2. Dedup: ถ้ายังอยู่อำเภอเดิม ข้ามได้เลย
    const prev = districtCache[userId];
    const now  = Date.now();
    if (prev && prev.district === district) {
      return res.json({ status: "same_district", district });
    }

    // 3. เช็คว่ามีคันอื่นยิงอำเภอเดียวกันภายใน 3 นาทีไหม
    const trip = trips[tripCode];
    if (trip) {
      const recentOther = Object.entries(districtCache).find(([uid, data]) =>
        uid !== userId &&
        data.district === district &&
        now - data.sentAt < 3 * 60 * 1000
      );

      if (recentOther) {
        districtCache[userId] = { district, sentAt: now };
        const minutesDiff = Math.round((now - recentOther[1].sentAt) / 60000);
        const carName = getCarName(tripCode, userId);
        await client.pushMessage(groupId, buildPillMessage(carName, district, minutesDiff));
        return res.json({ status: "pill_sent", district });
      }
    }

    // 4. ส่ง Flex Message เต็ม
    districtCache[userId] = { district, sentAt: now };
    const carName = getCarName(tripCode, userId);

    const [weather, traffic] = await Promise.all([
      getWeather(lat, lon),
      getTrafficAhead(lat, lon, trip),
    ]);

    await client.pushMessage(groupId, buildFullFlexMessage(carName, district, weather, traffic));
    res.json({ status: "full_sent", district });

  } catch (e) {
    console.error("Location error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Trip Management API ───────────────────────────────────────

// สร้าง Trip
// รับ origin / destination เป็น { name, lat, lon }
// รับ waypoints เป็น [{ name, lat, lon }]
app.post("/api/trip/create", async (req, res) => {
  const { userId, groupId, origin, waypoints, destination } = req.body;
  const tripCode = "TRP-" + Math.random().toString(36).substring(2, 6).toUpperCase();

  // Normalize: รองรับทั้ง string เก่า และ object ใหม่
  const normPlace = (p) =>
    typeof p === "string" ? { name: p, lat: null, lon: null } : p;

  trips[tripCode] = {
    tripCode,
    groupId,
    createdBy: userId,
    origin: normPlace(origin),
    waypoints: (waypoints || []).map(normPlace),
    destination: normPlace(destination),
    cars: {
      A: { members: [userId], name: "คัน A" },
      B: { members: [], name: "คัน B" },
    },
    createdAt: Date.now(),
  };

  sessions[userId] = { tripCode, carId: "A" };
  res.json({ tripCode, trip: trips[tripCode] });
});

// Join Trip
app.post("/api/trip/join", async (req, res) => {
  const { userId, tripCode, carId } = req.body;
  const trip = trips[tripCode];
  if (!trip) return res.status(404).json({ error: "ไม่พบ Trip นี้" });

  if (!trip.cars[carId]) trip.cars[carId] = { members: [], name: `คัน ${carId}` };
  if (!trip.cars[carId].members.includes(userId)) {
    trip.cars[carId].members.push(userId);
  }
  sessions[userId] = { tripCode, carId };
  res.json({ status: "joined", trip });
});

// ดึงข้อมูล Trip
app.get("/api/trip/:code", (req, res) => {
  const trip = trips[req.params.code];
  if (!trip) return res.status(404).json({ error: "ไม่พบ Trip" });
  res.json(trip);
});

// ─── Helper: Reverse Geocode → อำเภอ ─────────────────────────
async function getDistrict(lat, lon) {
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&accept-language=th`;
  const resp = await axios.get(url, {
    headers: { "User-Agent": "TripWeatherBot/1.0" },
  });
  const addr = resp.data.address || {};
  return addr.county || addr.city_district || addr.suburb || addr.city || null;
}

// ─── Helper: อากาศ (Open-Meteo ฟรี) ──────────────────────────
async function getWeather(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,precipitation_probability,windspeed_10m,uv_index&timezone=Asia%2FBangkok`;
  const resp = await axios.get(url);
  const c = resp.data.current || {};
  return {
    temp: Math.round(c.temperature_2m || 0),
    rain: Math.round(c.precipitation_probability || 0),
    wind: Math.round(c.windspeed_10m || 0),
    uv:   Math.round(c.uv_index || 0),
  };
}

// ─── Helper: ETA ถึงปลายทาง (OSRM ฟรี) ──────────────────────
// trip.destination ต้องเป็น { name, lat, lon }
async function getTrafficAhead(lat, lon, trip) {
  if (!trip || !trip.destination) return null;
  const dest = trip.destination;
  if (!dest.lat || !dest.lon) return null;   // ยังไม่มีพิกัด (legacy string)
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${lon},${lat};${dest.lon},${dest.lat}?overview=false`;
    const resp = await axios.get(url);
    const route = resp.data.routes?.[0];
    if (!route) return null;
    return {
      distKm:  Math.round(route.distance / 1000),
      durMin:  Math.round(route.duration  / 60),
      destName: dest.name || "ปลายทาง",
    };
  } catch {
    return null;
  }
}

// ─── Helper: ชื่อคันรถ ────────────────────────────────────────
function getCarName(tripCode, userId) {
  const trip = trips[tripCode];
  if (!trip) return "รถ";
  for (const [, car] of Object.entries(trip.cars)) {
    if (car.members.includes(userId)) return car.name;
  }
  return "รถ";
}

// ─── Builder: Flex Message เต็ม ───────────────────────────────
function buildFullFlexMessage(carName, district, weather, traffic) {
  const rainBadge = weather.rain < 20
    ? { color: "#0F6E56", bg: "#E1F5EE", text: "ไม่มี" }
    : weather.rain < 50
    ? { color: "#633806", bg: "#FAEEDA", text: "มีบ้าง" }
    : { color: "#791F1F", bg: "#FCEBEB", text: "ตกแน่" };

  const uvBadge = weather.uv <= 5
    ? { color: "#0F6E56", bg: "#E1F5EE", text: "ปกติ" }
    : weather.uv <= 7
    ? { color: "#633806", bg: "#FAEEDA", text: "สูง" }
    : { color: "#791F1F", bg: "#FCEBEB", text: "สูงมาก" };

  const headerColor = weather.rain >= 50 ? "#854F0B" : "#185FA5";

  // ETA block
  const trafficContents = traffic
    ? [
        { type: "separator", margin: "sm" },
        {
          type: "box", layout: "vertical",
          backgroundColor: "#FFF8E6", cornerRadius: "6px",
          paddingAll: "8px", margin: "sm",
          contents: [
            {
              type: "text",
              text: `ถึง ${traffic.destName}`,
              size: "xs", weight: "bold", color: "#633806",
            },
            {
              type: "text",
              text: `เหลือ ~${traffic.distKm} กม. · ~${traffic.durMin} นาที`,
              size: "xs", color: "#3a2800", margin: "xs",
            },
          ],
        },
      ]
    : [];

  return {
    type: "flex",
    altText: `${carName} เข้า ${district} · ${weather.temp}°C ฝน ${weather.rain}%`,
    contents: {
      type: "bubble",
      header: {
        type: "box", layout: "vertical",
        backgroundColor: headerColor, paddingAll: "12px",
        contents: [
          { type: "text", text: `เข้า ${district}`, weight: "bold", color: "#ffffff", size: "md" },
          { type: "text", text: `${carName} · ${new Date().toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" })} น.`, color: "#ffffffb3", size: "xs", margin: "xs" },
        ],
      },
      body: {
        type: "box", layout: "vertical", paddingAll: "12px", spacing: "sm",
        contents: [
          {
            type: "box", layout: "horizontal", spacing: "md",
            contents: [
              {
                type: "box", layout: "vertical", flex: 1,
                backgroundColor: "#f8f8f8", cornerRadius: "8px", paddingAll: "8px",
                contents: [
                  { type: "text", text: "อุณหภูมิ", size: "xxs", color: "#888888" },
                  { type: "text", text: `${weather.temp}°C`, size: "lg", weight: "bold", color: "#1a1a1a" },
                ],
              },
              {
                type: "box", layout: "vertical", flex: 1,
                backgroundColor: "#f8f8f8", cornerRadius: "8px", paddingAll: "8px",
                contents: [
                  { type: "text", text: "ลม", size: "xxs", color: "#888888" },
                  { type: "text", text: `${weather.wind} กม/ช`, size: "sm", weight: "bold", color: "#1a1a1a" },
                ],
              },
            ],
          },
          {
            type: "box", layout: "horizontal", spacing: "md",
            contents: [
              {
                type: "box", layout: "vertical", flex: 1,
                backgroundColor: rainBadge.bg, cornerRadius: "8px", paddingAll: "8px",
                contents: [
                  { type: "text", text: "ฝน", size: "xxs", color: rainBadge.color },
                  { type: "text", text: `${weather.rain}%`, size: "lg", weight: "bold", color: rainBadge.color },
                  { type: "text", text: rainBadge.text, size: "xxs", color: rainBadge.color },
                ],
              },
              {
                type: "box", layout: "vertical", flex: 1,
                backgroundColor: uvBadge.bg, cornerRadius: "8px", paddingAll: "8px",
                contents: [
                  { type: "text", text: "UV Index", size: "xxs", color: uvBadge.color },
                  { type: "text", text: `${weather.uv}`, size: "lg", weight: "bold", color: uvBadge.color },
                  { type: "text", text: uvBadge.text, size: "xxs", color: uvBadge.color },
                ],
              },
            ],
          },
          ...trafficContents,
        ],
      },
    },
  };
}

// ─── Builder: Pill สั้น (คันที่ 2) ────────────────────────────
function buildPillMessage(carName, district, minutesDiff) {
  return {
    type: "flex",
    altText: `${carName} เข้า ${district} แล้วครับ`,
    contents: {
      type: "bubble", size: "kilo",
      body: {
        type: "box", layout: "horizontal",
        paddingAll: "12px", spacing: "md", alignItems: "center",
        contents: [
          {
            type: "box", layout: "vertical", width: "36px",
            backgroundColor: "#E1F5EE", cornerRadius: "18px",
            paddingAll: "8px", alignItems: "center",
            contents: [{ type: "text", text: "🚗", size: "md", align: "center" }],
          },
          {
            type: "box", layout: "vertical", flex: 1,
            contents: [
              { type: "text", text: `${carName} เข้า ${district} แล้วครับ`, size: "sm", weight: "bold", color: "#1a1a1a", wrap: true },
              { type: "text", text: minutesDiff > 0 ? `ห่างคันแรก ~${minutesDiff} นาที` : "เกือบพร้อมกัน", size: "xs", color: "#888888", margin: "xs" },
            ],
          },
        ],
      },
    },
  };
}

// ─── Start ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`TripWeather Bot running on port ${PORT}`));
