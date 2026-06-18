/* =========================
 * Imports & setup
 * ========================= */

const { fileURLToPath } = require('url');
const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { updateFlightPath, getFlightPath, updateBatch } = require('./history.cjs');
const atcHistory = require('./atc_history.cjs');
require('dotenv').config();
const telemetry = require('./telemetry.cjs');
const metrics = require('./metrics.cjs');
const fleetAnalytics = require('./fleet_analytics.cjs');
const logoBlocklist = require('./airline_logo_blocklist.cjs');
const supabaseAuth = require('./supabase.cjs');
const watchlist = require('./watchlist.cjs');
const pushNotifications = require('./push.cjs');

// ⬇️ 1. IMPORT HTTP & SOCKET.IO
const { createServer } = require('http');
const { Server } = require('socket.io');

const app = express();
// ⬇️ 2. CREATE HTTP SERVER & ATTACH SOCKET.IO
const httpServer = createServer(app);
const whitelist = [
    'https://inflight.info',
    'https://site--indgo-backend--6dmjph8ltlhv.code.run',
    'https://site--acars-backend--6dmjph8ltlhv.code.run',
    "capacitor://inflight-secure",
    "https://discoverva.netlify.app",
    "http://localhost:8888"
];
// Pattern-matched origins. Netlify names every deploy preview
// https://deploy-preview-<N>--indgo-va.netlify.app where <N> is the PR number,
// so it changes on every PR. Matching the pattern lets all previews through
// without editing the whitelist each time.
const whitelistPatterns = [
    /^https:\/\/deploy-preview-\d+--indgo-va\.netlify\.app$/
];
const corsOptions = {
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);
        if (whitelist.indexOf(origin) !== -1 ||
            whitelistPatterns.some((re) => re.test(origin))) {
            callback(null, true);
        // Origin is in the whitelist, allow it
        } else {
            callback(new Error('Not allowed by CORS'));
        // Origin is not allowed
        }
    },
    optionsSuccessStatus: 200
};
// 1. Apply CORS to Socket.IO
const io = new Server(httpServer, {
  cors: corsOptions
});
// Airline-logo takedown blocklist for the Inflight app (see
// airline_logo_blocklist.cjs). Managed from the dashboard's "Logo Blocklist"
// tab. Registered BEFORE the whitelist CORS middleware on purpose:
// this endpoint is fully public and must answer every origin (capacitor://,
// curl, anything) with Access-Control-Allow-Origin: *.
app.options('/api/airline-logos/blocklist', cors({ origin: '*' }));
app.get('/api/airline-logos/blocklist', cors({ origin: '*' }), (req, res) => {
  let codes = [];
  try {
    codes = logoBlocklist.codes();
  } catch (e) {
    // A storage hiccup must never break the response — serve an empty list.
    console.error(`⚠️ Could not read airline logo blocklist: ${e.message}`);
  }
  res.set('Cache-Control', 'public, max-age=300');
  res.json(codes);
});

// Watchlist capabilities probe — public for the same reason as the blocklist
// endpoint above: the client probes it on boot from any origin, no auth.
watchlist.registerCapabilitiesRoute(app);

// 2. Apply CORS to Express (for API requests like /if-sessions)
app.use(cors(corsOptions));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Friends watchlist CRUD (Supabase-token authed) + APNs token registries.
// See watchlist.cjs / push.cjs / supabase.cjs.
watchlist.registerRoutes(app);
pushNotifications.registerRoutes(app, supabaseAuth.requireAuth);

// Diagnostics snapshot for the dashboard: IF API timing/errors, poller health,
// live cache sizes, socket counts and process memory. Read-only, cheap to call.
app.get('/api/admin/diagnostics', (req, res) => {
  const rooms = {};
  try {
    for (const [name, set] of io.sockets.adapter.rooms) {
      // Skip the implicit per-socket rooms (named after the socket id).
      if (!io.sockets.sockets.has(name)) rooms[name] = set.size;
    }
  } catch (_) { /* adapter not ready */ }

  res.json({
    ok: true,
    data: metrics.snapshot({
      sockets: {
        connected: io.engine ? io.engine.clientsCount : 0,
        rooms,
      },
      cache: {
        sessions: apiCache.sessions.length,
        flights: apiCache.flights.size,
        secondary: apiCache.secondary.size,
        flightRouting: apiCache.flightRouting.size,
        vaRoster: apiCache.vaRosterCache.size,
        tracks: apiCache.tracks.length,
        lastRedisSave: apiCache.lastRedisSave.size,
        lastSessionsUpdateMsAgo: apiCache.lastSessionsUpdate
          ? Date.now() - apiCache.lastSessionsUpdate
          : null,
      },
      config: {
        activePollMs: ACTIVE_POLL_MS,
        idlePollMs: IDLE_POLL_MS,
        secondaryActiveMs: SECONDARY_ACTIVE_MS,
        secondaryIdleMs: SECONDARY_IDLE_MS,
      },
    }),
  });
});

// Telemetry Middleware: Track all incoming HTTP requests
app.use((req, res, next) => {
    // Only track actual API hits, ignore static file polling if needed
    if (req.path.startsWith('/api/') || req.path.startsWith('/if-') || req.path.startsWith('/flights/')) {
        // req.ip works best if 'trust proxy' is enabled in Express for reverse proxies (like NGINX/Cloudflare)
        telemetry.recordApiHit(req.headers['x-forwarded-for'] || req.socket.remoteAddress);
    }
    next();
});
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
const ACTIVE_POLL_MS = 15000; // 10 seconds (User connected)
const IDLE_POLL_MS = 35000;   // 30 seconds (No users)

const SECONDARY_ACTIVE_MS = 50000;
// 30 seconds (User connected)
const SECONDARY_IDLE_MS = 120000;   // 120 seconds (No users)

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
  tracks: [],
  secondary: new Map(), // sessionId -> { atc: [], notams: [], world: [], timestamp: ... }
  flightRouting: new Map(),
  lastSessionsUpdate: 0,
  // ⬇️ NEW: Add a cache for the VA pilot roster
  vaRosterCache: new Map(), // Stores { lowercase_username -> { role: '...' } }
  lastRedisSave: new Map(),
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
// Time every Infinite Flight API call (per-endpoint avg/p95/max + errors) so
// the dashboard Diagnostics tab can surface what's slow / where it's choking.
metrics.instrumentAxios(ifClient);
/* =========================
 * Axios 429 Interceptor (Exponential Backoff)
 * ========================= */
ifClient.interceptors.response.use(
  response => response,
  async (error) => {
    const config = error.config;
    if (error?.response?.status === 429) {
      config._retryCount = (config._retryCount || 0) + 1;
      const MAX_RETRIES = 4;
      if (config._retryCount <= MAX_RETRIES) {
        // Respect Retry-After header if provided, otherwise exponential backoff
        const retryAfterHeader = error.response.headers?.['retry-after'];
        
        const retryAfterMs = retryAfterHeader
          ? parseFloat(retryAfterHeader) * 1000
          : Math.min(1000 * Math.pow(2, config._retryCount), 32000);
        console.warn(`[if-api] ⏳ 429 Too Many Requests. Retry ${config._retryCount}/${MAX_RETRIES} in ${Math.round(retryAfterMs / 1000)}s.`);
        await new Promise(r => setTimeout(r, retryAfterMs));
        return ifClient(config);
      }
      console.error(`[if-api] 🛑 429 persisted after ${MAX_RETRIES} retries. Giving up.`);
    }
    return Promise.reject(error);
  }
);

/* =========================
 * Concurrency Limiter (for batch requests)
 * ========================= */
function createConcurrencyLimiter(maxConcurrent) {
  let active = 0;
  const queue = [];
  return function limit(fn) {
    return new Promise((resolve, reject) => {
      const run = async () => {
        active++;
        try { resolve(await fn()); }
        catch (e) { reject(e); }
        finally {
          active--;
          if (queue.length > 0) queue.shift()();
       
        }
      };
      active < maxConcurrent ? run() : queue.push(run);
    });
  };
}
// Max 3 concurrent route fetches to stay well under rate limits
const routeLimiter = createConcurrencyLimiter(3);
/* =========================
 * On-Demand TTL Cache (for per-request endpoints)
 * ========================= */
const onDemandCache = new Map();
// Hard ceiling so a burst of unique keys (userStats:<id>, airport:<icao>, …)
// between prunes can't grow the cache without bound.
const ON_DEMAND_MAX_ENTRIES = 5000;

function getOnDemandCached(key) {
  const entry = onDemandCache.get(key);
  if (entry && Date.now() < entry.expiresAt) return entry.data;
  onDemandCache.delete(key);
  return null;
}

