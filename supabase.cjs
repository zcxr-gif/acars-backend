/* =========================
 * Supabase integration (auth + watchlist data)
 * =========================
 * Verifies the Supabase access tokens the Inflight client sends as
 * `Authorization: Bearer <jwt>` and reads/writes the existing Supabase tables
 * (`user_watchlist`, `user_preferences`) through PostgREST with the
 * service-role key — so existing users keep their watchlists the moment the
 * backend takes over from the client's direct Supabase access.
 *
 * Env:
 *   SUPABASE_URL                 project URL (defaults to the Inflight project)
 *   SUPABASE_JWT_SECRET          optional — enables local HS256 verification
 *   SUPABASE_SERVICE_ROLE_KEY    required for watchlist CRUD + remote auth
 *   SUPABASE_ANON_KEY            optional fallback apikey for /auth/v1/user
 */

const axios = require('axios');
const crypto = require('crypto');

const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://lcgaoiqwwpyqndaucyzu.supabase.co')
  .trim()
  .replace(/\/+$/, '');
const JWT_SECRET = (process.env.SUPABASE_JWT_SECRET || '').trim();
const SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '').trim();
const ANON_KEY = (process.env.SUPABASE_ANON_KEY || '').trim();

const restClient = SERVICE_KEY
  ? axios.create({
      baseURL: `${SUPABASE_URL}/rest/v1`,
      timeout: 10000,
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
      },
    })
  : null;

function hasServiceKey() {
  return !!SERVICE_KEY;
}

function canVerifyTokens() {
  return !!(JWT_SECRET || SERVICE_KEY || ANON_KEY);
}

/* =========================
 * Access-token verification
 * ========================= */

function b64urlDecode(s) {
  let t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  return Buffer.from(t, 'base64');
}

