const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// --- CONFIGURATION ---
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'flight_history.db');

// Tunables — change these in one place if you ever need to.
const MAX_FLIGHTS_PER_USER = 5;     // was effectively 2
const MAX_POINTS_PER_FLIGHT = 1500; // was 3000 — halved, since per-point cost dropped ~45%
const MAX_SESSIONS_PER_FLIGHT = 3;
const SESSION_GAP_MS = 30 * 60 * 1000;
const CRUISE_THROTTLE_MS = 120000;
const CRUISE_ALT_FT = 20000;

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
  console.warn('[history] Falling back to in-memory database (Data will not persist!)');
  db = new Database(':memory:');
}

// 2. High-Performance & Memory Safety Configuration
db.pragma('journal_mode = WAL');
db.pragma('synchronous = OFF');
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

/* =========================
 * Compact point format
 * On-disk: [lat, lon, alt, gs, time]  (~40 bytes/point)
 * In-memory: { lat, lon, alt, gs, time }
 * Convert only at the read/write boundary.
 * ========================= */
const I_LAT = 0, I_LON = 1, I_ALT = 2, I_GS = 3, I_TIME = 4, I_HDG = 5;

function packPoint(p) {
  return [
    Math.round(p.lat * 10000) / 10000, // ~11m precision — plenty for tracking
    Math.round(p.lon * 10000) / 10000,
    Math.round(p.alt),
    Math.round(p.gs),
    p.time,
    Math.round(p.hdg || 0)
  ];
}

function unpackPoint(a) {
  return { 
    lat: a[I_LAT], 
    lon: a[I_LON], 
    alt: a[I_ALT], 
    gs: a[I_GS], 
    time: a[I_TIME],
    hdg: a[I_HDG] || 0
  };
}


/**
 * Reads a path_json string and returns it as an array of {lat,lon,alt,gs,time}.
 * Transparently handles both the new compact format (array of arrays) and
 * the legacy object format that may still be on disk pre-migration.
 */
function readPath(json) {
  if (!json) return [];
  let parsed;
  try { parsed = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(parsed) || parsed.length === 0) return [];
  // Compact format: first element is an array
  if (Array.isArray(parsed[0])) return parsed.map(unpackPoint);
  // Legacy object format
  return parsed;
}

function writePath(pointsArr) {
  return JSON.stringify(pointsArr.map(packPoint));
}

/**
 * Clean up data older than 24 hours
 */
function purgeOldData() {
  const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
  db.prepare('DELETE FROM flight_history WHERE lastSeen < ?').run(oneDayAgo);
}

/**
 * Enforces the "Max N Flights per User" rule.
 * Deletes as many oldest flights as needed so that adding ONE new flight
 * keeps the user at or under MAX_FLIGHTS_PER_USER.
 */
function enforceUserLimit(userId) {
  const userFlights = db.prepare(
    'SELECT flightId FROM flight_history WHERE userId = ? ORDER BY lastSeen ASC'
  ).all(userId);

  const excess = userFlights.length - (MAX_FLIGHTS_PER_USER - 1);
  if (excess > 0) {
    const delStmt = db.prepare('DELETE FROM flight_history WHERE flightId = ?');
    for (let i = 0; i < excess; i++) {
      delStmt.run(userFlights[i].flightId);
    }
  }
}

/**
 * Logic to determine if we should skip recording a point to the array
 */
function shouldSkipPoint(flight, lastPoint, now) {
  if (!lastPoint) return false;

  // 1. Stationary Bloat Prevention
  if (flight.position.gs_kt < 2 && lastPoint.gs < 2) {
    return true;
  }

  // 2. Cruising Altitude Throttling
  const isCruising = flight.position.alt_ft >= CRUISE_ALT_FT;
  const timeSinceLast = now - lastPoint.time;
  if (isCruising && timeSinceLast < CRUISE_THROTTLE_MS) {
    return true;
  }

  return false;
}

/**
 * Calculates distance between two coordinates in Nautical Miles
 */
