/* =========================
 * Discord Rich Presence broker
 * =========================
 * The tracker's Discord presence runs entirely in the browser: it talks to the
 * user's local Discord desktop client over its RPC websocket (127.0.0.1:6463+)
 * and pushes SET_ACTIVITY frames as the watched flight moves. Two things in
 * that flow cannot happen in the browser, and they are all this module does:
 *
 *   1. Token exchange. Discord's RPC AUTHORIZE command hands the page an OAuth
 *      *code*. Turning that into an access token needs the app's client secret,
 *      which must never ship to a browser. POST /api/discord/presence/token
 *      does the exchange server-side.
 *
 *   2. Image hosting. Activity assets are normally fixed keys uploaded in the
 *      developer portal, which cannot show a per-airframe community photo.
 *      Discord's external-assets endpoint mints an `mp:external/...` key for an
 *      arbitrary https image, and it needs the bot token.
 *      POST /api/discord/presence/assets wraps it and caches the result — the
 *      same livery is requested by every viewer watching that flight.
 *
 * Nothing here is stateful beyond the asset cache, and nothing is stored per
 * user: the access token goes straight back to the caller that produced the
 * code. If the credentials below are unset the whole feature reports itself
 * disabled and the client silently skips it, so an unconfigured deploy behaves
 * exactly like today.
 *
 * ── Remote control ─────────────────────────────────────────────────────────
 * Rich Presence can only be reported to a Discord client on the same machine,
 * so a phone can never push its own. What it can do is tell the pilot's laptop
 * what to broadcast: the chosen flight lives here, keyed to their account, and
 * the desktop tab polls for it. That is the third job this module does — hold
 * one small piece of per-user state (which flight, and is a desktop tab alive)
 * so two devices can agree on it.
 *
 * The state is deliberately in-memory. It is control state, not user data: a
 * flight target is meaningless an hour after the flight lands, and the desktop
 * tab re-seeds its own target after a restart, so a redeploy costs one poll
 * interval rather than anything a pilot would notice. Revisions keep the two
 * writers honest — a heartbeat never overwrites a newer pick from the phone.
 *
 * Env:
 * Env — all namespaced under DISCORD_PRESENCE_*, because the VA bot already
 * owns the bare DISCORD_CLIENT_ID / DISCORD_BOT_TOKEN names. See clientId().
 *
 *   DISCORD_PRESENCE_CLIENT_ID      application id (public; served to the client)
 *   DISCORD_PRESENCE_CLIENT_SECRET  required for the code→token exchange
 *   DISCORD_PRESENCE_BOT_TOKEN      required for external image assets
 *   DISCORD_PRESENCE_REDIRECT       redirect URI registered on the app
 *                                   (default https://inflight.info)
 *   DISCORD_PRESENCE_ENABLED        force the master switch (0/false to disable)
 */

const supabase = require('./supabase.cjs');

const DISCORD_API = 'https://discord.com/api/v10';

// A target nobody has touched in this long is from a flight that has long since
// landed. Swept lazily, so an idle process does no work.
const TARGET_TTL_MS = 12 * 60 * 60 * 1000;
const TARGET_MAX = 20000;
// A desktop tab polls every 10s; miss three and it is gone (closed, asleep, or
// the laptop shut). The phone shows that rather than pretending it's live.
const HOST_STALE_MS = 35 * 1000;

// External asset paths are stable for a long time; a day of caching keeps us
// far below any rate limit while a livery stays hot in the live feed.
const ASSET_TTL_MS = 24 * 60 * 60 * 1000;
const ASSET_CACHE_MAX = 4000;

// Per-IP budgets. The client calls /assets once per flight it starts showing
// and /token once per Discord authorisation, so these are generous for real
// use and still cheap to enforce.
const RATE_WINDOW_MS = 60 * 1000;
// The session bucket carries the desktop poll (6/min) with room for a reconnect
// storm; target writes are one per flight the pilot picks.
const RATE_MAX = { token: 10, assets: 60, target: 30, session: 30 };

function boolEnv(name, dflt) {
  const v = String(process.env[name] ?? '').trim().toLowerCase();
  if (!v) return dflt;
  return !['0', 'false', 'no', 'off'].includes(v);
}

// Namespaced, and deliberately with NO fallback to the bare DISCORD_* names.
// The VA bot (database/bot.js) already owns DISCORD_BOT_TOKEN and
// DISCORD_CLIENT_ID, and these services share env config in practice —
// VA_BOT_FORWARD_TOKEN is set for both. A fallback would let presence quietly
// pick up the bot's application: the card would name the wrong app, the token
// exchange would fail `invalid_client` against a mismatched secret, and any
// minted image would 404 under an application that never requested it. Reading
// nothing is a better failure than reading somebody else's credentials.
function clientId() { return String(process.env.DISCORD_PRESENCE_CLIENT_ID || '').trim(); }
function clientSecret() { return String(process.env.DISCORD_PRESENCE_CLIENT_SECRET || '').trim(); }
function botToken() { return String(process.env.DISCORD_PRESENCE_BOT_TOKEN || '').trim(); }
function redirectUri() {
  return String(process.env.DISCORD_PRESENCE_REDIRECT || 'https://inflight.info').trim();
}

