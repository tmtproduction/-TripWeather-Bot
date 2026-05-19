require("dotenv").config();
const express = require("express");
const { Client, middleware } = require("@line/bot-sdk");
const axios = require("axios");
const { Redis } = require("@upstash/redis");
const path = require("path");

const app = express();

// ─── LINE Client ───────────────────────────────────────────────
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new Client(lineConfig);

// ─── Upstash Redis ─────────────────────────────────────────────
// Key schema:
//   trip:{tripCode}               → trip object          TTL 24h
//   sess:{userId}                 → {tripCode, carId}    TTL 24h
//   dist:{userId}                 → {district, sentAt}   TTL 2h
//   recent:{tripCode}:{district}  → {userId, sentAt}     TTL 3min
//   gps:{userId}                  → {lat,lon,district,updatedAt} TTL 4h
//   group:{groupId}               → tripCode             TTL 24h
const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const TTL_TRIP    = 60 * 60 * 24;
const TTL_SESSION = 60 * 60 * 24;
const TTL_DIST    = 60 * 60 * 2;
const TTL_RECENT  = 60 * 3;
const TTL_GPS     = 60 * 60 * 4;
const TTL_GROUP   = 60 * 60 * 24;

const getTrip      = (code)          => redis.get(`trip:${code}`);
const setTrip      = (code, v)       => redis.set(`trip:${code}`, v,    { ex: TTL_TRIP });
const getSession   = (uid)           => redis.get(`sess:${uid}`);
const setSession   = (uid, v)        => redis.set(`sess:${uid}`, v,     { ex: TTL_SESSION });
const delSession   = (uid)           => redis.del(`sess:${uid}`);
const getDist      = (uid)           => redis.get(`dist:${uid}`);
const setDist      = (uid, v)        => redis.set(`dist:${uid}`, v,     { ex: TTL_DIST });
const delDist      = (uid)           => redis.del(`dist:${uid}`);
const getRecent    = (code, d)       => redis.get(`recent:${code}:${d}`);
const setRecent    = (code, d, v)    => redis.set(`recent:${code}:${d}`, v, { ex: TTL_RECENT });
const getGps       = (uid)           => redis.get(`gps:${uid}`);
const setGps       = (uid, v)        => redis.set(`gps:${uid}`, v,     { ex: TTL_GPS });
const delGps       = (uid)           => redis.del(`gps:${uid}`);
const getGroupTrip = (gid)           => redis.get(`group:${gid}`);
const setGroupTrip = (gid, code)     => redis.set(`group:${gid}`, code, { ex: TTL_GROUP });

// ─── Static files ──────────────────────────────────────────────
app.use("/liff", express.static(path.join(__dirname, "liff")));

// ─── LINE Webhook (ต้องอยู่ก่อน express.json() เสมอ) ──────────
// express.json() จะทำให้ LINE middleware อ่าน raw body ไม่ได้
// ส่งผล SignatureValidationFailed
app.post("/webhook", middleware(lineConfig), async (req, res) => {
  res.sendStatus(200);
  for (const event of req.body.events || []) {
    try { await handleEvent(event); }
    catch (e) { console.error("Event error:", e.message); }
  }
});

async function handleEvent(event) {
  // DEBUG LOG — ลบออกหลังได้ groupId แล้ว
  console.log("[EVENT]", JSON.stringify({
    type:    event.type,
    groupId: event.source?.groupId,
    userId:  event.source?.userId,
    text:    event.message?.text,
  }));

  if (event.type === "join") {
    const groupId = event.source.groupId;
    await client.pushMessage(groupId, {
      type: "text",
      text: `สวัสดีครับ TripWeather Bot พร้อมแล้ว!\n\nสร้าง trip ได้ที่:\n${process.env.BASE_URL}/liff/setup.html?liffId=${process.env.LIFF_ID}&groupId=${groupId}`,
    });
  }

  if (event.type === "message" && event.message.type === "text") {
    const text    = event.message.text.trim();
    const textUP  = text.toUpperCase();
    const userId  = event.source.userId;
    const groupId = event.source.groupId;

    // หยุดติดตาม
    if (textUP === "STOP" || text === "หยุด") {
      await Promise.all([delSession(userId), delDist(userId), delGps(userId)]);
      return client.replyMessage(event.replyToken, {
        type: "text", text: "หยุดติดตาม GPS แล้วครับ ขอบคุณที่ใช้งาน TripWeather!",
      });
    }

    // ดูสถานะ
    if (textUP === "STATUS" || text === "สถานะ") {
      return handleStatusCommand(groupId, event.replyToken);
    }
  }
}

