// live_flights.js (Updated with Caching and History-Only Validation)

/* =========================
 * Imports & setup
 * ========================= */
const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

// ⬇️ 1. IMPORT HTTP and SOCKET.IO
const { createServer } = require('http');
const { Server } = require('socket.io');

const app = express();
// ⬇️ 2. CREATE HTTP SERVER & ATTACH SOCKET.IO
const httpServer = createServer(app);
const whitelist = [
    'https://indgo-va.netlify.app', // Your production site
    'http://localhost:8888'         // Your local development machine
];

const corsOptions = {
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);
        
        if (whitelist.indexOf(origin) !== -1) {
            callback(null, true); // Origin is in the whitelist, allow it
        } else {
            callback(new Error('Not allowed by CORS')); // Origin is not allowed
        }
    },
    optionsSuccessStatus: 200
};

// 1. Apply CORS to Socket.IO
const io = new Server(httpServer, {
  cors: corsOptions
});

// 2. Apply CORS to Express (for API requests like /if-sessions)
app.use(cors(corsOptions));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* =========================
 * Config
 * ========================= */
const PORT = parseInt(process.env.PORT || '5001', 10);

const IF_API_BASE_URL = (process.env.IF_API_BASE_URL || 'https://api.infiniteflight.com/public/v2').trim();
const RAW_IF_KEY = process.env.INFINITE_FLIGHT_API_KEY || process.env.IF_API_KEY || '';
const IF_API_KEY = RAW_IF_KEY.trim();

const VA_BACKEND_URL = (process.env.VA_BACKEND_URL || 'http://localhost:5000').trim();
const VA_ROSTER_POLL_MS = parseInt(process.env.VA_ROSTER_POLL_MS || (5 * 60 * 1000), 10); // 5 minutes
const TRACK_WEBHOOK_SECRET = process.env.TRACK_WEBHOOK_SECRET || '';

// ⬇️ MODIFIED: Poll interval for the ACARS/user-tracking engine
const POLL_MS = parseInt(process.env.POLL_MS || '30000', 10); // 30s (for active flight *tracking*)
const BACKGROUND_POLL_MS = parseInt(process.env.BACKGROUND_POLL_MS || (15 * 60 * 1000), 10); // 15 minutes (for backgrounded flights)

// ⬇️ NEW: Poll interval for broadcasting ALL flights to the front-end
// WARNING: 500ms is EXTREMELY fast and may get you rate-limited or blocked by the IF API.
// A safer value is 3000-5000ms (3-5 seconds).
const ALL_FLIGHTS_POLL_MS = parseInt(process.env.ALL_FLIGHTS_POLL_MS || '3000', 10);

const SEARCH_TIMEOUT_MS = parseInt(process.env.SEARCH_TIMEOUT_MS || (48 * 60 * 60 * 1000), 10); // 48 hours
const DEFAULT_IF_SERVER = (process.env.DEFAULT_IF_SERVER || 'Expert Server').trim();
const DEFAULT_CALLBACK_URL = (process.env.TRACK_CALLBACK_URL || '').trim();
const TRACK_LOG = process.env.TRACK_LOG === '1';

// ⬇️ MODIFIED: "Landed" heuristics (Speed/Location-based)
const LANDED_SPEED_KT = 40;     // Max ground speed (knots) to be considered landed

// ⬇️ MODIFIED: "Takeoff" heuristics (Speed/Location-based)
const TAKEOFF_SPEED_KT = 60;      // Min ground speed (knots) to be considered airborne/taking off

// ⬇️ MODIFIED: Shared proximity check
const AIRPORT_PROXIMITY_KM = 10; // Max distance from an airport center (km) for takeoff/landing detection

// Time calculation settings
const MAX_ROUTE_GAP_MS = 10 * 60 * 1000; // 5 minutes: Ignore gaps in /route data longer than this.

// In-memory tracker store
const trackers = new Map(); // id -> tracker
function newId() {
  try { return require('crypto').randomUUID(); } catch { return 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
}

/* =========================
 * NEW: In-Memory API Cache
 * ========================= */

// ⬇️ NEW: Define staff roles (from server.js) for easy checking
const VA_STAFF_ROLES = [
  'staff', 'admin', 'chief executive officer (ceo)', 'chief operating officer (coo)',
  'pirep manager (pm)', 'pilot relations & recruitment manager (pr)', 'technology & design manager (tdm)',
  'head of training (cot)', 'chief marketing officer (cmo)', 'route manager (rm)',
  'events manager (em)', 'flight instructor (fi)'
];

const apiCache = {
  sessions: [],
  flights: new Map(), // sessionId -> { server, sessionId, count, flights, rawFlights, timestamp }
  lastSessionsUpdate: 0,
  // ⬇️ NEW: Add a cache for the VA pilot roster
  vaRosterCache: new Map(), // Stores { lowercase_username -> { role: '...' } }
};
// Cache sessions for 1 minute to prevent spamming the /sessions endpoint
const SESSIONS_CACHE_TTL_MS = 60 * 1000; 

/* =========================
 * Axios client
 * ========================= */
// ... (this section is unchanged) ...
const ifClient = axios.create({
  baseURL: IF_API_BASE_URL,
  timeout: 15000,
  headers: {
    Authorization: `Bearer ${IF_API_KEY}`,
    Accept: 'application/json',
  },
});

/* =========================
 * Data Loaders (Airports, Aircraft & Liveries)
 * ========================= */
// ... (this section is unchanged) ...
let airports = [];
const aircraftNameMap = new Map(); // Map to store aircraft names (ID -> Name)
const liveryNameMap = new Map();   // Map to store livery names (ID -> Name)

function normalizeAirport(a) {
  return {
    icao: a.icao || a.ICAO || '',
    name: a.name || a.airport_name || '',
    lat: a.lat ?? a.latitude ?? null,
    lon: a.lon ?? a.longitude ?? null,
    elevation_ft: a.elevation_ft ?? a.elevation ?? 0,
    country: a.country || a.cc || null,
  };
}

(function loadAirports() {
  try {
    const filePath = path.join(__dirname, 'airports.json'); // robust path
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed)) {
      airports = parsed.map(normalizeAirport)
        .filter(a => a.icao && a.lat != null && a.lon != null);
    } else if (parsed && typeof parsed === 'object') {
      airports = Object.entries(parsed)
        .map(([icao, v]) => normalizeAirport({ icao, ...v }))
        .filter(a => a.icao && a.lat != null && a.lon != null);
    } else {
      airports = [];
    }

    console.log(`✅ Loaded ${airports.length} airports (normalized) from airports.json`);
  } catch (e) {
    console.error('❌ Could not load airports.json. Proximity checks will be disabled.', e);
    airports = [];
  }
})();

// Load aircraft names on startup
(async function loadAircraftNames() {
  try {
    if (!IF_API_KEY) {
      console.warn('⚠️  Skipping aircraft name load: API key is missing.');
      return;
    }
    const aircraftList = await getAircraftList();
    for (const aircraft of aircraftList) {
      aircraftNameMap.set(aircraft.id, aircraft.name);
    }
    console.log(`✅ Loaded ${aircraftNameMap.size} aircraft names.`);
  } catch (e) {
    console.error('❌ Could not load aircraft names. Names will be unavailable.', e.message);
  }
})();

// Load livery names on startup
(async function loadLiveryNames() {
  try {
    if (!IF_API_KEY) {
      console.warn('⚠️  Skipping livery name load: API key is missing.');
      return;
    }
    const liveryList = await getLiveryList();
    for (const livery of liveryList) {
      liveryNameMap.set(livery.id, livery.name);
    }
    console.log(`✅ Loaded ${liveryNameMap.size} livery names.`);
  } catch (e) {
    console.error('❌ Could not load livery names. Names will be unavailable.', e.message);
  }
})();

/* =========================
 * NEW: VA Roster Loader
 * ========================= */

/**
 * Fetches the pilot roster (IF Username + Role) from the main VA backend
 * and populates the in-memory vaRosterCache.
 */