function setOnDemandCached(key, data, ttlMs) {
  // Re-inserting moves the key to the end, keeping Map iteration order = LRU-ish.
  onDemandCache.delete(key);
  onDemandCache.set(key, { data, expiresAt: Date.now() + ttlMs });
  // Evict the oldest entries if we blew past the ceiling.
  if (onDemandCache.size > ON_DEMAND_MAX_ENTRIES) {
    const overflow = onDemandCache.size - ON_DEMAND_MAX_ENTRIES;
    let i = 0;
    for (const k of onDemandCache.keys()) {
      onDemandCache.delete(k);
      if (++i >= overflow) break;
    }
  }
}

// Periodically prune expired on-demand cache entries (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of onDemandCache.entries()) {
    if (now >= entry.expiresAt) onDemandCache.delete(key);
  }
}, 5 * 60 * 1000);
/* =========================
 * Data Loaders (Aircraft & Liveries)
 * ========================= */
const aircraftNameMap = new Map();
// Map to store aircraft names (ID -> Name)
const liveryNameMap = new Map();
// Map to store livery names (ID -> Name)

// NEW: Global storage to serve via API
const globalMetadata = {
  aircraft: [],
  liveries: [],
  lastUpdated: null
};

/**
 * Loads aircraft + liveries from the IF API into the in-memory maps. Safe to
 * re-run at any time — used both at startup and by the manual refresh endpoint
 * (e.g. after IF ships new planes/liveries) so the backend never needs a
 * restart to pick them up. Fetches both lists first and only swaps the shared
 * maps once both succeed, so a failed refresh can't leave them half-populated.
 */
// Wrap an upstream-list fetch so a failure says *which* list broke and carries
// the IF API HTTP status — turning a vague "refresh failed" into something
// actionable on the dashboard.
function tagListError(label) {
  return (e) => {
    const status = e?.response?.status;
    const msg = status
      ? `${label} fetch failed: IF API HTTP ${status}`
      : `${label} fetch failed: ${e?.message || 'unknown error'}`;
    const wrapped = new Error(msg);
    wrapped.response = e?.response;
    throw wrapped;
  };
}

async function loadMetadata(reason = 'startup') {
  metrics.recordTaskStart('metadata-refresh');

  if (!IF_API_KEY) {
    console.warn('⚠️ Skipping metadata load: API key is missing.');
    const e = new Error('IF API key is missing — set INFINITE_FLIGHT_API_KEY.');
    metrics.recordTaskFailure('metadata-refresh', e);
    throw e;
  }

  console.log(`⏳ Loading aircraft and liveries (${reason})...`);

  try {
    const [aircraftList, liveryList] = await Promise.all([
      getAircraftList().catch(tagListError('Aircraft')),
      getAllLiveries().catch(tagListError('Liveries')),
    ]);

    globalMetadata.aircraft = aircraftList;
    aircraftNameMap.clear();
    for (const aircraft of aircraftList) aircraftNameMap.set(aircraft.id, aircraft.name);

    globalMetadata.liveries = liveryList;
    liveryNameMap.clear();
    for (const livery of liveryList) liveryNameMap.set(livery.id, livery.name);

    globalMetadata.lastUpdated = Date.now();

    console.log(`✅ Loaded ${aircraftNameMap.size} aircraft types and ${liveryNameMap.size} liveries (${reason}).`);
    const result = {
      aircraft: aircraftNameMap.size,
      liveries: liveryNameMap.size,
      lastUpdated: globalMetadata.lastUpdated,
      reason,
    };
    metrics.recordTaskSuccess('metadata-refresh', result);
    return result;
  } catch (e) {
    console.error(`❌ Metadata load failed (${reason}): ${e.message}`);
    metrics.recordTaskFailure('metadata-refresh', e);
    throw e;
  }
}

// Concurrency guard: collapse overlapping refreshes (e.g. impatient button
// presses) onto a single in-flight fetch.
let metadataRefreshInFlight = null;
function refreshMetadata(reason = 'manual') {
  if (metadataRefreshInFlight) return metadataRefreshInFlight;
  metadataRefreshInFlight = loadMetadata(reason).finally(() => {
    metadataRefreshInFlight = null;
  });
  return metadataRefreshInFlight;
}

// Initial load at startup. Non-fatal: the server still boots if IF is down.
loadMetadata('startup').catch(e => console.error('❌ Could not load metadata.', e.message));
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

/**
 * ⬇️ NEW: Batch Fetcher for Routes
 * Fetches routes for multiple flight IDs in parallel.
 * Returns a map: { [flightId]: routeData[] }
 * If a specific flight fails (e.g. 404), it returns null for that ID instead of crashing.
 */
async function getBatchFlightRoutes(sessionId, flightIds) {
  if (!sessionId) throw new Error('Missing sessionId');
  if (!Array.isArray(flightIds) || flightIds.length === 0) return {};
  const results = {};
  
  // Throttle to max 3 concurrent requests to avoid rate limiting
  const promises = flightIds.map((flightId) =>
    routeLimiter(async () => {
      try {
        const rawRoute = await getFlightRoute(sessionId, flightId);
        results[flightId] = simplifyFlightRoute(rawRoute);
      } catch (e) {
        results[flightId] = null;
      }
    })
  );
  // Wait for all requests to finish (whether success or fail)
  await Promise.allSettled(promises);
  
  return results;
}

function unwrap(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.result)) return data.result;
  return data.result ??
  data.items ?? [];
}

function err(status, message, extra = {}) {
  return { ok: false, error: { status, message, ...extra } };
}

/**
 * Race a promise against a wall-clock timeout. Used to bound slow upstream
 * calls (e.g. the IF metadata refresh) so an HTTP handler always responds with
 * clean JSON *before* a reverse proxy / platform gateway gives up and returns
 * its own non-JSON error page — which is what made the dashboard surface the
 * opaque "The string did not match the expected pattern" parse error.
 */
function withTimeout(promise, ms, label = 'operation') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`${label} timed out after ${Math.round(ms / 1000)}s`);
      e.code = 'ETIMEDOUT';
      reject(e);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}


/* =========================
 * IF API Wrappers
 * ========================= */

/* =========================
 * NAT Tracks Logic
 * ========================= */

/**
 * Fetches the current Oceanic Tracks from the Infinite Flight API
 */
async function getOceanicTracks() {
  const url = '/tracks';
  try {
    const { data } = await ifClient.get(url);
    // Validate response and check for errorCode 0 (Ok)
    const payload = data && typeof data === 'object' ?
    data : {};
    if (typeof payload.errorCode === 'number' && payload.errorCode !== 0) {
       throw new Error(`IF API errorCode ${payload.errorCode}`);
    }

    const items = unwrap(data);
    
    // Map the response to the OceanicTrack schema
    return items.map(track => ({
      name: track.name,           // Usually letters like 'A', 'B'
      path: track.path,           // Array of waypoints/coordinates 
      eastLevels: track.eastLevels, // Altitudes for eastbound flight 
      westLevels: track.westLevels, // Altitudes for westbound flight
      type: track.type, 
      // Usually "North Atlantic Tracks"
      lastSeen: track.lastSeen     // Last update timestamp
    }));
  } catch (e) {
    // Retry with query param if Authorization header fails
    if (e?.response?.status === 401 || e?.response?.status === 403) {
      const { data: retry } = await ifClient.get(url, { params: { apikey: IF_API_KEY } });
      return unwrap(retry);
    }
    throw e;
  }
}

/**
 * Refresh NAT tracks once every 24 hours
 */
(function runTracksPoller() {
  getOceanicTracks()
    .then(tracks => {
      apiCache.tracks = tracks;
      console.log(`✅ [tracks] Synchronized ${tracks.length} Oceanic Tracks.`);
    })
    .catch(e => console.error('[tracks] Sync failed:', e.message))
    .finally(() => {
      // 24 Hour Refresh (24h * 60m * 60s * 1000ms)
      const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
    
      setTimeout(runTracksPoller, TWENTY_FOUR_HOURS);
    });
})();

async function getAircraftList() {
  const { data } = await ifClient.get('/aircraft');
  const items = unwrap(data);
  return items.map((a) => ({
    id: a?.id || null,
    name: a?.name || '',
  })).filter(a => a.id && a.name);
}