/**
 * What the client is allowed to attempt. `enabled` gates the feature entirely;
 * `externalAssets` tells the client whether to bother asking for community
 * photo keys or go straight to the static portal assets.
 */
function capabilities() {
  const configured = !!clientId() && !!clientSecret();
  return {
    ok: true,
    enabled: boolEnv('DISCORD_PRESENCE_ENABLED', configured),
    clientId: clientId() || null,
    externalAssets: !!botToken(),
    // Driving a laptop from a phone needs the account behind both devices, so
    // it is only offered where tokens can actually be verified.
    remote: supabase.canVerifyTokens(),
  };
}

function apiError(status, message) {
  return { ok: false, error: { status, message } };
}

// ---------------------------------------------------------------------------
// Rate limiting — fixed window per IP per bucket.
// ---------------------------------------------------------------------------

const _rate = new Map(); // `${bucket}:${ip}` -> { count, resetAt }

function rateLimited(bucket, req) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const entry = _rate.get(key);

  if (!entry || now >= entry.resetAt) {
    _rate.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    // Opportunistic sweep so the map cannot grow without bound.
    if (_rate.size > 10000) {
      for (const [k, v] of _rate) if (now >= v.resetAt) _rate.delete(k);
    }
    return false;
  }

  entry.count += 1;
  return entry.count > (RATE_MAX[bucket] || 30);
}

// ---------------------------------------------------------------------------
// External assets
// ---------------------------------------------------------------------------

const _assetCache = new Map(); // url -> { key, expiresAt }

function cachedAsset(url) {
  const hit = _assetCache.get(url);
  if (!hit) return undefined;
  if (Date.now() >= hit.expiresAt) {
    _assetCache.delete(url);
    return undefined;
  }
  // Refresh insertion order so the sweep below evicts genuinely cold entries.
  _assetCache.delete(url);
  _assetCache.set(url, hit);
  return hit.key;
}

function storeAsset(url, key) {
  _assetCache.set(url, { key, expiresAt: Date.now() + ASSET_TTL_MS });
  while (_assetCache.size > ASSET_CACHE_MAX) {
    const oldest = _assetCache.keys().next().value;
    if (oldest === undefined) break;
    _assetCache.delete(oldest);
  }
}

/**
 * Only https URLs are worth sending upstream — Discord rejects everything else,
 * and refusing them here keeps the caller from spending a round trip to find
 * that out. The length cap mirrors Discord's own limit on asset paths.
 */
function usableImageUrl(value) {
  if (typeof value !== 'string') return null;
  const url = value.trim();
  if (!url || url.length > 1000) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
    return url;
  } catch (_) {
    return null;
  }
}

/**
 * Resolve https image URLs to `mp:external/...` activity asset keys. Returns a
 * url -> key map containing only what resolved; callers treat a missing entry
 * as "fall back to a static asset", never as an error.
 */