async function fetchVaRoster() {
  if (!VA_BACKEND_URL || !TRACK_WEBHOOK_SECRET) {
    console.warn('[va-roster] Skipping fetch: VA_BACKEND_URL or TRACK_WEBHOOK_SECRET is not set.');
    return;
  }
  
  if (TRACK_LOG) console.log('[va-roster] Fetching VA pilot roster...');

  try {
    const { data: roster } = await axios.get(`${VA_BACKEND_URL}/api/internal/pilot-roster`, {
      timeout: 10000,
      headers: {
        'x-acars-signature': TRACK_WEBHOOK_SECRET
      }
    });

    if (!Array.isArray(roster)) {
      console.warn('[va-roster] Failed to update: Response was not an array.');
      return;
    }
    
    // Clear old cache and repopulate
    const newCache = new Map();
    for (const pilot of roster) {
      if (pilot.username) {
        newCache.set(pilot.username.toLowerCase(), {
          role: pilot.role || 'pilot'
        });
      }
    }
    
    apiCache.vaRosterCache = newCache;
    console.log(`✅ [va-roster] Successfully loaded ${apiCache.vaRosterCache.size} VA pilots into cache.`);

  } catch (e) {
    console.error(`❌ [va-roster] Failed to fetch VA roster from ${VA_BACKEND_URL}: ${e.message}`);
  }
}

/**
 * Starts the poller for the VA Roster
 */
(function runRosterPoller() {
  fetchVaRoster()
    .catch(e => {
        console.error('[va-roster] Unhandled poller error', e?.message);
    })
    .finally(() => {
      // Schedule the next poll
      setTimeout(runRosterPoller, VA_ROSTER_POLL_MS);
    });
})();


/* =========================
 * Helpers
 * ========================= */
// ... (getDistanceKm, findNearestAirport functions are unchanged) ...
/**
 * Calculates the distance between two coordinates in kilometers using the Haversine formula.
 */
function getDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // Radius of the Earth in km
  const toRad = (v) => (v * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Finds the closest airport to a given latitude and longitude.
 */
function findNearestAirport(lat, lon) {
  if (!airports.length || typeof lat !== 'number' || typeof lon !== 'number') {
    return { airport: null, distanceKm: Infinity };
  }

  let bestAirport = null;
  let minDistance = Infinity;

  for (const airport of airports) {
    const distance = getDistanceKm(lat, lon, airport.lat, airport.lon);
    if (distance < minDistance) {
      minDistance = distance;
      bestAirport = airport;
    }
  }
  
  return { airport: bestAirport, distanceKm: minDistance };
}

/**
 * ⬇️ REPLACED FUNCTION
 * Analyzes a flight's complete route data to calculate the true flight duration,
 * ignoring long gaps from disconnections.
 * This is the "robust time keeper" function.
 *
 * NEW: This version now ensures the landing airport is not the same as the takeoff airport.
 */
function calculateFlightDurationFromRoute(route, airports) {
  if (!route || route.length < 2) {
    return { durationMs: 0, takeoffPoint: null, landingPoint: null, takeoffAirport: null, landingAirport: null };
  }

  let takeoffPoint = null;
  let takeoffAirport = null;
  let landingPoint = null;
  let landingAirport = null;

  // 1. Find Takeoff Point (first point near an airport matching takeoff speed)
  for (let i = 0; i < route.length; i++) {
    const point = route[i];
    const { airport, distanceKm } = findNearestAirport(point.lat, point.lon); // Get distance
    if (airport) {
      if (point.groundSpeed > TAKEOFF_SPEED_KT && distanceKm < AIRPORT_PROXIMITY_KM) {
        takeoffPoint = point;
        takeoffAirport = airport; // We've marked the departure airport
        break; // Found the first airborne point, stop searching
      }
    }
  }

  // 2. Find Landing Point (last point near an airport matching landing speed)
  //    This point MUST NOT be the same as the takeoff airport.
  for (let i = route.length - 1; i >= 0; i--) {
    const point = route[i];
    const { airport, distanceKm } = findNearestAirport(point.lat, point.lon);
    if (airport) {
      const isLandedSpeed = point.groundSpeed < LANDED_SPEED_KT;
      const isNearAirport = distanceKm < AIRPORT_PROXIMITY_KM;

      // ⬇️ NEW LOGIC: Check if this airport is the *same* as the one we took off from.
      // We only check this if a takeoffAirport was successfully identified.
      const isDepartureAirport = takeoffAirport && airport.icao === takeoffAirport.icao;

      // The point is valid only if it's at landed speed, near an airport,
      // AND it's NOT the departure airport.
      if (isLandedSpeed && isNearAirport && !isDepartureAirport) {
        landingPoint = point;
        landingAirport = airport;
        break; // Found the last landing-like point, stop searching
      }
    }
  }

  // If we couldn't find a clear takeoff or landing (that meets our criteria),
  // we can't calculate duration.
  if (!takeoffPoint || !landingPoint) {
    return { durationMs: 0, takeoffPoint, landingPoint, takeoffAirport, landingAirport };
  }
  
  const takeoffTimestamp = new Date(takeoffPoint.timestamp).getTime();
  const landingTimestamp = new Date(landingPoint.timestamp).getTime();

  // Filter the route to only include points between the detected takeoff and landing.
  const flightSegment = route.filter(p => {
    const ts = new Date(p.timestamp).getTime();
    return ts >= takeoffTimestamp && ts <= landingTimestamp;
  });
  
  if (flightSegment.length < 2) {
    return { durationMs: 0, takeoffPoint, landingPoint, takeoffAirport, landingAirport };
  }
  
  // 3. Sum up the durations between consecutive points, ignoring large gaps.
  //    This logic explicitly handles disconnections (gaps > MAX_ROUTE_GAP_MS are ignored)
  //    and only counts time within the flightSegment (from takeoff to landing).
  let totalDurationMs = 0;
  for (let i = 0; i < flightSegment.length - 1; i++) {
    const t1 = new Date(flightSegment[i].timestamp).getTime();
    const t2 = new Date(flightSegment[i + 1].timestamp).getTime();
    const delta = t2 - t1;

    // Only add the interval if it's positive and smaller than our defined max gap.
    if (delta > 0 && delta < MAX_ROUTE_GAP_MS) {
      totalDurationMs += delta;
    }
  }

  return {
    durationMs: totalDurationMs,
    takeoffPoint,
    landingPoint,
    takeoffAirport,
    landingAirport,
  };
}


function unwrap(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.result)) return data.result;
  return data.result ?? data.items ?? [];
}

function err(status, message, extra = {}) {
  return { ok: false, error: { status, message, ...extra } };
}


/* =========================
 * IF API Wrappers
 * ========================= */
async function getAircraftList() {
// ... (this function is unchanged) ...
  const { data } = await ifClient.get('/aircraft');
  const items = unwrap(data);
  return items.map((a) => ({
    id: a?.id || null,
    name: a?.name || '',
  })).filter(a => a.id && a.name);
}

async function getLiveryList() {
// ... (this function is unchanged) ...
  const { data } = await ifClient.get('/aircraft/liveries');
  const items = unwrap(data);
  return items.map((l) => ({
    id: l?.id || null,
    name: l?.liveryName || '',
  })).filter(l => l.id && l.name);
}

/**
 * ⬇️ REPLACED FUNCTION
 * This function now uses the in-memory cache to avoid spamming the API.
 */
async function getSessions() {
  const now = Date.now();
  // 1. Check if cache is valid (not older than TTL and not empty)
  if (now - apiCache.lastSessionsUpdate < SESSIONS_CACHE_TTL_MS && apiCache.sessions.length > 0) {
    if (TRACK_LOG) console.log('[getSessions] Returning cached sessions.');
    return apiCache.sessions;
  }
  
  if (TRACK_LOG) console.log('[getSessions] Fetching fresh sessions from API.');
  const { data } = await ifClient.get('/sessions');
  const items = unwrap(data);
  const sessions = items.map((s) => ({
    id: s?.id || s?.uuid || null,
    name: s?.name || s?.serverName || '',
    raw: s,
  })).filter(s => s.id && s.name);
  
  // 3. Update cache
  apiCache.sessions = sessions;
  apiCache.lastSessionsUpdate = now;
  return sessions;
}

function pickSessionIdByName(sessions, desiredName = 'Expert Server') {
// ... (this function is unchanged) ...
  if (!Array.isArray(sessions) || sessions.length === 0) return null;
  const want = String(desiredName || '').trim().toLowerCase();
  const exact = sessions.find(s => (s.name || '').toLowerCase() === want);
  if (exact) return exact.id;
  const fuzzy = sessions.find(s => (s.name || '').toLowerCase().includes(want));
  if (fuzzy) return fuzzy.id;
  const aliases = {
    expert: ['expert server', 'expert'],
    training: ['training server', 'training'],
    casual: ['casual server', 'casual'],
  };
  for (const [key, keys] of Object.entries(aliases)) {
    if (keys.includes(want)) {
      const found = sessions.find(s => (s.name || '').toLowerCase().includes(key));
      if (found) return found.id;
    }
  }
  return sessions[0]?.id ?? null;
}

