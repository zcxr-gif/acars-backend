// live_flights.js (Simplified: ACARS/Tracking Engine Removed)

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
    'https://inflight.info',        
    'https://deploy-preview-2--indgo-va.netlify.app',
    'https://site--indgo-backend--6dmjph8ltlhv.code.run'
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

const ALL_FLIGHTS_POLL_MS = parseInt(process.env.ALL_FLIGHTS_POLL_MS || '2000', 10);

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
  flights: new Map(), // sessionId -> { server, sessionId, count, flights, timestamp }
  lastSessionsUpdate: 0,
  // ⬇️ NEW: Add a cache for the VA pilot roster
  vaRosterCache: new Map(), // Stores { lowercase_username -> { role: '...' } }
};
// Cache sessions for 1 minute to prevent spamming the /sessions endpoint
const SESSIONS_CACHE_TTL_MS = 60 * 1000; 

/* =========================
 * Axios client
 * ========================= */
const ifClient = axios.create({
  baseURL: IF_API_BASE_URL,
  timeout: 15000,
  headers: {
    Authorization: `Bearer ${IF_API_KEY}`,
    Accept: 'application/json',
  },
});

/* =========================
 * Data Loaders (Aircraft & Liveries)
 * ========================= */
const aircraftNameMap = new Map(); // Map to store aircraft names (ID -> Name)
const liveryNameMap = new Map();   // Map to store livery names (ID -> Name)

// NEW: Global storage to serve via API
const globalMetadata = {
  aircraft: [],
  liveries: []
};

/**
 * Unified Metadata Loader
 * Fetches Aircraft first, then iterates through them to fetch all liveries.
 */
async function initSystemMetadata() {
  console.log('🔄 [init] Starting metadata load...');

  if (!IF_API_KEY) {
    console.warn('⚠️  [init] Skipping metadata load: API key is missing.');
    return;
  }

  // 1. Load Aircraft
  try {
    console.log('🔄 [init] Fetching aircraft list...');
    const aircraftList = await getAircraftList();
    
    globalMetadata.aircraft = aircraftList;
    
    // Update Map
    aircraftNameMap.clear();
    for (const a of aircraftList) {
      aircraftNameMap.set(a.id, a.name);
    }
    console.log(`✅ [init] Loaded ${aircraftList.length} aircraft models.`);

    // 2. Load Liveries (Iterate per aircraft)
    console.log(`🔄 [init] Fetching liveries for ${aircraftList.length} aircraft (this may take a moment)...`);
    
    const allLiveries = [];
    
    // We execute sequentially to be kind to the API rate limits
    for (const aircraft of aircraftList) {
        try {
            const liveries = await getLiveriesForAircraft(aircraft.id);
            allLiveries.push(...liveries);
        } catch (err) {
            console.warn(`⚠️  [init] Failed to load liveries for ${aircraft.name}: ${err.message}`);
        }
    }

    globalMetadata.liveries = allLiveries;

    // Update Map
    liveryNameMap.clear();
    for (const l of allLiveries) {
      liveryNameMap.set(l.id, l.name);
    }
    console.log(`✅ [init] Loaded ${allLiveries.length} total liveries.`);

  } catch (e) {
    console.error('❌ [init] Critical metadata load failure:', e.message);
  }
}

// Start the unified loader
initSystemMetadata();

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
  
  console.log('[va-roster] Fetching VA pilot roster...');

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
  const { data } = await ifClient.get('/aircraft');
  const items = unwrap(data);
  return items.map((a) => ({
    id: a?.id || null,
    name: a?.name || '',
  })).filter(a => a.id && a.name);
}

// NOTE: getLiveryList() has been removed in favor of getLiveriesForAircraft() below.

