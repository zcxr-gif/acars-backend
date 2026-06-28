/* =========================
 * VA embed filter + takeoff/landing event push (all VAs)
 * =========================
 * This backend only watches every VA we have and matches live flights to them
 * by callsign (the "VA Embed — Data Sourcing" rules). When a matched pilot
 * leaves the ground (`takeoff`) or returns to it (`landing`) it POSTs that one
 * event to the other backend, which does everything else (mapping the callsign
 * to the right VA presentation, posting, etc). There is no 24/7 stream.
 *
 * Two jobs:
 *   1. GET /api/va/roster — stateless pull for a single VA (query-param config),
 *      handy for on-demand backfill. Stores nothing.
 *   2. Event engine (processSnapshot) — fed each broadcast poll. Matches flights
 *      against ALL VA configs (fetched from VA_BACKEND_URL) and pushes only
 *      ground↔air transitions. A persistent dedupe (history.claimFlightState,
 *      injected) guarantees each (flightId, event) is sent at most once, even
 *      across restarts. Only a tiny per-flight ground/air flag is held in
 *      memory between polls; no roster or stream is stored.
 *
 * Env:
 *   VA_BACKEND_URL        — base of the indgo backend (VA configs are fetched
 *                           from `${VA_BACKEND_URL}/api/va-ads` unless overridden).
 *   VA_LIST_URL           — explicit URL to fetch the VA list from (overrides
 *                           the default above).
 *   VA_LIST_SECRET        — optional; sent as `x-acars-signature` on that fetch.
 *   VA_LIST_REFRESH_MS    — VA-list refresh interval, default 5 min.
 *   VA_BOT_FORWARD_URL    — where takeoff/landing events are POSTed.
 *   VA_BOT_FORWARD_TOKEN  — optional bearer token for that POST.
 *   VA_GROUND_SPEED_KT    — ground/air threshold, default 40 kt.
 *   VA_CONFIRM_SNAPSHOTS  — consecutive readings to confirm a flip, default 2.
 */

const axios = require('axios');

/* ---- normalisation helpers (Step 2 of the doc) ---- */

// First token of a callsign/code, uppercased: "Ocean 01EX" -> "OCEAN".
function firstToken(s) {
  return String(s || '').trim().toUpperCase().split(/[\s\-_/]+/).filter(Boolean)[0] || '';
}

// Compact a callsign for matching: drop spaces/separators, uppercase.
// "Air Canada 123 VA" -> "AIRCANADA123VA".
function compact(s) {
  return String(s || '').toUpperCase().replace(/[\s\-_/]+/g, '');
}

