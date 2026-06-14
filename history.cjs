const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// --- CONFIGURATION ---
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'flight_history.db');

// Tunables — change these in one place if you ever need to.
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
    path_json TEXT,
    aircraftId TEXT,
    liveryId TEXT,
    aircraftName TEXT,
    liveryName TEXT
  )
`).run();
db.prepare(`CREATE INDEX IF NOT EXISTS idx_user_time ON flight_history (userId, lastSeen)`).run();
// Supports the ATC-replay candidate query, which filters purely on lastSeen.
db.prepare(`CREATE INDEX IF NOT EXISTS idx_last_seen ON flight_history (lastSeen)`).run();

// Migration: add the aircraft/livery columns to databases created before they
// existed. CREATE TABLE IF NOT EXISTS won't touch an existing table, so we add
// each missing column explicitly. Plane type + livery are constant for the life
// of a flight, so they live as plain columns rather than inside the path.
(() => {
  const existing = new Set(
    db.prepare(`PRAGMA table_info(flight_history)`).all().map(c => c.name)
  );
  for (const col of ['aircraftId', 'liveryId', 'aircraftName', 'liveryName']) {
    if (!existing.has(col)) {
      db.prepare(`ALTER TABLE flight_history ADD COLUMN ${col} TEXT`).run();
      console.log(`[history] Migrated flight_history: added column ${col}`);
    }
  }
})();

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
 * Wipe flights not updated in the last 48 hours.
 */
function purgeOldData() {
  const twoDaysAgo = Date.now() - (48 * 60 * 60 * 1000);
  db.prepare('DELETE FROM flight_history WHERE lastSeen < ?').run(twoDaysAgo);
}

/**
 * Logic to determine if we should skip recording a point to the array.
 * `pointTime` is the timestamp we intend to stamp the new point with — the
 * aircraft's actual position-report time, NOT the server poll time.
 */
function shouldSkipPoint(flight, lastPoint, pointTime) {
  if (!lastPoint) return false;

  // 0. Stale / duplicate report guard.
  // The point time is the aircraft's real report time. If it hasn't advanced
  // past the last recorded point, the API just handed us the same (or an older)
  // report again — recording it would push the trail's tip ahead of, or out of
  // order with, the live position the socket is broadcasting.
  if (pointTime <= lastPoint.time) {
    return true;
  }

  // 1. Stationary Bloat Prevention
  if (flight.position.gs_kt < 2 && lastPoint.gs < 2) {
    return true;
  }

  // 2. Cruising Altitude Throttling
  const isCruising = flight.position.alt_ft >= CRUISE_ALT_FT;
  const timeSinceLast = pointTime - lastPoint.time;
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
 * Sweeps the entire DB to compress existing bloated arrays and migrate
 * legacy object-format paths to the new compact array format.
 */
function runDeepClean() {
  console.log('[history] 🧹 Starting deep clean of existing database...');

  // Compress historical flight paths + migrate format
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
    `[history] ✨ Deep clean complete! Compressed ${updatedPaths} paths, migrated ${migratedPaths} legacy paths to compact format.`
  );
}

/**
 * Optimized Batch Update
 */
function updateBatch(flights) {
  const now = Date.now();

  purgeOldData();

  const upsertStmt = db.prepare(`
    INSERT INTO flight_history (userId, flightId, callsign, lastSeen, path_json, aircraftId, liveryId, aircraftName, liveryName)
    VALUES (@userId, @flightId, @callsign, @lastSeen, @path_json, @aircraftId, @liveryId, @aircraftName, @liveryName)
    ON CONFLICT(flightId) DO UPDATE SET
      lastSeen = excluded.lastSeen,
      path_json = excluded.path_json,
      aircraftId = excluded.aircraftId,
      liveryId = excluded.liveryId,
      aircraftName = excluded.aircraftName,
      liveryName = excluded.liveryName
  `);

  const selectPathStmt = db.prepare('SELECT path_json FROM flight_history WHERE flightId = ?');
  const touchLastSeenStmt = db.prepare('UPDATE flight_history SET lastSeen = ? WHERE flightId = ?');

  const runBatch = db.transaction((flightList) => {
    for (const flight of flightList) {
      const existing = selectPathStmt.get(flight.flightId);
      let flightPath = [];

      if (existing?.path_json) {
        flightPath = readPath(existing.path_json);
      }

      const lastPoint = flightPath[flightPath.length - 1];

      // Stamp the point with the aircraft's actual report time, not the server
      // poll time. This is the same value the live socket broadcasts
      // (position.lastReportMs), so the recorded trail stays in the same time
      // domain as the live marker and its tip can't drift ahead of the plane.
      // Fall back to `now` only if the report time is missing/invalid.
      const reportMs = flight.position.lastReportMs;
      const pointTime = (typeof reportMs === 'number' && reportMs > 0) ? reportMs : now;

      if (shouldSkipPoint(flight, lastPoint, pointTime)) {
        touchLastSeenStmt.run(now, flight.flightId);
        continue;
      }

      flightPath.push({
        lat: flight.position.lat,
        lon: flight.position.lon,
        alt: flight.position.alt_ft,
        gs: flight.position.gs_kt,
        time: pointTime,
        hdg: flight.position.heading_deg
      });

      flightPath = trimFlightSessions(flightPath);

      const ac = flight.aircraft || {};
      upsertStmt.run({
        userId: flight.userId,
        flightId: flight.flightId,
        callsign: flight.callsign,
        lastSeen: now,
        path_json: writePath(flightPath),
        aircraftId: ac.aircraftId || null,
        liveryId: ac.liveryId || null,
        aircraftName: ac.aircraftName || null,
        liveryName: ac.liveryName || null
      });
    }
  });

  runBatch(flights);
}

/**
 * Returns the recorded trail for a flight, time-sorted ascending.
 *
 * Pass `untilMs` to clamp the trail to a socket frame the caller already holds:
 * only points with time <= untilMs are returned. The recorded `time` is the
 * aircraft's lastReportMs (see updateBatch), the same value the live socket
 * broadcasts, so clamping to the marker's lastReportMs guarantees the trail's
 * tip can never lead the live position the client is currently drawing.
 */
async function getFlightPath(flightId, untilMs) {
  const row = db.prepare('SELECT path_json FROM flight_history WHERE flightId = ?').get(flightId);
  if (!row) return [];
  const path = readPath(row.path_json);
  if (typeof untilMs === 'number' && Number.isFinite(untilMs)) {
    return path.filter(p => p.time <= untilMs);
  }
  return path;
}

/**
 * Returns every recorded flight whose trail was still being updated at or after
 * `sinceMs`, with its path already unpacked. This is the candidate set the ATC
 * replay layer scans to find the flights that were inside a controller's
 * airspace during a session window. Filtering on lastSeen alone is cheap thanks
 * to idx_last_seen; the spatial/temporal narrowing happens in atc_history.cjs.
 */
function getFlightsForReplay(sinceMs) {
  const rows = db
    .prepare('SELECT userId, flightId, callsign, path_json, aircraftId, liveryId, aircraftName, liveryName FROM flight_history WHERE lastSeen >= ?')
    .all(sinceMs);
  return rows.map(r => ({
    userId: r.userId,
    flightId: r.flightId,
    callsign: r.callsign,
    aircraft: {
      aircraftId: r.aircraftId || null,
      liveryId: r.liveryId || null,
      aircraftName: r.aircraftName || null,
      liveryName: r.liveryName || null
    },
    path: readPath(r.path_json)
  }));
}

// Startup: deep clean after 5s so it doesn't block boot
setTimeout(runDeepClean, 5000);

// Periodic maintenance: purge flights older than 48h every hour,
// and compress paths once a day.
setInterval(purgeOldData, 60 * 60 * 1000);
setInterval(runDeepClean, 24 * 60 * 60 * 1000);

// With synchronous=OFF and a steady write stream the WAL file (and the memory
// mapping behind it) keeps growing until a checkpoint reclaims it. Force a
// truncating checkpoint every 10 minutes to keep it bounded.
setInterval(() => {
  try { db.pragma('wal_checkpoint(TRUNCATE)'); }
  catch (e) { console.warn('[history] WAL checkpoint failed:', e.message); }
}, 10 * 60 * 1000);

module.exports = { updateBatch, getFlightPath, getFlightsForReplay, runDeepClean };