async function getLiveriesForAircraft(aircraftId) {
  if (!aircraftId) throw new Error('Missing aircraftId');
  
  const url = `/aircraft/${encodeURIComponent(aircraftId)}/liveries`;
  
  try {
    const { data } = await ifClient.get(url);
    const items = unwrap(data);
    
    return items.map((l) => ({
      id: l?.id || null,
      name: l?.liveryName || '',
      aircraftId: l?.aircraftID || null, // API returns 'aircraftID'
      aircraftName: l?.aircraftName || ''
    })).filter(l => l.id && l.name);

  } catch (e) {
    // Standard retry logic for 401/403 errors
    const status = e?.response?.status;
    if (status === 401 || status === 403) {
      const { data: retry } = await ifClient.get(url, { params: { apikey: IF_API_KEY } });
      const items = unwrap(retry);
      return items.map((l) => ({
        id: l?.id || null,
        name: l?.liveryName || '',
        aircraftId: l?.aircraftID || null,
        aircraftName: l?.aircraftName || ''
      })).filter(l => l.id && l.name);
    }
    // If 404, it might mean the aircraft ID is invalid or has no liveries exposed
    if (status === 404) {
      return [];
    }
    throw e;
  }
}

/**
 * ⬇️ REPLACED FUNCTION
 * This function now uses the in-memory cache to avoid spamming the API.
 */
async function getSessions() {
  const now = Date.now();
  // 1. Check if cache is valid (not older than TTL and not empty)
  if (now - apiCache.lastSessionsUpdate < SESSIONS_CACHE_TTL_MS && apiCache.sessions.length > 0) {
    return apiCache.sessions;
  }
  
  console.log('[getSessions] Fetching fresh sessions from API.');
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

/* =========================
 * Socket.IO Connection Handling (NEW)
 * ========================= */
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
      console.warn(`[broadcast] No sessionId for server "${serverName}"`);
      continue; // Skip this server
    }

    const roomName = serverName.toLowerCase();
    // Check if anyone is listening
    const room = io.sockets.adapter.rooms.get(roomName);

    if (!room || room.size === 0) {
      // 😴 Skipping ${serverName}, no clients.
      apiCache.flights.delete(sessionId); // Clear stale data
      continue;
    }

    try {
      // This is the main API call we need to protect
      const rawFlights = await getFlightsForSession(sessionId);

      // ----------------------------------------------------
      // ⬇️ BUGSQUASH: HEURISTIC BLIP GUARD (v2) ⬇️
      // ----------------------------------------------------
      
      const newFlightCount = (Array.isArray(rawFlights) ? rawFlights.length : 0);
      const cachedData = apiCache.flights.get(sessionId);
      const cachedFlightCount = (cachedData && cachedData.count > 0) ? cachedData.count : 0;

      // A "blip" is defined as EITHER:
      // 1. Receiving 0 flights when we previously had flights.
      // 2. Receiving a new count that is less than 50% of our cached count
      //    (e.g., dropping from 500 to 249 or less), which is highly
      //    indicative of a temporary API data glitch.

      const isCompleteBlip = (newFlightCount === 0 && cachedFlightCount > 0);
      const isPartialBlip = (newFlightCount > 0 && cachedFlightCount > 0 && newFlightCount < (cachedFlightCount * 0.50));

      if (isCompleteBlip || isPartialBlip) {
        console.warn(`[broadcast] ⚠️  BLIP GUARD (v2): Received ${newFlightCount} flights for ${serverName}, but cache had ${cachedFlightCount}. This is a >50% drop. Skipping broadcast.`);
        continue; // Move to the next server, keeping the old (good) cache.
      }
      
      // If we are here, it's a valid update:
      // - The API returned a good count.
      // - The API returned 0, and our cache was already 0 (server is empty).
      // - The API returned a new count that was a "normal" drop (e.g., 500 -> 480).

      // ----------------------------------------------------
      // ⬆️ BUGSQUASH: HEURISTIC BLIP GUARD (v2) ⬆️
      // ----------------------------------------------------

      const simplifiedFlights = rawFlights.map(simplifyFlight);
      
      const payload = {
        server: serverName,
        sessionId: sessionId,
        count: simplifiedFlights.length,
        flights: simplifiedFlights,
        timestamp: new Date().toISOString()
      };
      
      // 1. 🚀 UPDATE THE CACHE for other services (API)
      apiCache.flights.set(sessionId, payload);

      // 2. 📡 EMIT TO THE ROOM (if clients are present)
      if (room && room.size > 0) {
        io.to(roomName).emit('all_flights_update', payload);
        
        // console.log(`[broadcast] 📡 Sent ${simplifiedFlights.length} flights to ${room.size} client(s) for ${serverName}`);
      }

    } catch (e) {
      console.warn(`[broadcast] Flights fetch failed for "${serverName}"`, e?.message);
      
      // ⬇️ MODIFIED CATCH: Only delete cache/back off on 429
      if (e?.message?.includes('429')) {
          console.error(`[broadcast] 🛑 Flights API Rate Limit (429) detected. Backing off for 60 seconds.`);
          nextBroadcastPollMs = 60000; // 60s backoff
          // Clear cache on rate limit
          apiCache.flights.delete(sessionId); 
      }
      // For any other error (e.g., 500, 503, timeout), we'll
      // just log it and *keep the old cache* data. This also
      // helps prevent "disappearing icons" on a server-side API error.
    }
  }
}

