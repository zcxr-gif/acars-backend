/* =========================
 * VA embed filter (stateless callsign matcher)
 * =========================
 * Implements the "VA Embed — Data Sourcing" contract on the data side:
 * given a VA config (callsign code + prefixes/suffixes/hubs/servers), filter
 * the live flights down to that VA's roster and hand it back.
 *
 * This deliberately stores NOTHING. It reads the flights snapshot that the
 * broadcast poller already keeps in memory (apiCache.flights) and computes the
 * filtered roster per request. The indgo-backend bot pulls this endpoint (or we
 * forward to it, see VA_BOT_FORWARD_URL) and relays the roster to the
 * destination server — so our memory never fills up with VA-specific copies.
 *
 * Config is accepted as query params (the doc's "B) Query params" preview
 * shape), since token→VA resolution lives on the indgo backend, not here:
 *   ?va=OCEAN&name=Ocean%20Virtual&prefixes=Air%20Canada&suffixes=VA,EX
 *     &hubs=KJFK,KBOS&servers=Expert
 * `prefixes` / `suffixes` / `hubs` / `servers` are comma-separated.
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

// Turn the raw query into the normalised config used for matching.
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

// Build the VA's live roster from the in-memory flights cache. Pure read — it
// never mutates or persists anything.
//   sessions     : [{ id, name }, ...] (from getSessions)
//   flightsCache : Map sessionId -> { server, sessionId, flights: [...] }
function filterLiveRoster(cfg, sessions, flightsCache) {
  const wanted = cfg.servers.map((s) => s.toLowerCase());
  const out = [];
  for (const s of sessions || []) {
    if (wanted.length && !wanted.some((w) => String(s?.name || '').toLowerCase().includes(w))) {
      continue;
    }
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

/* ---- optional best-effort forward to the bot ---- */

// If VA_BOT_FORWARD_URL is set, push the filtered roster to the indgo-backend
// bot. Fire-and-forget: we never await it on the response path and never store
// the result, so a slow/failed bot can't back up memory here.
function forwardToBot(cfg, roster) {
  const url = process.env.VA_BOT_FORWARD_URL;
  if (!url) return;
  axios
    .post(
      url,
      { va: { code: cfg.code, name: cfg.name }, hubs: cfg.hubs, count: roster.length, flights: roster },
      {
        timeout: 8000,
        headers: process.env.VA_BOT_FORWARD_TOKEN
          ? { authorization: `Bearer ${process.env.VA_BOT_FORWARD_TOKEN}` }
          : undefined,
      }
    )
    .catch((e) => console.warn(`[va-filter] ⚠️ Forward to bot failed: ${e.message}`));
}

/* ---- route ---- */

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
      const flightsCache = getFlightsCache();
      const roster = filterLiveRoster(cfg, sessions, flightsCache);

      // Optionally relay to the bot; never awaited, never cached.
      forwardToBot(cfg, roster);

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
  registerRoutes,
};
