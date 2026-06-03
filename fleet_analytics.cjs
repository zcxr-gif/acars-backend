/* =========================
 * fleet_analytics.cjs
 * Live-world fleet analytics for Infinite Flight.
 *
 * The broadcaster already polls every active flight on every server (aircraft
 * type, livery/airline, departure + arrival ICAO, position, phase, VA, server).
 * This module turns that firehose into aggregate insight:
 *   - Most popular aircraft types & liveries (airlines) in the air right now
 *   - Busiest airports (by combined departures + arrivals)
 *   - Per-server flight distribution
 *   - Flight-phase breakdown (ground / climb / cruise / descent)
 *   - Top virtual organisations by active flights
 *   - Global totals (live flights, airborne, unique pilots, VA/staff presence)
 *
 * Snapshots of those aggregates are persisted to SQLite on an interval so the
 * dashboard can show trends over days/weeks, not just the current instant.
 *
 * `computeLiveSnapshot` is pure (no I/O) — safe to call on every request.
 * Persistence lives in its own DB file so it never contends with the flight
 * history or telemetry databases.
 * ========================= */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const TOP_N = 15;            // rows kept per leaderboard in a snapshot
const RETENTION_DAYS = 14;   // how far back trend history is kept

/* ---- Persistence ---- */
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) { /* handled below */ }
}

let db;
try {
  db = new Database(path.join(DATA_DIR, 'fleet.db'));
} catch (e) {
  console.error('[fleet] ❌ Could not open fleet.db, falling back to in-memory:', e.message);
  db = new Database(':memory:');
}
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS fleet_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    total_flights INTEGER,
    airborne INTEGER,
    unique_pilots INTEGER,
    data_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_fleet_ts ON fleet_snapshots(timestamp);
`);

/* ---- Aggregation helpers ---- */
function bump(map, key) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + 1);
}

function topN(map, n = TOP_N) {
  return [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, n);
}

/**
 * Classify a flight's phase from its live position. We only have MSL altitude,
 * so "On Ground" leans on groundspeed; the rest is driven by vertical speed.
 * Deliberately coarse — it's a fleet-wide distribution, not per-flight truth.
 */
function classifyPhase(pos) {
  if (!pos || typeof pos.gs_kt !== 'number') return 'Unknown';
  if (pos.gs_kt < 40) return 'On Ground';
  if (typeof pos.vs_fpm === 'number') {
    if (pos.vs_fpm > 250) return 'Climbing';
    if (pos.vs_fpm < -250) return 'Descending';
  }
  return 'Cruise';
}

/**
 * Aggregate the live flight cache into a single analytics snapshot.
 * @param {Array} sessionPayloads  values of apiCache.flights — each is
 *   { server, sessionId, count, flights: [...], timestamp }
 */
function computeLiveSnapshot(sessionPayloads = []) {
  const byAircraft = new Map();
  const byLivery = new Map();
  const byDeparture = new Map();
  const byArrival = new Map();
  const byAirport = new Map();   // combined dep + arr traffic
  const byServer = new Map();
  const byVA = new Map();
  const byPhase = new Map();
  const pilots = new Set();

  let totalFlights = 0;
  let airborne = 0;
  let onGround = 0;
  let vaMembers = 0;
  let staffOnline = 0;

  for (const payload of sessionPayloads) {
    const server = payload?.server || 'Unknown';
    const flights = Array.isArray(payload?.flights) ? payload.flights : [];

    for (const f of flights) {
      totalFlights += 1;
      bump(byServer, server);

      const ac = f.aircraft || {};
      bump(byAircraft, ac.aircraftName);
      bump(byLivery, ac.liveryName);

      const dep = f.departureIcao ? String(f.departureIcao).toUpperCase() : null;
      const arr = f.arrivalIcao ? String(f.arrivalIcao).toUpperCase() : null;
      if (dep) { bump(byDeparture, dep); bump(byAirport, dep); }
      if (arr) { bump(byArrival, arr); bump(byAirport, arr); }

      bump(byVA, f.virtualOrganization);
      if (f.isVAMember) vaMembers += 1;
      if (f.isStaff) staffOnline += 1;

      const phase = classifyPhase(f.position);
      bump(byPhase, phase);
      if (phase === 'On Ground') onGround += 1;
      else if (phase !== 'Unknown') airborne += 1;

      if (f.userId) pilots.add(f.userId);
      else if (f.username) pilots.add(f.username);
    }
  }

  return {
    timestamp: Date.now(),
    servers: sessionPayloads.length,
    totalFlights,
    airborne,
    onGround,
    uniquePilots: pilots.size,
    vaMembers,
    staffOnline,
    topAircraft: topN(byAircraft),
    topLiveries: topN(byLivery),
    busiestAirports: topN(byAirport),
    topDepartures: topN(byDeparture),
    topArrivals: topN(byArrival),
    topVAs: topN(byVA),
    byServer: topN(byServer, 20),
    byPhase: topN(byPhase, 6),
  };
}

/* ---- Snapshot persistence ---- */
const insertStmt = db.prepare(`
  INSERT INTO fleet_snapshots (total_flights, airborne, unique_pilots, data_json)
  VALUES (?, ?, ?, ?)
