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
 *   VA_LIST_REFRESH_MS    — VA-list refresh interval, default 5 min. Also paces
 *                           the roster watch list.
 *   VA_ROSTER_WATCH_URL   — explicit URL for the roster watch list (the pilots
 *                           of VAs that accept any callsign). Defaults to
 *                           `${VA_BACKEND_URL}/api/va/roster-watch`.
 *   VA_BOT_FORWARD_URL    — where takeoff/landing events are POSTed.
 *   VA_BOT_FORWARD_TOKEN  — optional bearer token for that POST.
 *   VA_GROUND_SPEED_KT    — ground/air threshold, default 40 kt.
 *   VA_AIRBORNE_ALT_FT    — at/above this MSL altitude a flight is always treated
 *                           as airborne (no landing), default 10000 ft.
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

// How hard we work to call a flight this VA's. Owner/staff pick one per VA (the
// `callsignMatch` field on the va-ads listing); anything unrecognised is
// 'strict', because showing somebody else's pilot as yours is the error a VA has
// not agreed to.
//   'exact'  — the callsign must BE the registered shape: <prefix><number><tag>,
//              nothing before, between or after it. "Air Canada 001VA" only.
//   'strict' — declared prefix AND the tag on one of the last two tokens, so a
//              pilot may append a division/event tag after the VA one.
//   'tag'    — 'strict', plus the VA's own distinctive tag on ANY airline. The
//              codeshare answer: Norwegian flies "Red Nose 12NV" on its own
//              metal and "Shamrock 12NV" on a partner's, and the "NV" is the
//              VA claiming the flight. Every other mode tests the prefix first
//              and returns early, so a codeshare leg was dropped here — before
//              the event was ever forwarded — no matter what the other backend
//              was configured to do with it.
//   'broad'  — the declared prefix alone is enough, tag or no tag.
const MATCH_MODES = new Set(['exact', 'strict', 'tag', 'broad']);
function matchMode(v) {
  const m = String(v || '').trim().toLowerCase();
  return MATCH_MODES.has(m) ? m : 'strict';
}

// Every callsign mask a VA declared, in preference order. A listing may carry
// the multi-value `callsigns` (the authoritative field), a legacy single
// `callsign`, or — on older documents — BOTH, with `callsigns` sitting empty.
// An empty array is truthy in JS, so `q.callsigns || q.callsign` silently
// resolves to [] on exactly those older documents and the VA stops matching
// anything. Hence the explicit length checks.
function callsignMasks(q) {
  for (const v of [q.callsignPattern, q.callsignTemplate, q.callsigns, q.callsign]) {
    const list = (Array.isArray(v) ? v : [v]).filter((s) => String(s || '').trim());
    if (list.length) return list;
  }
  return [];
}

