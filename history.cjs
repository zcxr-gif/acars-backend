const Database = require('better-sqlite3');
const path = require('path');

// 1. Initialize the DB [cite: 1]
const db = new Database('flight_history.db');

// 2. High-Performance Configuration [cite: 2]
db.pragma('journal_mode = WAL'); 
db.pragma('synchronous = OFF');

// 3. Create Tables [cite: 2]
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

db.prepare(`CREATE INDEX IF NOT EXISTS idx_user_time ON flight_history (userId, lastSeen)`).run(); [cite: 3]

/**
 * Appends a new position to the flight's history (Single Flight) [cite: 4]
 */
async function updateFlightPath(flight) {
  const now = Date.now(); [cite: 4]
  const userId = flight.userId; [cite: 5]
  const flightId = flight.flightId; [cite: 5]

  // A. 24-Hour Cleanup [cite: 5]
  const oneDayAgo = now - (24 * 60 * 60 * 1000); [cite: 5]
  db.prepare('DELETE FROM flight_history WHERE lastSeen < ?').run(oneDayAgo); [cite: 6]

  // B. Get existing flight data [cite: 6]
  const existing = db.prepare('SELECT path_json FROM flight_history WHERE flightId = ?').get(flightId); [cite: 6]
  let flightPath = []; [cite: 7]
  if (existing && existing.path_json) {
    try {
      flightPath = JSON.parse(existing.path_json); [cite: 7]
    } catch (e) {
      flightPath = []; [cite: 8]
    }
  }

  // C. Append the new point [cite: 9]
  flightPath.push({
    lat: flight.position.lat,
    lon: flight.position.lon,
    alt: flight.position.alt_ft,
    gs: flight.position.gs_kt,
    time: now
  }); [cite: 9, 10]

  // D. Enforce "Max 2 Flights" Rule [cite: 10]
  if (!existing) {
    const userFlights = db.prepare('SELECT flightId FROM flight_history WHERE userId = ? ORDER BY lastSeen ASC').all(userId); [cite: 10]
    if (userFlights.length >= 2) {
      db.prepare('DELETE FROM flight_history WHERE flightId = ?').run(userFlights[0].flightId); [cite: 11]
    }
  }

  // E. Save back to DB [cite: 12]
  db.prepare(`
    INSERT INTO flight_history (userId, flightId, callsign, lastSeen, path_json)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(flightId) DO UPDATE SET
      lastSeen = excluded.lastSeen,
      path_json = excluded.path_json
  `).run(userId, flightId, flight.callsign, now, JSON.stringify(flightPath)); [cite: 12, 13]
}

/**
 * NEW: Batch Update for 24/7 Polling
 * Processes multiple flights in a single transaction for efficiency.
 */
function updateBatch(flights) {
  const now = Date.now();
  const oneDayAgo = now - (24 * 60 * 60 * 1000);

  // 1. Run cleanup once per batch
  db.prepare('DELETE FROM flight_history WHERE lastSeen < ?').run(oneDayAgo);

  // 2. Define the individual upsert statement
  const upsertStmt = db.prepare(`
    INSERT INTO flight_history (userId, flightId, callsign, lastSeen, path_json)
    VALUES (@userId, @flightId, @callsign, @lastSeen, @path_json)
    ON CONFLICT(flightId) DO UPDATE SET
      lastSeen = excluded.lastSeen,
      path_json = excluded.path_json
  `);

  // 3. Define the Transaction
  const runBatch = db.transaction((flightList) => {
    for (const flight of flightList) {
      // Get current path
      const existing = db.prepare('SELECT path_json FROM flight_history WHERE flightId = ?').get(flight.flightId);
      let flightPath = [];
      
      if (existing?.path_json) {
        try { flightPath = JSON.parse(existing.path_json); } catch (e) { flightPath = []; }
      }

      // Add new point
      flightPath.push({
        lat: flight.position.lat,
        lon: flight.position.lon,
        alt: flight.position.alt_ft,
        gs: flight.position.gs_kt,
        time: now
      });

      // Execute within transaction
      upsertStmt.run({
        userId: flight.userId,
        flightId: flight.flightId,
        callsign: flight.callsign,
        lastSeen: now,
        path_json: JSON.stringify(flightPath)
      });
    }
  });

  // 4. Execute the batch
  runBatch(flights);
}

/**
 * Retrieves the path for the API [cite: 13]
 */
async function getFlightPath(flightId) {
  const row = db.prepare('SELECT path_json FROM flight_history WHERE flightId = ?').get(flightId); [cite: 13]
  return row ? JSON.parse(row.path_json) : []; [cite: 14]
}

module.exports = { updateFlightPath, getFlightPath, updateBatch };