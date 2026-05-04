/**
 * Badge + Presence module for inflight.info
 *
 * Drop-in feature: serves /badge/:username.svg, /api/presence/:username,
 * and the opt-in/out endpoints. All caching, rate limiting, and the username
 * activity index live in here so live_flights.cjs only needs three small hooks.
 *
 * Memory footprint (worst case across all internal caches): ~15 MB.
 * CPU per cached request: ~5 µs. Per uncached SVG render: ~3-5 µs.
 *
 * USAGE in live_flights.cjs:
 *   const badgePresence = require('./badge_presence.cjs');
 *
 *   // After Express app + apiCache are initialized:
 *   badgePresence.attach({ app, apiCache });
 *
 *   // Inside pollAndBroadcastFlights, AFTER `const finalFlights = ...`:
 *   badgePresence.indexFlights(apiCache, sessionId, serverName, finalFlights);
 */

const registry = require('./registry.cjs');
const badgeRenderer = require('./badge_renderer.cjs');

/* =========================
 * Activity scoring
 * ========================= */

/**
 * Score a flight by how "active" it looks. Used to pick the best flight
 * when a single user has multiple sessions across servers (e.g. idle on
 * Expert while testing on Training).
 *
 * Scores combine: connection state, freshness of last position report,
 * whether they're moving, and whether pilotState is set.
 */
function scoreFlightActivity(flight) {
  if (!flight) return -Infinity;
  let score = 0;

  // Strongest signal: is the IF client actively connected
  if (flight.isConnected === true) score += 100;
  else if (flight.isConnected === false) score -= 50;

  // Recency of last position report
  const lastMs = flight.position?.lastReportMs;
  if (typeof lastMs === 'number') {
    const ageMs = Date.now() - lastMs;
    if (ageMs < 10_000) score += 50;
    else if (ageMs < 30_000) score += 20;
    else if (ageMs > 120_000) score -= 30;
  }

  // Movement signals
  const gs = flight.position?.gs_kt;
  const alt = flight.position?.alt_ft;
  if (typeof gs === 'number' && gs > 5) score += 20;
  if (typeof alt === 'number' && alt > 1000) score += 20;

  // pilotState being non-null means actively piloted
  if (flight.pilotState !== null && flight.pilotState !== undefined) score += 10;

  return score;
}

/* =========================
 * Username index
 * Built fresh each poll cycle by pollAndBroadcastFlights — no leak surface.
 * Stored on apiCache as: apiCache.usernameIndex (Map<sessionId, Map<lcUsername, [{flight, sessionId, server}]>>)
 * ========================= */

/**
 * Called by the broadcaster after computing simplified flights for a session.
 * Replaces the previous index for that session — never accumulates.
 */
function indexFlights(apiCache, sessionId, serverName, finalFlights) {
  if (!apiCache.usernameIndex) {
    apiCache.usernameIndex = new Map();
  }

  const sessionMap = new Map();
  const optedInBumps = [];

  for (const f of finalFlights) {
    if (!f.username) continue;
    const key = f.username.toLowerCase();

    const entry = { flight: f, sessionId, server: serverName };
    if (!sessionMap.has(key)) sessionMap.set(key, [entry]);
    else sessionMap.get(key).push(entry);

    if (registry.isOptedIn(key)) optedInBumps.push(key);
  }

  apiCache.usernameIndex.set(sessionId, sessionMap);

  // Bump last_seen_active for opted-in users observed flying.
  // Done via setImmediate to keep the broadcast hot path clean.
  if (optedInBumps.length > 0) {
    setImmediate(() => registry.bumpActivity(optedInBumps));
  }
}

/**
 * Find the best flight for a username across all sessions.
 * Returns { flight, sessionId, server } or null.
 */
function findFlightByUsername(apiCache, username) {
  if (!username || !apiCache.usernameIndex) return null;
  const key = username.toLowerCase();

  let best = null;
  let bestScore = -Infinity;

  for (const sessionMap of apiCache.usernameIndex.values()) {
    const entries = sessionMap.get(key);
    if (!entries) continue;
    for (const entry of entries) {
      const score = scoreFlightActivity(entry.flight);
      if (score > bestScore) {
        bestScore = score;
        best = entry;
      }
    }
  }

  // If even the best looks dead/stale, treat as offline
  if (bestScore < 0) return null;
  return best;
}

/* =========================
 * Per-IP token-bucket rate limit
 * ========================= */