async function getFlightsForSession(sessionId) {
// ... (this function is unchanged) ...
  if (!sessionId) throw new Error('Missing sessionId');
  try {
    const { data } = await ifClient.get(`/sessions/${encodeURIComponent(sessionId)}/flights`);
    const payload = data && typeof data === 'object' ? data : {};
    if (typeof payload.errorCode === 'number' && payload.errorCode !== 0) {
      const err = new Error(`IF API errorCode ${payload.errorCode}`);
      err.response = { data: payload };
      throw err;
    }
    return Array.isArray(payload.result) ? payload.result : (Array.isArray(data) ? data : []);
  } catch (e) {
    const status = e?.response?.status;
    if (status === 401 || status === 403 || status === 404) {
      const { data: retry } = await ifClient.get(
        `/sessions/${encodeURIComponent(sessionId)}/flights`,
        { params: { apikey: IF_API_KEY } }
      );
      const payload = retry && typeof retry === 'object' ? retry : {};
      if (typeof payload.errorCode === 'number' && payload.errorCode !== 0) {
        const err = new Error(`IF API errorCode ${payload.errorCode} (query param)`);
        err.response = { data: payload };
        throw err;
      }
      return Array.isArray(payload.result) ? payload.result : (Array.isArray(retry) ? retry : []);
    }
    throw e;
  }
}


// ⬇️ REPLACED FUNCTION
function simplifyFlight(f) {
  const aircraftId = f?.aircraftId || null;
  const liveryId = f?.liveryId || null;
  const username = f?.username || null;
  
  // ⬇️ NEW: VA Roster Check
  let isVAMember = false;
  let isStaff = false;
  let vaRole = null;

  if (username) {
    const profile = apiCache.vaRosterCache.get(username.toLowerCase());
    if (profile) {
      isVAMember = true;
      vaRole = profile.role;
      // Check if the role is one of the staff roles
      isStaff = VA_STAFF_ROLES.includes(vaRole.toLowerCase());
    }
  }

  return {
    flightId: f?.flightId || null,
    userId: f?.userId || null,
    callsign: f?.callsign || '',
    username: username,
    virtualOrganization: f?.virtualOrganization || null,
    // ⬇️ NEW: Add the VA status fields
    isVAMember,
    isStaff,
    vaRole,
    // ⬆️ End of new fields
    position: {
      lat: typeof f?.latitude === 'number' ? f.latitude : null,
      lon: typeof f?.longitude === 'number' ? f.longitude : null,
      alt_ft: typeof f?.altitude === 'number' ? f.altitude : null,
      gs_kt: typeof f?.speed === 'number' ? f.speed : null,
      vs_fpm: typeof f?.verticalSpeed === 'number' ? f.verticalSpeed : null,
      // ⬇️ REMOVED
      // track_deg: typeof f?.track === 'number' ? f.track : null, 
      heading_deg: typeof f?.heading === 'number' ? f.heading : null,
      lastReport: f?.lastReport || null,
      lastReportMs: f?.lastReport ? Date.parse(f.lastReport) || null : null,
    },
    aircraft: {
      aircraftId: aircraftId,
      liveryId: liveryId,
      aircraftName: aircraftNameMap.get(aircraftId) || null,
      liveryName: liveryNameMap.get(liveryId) || null,
    },
    pilotState: typeof f?.pilotState === 'number' ? f.pilotState : null,
    isConnected: typeof f?.isConnected === 'boolean' ? f.isConnected : null,
  };
}

// ... (All other IF API Wrappers like getFlightPlan, getFlightRoute, getActiveATC, getNotams, getUserStats, getUserGrade are unchanged) ...
async function getFlightPlan(sessionId, flightId) {
  if (!sessionId || !flightId) throw new Error('Missing sessionId or flightId');
  const url = `/sessions/${encodeURIComponent(sessionId)}/flights/${encodeURIComponent(flightId)}/flightplan`;
  try {
    const { data } = await ifClient.get(url);
    const payload = data && typeof data === 'object' ? data : {};
    if (typeof payload.errorCode === 'number' && payload.errorCode !== 0) {
      if (payload.errorCode === 6) return null;
      const err = new Error(`IF API errorCode ${payload.errorCode}`);
      err.response = { data: payload };
      throw err;
    }
    return payload.result || null;
  } catch (e) {
    const status = e?.response?.status;
    if (status === 401 || status === 403) {
      const { data: retry } = await ifClient.get(url, { params: { apikey: IF_API_KEY } });
      const payload = retry && typeof retry === 'object' ? retry : {};
      if (typeof payload.errorCode === 'number' && payload.errorCode !== 0) {
        if (payload.errorCode === 6) return null;
        const err = new Error(`IF API errorCode ${payload.errorCode} (query param)`);
        err.response = { data: payload };
        throw err;
      }
      return payload.result || null;
    }
    if (status === 404) {
      return null;
    }
    throw e;
  }
}


function simplifyFlightPlan(plan) {
  if (!plan || !Array.isArray(plan.flightPlanItems)) {
    return { flightPlanId: plan?.flightPlanId || null, waypoints: [] };
  }
  
  const waypoints = [];
  
  const extractWaypoints = (items) => {
    if (!Array.isArray(items)) return; // Safety check
    
    for (const item of items) {
      // According to the documentation, an item is a procedure IF it has children.
      if (Array.isArray(item.children) && item.children.length > 0) {
        // This is a procedure (e.g., "L12R").
        // Do NOT add this item itself; just process its children.
        extractWaypoints(item.children);
      } else {
        // This is a waypoint (e.g., "AMAHE", "ZESTY", "RW12R").
        // Add it, but keep the safety check for (0,0) locations just in case.
        if (item.location && (item.location.latitude !== 0 || item.location.longitude !== 0)) {
          waypoints.push({
            name: item.name,
            lat: item.location.latitude,
            lon: item.location.longitude,
          });
        }
      }
    }
  };
  
  extractWaypoints(plan.flightPlanItems);
  
  return {
    flightPlanId: plan.flightPlanId,
    waypoints,
  };
}

async function getFlightRoute(sessionId, flightId) {
  if (!sessionId || !flightId) throw new Error('Missing sessionId or flightId');
  const url = `/sessions/${encodeURIComponent(sessionId)}/flights/${encodeURIComponent(flightId)}/route`;
  try {
    const { data } = await ifClient.get(url);
    const payload = data && typeof data === 'object' ? data : {};
    if (typeof payload.errorCode === 'number' && payload.errorCode !== 0) {
      if (payload.errorCode === 6) return [];
      const err = new Error(`IF API errorCode ${payload.errorCode}`);
      err.response = { data: payload };
      throw err;
    }
    return Array.isArray(payload.result) ? payload.result : [];
  } catch (e) {
    const status = e?.response?.status;
    if (status === 401 || status === 403) {
      const { data: retry } = await ifClient.get(url, { params: { apikey: IF_API_KEY } });
      const payload = retry && typeof retry === 'object' ? retry : {};
      if (typeof payload.errorCode === 'number' && payload.errorCode !== 0) {
        if (payload.errorCode === 6) return [];
        const err = new Error(`IF API errorCode ${payload.errorCode} (query param)`);
        err.response = { data: payload };
        throw err;
      }
      return Array.isArray(payload.result) ? payload.result : [];
    }
    if (status === 404) {
      return [];
    }
    throw e;
  }
}

function simplifyFlightRoute(routeData) {
  if (!Array.isArray(routeData)) return [];
  return routeData.map(p => ({
    lat: p.latitude,
    lon: p.longitude,
    altitude: p.altitude,
    groundSpeed: p.groundSpeed,
    track: p.track,
    timestamp: p.date,
  }));
}

async function getActiveATC(sessionId) {
  if (!sessionId) throw new Error('Missing sessionId');
  const url = `/sessions/${encodeURIComponent(sessionId)}/atc`;
  try {
    const { data } = await ifClient.get(url);
    const payload = data && typeof data === 'object' ? data : {};
    if (typeof payload.errorCode === 'number' && payload.errorCode !== 0) {
      const err = new Error(`IF API errorCode ${payload.errorCode}`);
      err.response = { data: payload };
      throw err;
    }
    return Array.isArray(payload.result) ? payload.result : [];
  } catch (e) {
    const status = e?.response?.status;
    if (status === 401 || status === 403) {
      const { data: retry } = await ifClient.get(url, { params: { apikey: IF_API_KEY } });
      const payload = retry && typeof retry === 'object' ? retry : {};
      if (typeof payload.errorCode === 'number' && payload.errorCode !== 0) {
        const err = new Error(`IF API errorCode ${payload.errorCode} (query param)`);
        err.response = { data: payload };
        throw err;
      }
      return Array.isArray(payload.result) ? payload.result : [];
    }
    if (status === 404) {
      return [];
    }
    throw e;
  }
}

