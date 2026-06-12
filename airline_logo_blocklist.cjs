/* =========================
 * Airline logo takedown blocklist
 * =========================
 * Takedown blocklist for airline logos in the Inflight app. Add a 3-letter
 * ICAO airline code (e.g. AAL, DLH, SIA) to immediately suppress that
 * airline's logo on all installs — the app refetches the list once per
 * session, so no App Store update is needed.
 *
 * Codes are managed from the dashboard's "Logo Blocklist" tab (or the
 * /api/admin/airline-logo-blocklist endpoints) and persist in SQLite so
 * they survive restarts.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'airline_logo_blocklist.db');

if (!fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    console.error(`[logo-blocklist] ❌ Failed to create data directory at ${DATA_DIR}:`, e.message);
  }
}

let db;
try {
  db = new Database(DB_PATH);
} catch (e) {
  console.error('[logo-blocklist] ❌ Could not open DB, falling back to in-memory:', e.message);
  console.warn('[logo-blocklist] Blocklist entries will NOT persist across restarts!');
  db = new Database(':memory:');
}

db.pragma('journal_mode = WAL');

db.prepare(`
  CREATE TABLE IF NOT EXISTS blocked_airline_logos (
    code TEXT PRIMARY KEY,
    addedAt INTEGER NOT NULL
  )
`).run();

const stmts = {
  all: db.prepare('SELECT code, addedAt FROM blocked_airline_logos ORDER BY code'),
  insert: db.prepare('INSERT OR IGNORE INTO blocked_airline_logos (code, addedAt) VALUES (?, ?)'),
  remove: db.prepare('DELETE FROM blocked_airline_logos WHERE code = ?'),
};

// ICAO airline designators are exactly 3 uppercase letters.
function normalize(code) {
  const c = String(code || '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : null;
}

// Plain array of codes, e.g. ["AAL", "DLH"] — what the public endpoint serves.
function codes() {
  return stmts.all.all().map((row) => row.code);
}

// Full rows ({ code, addedAt }) for the dashboard tab.
function entries() {
  return stmts.all.all();
}

// Returns the normalized code, or null if the input isn't a valid ICAO code.
function add(code) {
  const c = normalize(code);
  if (!c) return null;
  stmts.insert.run(c, Date.now());
  return c;
}

// Returns true if a row was actually deleted.
function remove(code) {
  const c = normalize(code);
  if (!c) return false;
  return stmts.remove.run(c).changes > 0;
}

module.exports = { codes, entries, add, remove, normalize };