`);
const cleanupStmt = db.prepare(`
  DELETE FROM fleet_snapshots WHERE timestamp < datetime('now', ?)
`);
const persist = db.transaction((s) => {
  insertStmt.run(s.totalFlights || 0, s.airborne || 0, s.uniquePilots || 0, JSON.stringify(s));
  cleanupStmt.run(`-${RETENTION_DAYS} days`);
});

/**
 * Persist one snapshot and purge anything past the retention window. Empty
 * snapshots (no flights at all — e.g. an IF outage) are skipped so they don't
 * dilute the trend leaderboards with zero rows.
 */
function saveSnapshot(snapshot) {
  if (!snapshot || !snapshot.totalFlights) return false;
  persist(snapshot);
  return true;
}

/* ---- Trends over time ---- */
function aggTopN(map, n = TOP_N) {
  return [...map.entries()]
    .map(([key, total]) => ({ key, total }))
    .sort((a, b) => b.total - a.total)
    .slice(0, n);
}

/**
 * Build a trend report for the last `daysBack` days:
 *   - a downsampled time-series of total/airborne flights & unique pilots
 *   - presence-weighted leaderboards (an aircraft/airport that shows up in more
 *     snapshots, with higher counts, scores higher) summed across the window
 *   - the peak global flight count and when it happened
 */
function getTrends(daysBack = 7) {
  const days = Number(daysBack) || 7;
  const rows = db.prepare(`
    SELECT timestamp, total_flights, airborne, unique_pilots, data_json
    FROM fleet_snapshots
    WHERE timestamp >= datetime('now', ?)
    ORDER BY timestamp ASC
  `).all(`-${days} days`);

  const series = rows.map((r) => ({
    t: r.timestamp,
    totalFlights: r.total_flights,
    airborne: r.airborne,
    uniquePilots: r.unique_pilots,
  }));

  const aircraftAgg = new Map();
  const liveryAgg = new Map();
  const airportAgg = new Map();
  let peakFlights = 0;
  let peakAt = null;

  for (const r of rows) {
    if (r.total_flights > peakFlights) {
      peakFlights = r.total_flights;
      peakAt = r.timestamp;
    }
    let data;
    try { data = JSON.parse(r.data_json); } catch { continue; }
    for (const a of data.topAircraft || []) aircraftAgg.set(a.key, (aircraftAgg.get(a.key) || 0) + a.count);
    for (const a of data.topLiveries || []) liveryAgg.set(a.key, (liveryAgg.get(a.key) || 0) + a.count);
    for (const a of data.busiestAirports || []) airportAgg.set(a.key, (airportAgg.get(a.key) || 0) + a.count);
  }

  return {
    daysBack: days,
    samples: rows.length,
    peakFlights,
    peakAt,
    series,
    topAircraft: aggTopN(aircraftAgg),
    topLiveries: aggTopN(liveryAgg),
    busiestAirports: aggTopN(airportAgg),
  };
}

/* ---- Graceful shutdown (close cleanly so WAL is flushed) ---- */
process.on('exit', () => { try { if (db.open) db.close(); } catch (_) { /* ignore */ } });

module.exports = {
  computeLiveSnapshot,
  classifyPhase,
  saveSnapshot,
  getTrends,
};
