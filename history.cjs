const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const codec = require('./path_codec.cjs');

// --- CONFIGURATION ---
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'flight_history.db');

// Tunables — change these in one place if you ever need to.
const MAX_POINTS_PER_FLIGHT = 1500; // was 3000 — halved, since per-point cost dropped ~45%
const MAX_SESSIONS_PER_FLIGHT = 3;
const SESSION_GAP_MS = 30 * 60 * 1000;
const CRUISE_THROTTLE_MS = 120000;
const CRUISE_ALT_FT = 20000;

/* --- Retention ---
 * Trails used to be dropped after 48 hours. That number was never about disk
 * price; it was the only way to keep a table under control that rewrote every
 * airborne aircraft's entire trail, as JSON, every fifteen seconds. Chunked
 * binary storage (see path_codec.cjs and appendPoints below) cuts the bytes per
 * point ~5x and the bytes written per poll by two orders of magnitude, so the
 * window can now be opened up by roughly the same factor for the same disk.
 *
 * Two limits apply, and the tighter one wins:
 *
 *   HISTORY_RETENTION_HOURS  age ceiling. Default 14 days.
 *   HISTORY_MAX_DB_MB        size ceiling. When the database exceeds it the
 *                            oldest flights are dropped until it fits again.
 *
 * The size ceiling is the important one operationally: it means an unusually
 * busy week degrades into a shorter window instead of filling the volume. Set
 * HISTORY_MAX_DB_MB=0 to disable it and rely on age alone.
 */
const intEnv = (name, dflt) => {
  const parsed = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : dflt;
};

const RETENTION_HOURS = intEnv('HISTORY_RETENTION_HOURS', 24 * 14);
const RETENTION_MS = RETENTION_HOURS * 60 * 60 * 1000;
const MAX_DB_BYTES = intEnv('HISTORY_MAX_DB_MB', 4096) * 1024 * 1024;

/* --- Chunking ---
 * Points accumulate in a small hot tail on the flight's own row, which is the
 * only thing rewritten on a normal poll. Once the tail reaches CHUNK_POINTS it
 * is sealed into an immutable row in flight_path_chunks and the tail resets.
 *
 * Sealed chunks are never updated again — trimming deletes whole chunk rows —
 * so the expensive part of the old design (rewriting the entire trail to append
 * one point) simply does not happen any more.
 *
 * 48 points is a little over two minutes of climb/descent sampling, or ~90
 * minutes of throttled cruise. It keeps the per-poll tail rewrite around half a
 * kilobyte while holding each chunk's absolute-point overhead under 3%.
 */
const CHUNK_POINTS = intEnv('HISTORY_CHUNK_POINTS', 48);

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

/* Sealed trail chunks.
 *
 * These live in their own table rather than a column on flight_history for one
 * decisive reason: SQLite rewrites a row's entire record on any UPDATE. Had the
 * sealed trail stayed a column, touching the hot tail every fifteen seconds
 * would have rewritten the whole trail alongside it and the chunking would have
 * bought nothing at all. As a separate table, sealing is an INSERT of one small
 * row and existing chunks are never written again.
 *
 * `points` is stored so trimming can count a chunk without decoding it.
 */
db.prepare(`
  CREATE TABLE IF NOT EXISTS flight_path_chunks (
    flightId TEXT NOT NULL,
    seq      INTEGER NOT NULL,
    points   INTEGER NOT NULL,
    chunk    BLOB NOT NULL,
    PRIMARY KEY (flightId, seq)
  )
`).run();

// Dedupe ledger for VA takeoff/landing events already pushed to the other
// backend. One row per (flightId, event) so we never announce the same state
// twice — even across a restart, which clears the in-memory phase tracker.
// Rows are tiny and purged on the same 48h schedule as flight_history.
db.prepare(`
  CREATE TABLE IF NOT EXISTS va_sent_events (
    flightId TEXT,
    event TEXT,
    sentAt INTEGER,
    PRIMARY KEY (flightId, event)
  )
`).run();
db.prepare(`CREATE INDEX IF NOT EXISTS idx_va_sent_at ON va_sent_events (sentAt)`).run();
const claimEventStmt = db.prepare(
  `INSERT OR IGNORE INTO va_sent_events (flightId, event, sentAt) VALUES (?, ?, ?)`
);