(function runBroadcastPoller() {
  // 1. Record the start time *before* the poll
  const pollStartTime = Date.now();

  pollAndBroadcastFlights()
    .catch(e => {
        console.error('[broadcast] Unhandled poll error', e?.message);
         if (e?.message?.includes('429')) {
            console.error(`[broadcast] 🛑 Unhandled 429. Backing off for 60s.`);
            nextBroadcastPollMs = 60000; // 60 seconds
         }
    })
    .finally(() => {
      let timeToWait;

      // 2. Check if a backoff (e.g., 60000ms) was triggered by the poll function
      if (nextBroadcastPollMs !== ALL_FLIGHTS_POLL_MS) {
        // A backoff was triggered. We must honor it.
        timeToWait = nextBroadcastPollMs;
        console.log(`[broadcast] Backoff triggered. Waiting ${timeToWait}ms.`);
        
        // Reset the variable for the *next* cycle (after this one)
        nextBroadcastPollMs = ALL_FLIGHTS_POLL_MS;
      } else {
        // 3. NO backoff. Calculate the steady tick.
        const pollEndTime = Date.now();
        const executionTime = pollEndTime - pollStartTime;
        
        // This is our new "smart" wait time
        timeToWait = ALL_FLIGHTS_POLL_MS - executionTime;
        
        if (timeToWait <= 0) {
          // This means the poll took *longer* than our interval.
          // This is okay! It just means we run the next poll immediately
          // to try and "catch up" to the steady tick.
          console.warn(`[broadcast] ⚠️  Poll took ${executionTime}ms, longer than interval of ${ALL_FLIGHTS_POLL_MS}ms. Running next poll almost immediately.`);
          
          // We set a tiny 10ms buffer to prevent a 100% CPU "spin-lock"
          timeToWait = 10;
        }
      }
      
      // 4. Schedule the next poll using our calculated wait time
      setTimeout(runBroadcastPoller, timeToWait);
    });
})();


/* =========================
 * API Endpoints
 * ========================= */

app.get('/api/metadata', (req, res) => {
  res.json({
    ok: true,
    aircraft: globalMetadata.aircraft,
    liveries: globalMetadata.liveries
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true, status: 'alive', timestamp: new Date().toISOString() });
});

app.get('/if-key-debug', (req, res) => {
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
    res.json({ ok: true, count: sessions?.length || 0, sessions });
  } catch (e) {
    const status = e?.response?.status || 500;
    res.status(status).json(err(status, 'Failed to fetch sessions', { detail: e?.message }));
  }
});

app.get('/if-sessions-test', async (req, res) => {
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
  console.warn(`[api] /flights/${sessionId} cache miss. Fetching live.`);
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

// All /track/... endpoints have been removed.

/* =========================
 * Startup
 * ========================= */

// ⬇️ 3. Change app.listen to httpServer.listen
httpServer.listen(PORT, () => {
  console.log(`✅ Live Flight Broadcaster (Sockets) ready: http://localhost:${PORT}`);
  console.log('🌐 Base URL:', IF_API_BASE_URL);
  console.log(`📡 Broadcasting all flights every ${ALL_FLIGHTS_POLL_MS}ms`);
  if (!IF_API_KEY) {
    console.warn('⚠️  IF API key is missing. Set INFINITE_FLIGHT_API_KEY in your .env file.');
  }
});