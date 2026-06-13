/* =========================
 * APNs push (watchlist alerts + Live Activity updates)
 * =========================
 * Token-based APNs auth (ES256 provider JWT over HTTP/2 via Node's built-in
 * http2 module — no extra dependencies). Device + Live Activity token
 * registries persist in SQLite so they survive restarts.
 *
 * Env:
 *   APNS_KEY_P8     contents of the .p8 auth key (literal "\n" allowed)
 *   APNS_KEY_PATH   alternative: path to the .p8 file
 *   APNS_KEY_ID     key id of the .p8
 *   APNS_TEAM_ID    Apple developer team id
 *   APNS_TOPIC      app bundle id (default com.tracker.Inflight)
 *   APNS_HOST       default https://api.push.apple.com (production)
 */

const http2 = require('http2');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const supabase = require('./supabase.cjs');

const APNS_HOST = (process.env.APNS_HOST || 'https://api.push.apple.com').trim();
const APNS_TOPIC = (process.env.APNS_TOPIC || 'com.tracker.Inflight').trim();
const LIVE_ACTIVITY_TOPIC = `${APNS_TOPIC}.push-type.liveactivity`;
const KEY_ID = (process.env.APNS_KEY_ID || '').trim();
const TEAM_ID = (process.env.APNS_TEAM_ID || '').trim();

let PRIVATE_KEY_PEM = process.env.APNS_KEY_P8 || '';
if (!PRIVATE_KEY_PEM && process.env.APNS_KEY_PATH) {
  try {
    PRIVATE_KEY_PEM = fs.readFileSync(process.env.APNS_KEY_PATH.trim(), 'utf8');
  } catch (e) {
    console.error('[push] ❌ Could not read APNS_KEY_PATH:', e.message);
  }
}
// Allow the key to be pasted into an env var with literal "\n" sequences.
PRIVATE_KEY_PEM = PRIVATE_KEY_PEM.replace(/\\n/g, '\n').trim();

function configured() {
  return !!(KEY_ID && TEAM_ID && PRIVATE_KEY_PEM);
}

/* =========================
 * Token registries (SQLite)
 * ========================= */

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'push_tokens.db');

if (!fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    console.error(`[push] ❌ Failed to create data directory at ${DATA_DIR}:`, e.message);
  }
}

let db;
try {
  db = new Database(DB_PATH);
} catch (e) {
  console.error('[push] ❌ Could not open DB, falling back to in-memory:', e.message);
  console.warn('[push] Push tokens will NOT persist across restarts!');
  db = new Database(':memory:');
}

db.pragma('journal_mode = WAL');

db.prepare(`
  CREATE TABLE IF NOT EXISTS push_devices (
    user_id TEXT NOT NULL,
    device_token TEXT NOT NULL,
    platform TEXT NOT NULL DEFAULT 'ios',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, device_token)
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS live_activity_tokens (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    activity_id TEXT,
    flight_id TEXT,
    updated_at INTEGER NOT NULL,
    misses INTEGER NOT NULL DEFAULT 0,
    last_push_at INTEGER NOT NULL DEFAULT 0
  )
`).run();

const stmts = {
  upsertDevice: db.prepare(`
    INSERT INTO push_devices (user_id, device_token, platform, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id, device_token)
    DO UPDATE SET platform = excluded.platform, updated_at = excluded.updated_at
  `),
  deleteDevice: db.prepare('DELETE FROM push_devices WHERE user_id = ? AND device_token = ?'),
  pruneDeviceToken: db.prepare('DELETE FROM push_devices WHERE device_token = ?'),
  devicesForUser: db.prepare("SELECT device_token FROM push_devices WHERE user_id = ? AND platform = 'ios'"),
  upsertLaToken: db.prepare(`
    INSERT INTO live_activity_tokens (token, user_id, kind, activity_id, flight_id, updated_at, misses, last_push_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, 0)
    ON CONFLICT (token)
    DO UPDATE SET user_id = excluded.user_id, kind = excluded.kind,
                  activity_id = excluded.activity_id, flight_id = excluded.flight_id,
                  updated_at = excluded.updated_at, misses = 0
  `),
  deleteLaToken: db.prepare('DELETE FROM live_activity_tokens WHERE token = ?'),
  laUpdateTokens: db.prepare("SELECT * FROM live_activity_tokens WHERE kind = 'update'"),
  setLaState: db.prepare('UPDATE live_activity_tokens SET misses = ?, last_push_at = ? WHERE token = ?'),
};

