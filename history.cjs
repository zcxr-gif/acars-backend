const Database = require('better-sqlite3');
const path = require('path');

// 1. Initialize the DB
const db = new Database('flight_history.db');

// 2. High-Performance Configuration
db.pragma('journal_mode = WAL'); 
db.pragma('synchronous = OFF');

// 3. Create Tables
db.prepare(`
  CREATE TABLE IF NOT EXISTS flight_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId TEXT,
    flightId TEXT UNIQUE,
    callsign TEXT,
    lastSeen INTEGER,
    path_json TEXT -- Stores the array of coordinates
  )
`).run();

db.prepare(`CREATE INDEX IF NOT EXISTS idx_user_time ON flight_history (userId, lastSeen)`).run();

/**
 * Appends a new position to the flight's history (Single Flight)
 */
async function updateFlightPath(flight) {
  const now = Date.now();
  const userId = flight.userId;
  const flightId = flight.flightId;

  // A. 24-Hour Cleanup
  const oneDayAgo = now - (24 * 60 * 60 * 1000);
  db.prepare('DELETE FROM flight_history WHERE lastSeen < ?').run(oneDayAgo);

  // B. Get existing flight data
  const existing = db.prepare('SELECT path_json FROM flight_history WHERE flightId = ?').get(flightId);
  let flightPath = [];
  if (existing && existing.path_json) {
    try {
      flightPath = JSON.parse(existing.path_json);
    } catch (e) {
      flightPath = [];
    }
  }

  // C. Append the new point
  flightPath.push({
    lat: flight.position.lat,
    lon: flight.position.lon,
    alt: flight.position.alt_ft,
    gs: flight.position.gs_kt,
    time: now
  });

  // D. Enforce "Max 2 Flights" Rule
  if (!existing) {
    const userFlights = db.prepare('SELECT flightId FROM flight_history WHERE userId = ? ORDER BY lastSeen ASC').all(userId);
    if (userFlights.length >= 2) {
      db.prepare('DELETE FROM flight_history WHERE flightId = ?').run(userFlights[0].flightId);
    }
  }

  // E. Save back to DB
  db.prepare(`
    INSERT INTO flight_history (userId, flightId, callsign, lastSeen, path_json)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(flightId) DO UPDATE SET
      lastSeen = excluded.lastSeen,
      path_json = excluded.path_json
  `).run(userId, flightId, flight.callsign, now, JSON.stringify(flightPath));
}

/**
 * NEW: Batch Update for 24/7 Polling
 */
function updateBatch(flights) {
  const now = Date.now();
  const oneDayAgo = now - (24 * 60 * 60 * 1000);
  
  db.prepare('DELETE FROM flight_history WHERE lastSeen < ?').run(oneDayAgo);
  
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
        try { flightPath = JSON.parse(existing.path_json); } catch (e) { flightPath = []; }
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

module.exports = { updateFlightPath, getFlightPath, updateBatch };