function makeRateLimiter({ maxTokens, windowMs }) {
  const buckets = new Map(); // ip -> { tokens, lastRefill }

  function check(ip) {
    if (!ip) ip = 'unknown';
    const now = Date.now();
    const entry = buckets.get(ip) || { tokens: maxTokens, lastRefill: now };
    const elapsed = now - entry.lastRefill;
    const refill = (elapsed / windowMs) * maxTokens;
    entry.tokens = Math.min(maxTokens, entry.tokens + refill);
    entry.lastRefill = now;
    if (entry.tokens < 1) {
      buckets.set(ip, entry);
      return false;
    }
    entry.tokens -= 1;
    buckets.set(ip, entry);
    return true;
  }

  // Periodic cleanup of stale entries
  const cleanup = setInterval(() => {
    const now = Date.now();
    const stale = now - 10 * 60 * 1000;
    for (const [ip, entry] of buckets) {
      if (entry.lastRefill < stale) buckets.delete(ip);
    }
  }, 5 * 60 * 1000);
  cleanup.unref?.();

  return { check, _size: () => buckets.size };
}

const badgeRateLimit = makeRateLimiter({ maxTokens: 60, windowMs: 60_000 });
const presenceRateLimit = makeRateLimiter({ maxTokens: 20, windowMs: 60_000 });
const registryRateLimit = makeRateLimiter({ maxTokens: 5, windowMs: 60_000 });

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

/* =========================
 * Badge SVG cache (LRU-ish with size cap)
 * ========================= */

const BADGE_CACHE_TTL_MS = 60 * 1000;
const BADGE_CACHE_MAX = 5000;
const badgeCache = new Map(); // key -> { svg, stateHash, expiresAt }

function setBadgeCached(key, svg, stateHash) {
  if (badgeCache.size >= BADGE_CACHE_MAX) {
    // Evict oldest 10%
    const evictCount = Math.floor(BADGE_CACHE_MAX * 0.1);
    const it = badgeCache.keys();
    for (let i = 0; i < evictCount; i++) {
      const next = it.next();
      if (next.done) break;
      badgeCache.delete(next.value);
    }
  }
  badgeCache.set(key, { svg, stateHash, expiresAt: Date.now() + BADGE_CACHE_TTL_MS });
}

function getBadgeCached(key) {
  const entry = badgeCache.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    badgeCache.delete(key);
    return null;
  }
  return entry;
}

// Periodic cleanup of expired entries
const badgeCacheSweep = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of badgeCache) {
    if (now >= entry.expiresAt) badgeCache.delete(key);
  }
}, 5 * 60 * 1000);
badgeCacheSweep.unref?.();

/* =========================
 * State hashing — only the visually meaningful fields
 * Altitude is rounded to nearest 1000 ft so minor variation doesn't churn the cache.
 * ========================= */

function computeStateHash(hit) {
  if (!hit) return 'offline';
  const f = hit.flight;
  const altBucket = Math.round((f.position?.alt_ft || 0) / 1000);
  const gsBucket = Math.round((f.position?.gs_kt || 0) / 25); // bucket to 25kt
  return [
    f.callsign || '',
    f.aircraft?.aircraftId || '',
    f.departureIcao || '',
    f.arrivalIcao || '',
    altBucket,
    gsBucket,
    hit.server || '',
  ].join('|');
}

/* =========================
 * Endpoints
 * ========================= */

