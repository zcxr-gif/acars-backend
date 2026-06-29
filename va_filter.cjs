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
 *                           from `${VA_BACKEND_URL}/api/va-ads`). Defaults to the
 *                           known indgo host if unset.
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

// Tokenise a callsign the way embed.js does: trim, uppercase, split on any run
// of space / hyphen / underscore / slash, drop empties.
// "Air Canada 001VA" -> ["AIR","CANADA","001VA"].
function callsignTokens(s) {
  return String(s || '').trim().toUpperCase().split(/[\s\-_/]+/).filter(Boolean);
}

// Spoken wake-turbulence words tacked onto the end of a callsign — stripped
// before matching so "United 2UA Heavy" is treated as "United 2UA".
const WEIGHT_WORDS = new Set(['HEAVY', 'SUPER']);

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

// Split a VA callsign mask like "OCEAN ##VA" into the fixed prefix ("OCEAN")
// and suffix ("VA") around the variable flight-number run ("#"). "BAW ###" ->
// { prefix: "BAW", suffix: "" } (prefix-only). No "#" => the whole thing is the
// prefix. Compaction drops spaces/separators but keeps the "#" placeholders.
function patternParts(pattern) {
  const c = compact(pattern); // "OCEAN##VA"
  const first = c.indexOf('#');
  if (first === -1) return { prefix: c, suffix: '' };
  const last = c.lastIndexOf('#');
  return { prefix: c.slice(0, first), suffix: c.slice(last + 1) };
}

// Turn raw input (query param or VA-list item) into the normalised matching
// config. Accepts the various field names the backends use, including the
// va-ads `callsign` mask ("OCEAN ##VA").
function normalizeConfig(q = {}) {
  // prefixes: compacted (spaces/separators removed), uppercased.
  let prefixes = csv(q.prefixes || q.callsignPrefixes).map(compact).filter(Boolean);

  // suffixes: uppercased, whitespace stripped; [] => prefix-only match.
  let suffixes = csv(q.suffixes || q.callsignSuffixes).map(compact).filter(Boolean);

  // No explicit prefix/suffix lists? Derive them from the VA's callsign mask
  // ("Air Canada ##VA", or just "Air Canada"). The WHOLE fixed part becomes the
  // prefix — "AIRCANADA", not just "AIR" — so it can't collide with "Air Force".
  // The trailing literal (if any) becomes the suffix tag ("VA"). Explicit lists,
  // if given, always win.
  const mask = q.callsignPattern || q.callsignTemplate || q.callsign;
  if ((!prefixes.length || !suffixes.length) && mask) {
    const { prefix, suffix } = patternParts(mask);
    if (!prefixes.length && prefix) prefixes = [prefix];
    if (!suffixes.length && suffix) suffixes = [suffix];
  }

  // code: an explicit short code if one was given, else the full prefix.
  const code = firstToken(q.va || q.code || q.callsignCode) || prefixes[0] || '';
  if (!prefixes.length && code) prefixes = [code];

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

/* ---- matching (mirrors embed.js callsignMatches) ---- */

// A suffix tag only counts when it's a real tag, not coincidental trailing
// letters: the token must end with the tag, and either BE the tag exactly
// ("VA") or have a DIGIT immediately before it (the tag glued to a flight
// number, "001VA"). So "MOSKVA"/"NOVA" never match the tag "VA".
function tokenHasSuffixTag(token, tag) {
  if (!tag || !token.endsWith(tag)) return false;
  if (token === tag) return true;
  const before = token.charAt(token.length - tag.length - 1);
  return before >= '0' && before <= '9';
}

// A callsign belongs to the VA when (after uppercasing, stripping separators
// and trailing weight-class words) its compacted form STARTS WITH a declared
// prefix and — if the VA uses suffix tags — its LAST token CARRIES one of those
// tags. Prefix-only VAs (no suffixes configured) match on the prefix alone.
// The whole leading name is compacted into the prefix ("AIRCANADA"), so "Air
// Canada" matches only Air Canada, never "Air France".
function callsignMatches(callsign, cfg) {
  let tokens = callsignTokens(callsign);
  // Strip spoken weight-class words off the end ("... Heavy" / "... Super").
  while (tokens.length > 1 && WEIGHT_WORDS.has(tokens[tokens.length - 1])) tokens.pop();
  if (!tokens.length) return false;

  const c = tokens.join('');          // "AIRCANADA001VA"
  const last = tokens[tokens.length - 1]; // "001VA"

  const prefixHit = cfg.prefixes.some((p) => p && c.startsWith(p));
  if (!cfg.suffixes.length) return prefixHit; // prefix-only VA
  if (!prefixHit) return false;               // tag mode: BOTH must hold
  return cfg.suffixes.some((tag) => tokenHasSuffixTag(last, tag));
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

// Default base for the indgo backend (same host already in the CORS whitelist).
// Overridden by VA_BACKEND_URL, or bypassed entirely by VA_LIST_URL.
const DEFAULT_VA_BACKEND = 'https://site--indgo-backend--6dmjph8ltlhv.code.run';

let vaConfigs = []; // normalised configs for every VA we watch

// Replace the watched VA set from a raw list. Drops entries we can't match on.
// Like embed.js, a VA matches on its prefix(es); suffix tags are optional. To
// keep generic airline traffic out, a VA should declare a tag (e.g. "VA") so a
// bare "Air Canada 1234" without the tag is ignored — see callsignMatches.
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

// Unwrap whatever envelope the VA list arrives in into a plain array.
function vaListItems(data) {
  return Array.isArray(data) ? data : data?.data || data?.vas || data?.ads || data?.results || [];
}

// Pull the VA list from the other backend and refresh the registry. Follows
// pagination (va-ads returns { data, pagination: { page, totalPages } }).
async function refreshVaConfigs() {
  const base = (process.env.VA_BACKEND_URL || DEFAULT_VA_BACKEND).replace(/\/$/, '');
  const url = process.env.VA_LIST_URL || `${base}/api/va-ads`;
  const limit = Number(process.env.VA_LIST_PAGE_LIMIT) || 100;
  const headers = process.env.VA_LIST_SECRET ? { 'x-acars-signature': process.env.VA_LIST_SECRET } : undefined;
  try {
    const all = [];
    let page = 1;
    let totalPages = 1;
    do {
      const u = new URL(url);
      if (!u.searchParams.has('limit')) u.searchParams.set('limit', String(limit));
      u.searchParams.set('page', String(page));
      const { data } = await axios.get(u.toString(), { timeout: 10000, headers });
      all.push(...vaListItems(data));
      totalPages = Number(data?.pagination?.totalPages) || 1;
      page += 1;
    } while (page <= totalPages && page <= 50); // hard cap so a bad total can't loop forever
    const n = setVaConfigs(all);
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
// Optional global server allow-list for events, e.g. VA_EVENT_SERVERS="Expert".
// Empty = every server. va-ads has no per-VA server field, so this is the knob
// that keeps Casual/Training traffic from generating events.
const EVENT_SERVERS = csv(process.env.VA_EVENT_SERVERS);

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
    departureIcao: flight?.departureIcao || null,
    arrivalIcao: flight?.arrivalIcao || null,
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
    // Global server gate (Casual/Training noise control), if configured.
    if (EVENT_SERVERS.length && !serverWanted({ servers: EVENT_SERVERS }, payload?.server)) continue;
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
