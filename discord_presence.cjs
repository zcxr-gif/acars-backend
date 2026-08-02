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
 * Env:
 *   DISCORD_CLIENT_ID          — application id (public; served to the client)
 *   DISCORD_CLIENT_SECRET      — required for the code→token exchange
 *   DISCORD_BOT_TOKEN          — required for external image assets
 *   DISCORD_PRESENCE_REDIRECT  — redirect URI registered on the app
 *                                (default https://inflight.info)
 *   DISCORD_PRESENCE_ENABLED   — force the master switch (0/false to disable)
 */

const DISCORD_API = 'https://discord.com/api/v10';

// External asset paths are stable for a long time; a day of caching keeps us
// far below any rate limit while a livery stays hot in the live feed.
const ASSET_TTL_MS = 24 * 60 * 60 * 1000;
const ASSET_CACHE_MAX = 4000;

// Per-IP budgets. The client calls /assets once per flight it starts showing
// and /token once per Discord authorisation, so these are generous for real
// use and still cheap to enforce.
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = { token: 10, assets: 60 };

function boolEnv(name, dflt) {
  const v = String(process.env[name] ?? '').trim().toLowerCase();
  if (!v) return dflt;
  return !['0', 'false', 'no', 'off'].includes(v);
}

function clientId() { return String(process.env.DISCORD_CLIENT_ID || '').trim(); }
function clientSecret() { return String(process.env.DISCORD_CLIENT_SECRET || '').trim(); }
function botToken() { return String(process.env.DISCORD_BOT_TOKEN || '').trim(); }
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
// Routes
// ---------------------------------------------------------------------------

function registerRoutes(app) {
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
}

module.exports = {
  registerRoutes,
  capabilities,
  resolveExternalAssets,
};