// Split a comma-separated value (or array of them) into trimmed tokens.
// Splitting on commas only keeps multi-word prefixes intact, e.g. "Air Canada"
// stays one token so it compacts to "AIRCANADA".
function csv(v) {
  if (Array.isArray(v)) return v.flatMap(csv);
  return String(v || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

// Turn raw input (query param or VA-list item) into the normalised matching
// config. Accepts the various field names the backends use.
function normalizeConfig(q = {}) {
  const code = firstToken(q.va || q.code || q.callsign || q.callsignCode);

  // prefixes: compacted (spaces/separators removed), uppercased; default [code].
  let prefixes = csv(q.prefixes || q.callsignPrefixes).map(compact).filter(Boolean);
  if (!prefixes.length && code) prefixes = [code];

  // suffixes: uppercased, whitespace stripped; [] => prefix-only match.
  const suffixes = csv(q.suffixes || q.callsignSuffixes).map(compact).filter(Boolean);

  // hubs: ICAO list (accepts hubs / icao / hub), uppercased. Branding only.
  const hubs = csv(q.hubs || q.icao || q.hub).map((h) => h.toUpperCase());

  // servers: substring filter against IF session names (case-insensitive).
  const servers = csv(q.servers);

  return {
    code,
    name: (q.name && String(q.name)) || code,
    prefixes,
    suffixes,
    hubs,
    servers,
  };
}

/* ---- matching (Step 4 of the doc) ---- */

// A callsign belongs to the VA when its compacted form starts with one of the
// VA prefixes and (if suffixes are configured) ends with one of the suffixes.
function callsignMatches(callsign, cfg) {
  const c = compact(callsign);
  if (!c) return false;
  const prefixOk = cfg.prefixes.some((p) => p && c.startsWith(p));
  if (!prefixOk) return false;
  if (!cfg.suffixes.length) return true; // prefix-only VA
  return cfg.suffixes.some((suf) => suf && c.endsWith(suf));
}

// Server-name substring filter shared by the roster and the event engine.
function serverWanted(cfg, serverName) {
  if (!cfg.servers.length) return true;
  const name = String(serverName || '').toLowerCase();
  return cfg.servers.some((w) => name.includes(w.toLowerCase()));
}

// Build one VA's live roster from the in-memory flights cache. Pure read.
//   sessions     : [{ id, name }, ...] (from getSessions)
//   flightsCache : Map sessionId -> { server, sessionId, flights: [...] }
function filterLiveRoster(cfg, sessions, flightsCache) {
  const out = [];
  for (const s of sessions || []) {
    if (!serverWanted(cfg, s?.name)) continue;
    const payload = flightsCache.get(s?.id);
    for (const f of payload?.flights || []) {
      if (f && callsignMatches(f.callsign, cfg)) {
        out.push({ ...f, server: s?.name || payload?.server || null });
      }
    }
  }
  return out;
}

/* =========================
 * All-VA registry (fetched from VA_BACKEND_URL)
 * ========================= */

let vaConfigs = []; // normalised configs for every VA we watch

// Replace the watched VA set from a raw list. Drops entries we can't match on.
function setVaConfigs(rawList) {
  const list = Array.isArray(rawList) ? rawList : [];
  vaConfigs = list
    .map((ad) => normalizeConfig(ad || {}))
    .filter((cfg) => cfg.prefixes.length); // need at least one prefix to match
  return vaConfigs.length;
}

// First VA whose callsign rules (and server filter) match this flight, or null.
function matchVa(callsign, serverName) {
  for (const cfg of vaConfigs) {
    if (callsignMatches(callsign, cfg) && serverWanted(cfg, serverName)) return cfg;
  }
  return null;
}

// Pull the VA list from the other backend and refresh the registry.
async function refreshVaConfigs() {
  const url =
    process.env.VA_LIST_URL ||
    (process.env.VA_BACKEND_URL ? `${process.env.VA_BACKEND_URL.replace(/\/$/, '')}/api/va-ads` : null);
  if (!url) return;
  try {
    const { data } = await axios.get(url, {
      timeout: 10000,
      headers: process.env.VA_LIST_SECRET ? { 'x-acars-signature': process.env.VA_LIST_SECRET } : undefined,
    });
    const list = Array.isArray(data) ? data : data?.vas || data?.ads || data?.data || data?.results || [];
    const n = setVaConfigs(list);
    console.log(`[va-filter] Loaded ${n} VA callsign config(s) from ${url}.`);
  } catch (e) {
    console.warn(`[va-filter] ⚠️ VA config refresh failed (${url}): ${e.message}`);
  }
}

/* =========================
 * Ground/air state + event engine
 * ========================= */

const GROUND_SPEED_KT = Number(process.env.VA_GROUND_SPEED_KT) || 40;
const CONFIRM_SNAPSHOTS = Math.max(1, Number(process.env.VA_CONFIRM_SNAPSHOTS) || 2);

// true = airborne, false = on ground, null = unknown (no usable reading).
// Mirrors fleet_analytics.classifyPhase: only MSL altitude is available, so the
// ground call leans on groundspeed.
function airborneState(pos) {
  if (!pos || typeof pos.gs_kt !== 'number') return null;
  return pos.gs_kt >= GROUND_SPEED_KT;
}

// Tiny per-flight state for matched VA flights only — never the whole server.
const committed = new Map(); // flightId -> bool airborne (last confirmed)
const pending = new Map(); // flightId -> { air: bool, n: int } (flip being confirmed)

// POST a single takeoff/landing event to the other backend. Fire-and-forget:
// never awaited on the poll path, never cached.
function pushEvent(type, flight, serverName, cfg) {
  const url = process.env.VA_BOT_FORWARD_URL;
  if (!url) return;
  const payload = {
    event: type, // 'takeoff' | 'landing'
    va: { code: cfg.code, name: cfg.name },
    callsign: flight?.callsign || '',
    username: flight?.username || null,
    flightId: flight?.flightId || null,
    server: serverName || null,
    position: flight?.position || null,
    aircraft: flight?.aircraft || null,
    timestamp: Date.now(),
  };
  axios
    .post(url, payload, {
      timeout: 8000,
      headers: process.env.VA_BOT_FORWARD_TOKEN
        ? { authorization: `Bearer ${process.env.VA_BOT_FORWARD_TOKEN}` }
        : undefined,
    })
    .catch((e) => console.warn(`[va-filter] ⚠️ ${type} push failed for ${payload.callsign}: ${e.message}`));
}

// Fed the combined flights cache after each broadcast poll. Detects ground↔air
// transitions for any matched VA flight and pushes takeoff/landing events.
//   flightsCache : Map sessionId -> { server, sessionId, flights: [...] }
//   claimEvent   : (flightId, event) -> bool — true the first time only, so each
//                  state is sent at most once (persistent dedupe). Optional.
function processSnapshot(flightsCache, claimEvent) {
  if (!vaConfigs.length) return; // no VAs loaded yet — nothing to watch
  const claim = typeof claimEvent === 'function' ? claimEvent : () => true;
  const present = new Set();

  for (const payload of flightsCache.values()) {
    for (const f of payload?.flights || []) {
      if (!f?.flightId) continue;
      const cfg = matchVa(f.callsign, payload?.server);
      if (!cfg) continue;
      present.add(f.flightId);

      const cur = airborneState(f.position);
      if (cur === null) continue; // no reading this cycle — hold previous state

      const prev = committed.get(f.flightId);
      if (prev === undefined) {
        // First sighting: seed state, fire nothing. A pilot who connects already
        // airborne must not generate a spurious takeoff.
        committed.set(f.flightId, cur);
        continue;
      }
      if (cur === prev) {
        pending.delete(f.flightId); // stable again — cancel any pending flip
        continue;
      }

      // State differs — require CONFIRM_SNAPSHOTS consecutive readings before
      // committing, so a single jittery poll near the threshold can't fire.
      let p = pending.get(f.flightId);
      if (!p || p.air !== cur) {
        p = { air: cur, n: 1 };
        pending.set(f.flightId, p);
      } else {
        p.n += 1;
      }
      if (p.n >= CONFIRM_SNAPSHOTS) {
        committed.set(f.flightId, cur);
        pending.delete(f.flightId);
        const type = cur ? 'takeoff' : 'landing';
        // Only send if we haven't already sent this exact state for this flight.
        if (claim(f.flightId, type)) pushEvent(type, f, payload?.server, cfg);
      }
    }
  }

  // Prune flights that are no longer live. A pilot who disconnects mid-air
  // produces no landing event — we only fire on an observed air→ground change.
  for (const id of committed.keys()) if (!present.has(id)) committed.delete(id);
  for (const id of pending.keys()) if (!present.has(id)) pending.delete(id);
}

// Start the VA-list refresh loop. Inert (logs once) if no source is configured.
let started = false;
function initEventEngine() {
  if (started) return;
  started = true;
  refreshVaConfigs();
  const ms = Number(process.env.VA_LIST_REFRESH_MS) || 5 * 60 * 1000;
  const t = setInterval(refreshVaConfigs, ms);
  if (typeof t.unref === 'function') t.unref();
}

/* ---- roster route (single-VA pull / backfill) ---- */

function registerRoutes(app, { getSessions, getFlightsCache }) {
  // GET /api/va/roster — stateless. Returns one VA's live roster filtered from
  // the existing live cache. Nothing is stored on this path.
  app.get('/api/va/roster', async (req, res) => {
    try {
      const cfg = normalizeConfig(req.query);
      if (!cfg.code) {
        return res
          .status(400)
          .json({ ok: false, error: { status: 400, message: 'A VA code is required (e.g. ?va=OCEAN).' } });
      }
      const sessions = (await getSessions()) || [];
      const roster = filterLiveRoster(cfg, sessions, getFlightsCache());
      res.set('Cache-Control', 'no-store');
      res.json({
        ok: true,
        va: { code: cfg.code, name: cfg.name },
        hubs: cfg.hubs,
        count: roster.length,
        flights: roster,
      });
    } catch (e) {
      console.error('[va-filter] ❌ Roster build failed:', e.message);
      res.status(500).json({ ok: false, error: { status: 500, message: 'Failed to build VA roster' } });
    }
  });
}

module.exports = {
  firstToken,
  compact,
  normalizeConfig,
  callsignMatches,
  filterLiveRoster,
  airborneState,
  setVaConfigs,
  matchVa,
  refreshVaConfigs,
  processSnapshot,
  initEventEngine,
  registerRoutes,
};
