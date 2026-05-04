/**
 * Opt-in user registry for badge + presence features.
 *
 * Stores a tiny list of IF usernames who have explicitly opted in to having
 * their live flight data exposed via /badge/:username.svg and /api/presence/:username.
 *
 * This is a separate SQLite DB from flight_history.db so that the existing
 * volume layout / pragmas / WAL files for history are untouched.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'registry.db');

if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); }
  catch (e) { console.error(`[registry] Failed to create data dir`, e); }
}

let db;
try {
  db = new Database(DB_PATH);
} catch (e) {
  console.error('[registry] DB error, falling back to memory:', e.message);
  db = new Database(':memory:');
}

// Lightweight pragmas — this DB is tiny and rarely written
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.prepare(`
  CREATE TABLE IF NOT EXISTS opted_in_users (
    username_lower TEXT PRIMARY KEY,
    username_original TEXT NOT NULL,
    registered_at INTEGER NOT NULL,
    last_seen_active INTEGER
  )
`).run();

// In-memory mirror — checked on every badge/presence request, so we don't want
// to hit SQLite on the hot path. Refreshed on register/unregister.
let optedInSet = new Set();

function refreshCache() {
  const rows = db.prepare('SELECT username_lower FROM opted_in_users').all();
  optedInSet = new Set(rows.map(r => r.username_lower));
  console.log(`[registry] Loaded ${optedInSet.size} opted-in users into cache.`);
}

// Initial load
refreshCache();

/**
 * Synchronous opt-in check. Hot-path safe (in-memory Set lookup).
 */
function isOptedIn(username) {
  if (!username || typeof username !== 'string') return false;
  return optedInSet.has(username.toLowerCase());
}

/**
 * Register a user. Returns { ok, alreadyRegistered }.
 */
function registerUser(username) {
  if (!username || typeof username !== 'string') {
    return { ok: false, error: 'Invalid username' };
  }
  const trimmed = username.trim();
  if (trimmed.length < 2 || trimmed.length > 64) {
    return { ok: false, error: 'Username must be 2-64 characters' };
  }
  // Basic charset check — IF usernames are alphanumeric + a few specials
  if (!/^[A-Za-z0-9_\-. ]+$/.test(trimmed)) {
    return { ok: false, error: 'Invalid characters in username' };
  }

  const lower = trimmed.toLowerCase();
  const existing = db.prepare('SELECT username_lower FROM opted_in_users WHERE username_lower = ?').get(lower);
  if (existing) {
    return { ok: true, alreadyRegistered: true };
  }

  db.prepare(`
    INSERT INTO opted_in_users (username_lower, username_original, registered_at)
    VALUES (?, ?, ?)
  `).run(lower, trimmed, Date.now());

  optedInSet.add(lower);
  return { ok: true, alreadyRegistered: false };
}

/**
 * Unregister. Returns { ok, wasRegistered }.
 */
function unregisterUser(username) {
  if (!username || typeof username !== 'string') {
    return { ok: false, error: 'Invalid username' };
  }
  const lower = username.trim().toLowerCase();
  const result = db.prepare('DELETE FROM opted_in_users WHERE username_lower = ?').run(lower);

  if (result.changes > 0) {
    optedInSet.delete(lower);
    return { ok: true, wasRegistered: true };
  }
  return { ok: true, wasRegistered: false };
}

/**
 * Bump last_seen_active when an opted-in user is observed flying.
 * Used to prune dormant accounts later if needed. Called from the poller,
 * so it must be cheap — we batch-update via a transaction.
 */
const bumpStmt = db.prepare('UPDATE opted_in_users SET last_seen_active = ? WHERE username_lower = ?');
const bumpTxn = db.transaction((usernames, ts) => {
  for (const u of usernames) bumpStmt.run(ts, u);
});

function bumpActivity(usernamesLower) {
  if (!usernamesLower || usernamesLower.length === 0) return;
  try {
    bumpTxn(usernamesLower, Date.now());
  } catch (e) {
    // Non-critical, swallow
  }
}

function getStats() {
  const total = db.prepare('SELECT COUNT(*) AS c FROM opted_in_users').get().c;
  const activeRecently = db.prepare(
    'SELECT COUNT(*) AS c FROM opted_in_users WHERE last_seen_active > ?'
  ).get(Date.now() - 7 * 24 * 60 * 60 * 1000).c;
  return { total, activeLast7Days: activeRecently };
}

module.exports = {
  isOptedIn,
  registerUser,
  unregisterUser,
  bumpActivity,
  getStats,
  refreshCache,
};
