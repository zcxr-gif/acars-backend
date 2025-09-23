// live_flights.cjs
const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5001;

const IF_API_BASE_URL = (process.env.IF_API_BASE_URL || 'https://api.infiniteflight.com/public/v2').trim();
const RAW_IF_KEY = process.env.INFINITE_FLIGHT_API_KEY || process.env.IF_API_KEY || '';
const IF_API_KEY = RAW_IF_KEY.trim();

// -------- Tracking config (new) --------
const POLL_MS = parseInt(process.env.POLL_MS || '30000', 10);                // 30s
const SEARCH_TIMEOUT_MS = parseInt(process.env.SEARCH_TIMEOUT_MS || (15 * 60 * 1000), 10); // 15m
const DEFAULT_IF_SERVER = (process.env.DEFAULT_IF_SERVER || 'Expert Server').trim();
const DEFAULT_CALLBACK_URL = (process.env.TRACK_CALLBACK_URL || '').trim(); // optional webhook to your other backend
const TRACK_LOG = process.env.TRACK_LOG === '1'; // set TRACK_LOG=1 for verbose logs

// In-memory tracker store (simple & fast). Your "other backend" is the source of truth.
const trackers = new Map(); // id -> tracker
function newId() {
  // node >= 19 has crypto.randomUUID; fallback simple id
  try { return require('crypto').randomUUID(); } catch { return 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
}

// -------- IF client --------
const ifClient = axios.create({
  baseURL: IF_API_BASE_URL,
  timeout: 15000,
  headers: {
    Authorization: `Bearer ${IF_API_KEY}`,
    Accept: 'application/json',
  },
});

function unwrap(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.result)) return data.result;
  return data.result ?? data.items ?? [];
}

function err(status, message, extra = {}) {
  return { ok: false, error: { status, message, ...extra } };
}

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

// --- route (flown path) ---
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
    return payload.result || [];
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
      return payload.result || [];
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
    alt_ft: p.altitude,
    gs_kt: p.groundSpeed,
    track_deg: p.track,
    timestamp: p.date,
    timestampMs: Date.parse(p.date) || null,
  }));
}

// ---------------------------------------------------------
// Tracking worker (new)
// ---------------------------------------------------------

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
    }, { timeout: 10000 });
  } catch (e) {
    if (TRACK_LOG) console.warn('[callback] failed', e?.message);
  }
}

function addTrackers(input) {
  // input: {username, server?, callbackUrl?} OR {usernames: [...]}
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

    // De-dupe: if there's an active tracker for same username+server, reuse it
    const existing = [...trackers.values()].find(t =>
      t.username.toLowerCase() === username.toLowerCase() &&
      t.server.toLowerCase() === server.toLowerCase() &&
      (t.status === 'queued' || t.status === 'searching')
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
      timeoutAt: now + SEARCH_TIMEOUT_MS,
    };
    trackers.set(id, t);
    created.push(t);

    // fire-and-forget initial callback
    notifyCallback(t, {});
  }
  return created;
}

function getActiveTrackers() {
  return [...trackers.values()].filter(t => t.status === 'searching');
}

async function pollOnce() {
  const active = getActiveTrackers();
  if (!active.length) return;

  // Timeouts first
  const now = Date.now();
  for (const t of active) {
    if (now >= t.timeoutAt) {
      t.status = 'not_found';
      trackers.set(t.id, t);
      if (TRACK_LOG) console.log(`[track] NOT FOUND ${t.username} on ${t.server}`);
      notifyCallback(t, { reason: 'timeout_15m' });
    }
  }

  const remaining = getActiveTrackers();
  if (!remaining.length) return;

  // Group by server name
  const byServer = remaining.reduce((m, t) => {
    const key = t.server.toLowerCase();
    if (!m[key]) m[key] = [];
    m[key].push(t);
    return m;
  }, {});

  // Fetch sessions once
  let sessions = [];
  try {
    sessions = await getSessions();
  } catch (e) {
    if (TRACK_LOG) console.warn('[track] sessions fetch failed', e?.message);
    return; // try next tick
  }

  // Process each server group
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

    // Build username index (case-insensitive)
    const byUsername = new Map();
    for (const f of flights) {
      const u = (f.username || '').toLowerCase();
      if (!u) continue;
      if (!byUsername.has(u)) byUsername.set(u, []);
      byUsername.get(u).push(f);
    }

    for (const t of group) {
      t.attempts += 1;
      t.lastPolledAt = Date.now();
      const match = byUsername.get(t.username.toLowerCase());
      if (match && match.length) {
        // pick first match
        const found = simplifyFlight(match[0]);
        t.status = 'found';
        t.lastSeenAt = Date.now();
        t.flight = { ...found, sessionId };
        trackers.set(t.id, t);
        if (TRACK_LOG) console.log(`[track] FOUND ${t.username} -> flightId=${found.flightId} callsign=${found.callsign || ''}`);
        notifyCallback(t, { flight: t.flight });
      } else {
        // still searching; leave it
        trackers.set(t.id, t);
      }
    }
  }
}

// Start the polling loop
setInterval(() => {
  pollOnce().catch(e => {
    if (TRACK_LOG) console.error('[track] pollOnce error', e?.message);
  });
}, POLL_MS);

// ---------------------------------------------------------
// Existing endpoints (kept) + new tracking endpoints
// ---------------------------------------------------------

// ---- Existing: plans & routes ----
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

    const simplifiedRoute = simplifyFlightRoute(rawRoute);
    res.json({ ok: true, flightId, route: simplifiedRoute });

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

// ---- Existing: debug & test ----
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

// ---------------------------------------------------------
// New tracking endpoints
// ---------------------------------------------------------

// 1) Start tracking one or many usernames
// Body can be { username, server?, callbackUrl? } OR { usernames: [...], server?, callbackUrl? }
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

// 2) Get tracker by id
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
    attempts: t.attempts,
    flight: t.flight,
    timeoutAt: new Date(t.timeoutAt).toISOString(),
  }});
});

// 3) Stop tracker
app.post('/track/:id/stop', (req, res) => {
  const t = trackers.get(req.params.id);
  if (!t) return res.status(404).json(err(404, 'tracker not found'));
  t.status = 'stopped';
  trackers.set(t.id, t);
  notifyCallback(t, { reason: 'stopped_by_request' });
  res.json({ ok: true, status: t.status });
});

// 4) List active trackers (debug)
app.get('/track/active', (req, res) => {
  const active = getActiveTrackers().map(t => ({
    id: t.id, username: t.username, server: t.server, status: t.status,
    startedAt: new Date(t.startedAt).toISOString(),
    timeoutAt: new Date(t.timeoutAt).toISOString(),
    attempts: t.attempts
  }));
  res.json({ ok: true, count: active.length, trackers: active });
});

// ---- health ----
app.get('/health', (req, res) => {
  res.status(200).json({ ok: true, status: 'alive', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`✅ Live Flight Tracker ready: http://localhost:${PORT}`);
  console.log('🌐 Base URL:', IF_API_BASE_URL);
  console.log(`🔁 Tracking: poll=${POLL_MS}ms timeout=${SEARCH_TIMEOUT_MS}ms defaultServer="${DEFAULT_IF_SERVER}"`);
});