// HS256 verification against the project's JWT secret. Returns the user id
// (`sub` claim) or null.
function verifyJwtLocally(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header, payload;
  try {
    header = JSON.parse(b64urlDecode(parts[0]).toString('utf8'));
    payload = JSON.parse(b64urlDecode(parts[1]).toString('utf8'));
  } catch (_) {
    return null;
  }
  if (header?.alg !== 'HS256') return null;
  const expected = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${parts[0]}.${parts[1]}`)
    .digest();
  let signature;
  try {
    signature = b64urlDecode(parts[2]);
  } catch (_) {
    return null;
  }
  if (expected.length !== signature.length || !crypto.timingSafeEqual(expected, signature)) {
    return null;
  }
  if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()) return null;
  return typeof payload.sub === 'string' && payload.sub ? payload.sub : null;
}

// Remote fallback: ask Supabase auth who the token belongs to. Verified tokens
// are cached briefly so the watchlist endpoints don't hit /auth/v1/user on
// every request.
const tokenCache = new Map(); // token -> { userId, expiresAt }
const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;
const TOKEN_CACHE_MAX = 5000;

async function verifyJwtRemotely(token) {
  const cached = tokenCache.get(token);
  if (cached && cached.expiresAt > Date.now()) return cached.userId;
  tokenCache.delete(token);

  try {
    const { data } = await axios.get(`${SUPABASE_URL}/auth/v1/user`, {
      timeout: 8000,
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: SERVICE_KEY || ANON_KEY,
      },
    });
    const userId = data?.id || data?.user?.id || null;
    if (userId) {
      tokenCache.set(token, { userId, expiresAt: Date.now() + TOKEN_CACHE_TTL_MS });
      if (tokenCache.size > TOKEN_CACHE_MAX) {
        const overflow = tokenCache.size - TOKEN_CACHE_MAX;
        let i = 0;
        for (const k of tokenCache.keys()) {
          tokenCache.delete(k);
          if (++i >= overflow) break;
        }
      }
    }
    return userId;
  } catch (e) {
    const status = e?.response?.status;
    if (status === 401 || status === 403) return null; // bad/expired token
    throw e; // network / 5xx — caller answers 503, not 401
  }
}

async function verifyAccessToken(token) {
  if (JWT_SECRET) return verifyJwtLocally(token);
  if (SERVICE_KEY || ANON_KEY) return verifyJwtRemotely(token);
  return null;
}

// Express middleware: sets req.userId from the bearer token or rejects 401.
async function requireAuth(req, res, next) {
  const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  if (!match) {
    return res.status(401).json({ ok: false, error: { status: 401, message: 'Missing Authorization bearer token' } });
  }
  try {
    const userId = await verifyAccessToken(match[1].trim());
    if (!userId) {
      return res.status(401).json({ ok: false, error: { status: 401, message: 'Invalid or expired access token' } });
    }
    req.userId = userId;
    next();
  } catch (e) {
    console.error('[supabase] ❌ Token verification failed:', e.message);
    res.status(503).json({ ok: false, error: { status: 503, message: 'Auth verification temporarily unavailable' } });
  }
}

/* =========================
 * Watchlist data (user_watchlist)
 * ========================= */

function requireRest() {
  if (!restClient) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set — watchlist storage unavailable');
  return restClient;
}

// Escape LIKE wildcards so an ilike filter is an exact case-insensitive match.
function escapeIlike(value) {
  return String(value).replace(/[\\%_]/g, '\\$&');
}

function mapEntry(row) {
  return {
    id: String(row.id),
    watchedUsername: row.watched_username,
    addedAt: row.added_at,
  };
}

async function listWatchlist(userId) {
  const { data } = await requireRest().get('/user_watchlist', {
    params: {
      user_id: `eq.${userId}`,
      select: 'id,watched_username,added_at',
      order: 'added_at.desc',
    },
  });
  return (Array.isArray(data) ? data : []).map(mapEntry);
}

// Returns the new entry, or null when (user, username) already exists
// (case-insensitive) — the route turns null into a 409.
async function addWatchlistEntry(userId, username) {
  const rest = requireRest();
  const { data: existing } = await rest.get('/user_watchlist', {
    params: {
      user_id: `eq.${userId}`,
      watched_username: `ilike.${escapeIlike(username)}`,
      select: 'id',
      limit: 1,
    },
  });
  if (Array.isArray(existing) && existing.length > 0) return null;

  try {
    const { data } = await rest.post(
      '/user_watchlist',
      { user_id: userId, watched_username: username, added_at: new Date().toISOString() },
      { headers: { Prefer: 'return=representation' } }
    );
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error('Supabase insert returned no row');
    return mapEntry(row);
  } catch (e) {
    // Unique-violation race between the existence check and the insert.
    if (e?.response?.status === 409 || e?.response?.data?.code === '23505') return null;
    throw e;
  }
}

// True if a row owned by this user was deleted.
async function deleteWatchlistEntry(userId, entryId) {
  try {
    const { data } = await requireRest().delete('/user_watchlist', {
      params: { id: `eq.${entryId}`, user_id: `eq.${userId}` },
      headers: { Prefer: 'return=representation' },
    });
    return Array.isArray(data) && data.length > 0;
  } catch (e) {
    // An id that can't be cast (wrong uuid/bigint shape) is just "not found".
    const code = e?.response?.data?.code;
    if (e?.response?.status === 400 || code === '22P02' || code === '22003') return false;
    throw e;
  }
}

// Every user id that watches this pilot (case-insensitive) — used for pushes.
async function getWatcherUserIds(username) {
  const { data } = await requireRest().get('/user_watchlist', {
    params: {
      watched_username: `ilike.${escapeIlike(username)}`,
      select: 'user_id',
    },
  });
  const ids = (Array.isArray(data) ? data : []).map((r) => r.user_id).filter(Boolean);
  return [...new Set(ids)];
}

/* =========================
 * Notification preference (user_preferences.notification_watchlist_enabled)
 * ========================= */

const prefCache = new Map(); // userId -> { enabled, expiresAt }
const PREF_CACHE_TTL_MS = 5 * 60 * 1000;
const PREF_CACHE_MAX = 5000;

async function isWatchlistNotificationEnabled(userId) {
  const cached = prefCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.enabled;

  // Default to enabled: a missing row (or a Supabase hiccup) must not silently
  // disable everyone's notifications.
  let enabled = true;
  try {
    const { data } = await requireRest().get('/user_preferences', {
      params: {
        user_id: `eq.${userId}`,
        select: 'notification_watchlist_enabled',
        limit: 1,
      },
    });
    const row = Array.isArray(data) ? data[0] : null;
    if (row && row.notification_watchlist_enabled === false) enabled = false;
  } catch (e) {
    console.warn('[supabase] ⚠️ Preference lookup failed (defaulting to enabled):', e.message);
  }

  prefCache.set(userId, { enabled, expiresAt: Date.now() + PREF_CACHE_TTL_MS });
  if (prefCache.size > PREF_CACHE_MAX) {
    const overflow = prefCache.size - PREF_CACHE_MAX;
    let i = 0;
    for (const k of prefCache.keys()) {
      prefCache.delete(k);
      if (++i >= overflow) break;
    }
  }
  return enabled;
}

module.exports = {
  hasServiceKey,
  canVerifyTokens,
  requireAuth,
  verifyAccessToken,
  listWatchlist,
  addWatchlistEntry,
  deleteWatchlistEntry,
  getWatcherUserIds,
  isWatchlistNotificationEnabled,
};