async function getNotams(sessionId) {
  if (!sessionId) throw new Error('Missing sessionId');
  const url = `/sessions/${encodeURIComponent(sessionId)}/notams`;
  try {
    const { data } = await ifClient.get(url);
    const payload = data && typeof data === 'object' ? data : {};
    if (typeof payload.errorCode === 'number' && payload.errorCode !== 0) {
      const err = new Error(`IF API errorCode ${payload.errorCode}`);
      err.response = { data: payload };
      throw err;
    }
    return Array.isArray(payload.result) ? payload.result : [];
  } catch (e) {
    const status = e?.response?.status;
    if (status === 401 || status === 403) {
      const { data: retry } = await ifClient.get(url, { params: { apikey: IF_API_KEY } });
      const payload = retry && typeof retry === 'object' ? retry : {};
      if (typeof payload.errorCode === 'number' && payload.errorCode !== 0) {
        const err = new Error(`IF API errorCode ${payload.errorCode} (query param)`);
        err.response = { data: payload };
        throw err;
      }
      return Array.isArray(payload.result) ? payload.result : [];
    }
    if (status === 404) {
      return [];
    }
    throw e;
  }
}

async function getUserStats(params) {
// ... (this function is unchanged) ...
  const url = '/users';
  if (!params || (!params.userIds && !params.discourseNames && !params.userHashes)) {
    throw new Error('At least one search parameter (userIds, discourseNames, userHashes) is required.');
  }

  try {
    // This is a POST request, so we send the params in the body
    const { data } = await ifClient.post(url, params);
    const payload = data && typeof data === 'object' ? data : {};
    if (typeof payload.errorCode === 'number' && payload.errorCode !== 0) {
      const err = new Error(`IF API errorCode ${payload.errorCode}`);
      err.response = { data: payload };
      throw err;
    }
    return Array.isArray(payload.result) ? payload.result : [];
  } catch (e) {
    const status = e?.response?.status;
    // Replicate the retry logic from your other functions for consistency
    if (status === 401 || status === 403) {
      const { data: retry } = await ifClient.post(url, params, { params: { apikey: IF_API_KEY } });
      const payload = retry && typeof retry === 'object' ? retry : {};
      if (typeof payload.errorCode === 'number' && payload.errorCode !== 0) {
        const err = new Error(`IF API errorCode ${payload.errorCode} (query param)`);
        err.response = { data: payload };
        throw err;
      }
      return Array.isArray(payload.result) ? payload.result : [];
    }
    throw e;
  }
}

async function getUserGrade(userId) {
// ... (this function is unchanged) ...
  if (!userId) throw new Error('Missing userId');
  const url = `/users/${encodeURIComponent(userId)}`;
  try {
    const { data } = await ifClient.get(url);
    const payload = data && typeof data === 'object' ? data : {};
    if (typeof payload.errorCode === 'number' && payload.errorCode !== 0) {
      if (payload.errorCode === 1) return null; // UserNotFound
      const err = new Error(`IF API errorCode ${payload.errorCode}`);
      err.response = { data: payload };
      throw err;
    }
    return payload.result || null;
  } catch (e) {
    const status = e?.response?.status;
    if (status === 401 || status === 403) {
      const { data: retry } = await ifClient.get(url, { params: { apikey: IF_API_KEY } });
      const payload = retry && typeof retry === 'object' ? retry : {};
      if (typeof payload.errorCode === 'number' && payload.errorCode !== 0) {
        if (payload.errorCode === 1) return null; // UserNotFound
        const err = new Error(`IF API errorCode ${payload.errorCode} (query param)`);
        err.response = { data: payload };
        throw err;
      }
      return payload.result || null;
    }
    if (status === 404) {
      return null;
    }
    throw e;
  }
}

/**
 * ⬇️ CORRECTED FUNCTION
 * Fetches the recent flight history for a user.
 * This version correctly parses the paginated response { result: { data: [...] } }
 */
async function getUserFlightHistory(userId, page = 1) {
  if (!userId) throw new Error('Missing userId');
  const url = `/users/${encodeURIComponent(userId)}/flights`;
  try {
    // Add 'page' to params
    const { data } = await ifClient.get(url, { params: { page } });
    const payload = data && typeof data === 'object' ? data : {};
    if (typeof payload.errorCode === 'number' && payload.errorCode !== 0) {
      if (payload.errorCode === 1) return []; // UserNotFound (or no flights)
      const err = new Error(`IF API errorCode ${payload.errorCode}`);
      err.response = { data: payload };
      throw err;
    }
    // ⬇️ FIX: Return the 'data' array inside the 'result' object
    return Array.isArray(payload.result?.data) ? payload.result.data : [];
  } catch (e) {
    const status = e?.response?.status;
    if (status === 401 || status === 403) {
      // Add page to retry params
      const { data: retry } = await ifClient.get(url, { params: { apikey: IF_API_KEY, page } });
      const payload = retry && typeof retry === 'object' ? retry : {};
      if (typeof payload.errorCode === 'number' && payload.errorCode !== 0) {
        if (payload.errorCode === 1) return []; // UserNotFound
        const err = new Error(`IF API errorCode ${payload.errorCode} (query param)`);
        err.response = { data: payload };
        throw err;
      }
      // ⬇️ FIX: Return the 'data' array inside the 'result' object
      return Array.isArray(payload.result?.data) ? payload.result.data : [];
    }
    if (status === 404) {
      return []; // 404 means user not found, so no flights.
    }
    throw e;
  }
}


/* =========================
 * Socket.IO Connection Handling (NEW)
 * ========================= */
// ... (this section is unchanged) ...
io.on('connection', (socket) => {
  console.log(`[socket] ✅ User connected: ${socket.id}`);

  // Listen for a client to request a specific server's flight data
  socket.on('join_server_room', (serverName) => {
    if (!serverName) return;
    const roomName = String(serverName).toLowerCase();
    socket.join(roomName);
    console.log(`[socket] 🚪 ${socket.id} joined room: ${roomName}`);
  });

  socket.on('disconnect', () => {
    console.log(`[socket] ❌ User disconnected: ${socket.id}`);
  });
});


/* =========================
 * All-Flights Broadcaster (MODIFIED)
 * ========================= */

// This function now fetches flights, updates the central cache, and broadcasts to clients.
// It also includes error handling to back off if rate-limited.
let nextBroadcastPollMs = ALL_FLIGHTS_POLL_MS; // Dynamic poll interval

async function pollAndBroadcastFlights() {
  let sessions = [];
  try {
    // This will use the new cache-aware getSessions() function
    sessions = await getSessions();
  } catch (e) {
    console.warn('[broadcast] Sessions fetch failed', e?.message);
    if (e?.message?.includes('429')) {
      console.error(`[broadcast] 🛑 Sessions API Rate Limit (429) detected. Backing off for 60 seconds.`);
      nextBroadcastPollMs = 60000; // 60s backoff
    }
    return; // Try again on next poll
  }

  // We fetch data for the main servers to populate the cache for all services
  const serverNames = ["Expert Server", "Training Server", "Casual Server"];
  
  for (const serverName of serverNames) {
    const sessionId = pickSessionIdByName(sessions, serverName);

    if (!sessionId) {
      if (TRACK_LOG) console.warn(`[broadcast] No sessionId for server "${serverName}"`);
      continue; // Skip this server
    }

    const roomName = serverName.toLowerCase();
    // Check if anyone is listening (either a socket client or an ACARS tracker)
    const room = io.sockets.adapter.rooms.get(roomName);
    const acarsNeedsThisServer = getActiveTrackers().some(t => t.server.toLowerCase() === serverName.toLowerCase());

    if ((!room || room.size === 0) && !acarsNeedsThisServer) {
      // if (TRACK_LOG) console.log(`[broadcast] 😴 Skipping ${serverName}, no clients or trackers.`);
      apiCache.flights.delete(sessionId); // Clear stale data
      continue;
    }

    try {
      // This is the main API call we need to protect
      const rawFlights = await getFlightsForSession(sessionId);
      const simplifiedFlights = rawFlights.map(simplifyFlight);
      
      const payload = {
        server: serverName,
        sessionId: sessionId,
        count: simplifiedFlights.length,
        flights: simplifiedFlights,
        timestamp: new Date().toISOString()
      };
      
      // 1. 🚀 UPDATE THE CACHE for other services (ACARS, API)
      apiCache.flights.set(sessionId, {
          ...payload,
          rawFlights: rawFlights // Store raw flights for ACARS tracker
      });

      // 2. 📡 EMIT TO THE ROOM (if clients are present)
      if (room && room.size > 0) {
        io.to(roomName).emit('all_flights_update', payload);
        
        if (TRACK_LOG) {
            console.log(`[broadcast] 📡 Sent ${simplifiedFlights.length} flights to ${room.size} client(s) for ${serverName}`);
        }
      }

    } catch (e) {
      console.warn(`[broadcast] Flights fetch failed for "${serverName}"`, e?.message);
      // Clear cache for this server so ACARS doesn't use stale data
      apiCache.flights.delete(sessionId);

      if (e?.message?.includes('429')) {
          console.error(`[broadcast] 🛑 Flights API Rate Limit (429) detected. Backing off for 60 seconds.`);
          nextBroadcastPollMs = 60000; // 60s backoff
      }
    }
  }
}

