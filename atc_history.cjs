/* =========================
 * ATC history & controller replay
 *
 * The Infinite Flight Live API exposes ATC only as a *live* snapshot
 * (`/sessions/{id}/atc`) — there is no "ATC route/history" endpoint the way
 * there is for flights. So, exactly like history.cjs does for aircraft, we
 * persist the snapshots the secondary poller already fetches and turn them into
 * frequency *intervals* (open → close). From those intervals we can:
 *   1. let the frontend search a controller's past sessions, and
 *   2. replay a session by reconstructing which flights were inside that
 *      controller's airspace during the session window, using the recorded
 *      paths in flight_history.
 *
 * Hard limit: replay only works inside the flight-path retention window (48h),
 * because that is the only window for which we have flight positions to show.
 * ========================= */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { getFlightsForReplay } = require('./history.cjs');

// --- CONFIGURATION ---
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'atc_history.db');

// Match the flight-path retention. Replaying a session older than this is
// pointless: the flights it contained have already been purged.
const RETENTION_MS = 48 * 60 * 60 * 1000;

// Two frequency intervals from the same controller at the same airport are
// considered one "controlling session" if the gap between them is under this.
const SESSION_GAP_MS = 15 * 60 * 1000;

// Padding applied to the session window when scanning flight paths, so a flight
// captured a poll-cycle before/after the frequency edges is still included.
const WINDOW_PAD_MS = 5 * 60 * 1000;

// IF ATCFrequencyType enum → human label.
const FREQ_TYPES = {
  0: 'Ground',
  1: 'Tower',
  2: 'Unicom',
  3: 'Clearance',
  4: 'Approach',
  5: 'Departure',
  6: 'Center',
  7: 'ATIS',
  8: 'Aircraft',
  9: 'Recorded',
  10: 'Unknown',
  11: 'Unused'
};

// How far out each kind of position realistically owns airspace, in nautical
// miles. A session's search radius is the max across the frequencies it staffed.
const FREQ_RADIUS_NM = {
  0: 15,   // Ground
  1: 15,   // Tower
  2: 15,   // Unicom
  3: 15,   // Clearance
  4: 60,   // Approach
  5: 60,   // Departure
  6: 250,  // Center
  7: 15,   // ATIS
  default: 30
};

// Anything that passes within this of the field is treated as "at the airport"
// (an arrival/departure) rather than just transiting the controller's airspace.
const AT_AIRPORT_NM = 3;

// Ensure the data directory exists (critical when backed by a volume).
if (!fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    console.error(`[atc-history] ❌ Failed to create data directory at ${DATA_DIR}.`, e);
  }
}

console.log(`[atc-history] Database path: ${DB_PATH}`);

let db;
try {
  db = new Database(DB_PATH);
} catch (e) {
  console.error('[atc-history] ❌ CRITICAL DATABASE ERROR:', e.message);
  console.warn('[atc-history] Falling back to in-memory database (data will not persist!)');
  db = new Database(':memory:');
}

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.prepare(`
  CREATE TABLE IF NOT EXISTS atc_intervals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sessionId TEXT,
    userId TEXT,
    username TEXT,
    frequencyId TEXT,
    airportName TEXT,
    freqType INTEGER,
    lat REAL,
    lon REAL,
    startTime INTEGER,
    endTime INTEGER,
    lastSeen INTEGER,
    UNIQUE(userId, frequencyId, startTime)
  )
`).run();
db.prepare(`CREATE INDEX IF NOT EXISTS idx_atc_session_start ON atc_intervals (sessionId, startTime)`).run();
db.prepare(`CREATE INDEX IF NOT EXISTS idx_atc_user_start ON atc_intervals (userId, startTime)`).run();

/* =========================
 * Helpers
 * ========================= */

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

function freqLabel(type) {
  return FREQ_TYPES[type] ?? `Type${type}`;
}

function radiusForTypes(types) {
  let max = 0;
  for (const t of types) {
    const r = FREQ_RADIUS_NM[t] ?? FREQ_RADIUS_NM.default;
    if (r > max) max = r;
  }
  return max || FREQ_RADIUS_NM.default;
}

// Parse the API's ISO startTime to epoch ms, tolerating missing/odd values.
function parseStart(value, fallback) {
  if (typeof value === 'number' && value > 0) return value;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : fallback;
}

function purgeOld() {
  const cutoff = Date.now() - RETENTION_MS;
  // A row is dead once its last-seen falls outside retention.
  db.prepare('DELETE FROM atc_intervals WHERE lastSeen < ?').run(cutoff);
}

/* =========================
 * Recording
 * ========================= */