/**
 * Atomically claim a (flightId, event) pair before sending it onward.
 * Returns true only the first time it's seen — i.e. when it was newly inserted
 * — so the caller sends exactly once. Returns false if we've already sent it.
 * Fails open (returns true) on a storage error: a rare duplicate beats dropping
 * a real takeoff/landing.
 */
function claimFlightState(flightId, event) {
  if (!flightId || !event) return false;
  try {
    return claimEventStmt.run(String(flightId), String(event), Date.now()).changes > 0;
  } catch (e) {
    console.warn('[history] claimFlightState failed:', e.message);
    return true;
  }
}

const releaseEventStmt = db.prepare(
  `DELETE FROM va_sent_events WHERE flightId = ? AND event = ?`
);

/**
 * Gives a claim back, so the work it guarded can be retried.
 *
 * Announcing a takeoff never needed this — a send either happened or it didn't.
 * Archiving does: it claims before uploading, and an upload that fails to a
 * network blip must not cost the pilot their replay permanently.
 */
function releaseFlightState(flightId, event) {
  if (!flightId || !event) return false;
  try {
    return releaseEventStmt.run(String(flightId), String(event)).changes > 0;
  } catch (e) {
    console.warn('[history] releaseFlightState failed:', e.message);
    return false;
  }
}

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

  // Chunked-storage columns. `path_json` is left in place and kept readable —
  // rows written by the old build are migrated lazily (on their next poll) or
  // by the background sweep, never in one blocking pass at boot.
  const chunkCols = {
    tail_blob: 'BLOB',       // hot buffer of unsealed points
    last_point: 'TEXT',      // last recorded point, so a just-sealed trail can
                             // still answer shouldSkipPoint without a decode
    point_count: 'INTEGER',  // chunks + tail, maintained incrementally
    session_breaks: 'INTEGER',
    chunk_seq: 'INTEGER'     // next sequence number to seal at
  };
  for (const [col, type] of Object.entries(chunkCols)) {
    if (!existing.has(col)) {
      db.prepare(`ALTER TABLE flight_history ADD COLUMN ${col} ${type}`).run();
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
 * Reads a legacy path_json string and returns it as an array of
 * {lat,lon,alt,gs,time}. Handles both the compact format (array of arrays) and
 * the older object format. Trails are no longer written this way — this exists
 * so rows put down by previous builds stay readable until they are migrated.
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

/* =========================
 * Chunked trail storage
 * ========================= */

const selectChunksStmt = db.prepare(
  'SELECT chunk FROM flight_path_chunks WHERE flightId = ? ORDER BY seq'
);

/**
 * Rebuilds a full trail: every sealed chunk in order, then the unsealed tail.
 * `row` must carry tail_blob and path_json.
 */
function assemblePath(flightId, row) {
  // A row still in the legacy format has no chunks yet.
  if (row && row.path_json) return readPath(row.path_json);

  const points = [];
  for (const r of selectChunksStmt.all(flightId)) {
    const decoded = codec.decodeBlob(r.chunk);
    for (const p of decoded) points.push(p);
  }
  if (row && row.tail_blob && row.tail_blob.length) {
    for (const p of codec.decodeBlob(row.tail_blob)) points.push(p);
  }
  return points;
}

function packLastPoint(p) {
  return p ? JSON.stringify(packPoint(p)) : null;
}

function unpackLastPoint(text) {
  if (!text) return null;
  try {
    const arr = JSON.parse(text);
    return Array.isArray(arr) ? unpackPoint(arr) : null;
  } catch {
    return null;
  }
}

/**
 * Total bytes the history database occupies, main file plus WAL.
 */
function databaseBytes() {
  let total = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try { total += fs.statSync(DB_PATH + suffix).size; } catch { /* absent */ }
  }
  return total;
}

const deleteChunksForStmt = db.prepare(
  'DELETE FROM flight_path_chunks WHERE flightId IN (SELECT flightId FROM flight_history WHERE lastSeen < ?)'
);

/**
 * Drops flights past the age ceiling, then — if the database is still over its
 * size ceiling — drops the oldest flights until it fits.
 *
 * Chunk rows are removed before their parent row, so the subquery that finds
 * them still resolves. Nothing here decodes a trail.
 */
function purgeOldData() {
  const cutoff = Date.now() - RETENTION_MS;
  deleteChunksForStmt.run(cutoff);
  db.prepare('DELETE FROM flight_history WHERE lastSeen < ?').run(cutoff);
  db.prepare('DELETE FROM va_sent_events WHERE sentAt < ?').run(Date.now() - (48 * 60 * 60 * 1000));

  if (!MAX_DB_BYTES) return;

  // Size ceiling. Walk forward from the oldest flights in slices, re-measuring
  // as we go, so a quiet database never pays for a scan it doesn't need.
  let guard = 0;
  while (databaseBytes() > MAX_DB_BYTES && guard++ < 200) {
    const slice = db
      .prepare('SELECT lastSeen FROM flight_history ORDER BY lastSeen ASC LIMIT 1 OFFSET 2000')
      .get();
    // Fewer than 2000 rows left and still over budget — something other than
    // trail volume is responsible, so stop rather than empty the table.
    if (!slice) break;

    deleteChunksForStmt.run(slice.lastSeen);
    const removed = db.prepare('DELETE FROM flight_history WHERE lastSeen < ?').run(slice.lastSeen).changes;
    if (!removed) break;

    // Space is only actually reclaimed once the WAL folds back into the main
    // file, and databaseBytes() counts both — checkpoint so the next
    // measurement reflects the delete.
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* non-fatal */ }
    console.log(`[history] Over size ceiling — dropped ${removed} oldest flights.`);
  }
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

const insertChunkStmt = db.prepare(
  'INSERT OR REPLACE INTO flight_path_chunks (flightId, seq, points, chunk) VALUES (?, ?, ?, ?)'
);
const deleteFlightChunksStmt = db.prepare('DELETE FROM flight_path_chunks WHERE flightId = ?');

/**
 * Lays a whole trail down as chunks plus a leftover tail, replacing whatever
 * was stored for the flight. Returns the next free sequence number and the
 * unsealed remainder for the caller to put on the flight's row.
 *
 * This is the expensive path. It runs on migration and on a trim — never on an
 * ordinary poll.
 */
function rewriteTrail(flightId, points) {
  deleteFlightChunksStmt.run(flightId);

  let seq = 0;
  let i = 0;
  for (; i + CHUNK_POINTS <= points.length; i += CHUNK_POINTS) {
    const slice = points.slice(i, i + CHUNK_POINTS);
    insertChunkStmt.run(flightId, seq++, slice.length, codec.encodeAll(slice));
  }

  return { chunkSeq: seq, tail: points.slice(i) };
}

/**
 * Migrates rows still holding a legacy `path_json` trail into chunked storage.
 *
 * The old deep clean read every row in the table in one go, which was tolerable
 * at 48 hours and would not be at two weeks. This one takes a bounded slice per
 * pass and stops as soon as no legacy rows remain — after the fleet has cycled
 * through once it is a single indexed lookup that finds nothing.
 */
function runDeepClean(batchSize = 500) {
  const legacy = db
    .prepare('SELECT flightId, path_json FROM flight_history WHERE path_json IS NOT NULL LIMIT ?')
    .all(batchSize);

  if (legacy.length === 0) return 0;

  const clearJsonStmt = db.prepare(
    'UPDATE flight_history SET path_json = NULL, tail_blob = ?, last_point = ?, point_count = ?, session_breaks = ?, chunk_seq = ? WHERE flightId = ?'
  );

  let migrated = 0;
  const migrateBatch = db.transaction((rows) => {
    for (const row of rows) {
      const points = trimFlightSessions(readPath(row.path_json));
      const { chunkSeq, tail } = rewriteTrail(row.flightId, points);
      clearJsonStmt.run(
        tail.length ? codec.encodeAll(tail) : null,
        packLastPoint(points[points.length - 1]),
        points.length,
        countSessionBreaks(points),
        chunkSeq,
        row.flightId
      );
      migrated++;
    }
  });

  migrateBatch(legacy);
  console.log(`[history] Migrated ${migrated} legacy trails to chunked storage.`);

  // More waiting? Come back shortly rather than doing it all at once.
  if (legacy.length === batchSize) setTimeout(() => runDeepClean(batchSize), 5000);
  return migrated;
}

/** Counts session boundaries in an assembled trail. */
function countSessionBreaks(pathArray) {
  let breaks = 0;
  for (let i = 1; i < pathArray.length; i++) {
    const p1 = pathArray[i - 1];
    const p2 = pathArray[i];
    if ((p2.time - p1.time) > SESSION_GAP_MS || getDistanceNM(p1.lat, p1.lon, p2.lat, p2.lon) > 50) {
      breaks++;
    }
  }
  return breaks;
}

/**
 * Applies the size and session limits to a flight that has just sealed a chunk.
 *
 * The cheap case — too many points — drops whole chunk rows off the front,
 * which needs no decoding at all. Only a flight that has accumulated more
 * sessions than we keep gets the full decode-trim-rewrite, and that needs three
 * separate departures logged under one flightId to trigger.
 *
 * Limits are therefore enforced at chunk granularity: a trail can run up to
 * CHUNK_POINTS over MAX_POINTS_PER_FLIGHT before the next seal pulls it back.
 * That slack is the entire point — it is what keeps the common poll O(1).
 */
function enforceTrailLimits(flightId, state) {
  if (state.sessionBreaks >= MAX_SESSIONS_PER_FLIGHT) {
    const trimmed = trimFlightSessions(assemblePath(flightId, { tail_blob: null }));
    const { chunkSeq, tail } = rewriteTrail(flightId, trimmed);
    state.chunkSeq = chunkSeq;
    state.tail = tail;
    state.pointCount = trimmed.length;
    state.sessionBreaks = countSessionBreaks(trimmed);
    return;
  }

  if (state.pointCount <= MAX_POINTS_PER_FLIGHT) return;

  const chunks = db
    .prepare('SELECT seq, points FROM flight_path_chunks WHERE flightId = ? ORDER BY seq')
    .all(flightId);
  const dropStmt = db.prepare('DELETE FROM flight_path_chunks WHERE flightId = ? AND seq = ?');

  for (const c of chunks) {
    if (state.pointCount - c.points < MAX_POINTS_PER_FLIGHT) break;
    dropStmt.run(flightId, c.seq);
    state.pointCount -= c.points;
  }
}

const selectFlightStateStmt = db.prepare(
  'SELECT path_json, tail_blob, last_point, point_count, session_breaks, chunk_seq FROM flight_history WHERE flightId = ?'
);

const upsertFlightStmt = db.prepare(`
  INSERT INTO flight_history (userId, flightId, callsign, lastSeen, path_json, aircraftId, liveryId, aircraftName, liveryName, tail_blob, last_point, point_count, session_breaks, chunk_seq)
  VALUES (@userId, @flightId, @callsign, @lastSeen, NULL, @aircraftId, @liveryId, @aircraftName, @liveryName, @tail_blob, @last_point, @point_count, @session_breaks, @chunk_seq)
  ON CONFLICT(flightId) DO UPDATE SET
    lastSeen = excluded.lastSeen,
    path_json = NULL,
    aircraftId = excluded.aircraftId,
    liveryId = excluded.liveryId,
    aircraftName = excluded.aircraftName,
    liveryName = excluded.liveryName,
    tail_blob = excluded.tail_blob,
    last_point = excluded.last_point,
    point_count = excluded.point_count,
    session_breaks = excluded.session_breaks,
    chunk_seq = excluded.chunk_seq
`);

const touchLastSeenStmt = db.prepare('UPDATE flight_history SET lastSeen = ? WHERE flightId = ?');

/**
 * Optimized Batch Update
 *
 * One poll appends at most one point per flight. The old implementation read,
 * parsed, re-serialised and rewrote that flight's entire trail to do it, so the
 * cost of recording a long-haul grew with its own length — the dominant write
 * cost in this process by a wide margin.
 *
 * Now the point lands in a small tail that is the only thing rewritten, and the
 * trail proper is touched once every CHUNK_POINTS polls by a single INSERT.
 */
function updateBatch(flights) {
  const now = Date.now();

  const runBatch = db.transaction((flightList) => {
    for (const flight of flightList) {
      const row = selectFlightStateStmt.get(flight.flightId);

      // A row written by the previous build still carries its trail as JSON.
      // Convert it here rather than waiting for the sweep — this flight is
      // active, so it would only be rewritten again in a moment anyway.
      let state;
      if (row && row.path_json) {
        const legacy = trimFlightSessions(readPath(row.path_json));
        const { chunkSeq, tail } = rewriteTrail(flight.flightId, legacy);
        state = {
          tail,
          chunkSeq,
          pointCount: legacy.length,
          sessionBreaks: countSessionBreaks(legacy),
          lastPoint: legacy[legacy.length - 1] || null
        };
      } else if (row) {
        const tail = row.tail_blob && row.tail_blob.length ? codec.decodeBlob(row.tail_blob) : [];
        state = {
          tail,
          chunkSeq: row.chunk_seq || 0,
          pointCount: row.point_count || 0,
          sessionBreaks: row.session_breaks || 0,
          lastPoint: unpackLastPoint(row.last_point) || tail[tail.length - 1] || null
        };
      } else {
        state = { tail: [], chunkSeq: 0, pointCount: 0, sessionBreaks: 0, lastPoint: null };
      }

      // Stamp the point with the aircraft's actual report time, not the server
      // poll time. This is the same value the live socket broadcasts
      // (position.lastReportMs), so the recorded trail stays in the same time
      // domain as the live marker and its tip can't drift ahead of the plane.
      // Fall back to `now` only if the report time is missing/invalid.
      const reportMs = flight.position.lastReportMs;
      const pointTime = (typeof reportMs === 'number' && reportMs > 0) ? reportMs : now;

      if (shouldSkipPoint(flight, state.lastPoint, pointTime)) {
        touchLastSeenStmt.run(now, flight.flightId);
        continue;
      }

      const point = {
        lat: flight.position.lat,
        lon: flight.position.lon,
        alt: flight.position.alt_ft,
        gs: flight.position.gs_kt,
        time: pointTime,
        hdg: flight.position.heading_deg
      };

      // Session boundaries are spotted as they happen — the same test the old
      // full-array walk applied, just against the one point that can create a
      // new boundary instead of re-walking everything recorded so far.
      if (state.lastPoint) {
        const isTimeGap = (point.time - state.lastPoint.time) > SESSION_GAP_MS;
        const isTeleport = getDistanceNM(state.lastPoint.lat, state.lastPoint.lon, point.lat, point.lon) > 50;
        if (isTimeGap || isTeleport) state.sessionBreaks++;
      }

      state.tail.push(point);
      state.pointCount++;
      state.lastPoint = point;

      if (state.tail.length >= CHUNK_POINTS) {
        insertChunkStmt.run(flight.flightId, state.chunkSeq++, state.tail.length, codec.encodeAll(state.tail));
        state.tail = [];
        enforceTrailLimits(flight.flightId, state);
      }

      const ac = flight.aircraft || {};
      upsertFlightStmt.run({
        userId: flight.userId,
        flightId: flight.flightId,
        callsign: flight.callsign,
        lastSeen: now,
        aircraftId: ac.aircraftId || null,
        liveryId: ac.liveryId || null,
        aircraftName: ac.aircraftName || null,
        liveryName: ac.liveryName || null,
        tail_blob: state.tail.length ? codec.encodeAll(state.tail) : null,
        last_point: packLastPoint(state.lastPoint),
        point_count: state.pointCount,
        session_breaks: state.sessionBreaks,
        chunk_seq: state.chunkSeq
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
  const row = db
    .prepare('SELECT path_json, tail_blob FROM flight_history WHERE flightId = ?')
    .get(flightId);
  if (!row) return [];
  const path = assemblePath(flightId, row);
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
    .prepare('SELECT userId, flightId, callsign, path_json, tail_blob, aircraftId, liveryId, aircraftName, liveryName FROM flight_history WHERE lastSeen >= ?')
    .all(sinceMs);

  // Pull every chunk for the whole window in one indexed pass and group it by
  // flight, rather than issuing a query per candidate. This runs over the full
  // replay window, so an N+1 here would be felt.
  const chunksByFlight = new Map();
  const chunkRows = db
    .prepare(`
      SELECT c.flightId, c.chunk
      FROM flight_path_chunks c
      JOIN flight_history f ON f.flightId = c.flightId
      WHERE f.lastSeen >= ?
      ORDER BY c.flightId, c.seq
    `)
    .all(sinceMs);

  for (const r of chunkRows) {
    let list = chunksByFlight.get(r.flightId);
    if (!list) chunksByFlight.set(r.flightId, (list = []));
    list.push(r.chunk);
  }

  return rows.map(r => {
    let pathPoints;
    if (r.path_json) {
      // Not yet migrated — the sweep will get to it.
      pathPoints = readPath(r.path_json);
    } else {
      pathPoints = [];
      for (const chunk of chunksByFlight.get(r.flightId) || []) {
        for (const p of codec.decodeBlob(chunk)) pathPoints.push(p);
      }
      if (r.tail_blob && r.tail_blob.length) {
        for (const p of codec.decodeBlob(r.tail_blob)) pathPoints.push(p);
      }
    }

    return {
      userId: r.userId,
      flightId: r.flightId,
      callsign: r.callsign,
      aircraft: {
        aircraftId: r.aircraftId || null,
        liveryId: r.liveryId || null,
        aircraftName: r.aircraftName || null,
        liveryName: r.liveryName || null
      },
      path: pathPoints
    };
  });
}

console.log(
  `[history] Retention: ${RETENTION_HOURS}h` +
  (MAX_DB_BYTES ? `, capped at ${Math.round(MAX_DB_BYTES / (1024 * 1024))} MB` : ', uncapped') +
  `, sealing every ${CHUNK_POINTS} points.`
);

// Startup: migrate legacy trails after 5s so it doesn't block boot. Each pass
// is bounded and re-arms itself while work remains. purgeOldData used to run on
// every batch, which meant a restart always swept immediately — keep that.
setTimeout(() => {
  try { purgeOldData(); } catch (e) { console.warn('[history] Startup purge failed:', e.message); }
  runDeepClean();
}, 5000);

// Periodic maintenance. purgeOldData no longer runs on every poll — it is a
// scan, and doing it sixty times a minute for a window measured in weeks was
// pure overhead. Once trails are migrated the hourly sweep finds nothing.
setInterval(purgeOldData, 60 * 60 * 1000);
setInterval(() => runDeepClean(), 6 * 60 * 60 * 1000);

// With synchronous=OFF and a steady write stream the WAL file (and the memory
// mapping behind it) keeps growing until a checkpoint reclaims it. Force a
// truncating checkpoint every 10 minutes to keep it bounded.
setInterval(() => {
  try { db.pragma('wal_checkpoint(TRUNCATE)'); }
  catch (e) { console.warn('[history] WAL checkpoint failed:', e.message); }
}, 10 * 60 * 1000);

module.exports = {
  updateBatch,
  getFlightPath,
  getFlightsForReplay,
  runDeepClean,
  claimFlightState,
  releaseFlightState,
  purgeOldData,
  // Exposed for path_codec.test.cjs, which asserts against the stored shape
  // (chunk rows, hot-tail size) and not just the decoded trail.
  _db: db
};