// Start the new broadcaster loop with dynamic backoff
(function runBroadcastPoller() {
  pollAndBroadcastFlights()
    .catch(e => {
        console.error('[broadcast] Unhandled poll error', e?.message);
         if (e?.message?.includes('429')) {
            console.error(`[broadcast] 🛑 Unhandled 429. Backing off for 60s.`);
            nextBroadcastPollMs = 60000; // 60 seconds
         }
    })
    .finally(() => {
      // Schedule the next poll using the dynamic interval
      setTimeout(runBroadcastPoller, nextBroadcastPollMs);

      // Reset to default poll time for the *next* cycle (after the backoff)
      if (nextBroadcastPollMs !== ALL_FLIGHTS_POLL_MS) {
          console.log(`[broadcast] Resuming default poll interval of ${ALL_FLIGHTS_POLL_MS}ms after this backoff cycle.`);
          nextBroadcastPollMs = ALL_FLIGHTS_POLL_MS;
      }
    });
})();


/* =========================
 * Tracking engine (MODIFIED - Reads from cache)
 * ========================= */
async function notifyCallback(tracker, payload) {
// ... (this function is unchanged) ...
  const url = tracker.callbackUrl || DEFAULT_CALLBACK_URL;
  if (!url) return;
  try {
    await axios.post(url, {
      trackerId: tracker.id,
      username: tracker.username,
      server: tracker.server,
      status: tracker.status,
      ...payload,
    }, {
      timeout: 10000,
      headers: {
        'x-acars-signature': process.env.TRACK_WEBHOOK_SECRET || ''
      }
    });
  } catch (e) {
    if (TRACK_LOG) console.warn('[callback] failed', e?.message);
  }
}

function addTrackers(input) {
// ... (this function is unchanged, but logs to history) ...
  const now = Date.now();
  const created = [];
  const list = Array.isArray(input.usernames) && input.usernames.length
    ? input.usernames.map(u => ({ username: u, server: input.server, callbackUrl: input.callbackUrl }))
    : [{ username: input.username, server: input.server, callbackUrl: input.callbackUrl }];

  for (const item of list) {
    const username = String(item.username || '').trim();
    if (!username) continue;
    const server = (item.server || DEFAULT_IF_SERVER).trim();
    const callbackUrl = (item.callbackUrl || DEFAULT_CALLBACK_URL || '').trim();

    const existing = [...trackers.values()].find(t =>
      t.username.toLowerCase() === username.toLowerCase() &&
      t.server.toLowerCase() === server.toLowerCase() &&
      (t.status === 'searching' || t.status === 'tracking')
    );
    if (existing) {
      created.push(existing);
      continue;
    }

    const id = newId();
    const t = {
      id,
      username,
      server,
      callbackUrl: callbackUrl || null,
      status: 'searching',
      startedAt: now,
      lastPolledAt: 0,
      lastSeenAt: 0,
      attempts: 0,
      flight: null,
      lastKnownFlight: null,
      timeoutAt: now + SEARCH_TIMEOUT_MS,
      nextPollAt: now,
      // ⬇️ MODIFIED: Add rich history message
      history: [{ event: 'created', message: `Tracker created for ${username} on ${server}.`, timestamp: now }],
    };
    trackers.set(id, t);
    created.push(t);
    notifyCallback(t, {});
  }
  return created;
}

function getActiveTrackers() {
// ... (this function is unchanged) ...
  return [...trackers.values()].filter(t => t.status === 'searching' || t.status === 'tracking');
}



/**
 * ⬇️ REPLACED FUNCTION (HISTORY-ONLY VALIDATION)
 *
 * This version implements the user's critical requirement:
 * Once a tracker's status becomes 'tracking' (i.e., it has locked onto a
 * flightId), it can NEVER revert to 'searching'.
 *
 * This version relies *exclusively* on the User History API for landing
 * confirmation. It will not use Route Analysis as a fallback.
 *
 * It will poll, bound to the original flightId, and re-run the history
 * check until the 48-hour timeout is reached or a valid log is found.
 *
 * A valid log MUST have:
 * 1. `landingCount` === 1
 * 2. `totalTime` >= 30 minutes
 */
