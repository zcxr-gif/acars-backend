// live_flights.cjs (CommonJS)
// A small Express microservice to fetch live flights from Infinite Flight Live API v2
// Robust against wrong base URLs (404s), with friendly errors and optional VA callsign filtering.

// 1) IMPORTS
const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

// 2) APP SETUP
const app = express();
app.use(cors());

const PORT = process.env.PORT || 5001;

// 3) CONFIG
// ✅ Correct public v2 base. If you override, keep the trailing "/public/v2"
const IF_API_BASE_URL = process.env.IF_API_BASE_URL || 'https://api.infiniteflight.com/public/v2';
const IF_API_KEY = process.env.INFINITE_FLIGHT_API_KEY; // required

// Default server to query (you can change via ?server=Training%20Server)
const DEFAULT_SERVER_NAME = process.env.TARGET_SERVER_NAME || 'Expert Server';

// Optional VA callsign prefix filter (e.g., IGO, AAL). Empty means "no filter".
const DEFAULT_VA_PREFIX = (process.env.VA_PREFIX || '').toUpperCase();

// 4) HELPERS
const withAuth = { headers: { Authorization: `Bearer ${IF_API_KEY || ''}` }, timeout: 20000 };

function err(status, message, extra = {}) {
  return { status, message, ...extra };
}

function sanitizePrefix(prefix) {
  return (prefix || '').toString().trim().toUpperCase();
}

// 5) ROUTES
// GET /health — simple health check
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'live_flights', baseUrl: IF_API_BASE_URL });
});

// GET /live-flights
// Query params:
//   server: name of server (e.g., "Expert Server")
//   prefix: callsign prefix filter (e.g., "IGO")
//   limit:  integer to limit results (post-filter)
//   includeRaw: '1' to include raw flight objects
app.get('/live-flights', async (req, res) => {
  try {
    if (!IF_API_KEY) {
      return res.status(500).json(err(500, 'Server misconfigured: INFINITE_FLIGHT_API_KEY is not set.'));
    }

    const serverName = (req.query.server || DEFAULT_SERVER_NAME).toString();
    const vaPrefix = sanitizePrefix(req.query.prefix || DEFAULT_VA_PREFIX);
    const limit = Math.max(0, parseInt(req.query.limit || '0', 10) || 0);
    const includeRaw = req.query.includeRaw === '1';

    // Step 1: Get sessions
    const sessionsUrl = `${IF_API_BASE_URL}/sessions`;
    console.log('[IF] GET', sessionsUrl);

    let sessionsResp;
    try {
      sessionsResp = await axios.get(sessionsUrl, withAuth);
    } catch (e) {
      if (e.response) {
        // Often the sign of a wrong base URL is a 404 HTML page from nginx
        const body = typeof e.response.data === 'string' ? e.response.data.slice(0, 400) : e.response.data;
        return res.status(e.response.status).json(
          err(e.response.status, 'Error fetching sessions from Infinite Flight API', { url: sessionsUrl, body })
        );
      }
      if (e.request) {
        return res.status(503).json(err(503, 'No response from Infinite Flight API when fetching sessions.'));
      }
      return res.status(500).json(err(500, 'Unexpected error before sessions request.', { detail: e.message }));
    }

    const sessions = Array.isArray(sessionsResp?.data?.result) ? sessionsResp.data.result : [];
    if (!sessions.length) {
      return res.status(502).json(err(502, 'Received empty session list from Infinite Flight API.'));
    }

    // Find server by name (exact match). If not found, suggest available names.
    const target = sessions.find(s => (s?.name || '').toString() === serverName);
    if (!target) {
      return res.status(404).json(
        err(404, `Server "${serverName}" not found.`, { availableServers: sessions.map(s => s?.name).filter(Boolean) })
      );
    }

    // Step 2: Get flights for that session
    const flightsUrl = `${IF_API_BASE_URL}/sessions/${target.id}/flights`;
    console.log('[IF] GET', flightsUrl);

    let flightsResp;
    try {
      flightsResp = await axios.get(flightsUrl, withAuth);
    } catch (e) {
      if (e.response) {
        const body = typeof e.response.data === 'string' ? e.response.data.slice(0, 400) : e.response.data;
        return res.status(e.response.status).json(
          err(e.response.status, 'Error fetching flights from Infinite Flight API', { url: flightsUrl, body })
        );
      }
      if (e.request) {
        return res.status(503).json(err(503, 'No response from Infinite Flight API when fetching flights.'));
      }
      return res.status(500).json(err(500, 'Unexpected error before flights request.', { detail: e.message }));
    }

    let flights = Array.isArray(flightsResp?.data?.result) ? flightsResp.data.result : [];

    // Optional callsign prefix filtering (case-insensitive)
    if (vaPrefix) {
      flights = flights.filter(f => (f?.callsign || '').toUpperCase().startsWith(vaPrefix));
    }

    // Sort by callsign then by last seen (if available)
    flights.sort((a, b) => {
      const ca = (a?.callsign || '').toUpperCase();
      const cb = (b?.callsign || '').toUpperCase();
      if (ca < cb) return -1; if (ca > cb) return 1;
      const ta = a?.lastSeen || a?.lastUpdated || 0;
      const tb = b?.lastSeen || b?.lastUpdated || 0;
      return tb - ta; // newest first
    });

    if (limit > 0 && flights.length > limit) flights = flights.slice(0, limit);

    // Shape a compact response
    const shaped = flights.map(f => ({
      id: f?.id,
      callsign: f?.callsign || null,
      userId: f?.userId || null,
      aircraftId: f?.aircraftId || null,
      server: target.name,
      sessionId: target.id,
      latitude: f?.latitude ?? null,
      longitude: f?.longitude ?? null,
      altitude: f?.altitude ?? null,
      speed: f?.speed ?? null,
      heading: f?.heading ?? null,
      vs: f?.verticalSpeed ?? null,
      lastUpdated: f?.lastUpdated || f?.lastSeen || null,
    }));

    const payload = {
      server: target.name,
      sessionId: target.id,
      count: flights.length,
      flights: includeRaw ? flights : shaped,
      filteredByPrefix: vaPrefix || null,
      baseUrl: IF_API_BASE_URL,
    };

    return res.json(payload);
  } catch (errAny) {
    console.error('UNHANDLED ERROR in /live-flights:', errAny);
    return res.status(500).json(err(500, 'Unexpected server error.', { detail: errAny?.message }));
  }
});

// 6) START SERVER
app.listen(PORT, () => {
  console.log(`Live Flight Tracker listening on http://localhost:${PORT}`);
  console.log('Base URL:', IF_API_BASE_URL);
});