function getDistanceNM(lat1, lon1, lat2, lon2) {
  const R = 3440.065;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Keeps only the last N flight sessions within the path array.
 */
function trimFlightSessions(pathArray, maxSessions = MAX_SESSIONS_PER_FLIGHT, sessionGapMs = SESSION_GAP_MS) {
  if (pathArray.length < 2) return pathArray;

  const sessionBoundaries = [];

  for (let i = 1; i < pathArray.length; i++) {
    const p1 = pathArray[i - 1];
    const p2 = pathArray[i];

    const isTimeGap = (p2.time - p1.time) > sessionGapMs;
    const isTeleport = getDistanceNM(p1.lat, p1.lon, p2.lat, p2.lon) > 50;

    if (isTimeGap || isTeleport) {
      sessionBoundaries.push(i);
    }
  }

  if (sessionBoundaries.length >= maxSessions) {
    const sessionsToRemove = sessionBoundaries.length - maxSessions + 1;
    const sliceIndex = sessionBoundaries[sessionsToRemove - 1];
    pathArray = pathArray.slice(sliceIndex);
  }

  if (pathArray.length > MAX_POINTS_PER_FLIGHT) {
    return pathArray.slice(-MAX_POINTS_PER_FLIGHT);
  }

  return pathArray;
}

/**
 * Retroactive Database Cleaner
 * Sweeps the entire DB to enforce limits, compress existing bloated arrays,
 * and migrate legacy object-format paths to the new compact array format.
 */
function runDeepClean() {
  console.log('[history] 🧹 Starting deep clean of existing database...');

  // Phase 1: Enforce global user limits
  const users = db.prepare('SELECT DISTINCT userId FROM flight_history').all();
  let deletedFlights = 0;

  for (const u of users) {
    const userFlights = db.prepare(
      'SELECT flightId FROM flight_history WHERE userId = ? ORDER BY lastSeen ASC'
    ).all(u.userId);
    if (userFlights.length > MAX_FLIGHTS_PER_USER) {
      const flightsToDelete = userFlights.slice(0, userFlights.length - MAX_FLIGHTS_PER_USER);
      for (const f of flightsToDelete) {
        db.prepare('DELETE FROM flight_history WHERE flightId = ?').run(f.flightId);
        deletedFlights++;
      }
    }
  }

  // Phase 2: Compress historical flight paths + migrate format
  const allFlights = db.prepare('SELECT flightId, path_json FROM flight_history').all();
  let updatedPaths = 0;
  let migratedPaths = 0;
  const updateStmt = db.prepare('UPDATE flight_history SET path_json = ? WHERE flightId = ?');

  const cleanBatch = db.transaction((flights) => {
    for (const flight of flights) {
      if (!flight.path_json) continue;

      let raw;
      try { raw = JSON.parse(flight.path_json); } catch { continue; }
      if (!Array.isArray(raw) || raw.length === 0) continue;

      const wasLegacy = !Array.isArray(raw[0]); // object-format detection
      const pathArray = wasLegacy ? raw : raw.map(unpackPoint);

      if (pathArray.length < 2) {
        // Still migrate single-point legacy entries
        if (wasLegacy) {
          updateStmt.run(writePath(pathArray), flight.flightId);
          migratedPaths++;
        }
        continue;
      }

      // Strip old stationary / over-sampled cruise bloat
      let cleanedPath = [pathArray[0]];
      for (let i = 1; i < pathArray.length; i++) {
        const p1 = cleanedPath[cleanedPath.length - 1];
        const p2 = pathArray[i];

        if (p2.gs < 2 && p1.gs < 2) continue;
        if (p2.alt >= CRUISE_ALT_FT && (p2.time - p1.time) < CRUISE_THROTTLE_MS) continue;

        cleanedPath.push(p2);
      }

      cleanedPath = trimFlightSessions(cleanedPath);

      // Write back if we compressed OR if we still need to migrate the format
      if (cleanedPath.length < pathArray.length || wasLegacy) {
        updateStmt.run(writePath(cleanedPath), flight.flightId);
        if (cleanedPath.length < pathArray.length) updatedPaths++;
        if (wasLegacy) migratedPaths++;
      }
    }
  });

  cleanBatch(allFlights);
  console.log(
    `[history] ✨ Deep clean complete! Deleted ${deletedFlights} old flights, ` +
    `compressed ${updatedPaths} paths, migrated ${migratedPaths} legacy paths to compact format.`
  );
}

/**
 * Optimized Batch Update
 */
function updateBatch(flights) {
  const now = Date.now();

  purgeOldData();

  const upsertStmt = db.prepare(`
    INSERT INTO flight_history (userId, flightId, callsign, lastSeen, path_json)
    VALUES (@userId, @flightId, @callsign, @lastSeen, @path_json)
    ON CONFLICT(flightId) DO UPDATE SET
      lastSeen = excluded.lastSeen,
      path_json = excluded.path_json
  `);

  const selectPathStmt = db.prepare('SELECT path_json FROM flight_history WHERE flightId = ?');
  const touchLastSeenStmt = db.prepare('UPDATE flight_history SET lastSeen = ? WHERE flightId = ?');

  const runBatch = db.transaction((flightList) => {
    for (const flight of flightList) {
      const existing = selectPathStmt.get(flight.flightId);
      let flightPath = [];

      if (existing?.path_json) {
        flightPath = readPath(existing.path_json);
      } else {
        // New flightId for this user — make room first
        enforceUserLimit(flight.userId);
      }

      const lastPoint = flightPath[flightPath.length - 1];

      if (shouldSkipPoint(flight, lastPoint, now)) {
        touchLastSeenStmt.run(now, flight.flightId);
        continue;
      }

      flightPath.push({
        lat: flight.position.lat,
        lon: flight.position.lon,
        alt: flight.position.alt_ft,
        gs: flight.position.gs_kt,
        time: now,
        hdg: flight.position.heading_deg
      });

      flightPath = trimFlightSessions(flightPath);

      upsertStmt.run({
        userId: flight.userId,
        flightId: flight.flightId,
        callsign: flight.callsign,
        lastSeen: now,
        path_json: writePath(flightPath)
      });
    }
  });

  runBatch(flights);
}

async function getFlightPath(flightId) {
  const row = db.prepare('SELECT path_json FROM flight_history WHERE flightId = ?').get(flightId);
  return row ? readPath(row.path_json) : [];
}

// Run the deep clean 5 seconds after startup so it doesn't block the initial boot process
setTimeout(runDeepClean, 5000);

module.exports = { updateBatch, getFlightPath, runDeepClean };