async function pollOnce() {
  const now = Date.now();

  // find trackers that are due to be polled
  const trackersToCheck = [...trackers.values()].filter(t =>
    (t.status === 'searching' || t.status === 'tracking') && now >= t.nextPollAt
  );

  if (!trackersToCheck.length) return;

  // Group trackers by server for efficient handling
  const byServer = trackersToCheck.reduce((m, t) => {
    const key = t.server.toLowerCase();
    if (!m[key]) m[key] = [];
    m[key].push(t);
    return m;
  }, {});

  // Sessions come from cache (broadcaster populates apiCache.sessions)
  const sessions = apiCache.sessions;
  if (!sessions || sessions.length === 0) {
    if (TRACK_LOG) console.warn('[track] No cached sessions available. Skipping poll.');
    return;
  }

  for (const [serverKey, group] of Object.entries(byServer)) {
    const humanName = group[0]?.server || DEFAULT_IF_SERVER;
    const sessionId = pickSessionIdByName(sessions, humanName);
    if (!sessionId) {
      if (TRACK_LOG) console.warn(`[track] no sessionId for server "${humanName}"`);
      // ensure trackers get their nextPoll set so we don't spin
      for (const t of group) {
        t.nextPollAt = now + POLL_MS;
        trackers.set(t.id, t);
      }
      continue;
    }

    // Read raw flights from flights cache (set by broadcaster)
    const cachedData = apiCache.flights.get(sessionId);
    if (!cachedData || !cachedData.rawFlights) {
      if (TRACK_LOG) console.warn(`[track] No cached raw flights for "${humanName}". Broadcaster may be offline or rate-limited.`);
      // schedule next check for each tracker and continue
      for (const t of group) {
        t.nextPollAt = now + POLL_MS;
        trackers.set(t.id, t);
      }
      continue;
    }
    const flights = cachedData.rawFlights;

    // Build lookup maps
    const byUsername = new Map();
    const byFlightId = new Map();
    for (const f of flights) {
      if (f.flightId) byFlightId.set(f.flightId, f);
      const u = (f.username || '').toLowerCase();
      if (u) {
        if (!byUsername.has(u)) byUsername.set(u, []);
        byUsername.get(u).push(f);
      }
    }

    // Process each tracker in this server group
    for (const t of group) {
      t.attempts = (t.attempts || 0) + 1;
      t.lastPolledAt = now;

      let match = null;

      // --- FLIGHT MATCHING LOGIC ---
      
      // If already tracking, prefer the locked flightId
      if (t.status === 'tracking' && t.lastKnownFlight?.flightId) {
        match = byFlightId.get(t.lastKnownFlight.flightId);
      } 
      // ONLY if status is 'searching' (pre-lock) do we look by username
      else if (t.status === 'searching') {
        const userFlights = byUsername.get(t.username.toLowerCase());
        if (userFlights && userFlights.length) {
          match = userFlights[0];
        }
      }
      
      // --- END FLIGHT MATCHING LOGIC ---


      if (match) {
        // ---------------------------------
        // FLIGHT IS PRESENT (ONLINE)
        // ---------------------------------
        const found = simplifyFlight(match);

        // This is the "first lock" event.
        // It happens when status *was* 'searching' and we found a flight.
        const isFirstLock = t.status === 'searching';
        
        if (isFirstLock) {
           t.history.push({ event: 'online', message: `User found ONLINE. Locking onto flightId: ${found.flightId}`, timestamp: now });
           if (TRACK_LOG) console.log(`[track] ONLINE ${t.username} on ${t.server} -> Locking onto flightId: ${found.flightId}`);
           notifyCallback(t, { flight: { ...found, sessionId }, reason: 'user_online' });
           
           // THIS IS THE MOMENT OF "PERMANENT LOCK"
           t.status = 'tracking'; 
           t.lastKnownFlight = { flightId: found.flightId, sessionId: sessionId };
        }

        t.lastSeenAt = now;
        t.flight = { ...found, sessionId }; // This .flight object contains the userId
        
        // This check is redundant due to isFirstLock, but safe to keep
        if (!t.lastKnownFlight) {
             t.lastKnownFlight = { flightId: found.flightId, sessionId: sessionId };
        }

        // Takeoff detection (speed + proximity)
        const hasTakenOff = t.history.some(h => h.event === 'takeoff');
        if (!hasTakenOff && found.position.lat && found.position.lon) {
          const { airport, distanceKm } = findNearestAirport(found.position.lat, found.position.lon);
          if (airport) {
            const groundSpeed = found.position.gs_kt;
            const isAirborne = groundSpeed > TAKEOFF_SPEED_KT && distanceKm < AIRPORT_PROXIMITY_KM;
            if (isAirborne) {
              t.history.push({ event: 'takeoff', message: `TAKEOFF detected near ${airport.icao}. Flight timer started.`, timestamp: now, airport: airport.icao });
              if (TRACK_LOG) console.log(`[track] TAKEOFF ${t.username} from near ${airport.icao}. Flight timer started.`);
              notifyCallback(t, { reason: 'flight_takeoff', airport });
            }
          }
        }

        // Schedule next poll (background vs active)
        const isInBackground = found.pilotState === 3;
        t.nextPollAt = now + (isInBackground ? BACKGROUND_POLL_MS : POLL_MS);
        
        const wasInBackground = t.history.at(-1)?.event === 'background';
        if (isInBackground && !wasInBackground) {
            t.history.push({ event: 'background', message: `User is in background. Switching to ${BACKGROUND_POLL_MS/60000}m poll interval.`, timestamp: now });
            if (TRACK_LOG) console.log(`[track] ✈️ ${t.username} is in background. Next poll in ${BACKGROUND_POLL_MS/60000}m.`);
        } else if (!isInBackground && wasInBackground) {
            t.history.push({ event: 'active', message: `User is active. Resuming ${POLL_MS/1000}s poll interval.`, timestamp: now });
        }


        trackers.set(t.id, t);
        continue; // proceed to next tracker
      }

      // ---------------------------------
      // FLIGHT IS NOT PRESENT (OFFLINE)
      // ---------------------------------
      
      // We now check if the tracker was *ever* locked to a flight.
      if (t.lastKnownFlight?.flightId) {
        
        // ⬇️ ⬇️ ⬇️ THIS IS THE MODIFIED BLOCK (History-Only) ⬇️ ⬇️ ⬇️

        // --- START: "POST-LOCK" OFFLINE LOGIC ---
        
        let landingConfirmed = false;
        let method = 'unknown';
        let officialDurationMs = 0;
        let officialStartTime = null;
        let officialEndTime = null;
        let takeoffAirport = null;
        let landingAirport = null;
        
        const lastFlightId = t.lastKnownFlight.flightId;

        // 1. CHECK OFFICIAL USER HISTORY (ONLY SOURCE OF TRUTH)
        if (t.flight?.userId) {
          try {
            const userId = t.flight.userId;
            t.history.push({ event: 'fetch_history', message: `Flight ${lastFlightId} not in /flights. Checking official user history...`, timestamp: now });
            if (TRACK_LOG) console.log(`[track] ${t.username} flight ${lastFlightId} not in /flights. Checking official history...`);
            
            const userFlights = await getUserFlightHistory(userId, 1);
            const completedFlight = userFlights.find(f => f.id === lastFlightId);

            // Stricter validation logic as requested.
            // Flight must exist, have duration >= 30m, and landingCount === 1.
            const flightTime = completedFlight?.totalTime;
            const landings = completedFlight?.landingCount;
            const isDurationValid = typeof flightTime === 'number' && flightTime >= 30;
            const isLandingCountValid = typeof landings === 'number' && landings === 1;

            if (completedFlight && isDurationValid && isLandingCountValid) {
              
              // SUCCESS: Flight is 100% confirmed as LANDED
              landingConfirmed = true;
              method = 'user_history';
              officialDurationMs = (completedFlight.totalTime || 0) * 60 * 1000; // minutes to ms
              officialEndTime = completedFlight.created; // Official landing time
              
              t.history.push({ 
                event: 'fetch_history_success', 
                message: `Official history CONFIRMED landing. Duration: ${Math.round(officialDurationMs/60000)}m, Landings: 1.`, 
                timestamp: now,
                data: completedFlight 
              });
              if (TRACK_LOG) console.log(`[track] ${t.username} official history CONFIRMED landing. Duration ${officialDurationMs}ms.`);

              // Now, we run route analysis *only to get airport data*
              // This does NOT confirm the landing, it only enriches the data.
              try {
                const route = await getFlightRoute(t.lastKnownFlight.sessionId, lastFlightId);
                const simplifiedRoute = simplifyFlightRoute(route);
                const flightAnalysis = calculateFlightDurationFromRoute(simplifiedRoute, airports);
                
                takeoffAirport = flightAnalysis.takeoffAirport; 
                landingAirport = flightAnalysis.landingAirport;
                officialStartTime = flightAnalysis.takeoffPoint?.timestamp; // Use route takeoff time

                t.history.push({ event: 'analysis_for_airports', message: `Route analysis ran to find airports. Takeoff: ${takeoffAirport?.icao || 'N/A'}, Landing: ${landingAirport?.icao || 'N/A'}.`, timestamp: now });
              } catch (routeError) {
                t.history.push({ event: 'analysis_for_airports_fail', message: `Route analysis for airports failed (${routeError.message}). Airports will be unknown.`, timestamp: now });
                if (TRACK_LOG) console.warn(`[track] ${t.username} route analysis for airports failed: ${routeError.message}`);
              }
            } else {
              // Detailed failure reasoning for the log
              let reason = 'Flight not found in history.';
              if (completedFlight) {
                // Flight was found, but failed the new checks.
                reason = `Flight found but failed validation. Duration: ${flightTime}m (Req: >=30, Pass: ${isDurationValid}). Landings: ${landings} (Req: 1, Pass: ${isLandingCountValid}).`;
              }
                
              t.history.push({ 
                event: 'fetch_history_fail', 
                message: `${reason} Will continue polling.`, 
                timestamp: now,
                data: completedFlight || null
              });
              if (TRACK_LOG) console.warn(`[track] ${t.username} flight ${lastFlightId} failed history check: ${reason}`);
            }
          } catch (historyError) {
            t.history.push({ event: 'fetch_history_error', message: `Failed to fetch user history: ${historyError.message}. Will continue polling.`, timestamp: now });
            if (TRACK_LOG) console.error(`[track] ${t.username} failed to fetch user history: ${historyError.message}`);
          }
        } else {
            t.history.push({ event: 'fetch_history_skip', message: 'No userId available. Cannot check official history. Will continue polling.', timestamp: now });
            if (TRACK_LOG) console.warn(`[track] ${t.username} has no userId. Cannot check history.`);
        }


        // 2. FALLBACK TO ROUTE ANALYSIS (REMOVED)
        // This block has been intentionally removed as per the new logic.
        // We no longer use route analysis to confirm a landing.


        // 3. FINAL DECISION: Notify or Continue Polling
        if (landingConfirmed) {
          if (!landingAirport) landingAirport = { icao: 'UNKN', name: 'Unknown' };
          if (!takeoffAirport) takeoffAirport = { icao: 'UNKN', name: 'Unknown' };

          // LANDING CONFIRMED. Stop the tracker.
          t.status = 'landed'; 

          const landedMsg = `LANDED (via ${method}) at ${landingAirport.icao}. Duration: ${Math.round(officialDurationMs/60000)}m. Stopping tracker.`;
          t.history.push({ event: 'landed', message: landedMsg, timestamp: now, airport: landingAirport.icao, method: method });

          if (TRACK_LOG) console.log(`[track] LANDED ${t.username} at ${landingAirport.icao}. Duration: ${Math.round(officialDurationMs/60000)}m (method: ${method}). Stopping tracker.`);
          
          notifyCallback(t, {
            reason: 'flight_landed',
            flightDurationMs: officialDurationMs,
            takeoffDetails: {
              airport: takeoffAirport, 
              timestamp: officialStartTime,
            },
            landingDetails: {
              airport: landingAirport, 
              timestamp: officialEndTime,
            }
          });

          trackers.set(t.id, t);
          continue; // move to next tracker
        }
        
        // -----------------------------------------------------------------
        // CRITICAL: Landing check failed.
        // DO NOT change status. It remains 'tracking'.
        // -----------------------------------------------------------------
        
        const offlineMsg = `User is OFFLINE. Landing not yet confirmed via User History. Continuing to poll for ${lastFlightId}.`;
        if (t.history.at(-1)?.event !== 'offline_polling') { // Avoid spamming log
           t.history.push({ event: 'offline_polling', message: offlineMsg, timestamp: now });
           if (TRACK_LOG) console.log(`[track] OFFLINE ${t.username}. Status remains 'tracking', polling for ${lastFlightId}.`);
        }
        
        // --- END: "POST-LOCK" OFFLINE LOGIC ---
        
        // ⬆️ ⬆️ T END OF THE MODIFIED BLOCK ⬆️ ⬆️ ⬆️
        
      } else {
        // --- START: "PRE-LOCK" OFFLINE LOGIC ---
        // The tracker is still 'searching' and hasn't found the user.
        // This is fine. It remains 'searching'.
         const searchingMsg = `User not found. Continuing search.`;
         if (t.history.at(-1)?.event !== 'searching') {
            t.history.push({ event: 'searching', message: searchingMsg, timestamp: now });
         }
         // t.status remains 'searching'
         // --- END: "PRE-LOCK" OFFLINE LOGIC ---
      }


      // ---------------------------------
      // TIMEOUT & NEXT POLL LOGIC
      // (Applies to both 'searching' and 'tracking' states)
      // ---------------------------------
      
      // Preserve last known flight in t.flight for frontend display
      if (!t.flight && t.lastKnownFlight) {
        t.flight = {
          flightId: t.lastKnownFlight.flightId,
          sessionId: t.lastKnownFlight.sessionId,
          lastSeenAt: t.lastSeenAt || now
        };
      }

      // Intelligent next poll schedule based on how recently we saw the user
      let nextInterval = POLL_MS;
      const timeSinceSeen = now - (t.lastSeenAt || t.startedAt);
      if (timeSinceSeen < 15 * 60 * 1000) { // <15m
        nextInterval = 2 * 60 * 1000; // 2m
      } else if (timeSinceSeen < 6 * 60 * 60 * 1000) { // <6h
        nextInterval = 15 * 60 * 1000; // 15m
      } else {
        nextInterval = 60 * 60 * 1000; // 1h
      }
      t.nextPollAt = now + nextInterval;

      // Check for final timeout
      if (now >= t.timeoutAt) {
        // Tracker timed out. Stop it.
        t.status = 'not_found';
        t.history.push({ event: 'timeout', message: `Search TIMEOUT exceeded (${SEARCH_TIMEOUT_MS / (60 * 60 * 1000)}h). Stopping tracker.`, timestamp: now });
        if (TRACK_LOG) console.log(`[track] TIMEOUT ${t.username} on ${t.server}`);
        notifyCallback(t, { reason: `timeout_${SEARCH_TIMEOUT_MS / (60 * 60 * 1000)}h` });
      } else {
         // Log the next poll time
         if (TRACK_LOG) {
           const willTimeoutAt = new Date(t.timeoutAt).toISOString();
           console.log(`[track] ${t.status} ${t.username}, next poll in ${nextInterval/60000}m (will timeout at ${willTimeoutAt})`);
         }
      }

      // persist updated tracker
      trackers.set(t.id, t);
    } // end for each tracker in group
  } // end for each server group
}


