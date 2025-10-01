// live_flights.js

/* =========================
 * Imports & setup
 * ========================= */
const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* =========================
 * Config
 * ========================= */
const PORT = parseInt(process.env.PORT || '5001', 10);

const IF_API_BASE_URL = (process.env.IF_API_BASE_URL || 'https://api.infiniteflight.com/public/v2').trim();
const RAW_IF_KEY = process.env.INFINITE_FLIGHT_API_KEY || process.env.IF_API_KEY || '';
const IF_API_KEY = RAW_IF_KEY.trim();

const POLL_MS = parseInt(process.env.POLL_MS || '30000', 10); // 30s (for active flights)
const BACKGROUND_POLL_MS = parseInt(process.env.BACKGROUND_POLL_MS || (15 * 60 * 1000), 10); // 15 minutes (for backgrounded flights)
const SEARCH_TIMEOUT_MS = parseInt(process.env.SEARCH_TIMEOUT_MS || (48 * 60 * 60 * 1000), 10); // 48 hours
const DEFAULT_IF_SERVER = (process.env.DEFAULT_IF_SERVER || 'Expert Server').trim();
const DEFAULT_CALLBACK_URL = (process.env.TRACK_CALLBACK_URL || '').trim();
const TRACK_LOG = process.env.TRACK_LOG === '1';

// "Landed" heuristics (AGL-based)
const LANDED_ALTITUDE_AGL_FT = 1000; // Max altitude Above Ground Level (AGL)
const LANDED_SPEED_KT = 40;     // Max ground speed (knots)
const LANDED_PROXIMITY_KM = 10; // Max distance from an airport center (km)