// ─── Status Command ────────────────────────────────────────────
async function handleStatusCommand(groupId, replyToken) {
  if (!groupId) return;

  const tripCode = await getGroupTrip(groupId);
  if (!tripCode) {
    return client.replyMessage(replyToken, {
      type: "text", text: "ยังไม่มี Trip ที่กำลังดำเนินการในกลุ่มนี้ครับ\n\nสร้าง trip ได้ที่:\n" +
        `${process.env.BASE_URL}/liff/setup.html?liffId=${process.env.LIFF_ID}&groupId=${groupId}`,
    });
  }

  const trip = await getTrip(tripCode);
  if (!trip) {
    return client.replyMessage(replyToken, {
      type: "text", text: "ไม่พบข้อมูล Trip ครับ (อาจหมดอายุแล้ว)",
    });
  }

  // ดึงข้อมูลแต่ละคัน
  const carEntries = Object.entries(trip.cars || {});
  const carInfo = {};
  for (const [carId, car] of carEntries) {
    let latestDist = null, latestGps = null, latestAt = 0;
    for (const uid of (car.members || [])) {
      const [d, g] = await Promise.all([getDist(uid), getGps(uid)]);
      if (d && (d.sentAt || 0) > latestAt) {
        latestDist = d; latestAt = d.sentAt || 0;
      }
      if (g && (g.updatedAt || 0) > latestAt) {
        latestGps = g;
      }
    }
    carInfo[carId] = { ...car, dist: latestDist, gps: latestGps };
  }

  const gap = await calcCarGap(trip);
  return client.replyMessage(replyToken, buildStatusFlexMessage(trip, carInfo, gap));
}

// ─── Config API ────────────────────────────────────────────────
// express.json() ต้องอยู่หลัง webhook route เท่านั้น
app.use(express.json());

app.get("/api/config", (req, res) => {
  res.json({ mapsKey: process.env.GOOGLE_MAPS_KEY || "" });
});