// This is the original poller loop for the tracking engine
// ... (this function is unchanged) ...
(function runPoller() {
  pollOnce()
    .catch(e => {
      // Log any errors from this poll run
      if (TRACK_LOG) console.error('[track] pollOnce error', e?.message);
    })
    .finally(() => {
      // Schedule the *next* poll only after this one is complete
      // It uses the (now 30-second) POLL_MS variable
      setTimeout(runPoller, POLL_MS);
    });
})();


/* =========================
 * API Endpoints
 * ========================= */
app.get('/health', (req, res) => {
// ... (this function is unchanged) ...
  res.status(200).json({ ok: true, status: 'alive', timestamp: new Date().toISOString() });
});

app.get('/if-key-debug', (req, res) => {
// ... (this function is unchanged) ...
  const masked = IF_API_KEY ? `${IF_API_KEY.slice(0, 4)}...${IF_API_KEY.slice(-4)}` : '(missing)';
  res.json({
    ok: true,
    hasKey: !!IF_API_KEY,
    keyLength: IF_API_KEY.length,
    masked,
    headerPreview: IF_API_KEY ? `Bearer ${IF_API_KEY.slice(0, 4)}…` : null,
    baseURL: IF_API_BASE_URL
  });
});

/**
 * ⬇️ REPLACED FUNCTION
 * This endpoint now uses the cache-aware getSessions() function.
 */
app.get('/if-sessions', async (req, res) => {
  try {
    if (!IF_API_KEY) return res.status(500).json(err(500, 'INFINITE_FLIGHT_API_KEY is not set'));
    // This now uses the cache!
    const sessions = await getSessions();
    res.json({ ok: true, count: sessions?.length || 0, sessions, fromCache: (Date.now() - apiCache.lastSessionsUpdate < SESSIONS_CACHE_TTL_MS) });
  } catch (e) {
    const status = e?.response?.status || 500;
    res.status(status).json(err(status, 'Failed to fetch sessions', { detail: e?.message }));
  }
});

app.get('/if-sessions-test', async (req, res) => {
// ... (this function is unchanged, but benefits from getSessions() caching) ...
  try {
    if (!IF_API_KEY) return res.status(500).json(err(500, 'INFINITE_FLIGHT_API_KEY is not set'));
    const targetServer = (req.query.server || 'Expert Server').toString();
    const sessions = await getSessions(); // Will use cache
    const sessionId = pickSessionIdByName(sessions, targetServer);
    if (!sessionId) {
      return res.status(404).json(err(404, `Server not found: ${targetServer}`, { sessions }));
    }
    const flights = await getFlightsForSession(sessionId);
    res.json({
      ok: true,
      server: targetServer,
      sessionId,
      totalFlights: Array.isArray(flights) ? flights.length : 0,
      sample: flights?.slice(0, 3) || []
    });
  } catch (e) {
    const status = e?.response?.status || 500;
    const apiError = e?.response?.data;
    res.status(status).json(
      err(status, 'Failed to fetch flights for test', {
        apiErrorCode: apiError?.errorCode,
        apiErrorMessage: apiError?.result,
        detail: e?.message
      })
    );
  }
});

/**
 * ⬇️ REPLACED FUNCTION
 * This endpoint now reads from the flights cache first.
 */
app.get('/flights/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const callsignFilter = req.query.callsignEndsWith;

  // 1. Check cache first
  const cachedData = apiCache.flights.get(sessionId);
  if (cachedData) {
    let simplified = cachedData.flights; // Already simplified
    if (callsignFilter) {
      const suffix = callsignFilter.toUpperCase();
      simplified = simplified.filter(f =>
        f.callsign && f.callsign.toUpperCase().endsWith(suffix)
      );
    }
    return res.json({ ok: true, total: simplified.length, flights: simplified, fromCache: true });
  }

  // 2. Fallback to live fetch if not in cache
  if (TRACK_LOG) console.warn(`[api] /flights/${sessionId} cache miss. Fetching live.`);
  try {
    const flights = await getFlightsForSession(sessionId);
    let simplified = flights.map(simplifyFlight);
    if (callsignFilter) {
      const suffix = callsignFilter.toUpperCase();
      simplified = simplified.filter(f =>
        f.callsign && f.callsign.toUpperCase().endsWith(suffix)
      );
    }
    res.json({ ok: true, total: simplified.length, flights: simplified, fromCache: false });
  } catch (e) {
    const status = e?.response?.status || 500;
    res.status(status).json(err(status, 'Failed to fetch flights', { detail: e?.message }));
  }
});