/**
 * Fold one live ATC snapshot into the interval table.
 *  - new frequencies are inserted as open intervals (endTime = NULL),
 *  - re-seen frequencies have their lastSeen bumped (and are re-opened if a
 *    transient drop-out had closed them),
 *  - open intervals for this session that are absent from the snapshot are
 *    closed at their last-seen time.
 *
 * `atcList` is the raw `result` array from GET /sessions/{id}/atc.
 */
function updateAtcBatch(sessionId, atcList) {
  if (!sessionId || !Array.isArray(atcList)) return;
  const now = Date.now();

  const upsert = db.prepare(`
    INSERT INTO atc_intervals
      (sessionId, userId, username, frequencyId, airportName, freqType, lat, lon, startTime, endTime, lastSeen)
    VALUES
      (@sessionId, @userId, @username, @frequencyId, @airportName, @freqType, @lat, @lon, @startTime, NULL, @lastSeen)
    ON CONFLICT(userId, frequencyId, startTime) DO UPDATE SET
      lastSeen = excluded.lastSeen,
      endTime = NULL,
      username = excluded.username,
      airportName = excluded.airportName,
      lat = excluded.lat,
      lon = excluded.lon
  `);

  const selectOpen = db.prepare(
    'SELECT id, userId, frequencyId, startTime, lastSeen FROM atc_intervals WHERE sessionId = ? AND endTime IS NULL'
  );
  const closeStmt = db.prepare('UPDATE atc_intervals SET endTime = ? WHERE id = ?');

  const run = db.transaction((list) => {
    const liveKeys = new Set();

    for (const a of list) {
      if (!a || !a.userId || a.frequencyId == null) continue;
      const startTime = parseStart(a.startTime, now);
      liveKeys.add(`${a.userId}|${a.frequencyId}|${startTime}`);
      upsert.run({
        sessionId,
        userId: String(a.userId),
        username: a.username || '',
        frequencyId: String(a.frequencyId),
        airportName: a.airportName || '',
        freqType: typeof a.type === 'number' ? a.type : -1,
        lat: typeof a.latitude === 'number' ? a.latitude : null,
        lon: typeof a.longitude === 'number' ? a.longitude : null,
        startTime,
        lastSeen: now
      });
    }

    // Close anything previously open that did not appear this round.
    for (const row of selectOpen.all(sessionId)) {
      const key = `${row.userId}|${row.frequencyId}|${row.startTime}`;
      if (!liveKeys.has(key)) {
        closeStmt.run(row.lastSeen, row.id);
      }
    }
  });

  run(atcList);
  purgeOld();
}

/**
 * On boot we can't know which sessions are still live, so seal every dangling
 * open interval at its last-seen time. If a frequency is in fact still staffed,
 * the next poll re-opens it via the upsert (same userId+frequencyId+startTime).
 */
function closeDangling() {
  const info = db
    .prepare('UPDATE atc_intervals SET endTime = lastSeen WHERE endTime IS NULL')
    .run();
  if (info.changes) {
    console.log(`[atc-history] Sealed ${info.changes} dangling open interval(s) on startup.`);
  }
}

/* =========================
 * Session grouping & search
 * ========================= */

// Walk time-ordered intervals for a single controller and merge contiguous
// frequencies at the same airport into "controlling sessions".
function groupIntervals(rows) {
  const sorted = rows
    .slice()
    .sort((a, b) =>
      a.userId === b.userId
        ? (a.airportName === b.airportName ? a.startTime - b.startTime : a.airportName.localeCompare(b.airportName))
        : a.userId.localeCompare(b.userId)
    );

  const sessions = [];
  let cur = null;

  for (const r of sorted) {
    const end = r.endTime || r.lastSeen;
    const sameGroup =
      cur &&
      cur.userId === r.userId &&
      cur.airportName === r.airportName &&
      r.startTime - cur.end <= SESSION_GAP_MS;

    if (!sameGroup) {
      if (cur) sessions.push(cur);
      cur = {
        key: `${r.userId}:${r.startTime}`,
        sessionId: r.sessionId,
        userId: r.userId,
        username: r.username,
        airportName: r.airportName,
        lat: r.lat,
        lon: r.lon,
        start: r.startTime,
        end,
        open: r.endTime == null,
        types: new Set([r.freqType]),
        intervals: [r]
      };
    } else {
      cur.end = Math.max(cur.end, end);
      cur.open = cur.open || r.endTime == null;
      cur.types.add(r.freqType);
      cur.intervals.push(r);
      if (cur.lat == null && r.lat != null) { cur.lat = r.lat; cur.lon = r.lon; }
    }
  }
  if (cur) sessions.push(cur);
  return sessions;
}