function attach({ app, apiCache }) {
  if (!app || !apiCache) {
    throw new Error('badge_presence.attach requires { app, apiCache }');
  }

  /* ---------- BADGE ---------- */
  app.get('/badge/:username.svg', (req, res) => {
    const ip = getClientIp(req);
    if (!badgeRateLimit.check(ip)) {
      res.set('Retry-After', '60');
      return res.status(429).send('Rate limit exceeded');
    }

    const username = String(req.params.username || '');
    const theme = req.query.theme === 'light' ? 'light' : 'dark';

    // Sanity check on path param so we don't render abuse strings
    if (username.length === 0 || username.length > 64) {
      return res.status(400).send('Invalid username');
    }

    const optedIn = registry.isOptedIn(username);
    const hit = optedIn ? findFlightByUsername(apiCache, username) : null;

    let stateHash, state;
    if (!optedIn) {
      stateHash = `notoptedin|${theme}`;
      state = 'not_opted_in';
    } else if (!hit) {
      stateHash = `offline|${theme}`;
      state = 'offline';
    } else {
      stateHash = computeStateHash(hit) + '|' + theme;
      state = 'active';
    }

    // ETag short-circuit — saves bandwidth dramatically when forum proxies hit us
    const etag = `"${stateHash}"`;
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }

    const cacheKey = `${username.toLowerCase()}::${stateHash}`;
    let cached = getBadgeCached(cacheKey);
    if (!cached) {
      const svg = badgeRenderer.render(
        username,
        hit?.flight || null,
        hit?.server || null,
        theme,
        state
      );
      setBadgeCached(cacheKey, svg, stateHash);
      cached = { svg };
    }

    res.set({
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=30, stale-while-revalidate=60',
      'ETag': etag,
      // Defensive: prevent the SVG itself from being interpreted as a top-level page in legacy browsers
      'X-Content-Type-Options': 'nosniff',
    });
    res.send(cached.svg);
  });

  /* ---------- PRESENCE (for desktop helper) ---------- */
  app.get('/api/presence/:username', (req, res) => {
    const ip = getClientIp(req);
    if (!presenceRateLimit.check(ip)) {
      res.set('Retry-After', '60');
      return res.status(429).json({ ok: false, error: 'Rate limited. Helper should poll no faster than every 15s.' });
    }

    const username = String(req.params.username || '');
    if (username.length === 0 || username.length > 64) {
      return res.status(400).json({ ok: false, error: 'Invalid username' });
    }

    if (!registry.isOptedIn(username)) {
      res.set('Cache-Control', 'public, max-age=30');
      return res.json({ ok: true, state: 'not_opted_in' });
    }

    const hit = findFlightByUsername(apiCache, username);
    if (!hit) {
      res.set('Cache-Control', 'public, max-age=15');
      return res.json({ ok: true, state: 'offline' });
    }

    const f = hit.flight;
    res.set('Cache-Control', 'public, max-age=10');
    return res.json({
      ok: true,
      state: 'flying',
      callsign: f.callsign || null,
      aircraft: f.aircraft?.aircraftName || null,
      livery: f.aircraft?.liveryName || null,
      departureIcao: f.departureIcao || null,
      arrivalIcao: f.arrivalIcao || null,
      altitude_ft: f.position?.alt_ft ?? null,
      groundSpeed_kt: f.position?.gs_kt ?? null,
      verticalSpeed_fpm: f.position?.vs_fpm ?? null,
      heading_deg: f.position?.heading_deg ?? null,
      latitude: f.position?.lat ?? null,
      longitude: f.position?.lon ?? null,
      server: hit.server,
      isVAMember: !!f.isVAMember,
      vaRole: f.vaRole || null,
      // Helpers use this as the "started" anchor for Discord's elapsed timer
      lastReportMs: f.position?.lastReportMs || null,
    });
  });

  /* ---------- REGISTRY (opt-in / opt-out) ---------- */
  // NOTE: host is expected to have `app.use(express.json())` mounted globally,
  // which live_flights.cjs already does. req.body will be parsed.
  app.post('/api/registry/opt-in', (req, res) => {
    const ip = getClientIp(req);
    if (!registryRateLimit.check(ip)) {
      res.set('Retry-After', '60');
      return res.status(429).json({ ok: false, error: 'Rate limited' });
    }

    const username = req.body?.username;
    const result = registry.registerUser(username);
    if (!result.ok) return res.status(400).json(result);

    return res.json({
      ok: true,
      alreadyRegistered: !!result.alreadyRegistered,
      message: result.alreadyRegistered
        ? 'Already opted in.'
        : 'Successfully opted in. Your badge is now live.',
      badgeUrl: `/badge/${encodeURIComponent(username)}.svg`,
      presenceUrl: `/api/presence/${encodeURIComponent(username)}`,
    });
  });

  app.post('/api/registry/opt-out', (req, res) => {
    const ip = getClientIp(req);
    if (!registryRateLimit.check(ip)) {
      res.set('Retry-After', '60');
      return res.status(429).json({ ok: false, error: 'Rate limited' });
    }

    const username = req.body?.username;
    const result = registry.unregisterUser(username);
    if (!result.ok) return res.status(400).json(result);

    return res.json({
      ok: true,
      wasRegistered: !!result.wasRegistered,
      message: result.wasRegistered
        ? 'Opted out. Badge will return "not enabled".'
        : 'You were not opted in.',
    });
  });

  /* ---------- DEBUG / OPS ---------- */
  app.get('/api/registry/stats', (req, res) => {
    const stats = registry.getStats();
    res.json({
      ok: true,
      registry: stats,
      caches: {
        badgeCacheEntries: badgeCache.size,
        usernameIndexSessions: apiCache.usernameIndex?.size || 0,
      },
    });
  });

  console.log('✅ [badge-presence] Routes attached.');
}

module.exports = {
  attach,
  indexFlights,
  // Exposed for tests
  _scoreFlightActivity: scoreFlightActivity,
  _findFlightByUsername: findFlightByUsername,
  _computeStateHash: computeStateHash,
};