// APNs device tokens are hex (64 chars for alert pushes, longer for Live
// Activity tokens). Normalize to lowercase; reject anything else.
function normalizeHexToken(value) {
  const t = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{8,512}$/.test(t) ? t : null;
}

/* =========================
 * APNs HTTP/2 client
 * ========================= */

let providerTokenCache = null; // { token, issuedAt }

// Provider JWTs must be regenerated between 20 and 60 minutes — refresh at 50.
function providerToken() {
  const nowSec = Math.floor(Date.now() / 1000);
  if (providerTokenCache && nowSec - providerTokenCache.issuedAt < 50 * 60) {
    return providerTokenCache.token;
  }
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: KEY_ID })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: TEAM_ID, iat: nowSec })).toString('base64url');
  const signingInput = `${header}.${payload}`;
  const signature = crypto
    .sign('sha256', Buffer.from(signingInput), {
      key: crypto.createPrivateKey(PRIVATE_KEY_PEM),
      dsaEncoding: 'ieee-p1363',
    })
    .toString('base64url');
  providerTokenCache = { token: `${signingInput}.${signature}`, issuedAt: nowSec };
  return providerTokenCache.token;
}

let apnsSession = null;

function getApnsSession() {
  if (apnsSession && !apnsSession.closed && !apnsSession.destroyed) return apnsSession;
  apnsSession = http2.connect(APNS_HOST);
  apnsSession.on('error', (e) => {
    console.warn('[push] APNs session error:', e.message);
    apnsSession = null;
  });
  apnsSession.on('goaway', () => {
    try { apnsSession.close(); } catch (_) { /* already gone */ }
    apnsSession = null;
  });
  return apnsSession;
}

