/* =========================
 * APNs push (watchlist alerts + Live Activity updates)
 * =========================
 * Token-based APNs auth (ES256 provider JWT over HTTP/2 via Node's built-in
 * http2 module — no extra dependencies). Device + Live Activity token
 * registries persist in SQLite so they survive restarts.
 *
 * There are two ways to be told about a pilot, and both end up here:
 *
 *   - account-scoped — the Supabase `user_watchlist` the web tracker writes.
 *     Every device signed into that account is notified.
 *   - device-scoped — the native app has no accounts, so it registers the
 *     usernames it cares about against its own APNs token (`device_watch`).
 *     The token is the identity: it is opaque, device-specific and already the
 *     thing we would be pushing to, so there is nothing extra to authenticate.
 *
 * Recipients are resolved from both and de-duplicated by token, so an account
 * holder who also has the native app installed gets one push, not two.
 *
 * Env:
 *   APNS_KEY_P8     contents of the .p8 auth key (literal "\n" allowed)
 *   APNS_KEY_PATH   alternative: path to the .p8 file
 *   APNS_KEY_ID     key id of the .p8
 *   APNS_TEAM_ID    Apple developer team id
 *   APNS_TOPIC      app bundle id (default com.tracker.Inflight)
 *   APNS_HOST       which environment to try first (default production)
 *   APNS_ENV_FALLBACK  0/false to stop trying the other one — see below
 *
 * ## The two APNs environments, and the bug that hid behind them
 *
 * Apple runs two of them. A build signed `aps-environment: development` — every
 * build run from Xcode, and any build whose export did not rewrite the
 * entitlement — registers with the sandbox and is handed a token the
 * PRODUCTION host does not recognise. It does not fail politely: the reply is
 * `400 BadDeviceToken`, which is byte for byte the reply for a token that is
 * genuinely rubbish.
 *
 * This module used to believe it, and prune the token — along with the whole
 * device_watch subscription hanging off it, which is the registry's only owner.
 * So a development or mismatched build did not merely fail to be notified: the
 * first event it should have received erased its watchlist from the server, and
 * every later one had nothing to deliver to. "It never sends any notification at
 * all", exactly, and self-concealing, because the evidence deleted itself.
 *
 * So a token's environment is now something we learn rather than assume. A
 * `BadDeviceToken` is retried once against the other host; whichever one accepts
 * it is remembered per token, and a token is only ever pruned when BOTH have
 * refused it. Nothing to configure, and it repairs a fleet that is a mixture —
 * which every TestFlight-plus-Xcode fleet is.
 */

const http2 = require('http2');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const supabase = require('./supabase.cjs');
const geo = require('./geo.cjs');

const APNS_PRODUCTION_HOST = 'https://api.push.apple.com';
const APNS_SANDBOX_HOST = 'https://api.sandbox.push.apple.com';

const APNS_HOST = (process.env.APNS_HOST || APNS_PRODUCTION_HOST).trim();

// The one to try second. Derived rather than configured: there are exactly two,
// and "the other one" is never a judgement call.
const APNS_ALT_HOST = APNS_HOST === APNS_SANDBOX_HOST ? APNS_PRODUCTION_HOST : APNS_SANDBOX_HOST;

function envFallbackEnabled() {
  const v = String(process.env.APNS_ENV_FALLBACK ?? '').trim().toLowerCase();
  if (!v) return true;
  return !['0', 'false', 'no', 'off'].includes(v);
}

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

// Which pilots one device wants to hear about. Rows are owned by the APNs
// token, so uninstalling the app (which kills the token) takes the whole
// subscription with it the first time APNs answers 410.
db.prepare(`
  CREATE TABLE IF NOT EXISTS device_watch (
    device_token TEXT NOT NULL,
    username TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (device_token, username)
  )
`).run();

db.prepare('CREATE INDEX IF NOT EXISTS device_watch_username ON device_watch (username)').run();

// Which APNs environment a token actually belongs to, learned the first time
// one host accepts it. Rows are only ever written after a 2xx, so nothing in
// here is a guess — and a token missing from this table simply means the
// configured host has not been contradicted yet.
db.prepare(`
  CREATE TABLE IF NOT EXISTS apns_environment (
    token TEXT PRIMARY KEY,
    host TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )
`).run();

