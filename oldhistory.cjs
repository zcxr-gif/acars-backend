const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// --- CONFIGURATION ---
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

/**
 * Clean up data older than 24 hours 
 */
function purgeOldData() {
  const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
  db.prepare('DELETE FROM flight_history WHERE lastSeen < ?').run(oneDayAgo);
}

/**
 * Enforces the "Max 2 Flights per User" rule for a specific user
 */
function enforceUserLimit(userId) {
  const userFlights = db.prepare('SELECT flightId FROM flight_history WHERE userId = ? ORDER BY lastSeen ASC').all(userId);
  if (userFlights.length >= 2) {
    db.prepare('DELETE FROM flight_history WHERE flightId = ?').run(userFlights[0].flightId);
  }
}

/**
 * Logic to determine if we should skip recording a point to the JSON array 
 */
function shouldSkipPoint(flight, lastPoint, now) {
  if (!lastPoint) return false;

  // 1. Stationary Bloat Prevention
  if (flight.position.gs_kt < 2 && lastPoint.gs < 2) {
    return true;
  }

  // 2. Cruising Altitude Throttling
  const isCruising = flight.position.alt_ft >= 20000;
  const timeSinceLast = now - lastPoint.time;
  if (isCruising && timeSinceLast < 120000) {
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
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

/**
 * Keeps only the last N flight sessions within the path array.
 */
function trimFlightSessions(pathArray, maxSessions = 3, sessionGapMs = 1800000) { 
  if (pathArray.length < 2) return pathArray;

  let sessionBoundaries = [];
  
  for (let i = 1; i < pathArray.length; i++) {
    const p1 = pathArray[i-1];
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

  if (pathArray.length > 3000) {
      return pathArray.slice(-3000);
  }

  return pathArray;
}

/**
 * [NEW] Retroactive Database Cleaner
 * Sweeps the entire DB to enforce limits and compress existing bloated arrays.
 */
function runDeepClean() {
  console.log('[history] 🧹 Starting deep clean of existing database...');
  
  // Phase 1: Enforce global user limits
  const users = db.prepare('SELECT DISTINCT userId FROM flight_history').all();
  let deletedFlights = 0;
  
  for (const u of users) {
    const userFlights = db.prepare('SELECT flightId FROM flight_history WHERE userId = ? ORDER BY lastSeen ASC').all(u.userId);
    // If a user has more than 2 flights, delete the oldest ones
    if (userFlights.length > 2) {
      const flightsToDelete = userFlights.slice(0, userFlights.length - 2);
      for (const f of flightsToDelete) {
        db.prepare('DELETE FROM flight_history WHERE flightId = ?').run(f.flightId);
        deletedFlights++;
      }
    }
  }

  // Phase 2: Compress historical flight paths
  const allFlights = db.prepare('SELECT flightId, path_json FROM flight_history').all();
  let updatedPaths = 0;
  const updateStmt = db.prepare('UPDATE flight_history SET path_json = ? WHERE flightId = ?');

  const cleanBatch = db.transaction((flights) => {
    for (const flight of flights) {
      if (!flight.path_json) continue;
      
      let pathArray;
      try {
         pathArray = JSON.parse(flight.path_json);
      } catch(e) { continue; }

      if (pathArray.length < 2) continue;

      // Rebuild the array, stripping out old stationary bloat
      let cleanedPath = [pathArray[0]];
      for (let i = 1; i < pathArray.length; i++) {
        const p1 = cleanedPath[cleanedPath.length - 1];
        const p2 = pathArray[i];
        
        // Retrospectively apply the stationary rule (gs is saved as 'gs', not 'gs_kt')
        if (p2.gs < 2 && p1.gs < 2) continue;
        
        // Retrospectively apply the cruising rule (alt is saved as 'alt', not 'alt_ft')
        if (p2.alt >= 20000 && (p2.time - p1.time) < 120000) continue;
        
        cleanedPath.push(p2);
      }

      // Trim sessions based on the newly cleaned timeline
      cleanedPath = trimFlightSessions(cleanedPath, 3, 30 * 60 * 1000);

      // Only write to the DB if we actually compressed the data
      if (cleanedPath.length < pathArray.length) {
        updateStmt.run(JSON.stringify(cleanedPath), flight.flightId);
        updatedPaths++;
      }
    }
  });

  cleanBatch(allFlights);
  console.log(`[history] ✨ Deep clean complete! Deleted ${deletedFlights} old flights, compressed ${updatedPaths} flight paths.`);
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
        enforceUserLimit(flight.userId);
      }

      const lastPoint = flightPath[flightPath.length - 1];
  
      if (shouldSkipPoint(flight, lastPoint, now)) {
        db.prepare('UPDATE flight_history SET lastSeen = ? WHERE flightId = ?').run(now, flight.flightId);
        continue; 
      }

      flightPath.push({
        lat: flight.position.lat,
        lon: flight.position.lon,
        alt: flight.position.alt_ft,
        gs: flight.position.gs_kt,
        time: now
      });

      flightPath = trimFlightSessions(flightPath, 3, 30 * 60 * 1000);

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

// Run the deep clean 5 seconds after startup so it doesn't block the initial boot process
setTimeout(runDeepClean, 5000);

module.exports = { updateBatch, getFlightPath, runDeepClean };