// ─── GPS Webhook ───────────────────────────────────────────────
app.post("/api/location", async (req, res) => {
  const { userId, groupId, tripCode, carId, lat, lon } = req.body;
  if (!userId || !lat || !lon || !groupId) {
    return res.status(400).json({ error: "missing fields" });
  }

  try {
    const district = await getDistrict(lat, lon);
    if (!district) return res.json({ status: "no_district" });

    const now = Date.now();

    // บันทึก GPS ล่าสุด
    await setGps(userId, { lat, lon, district, updatedAt: now });

    // Dedup: ยังอยู่อำเภอเดิม
    const prevDist = await getDist(userId);
    if (prevDist?.district === district) {
      return res.json({ status: "same_district", district });
    }

    const trip = await getTrip(tripCode);
    const recentEntry = tripCode ? await getRecent(tripCode, district) : null;

    // คันอื่นในกลุ่มเดียวกันยิงอำเภอนี้ไปแล้วภายใน 3 นาที
    if (recentEntry && recentEntry.userId !== userId) {
      await setDist(userId, { district, sentAt: now });
      const minutesDiff = Math.round((now - recentEntry.sentAt) / 60000);
      const carName = getCarName(trip, userId);
      const gap = await calcCarGap(trip);
      await client.pushMessage(groupId, buildPillMessage(carName, district, minutesDiff, gap));
      return res.json({ status: "pill_sent", district });
    }

    // ส่ง Flex Message เต็ม
    await Promise.all([
      setDist(userId, { district, sentAt: now }),
      tripCode ? setRecent(tripCode, district, { userId, sentAt: now }) : Promise.resolve(),
    ]);

    const carName = getCarName(trip, userId);
    const [weather, traffic, gap] = await Promise.all([
      getWeather(lat, lon),
      getTrafficAhead(lat, lon, trip),
      calcCarGap(trip),
    ]);

    await client.pushMessage(groupId, buildFullFlexMessage(carName, district, weather, traffic, gap));
    res.json({ status: "full_sent", district });

  } catch (e) {
    console.error("Location error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Trip Management API ───────────────────────────────────────

// สร้าง Trip
app.post("/api/trip/create", async (req, res) => {
  const { userId, groupId, origin, waypoints, destination } = req.body;
  const tripCode = "TRP-" + Math.random().toString(36).substring(2, 6).toUpperCase();
  const normPlace = (p) => typeof p === "string" ? { name: p, lat: null, lon: null } : (p || null);

  const trip = {
    tripCode, groupId, createdBy: userId,
    origin:      normPlace(origin),
    waypoints:   (waypoints || []).map(normPlace),
    destination: normPlace(destination),
    cars: {
      A: { members: [userId], name: "คัน A" },
      B: { members: [],       name: "คัน B" },
    },
    createdAt: Date.now(),
  };

  await Promise.all([
    setTrip(tripCode, trip),
    setSession(userId, { tripCode, carId: "A" }),
    groupId ? setGroupTrip(groupId, tripCode) : Promise.resolve(),
  ]);

  res.json({ tripCode, trip });

  // ส่ง LINE แจ้งกลุ่ม (background — ไม่รอ)
  if (groupId) {
    calcRouteDistance(trip)
      .then(route => client.pushMessage(groupId, buildTripCreatedMessage(trip, route)))
      .catch(e => console.warn("Trip created message failed:", e.message));
  }
});

// Join Trip
app.post("/api/trip/join", async (req, res) => {
  const { userId, tripCode, carId } = req.body;
  const trip = await getTrip(tripCode);
  if (!trip) return res.status(404).json({ error: "ไม่พบ Trip นี้" });

  if (!trip.cars[carId]) trip.cars[carId] = { members: [], name: `คัน ${carId}` };
  if (!trip.cars[carId].members.includes(userId)) trip.cars[carId].members.push(userId);

  await Promise.all([
    setTrip(tripCode, trip),
    setSession(userId, { tripCode, carId }),
  ]);
  res.json({ status: "joined", trip });
});

// ดึงข้อมูล Trip
app.get("/api/trip/:code", async (req, res) => {
  const trip = await getTrip(req.params.code);
  if (!trip) return res.status(404).json({ error: "ไม่พบ Trip" });
  res.json(trip);
});

// รายการ Trip ของกลุ่ม (สำหรับ join screen — ไม่มี userId)
app.get("/api/trips/public", async (req, res) => {
  const { groupId } = req.query;
  try {
    // SCAN หา trip ทั้งหมด แล้วกรองตาม groupId
    let allKeys = [], cursor = 0;
    do {
      const [nc, keys] = await redis.scan(cursor, { match: "trip:*", count: 100 });
      cursor = Number(nc);
      allKeys = allKeys.concat(keys);
    } while (cursor !== 0);

    const results = await Promise.all(allKeys.map(k => redis.get(k)));
    const trips   = results.filter(t => t && (!groupId || t.groupId === groupId))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, 10)  // สูงสุด 10 trip
      .map(t => ({
        tripCode:     t.tripCode,
        originName:   t.origin?.name      ?? t.origin      ?? '?',
        destName:     t.destination?.name ?? t.destination ?? '?',
        waypointCount: (t.waypoints || []).length,
        createdAt:    t.createdAt,
        carsInfo: Object.fromEntries(
          Object.entries(t.cars || {}).map(([id, car]) => [id, car.members.length])
        ),
      }));

    res.json(trips);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// เช็คระยะห่างระหว่างคัน (เรียกจาก tracker)
app.post("/api/trip/:code/gap", async (req, res) => {
  const { userId, lat, lon, notifyLine } = req.body;
  const trip = await getTrip(req.params.code);
  if (!trip) return res.status(404).json({ error: "ไม่พบ Trip" });

  // อัปเดต GPS ของ user นี้ก่อน
  if (userId && lat && lon) {
    await setGps(userId, { lat, lon, updatedAt: Date.now() });
  }

  const gap = await calcCarGap(trip);
  if (!gap) return res.json({ status: "no_data", message: "ยังไม่มีข้อมูล GPS ของอีกคัน" });

  // ส่งแจ้ง LINE ถ้าขอ
  if (notifyLine && trip.groupId) {
    const carA = Object.entries(trip.cars).find(([id]) => id === 'A')?.[1];
    const carB = Object.entries(trip.cars).find(([id]) => id === 'B')?.[1];
    await client.pushMessage(trip.groupId, buildGapMessage(
      carA?.name || 'คัน A', gap.distA,
      carB?.name || 'คัน B', gap.distB,
      gap.distKm
    ));
  }

  res.json({ status: "ok", gap });
});

// ─── Admin API ─────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const key = req.query.key || req.headers['x-admin-key'];
  if (!process.env.ADMIN_SECRET || key !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  next();
}

app.get('/api/admin/trips', adminAuth, async (req, res) => {
  try {
    let allKeys = [], cursor = 0;
    do {
      const [nc, keys] = await redis.scan(cursor, { match: 'trip:*', count: 100 });
      cursor = Number(nc); allKeys = allKeys.concat(keys);
    } while (cursor !== 0);
    if (!allKeys.length) return res.json([]);
    const results = await Promise.all(allKeys.map(k => redis.get(k)));
    res.json(results.filter(Boolean).sort((a, b) => (b.createdAt||0) - (a.createdAt||0)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/trip/:code', adminAuth, async (req, res) => {
  await redis.del(`trip:${req.params.code}`);
  res.json({ status: 'deleted' });
});

// ─── Helpers ───────────────────────────────────────────────────

async function calcRouteDistance(trip) {
  try {
    const points = [
      trip.origin,
      ...(trip.waypoints || []),
      trip.destination,
    ].filter(p => p?.lat && p?.lon);

    if (points.length < 2) return null;

    const coords = points.map(p => `${p.lon},${p.lat}`).join(';');
    const resp   = await axios.get(
      `https://router.project-osrm.org/route/v1/driving/${coords}?overview=false`,
      { timeout: 6000 }
    );
    const route = resp.data.routes?.[0];
    if (!route) return null;

    return {
      distKm: Math.round(route.distance / 1000),
      durMin: Math.round(route.duration  / 60),
    };
  } catch { return null; }
}

// Cache reverse geocode (~1.1km grid, 30 นาที)
const geocodeCache = new Map();

async function getDistrict(lat, lon) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  if (geocodeCache.has(key)) return geocodeCache.get(key);

  let result = null;

  // ── 1. ลอง Google Maps Geocoding API ก่อน (ถ้ามี key) ─────────
  if (process.env.GOOGLE_MAPS_KEY) {
    try {
      const resp = await axios.get(
        `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lon}&language=th&result_type=administrative_area_level_2|locality&key=${process.env.GOOGLE_MAPS_KEY}`,
        { timeout: 6000 }
      );
      const results = resp.data.results || [];
      for (const r of results) {
        for (const comp of (r.address_components || [])) {
          if (comp.types.includes("administrative_area_level_2") ||
              comp.types.includes("locality")) {
            result = comp.long_name;
            break;
          }
        }
        if (result) break;
      }
    } catch (e) {
      console.warn("Google Geocode error:", e.message);
    }
  }

  // ── 2. Fallback: Nominatim (ถ้า Google ไม่มี / ล้มเหลว) ───────
  if (!result) {
    try {
      await new Promise(r => setTimeout(r, 1100));
      const resp = await axios.get(
        `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&accept-language=th`,
        {
          headers: { "User-Agent": "TripWeatherBot/1.0 (tripweather-bot.onrender.com)" },
          timeout: 8000,
        }
      );
      const addr = resp.data.address || {};
      result = addr.county || addr.city_district || addr.suburb || addr.city || null;
    } catch (e) {
      console.error("Nominatim error:", e.message);
    }
  }

  if (result) {
    geocodeCache.set(key, result);
    setTimeout(() => geocodeCache.delete(key), 30 * 60 * 1000);
  }
  return result;
}

async function getWeather(lat, lon) {
  const resp = await axios.get(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,precipitation_probability,windspeed_10m,uv_index&timezone=Asia%2FBangkok`
  );
  const c = resp.data.current || {};
  return {
    temp: Math.round(c.temperature_2m || 0),
    rain: Math.round(c.precipitation_probability || 0),
    wind: Math.round(c.windspeed_10m || 0),
    uv:   Math.round(c.uv_index || 0),
  };
}

async function getTrafficAhead(lat, lon, trip) {
  if (!trip?.destination?.lat || !trip?.destination?.lon) return null;
  try {
    const { lat: dlat, lon: dlon, name } = trip.destination;
    const resp = await axios.get(
      `https://router.project-osrm.org/route/v1/driving/${lon},${lat};${dlon},${dlat}?overview=false`
    );
    const route = resp.data.routes?.[0];
    if (!route) return null;
    return { distKm: Math.round(route.distance/1000), durMin: Math.round(route.duration/60), destName: name || "ปลายทาง" };
  } catch { return null; }
}

// คำนวณระยะห่างระหว่างคัน (Haversine)
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
    Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

async function calcCarGap(trip) {
  if (!trip) return null;
  const carEntries = Object.entries(trip.cars || {});
  const gpsPerCar  = {};

  for (const [carId, car] of carEntries) {
    let latest = null, latestAt = 0;
    for (const uid of (car.members || [])) {
      const g = await getGps(uid);
      if (g && (g.updatedAt || 0) > latestAt) { latest = g; latestAt = g.updatedAt; }
    }
    gpsPerCar[carId] = latest;
  }

  const carIds = Object.keys(gpsPerCar);
  if (carIds.length < 2) return null;

  const [idA, idB] = carIds;
  const posA = gpsPerCar[idA], posB = gpsPerCar[idB];
  if (!posA || !posB) return null;

  const distKm = Math.round(haversine(posA.lat, posA.lon, posB.lat, posB.lon) * 10) / 10;
  return { distKm, distA: posA.district, distB: posB.district };
}

function getCarName(trip, userId) {
  if (!trip) return "รถ";
  for (const [, car] of Object.entries(trip.cars || {})) {
    if (car.members?.includes(userId)) return car.name;
  }
  return "รถ";
}

// ─── Builders ──────────────────────────────────────────────────

function buildTripCreatedMessage(trip, route) {
  const oName = trip.origin?.name      ?? trip.origin      ?? '?';
  const dName = trip.destination?.name ?? trip.destination ?? '?';
  const wps   = (trip.waypoints || []).map(w => w?.name ?? w).filter(Boolean);
  const liffUrl = `https://liff.line.me/${process.env.LIFF_ID}?joinCode=${trip.tripCode}&groupId=${trip.groupId}`;

  // route summary cells
  const routeCells = route ? [
    {
      type: "box", layout: "horizontal", spacing: "md", margin: "md",
      contents: [
        { type: "box", layout: "vertical", flex: 1, backgroundColor: "#E6F1FB",
          cornerRadius: "8px", paddingAll: "10px",
          contents: [
            { type: "text", text: "ระยะทาง", size: "xxs", color: "#185FA5" },
            { type: "text", text: `${route.distKm} กม.`, size: "lg", weight: "bold", color: "#0C447C" },
          ] },
        { type: "box", layout: "vertical", flex: 1, backgroundColor: "#E1F5EE",
          cornerRadius: "8px", paddingAll: "10px",
          contents: [
            { type: "text", text: "เวลาโดยประมาณ", size: "xxs", color: "#0F6E56" },
            { type: "text",
              text: route.durMin < 60
                ? `${route.durMin} น.`
                : `${Math.floor(route.durMin/60)}ชม.${route.durMin%60>0?route.durMin%60+'น.':""}`,
              size: "lg", weight: "bold", color: "#085041" },
          ] },
      ],
    },
  ] : [];

  // waypoint rows
  const waypointRows = [
    { icon: "🔵", name: oName },
    ...wps.map(w => ({ icon: "🟡", name: w })),
    { icon: "🏁", name: dName },
  ].map(item => ({
    type: "box", layout: "horizontal", spacing: "sm", alignItems: "center",
    contents: [
      { type: "text", text: item.icon, size: "sm", flex: 0 },
      { type: "text", text: item.name, size: "sm", color: "#1a1a1a", flex: 1, wrap: true },
    ],
  }));

  return {
    type: "flex",
    altText: `🆕 Trip ใหม่! ${trip.tripCode} | ${oName} → ${dName}`,
    contents: {
      type: "bubble",
      header: {
        type: "box", layout: "vertical",
        backgroundColor: "#06C755", paddingAll: "12px",
        contents: [
          { type: "text", text: "🆕 Trip ใหม่พร้อมแล้ว!", weight: "bold", color: "#ffffff", size: "md" },
          { type: "text", text: trip.tripCode, color: "#ffffffcc", size: "xs", margin: "xs",
            letterSpacing: "2px" },
        ],
      },
      body: {
        type: "box", layout: "vertical", paddingAll: "14px", spacing: "sm",
        contents: [
          { type: "box", layout: "vertical", spacing: "xs", contents: waypointRows },
          ...routeCells,
        ],
      },
      footer: {
        type: "box", layout: "vertical", paddingAll: "12px", spacing: "sm",
        contents: [
          {
            type: "button",
            action: { type: "uri", label: "🚙 Join Trip นี้", uri: liffUrl },
            style: "primary", color: "#06C755", height: "sm",
          },
          {
            type: "text",
            text: `Code: ${trip.tripCode}  ·  แชร์ให้เพื่อนในกลุ่ม`,
            size: "xxs", color: "#aaa", align: "center",
          },
        ],
      },
    },
  };
}

function buildFullFlexMessage(carName, district, weather, traffic, gap) {
  const rainBadge = weather.rain < 20
    ? { color:"#0F6E56", bg:"#E1F5EE", text:"ไม่มี" }
    : weather.rain < 50
    ? { color:"#633806", bg:"#FAEEDA", text:"มีบ้าง" }
    : { color:"#791F1F", bg:"#FCEBEB", text:"ตกแน่" };

  const uvBadge = weather.uv <= 5
    ? { color:"#0F6E56", bg:"#E1F5EE", text:"ปกติ" }
    : weather.uv <= 7
    ? { color:"#633806", bg:"#FAEEDA", text:"สูง" }
    : { color:"#791F1F", bg:"#FCEBEB", text:"สูงมาก" };

  const headerColor = weather.rain >= 50 ? "#854F0B" : "#185FA5";
  const time = new Date().toLocaleTimeString("th-TH", { hour:"2-digit", minute:"2-digit" });

  const extraContents = [];

  if (traffic) {
    extraContents.push(
      { type:"separator", margin:"sm" },
      { type:"box", layout:"vertical", backgroundColor:"#FFF8E6", cornerRadius:"6px", paddingAll:"8px", margin:"sm",
        contents:[
          { type:"text", text:`ถึง ${traffic.destName}`, size:"xs", weight:"bold", color:"#633806" },
          { type:"text", text:`เหลือ ~${traffic.distKm} กม. · ~${traffic.durMin} นาที`, size:"xs", color:"#3a2800", margin:"xs" },
        ] }
    );
  }

  if (gap) {
    const gapText = gap.distKm < 1
      ? `${Math.round(gap.distKm * 1000)} ม.`
      : `${gap.distKm} กม.`;
    extraContents.push(
      { type:"separator", margin:"sm" },
      { type:"box", layout:"vertical", backgroundColor:"#f0f0f0", cornerRadius:"6px", paddingAll:"8px", margin:"sm",
        contents:[
          { type:"text", text:"📏 ระยะห่างระหว่างคัน", size:"xs", weight:"bold", color:"#555" },
          { type:"text", text:`~${gapText}`, size:"xs", color:"#333", margin:"xs" },
        ] }
    );
  }

  return {
    type: "flex",
    altText: `${carName} เข้า ${district} · ${weather.temp}°C ฝน ${weather.rain}%`,
    contents: {
      type: "bubble",
      header: {
        type:"box", layout:"vertical", backgroundColor:headerColor, paddingAll:"12px",
        contents:[
          { type:"text", text:`เข้า ${district}`, weight:"bold", color:"#ffffff", size:"md" },
          { type:"text", text:`${carName} · ${time} น.`, color:"#ffffffb3", size:"xs", margin:"xs" },
        ],
      },
      body: {
        type:"box", layout:"vertical", paddingAll:"12px", spacing:"sm",
        contents:[
          { type:"box", layout:"horizontal", spacing:"md", contents:[
            { type:"box", layout:"vertical", flex:1, backgroundColor:"#f8f8f8", cornerRadius:"8px", paddingAll:"8px",
              contents:[
                { type:"text", text:"อุณหภูมิ", size:"xxs", color:"#888888" },
                { type:"text", text:`${weather.temp}°C`, size:"lg", weight:"bold", color:"#1a1a1a" },
              ] },
            { type:"box", layout:"vertical", flex:1, backgroundColor:"#f8f8f8", cornerRadius:"8px", paddingAll:"8px",
              contents:[
                { type:"text", text:"ลม", size:"xxs", color:"#888888" },
                { type:"text", text:`${weather.wind} กม/ช`, size:"sm", weight:"bold", color:"#1a1a1a" },
              ] },
          ] },
          { type:"box", layout:"horizontal", spacing:"md", contents:[
            { type:"box", layout:"vertical", flex:1, backgroundColor:rainBadge.bg, cornerRadius:"8px", paddingAll:"8px",
              contents:[
                { type:"text", text:"ฝน", size:"xxs", color:rainBadge.color },
                { type:"text", text:`${weather.rain}%`, size:"lg", weight:"bold", color:rainBadge.color },
                { type:"text", text:rainBadge.text, size:"xxs", color:rainBadge.color },
              ] },
            { type:"box", layout:"vertical", flex:1, backgroundColor:uvBadge.bg, cornerRadius:"8px", paddingAll:"8px",
              contents:[
                { type:"text", text:"UV Index", size:"xxs", color:uvBadge.color },
                { type:"text", text:`${weather.uv}`, size:"lg", weight:"bold", color:uvBadge.color },
                { type:"text", text:uvBadge.text, size:"xxs", color:uvBadge.color },
              ] },
          ] },
          ...extraContents,
        ],
      },
    },
  };
}

function buildPillMessage(carName, district, minutesDiff, gap) {
  const gapContents = gap ? [
    { type:"separator", margin:"sm" },
    { type:"text",
      text:`📏 ห่างกัน ~${gap.distKm < 1 ? Math.round(gap.distKm*1000)+'ม.' : gap.distKm+'กม.'}`,
      size:"xs", color:"#888", margin:"sm" },
  ] : [];

  return {
    type: "flex",
    altText: `${carName} เข้า ${district} แล้วครับ`,
    contents: {
      type:"bubble", size:"kilo",
      body:{
        type:"box", layout:"vertical", paddingAll:"12px", spacing:"sm",
        contents:[
          { type:"box", layout:"horizontal", spacing:"md", alignItems:"center",
            contents:[
              { type:"box", layout:"vertical", width:"36px", backgroundColor:"#E1F5EE", cornerRadius:"18px", paddingAll:"8px", alignItems:"center",
                contents:[{ type:"text", text:"🚗", size:"md", align:"center" }] },
              { type:"box", layout:"vertical", flex:1,
                contents:[
                  { type:"text", text:`${carName} เข้า ${district} แล้วครับ`, size:"sm", weight:"bold", color:"#1a1a1a", wrap:true },
                  { type:"text", text:minutesDiff > 0 ? `ห่างคันแรก ~${minutesDiff} นาที` : "เกือบพร้อมกัน", size:"xs", color:"#888888", margin:"xs" },
                ] },
            ] },
          ...gapContents,
        ],
      },
    },
  };
}

function buildGapMessage(nameA, distA, nameB, distB, distKm) {
  const gapText = distKm < 1 ? `${Math.round(distKm*1000)} ม.` : `${distKm} กม.`;
  return {
    type:"flex",
    altText:`📏 ${nameA} ห่างจาก ${nameB} ~${gapText}`,
    contents:{
      type:"bubble",
      body:{
        type:"box", layout:"vertical", paddingAll:"14px", spacing:"md",
        contents:[
          { type:"text", text:"📏 ระยะห่างระหว่างคัน", weight:"bold", size:"sm", color:"#1a1a1a" },
          { type:"box", layout:"horizontal", spacing:"md", margin:"md",
            contents:[
              { type:"box", layout:"vertical", flex:1, backgroundColor:"#E6F1FB", cornerRadius:"10px", paddingAll:"10px",
                contents:[
                  { type:"text", text:nameA, size:"xs", weight:"bold", color:"#0C447C" },
                  { type:"text", text:distA || "—", size:"xs", color:"#185FA5", margin:"xs" },
                ] },
              { type:"box", layout:"vertical", flex:1, backgroundColor:"#E1F5EE", cornerRadius:"10px", paddingAll:"10px",
                contents:[
                  { type:"text", text:nameB, size:"xs", weight:"bold", color:"#085041" },
                  { type:"text", text:distB || "—", size:"xs", color:"#0F6E56", margin:"xs" },
                ] },
            ] },
          { type:"box", layout:"vertical", backgroundColor:"#f8f8f8", cornerRadius:"10px", paddingAll:"10px", margin:"sm",
            contents:[
              { type:"text", text:"ระยะห่าง (เส้นตรง)", size:"xs", color:"#888" },
              { type:"text", text:`~${gapText}`, size:"xl", weight:"bold", color:"#1a1a1a", margin:"xs" },
            ] },
        ],
      },
    },
  };
}

function buildStatusFlexMessage(trip, carInfo, gap) {
  const oName  = trip.origin?.name      ?? trip.origin      ?? '?';
  const dName  = trip.destination?.name ?? trip.destination ?? '?';
  const time   = new Date().toLocaleTimeString("th-TH", { hour:"2-digit", minute:"2-digit" });

  const carContents = Object.entries(carInfo).map(([carId, info]) => {
    const hasData = info.dist?.district;
    const mins    = info.dist?.sentAt ? Math.round((Date.now() - info.dist.sentAt) / 60000) : null;
    const ageText = mins === null ? '' : mins < 1 ? 'เพิ่งอัปเดต' : `${mins} นาทีที่แล้ว`;
    const icon    = carId === 'A' ? '🚗' : '🚙';
    const bg      = carId === 'A' ? '#E6F1FB' : '#E1F5EE';
    const tc      = carId === 'A' ? '#0C447C' : '#085041';
    const sc      = carId === 'A' ? '#185FA5' : '#0F6E56';

    return {
      type:"box", layout:"vertical", backgroundColor:bg, cornerRadius:"10px", paddingAll:"10px",
      contents:[
        { type:"text", text:`${icon} ${info.name}`, size:"xs", weight:"bold", color:tc },
        { type:"text",
          text: hasData ? info.dist.district : (info.members?.length > 0 ? 'ยังไม่ได้เริ่มติดตาม' : 'ยังไม่มีสมาชิก'),
          size:"sm", weight:"bold", color:hasData ? "#1a1a1a" : "#aaa", margin:"sm" },
        ...(ageText ? [{ type:"text", text:ageText, size:"xs", color:sc, margin:"xs" }] : []),
      ],
    };
  });

  const gapContents = gap ? [
    { type:"separator", margin:"md" },
    { type:"box", layout:"vertical", margin:"md",
      contents:[
        { type:"text", text:"📏 ระยะห่างระหว่างคัน (เส้นตรง)", size:"xs", color:"#888" },
        { type:"text",
          text:`~${gap.distKm < 1 ? Math.round(gap.distKm*1000)+'ม.' : gap.distKm+' กม.'}`,
          size:"xl", weight:"bold", color:"#1a1a1a", margin:"xs" },
      ] },
  ] : [
    { type:"separator", margin:"md" },
    { type:"text", text:"ยังไม่สามารถคำนวณระยะห่างได้\n(ต้องมีทั้ง 2 คันกด 'เริ่มติดตาม GPS' ก่อน)", size:"xs", color:"#aaa", margin:"md", wrap:true },
  ];

  return {
    type:"flex",
    altText:`📍 สถานะ ${trip.tripCode} | ${oName} → ${dName}`,
    contents:{
      type:"bubble",
      header:{
        type:"box", layout:"vertical", backgroundColor:"#1a1a1a", paddingAll:"12px",
        contents:[
          { type:"text", text:`📍 สถานะการเดินทาง`, weight:"bold", color:"#ffffff", size:"sm" },
          { type:"text", text:`${oName} → ${dName}`, color:"#aaaaaa", size:"xs", margin:"xs", wrap:true },
          { type:"text", text:`${trip.tripCode} · ตรวจสอบ ${time} น.`, color:"#666666", size:"xs", margin:"xs" },
        ],
      },
      body:{
        type:"box", layout:"vertical", paddingAll:"12px", spacing:"sm",
        contents:[
          { type:"box", layout:"vertical", spacing:"sm", contents: carContents },
          ...gapContents,
        ],
      },
    },
  };
}

// ─── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`TripWeather Bot running on port ${PORT}`));