function summarize(session) {
  return {
    key: session.key,
    sessionId: session.sessionId,
    userId: session.userId,
    username: session.username,
    airportName: session.airportName,
    lat: session.lat,
    lon: session.lon,
    start: session.start,
    end: session.end,
    open: session.open,
    durationMin: Math.round((session.end - session.start) / 60000),
    frequencies: [...session.types].map(freqLabel)
  };
}

/**
 * Search recorded controller sessions. All filters optional.
 *   { sessionId, user (username substring), userId, sinceMs, limit }
 */
function getSessions({ sessionId, user, userId, sinceMs, limit = 100 } = {}) {
  const cutoff = Math.max(sinceMs || 0, Date.now() - RETENTION_MS);
  const clauses = ['lastSeen >= ?'];
  const params = [cutoff];

  if (sessionId) { clauses.push('sessionId = ?'); params.push(sessionId); }
  if (userId) { clauses.push('userId = ?'); params.push(String(userId)); }
  if (user) { clauses.push('username LIKE ?'); params.push(`%${user}%`); }

  const rows = db
    .prepare(`SELECT * FROM atc_intervals WHERE ${clauses.join(' AND ')} ORDER BY startTime DESC`)
    .all(...params);

  const sessions = groupIntervals(rows)
    .sort((a, b) => b.start - a.start)
    .slice(0, limit)
    .map(summarize);

  return sessions;
}

/* =========================
 * Replay
 * ========================= */

// Re-derive a single grouped session from its key (`userId:startTime`).
function findSessionByKey(key) {
  const sep = key.lastIndexOf(':');
  if (sep < 0) return null;
  const userId = key.slice(0, sep);
  const start = parseInt(key.slice(sep + 1), 10);
  if (!userId || !Number.isFinite(start)) return null;

  const rows = db
    .prepare('SELECT * FROM atc_intervals WHERE userId = ? ORDER BY startTime ASC')
    .all(userId);

  return groupIntervals(rows).find(s => s.userId === userId && s.start === start) || null;
}

/**
 * Build the full replay payload for a controlling session: the controller's
 * facility and frequency timeline, plus every recorded flight that was inside
 * the controller's airspace during the (padded) session window.
 */
function getReplay(key) {
  const session = findSessionByKey(key);
  if (!session) return null;

  const winStart = session.start - WINDOW_PAD_MS;
  const winEnd = (session.open ? Date.now() : session.end) + WINDOW_PAD_MS;
  const radius = radiusForTypes([...session.types]);
  const hasFacility = session.lat != null && session.lon != null;

  const flights = [];
  if (hasFacility) {
    const candidates = getFlightsForReplay(winStart);
    for (const f of candidates) {
      if (!Array.isArray(f.path) || f.path.length === 0) continue;

      let closestNm = Infinity;
      const seg = [];
      for (const p of f.path) {
        if (p.time < winStart || p.time > winEnd) continue;
        const d = getDistanceNM(session.lat, session.lon, p.lat, p.lon);
        if (d <= radius) {
          seg.push(p);
          if (d < closestNm) closestNm = d;
        }
      }
      if (seg.length === 0) continue;

      flights.push({
        flightId: f.flightId,
        userId: f.userId,
        callsign: f.callsign,
        closestNm: Math.round(closestNm * 10) / 10,
        atAirport: closestNm <= AT_AIRPORT_NM,
        path: seg
      });
    }
    flights.sort((a, b) => a.closestNm - b.closestNm);
  }

  return {
    controller: {
      key: session.key,
      userId: session.userId,
      username: session.username,
      airportName: session.airportName,
      lat: session.lat,
      lon: session.lon,
      window: { start: session.start, end: session.open ? Date.now() : session.end },
      open: session.open,
      searchRadiusNm: radius,
      frequencies: session.intervals.map(i => ({
        type: freqLabel(i.freqType),
        frequencyId: i.frequencyId,
        start: i.startTime,
        end: i.endTime || i.lastSeen,
        open: i.endTime == null
      }))
    },
    flightCount: flights.length,
    flights
  };
}

// Startup + periodic maintenance.
setTimeout(closeDangling, 4000);
setInterval(purgeOld, 60 * 60 * 1000);
// Keep the WAL (and its memory mapping) bounded under the steady poll-write load.
setInterval(() => {
  try { db.pragma('wal_checkpoint(TRUNCATE)'); }
  catch (e) { console.warn('[atc-history] WAL checkpoint failed:', e.message); }
}, 10 * 60 * 1000);

module.exports = { updateAtcBatch, getSessions, getReplay };