// Which event kinds that device wants, as a JSON object. Kept in its own table
// rather than repeated on every watch row: the choice is per device, not per
// pilot.
db.prepare(`
  CREATE TABLE IF NOT EXISTS device_prefs (
    device_token TEXT PRIMARY KEY,
    events TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )
`).run();

// Live Activities can be started remotely for a device that has no account, so
// a start token needs to be findable by device token as well as by user. Added
// by migration because the table predates the native app.
{
  const columns = db.prepare('PRAGMA table_info(live_activity_tokens)').all();
  if (!columns.some((c) => c.name === 'device_token')) {
    db.prepare('ALTER TABLE live_activity_tokens ADD COLUMN device_token TEXT').run();
  }
}

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
    INSERT INTO live_activity_tokens (token, user_id, kind, activity_id, flight_id, device_token, updated_at, misses, last_push_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)
    ON CONFLICT (token)
    DO UPDATE SET user_id = excluded.user_id, kind = excluded.kind,
                  activity_id = excluded.activity_id, flight_id = excluded.flight_id,
                  device_token = excluded.device_token,
                  updated_at = excluded.updated_at, misses = 0
  `),
  deleteLaToken: db.prepare('DELETE FROM live_activity_tokens WHERE token = ?'),
  laUpdateTokens: db.prepare("SELECT * FROM live_activity_tokens WHERE kind = 'update'"),
  setLaState: db.prepare('UPDATE live_activity_tokens SET misses = ?, last_push_at = ? WHERE token = ?'),
  startTokenForDevice: db.prepare(
    "SELECT token FROM live_activity_tokens WHERE kind = 'start' AND device_token = ? LIMIT 1"
  ),
  startTokensForUser: db.prepare(
    "SELECT token FROM live_activity_tokens WHERE kind = 'start' AND user_id = ? AND user_id <> ''"
  ),
  laTokenForFlight: db.prepare(
    "SELECT token FROM live_activity_tokens WHERE kind = 'update' AND device_token = ? AND flight_id = ? LIMIT 1"
  ),

  replaceWatchClear: db.prepare('DELETE FROM device_watch WHERE device_token = ?'),
  insertWatch: db.prepare(
    'INSERT OR REPLACE INTO device_watch (device_token, username, updated_at) VALUES (?, ?, ?)'
  ),
  watchesForDevice: db.prepare('SELECT username FROM device_watch WHERE device_token = ? ORDER BY username'),
  devicesWatching: db.prepare('SELECT device_token FROM device_watch WHERE username = ?'),
  allWatchedUsernames: db.prepare('SELECT DISTINCT username FROM device_watch'),
  pruneDeviceWatch: db.prepare('DELETE FROM device_watch WHERE device_token = ?'),

  upsertPrefs: db.prepare(`
    INSERT INTO device_prefs (device_token, events, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (device_token)
    DO UPDATE SET events = excluded.events, updated_at = excluded.updated_at
  `),
  prefsForDevice: db.prepare('SELECT events FROM device_prefs WHERE device_token = ?'),
  prunePrefs: db.prepare('DELETE FROM device_prefs WHERE device_token = ?'),

  apnsHostFor: db.prepare('SELECT host FROM apns_environment WHERE token = ?'),
  rememberApnsHost: db.prepare(`
    INSERT INTO apns_environment (token, host, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (token)
    DO UPDATE SET host = excluded.host, updated_at = excluded.updated_at
  `),
  forgetApnsHost: db.prepare('DELETE FROM apns_environment WHERE token = ?'),
  apnsEnvironmentCounts: db.prepare('SELECT host, COUNT(*) AS n FROM apns_environment GROUP BY host'),
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

// One session per host, because there are now two hosts. Keyed rather than
// held in a single variable: the sandbox connection is idle on almost every
// deployment, and tearing down the production one to reach it — which is what
// a single slot would do — would reconnect on every alternate push.
const apnsSessions = new Map(); // host -> ClientHttp2Session

function getApnsSession(host) {
  const existing = apnsSessions.get(host);
  if (existing && !existing.closed && !existing.destroyed) return existing;

  const session = http2.connect(host);
  session.on('error', (e) => {
    console.warn(`[push] APNs session error (${host}):`, e.message);
    if (apnsSessions.get(host) === session) apnsSessions.delete(host);
  });
  session.on('goaway', () => {
    try { session.close(); } catch (_) { /* already gone */ }
    if (apnsSessions.get(host) === session) apnsSessions.delete(host);
  });
  apnsSessions.set(host, session);
  return session;
}

function apnsRequest(deviceToken, headers, body, host = APNS_HOST) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = getApnsSession(host).request({
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

/** Which host this token is known to live on, or the configured default. */
function hostFor(token) {
  try {
    return stmts.apnsHostFor.get(token)?.host || APNS_HOST;
  } catch (_) {
    return APNS_HOST;
  }
}

function rememberHost(token, host) {
  try {
    if (host === APNS_HOST) stmts.forgetApnsHost.run(token);
    else stmts.rememberApnsHost.run(token, host, Date.now());
  } catch (e) {
    console.warn('[push] ⚠️ Could not record the APNs environment:', e.message);
  }
}

/** Everything a token owns, gone in one go. */
function pruneToken(token) {
  stmts.pruneDeviceToken.run(token);
  stmts.deleteLaToken.run(token);
  // A dead alert token also takes its device-scoped subscription with it —
  // that registry is keyed by exactly this token, so nothing else will ever
  // clean it up.
  stmts.pruneDeviceWatch.run(token);
  stmts.prunePrefs.run(token);
  stmts.forgetApnsHost.run(token);
}

// A token the wrong host will not recognise, and a token nobody will ever
// recognise, are the same four hundred and the same four words.
function isEnvironmentMismatch(status, body) {
  return status === 400 && body?.reason === 'BadDeviceToken';
}

/**
 * Send one push.
 *
 * Tries the environment this token is known to live on — the configured one
 * until something has said otherwise — and, on the one reply that means "wrong
 * environment", tries the other. Whichever is accepted is remembered, so the
 * second attempt happens once per token rather than once per push.
 *
 * A token is pruned only when it has been refused by both, or when APNs says
 * `410 Unregistered`, which is the app having been deleted and is not
 * ambiguous. Returns the HTTP status (0 on transport failure) so callers can
 * decide what to record.
 */
async function sendToToken(token, headers, payload) {
  const primary = hostFor(token);

  try {
    let { status, body } = await apnsRequest(token, headers, payload, primary);

    if (isEnvironmentMismatch(status, body) && envFallbackEnabled()) {
      const alternate = primary === APNS_HOST ? APNS_ALT_HOST : APNS_HOST;
      const retry = await apnsRequest(token, headers, payload, alternate);

      if (retry.status >= 200 && retry.status < 300) {
        rememberHost(token, alternate);
        console.log(`[push] ↪️ Token belongs to ${alternate} — remembered.`);
        return retry.status;
      }

      // Both refused it, so it really is dead. Report the second reply, which
      // is the one that settled it.
      ({ status, body } = retry);
    }

    if (status === 410 || isEnvironmentMismatch(status, body)) {
      pruneToken(token);
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
 * Device-scoped subscriptions
 * ========================= */

// Every event about SOMEBODY ELSE the client may ask for, and what it defaults
// to when the client says nothing. Takeoff is the headline feature, so it is
// on; offline is the noisiest and least interesting, so it is not.
const EVENT_KINDS = ['takeoff', 'landing', 'online', 'offline'];

/**
 * Every event about the pilot's OWN flight, by the preference key that governs
 * it, and the `kind` each notice carries on the wire.
 *
 * These used to have no switch at all. That was defensible while the only one
 * was "your sim link dropped" — a single notice nobody would want twice — and
 * stopped being defensible the moment there were four, one of which makes a
 * sound in the middle of a flight. The switch lives on the device rather than
 * on the account for the same reason the watchlist's does: it is a preference
 * about a phone's notification centre, and the phone is what has one.
 */
const OWN_FLIGHT_KINDS = {
  own_airborne: 'ownAirborne',
  own_descent: 'ownDescent',
  own_approach: 'ownApproach',
  own_landed: 'ownLanded',
  connect_dropped: 'connectDropped',
};

const OWN_FLIGHT_EVENT_KEYS = Object.values(OWN_FLIGHT_KINDS);

const DEFAULT_EVENTS = {
  takeoff: true,
  landing: true,
  online: true,
  offline: false,
  liveActivity: true,
  // All on by default: somebody who has told us which aeroplane is theirs has
  // already opted into hearing about it, and a feature that ships switched off
  // is a feature nobody discovers.
  ownAirborne: true,
  ownDescent: true,
  ownApproach: true,
  ownLanded: true,
  connectDropped: true,
};

// Every key the wire format carries, in one list, so a new event kind is added
// in exactly one place.
const PREFERENCE_KEYS = [...EVENT_KINDS, 'liveActivity', ...OWN_FLIGHT_EVENT_KEYS];

const MAX_WATCHED_PER_DEVICE = 200;

function normalizeEvents(raw) {
  const out = { ...DEFAULT_EVENTS };
  if (raw && typeof raw === 'object') {
    for (const key of PREFERENCE_KEYS) {
      if (typeof raw[key] === 'boolean') out[key] = raw[key];
    }
  }
  return out;
}

function deviceEvents(deviceToken) {
  try {
    const row = stmts.prefsForDevice.get(deviceToken);
    if (!row) return { ...DEFAULT_EVENTS };
    return normalizeEvents(JSON.parse(row.events));
  } catch (_) {
    // Unparseable stored prefs are treated as unset rather than as "nothing
    // wanted" — silence is the worse failure.
    return { ...DEFAULT_EVENTS };
  }
}

// Replaces this device's whole subscription in one transaction, so a client
// that re-sends its list never sees a moment with half of it registered.
const replaceSubscription = db.transaction((deviceToken, usernames, events) => {
  const now = Date.now();
  stmts.replaceWatchClear.run(deviceToken);
  for (const username of usernames) stmts.insertWatch.run(deviceToken, username, now);
  stmts.upsertPrefs.run(deviceToken, JSON.stringify(events), now);
});

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
    registerLiveActivityToken(req, res, req.userId);
  });

  /* ---- device-scoped (no account) ---- */

  // The native tracker has no sign-in, so these are authenticated by the APNs
  // token in the body: only the device iOS handed it to knows it, and it is
  // already the address we would be pushing to. Someone who guessed one could
  // change what that device is subscribed to — they could not read anything
  // back that they did not already send, and they cannot mint a token, so the
  // exposure is the same as the push endpoint itself.
  app.put('/api/push/subscriptions', (req, res) => {
    const deviceToken = normalizeHexToken(req.body?.deviceToken);
    if (!deviceToken) return res.status(400).json(apiError(400, 'Invalid or missing deviceToken'));

    const raw = Array.isArray(req.body?.usernames) ? req.body.usernames : [];
    const usernames = [
      ...new Set(
        raw
          .filter((u) => typeof u === 'string' && u.trim() && u.trim().length <= 64)
          .map((u) => u.trim().toLowerCase())
      ),
    ].slice(0, MAX_WATCHED_PER_DEVICE);

    const events = normalizeEvents(req.body?.events);

    try {
      replaceSubscription(deviceToken, usernames, events);
      res.json({ ok: true, watching: usernames.length, events });
    } catch (e) {
      res.status(500).json(apiError(500, `Failed to save subscription: ${e.message}`));
    }
  });

  // Lets a client that has lost its local state (reinstall, restore) discover
  // what the server still thinks it wants.
  app.get('/api/push/subscriptions/:deviceToken', (req, res) => {
    const deviceToken = normalizeHexToken(req.params.deviceToken);
    if (!deviceToken) return res.status(400).json(apiError(400, 'Invalid deviceToken'));
    try {
      res.json({
        ok: true,
        usernames: stmts.watchesForDevice.all(deviceToken).map((r) => r.username),
        events: deviceEvents(deviceToken),
      });
    } catch (e) {
      res.status(500).json(apiError(500, `Failed to read subscription: ${e.message}`));
    }
  });

  app.delete('/api/push/subscriptions/:deviceToken', (req, res) => {
    const deviceToken = normalizeHexToken(req.params.deviceToken);
    if (!deviceToken) return res.status(400).json(apiError(400, 'Invalid deviceToken'));
    try {
      stmts.pruneDeviceWatch.run(deviceToken);
      stmts.prunePrefs.run(deviceToken);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json(apiError(500, `Failed to clear subscription: ${e.message}`));
    }
  });

  // Same endpoint as the authed one above, but the Live Activity token is tied
  // to a device rather than an account — that is what lets the takeoff of a
  // watched pilot start a Live Activity on a device nobody has signed in on.
  app.post('/api/push/device-live-activity-tokens', (req, res) => {
    const deviceToken = normalizeHexToken(req.body?.deviceToken);
    if (!deviceToken) return res.status(400).json(apiError(400, 'Invalid or missing deviceToken'));
    registerLiveActivityToken(req, res, '', deviceToken);
  });
}

function registerLiveActivityToken(req, res, userId, deviceToken = null) {
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
    stmts.upsertLaToken.run(token, userId, kind, activityId, flightId, deviceToken, Date.now());
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json(apiError(500, `Failed to register live activity token: ${e.message}`));
  }
}

/* =========================
 * Watchlist alert pushes
 * ========================= */

// Server-side dedupe: max one push per (device, pilot, event) per 60s. Guards
// against a pilot who is skimming the ground/air threshold generating a burst,
// on top of the confirm-snapshots hysteresis the event engine already applies.
const recentPush = new Map(); // `${token}|${pilotLower}|${type}` -> ts
const PUSH_DEDUPE_MS = 60 * 1000;

function pruneRecentPush() {
  if (recentPush.size < 2000) return;
  const cutoff = Date.now() - PUSH_DEDUPE_MS;
  for (const [k, ts] of recentPush) {
    if (ts < cutoff) recentPush.delete(k);
  }
}

// How each event reads on the lock screen. `flight` is null for offline —
// the pilot is gone, so there is nothing to describe.
function alertFor(type, username, flight) {
  const dep = flight?.departureIcao || '????';
  const arr = flight?.arrivalIcao || '????';
  const aircraft = flight?.aircraft?.aircraftName || 'Unknown aircraft';

  switch (type) {
    case 'takeoff':
      return { title: username, subtitle: `Airborne out of ${dep}`, body: `${dep} → ${arr} · ${aircraft}` };
    case 'landing':
      return { title: username, subtitle: `Landed at ${arr}`, body: `${dep} → ${arr} · ${aircraft}` };
    case 'online':
      return { title: username, subtitle: 'Now online', body: `${dep} → ${arr} · ${aircraft}` };
    case 'offline':
      return { title: username, subtitle: 'Went offline', body: 'No longer on the server' };
    default:
      return null;
  }
}

/**
 * Every APNs alert token that should hear about this pilot, from both the
 * account-scoped watchlist and the device-scoped subscriptions, filtered by
 * what each side has asked for and de-duplicated by token.
 *
 * @returns {Promise<Array<{ token: string, liveActivity: boolean }>>}
 */
async function recipientsFor(username, type) {
  const lower = String(username).toLowerCase();
  const byToken = new Map();

  // Device-scoped: synchronous, local, and the path the native app uses.
  try {
    for (const row of stmts.devicesWatching.all(lower)) {
      const events = deviceEvents(row.device_token);
      if (!events[type]) continue;
      byToken.set(row.device_token, { token: row.device_token, liveActivity: !!events.liveActivity });
    }
  } catch (e) {
    console.warn('[push] ⚠️ Device watcher lookup failed:', e.message);
  }

  // Account-scoped: the existing Supabase watchlist. It has one notification
  // switch rather than per-event ones, so it opts into everything or nothing.
  if (supabase.hasServiceKey()) {
    try {
      for (const userId of await supabase.getWatcherUserIds(username)) {
        if (!(await supabase.isWatchlistNotificationEnabled(userId))) continue;
        for (const d of stmts.devicesForUser.all(userId)) {
          if (byToken.has(d.device_token)) continue;
          byToken.set(d.device_token, { token: d.device_token, liveActivity: true });
        }
      }
    } catch (e) {
      console.warn('[push] ⚠️ Watcher lookup failed:', e.message);
    }
  }

  return [...byToken.values()];
}

/**
 * Push one watchlist event to everyone who asked for it.
 *
 * @param {'takeoff'|'landing'|'online'|'offline'} type
 * @param {string} username
 * @param {object|null} flight  the live flight record, when there is one
 */
async function notifyWatchers(type, username, flight) {
  if (!configured()) return;

  const alert = alertFor(type, username, flight);
  if (!alert) return;

  const recipients = await recipientsFor(username, type);
  if (!recipients.length) return;

  const lower = String(username).toLowerCase();
  const payload = {
    aps: {
      alert,
      sound: 'default',
      'thread-id': 'inflight-watchlist',
      // Lets the app badge and route the tap without re-deriving any of this.
      'interruption-level': type === 'takeoff' ? 'time-sensitive' : 'active',
    },
    kind: `watchlist_${type}`,
    username: lower,
    flightId: flight?.flightId || null,
    departureIcao: flight?.departureIcao || null,
    arrivalIcao: flight?.arrivalIcao || null,
    aircraftName: flight?.aircraft?.aircraftName || null,
    liveryName: flight?.aircraft?.liveryName || null,
  };
  const headers = {
    'apns-topic': APNS_TOPIC,
    'apns-push-type': 'alert',
    'apns-priority': '10',
    // Matches the client's local dedupe identifier. Collapse ids are capped
    // at 64 bytes by APNs.
    'apns-collapse-id': `watchlist-${type}-${lower}`.slice(0, 64),
  };

  const now = Date.now();
  for (const recipient of recipients) {
    const dedupeKey = `${recipient.token}|${lower}|${type}`;
    if (now - (recentPush.get(dedupeKey) || 0) < PUSH_DEDUPE_MS) continue;
    recentPush.set(dedupeKey, now);
    await sendToToken(recipient.token, headers, payload);

    // A takeoff is the one event with a whole flight behind it, so it is the
    // one that earns a Live Activity. Failing to start it must not affect the
    // alert that already went out.
    if (type === 'takeoff' && recipient.liveActivity && flight) {
      await startLiveActivity(recipient.token, username, flight).catch((e) =>
        console.warn('[push] ⚠️ Live Activity start failed:', e.message)
      );
    }
  }
  pruneRecentPush();
}

// Kept for callers written against the original single-event API.
function notifyWatchersPilotOnline(username, flight) {
  return notifyWatchers('online', username, flight);
}

/**
 * A notification to a pilot about their OWN flight.
 *
 * Everything above this line is about somebody you are watching; this is the
 * other direction, and it needs a different address. Watchlist pushes are
 * routed by APNs token because the native app registers the usernames it cares
 * about against its own token — but "your sim link dropped" has to reach the
 * person flying, who is identified by the account their live status is keyed
 * on. `push_devices` is the only table that joins the two, which is why the app
 * now registers its token there once it is signed in.
 *
 * Silent when that registration has not happened. There is no fallback worth
 * having: guessing at a device from a username would mean notifying whoever
 * happened to be watching that pilot instead of the pilot.
 *
 * @param {string} userId  Supabase account id
 * @returns {Promise<number>} how many devices were reached
 */
async function notifyAccount(
  userId,
  { title, subtitle, body, kind, collapseId, data = {}, level = 'passive', sound = true }
) {
  if (!configured() || !userId) return 0;

  let devices = [];
  try {
    devices = stmts.devicesForUser.all(userId);
  } catch (e) {
    console.warn('[push] ⚠️ Device lookup failed:', e.message);
    return 0;
  }
  if (!devices.length) return 0;

  // Filtered per device rather than per account, because two phones signed into
  // one account are two notification centres with two sets of opinions. A kind
  // this table does not know is not filtered at all — an older client that has
  // never sent a preference for it still gets it, which is the failure mode
  // worth having.
  const preferenceKey = OWN_FLIGHT_KINDS[kind];
  if (preferenceKey) {
    devices = devices.filter((device) => deviceEvents(device.device_token)[preferenceKey] !== false);
    if (!devices.length) return 0;
  }

  const payload = {
    aps: {
      alert: { title, subtitle, body },
      // Both of these default to the quiet end and both are per-notice, because
      // the notices are not alike. "Your telemetry went quiet" is information
      // about something that has already happened and must not interrupt a
      // hand-flown approach — that is what this was written for and it stays
      // passive. "Top of descent" IS the approach: a pilot who asked to be told
      // about their own flight asked to be told at the moment there is
      // something to do, and a passive notice delivered silently after the fact
      // is the same as not being told.
      'interruption-level': level === 'active' ? 'active' : 'passive',
      ...(sound ? { sound: 'default' } : {}),
      'thread-id': 'inflight-own-flight',
    },
    kind,
    ...data,
  };
  const headers = {
    'apns-topic': APNS_TOPIC,
    'apns-push-type': 'alert',
    // 5 lets APNs hold a notice back to save power, which is right for one that
    // is only a record. A moment in a flight is worth nothing five minutes
    // late, so an active notice goes at 10.
    'apns-priority': level === 'active' ? '10' : '5',
    'apns-collapse-id': String(collapseId || kind).slice(0, 64),
  };

  let sent = 0;
  for (const device of devices) {
    const status = await sendToToken(device.device_token, headers, payload);
    if (status >= 200 && status < 300) sent += 1;
  }
  return sent;
}

/** Every pilot anyone is watching — the set the event engine tracks state for. */
function watchedUsernames() {
  const out = new Set();
  try {
    for (const row of stmts.allWatchedUsernames.all()) out.add(row.username);
  } catch (e) {
    console.warn('[push] ⚠️ Could not read watched usernames:', e.message);
  }
  return out;
}

/* =========================
 * Live Activity update pushes
 * ========================= */

// Swift's synthesized Codable decodes Date as seconds since 2001-01-01
// (Apple reference date), NOT unix seconds — see the spec's gotcha.
const APPLE_EPOCH_OFFSET = 978307200;
const LA_MIN_INTERVAL_MS = 45 * 1000; // spec cadence is ~50s; poller can be faster
const LA_END_AFTER_MISSES = 2;

const { airportCoords, haversineNm } = geo;

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

  // currentATD is omitted — the live API doesn't expose departure time. It is
  // `Date?` on the Swift side, so leaving it out decodes fine.
  //
  // `lastUpdated` is NOT optional over there, and Swift's synthesized decoder
  // does not fall back to a property's default when a key is missing — it
  // throws, and a Live Activity whose content state fails to decode simply
  // never updates. It has to be on the wire.
  return {
    distanceToDestinationNm: distanceNm !== null ? Math.round(distanceNm * 10) / 10 : 0,
    currentETA: etaSec - APPLE_EPOCH_OFFSET,
    isLanded,
    lastUpdated: nowSec - APPLE_EPOCH_OFFSET,
    altitudeFt: Math.round(typeof pos.alt_ft === 'number' ? pos.alt_ft : 0),
    groundSpeedKt: Math.round(gs),
  };
}

/**
 * Attributes for an activity the server is starting itself.
 *
 * These are fixed for the life of the activity, so everything here is either
 * route geometry or aircraft identity — nothing that moves.
 */
function liveActivityAttributes(username, flight) {
  const pos = flight?.position || {};
  const origin = airportCoords(flight?.departureIcao);
  const dest = airportCoords(flight?.arrivalIcao);
  const nowSec = Math.floor(Date.now() / 1000);

  let totalNm = 0;
  if (origin && dest) {
    totalNm = haversineNm(origin.lat, origin.lon, dest.lat, dest.lon);
  } else if (dest && typeof pos.lat === 'number' && typeof pos.lon === 'number') {
    // No origin on file: the distance still to run is the best total we have.
    totalNm = haversineNm(pos.lat, pos.lon, dest.lat, dest.lon);
  }

  const gs = typeof pos.gs_kt === 'number' && pos.gs_kt > 50 ? pos.gs_kt : 450;
  const enrouteSec = totalNm > 0 ? Math.round((totalNm / gs) * 3600) : 0;

  return {
    callsign: flight?.callsign || username,
    airlineName: flight?.aircraft?.liveryName || '',
    aircraftType: flight?.aircraft?.aircraftName || '',
    liveryName: flight?.aircraft?.liveryName || '',
    registration: flight?.aircraft?.registration || '',
    departureIcao: (flight?.departureIcao || '').toUpperCase(),
    arrivalIcao: (flight?.arrivalIcao || '').toUpperCase(),
    // The activity starts at the moment of takeoff, so that is the departure
    // it should show — the live API has no filed schedule to offer instead.
    scheduledDeparture: nowSec - APPLE_EPOCH_OFFSET,
    scheduledArrival: nowSec + enrouteSec - APPLE_EPOCH_OFFSET,
    totalDistanceNm: Math.round(totalNm * 10) / 10,
    pilotUsername: username,
    // The app never saw this activity start, so this is the only thing tying
    // the banner back to an aircraft it can look up.
    flightId: flight?.flightId || '',
  };
}

/**
 * Start a Live Activity on one device for a flight that has just left the
 * ground — the "live banner" a watcher gets without touching their phone.
 *
 * Needs a push-to-start token, which iOS only issues for an app that has
 * declared `NSSupportsLiveActivitiesFrequentUpdates` and asked for one; a
 * device that hasn't is silently skipped.
 */
async function startLiveActivity(deviceToken, username, flight) {
  if (!flight?.flightId) return;

  let startToken;
  try {
    startToken = stmts.startTokenForDevice.get(deviceToken)?.token;
  } catch (e) {
    console.warn('[push] ⚠️ Start-token lookup failed:', e.message);
    return;
  }
  if (!startToken) return;

  // Already running one for this flight on this device — a re-issued takeoff
  // must not stack a second banner on top of the first.
  try {
    if (stmts.laTokenForFlight.get(deviceToken, flight.flightId)) return;
  } catch (_) { /* fall through and start it */ }

  const nowSec = Math.floor(Date.now() / 1000);
  const attributes = liveActivityAttributes(username, flight);

  await sendToToken(startToken, laHeaders(), {
    aps: {
      timestamp: nowSec,
      event: 'start',
      'attributes-type': 'InflightActivityAttributes',
      attributes,
      'content-state': liveActivityContentState(flight),
      // Shown if the activity starts while the screen is locked.
      alert: {
        title: `${username} is airborne`,
        body: `${attributes.departureIcao || '????'} → ${attributes.arrivalIcao || '????'}`,
        sound: 'default',
      },
      // Activities are ended by the update loop when the flight lands; this is
      // the backstop for one whose flight vanishes without ever landing.
      'dismissal-date': nowSec + 12 * 3600,
    },
    flightId: flight.flightId,
    username: String(username).toLowerCase(),
  });
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

/** Diagnostics: what the registries hold, and which environments they live in. */
function stats() {
  const out = {
    configured: configured(),
    host: APNS_HOST,
    environmentFallback: envFallbackEnabled(),
    devices: 0,
    watchRows: 0,
    liveActivityTokens: 0,
    // Tokens the configured host refused and the other one accepted. A number
    // climbing here on a production deployment means builds are shipping with
    // `aps-environment: development` — worth knowing, and invisible before.
    onAlternateEnvironment: 0,
  };
  try {
    out.devices = db.prepare('SELECT COUNT(*) AS n FROM push_devices').get().n;
    out.watchRows = db.prepare('SELECT COUNT(*) AS n FROM device_watch').get().n;
    out.liveActivityTokens = db.prepare('SELECT COUNT(*) AS n FROM live_activity_tokens').get().n;
    for (const row of stmts.apnsEnvironmentCounts.all()) {
      if (row.host !== APNS_HOST) out.onAlternateEnvironment += row.n;
    }
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

module.exports = {
  configured,
  registerRoutes,
  notifyWatchers,
  notifyWatchersPilotOnline,
  watchedUsernames,
  pushLiveActivityUpdates,
  notifyAccount,
  deviceEvents,
  stats,
  EVENT_KINDS,
  OWN_FLIGHT_KINDS,
  OWN_FLIGHT_EVENT_KEYS,
  PREFERENCE_KEYS,
  DEFAULT_EVENTS,
};
