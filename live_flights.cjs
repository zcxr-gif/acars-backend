// live_flights.cjs
// Express microservice for Infinite Flight Live API v2

const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());

const PORT = process.env.PORT || 5001;

// --- Config & axios client
const IF_API_BASE_URL =
  (process.env.IF_API_BASE_URL && process.env.IF_API_BASE_URL.trim()) ||
  'https://api.infiniteflight.com/public/v2';

const RAW_IF_KEY = process.env.INFINITE_FLIGHT_API_KEY || process.env.IF_API_KEY || '';
const IF_API_KEY = RAW_IF_KEY.trim();

const ifClient = axios.create({
  baseURL: IF_API_BASE_URL,
  timeout: 15000,
  headers: {
    Authorization: `Bearer ${IF_API_KEY}`,
    Accept: 'application/json',
  },
});

// --- Utility: normalize API envelope (some endpoints return { errorCode, result })
function unwrap(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.result)) return data.result;
  return data.result ?? data.items ?? [];
}

/**
 * Fetch all live sessions (servers).
 * Docs: GET /public/v2/sessions  (Authorization: Bearer <key>)
 */
async function getSessions() {
  const { data } = await ifClient.get('/sessions');
  const items = unwrap(data);

  // Normalize objects just in case fields change names slightly over time
  return items.map((s) => ({
    id: s?.id || s?.uuid || null,
    name: s?.name || s?.serverName || '',
    // keep any extra fields for debugging
    raw: s,
  })).filter(s => s.id && s.name);
}

/**
 * Pick a sessionId by display name (e.g., "Expert Server").
 * - case-insensitive
 * - tolerates "Expert", "Expert Server", "training" etc.
 * - falls back to first session if no exact/fuzzy match
 */
function pickSessionIdByName(sessions, desiredName = 'Expert Server') {
  if (!Array.isArray(sessions) || sessions.length === 0) return null;

  const want = String(desiredName || '').trim().toLowerCase();

  // 1) exact (case-insensitive)
  const exact = sessions.find(s => (s.name || '').toLowerCase() === want);
  if (exact) return exact.id;

  // 2) fuzzy contains
  const fuzzy = sessions.find(s => (s.name || '').toLowerCase().includes(want));
  if (fuzzy) return fuzzy.id;

  // 3) friendly aliases if user typed short forms like "expert", "training", "casual"
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

  // 4) last resort: first session (avoid total failure; your route still 404s if you prefer)
  return sessions[0]?.id ?? null;
}

/**
 * Fetch flights for a given session.
 * Docs: GET /public/v2/sessions/{sessionId}/flights
 */
async function getFlightsForSession(sessionId) {
  if (!sessionId) throw new Error('Missing sessionId');
  const { data } = await ifClient.get(`/sessions/${encodeURIComponent(sessionId)}/flights`);
  return unwrap(data);
}

function simplifyFlight(f) {
  return {
    id: f?.id,
    userId: f?.userId,
    callsign: f?.callsign || null,
    lat: f?.latitude ?? null,
    lon: f?.longitude ?? null,
    alt: f?.altitude ?? null,
    spd: f?.speed ?? null,
    hdg: f?.heading ?? null,
    vs: f?.verticalSpeed ?? null,
    lastUpdated: f?.lastUpdated ?? null
  };
}

// --- Debug routes
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

// Quick “does it work” test – fetch flights once from a named server (default Expert)
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

// --- Main endpoint
async function getFlightsForSession(sessionId) {
  if (!sessionId) throw new Error('Missing sessionId');

  try {
    const { data } = await ifClient.get(`/sessions/${encodeURIComponent(sessionId)}/flights`);
    const payload = data && typeof data === 'object' ? data : {};
    // API usually returns { errorCode, result: [...] }
    if (typeof payload.errorCode === 'number' && payload.errorCode !== 0) {
      const err = new Error(`IF API errorCode ${payload.errorCode}`);
      err.response = { data: payload };
      throw err;
    }
    return Array.isArray(payload.result) ? payload.result : (Array.isArray(data) ? data : []);
  } catch (e) {
    // Some deployments see 401/404 if header auth is rejected; try query-param auth once.
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

/**
 * Map the raw FlightEntry into your lean object used by the frontend.
 * (Matches the FlightEntry fields from the docs.)
 */
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

    // Requires IF 25.1+ to be accurate per docs
    pilotState: typeof f?.pilotState === 'number' ? f.pilotState : null, // 0=Active,1=AwayInFlight,2=AwayParked,3=InBackground
    isConnected: typeof f?.isConnected === 'boolean' ? f.isConnected : null,
  };
}

// --- Start
app.listen(PORT, () => {
  console.log(`Live Flight Tracker listening on http://localhost:${PORT}`);
  console.log('Base URL:', IF_API_BASE_URL);
});