app.get('/flights/:sessionId/:flightId/plan', async (req, res) => {
// ... (this function is unchanged) ...
  const { sessionId, flightId } = req.params;
  try {
    const rawPlan = await getFlightPlan(sessionId, flightId);
    if (!rawPlan) {
      return res.status(404).json(err(404, 'Flight plan not found. The flight may not exist or has no filed plan.'));
    }
    res.json({ ok: true, flightId, plan: rawPlan });
  } catch (e) {
    const status = e?.response?.status || 500;
    const apiError = e?.response?.data;
    res.status(status).json(
      err(status, 'Failed to fetch flight plan', {
        apiErrorCode: apiError?.errorCode,
        detail: e?.message
      })
    );
  }
});

app.get('/flights/:sessionId/:flightId/route', async (req, res) => {
// ... (this function is unchanged) ...
  const { sessionId, flightId } = req.params;
  try {
    const rawRoute = await getFlightRoute(sessionId, flightId);
    if (!rawRoute || rawRoute.length === 0) {
      return res.status(404).json(err(404, 'Flight route not found. The flight may not exist or has no position reports available.'));
    }
    res.json({ ok: true, flightId, route: rawRoute });
  } catch (e) {
    const status = e?.response?.status || 500;
    const apiError = e?.response?.data;
    res.status(status).json(
      err(status, 'Failed to fetch flight route', {
        apiErrorCode: apiError?.errorCode,
        detail: e?.message
      })
    );
  }
});

app.get('/atc/:sessionId', async (req, res) => {
// ... (this function is unchanged) ...
  const { sessionId } = req.params;
  try {
    const atcFacilities = await getActiveATC(sessionId);
    res.json({ ok: true, count: atcFacilities.length, atc: atcFacilities });
  } catch (e) {
    const status = e?.response?.status || 500;
    const apiError = e?.response?.data;
    res.status(status).json(
      err(status, 'Failed to fetch ATC facilities', {
        apiErrorCode: apiError?.errorCode,
        detail: e?.message
      })
    );
  }
});

app.get('/notams/:sessionId', async (req, res) => {
// ... (this function is unchanged) ...
  const { sessionId } = req.params;
  try {
    const notams = await getNotams(sessionId);
    res.json({ ok: true, count: notams.length, notams: notams });
  } catch (e) {
    const status = e?.response?.status || 500;
    const apiError = e?.response?.data;
    res.status(status).json(
      err(status, 'Failed to fetch NOTAMs', {
        apiErrorCode: apiError?.errorCode,
        detail: e?.message
      })
    );
  }
});

app.post('/users', async (req, res) => {
// ... (this function is unchanged) ...
  const { userIds, discourseNames, userHashes } = req.body;

  // Validate that at least one valid array is present in the request body
  if (
    (!Array.isArray(userIds) || userIds.length === 0) &&
    (!Array.isArray(discourseNames) || discourseNames.length === 0) &&
    (!Array.isArray(userHashes) || userHashes.length === 0)
  ) {
    return res.status(400).json(err(400, 'Request body must contain at least one of the following non-empty arrays: userIds, discourseNames, userHashes'));
  }

  try {
    const stats = await getUserStats({ userIds, discourseNames, userHashes });
    res.json({ ok: true, count: stats.length, users: stats });
  } catch (e) {
    const status = e?.response?.status || 500;
    const apiError = e?.response?.data;
    res.status(status).json(
      err(status, 'Failed to fetch user stats', {
        apiErrorCode: apiError?.errorCode,
        detail: e?.message
      })
    );
  }
});

app.get('/users/:userId/grade', async (req, res) => {
// ... (this function is unchanged) ...
  const { userId } = req.params;
  try {
    const gradeInfo = await getUserGrade(userId);
    if (!gradeInfo) {
      return res.status(404).json(err(404, 'User not found or has no grade information.'));
    }
    res.json({ ok: true, userId, gradeInfo });
  } catch (e) {
    const status = e?.response?.status || 500;
    const apiError = e?.response?.data;
    res.status(status).json(
      err(status, 'Failed to fetch user grade information', {
        apiErrorCode: apiError?.errorCode,
        detail: e?.message
      })
    );
  }
});


app.get('/track/active', (req, res) => {
// ... (this function is unchanged) ...
  const active = getActiveTrackers().map(t => ({
    id: t.id,
    username: t.username,
    server: t.server,
    status: t.status,
    startedAt: new Date(t.startedAt).toISOString(),
    lastSeenAt: t.lastSeenAt ? new Date(t.lastSeenAt).toISOString() : null,
    nextPollAt: t.nextPollAt ? new Date(t.nextPollAt).toISOString() : null,
    timeoutAt: new Date(t.timeoutAt).toISOString(),
    attempts: t.attempts
  }));
  res.json({ ok: true, count: active.length, trackers: active });
});

app.post('/track/start', async (req, res) => {
// ... (this function is unchanged) ...
  try {
    const created = addTrackers(req.body || {});
    if (!created.length) return res.status(400).json(err(400, 'username or usernames required'));
    res.json({
      ok: true,
      trackers: created.map(t => ({
        id: t.id,
        username: t.username,
        server: t.server,
        status: t.status,
        startedAt: new Date(t.startedAt).toISOString(),
        timeoutAt: new Date(t.timeoutAt).toISOString(),
      }))
    });
  } catch (e) {
    res.status(500).json(err(500, 'Failed to start tracker', { detail: e?.message }));
  }
});

app.get('/track/:id', (req, res) => {
// ... (this function is unchanged) ...
  const t = trackers.get(req.params.id);
  if (!t) return res.status(404).json(err(404, 'tracker not found'));
  res.json({ ok: true, tracker: {
    id: t.id,
    username: t.username,
    server: t.server,
    status: t.status,
    startedAt: new Date(t.startedAt).toISOString(),
    lastPolledAt: t.lastPolledAt ? new Date(t.lastPolledAt).toISOString() : null,
    lastSeenAt: t.lastSeenAt ? new Date(t.lastSeenAt).toISOString() : null,
    nextPollAt: t.nextPollAt ? new Date(t.nextPollAt).toISOString() : null,
    attempts: t.attempts,
    flight: t.flight,
    lastKnownFlight: t.lastKnownFlight,
    timeoutAt: new Date(t.timeoutAt).toISOString(),
    // ⬇️ MODIFIED: Ensure history is always sorted by timestamp (newest first for client)
    history: t.history
      .map(h => ({...h, timestamp: new Date(h.timestamp).toISOString()}))
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()),
  }});
});

app.post('/track/:id/stop', (req, res) => {
// ... (this function is unchanged, but logs to history) ...
  const t = trackers.get(req.params.id);
  if (!t) return res.status(44).json(err(404, 'tracker not found'));
  t.status = 'stopped';
  // ⬇️ MODIFIED: Add rich history message
  t.history.push({ event: 'stopped', message: 'Tracker stopped by manual API request.', timestamp: Date.now() });
  trackers.set(t.id, t);
  notifyCallback(t, { reason: 'stopped_by_request' });
  res.json({ ok: true, status: t.status });
});

app.post('/track/:id/delay', (req, res) => {
// ... (this function is unchanged, but logs to history) ...
  const t = trackers.get(req.params.id);
  if (!t) return res.status(404).json(err(404, 'tracker not found'));

  // Delay the next poll by 5 minutes from now
  const delayMs = 5 * 60 * 1000;
  t.nextPollAt = Date.now() + delayMs;
  
  // ⬇️ MODIFIED: Add rich history message
  t.history.push({ event: 'delayed', message: `Next poll delayed by 5 minutes via API.`, timestamp: Date.now() });
  trackers.set(t.id, t);
  
  res.json({ 
    ok: true, 
    status: t.status, 
    nextPollAt: new Date(t.nextPollAt).toISOString() 
  });
});

/* =========================
 * Startup
 * ========================= */

// ⬇️ 3. Change app.listen to httpServer.listen
httpServer.listen(PORT, () => {
  console.log(`✅ Live Flight Tracker (with Caching Sockets) ready: http://localhost:${PORT}`);
  console.log('🌐 Base URL:', IF_API_BASE_URL);
  console.log(`🔁 Tracking: poll=${POLL_MS}ms background=${BACKGROUND_POLL_MS}ms timeout=${SEARCH_TIMEOUT_MS / (60 * 60 * 1000)}h`);
  console.log(`📡 Broadcasting all flights every ${ALL_FLIGHTS_POLL_MS}ms (WARNING: 1000ms is still very fast!)`);
  console.log(`🛩️  Default IF Server: "${DEFAULT_IF_SERVER}"`);
  if (!IF_API_KEY) {
    console.warn('⚠️  IF API key is missing. Set INFINITE_FLIGHT_API_KEY in your .env file.');
  }
});