// ⬇️ REPLACED: Get User Logbook mapping all properties properly
async function getUserLogbook(userId, page = 1) {
  if (!userId) throw new Error('Missing userId');
  const url = `/users/${encodeURIComponent(userId)}/flights`;
  const params = { page, apikey: IF_API_KEY };
  try {
    const { data } = await ifClient.get(url, { params });
    const payload = data && typeof data === 'object' ? data : {};
    if (typeof payload.errorCode === 'number' && payload.errorCode !== 0) {
       const err = new Error(`IF API errorCode ${payload.errorCode}`);
       err.response = { data: payload };
       throw err;
    }
    
    return payload.result || null;
  } catch (e) {
    const status = e?.response?.status;
    if (status === 401 || status === 403) {
      const { data: retry } = await ifClient.get(url, { params });
      const payload = retry && typeof retry === 'object' ? retry : {};
      if (typeof payload.errorCode === 'number' && payload.errorCode !== 0) {
         const err = new Error(`IF API errorCode ${payload.errorCode} (retry)`);
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

async function getLiveriesForAircraft(aircraftId) {
  if (!aircraftId) throw new Error('Missing aircraftId');
  // Use the specific endpoint for a single aircraft model
  const url = `/aircraft/${encodeURIComponent(aircraftId)}/liveries`;
  try {
    const { data } = await ifClient.get(url);
    // Use your existing unwrap helper to handle the response safely
    const items = unwrap(data);
    // Map the results to match your existing data structure
    return items.map((l) => ({
      id: l?.id || null,
      name: l?.liveryName || '',
      aircraftId: l?.aircraftID || aircraftId, // Note: API sometimes uses 'aircraftID' or 'aircraftId'
      aircraftName: l?.aircraftName || ''
    })).filter(l => l.id && l.name);
  } catch (e) {
    const status = e?.response?.status;
    // Retry logic for 401/403 (Token Expiry)
    if (status === 401 || status === 403) {
      const { data: retry } = await ifClient.get(url, { params: { apikey: IF_API_KEY } });
      const items = unwrap(retry);
      return items.map((l) => ({
        id: l?.id || null,
        name: l?.liveryName || '',
        aircraftId: l?.aircraftID || aircraftId,
        aircraftName: l?.aircraftName || ''
      })).filter(l => l.id && l.name);
    }
    
    // If the aircraft ID is invalid, return empty array instead of crashing
    if (status === 404) {
      return [];
    }
    
    throw e;
  }
}

async function getAirportInfo(icao) {
  if (!icao) throw new Error('Missing airport ICAO');
  
  const cleanIcao = icao.toUpperCase().trim();
  const url = `/airport/${encodeURIComponent(cleanIcao)}`;
  try {
    const { data } = await ifClient.get(url);
    const payload = data && typeof data === 'object' ? data : {};
    // Check if errorCode is not 0 (Ok)
    if (typeof payload.errorCode === 'number' && payload.errorCode !== 0) {
       const err = new Error(`IF API errorCode ${payload.errorCode}`);
       err.response = { data: payload };
       throw err;
    }

    // Return the 'result' object (AirportInfo)
    return payload.result ||
    null;

  } catch (e) {
    const status = e?.response?.status;
    // Standard retry logic for 401/403 (Token Expiry)
    if (status === 401 || status === 403) {
      const { data: retry } = await ifClient.get(url, { params: { apikey: IF_API_KEY } });
      const payload = retry && typeof retry === 'object' ? retry : {};
      if (typeof payload.errorCode === 'number' && payload.errorCode !== 0) {
         const err = new Error(`IF API errorCode ${payload.errorCode} (query param)`);
         err.response = { data: payload };
         throw err;
      }

      return payload.result || null;
    }

    // If API returns 404, it means the airport doesn't exist
    if (status === 404) {
      return null;
    }
    
    throw e;
  }
}

async function getAirportAtis(sessionId, icao) {
  if (!sessionId || !icao) throw new Error('Missing sessionId or airport ICAO');
  const cleanIcao = icao.toUpperCase().trim();
  const url = `/sessions/${encodeURIComponent(sessionId)}/airport/${encodeURIComponent(cleanIcao)}/atis`;
try {
    const { data } = await ifClient.get(url);
    const payload = data && typeof data === 'object' ? data : {};
    if (typeof payload.errorCode === 'number' && payload.errorCode !== 0) {
       // errorCode 7 means "NoAtisAvailable"
       // We return null strictly for this case, so it's not treated as a crash.
       if (payload.errorCode === 7) {
         return null;
       }

       const err = new Error(`IF API errorCode ${payload.errorCode}`);
       err.response = { data: payload };
       throw err;
    }

    // Return the 'result' string (The ATIS message)
    return payload.result ||
    null;

  } catch (e) {
    const status = e?.response?.status;
    // Standard retry logic for 401/403 (Token Expiry)
    if (status === 401 || status === 403) {
      const { data: retry } = await ifClient.get(url, { params: { apikey: IF_API_KEY } });
      const payload = retry && typeof retry === 'object' ? retry : {};
      if (typeof payload.errorCode === 'number' && payload.errorCode !== 0) {
         if (payload.errorCode === 7) return null;
         // Handle "No ATIS" on retry as well

         const err = new Error(`IF API errorCode ${payload.errorCode} (query param)`);
         err.response = { data: payload };
         throw err;
      }

      return payload.result || null;
    }

    // If API returns 404, the session or endpoint might be invalid
    if (status === 404) {
      return null;
    }
    
    throw e;
  }
}

async function getAirportStatus(sessionId, icao) {
  if (!sessionId || !icao) throw new Error('Missing sessionId or airport ICAO');
  const cleanIcao = icao.toUpperCase().trim();
  const url = `/sessions/${encodeURIComponent(sessionId)}/airport/${encodeURIComponent(cleanIcao)}/status`;
try {
    const { data } = await ifClient.get(url);
    const payload = data && typeof data === 'object' ? data : {};
    // Check if errorCode is not 0 (Ok) 
    if (typeof payload.errorCode === 'number' && payload.errorCode !== 0) {
       // errorCode 5 is ServerNotFound, 6 is FlightNotFound, etc. 
       const err = new Error(`IF API errorCode ${payload.errorCode}`);
       err.response = { data: payload };
       throw err;
    }

    // Return the 'result' object (AirportStatus) which contains inboundFlights, atcFacilities, etc.
    return payload.result ||
    null;

  } catch (e) {
    const status = e?.response?.status;
    // Standard retry logic for 401/403 (Token Expiry)
    if (status === 401 || status === 403) {
      const { data: retry } = await ifClient.get(url, { params: { apikey: IF_API_KEY } });
      const payload = retry && typeof retry === 'object' ? retry : {};
      if (typeof payload.errorCode === 'number' && payload.errorCode !== 0) {
         const err = new Error(`IF API errorCode ${payload.errorCode} (query param)`);
         err.response = { data: payload };
         throw err;
      }

      return payload.result || null;
    }

    // If API returns 404, it might mean the session or airport is invalid in this context
    if (status === 404) {
      return null;
    }
    
    throw e;
  }
}

async function getAllLiveries() {
  const url = '/aircraft/liveries';
  try {
    const { data } = await ifClient.get(url);
    const items = unwrap(data);
    // Map the results according to the 'LiveryData' definition you provided
    return items.map((l) => ({
      id: l?.id || null,
      name: l?.liveryName || '',
      aircraftId: l?.aircraftID || null, // Note: API doc says 'aircraftID' (capital D)
      aircraftName: l?.aircraftName || ''
    })).filter(l => l.id && l.name);
  } catch (e) {
    const status = e?.response?.status;
    // Standard retry logic for 401/403 (Token Expiry)
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
    
    throw e;
  }
}

/**
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
    return Array.isArray(payload.result) ?
    payload.result : (Array.isArray(data) ? data : []);
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
      return Array.isArray(payload.result) ?
      payload.result : (Array.isArray(retry) ? retry : []);
    }
    throw e;
  }
}


function simplifyFlight(f, sessionId) {
  const aircraftId = f?.aircraftId || null;
  const liveryId = f?.liveryId || null;
  const username = f?.username || null;
  const flightId = f?.flightId || null;
  // Resolve readable names from maps
  const aircraftName = aircraftNameMap.get(aircraftId) || null;
  const liveryName = liveryNameMap.get(liveryId) || null;
  // Simple VA Roster Check (No grouping logic)
  const profile = username ? apiCache.vaRosterCache.get(username.toLowerCase()) : null;
  const isVAMember = !!profile;
  const vaRole = profile?.role || null;
  const isStaff = vaRole ? VA_STAFF_ROLES.includes(vaRole.toLowerCase()) : false;
  // ⬇️ NEW: Grab routing info from our persistent cache
  let arrivalIcao = f?.arrivalIcao || null;
  let departureIcao = f?.departureIcao || null;

  if (sessionId && flightId && apiCache.flightRouting.has(sessionId)) {
      const sessionRouting = apiCache.flightRouting.get(sessionId);
      const routing = sessionRouting.get(flightId);
      if (routing) {
          arrivalIcao = routing.arrivalIcao ||
          arrivalIcao;
          departureIcao = routing.departureIcao || departureIcao;
      }
  }

  return {
    flightId: flightId,
    userId: f?.userId ||
    null,
    callsign: f?.callsign || '',
    username: username,
    virtualOrganization: f?.virtualOrganization ||
    null,
    arrivalIcao: arrivalIcao,  
    departureIcao: departureIcao, 
    isVAMember,
    isStaff,
    vaRole,
    position: {
      lat: typeof f?.latitude === 'number' ?
      f.latitude : null,
      lon: typeof f?.longitude === 'number' ?
      f.longitude : null,
      alt_ft: typeof f?.altitude === 'number' ?
      f.altitude : null,
      gs_kt: typeof f?.speed === 'number' ?
      f.speed : null,
      vs_fpm: typeof f?.verticalSpeed === 'number' ?
      f.verticalSpeed : null,
      heading_deg: typeof f?.heading === 'number' ?
      f.heading : null,
      lastReport: f?.lastReport || null,
      lastReportMs: f?.lastReport ?
      Date.parse(f.lastReport) || null : null,
    },
    aircraft: {
      aircraftId,
      liveryId,
      aircraftName,
      liveryName
    },
    pilotState: typeof f?.pilotState === 'number' ?
    f.pilotState : null,
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
    return { flightPlanId: plan?.flightPlanId ||
    null, waypoints: [] };
  }
  
  const waypoints = [];
  const extractWaypoints = (items) => {
    if (!Array.isArray(items)) return;
    // Safety check
    
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

/**
 * ⬇️ NEW: IF API Wrapper for World Status
 * GET /sessions/{sessionId}/world
 */
async function getWorldStatus(sessionId) {
  if (!sessionId) throw new Error('Missing sessionId');
  const url = `/sessions/${encodeURIComponent(sessionId)}/world`;
  
  try {
    const { data } = await ifClient.get(url);
    const payload = data && typeof data === 'object' ? data : {};
    if (typeof payload.errorCode === 'number' && payload.errorCode !== 0) {
      const err = new Error(`IF API errorCode ${payload.errorCode}`);
      err.response = { data: payload };
      throw err;
    }
    
    // Returns an array of AirportStatus objects
    return Array.isArray(payload.result) ?
    payload.result : [];

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

// ⬇️ REPLACED: getUserGrade mapped exactly to apis.txt
async function getUserGrade(userId) {
  if (!userId) throw new Error('Missing userId');
  const url = `/users/${encodeURIComponent(userId)}`;
  
  try {
    const { data } = await ifClient.get(url);
    const payload = data && typeof data === 'object' ? data : {};
    if (typeof payload.errorCode === 'number' && payload.errorCode !== 0) {
      if (payload.errorCode === 1) return null;
      // UserNotFound
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
        if (payload.errorCode === 1) return null;
        // UserNotFound
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

// ⬇️ NEW: getUserAtcSessions wrapper
async function getUserAtcSessions(userId, page = 1) {
  if (!userId) throw new Error('Missing userId');
  // GET /users/{userId}/atc
  const url = `/users/${encodeURIComponent(userId)}/atc`;
  const params = { page, apikey: IF_API_KEY };
  try {
    const { data } = await ifClient.get(url, { params });
    const payload = data && typeof data === 'object' ? data : {};
    if (typeof payload.errorCode === 'number' && payload.errorCode !== 0) {
       const err = new Error(`IF API errorCode ${payload.errorCode}`);
       err.response = { data: payload };
       throw err;
    }

    return payload.result || null;
  } catch (e) {
    const status = e?.response?.status;
    // Standard retry logic for 401/403
    if (status === 401 || status === 403) {
      const { data: retry } = await ifClient.get(url, { params });
      const payload = retry && typeof retry === 'object' ? retry : {};
      if (typeof payload.errorCode === 'number' && payload.errorCode !== 0) {
         const err = new Error(`IF API errorCode ${payload.errorCode} (retry)`);
         err.response = { data: payload };
         throw err;
      }
      return payload.result || null;
    }
    
    // UserNotFound might return 404
    if (status === 404) {
      return null;
    }
    
    throw e;
  }
}

// ⬇️ NEW: getUserAtcSessionDetails wrapper
async function getUserAtcSessionDetails(userId, atcSessionId) {
  if (!userId || !atcSessionId) throw new Error('Missing userId or atcSessionId');
  // GET /users/{userId}/atc/{atcSessionId}
  const url = `/users/${encodeURIComponent(userId)}/atc/${encodeURIComponent(atcSessionId)}`;
  
  try {
    const { data } = await ifClient.get(url);
    const payload = data && typeof data === 'object' ? data : {};
    if (typeof payload.errorCode === 'number' && payload.errorCode !== 0) {
       const err = new Error(`IF API errorCode ${payload.errorCode}`);
       err.response = { data: payload };
       throw err;
    }

    return payload.result || null;
  } catch (e) {
    const status = e?.response?.status;
    // Standard retry logic for 401/403 (Token Expiry)
    if (status === 401 || status === 403) {
      const { data: retry } = await ifClient.get(url, { params: { apikey: IF_API_KEY } });
      const payload = retry && typeof retry === 'object' ? retry : {};
      if (typeof payload.errorCode === 'number' && payload.errorCode !== 0) {
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
 * Socket.IO Connection Handling (FIXED)
 * ========================= */
io.on('connection', (socket) => {
  const alive = metrics.recordSocketConnect();
  const { peak, totalConnections } = metrics.socketStats();
  console.log(`[socket] ✅ Connected: ${socket.id} | alive=${alive} peak=${peak} total=${totalConnections}`);

  // watchlist_subscribe / watchlist_event handling (cleans up on disconnect).
  watchlist.attachSocket(socket);

  // Listen for a client to request a specific server's flight data
  socket.on('join_server_room', async (serverName) => {
    if (!serverName) return;
    
    // Normalize the requested room name
    const targetRoom = String(serverName).trim().toLowerCase();
    
    // Define the specific flight data rooms we manage
    const validServerRooms = ['expert server', 'training server', 'casual server'];

   
 // 1. LEAVE OLD ROOMS
 

    for (const room of socket.rooms) {
      if (validServerRooms.includes(room) && room !== targetRoom) {
        socket.leave(room);
        // console.log(`[socket] 👋 ${socket.id} left room: ${room}`);
      }
    }

    // 2. JOIN NEW ROOM
    socket.join(targetRoom);
    console.log(`[socket] 🚪 ${socket.id} joined room: ${targetRoom}`);
    // --- [PERFORMANCE FIX] ---
    // Immediately send the last known data from cache to THIS specific user.
    // This prevents the user from waiting for the next polling cycle (2-5s delay).
    try {
      // A. Get current sessions (Uses existing cache logic in getSessions)
      const sessions = await getSessions();
      // B. Find the ID for the server they just joined
      // Note: pickSessionIdByName handles fuzzy matching (e.g. "expert server" vs "Expert Server")
      const sessionId = pickSessionIdByName(sessions, serverName);
      if (sessionId) {
        // C. Send cached FLIGHTS
        const cachedFlights = apiCache.flights.get(sessionId);
        if (cachedFlights) {
          socket.emit('all_flights_update', cachedFlights);
          console.log(`[socket] 🚀 Fast-forwarded FLIGHTS to ${socket.id} for ${serverName}`);
        }

        // D. Send cached ATC/NOTAMS (Secondary) - NEW FIX
        const cachedSecondary = apiCache.secondary.get(sessionId);
        if (cachedSecondary) {
          socket.emit('secondary_data_update', cachedSecondary);
          console.log(`[socket] 🚀 Fast-forwarded ATC/NOTAMS to ${socket.id} for ${serverName}`);
        }
      }
    } catch (err) {
      console.warn(`[socket] Failed to send immediate cache for ${serverName}:`, err.message);
    }
    // --- [END FIX] ---
  });
  socket.on('disconnect', (reason) => {
    const remaining = metrics.recordSocketDisconnect(reason);
    console.log(`[socket] ❌ Disconnected: ${socket.id} | reason=${reason} alive=${remaining}`);
  });
});

// ⬇️ UPDATED: Dynamic poll interval logic
let nextBroadcastPollMs = 0;

async function pollAndBroadcastFlights() {
  let sessions = [];
  try {
    sessions = await getSessions();
  } catch (e) {
    console.warn('[broadcast] Sessions fetch failed', e?.message);
    if (e?.message?.includes('429')) nextBroadcastPollMs = 60000;
    return;
  }

  // ── Memory: evict cache entries for IF sessions that no longer exist.
  // IF rotates session GUIDs (e.g. when their servers restart). Without this,
  // apiCache.flights / secondary / flightRouting accumulate dead sessions for
  // the lifetime of the process.
  const liveSessionIds = new Set(
    (Array.isArray(sessions) ? sessions : []).map(s => s.id).filter(Boolean)
  );
  if (liveSessionIds.size > 0) {
    for (const cache of [apiCache.flights, apiCache.secondary, apiCache.flightRouting]) {
      for (const id of cache.keys()) {
        if (!liveSessionIds.has(id)) cache.delete(id);
      }
    }
  }

  // Active flight IDs across every server this cycle, so the save-throttle
  // tracker can be pruned ONCE against the union — instead of once per session
  // against a single session's flights, which wiped sibling sessions' entries
  // and defeated the 15s save throttle (forcing a DB write every cycle).
  const globalActiveFlightIds = new Set();

  const serverNames = ["Expert Server", "Training Server", "Casual Server"];

  for (const serverName of serverNames) {
    const sessionId = pickSessionIdByName(sessions, serverName);
    if (!sessionId) continue;
    
    const roomName = serverName.toLowerCase();
    const room = io.sockets.adapter.rooms.get(roomName);

    // Skip heavy API fetching if absolutely no one is listening to this server
    if (!room || room.size === 0) {
       // continue; 
    }

    try {
      const rawFlights = await getFlightsForSession(sessionId);
      
      // Blip Guard Logic
      const newFlightCount = (Array.isArray(rawFlights) ? rawFlights.length : 0);
      const cachedData = apiCache.flights.get(sessionId);
      const cachedFlightCount = (cachedData && cachedData.count > 0) ? cachedData.count : 0;
      
      if ((newFlightCount === 0 && cachedFlightCount > 0) || 
          (newFlightCount > 0 && cachedFlightCount > 0 && newFlightCount < (cachedFlightCount * 0.50))) {
        console.warn(`[broadcast] ⚠️ BLIP GUARD: Skipping ${serverName}`);
        continue;
      }

      const activeFlightIds = new Set();
      
      // ⬇️ NEW: Track active flights for memory cleanup
      if (Array.isArray(rawFlights)) {
        for (const f of rawFlights) {
            if (f.flightId) activeFlightIds.add(f.flightId);
        }
      }

      // Routing cache is per-session, so prune it against this session's active
      // flights right here.
      if (apiCache.flightRouting.has(sessionId)) {
          const sessionRouting = apiCache.flightRouting.get(sessionId);
          for (const cachedFlightId of sessionRouting.keys()) {
              if (!activeFlightIds.has(cachedFlightId)) {
                  sessionRouting.delete(cachedFlightId); // Clears routing data
              }
          }
      }

      // Feed this session's active flights into the global union; the save
      // tracker is pruned once, after every server has been processed.
      for (const id of activeFlightIds) globalActiveFlightIds.add(id);

      // Map and simplify flights
      const finalFlights = rawFlights.map(f => simplifyFlight(f, sessionId));
      
      const now = Date.now();
      
      // Filter flights for DB saving
      const flightsToSave = finalFlights.filter(f => {
        const lastSave = apiCache.lastRedisSave.get(f.flightId) || 0;
        if (now - lastSave >= 15000) {
          apiCache.lastRedisSave.set(f.flightId, now);
          return true;
        }
        return false;
      });

      const payload = {
        server: serverName,
        sessionId: sessionId,
        count: finalFlights.length,
        flights: finalFlights,
        timestamp: new Date().toISOString()
      };
      
      // Update Cache and Broadcast IMMEDIATELY (Prioritize the user experience)
      apiCache.flights.set(sessionId, payload);
      
      if (room && room.size > 0) {
        io.to(roomName).emit('all_flights_update', payload);
      }

      // ⬇️ OPTIMIZED: Non-blocking Database I/O
      // Push the database write to the end of the Node.js event queue. 
      // This ensures Socket.IO broadcasts instantly without waiting for SQLite to unlock/write.
      if (flightsToSave.length > 0) {
        setImmediate(() => {
            try {
                updateBatch(flightsToSave);
            } catch (dbError) {
                console.error(`[broadcast] ❌ Background DB batch update failed:`, dbError.message);
            }
        });
      }

    } catch (e) {
      console.warn(`[broadcast] Flights fetch failed for "${serverName}"`, e?.message);
      if (e?.message?.includes('429')) {
         nextBroadcastPollMs = 60000;
      }
    }
  }

  // ── Memory: prune the save-throttle tracker against the union of all active
  // flights. Only runs when we saw at least one server's flights this cycle, so
  // a total fetch failure can't wrongly wipe the whole tracker.
  if (globalActiveFlightIds.size > 0) {
    for (const trackedFlightId of apiCache.lastRedisSave.keys()) {
      if (!globalActiveFlightIds.has(trackedFlightId)) {
        apiCache.lastRedisSave.delete(trackedFlightId);
      }
    }
  }

  // Watchlist presence: diff this cycle's combined snapshot (every server, so
  // a friend going online on Casual still notifies a client watching Expert)
  // and emit watchlist_event / APNs pushes + Live Activity updates.
  try {
    watchlist.processSnapshot(apiCache.flights);
  } catch (e) {
    console.warn('[watchlist] ⚠️ Snapshot processing failed:', e?.message);
  }
}

(function runBroadcastPoller() {
  // 1. Record start time
  const pollStartTime = Date.now();

  pollAndBroadcastFlights()
    .catch(e => {
        console.error('[broadcast] Unhandled poll error', e?.message);
         if (e?.message?.includes('429')) {
            console.error(`[broadcast] 🛑 Unhandled 429. Backing off for 60s.`);
            nextBroadcastPollMs = 60000; 
         }
    })
   
    .finally(() => {
      // 2. Determine Dynamic Interval
      // Check how many users are connected to Socket.IO
      const connectedUsers = io.engine.clientsCount;
      const targetInterval = connectedUsers > 0 ? ACTIVE_POLL_MS : IDLE_POLL_MS;
      
      let timeToWait;

      // 3. Check if a major backoff (like 60s from a 429 error) was triggered
      if (nextBroadcastPollMs > targetInterval) {
      
        timeToWait = nextBroadcastPollMs;
        console.log(`[broadcast] Backoff triggered. Waiting ${timeToWait}ms.`);
        
        // Reset for the next cycle
        nextBroadcastPollMs = 0;
      } else {
        // 4. Calculate standard "steady tick"
        const pollEndTime = Date.now();
        const executionTime = pollEndTime - pollStartTime;
        
        timeToWait = targetInterval - executionTime;
        // If execution took longer than interval, run immediately (with tiny buffer)
        if (timeToWait <= 0) {
          timeToWait = 10;
        }
        
        // Debug log (optional - helpful to see it working)
        // console.log(`[broadcast] Users: ${connectedUsers} | Took: ${executionTime}ms | Next in: ${timeToWait}ms`);
        nextBroadcastPollMs = 0;
      }
      
      // 5. Schedule next run
      setTimeout(runBroadcastPoller, timeToWait);
});
})();

/* =========================
 * Secondary Data Poller (ATC, NOTAMs & World) - UPDATED
 * ========================= */
async function pollAndBroadcastSecondary() {
  let sessions = [];
  try {
    sessions = await getSessions();
  } catch (e) {
    return;
  }

  const serverNames = ["Expert Server", "Training Server", "Casual Server"];
  for (const serverName of serverNames) {
    const sessionId = pickSessionIdByName(sessions, serverName);
    if (!sessionId) continue;
    // ⬇️ NEW: Initialize session routing cache if it doesn't exist
    if (!apiCache.flightRouting.has(sessionId)) {
        apiCache.flightRouting.set(sessionId, new Map());
    }
    const sessionRouting = apiCache.flightRouting.get(sessionId);

    try {
      // Fetch ATC, NOTAMs, and World Status in parallel
      const [atc, notams, world] = await Promise.all([
        getActiveATC(sessionId).catch(() => []),
        getNotams(sessionId).catch(() => []),
        getWorldStatus(sessionId).catch(() => [])
      ]);

      // ⬇️ NEW: Persist this ATC snapshot into the controller-replay history.
      // Non-blocking so it never delays the broadcast (same pattern as flights).
      setImmediate(() => {
        try {
          atcHistory.updateAtcBatch(sessionId, atc);
        } catch (atcDbErr) {
          console.error('[secondary] ❌ ATC history update failed:', atcDbErr.message);
        }
      });

      // ⬇️ NEW: Process world data to map departures and arrivals into memory
      if (Array.isArray(world)) {
        for (const airport of world) {
          const icao = airport.airportIcao;
          if (!icao) continue;

          // Process Departures (Outbound)
          if (Array.isArray(airport.outboundFlights)) {
            for (const flightId of airport.outboundFlights) {
              if (!sessionRouting.has(flightId)) {
                sessionRouting.set(flightId, { departureIcao: null, arrivalIcao: null });
              }
              sessionRouting.get(flightId).departureIcao = icao;
            }
          }

          // Process Arrivals (Inbound)
          if (Array.isArray(airport.inboundFlights)) {
            for (const flightId of airport.inboundFlights) {
              if (!sessionRouting.has(flightId)) {
                sessionRouting.set(flightId, { departureIcao: null, arrivalIcao: null });
              }
              sessionRouting.get(flightId).arrivalIcao = icao;
            }
          }
        }
      }

      const payload = {
        server: serverName,
        sessionId: sessionId,
        atc: atc,
        notams: notams,
        world: world,
        timestamp: new Date().toISOString()
      };
      // 1. Update Cache
      apiCache.secondary.set(sessionId, payload);
      // 2. Broadcast to room
      const roomName = serverName.toLowerCase();
      const room = io.sockets.adapter.rooms.get(roomName);
      if (room && room.size > 0) {
          io.to(roomName).emit('secondary_data_update', payload);
      }

    } catch (e) {
      console.warn(`[secondary] Failed to update secondary data for ${serverName}`, e.message);
    }
  }
}

(function runSecondaryPoller() {
  const start = Date.now();
  
  pollAndBroadcastSecondary()
    .catch(e => console.error('[secondary] Poller error', e))
    .finally(() => {
      // 1. Determine Dynamic Interval
      const connectedUsers = io.engine.clientsCount;
      const targetInterval = connectedUsers > 0 ? SECONDARY_ACTIVE_MS : SECONDARY_IDLE_MS;

      // 2. Calculate execution time to keep the rhythm steady
      const duration = Date.now() - start;
      let timeToWait = targetInterval - duration;

 
      // Safety buffer
      if (timeToWait <= 0) timeToWait = 1000;

      setTimeout(runSecondaryPoller, timeToWait);
    });
})();
/* =========================
 * API Endpoints
 * ========================= */

// ⬇️ NEW ROUTE: Retrieve Telemetry Analytics for Dashboard
app.get('/api/admin/telemetry', (req, res) => {
    // Optional: Add a simple secret key check here to prevent public access
    // if (req.query.secret !== process.env.TRACK_WEBHOOK_SECRET) return res.status(403).json(err(403, 'Forbidden'));
    
    try {
        const days = parseInt(req.query.days || '7', 10);
        const stats = telemetry.getAnalytics(days);
        res.json({ ok: true, data: stats });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

/* =========================
 * Live Fleet Analytics
 * Aggregate the live flight cache (every server) into world-wide insight:
 * most-flown aircraft & liveries, busiest airports, server split, flight
 * phases and VA presence — plus historical trends from periodic snapshots.
 * ========================= */

// Current aggregate of everything in the air right now, computed on demand
// from the live cache. Cheap (a single pass over the cached flights).
function currentFleetSnapshot() {
  return fleetAnalytics.computeLiveSnapshot(Array.from(apiCache.flights.values()));
}

app.get('/api/analytics/live', (req, res) => {
  try {
    res.json({ ok: true, data: currentFleetSnapshot() });
  } catch (e) {
    res.status(500).json(err(500, 'Failed to compute live analytics', { detail: e.message }));
  }
});

app.get('/api/analytics/trends', (req, res) => {
  try {
    const days = parseInt(req.query.days || '7', 10);
    res.json({ ok: true, data: fleetAnalytics.getTrends(days) });
  } catch (e) {
    res.status(500).json(err(500, 'Failed to load analytics trends', { detail: e.message }));
  }
});

// ⬇️ REPLACED ROUTE: Get User Flights (Logbook)
app.get('/api/users/:userId/flights', async (req, res) => {
  const { userId } = req.params;
  const page = parseInt(req.query.page || '1', 10);

  try {
    const logbook = await getUserLogbook(userId, page);
    
    if (!logbook) {
      return res.status(404).json(err(404, 'User logbook not found or user does not exist.'));
    }

    // Exact mapping from apis.txt schema including missing booleans
    res.json({ 
      ok: true, 
     
  userId, 
      pageIndex: logbook.pageIndex,
      totalPages: logbook.totalPages,
      totalCount: logbook.totalCount,
      hasPreviousPage: logbook.hasPreviousPage,
      hasNextPage: logbook.hasNextPage,
      flights: logbook.data
    });

  } catch (e) {
    const status = e?.response?.status || 500;
    const apiError = e?.response?.data;
    
    res.status(status).json(
      err(status, 'Failed to fetch user flights', { 
        detail: e?.message,
 
        apiErrorCode: apiError?.errorCode 
      })
    );
}
});

// ⬇️ NEW ROUTE: Get User ATC Sessions (Paginated)
app.get('/api/users/:userId/atc', async (req, res) => {
  const { userId } = req.params;
  const page = parseInt(req.query.page || '1', 10);

  try {
    const atcSessions = await getUserAtcSessions(userId, page);
    
    if (!atcSessions) {
      return res.status(404).json(err(404, 'User ATC sessions not found or user does not exist.'));
    }

    res.json({ 
      ok: true, 
      userId, 
      page: atcSessions.pageIndex,
 
      totalPages: atcSessions.totalPages,
      totalCount: atcSessions.totalCount,
      data: atcSessions.data
    });

  } catch (e) {
    const status = e?.response?.status || 500;
    const apiError = e?.response?.data;
    
    res.status(status).json(
      err(status, 'Failed to fetch user ATC sessions', { 
        detail: e?.message,
        apiErrorCode: apiError?.errorCode 
      })
    );
  }
});

// ⬇️ MERGED ROUTE: Get User Stats (Grade Info + Extended Telemetry cool)
app.get('/api/users/:userId/stats', async (req, res) => {
  const { userId } = req.params;
  const cacheKey = `userStats:${userId}`;
  const cached = getOnDemandCached(cacheKey);
  
  if (cached) return res.json({ ok: true, userId: cached.userId || userId, stats: cached.stats, fromCache: true });
  
  try {
    // Fetch Grade info AND Global Stats in parallel to save time
    const [userGrade, userStatsArray] = await Promise.all([
      getUserGrade(userId),
      getUserStats({ userIds: [userId] }).catch(() => []) // Catch in case stats endpoint fails
    ]);
    
    if (!userGrade) {
      return res.status(404).json(err(404, 'User not found or has no stats/grade information.'));
    }
    
    // Extract the global stats object from the POST endpoint array
    const globalStats = userStatsArray?.[0] || {};
    
    const statsPayload = {
      virtualOrganization: userGrade.virtualOrganization,
      discourseUsername: userGrade.discourseUsername,
      groups: userGrade.groups,
      roles: userGrade.roles,
      gradeDetails: userGrade.gradeDetails,
      
      // Included the calculated grade fix from earlier
      calculatedGrade: userGrade.gradeDetails?.gradeIndex !== undefined 
        ? userGrade.gradeDetails.gradeIndex + 1 
        : (userGrade.gradeIndex !== undefined ? userGrade.gradeIndex + 1 : null),
        
      violationCountByLevel: userGrade.violationCountByLevel,
      totalXP: userGrade.totalXP,
      atcOperations: userGrade.atcOperations,
      atcRank: userGrade.atcRank,
      total12MonthsViolations: userGrade.total12MonthsViolations,
      lastLevel1ViolationDate: userGrade.lastLevel1ViolationDate,
      lastLevel2ViolationDate: userGrade.lastLevel2ViolationDate,
      lastLevel3ViolationDate: userGrade.lastLevel3ViolationDate,
      lastReportViolationDate: userGrade.lastReportViolationDate,
      
      // ⬇️ EXTENDED GLOBAL STATS (Now mapped correctly from the POST endpoint)
      flightTime: globalStats.flightTime || 0,
      landingCount: globalStats.landingCount || 0,
      onlineFlights: globalStats.onlineFlights || 0,
      violations: globalStats.violations || 0
    };

    // 5min TTL cache
    setOnDemandCached(cacheKey, { userId: userGrade.userId || userId, stats: statsPayload }, 5 * 60 * 1000);

    res.json({ ok: true, userId: userGrade.userId || userId, stats: statsPayload });

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

app.get('/api/flights/:flightId/history', async (req, res) => {
  try {
    // Optional watermark: clients pass the lastReportMs of their most recent
    // socket frame so the returned trail can't lead the live marker they're
    // drawing. Omitting it returns the full recorded path (backward compatible).
    const rawUntil = req.query.until;
    const untilMs = rawUntil !== undefined ? Number(rawUntil) : undefined;
    if (rawUntil !== undefined && !Number.isFinite(untilMs)) {
      return res.status(400).json({ ok: false, error: 'until must be a numeric millisecond timestamp' });
    }
    const path = await getFlightPath(req.params.flightId, untilMs);
    res.json({ ok: true, flightId: req.params.flightId, path });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================
 * ATC / Controller Replay
 * Search recorded controller sessions, then replay one to see the controller's
 * frequency timeline and the flights that were inside their airspace.
 * ========================= */

// Search recorded controller sessions.
// Query: ?user=<usernameSubstring>&userId=<id>&sessionId=<server guid>&since=<ms>&limit=<n>
app.get('/api/atc/sessions', (req, res) => {
  try {
    const sessions = atcHistory.getSessions({
      sessionId: req.query.sessionId,
      user: req.query.user,
      userId: req.query.userId,
      sinceMs: req.query.since ? parseInt(req.query.since, 10) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit, 10) : undefined
    });
    res.json({ ok: true, count: sessions.length, sessions });
  } catch (e) {
    res.status(500).json(err(500, 'Failed to fetch ATC sessions', { detail: e.message }));
  }
});

// Convenience: most recent recorded sessions (optionally scoped to a server).
app.get('/api/atc/sessions/recent', (req, res) => {
  try {
    const sessions = atcHistory.getSessions({
      sessionId: req.query.sessionId,
      limit: req.query.limit ? parseInt(req.query.limit, 10) : 50
    });
    res.json({ ok: true, count: sessions.length, sessions });
  } catch (e) {
    res.status(500).json(err(500, 'Failed to fetch recent ATC sessions', { detail: e.message }));
  }
});

// Full replay payload for one session: ?key=<userId:startTime>
app.get('/api/atc/replay', (req, res) => {
  const { key } = req.query;
  if (!key) return res.status(400).json(err(400, 'Missing session key'));
  try {
    const replay = atcHistory.getReplay(key);
    if (!replay) {
      return res.status(404).json(err(404, 'Session not found or outside the 48h replay window.'));
    }
    res.json({ ok: true, ...replay });
  } catch (e) {
    res.status(500).json(err(500, 'Failed to build ATC replay', { detail: e.message }));
  }
});
// ⬇️ NEW ROUTE: Batch Route Fetcher (The Fix)
// Usage: POST /api/flights/routes/batch
// Body: { "sessionId": "...", "flightIds": ["id1", "id2", "id3"] }
app.post('/api/flights/routes/batch', async (req, res) => {
  const { sessionId, flightIds } = req.body;

  if (!sessionId) {
    return res.status(400).json(err(400, 'Missing sessionId'));
  }
  if (!Array.isArray(flightIds) || flightIds.length === 0) {
    return res.status(400).json(err(400, 'Missing flightIds array'));
  }

  // Limit batch size to prevent massive server load
  if (flightIds.length > 20) {
     return res.status(400).json(err(400, 'Too many IDs. Max 20 per batch.'));
  }

  try {
  
  // 1. Fetch routes in parallel
    const routeMap = await getBatchFlightRoutes(sessionId, flightIds);

    // 2. Return the map
    res.json({
      ok: true,
      sessionId,
      count: Object.keys(routeMap).length,
      routes: routeMap
    });

  } catch (e) {
    const status = e?.response?.status ||
500;
    res.status(status).json(err(status, 'Failed to process batch routes', { detail: e?.message }));
  }
});
app.get('/api/metadata', (req, res) => {
  const refreshStatus = metrics.taskStats().find(t => t.name === 'metadata-refresh') || null;
  res.json({
    ok: true,
    aircraft: globalMetadata.aircraft,
    liveries: globalMetadata.liveries,
    counts: { aircraft: aircraftNameMap.size, liveries: liveryNameMap.size },
    lastUpdated: globalMetadata.lastUpdated,
    // So the dashboard can explain *why* counts look stale/empty.
    refreshStatus,
  });
});

// Manual refresh of aircraft & liveries — wire this to a "Refresh metadata"
// button so new IF planes/liveries are picked up without a backend restart.
// Optionally gated: if METADATA_REFRESH_SECRET is set, callers must pass it via
// the x-admin-secret header or ?secret= query param. Left open if unset so the
// button works out of the box.
app.post('/api/admin/refresh-metadata', async (req, res) => {
  const requiredSecret = process.env.METADATA_REFRESH_SECRET;
  if (requiredSecret) {
    const provided = req.get('x-admin-secret') || req.query.secret;
    if (provided !== requiredSecret) {
      return res.status(403).json(err(403, 'Forbidden: invalid or missing admin secret'));
    }
  }
  try {
    // Bound the refresh well under any platform gateway timeout so we always
    // return JSON. Without this, a slow IF API lets the proxy answer with an
    // HTML error page, and the dashboard's res.json() then throws the opaque
    // WebKit "The string did not match the expected pattern" SyntaxError.
    const result = await withTimeout(refreshMetadata('manual'), 25000, 'Metadata refresh');
    res.json({
      ok: true,
      message: `Refreshed ${result.aircraft} aircraft and ${result.liveries} liveries.`,
      ...result
    });
  } catch (e) {
    const ifStatus = e?.response?.status || null;
    const timedOut = e?.code === 'ETIMEDOUT';
    const status = timedOut ? 504 : 502;
    const message = timedOut
      ? 'Metadata refresh timed out — the Infinite Flight API was too slow. Please try again.'
      : 'Failed to refresh metadata from the IF API';
    console.error(`❌ /api/admin/refresh-metadata → ${status}: ${e.message}`);
    res.status(status).json(err(status, message, { detail: e.message, ifStatus }));
  }
});
// Manage the airline-logo takedown blocklist from the dashboard's
// "Logo Blocklist" tab. Optionally gated like /api/admin/refresh-metadata:
// if BLOCKLIST_ADMIN_SECRET is set, write calls must pass it via the
// x-admin-secret header or ?secret= query param. Left open if unset so the
// dashboard tab works out of the box.
function blocklistAdminAllowed(req, res) {
  const requiredSecret = process.env.BLOCKLIST_ADMIN_SECRET;
  if (!requiredSecret) return true;
  const provided = req.get('x-admin-secret') || req.query.secret;
  if (provided === requiredSecret) return true;
  res.status(403).json(err(403, 'Forbidden: invalid or missing admin secret'));
  return false;
}

app.get('/api/admin/airline-logo-blocklist', (req, res) => {
  try {
    const entries = logoBlocklist.entries();
    res.json({ ok: true, count: entries.length, entries });
  } catch (e) {
    res.status(500).json(err(500, 'Failed to read blocklist', { detail: e.message }));
  }
});

app.post('/api/admin/airline-logo-blocklist', (req, res) => {
  if (!blocklistAdminAllowed(req, res)) return;
  const code = logoBlocklist.add(req.body?.code);
  if (!code) {
    return res.status(400).json(err(400, 'Invalid code — must be a 3-letter ICAO airline code (e.g. AAL, DLH, SIA)'));
  }
  console.log(`🚫 Airline logo blocklisted: ${code}`);
  const entries = logoBlocklist.entries();
  res.json({ ok: true, added: code, count: entries.length, entries });
});

app.delete('/api/admin/airline-logo-blocklist/:code', (req, res) => {
  if (!blocklistAdminAllowed(req, res)) return;
  const removed = logoBlocklist.remove(req.params.code);
  if (!removed) {
    return res.status(404).json(err(404, `Code not on the blocklist: ${req.params.code}`));
  }
  console.log(`✅ Airline logo unblocked: ${req.params.code.toUpperCase()}`);
  const entries = logoBlocklist.entries();
  res.json({ ok: true, removed: req.params.code.toUpperCase(), count: entries.length, entries });
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
// GET /api/live/tracks
app.get('/api/live/tracks', (req, res) => {
  res.json({
    ok: true,
    count: apiCache.tracks.length,
    tracks: apiCache.tracks
  });
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
    return res.json({ ok: true, total: simplified.length, flights: simplified, fromCache: true 
});
  }

  // 2. Fallback to live fetch if not in cache
  console.warn(`[api] /flights/${sessionId} cache miss. Fetching live.`);
  try {
    const flights = await getFlightsForSession(sessionId);
    // Pass sessionId here so it maps routing correctly
    let simplified = flights.map(f => simplifyFlight(f, sessionId)); 
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

// ⬇️ EXTENDED CACHE TTL FOR FLIGHT PLANS (10 Minutes)
app.get('/flights/:sessionId/:flightId/plan', async (req, res) => {
  const { sessionId, flightId } = req.params;
  const cacheKey = `plan:${sessionId}:${flightId}`;
  const cached = getOnDemandCached(cacheKey);
  
  if (cached) return res.json({ ok: true, flightId, plan: cached, fromCache: true });
  
  try {
    const rawPlan = await getFlightPlan(sessionId, flightId);
    if (!rawPlan) {
      return res.status(404).json(err(404, 'Flight plan not found. The flight may not exist or has no filed plan.'));
    }
    
    // ⬇️ NEW TTL: 10 * 60 * 1000 = 10 minutes (600,000 ms). 
    // This allows users to tap the same flight repeatedly without hammering the IF API.
    setOnDemandCached(cacheKey, rawPlan, 10 * 60 * 1000); 
    
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
  const cacheKey = `route:${sessionId}:${flightId}`;
  const cached = getOnDemandCached(cacheKey);
  if (cached) return res.json({ ok: true, flightId, route: cached, fromCache: true });
  try {
    const rawRoute = await getFlightRoute(sessionId, flightId);
    if (!rawRoute || rawRoute.length === 0) {
      return res.status(404).json(err(404, 'Flight route not found. The flight may not exist or has no position reports available.'));
    }
    setOnDemandCached(cacheKey, rawRoute, 30 * 1000); // 30s TTL
    res.json({ 
ok: true, flightId, route: rawRoute });
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
// ⬇️ REPLACED: ATC Endpoint now uses secondary cache
app.get('/atc/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  
  // 1. Try Cache First
  const cached = apiCache.secondary.get(sessionId);
  if (cached) {
      return res.json({ ok: true, count: cached.atc.length, atc: cached.atc, fromCache: true });
  }

  // 2. Fallback to Live Fetch
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
// ⬇️ REPLACED: NOTAMs Endpoint now uses secondary cache
app.get('/notams/:sessionId', async (req, res) => {
  const { sessionId } = req.params;

  // 1. Try Cache First
  const cached = apiCache.secondary.get(sessionId);
  if (cached) {
      return res.json({ ok: true, count: cached.notams.length, notams: cached.notams, fromCache: true });
  }

  // 2. Fallback to Live Fetch
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
/**
 * ⬇️ NEW ROUTE: Get World Status (Airport statuses for a whole session)
 * This uses the /world endpoint and reads from the secondary cache.
*/
app.get('/api/live/world/:sessionId', async (req, res) => {
  const { sessionId } = req.params;

  // 1. Try Cache First
  const cached = apiCache.secondary.get(sessionId);
  if (cached && cached.world) {
      return res.json({ ok: true, count: cached.world.length, world: cached.world, fromCache: true });
  }

  // 2. Fallback to Live Fetch
  try {
    const worldStatus = await getWorldStatus(sessionId);
    res.json({ ok: true, count: worldStatus.length, world: worldStatus, fromCache: false });
  } catch (e) {
    const status = e?.response?.status || 500;
    const apiError = e?.response?.data;
 
   res.status(status).json(
      err(status, 'Failed to fetch world status', {
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
// ⬇️ NEW ROUTE: Get liveries for a specific aircraft
app.get('/api/aircraft/:aircraftId/liveries', async (req, res) => {
  const { aircraftId } = req.params;

  try {
    const liveries = await getLiveriesForAircraft(aircraftId);
    
    res.json({ 
      ok: true, 
      aircraftId, 
      count: liveries.length, 
      liveries: liveries 
    });

  } catch (e) {
    const status = e?.response?.status || 500;
    res.status(status).json(
      
err(status, 'Failed to fetch liveries for aircraft', { detail: e?.message })
    );
  }
});
// ⬇️ NEW ROUTE: Get Airport Information (Direct Passthrough)
app.get('/api/airport/:icao', async (req, res) => {
  const { icao } = req.params;
  const cacheKey = `airport:${icao.toUpperCase()}`;
  const cached = getOnDemandCached(cacheKey);
  if (cached) return res.json({ ok: true, icao: cached.icao, airport: cached, fromCache: true });
  try {
    const airportInfo = await getAirportInfo(icao);
    
    if (!airportInfo) {
      return res.status(404).json(err(404, `Airport not found: ${icao}`));
    }
    setOnDemandCached(cacheKey, airportInfo, 10 * 60 * 1000); // 10min TTL (static data)
    res.json({ 
 
      ok: true, 
      icao: airportInfo.icao,
      airport: airportInfo 
    });

  } catch (e) {
    const status = e?.response?.status || 500;
    const apiError = e?.response?.data;
    
    res.status(status).json(
      err(status, 'Failed to fetch airport info', { 
        detail: e?.message,
        apiErrorCode: apiError?.errorCode
      })
    );
}
});
// ⬇️ NEW ROUTE: Get Live Airport Status (Inbound/Outbound/ATC)
app.get('/api/live/airport/:sessionId/:icao/status', async (req, res) => {
  const { sessionId, icao } = req.params;
  const cacheKey = `airportStatus:${sessionId}:${icao.toUpperCase()}`;
  const cached = getOnDemandCached(cacheKey);
  if (cached) return res.json({ ok: true, sessionId, icao: cached.airportIcao, status: cached._statusPayload, fromCache: true });
  try {
    const airportStatus = await getAirportStatus(sessionId, icao);
    
    if (!airportStatus) {
      return res.status(404).json(err(404, `Airport status not found for ${icao} on session ${sessionId}`));
    }
    
    const statusPayload = 
{
      airportName: airportStatus.airportName,
      inboundFlightsCount: airportStatus.inboundFlightsCount,
      inboundFlights: airportStatus.inboundFlights,
      outboundFlightsCount: airportStatus.outboundFlightsCount,
      outboundFlights: airportStatus.outboundFlights,
      atcFacilities: airportStatus.atcFacilities
    };
// Store with a helper property so cache hit can reconstruct response
    airportStatus._statusPayload = statusPayload;
setOnDemandCached(cacheKey, airportStatus, 30 * 1000); // 30s TTL
    res.json({ ok: true, sessionId, icao: airportStatus.airportIcao, status: statusPayload });
} catch (e) {
    const status = e?.response?.status || 500;
    const apiError = e?.response?.data;
res.status(status).json(
      err(status, 'Failed to fetch live airport status', { 
        detail: e?.message,
        apiErrorCode: apiError?.errorCode
      })
    );
}
});

// ⬇️ NEW ROUTE: Get Airport ATIS
app.get('/api/live/airport/:sessionId/:icao/atis', async (req, res) => {
  const { sessionId, icao } = req.params;
  const cacheKey = `atis:${sessionId}:${icao.toUpperCase()}`;
  const cached = getOnDemandCached(cacheKey);
  if (cached !== null) return res.json({ ok: true, sessionId, icao: icao.toUpperCase(), atis: cached.atis, fromCache: true });
  try {
    const atisString = await getAirportAtis(sessionId, icao);
    setOnDemandCached(cacheKey, { atis: atisString }, 60 * 1000); // 60s TTL
    res.json({ 
      ok: true, 
      sessionId,
      icao: icao.toUpperCase(),
 
     atis: atisString
    });

  } catch (e) {
    const status = e?.response?.status || 500;
    const apiError = e?.response?.data;
    
    res.status(status).json(
      err(status, 'Failed to fetch airport ATIS', { 
        detail: e?.message,
        apiErrorCode: apiError?.errorCode 
      })
    );
  }
});
/* =========================
 * Startup
 * ========================= */

// ⬇️ 3. Change app.listen to httpServer.listen
httpServer.listen(PORT, () => {
  console.log(`✅ Live Flight Broadcaster (Sockets) ready: http://localhost:${PORT}`);
  console.log('🌐 Base URL:', IF_API_BASE_URL);
  
  // Updated logs to use the new constants
  console.log(`📡 Flight Polling: ${ACTIVE_POLL_MS/1000}s (active) / ${IDLE_POLL_MS/1000}s (idle)`);
  console.log(`📡 Secondary Polling: ${SECONDARY_ACTIVE_MS/1000}s (active) / ${SECONDARY_IDLE_MS/1000}s (idle)`);

  // Start the Telemetry Snapshotter (Runs every 15 minutes)
  const FIFTEEN_MINUTES = 15 * 60 * 1000;
  setInterval(() => {
      const activeSockets = io.engine.clientsCount;
      telemetry.saveSnapshot(activeSockets);
  }, FIFTEEN_MINUTES);

  // Fleet analytics snapshotter: persist an aggregate of the live world every
  // 5 minutes so the dashboard can chart trends (popular aircraft/airports,
  // global traffic) over days. Empty snapshots are skipped inside saveSnapshot.
  const FIVE_MINUTES = 5 * 60 * 1000;
  setInterval(() => {
    try {
      fleetAnalytics.saveSnapshot(currentFleetSnapshot());
    } catch (e) {
      console.warn('[fleet] snapshot failed:', e.message);
    }
  }, FIVE_MINUTES);

  // Lightweight memory monitor: surfaces RSS/heap and the size of every
  // in-memory cache, so a leak shows up as steady growth in the logs rather
  // than as a silent OOM. Cheap — runs every 15 minutes.
  setInterval(() => {
    const mu = process.memoryUsage();
    const mb = (n) => Math.round(n / 1048576);
    let routingEntries = 0;
    for (const m of apiCache.flightRouting.values()) routingEntries += m.size;
    const sock = metrics.socketStats();
    console.log(
      `[mem] rss=${mb(mu.rss)}MB heap=${mb(mu.heapUsed)}/${mb(mu.heapTotal)}MB ` +
      `ext=${mb(mu.external)}MB | sessions:flights=${apiCache.flights.size} ` +
      `secondary=${apiCache.secondary.size} routing=${apiCache.flightRouting.size}(${routingEntries}) ` +
      `saveTracker=${apiCache.lastRedisSave.size} onDemand=${onDemandCache.size} ` +
      `vaRoster=${apiCache.vaRosterCache.size} ` +
      `sockets=${io.engine.clientsCount}(peak ${sock.peak}, ${sock.totalConnections} total)`
    );
  }, FIFTEEN_MINUTES);
  
  if (!IF_API_KEY) {
    console.warn('⚠️  IF API key is missing. Set INFINITE_FLIGHT_API_KEY in your .env file.');
  }
});