// Turn raw input (query param or VA-list item) into the normalised matching
// config. Accepts the various field names the backends use, including the
// va-ads `callsign` mask ("OCEAN ##VA").
function normalizeConfig(q = {}) {
  // prefixes: compacted (spaces/separators removed), uppercased.
  let prefixes = csv(q.prefixes || q.callsignPrefixes).map(compact).filter(Boolean);

  // suffixes: uppercased, whitespace stripped; [] => prefix-only match.
  let suffixes = csv(q.suffixes || q.callsignSuffixes).map(compact).filter(Boolean);

  // No explicit prefix/suffix lists? Derive them from the VA's callsign mask(s)
  // ("Air Canada ##VA", or just "Air Canada"). The WHOLE fixed part becomes the
  // prefix — "AIRCANADA", not just "AIR" — so it can't collide with "Air Force".
  // The trailing literal (if any) becomes the suffix tag ("VA"). A listing may
  // hold several callsigns (parent brand + sub-fleets); every one contributes,
  // so a VA's second callsign is not silently unmatched. Explicit lists, if
  // given, always win.
  //
  // `patterns` keeps the mask PAIRS as declared. The flat prefix/suffix lists
  // lose which tag belongs to which airline, which is fine for the loose modes
  // (a VA running one tag across several airlines is a documented setup) but not
  // for 'exact', where a VA that registered "OCEAN ##VA" and "SHAMROCK ###EX"
  // means those two shapes and not the four the cross-product would accept.
  let patterns = [];
  const masks = callsignMasks(q);
  if ((!prefixes.length || !suffixes.length) && masks.length) {
    const parts = masks.map(patternParts).filter((p) => p.prefix);
    patterns = parts;
    if (!prefixes.length) prefixes = [...new Set(parts.map((p) => p.prefix))];
    if (!suffixes.length) suffixes = [...new Set(parts.map((p) => p.suffix).filter(Boolean))];
  }

  // regulars: untagged callsigns matched by PREFIX ONLY and always included,
  // even while the prefixes above run in tag mode (staff / charter callsigns).
  const regulars = csv(q.regulars || q.regularCallsigns || q.callsignRegulars).map(compact).filter(Boolean);

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
    // The declared airline+tag pairs, when the config came from callsign masks.
    // Empty when prefixes/suffixes were given as independent lists — there are
    // no pairs to keep then, and the cross-product IS the intent.
    patterns,
    regulars,
    match: matchMode(q.callsignMatch || q.match),
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

// Is a tag distinctive enough to claim a flight on its OWN, with no declared
// airline in front of it? "VA" is not — nearly every virtual airline appends it,
// so it says "some VA" and nothing more, and matching on it alone would hand
// every VA in the sky to whoever asked first. Single letters collide the same
// way. Anything else ("NV", "EX", "UP") names one VA in practice. Mirrors
// isDistinctiveVaTag on the other backend and in embed.js.
function isDistinctiveTag(tag) {
  const t = String(tag || '').trim().toUpperCase();
  return t.length >= 2 && t !== 'VA';
}

// Exact-mode test: the compacted callsign must be EXACTLY one of the registered
// shapes — a declared prefix, then the flight number, then (when the VA uses
// tags) one of those tags, and then nothing at all. "AIRCANADA001VA" ✓ ;
// "AIRCANADA001VACX" ✗ (trailing extra), "AIRCANADA001" ✗ (no tag),
// "AIRCANADAX01VA" ✗ (the number isn't a number). This is the setting a VA turns
// on when it wants only the callsigns it registered and nothing that merely
// resembles them.
function matchesExactShape(compacted, prefixes, suffixes) {
  for (const p of prefixes) {
    if (!p || !compacted.startsWith(p)) continue;
    const rest = compacted.slice(p.length); // "001VA"
    if (!suffixes.length) {
      if (/^\d+$/.test(rest)) return true; // prefix-only VA: <prefix><number>
      continue;
    }
    for (const tag of suffixes) {
      if (!tag || !rest.endsWith(tag)) continue;
      if (/^\d+$/.test(rest.slice(0, rest.length - tag.length))) return true;
    }
  }
  return false;
}

// Exact mode against a config's DECLARED shapes. When the VA registered its
// callsigns as masks we know which tag goes with which airline, so a VA holding
// "OCEAN ##VA" and "SHAMROCK ###EX" matches exactly those two — not "Ocean 12EX"
// or "Shamrock 4VA", which is what testing every prefix against every suffix
// would let through. With no pairs on file (prefixes and suffixes supplied as
// independent lists, as an embed config does) the cross-product is the intent,
// so fall back to it.
function matchesExactConfig(compacted, cfg) {
  if (cfg.patterns && cfg.patterns.length) {
    return cfg.patterns.some((p) => matchesExactShape(compacted, [p.prefix], p.suffix ? [p.suffix] : []));
  }
  return matchesExactShape(compacted, cfg.prefixes, cfg.suffixes);
}

// Regular (untagged) callsigns are matched by name alone and never need a tag.
// In exact mode they still have to be the whole callsign — the bare name, or the
// name plus a flight number — rather than merely its opening.
function matchesRegular(compacted, regulars, mode) {
  return regulars.some((p) => {
    if (!p || !compacted.startsWith(p)) return false;
    if (mode !== 'exact') return true;
    const rest = compacted.slice(p.length);
    return rest === '' || /^\d+$/.test(rest);
  });
}

// A callsign belongs to the VA when (after uppercasing, stripping separators
// and trailing weight-class words) its compacted form STARTS WITH a declared
// prefix and — if the VA uses suffix tags — one of the last two tokens CARRIES
// one of those tags. Prefix-only VAs (no suffixes configured) match on the
// prefix alone. The whole leading name is compacted into the prefix
// ("AIRCANADA"), so "Air Canada" matches only Air Canada, never "Air France".
//
// `cfg.match` decides how much slack that rule has — see MATCH_MODES. Mirrors
// embed.js callsignMatches so the widget and the event feed agree on who is a
// member.
function callsignMatches(callsign, cfg) {
  let tokens = callsignTokens(callsign);
  // Strip spoken weight-class words off the end ("... Heavy" / "... Super").
  while (tokens.length > 1 && WEIGHT_WORDS.has(tokens[tokens.length - 1])) tokens.pop();
  if (!tokens.length) return false;

  const mode = cfg.match || 'strict';
  const c = tokens.join(''); // "AIRCANADA001VA"

  // Always-included untagged callsigns first — they bypass the tag rule.
  if (matchesRegular(c, cfg.regulars || [], mode)) return true;

  const tail = tokens.slice(-2);
  const carriesTag = (tag) => tail.some((t) => tokenHasSuffixTag(t, tag));

  // 'tag' mode asks about the TAG before the airline, because the flight it
  // exists for — a codeshare on partner metal — has no airline of the VA's on
  // it at all. Only a distinctive tag may claim a flight this way.
  if (mode === 'tag' && cfg.suffixes.some((t) => isDistinctiveTag(t) && carriesTag(t))) return true;

  const prefixHit = cfg.prefixes.some((p) => p && c.startsWith(p));
  if (!prefixHit) return false;
  if (mode === 'exact') return matchesExactConfig(c, cfg);
  if (mode === 'broad') return true;          // the airline name is enough

  // Tag mode on the VA's own airline. A pilot often appends a second trailing
  // tag (division / event code) after the VA one — "Air Canada 001VA CX" — so
  // either of the last two tokens carrying a configured tag counts.

  // With the declared pairs on file, each airline is held to ITS OWN tag. That
  // matters for a VA whose callsigns don't all work the same way: a listing
  // holding "BAW ###" (no tag) alongside "SPEEDBIRD ##VA" should accept
  // "BAW 123" AND "Speedbird 12VA", where a single flattened suffix list would
  // demand the tag from both and drop every BAW flight.
  if (cfg.patterns && cfg.patterns.length) {
    return cfg.patterns.some((p) => c.startsWith(p.prefix) && (!p.suffix || carriesTag(p.suffix)));
  }
  if (!cfg.suffixes.length) return true;      // prefix-only VA
  return cfg.suffixes.some(carriesTag);
}

// Same decision as callsignMatches, but returns the intermediate reasoning so
// the debug route can show WHY a callsign did or didn't match a VA. `matched`
// is taken straight from callsignMatches so this can never drift from the real
// rule — the extra fields are purely explanatory.
function explainMatch(callsign, cfg) {
  let tokens = callsignTokens(callsign);
  while (tokens.length > 1 && WEIGHT_WORDS.has(tokens[tokens.length - 1])) tokens.pop();
  const mode = cfg.match || 'strict';
  const compacted = tokens.join('');
  const tail = tokens.slice(-2);
  const lastToken = tokens[tokens.length - 1] || '';
  const prefixMatch = cfg.prefixes.some((p) => p && compacted.startsWith(p));
  // A tag is only *required* in strict mode; exact folds it into the shape test
  // and broad waives it outright.
  const suffixRequired = (mode === 'strict' || mode === 'tag') && cfg.suffixes.length > 0;
  const suffixMatch = suffixRequired
    ? cfg.suffixes.some((tag) => tail.some((t) => tokenHasSuffixTag(t, tag)))
    : null; // null = no tag needed in this mode
  return {
    code: cfg.code,
    name: cfg.name,
    match: mode,
    prefixes: cfg.prefixes,
    suffixes: cfg.suffixes,
    regulars: cfg.regulars || [],
    compacted,
    lastToken,
    prefixMatch,
    suffixRequired,
    suffixMatch,
    // 'tag' mode only: did a distinctive tag claim this flight on its own,
    // with no declared airline in front of it (the codeshare path)?
    tagOnlyMatch: mode === 'tag'
      ? cfg.suffixes.some((t) => isDistinctiveTag(t) && tail.some((k) => tokenHasSuffixTag(k, t)))
      : null,
    // Only meaningful in exact mode: did the callsign fit <prefix><number><tag>
    // with nothing extra?
    exactShapeMatch: mode === 'exact' ? matchesExactConfig(compacted, cfg) : null,
    patterns: cfg.patterns || [],
    regularMatch: matchesRegular(compacted, cfg.regulars || [], mode),
    matched: callsignMatches(callsign, cfg),
  };
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
// bare "Air Canada 1234" without the tag is ignored — see callsignMatches. A VA
// that wants nothing but its registered shape sets `callsignMatch: "exact"` on
// its listing, which is carried through here and applied per VA.
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

/* ---- roster watch list (VAs that accept any callsign) ---- */

// Usernames whose flights must be forwarded even when the callsign matches no
// VA at all. A VA can set a `rosterTrust` that waives part of the rule — "our
// members fly codeshare and
// partner callsigns, count them anyway" — and those flights are exactly the ones
// this matcher would never forward, because nothing in the callsign points at a
// VA. So the other backend publishes the roster usernames of the VAs that opted
// in, and a flight by one of them is pushed UNATTRIBUTED for that backend to
// resolve against the roster itself. We deliberately don't learn which VA a
// username belongs to: attribution lives on one side, and this is not it.
let rosterWatch = new Set();

// Lowercased, trimmed, '@' dropped. The published list is already expanded into
// every separator form a name can be written in (rosterMatchKeys on the other
// side), so a plain lowercase lookup is enough here.
function watchKey(username) {
  return String(username || '').trim().replace(/^@+/, '').toLowerCase();
}

function isWatchedPilot(username) {
  if (!rosterWatch.size) return false;
  const k = watchKey(username);
  return !!k && rosterWatch.has(k);
}

// Replace the watch set from a raw username list. The refresh path below uses
// it, and it's the seam the tests drive instead of the network (same shape as
// setVaConfigs). Returns the resulting size.
function setRosterWatch(list) {
  rosterWatch = new Set((Array.isArray(list) ? list : []).map(watchKey).filter(Boolean));
  return rosterWatch.size;
}

// Where the watch list is fetched from. Same base as the VA list, and the same
// override story: VA_ROSTER_WATCH_URL wins if set.
function resolvedRosterWatchUrl() {
  const base = (process.env.VA_BACKEND_URL || DEFAULT_VA_BACKEND).replace(/\/$/, '');
  return process.env.VA_ROSTER_WATCH_URL || `${base}/api/va/roster-watch`;
}

// Refresh the watch list. A failure leaves the previous set in place rather than
// emptying it — a blip on this endpoint should cost nobody their notifications.
async function refreshRosterWatch() {
  const url = resolvedRosterWatchUrl();
  const headers = process.env.VA_LIST_SECRET ? { 'x-acars-signature': process.env.VA_LIST_SECRET } : undefined;
  try {
    const { data } = await axios.get(url, { timeout: 10000, headers });
    const n = setRosterWatch(Array.isArray(data?.usernames) ? data.usernames : []);
    console.log(`[va-filter] Watching ${n} rostered pilot(s) for any-callsign VAs.`);
  } catch (e) {
    console.warn(`[va-filter] ⚠️ Roster watch refresh failed (${url}), keeping ${rosterWatch.size} entries: ${e.message}`);
  }
}

// Unwrap whatever envelope the VA list arrives in into a plain array.
function vaListItems(data) {
  return Array.isArray(data) ? data : data?.data || data?.vas || data?.ads || data?.results || [];
}

// Resolve the URL the VA list is fetched from: VA_LIST_URL wins, else
// `${VA_BACKEND_URL}/api/va-ads`, else the indgo default. Shared by the refresh
// loop and the debug route so both always report the same source.
function resolvedVaListUrl() {
  const base = (process.env.VA_BACKEND_URL || DEFAULT_VA_BACKEND).replace(/\/$/, '');
  return process.env.VA_LIST_URL || `${base}/api/va-ads`;
}

// Pull the VA list from the other backend and refresh the registry. Follows
// pagination (va-ads returns { data, pagination: { page, totalPages } }).
async function refreshVaConfigs() {
  const url = resolvedVaListUrl();
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
// Above this MSL altitude a flight is treated as airborne regardless of what
// the groundspeed reads. Guards against spurious landing events when a cruising
// flight (e.g. FL330) briefly reports a low or garbage groundspeed — nobody
// lands from 10k+ feet, so we refuse to call it a landing up there.
const AIRBORNE_ALT_FT = Number(process.env.VA_AIRBORNE_ALT_FT) || 10000;
const CONFIRM_SNAPSHOTS = Math.max(1, Number(process.env.VA_CONFIRM_SNAPSHOTS) || 2);
// Optional global server allow-list for events, e.g. VA_EVENT_SERVERS="Expert".
// Empty = every server. va-ads has no per-VA server field, so this is the knob
// that keeps Casual/Training traffic from generating events.
const EVENT_SERVERS = csv(process.env.VA_EVENT_SERVERS);

// true = airborne, false = on ground, null = unknown (no usable reading).
// Mirrors fleet_analytics.classifyPhase: only MSL altitude is available, so the
// ground call leans on groundspeed.
function airborneState(pos) {
  if (!pos) return null;
  // At or above the altitude floor the aircraft is unambiguously airborne, so a
  // low/garbage groundspeed reading can't be misread as a landing (VA ads were
  // firing landings for pilots still cruising at 33k).
  if (typeof pos.alt_ft === 'number' && pos.alt_ft >= AIRBORNE_ALT_FT) return true;
  if (typeof pos.gs_kt !== 'number') return null;
  return pos.gs_kt >= GROUND_SPEED_KT;
}

// Tiny per-flight state for matched VA flights only — never the whole server.
const committed = new Map(); // flightId -> bool airborne (last confirmed)
const pending = new Map(); // flightId -> { air: bool, n: int } (flip being confirmed)

// Stand-in "VA" for a flight forwarded on the roster watch list alone. Empty
// code/name is the signal: the other backend reads it as "no attribution
// offered" and resolves the flight against its own rosters.
const ROSTER_ONLY_CFG = { code: '', name: '', prefixes: [], suffixes: [], regulars: [], match: 'strict', hubs: [], servers: [] };

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
      let cfg = matchVa(f.callsign, payload?.server);
      // No VA owns this callsign — but the pilot may be on the roster of a VA
      // whose rosterTrust waives the part of the callsign rule this side just
      // applied: the tag ('airline'), the airline ('tagged'), or the callsign
      // outright ('any'). Forward it unattributed and let the other backend
      // decide; this side has no rosters and no business guessing which VA it
      // belongs to.
      if (!cfg && isWatchedPilot(f.username)) cfg = ROSTER_ONLY_CFG;
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
  refreshRosterWatch();
  const ms = Number(process.env.VA_LIST_REFRESH_MS) || 5 * 60 * 1000;
  const t = setInterval(refreshVaConfigs, ms);
  if (typeof t.unref === 'function') t.unref();
  // Same cadence: a pilot added to a roster shouldn't wait longer to be seen
  // than a VA added to the directory.
  const r = setInterval(refreshRosterWatch, ms);
  if (typeof r.unref === 'function') r.unref();
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

  // GET /api/va/debug — introspection for the watched VA set. Shows the source
  // the configs are fetched from, the event-push wiring, and every loaded VA's
  // normalised prefixes/suffixes so you can see whether a VA (e.g. Finnair)
  // actually loaded and how its callsign mask was parsed.
  //
  // Add ?callsign=Finnair%20343AY (optionally &server=Expert) to test-match one
  // callsign against every loaded VA and see, per VA, whether the prefix hit,
  // whether the suffix tag was required/present, and whether the server passed.
  app.get('/api/va/debug', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const out = {
      ok: true,
      source: {
        // Where the VA list is pulled from and how often it refreshes.
        url: resolvedVaListUrl(),
        refreshMs: Number(process.env.VA_LIST_REFRESH_MS) || 5 * 60 * 1000,
        // Pilots forwarded on roster membership alone (VAs with rosterTrust
        // "any"), and where that list comes from.
        rosterWatchUrl: resolvedRosterWatchUrl(),
        rosterWatchCount: rosterWatch.size,
        // Events only POST when this is set — unset = matching runs but nothing
        // is forwarded to the other backend.
        forwardConfigured: !!process.env.VA_BOT_FORWARD_URL,
        // Global server allow-list applied before any VA is matched (empty = all).
        eventServers: EVENT_SERVERS,
        groundSpeedKt: GROUND_SPEED_KT,
        confirmSnapshots: CONFIRM_SNAPSHOTS,
      },
      count: vaConfigs.length,
      configs: vaConfigs.map((c) => ({
        code: c.code,
        name: c.name,
        match: c.match,
        prefixes: c.prefixes,
        suffixes: c.suffixes,
        regulars: c.regulars,
        hubs: c.hubs,
        servers: c.servers,
      })),
    };

    const callsign = req.query.callsign ? String(req.query.callsign) : '';
    if (callsign) {
      const server = req.query.server ? String(req.query.server) : null;
      const candidates = vaConfigs.map((cfg) => {
        const e = explainMatch(callsign, cfg);
        e.serverAllowed = serverWanted(cfg, server);
        e.willMatch = e.matched && e.serverAllowed;
        return e;
      });
      const hit = candidates.find((e) => e.willMatch) || null;
      const username = req.query.username ? String(req.query.username) : '';
      out.test = {
        callsign,
        server,
        // The same global gate processSnapshot applies before matching any VA.
        globalServerGate: !EVENT_SERVERS.length || serverWanted({ servers: EVENT_SERVERS }, server),
        matched: hit ? { code: hit.code, name: hit.name } : null,
        // Add &username=… to see whether a flight no VA claims would still be
        // forwarded on the roster watch list alone.
        username: username || null,
        rosterWatched: username ? isWatchedPilot(username) : null,
        candidates,
      };
    }

    res.json(out);
  });
}

module.exports = {
  firstToken,
  compact,
  matchMode,
  normalizeConfig,
  callsignMatches,
  matchesExactShape,
  explainMatch,
  filterLiveRoster,
  airborneState,
  setVaConfigs,
  matchVa,
  resolvedVaListUrl,
  refreshVaConfigs,
  resolvedRosterWatchUrl,
  refreshRosterWatch,
  setRosterWatch,
  isWatchedPilot,
  processSnapshot,
  initEventEngine,
  registerRoutes,
};
