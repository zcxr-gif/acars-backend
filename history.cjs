const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs'); // Added fs to create directories if needed

// --- CONFIGURATION ---
// On Northflank, we will set this ENV var to '/data'
// If not set, it defaults to a local 'data' folder for testing
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'flight_history.db');

// Ensure the directory exists (Critical for Volumes!)
if (!fs.existsSync(DATA_DIR)) {
  console.log(`[history] Creating data directory: ${DATA_DIR}`);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    console.error(`[history] ❌ Failed to create data directory at ${DATA_DIR}. Check permissions!`, e);
  }
}

console.log(`[history] Database path: ${DB_PATH}`);

// 1. Initialize the DB
let db;
try {
  db = new Database(DB_PATH);
} catch (e) {
  console.error('[history] ❌ CRITICAL DATABASE ERROR:', e.message);
  // Fallback to in-memory if disk fails, just to keep app alive (optional)
  console.warn('[history] Falling back to in-memory database (Data will not persist!)');
  db = new Database(':memory:');
}

// 2. High-Performance & Memory Safety Configuration
// WAL mode allows simultaneous reading/writing
db.pragma('journal_mode = WAL'); 
db.pragma('synchronous = OFF');

// [CRITICAL FOR 700MB LIMIT]
// Limit SQLite cache to ~50MB.
// Negative number = kilobytes. -50000 = 50,000KB = ~50MB.
db.pragma('cache_size = -50000'); 

// 3. Create Tables
db.prepare(`
  CREATE TABLE IF NOT EXISTS flight_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId TEXT,
    flightId TEXT UNIQUE,
    callsign TEXT,
    lastSeen INTEGER,
    path_json TEXT
  )
`).run();

db.prepare(`CREATE INDEX IF NOT EXISTS idx_user_time ON flight_history (userId, lastSeen)`).run();

/**
 * Clean up data older than 24 hours 
 */
function purgeOldData() {
  const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
  db.prepare('DELETE FROM flight_history WHERE lastSeen < ?').run(oneDayAgo);
}

/**
 * Enforces the "Max 2 Flights per User" rule 
 */
function enforceUserLimit(userId) {
  const userFlights = db.prepare('SELECT flightId FROM flight_history WHERE userId = ? ORDER BY lastSeen ASC').all(userId);
  if (userFlights.length >= 2) {
    // Delete the oldest flight to make room for the new one
    db.prepare('DELETE FROM flight_history WHERE flightId = ?').run(userFlights[0].flightId);
  }
}

/**
 * Logic to determine if we should skip recording a point based on cruising altitude 
 */
function shouldSkipPoint(flight, lastPoint, now) {
  if (!lastPoint) return false;
  const isCruising = flight.position.alt_ft >= 20000;
  const timeSinceLast = now - lastPoint.time;
  // If cruising, only save every 2 minutes (120,000 ms)
  if (isCruising && timeSinceLast < 120000) {
    return true;
  }
  return false;
}

/**
 * Optimized Batch Update
 */
function updateBatch(flights) {
  const now = Date.now();
  // 1. Immediate Cleanup 
  purgeOldData();

  const upsertStmt = db.prepare(`
    INSERT INTO flight_history (userId, flightId, callsign, lastSeen, path_json)
    VALUES (@userId, @flightId, @callsign, @lastSeen, @path_json)
    ON CONFLICT(flightId) DO UPDATE SET
      lastSeen = excluded.lastSeen,
      path_json = excluded.path_json
  `);

  // 2. Wrap everything in a transaction for speed and consistency 
  const runBatch = db.transaction((flightList) => {
    for (const flight of flightList) {
      const existing = db.prepare('SELECT path_json FROM flight_history WHERE flightId = ?').get(flight.flightId);
      let flightPath = [];
      
      if (existing?.path_json) {
        try { 
            flightPath = JSON.parse(existing.path_json); 
        } 
        catch (e) { 
            flightPath = []; 
        }
      } else {
        // This is a NEW flight, enforce the 2-flight limit for the user
        enforceUserLimit(flight.userId);
      }

      // 3. Cruising Throttling Logic 
      const lastPoint = flightPath[flightPath.length - 1];
      if (shouldSkipPoint(flight, lastPoint, now)) {
        continue; // Skip this update for this flight to save space
      }

      flightPath.push({
        lat: flight.position.lat,
        lon: flight.position.lon,
        alt: flight.position.alt_ft,
        gs: flight.position.gs_kt,
        time: now
      });

      upsertStmt.run({
        userId: flight.userId,
        flightId: flight.flightId,
        callsign: flight.callsign,
        lastSeen: now,
        path_json: JSON.stringify(flightPath)
      });
    }
  });

  runBatch(flights);
}

async function getFlightPath(flightId) {
  const row = db.prepare('SELECT path_json FROM flight_history WHERE flightId = ?').get(flightId);
  return row ? JSON.parse(row.path_json) : [];
}

module.exports = { updateBatch, getFlightPath };