async function resolveExternalAssets(urls) {
  const out = {};
  const token = botToken();
  if (!token) return out;

  const pending = [];
  for (const raw of urls) {
    const url = usableImageUrl(raw);
    if (!url) continue;
    const hit = cachedAsset(url);
    if (hit) out[url] = hit;
    else if (!pending.includes(url)) pending.push(url);
  }
  if (!pending.length) return out;

  const res = await fetch(`${DISCORD_API}/applications/${clientId()}/external-assets`, {
    method: 'POST',
    headers: {
      'Authorization': `Bot ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ urls: pending }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`external-assets ${res.status}: ${body.slice(0, 200)}`);
  }

  const list = await res.json();
  if (!Array.isArray(list)) return out;

  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    const path = entry?.external_asset_path;
    // Discord echoes back the URL it resolved; when it doesn't, the response is
    // in request order, so fall back to the positional match.
    const url = usableImageUrl(entry?.url) || (list.length === pending.length ? pending[i] : null);
    if (!path || !url) continue;
    const key = `mp:${path}`;
    storeAsset(url, key);
    out[url] = key;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Remote control: the shared flight target and the desktop session
// ---------------------------------------------------------------------------

// userId -> { target, revision, updatedAtMs, hostSeenAtMs, hostConnected }
const _targets = new Map();

function sweepTargets() {
    const now = Date.now();
    for (const [userId, record] of _targets) {
        if (now - record.updatedAtMs > TARGET_TTL_MS) _targets.delete(userId);
    }
    // A pathological number of live users is still bounded: drop the coldest.
    while (_targets.size > TARGET_MAX) {
        const oldest = _targets.keys().next().value;
        if (oldest === undefined) break;
        _targets.delete(oldest);
    }
}

/**
 * Accept only the three fields the card needs, bounded. Anything else a client
 * sends is dropped rather than stored — this record is echoed back to the
 * pilot's other devices, so it holds nothing we didn't ask for.
 */
function sanitizeTarget(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const username = typeof raw.username === 'string' ? raw.username.trim().slice(0, 64) : '';
    if (!username) return null;
    return {
        flightId: typeof raw.flightId === 'string' ? raw.flightId.trim().slice(0, 128) : null,
        username,
        label: typeof raw.label === 'string' ? raw.label.trim().slice(0, 64) : username,
        // Which server the flight is on. Carried across devices so the laptop
        // links to the right session for a flight the phone picked.
        server: typeof raw.server === 'string' ? raw.server.trim().slice(0, 64) : '',
    };
}

/** What both devices see: the target, plus whether a desktop tab is alive. */
function describeRecord(record) {
    if (!record) {
        return { target: null, revision: 0, host: { online: false, connected: false } };
    }
    const online = Date.now() - record.hostSeenAtMs < HOST_STALE_MS;
    return {
        target: record.target,
        revision: record.revision,
        host: {
            online,
            // "Online" is a tab that is polling; "connected" is that tab
            // actually holding a Discord socket. The phone needs both to tell
            // "laptop asleep" from "laptop up, Discord closed".
            connected: online && !!record.hostConnected,
            lastSeenMs: record.hostSeenAtMs || null,
        },
    };
}

function readRecord(userId) {
    sweepTargets();
    return describeRecord(_targets.get(userId));
}

function writeTarget(userId, target) {
    sweepTargets();
    const existing = _targets.get(userId);
    const record = existing || { revision: 0, hostSeenAtMs: 0, hostConnected: false };
    record.target = target;
    record.revision += 1;
    record.updatedAtMs = Date.now();
    _targets.set(userId, record);
    return describeRecord(record);
}

/**
 * The desktop tab checking in. It never overwrites the target — that is the
 * phone's job — with one exception: if we hold no record at all, the tab's own
 * revision seeds one, which is how a target survives a backend restart.
 */
function touchSession(userId, { connected, revision, target }) {
    sweepTargets();
    let record = _targets.get(userId);

    if (!record && revision > 0 && target) {
        record = { target, revision, updatedAtMs: Date.now(), hostSeenAtMs: 0, hostConnected: false };
        _targets.set(userId, record);
    }
    if (!record) {
        record = { target: null, revision: 0, updatedAtMs: Date.now(), hostSeenAtMs: 0, hostConnected: false };
        _targets.set(userId, record);
    }

    record.hostSeenAtMs = Date.now();
    record.hostConnected = !!connected;
    return describeRecord(record);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * Every live flight a pilot currently has, across every server.
 *
 * The socket feed the client already has is scoped to one server room, so a
 * pilot flying on Expert while looking at Training cannot see their own
 * aircraft in it — and picking a flight to broadcast is exactly when that
 * matters. This reads the snapshots the poller already holds in memory, so it
 * costs nothing upstream and can be called freely.
 *
 * @param {() => Map<string, {server: string, flights: object[]}>} getFlightsCache
 */
function findPilotFlights(getFlightsCache, username) {
    const wanted = String(username || '').trim().toLowerCase();
    if (!wanted || typeof getFlightsCache !== 'function') return [];

    const cache = getFlightsCache();
    if (!cache || typeof cache.forEach !== 'function') return [];

    const found = [];
    const seen = new Set();
    cache.forEach((payload, sessionId) => {
        for (const flight of payload?.flights || []) {
            if (!flight?.username || flight.username.toLowerCase() !== wanted) continue;
            const key = String(flight.flightId);
            if (seen.has(key)) continue;
            seen.add(key);
            // Tag the server: the client needs it for the deep link, and a
            // pilot with two flights up needs to see which is which.
            found.push({ ...flight, server: payload.server || '', sessionId });
        }
    });
    return found;
}

function registerRoutes(app, deps = {}) {
  // Probed on boot before any Discord code runs, so the client can hide the
  // whole panel on a deploy that has no credentials.
  app.get('/api/discord/presence/config', (req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.json(capabilities());
  });

  // RPC AUTHORIZE gives the page a code; only the server can spend it.
  app.post('/api/discord/presence/token', async (req, res) => {
    const caps = capabilities();
    if (!caps.enabled) return res.status(503).json(apiError(503, 'Discord presence is not configured'));
    if (rateLimited('token', req)) return res.status(429).json(apiError(429, 'Too many token exchanges, try again shortly'));

    const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
    if (!code || code.length > 512) {
      return res.status(400).json(apiError(400, 'code must be a non-empty string'));
    }

    try {
      const body = new URLSearchParams({
        client_id: clientId(),
        client_secret: clientSecret(),
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri(),
      });

      const r = await fetch(`${DISCORD_API}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const json = await r.json().catch(() => null);

      if (!r.ok || !json?.access_token) {
        // Discord's own message ("invalid_grant", bad redirect_uri, …) is the
        // only useful signal for whoever is wiring the app up.
        const detail = json?.error_description || json?.error || `HTTP ${r.status}`;
        console.error('[discord-presence] ❌ Token exchange failed:', detail);
        return res.status(502).json(apiError(502, `Discord rejected the authorisation: ${detail}`));
      }

      res.json({
        ok: true,
        accessToken: json.access_token,
        tokenType: json.token_type || 'Bearer',
        expiresIn: json.expires_in || null,
        scope: json.scope || null,
      });
    } catch (e) {
      console.error('[discord-presence] ❌ Token exchange error:', e.message);
      res.status(502).json(apiError(502, 'Could not reach Discord to exchange the code'));
    }
  });

  // Community aircraft photo -> activity asset key.
  app.post('/api/discord/presence/assets', async (req, res) => {
    const caps = capabilities();
    if (!caps.enabled) return res.status(503).json(apiError(503, 'Discord presence is not configured'));
    if (!caps.externalAssets) return res.status(503).json(apiError(503, 'External activity assets are not configured'));
    if (rateLimited('assets', req)) return res.status(429).json(apiError(429, 'Too many asset lookups, try again shortly'));

    const urls = Array.isArray(req.body?.urls) ? req.body.urls.slice(0, 4) : [];
    if (!urls.length) return res.status(400).json(apiError(400, 'urls must be a non-empty array'));

    try {
      const assets = await resolveExternalAssets(urls);
      res.json({ ok: true, assets });
    } catch (e) {
      console.error('[discord-presence] ❌ Asset resolve failed:', e.message);
      // A miss is survivable — the client falls back to a static asset — so
      // this is reported as a soft failure rather than breaking the presence.
      res.status(502).json(apiError(502, 'Could not resolve the image with Discord'));
    }
  });

  // Everything this pilot has in the air right now, on any server, so the
  // picker can offer all of them. Public for the same reason /flights/:id is:
  // it is the live data the map already shows, just filtered.
  app.get('/api/discord/presence/pilot-flights', (req, res) => {
    if (rateLimited('assets', req)) return res.status(429).json(apiError(429, 'Too many lookups, try again shortly'));

    const username = typeof req.query.username === 'string' ? req.query.username.trim() : '';
    if (!username || username.length > 64) {
      return res.status(400).json(apiError(400, 'username is required'));
    }

    res.set('Cache-Control', 'no-cache');
    res.json({ ok: true, flights: findPilotFlights(deps.getFlightsCache, username) });
  });

  // ── Remote control ──────────────────────────────────────────────────────
  // All three are per-account, so they sit behind the same Supabase token the
  // rest of the authed API uses.

  // What the phone reads to render its remote, and to show laptop status.
  app.get('/api/discord/presence/target', supabase.requireAuth, (req, res) => {
    res.json({ ok: true, ...readRecord(req.userId) });
  });

  // The phone (or the desktop itself) choosing a flight.
  app.put('/api/discord/presence/target', supabase.requireAuth, (req, res) => {
    if (rateLimited('target', req)) return res.status(429).json(apiError(429, 'Too many changes, try again shortly'));

    const clearing = req.body?.clear === true;
    const target = clearing ? null : sanitizeTarget(req.body?.target);
    if (!clearing && !target) {
      return res.status(400).json(apiError(400, 'target.username is required, or pass clear: true'));
    }

    res.json({ ok: true, ...writeTarget(req.userId, target) });
  });

  // The desktop tab checking in and picking up changes. Doubles as the
  // heartbeat, so a tab that stops polling is a laptop that has gone away.
  app.post('/api/discord/presence/session', supabase.requireAuth, (req, res) => {
    if (rateLimited('session', req)) return res.status(429).json(apiError(429, 'Polling too fast'));

    const revision = Number.isFinite(req.body?.revision) ? Math.max(0, Math.floor(req.body.revision)) : 0;
    const state = touchSession(req.userId, {
      connected: req.body?.connected,
      revision,
      target: sanitizeTarget(req.body?.target),
    });

    // `changed` saves the tab from diffing: it re-applies only on a new pick.
    res.json({ ok: true, ...state, changed: state.revision !== revision });
  });
}

module.exports = {
  registerRoutes,
  capabilities,
  resolveExternalAssets,
  findPilotFlights,
};