function apnsRequest(deviceToken, headers, body) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = getApnsSession().request({
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${providerToken()}`,
        'content-type': 'application/json',
        ...headers,
      });
    } catch (e) {
      return reject(e);
    }
    let status = 0;
    const chunks = [];
    req.setTimeout(10000, () => {
      req.close(http2.constants.NGHTTP2_CANCEL);
      reject(new Error('APNs request timed out'));
    });
    req.on('response', (h) => { status = h[':status']; });
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { /* empty body */ }
      resolve({ status, body: parsed });
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

// Send one push; prunes the token from both registries when APNs says it's
// dead (410 Unregistered / 400 BadDeviceToken). Returns the HTTP status
// (0 on transport failure) so callers can decide what to record.
async function sendToToken(token, headers, payload) {
  try {
    const { status, body } = await apnsRequest(token, headers, payload);
    if (status === 410 || (status === 400 && body?.reason === 'BadDeviceToken')) {
      stmts.pruneDeviceToken.run(token);
      stmts.deleteLaToken.run(token);
      console.log(`[push] 🧹 Pruned dead APNs token (HTTP ${status}).`);
    } else if (status >= 300) {
      console.warn(`[push] ⚠️ APNs rejected push: HTTP ${status} ${body?.reason || ''}`.trim());
    }
    return status;
  } catch (e) {
    console.warn('[push] ⚠️ APNs send failed:', e.message);
    return 0;
  }
}

/* =========================
 * REST: token registries
 * ========================= */

function apiError(status, message) {
  return { ok: false, error: { status, message } };
}

function registerRoutes(app, requireAuth) {
  // Idempotent upsert keyed (userId, deviceToken); the client re-sends on
  // sign-in and token rotation.
  app.post('/api/push/devices', requireAuth, (req, res) => {
    const token = normalizeHexToken(req.body?.deviceToken);
    if (!token) return res.status(400).json(apiError(400, 'Invalid or missing deviceToken'));
    const platform = typeof req.body?.platform === 'string' && req.body.platform.trim()
      ? req.body.platform.trim().toLowerCase()
      : 'ios';
    try {
      stmts.upsertDevice.run(req.userId, token, platform, Date.now());
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json(apiError(500, `Failed to register device: ${e.message}`));
    }
  });

  app.delete('/api/push/devices/:deviceToken', requireAuth, (req, res) => {
    const token = normalizeHexToken(req.params.deviceToken);
    try {
      if (token) stmts.deleteDevice.run(req.userId, token);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json(apiError(500, `Failed to remove device: ${e.message}`));
    }
  });

  app.post('/api/push/live-activity-tokens', requireAuth, (req, res) => {
    const token = normalizeHexToken(req.body?.token);
    const kind = req.body?.kind;
    if (!token) return res.status(400).json(apiError(400, 'Invalid or missing token'));
    if (kind !== 'update' && kind !== 'start') {
      return res.status(400).json(apiError(400, 'kind must be "update" or "start"'));
    }
    const activityId = typeof req.body?.activityId === 'string' ? req.body.activityId : null;
    const flightId = typeof req.body?.flightId === 'string' ? req.body.flightId : null;
    if (kind === 'update' && !flightId) {
      return res.status(400).json(apiError(400, 'flightId is required when kind=update'));
    }
    try {
      stmts.upsertLaToken.run(token, req.userId, kind, activityId, flightId, Date.now());
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json(apiError(500, `Failed to register live activity token: ${e.message}`));
    }
  });
}

/* =========================
 * Watchlist alert pushes
 * ========================= */

// Server-side dedupe: max one online-push per (user, pilot) per 60s.
const recentOnlinePush = new Map(); // `${userId}|${pilotLower}` -> ts
const ONLINE_PUSH_DEDUPE_MS = 60 * 1000;

function pruneOnlinePushDedupe() {
  if (recentOnlinePush.size < 1000) return;
  const cutoff = Date.now() - ONLINE_PUSH_DEDUPE_MS;
  for (const [k, ts] of recentOnlinePush) {
    if (ts < cutoff) recentOnlinePush.delete(k);
  }
}

async function notifyWatchersPilotOnline(username, flight) {
  if (!configured() || !supabase.hasServiceKey()) return;

  let watcherIds;
  try {
    watcherIds = await supabase.getWatcherUserIds(username);
  } catch (e) {
    console.warn('[push] ⚠️ Watcher lookup failed:', e.message);
    return;
  }
  if (!watcherIds.length) return;

  const lower = String(username).toLowerCase();
  const dep = flight?.departureIcao || '????';
  const arr = flight?.arrivalIcao || '????';
  const aircraft = flight?.aircraft?.aircraftName || 'Unknown aircraft';
  const payload = {
    aps: {
      alert: { title: username, subtitle: 'Now online', body: `${dep} → ${arr} · ${aircraft}` },
      sound: 'default',
      'thread-id': 'inflight-watchlist',
    },
    kind: 'watchlist_online',
    username: lower,
  };
  const headers = {
    'apns-topic': APNS_TOPIC,
    'apns-push-type': 'alert',
    'apns-priority': '10',
    // Matches the client's local dedupe identifier. Collapse ids are capped
    // at 64 bytes by APNs.
    'apns-collapse-id': `watchlist-online-${lower}`.slice(0, 64),
  };

  const now = Date.now();
  for (const userId of watcherIds) {
    const dedupeKey = `${userId}|${lower}`;
    if (now - (recentOnlinePush.get(dedupeKey) || 0) < ONLINE_PUSH_DEDUPE_MS) continue;
    if (!(await supabase.isWatchlistNotificationEnabled(userId))) continue;
    const devices = stmts.devicesForUser.all(userId);
    if (!devices.length) continue;
    recentOnlinePush.set(dedupeKey, now);
    for (const d of devices) {
      await sendToToken(d.device_token, headers, payload);
    }
  }
  pruneOnlinePushDedupe();
}

/* =========================
 * Live Activity update pushes
 * ========================= */

// Swift's synthesized Codable decodes Date as seconds since 2001-01-01
// (Apple reference date), NOT unix seconds — see the spec's gotcha.
const APPLE_EPOCH_OFFSET = 978307200;
const LA_MIN_INTERVAL_MS = 45 * 1000; // spec cadence is ~50s; poller can be faster
const LA_END_AFTER_MISSES = 2;

let airportsIndex = null;
function airportCoords(icao) {
  if (!airportsIndex) {
    try {
      airportsIndex = JSON.parse(fs.readFileSync(path.join(__dirname, 'airports.json'), 'utf8'));
    } catch (e) {
      console.error('[push] ❌ Could not load airports.json:', e.message);
      airportsIndex = {};
    }
  }
  const a = airportsIndex[String(icao || '').toUpperCase()];
  return a && typeof a.lat === 'number' && typeof a.lon === 'number' ? a : null;
}

function haversineNm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const EARTH_RADIUS_NM = 3440.065;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(a)));
}

function liveActivityContentState(flight) {
  const pos = flight?.position || {};
  const dest = airportCoords(flight?.arrivalIcao);
  const nowSec = Math.floor(Date.now() / 1000);

  let distanceNm = null;
  if (dest && typeof pos.lat === 'number' && typeof pos.lon === 'number') {
    distanceNm = haversineNm(pos.lat, pos.lon, dest.lat, dest.lon);
  }
  const gs = typeof pos.gs_kt === 'number' ? pos.gs_kt : 0;
  const isLanded = distanceNm !== null && distanceNm < 15 && gs < 40;

  let etaSec = nowSec;
  if (distanceNm !== null && !isLanded) {
    const speed = gs > 50 ? gs : 450; // fall back to a cruise estimate pre-takeoff
    etaSec = nowSec + Math.round((distanceNm / speed) * 3600);
  }

  // currentATD is omitted — the live API doesn't expose departure time.
  return {
    distanceToDestinationNm: distanceNm !== null ? Math.round(distanceNm * 10) / 10 : 0,
    currentETA: etaSec - APPLE_EPOCH_OFFSET,
    isLanded,
  };
}

function laHeaders() {
  return {
    'apns-topic': LIVE_ACTIVITY_TOPIC,
    'apns-push-type': 'liveactivity',
    'apns-priority': '10',
  };
}

// Called on the flight-snapshot cadence with a Map of flightId -> flight
// (all servers). Pushes progress to every registered kind=update token; ends
// the activity (and drops the token) once the flight lands or vanishes for
// two consecutive cycles. kind=start tokens are stored but not used yet (4d).
async function pushLiveActivityUpdates(flightById) {
  if (!configured()) return;

  let tokens;
  try {
    tokens = stmts.laUpdateTokens.all();
  } catch (e) {
    console.warn('[push] ⚠️ Could not read live activity tokens:', e.message);
    return;
  }

  for (const t of tokens) {
    const now = Date.now();
    if (now - (t.last_push_at || 0) < LA_MIN_INTERVAL_MS) continue;
    const nowSec = Math.floor(now / 1000);
    const flight = t.flight_id ? flightById.get(t.flight_id) : null;

    if (!flight) {
      const misses = (t.misses || 0) + 1;
      if (misses >= LA_END_AFTER_MISSES) {
        await sendToToken(t.token, laHeaders(), {
          aps: { timestamp: nowSec, event: 'end', 'dismissal-date': nowSec + 15 * 60 },
        });
        stmts.deleteLaToken.run(t.token);
      } else {
        stmts.setLaState.run(misses, t.last_push_at || 0, t.token);
      }
      continue;
    }

    const contentState = liveActivityContentState(flight);
    if (contentState.isLanded) {
      await sendToToken(t.token, laHeaders(), {
        aps: {
          timestamp: nowSec,
          event: 'end',
          'dismissal-date': nowSec + 15 * 60,
          'content-state': contentState,
        },
      });
      stmts.deleteLaToken.run(t.token);
    } else {
      await sendToToken(t.token, laHeaders(), {
        aps: { timestamp: nowSec, event: 'update', 'content-state': contentState },
      });
      // Throttle even after an APNs rejection so a bad token can't be
      // retried every poll cycle. Dead tokens were already pruned above.
      stmts.setLaState.run(0, now, t.token);
    }
  }
}

module.exports = {
  configured,
  registerRoutes,
  notifyWatchersPilotOnline,
  pushLiveActivityUpdates,
};