// In-memory tracker store
const trackers = new Map(); // id -> tracker
function newId() {
  try { return require('crypto').randomUUID(); } catch { return 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
}

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
 * Airports data (robust loader + normalization)
 * ========================= */
let airports = [];

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

/* =========================
 * Helpers
 * ========================= */

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
async function getSessions() {
  const { data } = await ifClient.get('/sessions');
  const items = unwrap(data);
  return items.map((s) => ({
    id: s?.id || s?.uuid || null,
    name: s?.name || s?.serverName || '',
    raw: s,
  })).filter(s => s.id && s.name);
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

function simplifyFlight(f) {
  return {
    flightId: f?.flightId || null,
    userId: f?.userId || null,
    callsign: f?.callsign || '',
    username: f?.username || null,
    virtualOrganization: f?.virtualOrganization || null,
    position: {
      lat: typeof f?.latitude === 'number' ? f.latitude : null,
      lon: typeof f?.longitude === 'number' ? f.longitude : null,
      alt_ft: typeof f?.altitude === 'number' ? f.altitude : null,
      gs_kt: typeof f?.speed === 'number' ? f.speed : null,
      vs_fpm: typeof f?.verticalSpeed === 'number' ? f.verticalSpeed : null,
      track_deg: typeof f?.track === 'number' ? f.track : null,
      heading_deg: typeof f?.heading === 'number' ? f.heading : null,
      lastReport: f?.lastReport || null,
      lastReportMs: f?.lastReport ? Date.parse(f.lastReport) || null : null,
    },
    aircraft: {
      aircraftId: f?.aircraftId || null,
      liveryId: f?.liveryId || null,
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
    for (const item of items) {
      if (item.location && (item.location.latitude !== 0 || item.location.longitude !== 0)) {
        waypoints.push({
          name: item.name,
          lat: item.location.latitude,
          lon: item.location.longitude,
        });
      }
      if (Array.isArray(item.children)) {
        extractWaypoints(item.children);
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


/* =========================
 * Tracking engine
 * ========================= */
async function notifyCallback(tracker, payload) {
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
      history: [{ event: 'created', timestamp: now }],
    };
    trackers.set(id, t);
    created.push(t);
    notifyCallback(t, {});
  }
  return created;
}

function getActiveTrackers() {
  return [...trackers.values()].filter(t => t.status === 'searching' || t.status === 'tracking');
}

async function pollOnce() {
  const now = Date.now();

  const trackersToCheck = [...trackers.values()].filter(t =>
    (t.status === 'searching' || t.status === 'tracking') && now >= t.nextPollAt
  );

  if (!trackersToCheck.length) return;

  const byServer = trackersToCheck.reduce((m, t) => {
    const key = t.server.toLowerCase();
    if (!m[key]) m[key] = [];
    m[key].push(t);
    return m;
  }, {});

  let sessions = [];
  try {
    sessions = await getSessions();
  } catch (e) {
    if (TRACK_LOG) console.warn('[track] sessions fetch failed', e?.message);
    return;
  }

  for (const [serverKey, group] of Object.entries(byServer)) {
    const humanName = group[0]?.server || DEFAULT_IF_SERVER;
    const sessionId = pickSessionIdByName(sessions, humanName);
    if (!sessionId) {
      if (TRACK_LOG) console.warn(`[track] no sessionId for server "${humanName}"`);
      continue;
    }

    let flights = [];
    try {
      flights = await getFlightsForSession(sessionId);
    } catch (e) {
      if (TRACK_LOG) console.warn(`[track] flights fetch failed for server "${humanName}"`, e?.message);
      continue;
    }

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

    for (const t of group) {
      t.attempts += 1;
      t.lastPolledAt = now;
      let match = null;

      // Prioritize finding by flightId if we are already tracking
      if (t.status === 'tracking' && t.lastKnownFlight?.flightId) {
        match = byFlightId.get(t.lastKnownFlight.flightId);
      }
      
      // If not found by flightId, or if searching, try by username
      if (!match && (t.status === 'searching' || t.status === 'tracking')) {
        const userFlights = byUsername.get(t.username.toLowerCase());
        if (userFlights && userFlights.length) {
            // To handle multiple logins, re-lock onto the newest flight if the old one vanished
            match = userFlights[0]; 
        }
      }

      if (match) {
        const found = simplifyFlight(match);

        // If the flightId changes (e.g., user started a new flight), treat it as a new "online" event
        if (t.status !== 'tracking' || t.lastKnownFlight?.flightId !== found.flightId) {
          t.history.push({ event: 'online', timestamp: now });
          if (TRACK_LOG) console.log(`[track] ONLINE ${t.username} on ${t.server} -> Locking onto flightId: ${found.flightId}`);
          
          console.log(`[ACARS Debug] User found online. Sending 'found' (departure) notification to callback URL for ${t.username}`);
          
          notifyCallback(t, { flight: { ...found, sessionId }, reason: 'user_online' });
        }
        
        t.status = 'tracking';
        t.lastSeenAt = now;
        t.flight = { ...found, sessionId };
        t.lastKnownFlight = { flightId: found.flightId, sessionId: sessionId }; // Always update last known flight
        
        const isInBackground = found.pilotState === 3;
        t.nextPollAt = now + (isInBackground ? BACKGROUND_POLL_MS : POLL_MS);
        
        if (isInBackground && TRACK_LOG) {
          console.log(`[track] ✈️ ${t.username} is in background. Next poll in ${BACKGROUND_POLL_MS / 60000}m.`);
        }

      } else {
        // ==================================================================
        //
        // 🛑 START OF BUG FIX AREA 🛑
        // This entire 'else' block contains the corrected logic.
        //
        // ==================================================================
        
        // If we were tracking a flight and it has now disappeared,
        // it might have landed. This is our primary chance to check.
        if (t.lastKnownFlight?.flightId) {
          if (TRACK_LOG) console.log(`[track] User ${t.username}'s flight ${t.lastKnownFlight.flightId} disappeared, checking last route for landing...`);
          try {
            const route = await getFlightRoute(t.lastKnownFlight.sessionId, t.lastKnownFlight.flightId);
            const simplifiedRoute = simplifyFlightRoute(route);
        
            if (simplifiedRoute.length > 0) {
              const lastPoint = simplifiedRoute[simplifiedRoute.length - 1];
              const { airport, distanceKm } = findNearestAirport(lastPoint.lat, lastPoint.lon);

              if (airport) {
                const airportElevationFt = airport.elevation_ft || 0;
                const altitudeAgl = lastPoint.altitude - airportElevationFt;
                
                const isLowAndSlow = altitudeAgl < LANDED_ALTITUDE_AGL_FT && lastPoint.groundSpeed < LANDED_SPEED_KT;
                const isNearAirport = distanceKm < LANDED_PROXIMITY_KM;
                
                // If it meets landing criteria, we're done!
                if (isLowAndSlow && isNearAirport) {
                  t.status = 'landed';
                  t.history.push({ event: 'landed', timestamp: now, airport: airport.icao });
                  
                  const onlineEvent = t.history.slice().reverse().find(h => h.event === 'online');
                  const flightDurationMs = onlineEvent ? now - onlineEvent.timestamp : 0;
                  
                  if (TRACK_LOG) console.log(`[track] LANDED ${t.username} at ${airport.icao} after ${Math.round(flightDurationMs/60000)}m. Stopping tracker.`);
                  console.log(`[ACARS Debug] Flight has landed. Sending 'landed' notification to callback URL for ${t.username}`);

                  notifyCallback(t, { 
                    reason: 'flight_landed', 
                    flightDurationMs, 
                    lastPosition: lastPoint,
                    airport: {
                      icao: airport.icao,
                      name: airport.name,
                      distanceKm: distanceKm,
                    }
                  });
                  
                  trackers.set(t.id, t);
                  continue; // Move to the next tracker
                } else if (TRACK_LOG) {
                  // Log why the landing check failed, for debugging.
                  console.log(`[track] ${t.username} is low & slow check failed: nearAirport=${isNearAirport}, AGL=${altitudeAgl.toFixed(0)}ft. Closest: ${airport?.icao} at ${distanceKm?.toFixed(1)}km`);
                }
              }
            }
          } catch(e) {
            if (TRACK_LOG) console.warn(`[track] Failed to get route for ${t.username}: ${e.message}`);
          }
        }
        
        // If we've reached this point, the flight either never existed or it disappeared mid-air.
        
        // Check for timeout
        if (now >= t.timeoutAt) {
          t.status = 'not_found';
          if (TRACK_LOG) console.log(`[track] TIMEOUT ${t.username} on ${t.server}`);
          notifyCallback(t, { reason: `timeout_${SEARCH_TIMEOUT_MS / (60 * 60 * 1000)}h` });
          continue;
        }
        
        // If the status was 'tracking', this is the first poll where the user is missing.
        // Log it as an offline event.
        if (t.status === 'tracking') {
          t.history.push({ event: 'offline', timestamp: now });
          if (TRACK_LOG) console.log(`[track] OFFLINE (mid-air) ${t.username} on ${t.server}`);
          notifyCallback(t, { reason: 'user_offline' });
        }
        
        // Transition to 'searching' state and set a backoff poll interval.
        t.status = 'searching';
        t.flight = null;

        let nextInterval = POLL_MS;
        const timeSinceSeen = now - (t.lastSeenAt || t.startedAt);
        if (timeSinceSeen < 15 * 60 * 1000) { // If recently seen (<15m ago)
          nextInterval = 2 * 60 * 1000; // Check again in 2m
        } else if (timeSinceSeen < 6 * 60 * 60 * 1000) { // If seen in last 6h
          nextInterval = 15 * 60 * 1000; // Check in 15m
        } else { // It's been a while
          nextInterval = 60 * 60 * 1000; // Check in 1h
        }
        t.nextPollAt = now + nextInterval;
        if (TRACK_LOG) console.log(`[track] searching ${t.username}, next poll in ${nextInterval/60000}m`);
      }
      trackers.set(t.id, t);
    }
  }
}

// Start the polling loop
setInterval(() => {
  pollOnce().catch(e => {
    if (TRACK_LOG) console.error('[track] pollOnce error', e?.message);
  });
}, POLL_MS);


/* =========================
 * API Endpoints
 * ========================= */
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

app.get('/if-sessions', async (req, res) => {
  try {
    if (!IF_API_KEY) return res.status(500).json(err(500, 'INFINITE_FLIGHT_API_KEY is not set'));
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
    const sessions = await getSessions();
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

app.get('/flights/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const callsignFilter = req.query.callsignEndsWith;
  try {
    const flights = await getFlightsForSession(sessionId);
    let simplified = flights.map(simplifyFlight);
    if (callsignFilter) {
      const suffix = callsignFilter.toUpperCase();
      simplified = simplified.filter(f =>
        f.callsign && f.callsign.toUpperCase().endsWith(suffix)
      );
    }
    res.json({ ok: true, total: simplified.length, flights: simplified });
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
    const simplifiedPlan = simplifyFlightPlan(rawPlan);
    res.json({ ok: true, flightId, plan: simplifiedPlan });
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

app.get('/track/active', (req, res) => {
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
    history: t.history.map(h => ({...h, timestamp: new Date(h.timestamp).toISOString()})),
  }});
});

app.post('/track/:id/stop', (req, res) => {
  const t = trackers.get(req.params.id);
  if (!t) return res.status(404).json(err(404, 'tracker not found'));
  t.status = 'stopped';
  t.history.push({ event: 'stopped', timestamp: Date.now() });
  trackers.set(t.id, t);
  notifyCallback(t, { reason: 'stopped_by_request' });
  res.json({ ok: true, status: t.status });
});

app.post('/track/:id/delay', (req, res) => {
  const t = trackers.get(req.params.id);
  if (!t) return res.status(404).json(err(404, 'tracker not found'));

  // Delay the next poll by 5 minutes from now
  const delayMs = 5 * 60 * 1000;
  t.nextPollAt = Date.now() + delayMs;
  
  t.history.push({ event: 'delayed_by_test', timestamp: Date.now() });
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
app.listen(PORT, () => {
  console.log(`✅ Live Flight Tracker ready: http://localhost:${PORT}`);
  console.log('🌐 Base URL:', IF_API_BASE_URL);
  console.log(`🔁 Tracking: poll=${POLL_MS}ms background=${BACKGROUND_POLL_MS}ms timeout=${SEARCH_TIMEOUT_MS / (60 * 60 * 1000)}h`);
  console.log(`🛩️  Default IF Server: "${DEFAULT_IF_SERVER}"`);
  if (!IF_API_KEY) {
    console.warn('⚠️  IF API key is missing. Set INFINITE_FLIGHT_API_KEY in your .env file.');
  }
});