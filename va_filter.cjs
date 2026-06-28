/* =========================
 * VA embed filter + takeoff/landing event push
 * =========================
 * Two jobs, both built on the VA-callsign matching from the "VA Embed — Data
 * Sourcing" contract:
 *
 *   1. GET /api/va/roster  — stateless pull. Filters the live flight cache down
 *      to a VA's roster (callsign code / prefixes / suffixes / servers) so the
 *      bot can backfill a current snapshot on demand. Stores nothing.
 *
 *   2. Event engine (processSnapshot) — fed each broadcast poll. It watches the
 *      VA configured via env and pushes ONLY two kinds of event to the bot:
 *      `takeoff` (a matched pilot leaves the ground) and `landing` (a matched
 *      pilot returns to the ground). The bot relays each event to the
 *      destination server and posts it. No 24/7 stream, no stored roster — we
 *      keep only a tiny per-flight ground/air flag for the watched VA so we can
 *      detect the transitions, and we prune it as flights disappear.
 *
 * Config is comma-separated. Matching config can be supplied per request (the
 * doc's "B) Query params" shape) for the roster endpoint, or via env for the
 * event engine, since token→VA resolution lives on the indgo backend:
 *   VA_BOT_FORWARD_URL    — webhook the takeoff/landing events are POSTed to.
 *   VA_BOT_FORWARD_TOKEN  — optional bearer token for that webhook.
 *   VA_WATCH_CODE         — VA callsign code (e.g. OCEAN).
 *   VA_WATCH_PREFIXES     — comma list, e.g. "Air Canada" (defaults to [code]).
 *   VA_WATCH_SUFFIXES     — comma list, e.g. "VA,EX" ([] = prefix-only).
 *   VA_WATCH_SERVERS      — comma list of server-name substrings (optional).
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

// Split a comma-separated query value into trimmed tokens. Splitting on commas
// only (not whitespace) keeps multi-word prefixes intact, e.g. "Air Canada"
// stays one token so it compacts to "AIRCANADA".
function csv(v) {
  if (Array.isArray(v)) return v.flatMap(csv);
  return String(v || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

// Turn raw input (query or env) into the normalised config used for matching.
function normalizeConfig(q = {}) {
  const code = firstToken(q.va || q.code || q.callsign);

  // prefixes: compacted (spaces/separators removed), uppercased; default [code].
  let prefixes = csv(q.prefixes).map(compact).filter(Boolean);
  if (!prefixes.length && code) prefixes = [code];

  // suffixes: uppercased, whitespace stripped; [] => prefix-only match.
  const suffixes = csv(q.suffixes).map(compact).filter(Boolean);

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

// Build the VA's live roster from the in-memory flights cache. Pure read.
//   sessions     : [{ id, name }, ...] (from getSessions)
//   flightsCache : Map sessionId -> { server, sessionId, flights: [...] }
function filterLiveRoster(cfg, sessions, flightsCache) {
  const out = [];
  for (const s of sessions || []) {
    if (!serverWanted(cfg, s?.name)) continue;
    const payload = flightsCache.get(s?.id);
    const flights = payload?.flights || [];
    for (const f of flights) {
      if (f && callsignMatches(f.callsign, cfg)) {
        out.push({ ...f, server: s?.name || payload?.server || null });
      }
    }
  }
  return out;
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

// Resolve the watched VA from env once. Returns null if matching can't run.
let watchCfgMemo;
function watchConfig() {
  if (watchCfgMemo !== undefined) return watchCfgMemo;
  const cfg = normalizeConfig({
    va: process.env.VA_WATCH_CODE,
    prefixes: process.env.VA_WATCH_PREFIXES,
    suffixes: process.env.VA_WATCH_SUFFIXES,
    servers: process.env.VA_WATCH_SERVERS,
  });
  // Need a forward target and at least one prefix to match against.
  watchCfgMemo = process.env.VA_BOT_FORWARD_URL && cfg.prefixes.length ? cfg : null;
  return watchCfgMemo;
}

// Tiny per-flight state for the watched VA only — never the whole server.
const committed = new Map(); // flightId -> bool airborne (last confirmed)
const pending = new Map(); // flightId -> { air: bool, n: int } (flip being confirmed)

// POST a single takeoff/landing event to the bot. Fire-and-forget: never
// awaited on the poll path, never cached — a slow bot can't back up memory.
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
// transitions for the watched VA and pushes takeoff/landing events.
//   flightsCache : Map sessionId -> { server, sessionId, flights: [...] }
function processSnapshot(flightsCache) {
  const cfg = watchConfig();
  if (!cfg) return; // engine disabled (no bot URL / no VA configured)

  const present = new Set();

  for (const payload of flightsCache.values()) {
    if (!serverWanted(cfg, payload?.server)) continue;
    for (const f of payload?.flights || []) {
      if (!f?.flightId || !callsignMatches(f.callsign, cfg)) continue;
      present.add(f.flightId);

      const cur = airborneState(f.position);
      if (cur === null) continue; // no reading this cycle — hold previous state

      const prev = committed.get(f.flightId);
      if (prev === undefined) {
        // First time we see this flight: seed its state, fire nothing. A pilot
        // who connects already airborne must not generate a spurious takeoff.
        committed.set(f.flightId, cur);
        continue;
      }
      if (cur === prev) {
        pending.delete(f.flightId); // back to stable — cancel any pending flip
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
        pushEvent(cur ? 'takeoff' : 'landing', f, payload?.server, cfg);
      }
    }
  }

  // Prune flights that are no longer live (disconnected / left the VA). A pilot
  // who disconnects mid-air produces no landing event — we only fire on an
  // observed air→ground transition.
  for (const id of committed.keys()) if (!present.has(id)) committed.delete(id);
  for (const id of pending.keys()) if (!present.has(id)) pending.delete(id);
}

/* ---- roster route (pull / backfill) ---- */

function registerRoutes(app, { getSessions, getFlightsCache }) {
  // GET /api/va/roster — stateless. Returns the VA's live roster filtered from
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
  watchConfig,
  processSnapshot,
  registerRoutes,
};
