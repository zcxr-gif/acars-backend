/* =========================
 * Archivist — completed flights become permanent replays
 * =========================
 *
 * The tracker has had a replay archive for a long time: S3 storage behind
 * POST /api/trails on the indgo backend, a "Browse Replays" slide-over
 * (replayBrowser.js), and a "stored replays" section on both profile screens.
 * Every piece of it was built except the one that puts flights in — nothing has
 * ever called that POST. The archive reads empty because nothing fills it.
 *
 * This is the producer. Once a flight is over, its trail is promoted out of the
 * rolling flight_history window and into the archive, where it stops being
 * subject to retention at all. A pilot ends up with a permanent, replayable
 * record of everything they have flown, without doing anything to get it.
 *
 * That is worth stating plainly, because it is the part Infinite Flight itself
 * does not give you: the official logbook records that a flight happened —
 * origin, destination, times — but not the path. This keeps the path.
 *
 * How a flight is judged finished
 * -------------------------------
 * Infinite Flight drops an aircraft from the live feed the moment the pilot
 * ends the flight, so "finished" is simply "we have not seen it for a while".
 * That is read from flight_history.lastSeen rather than tracked in memory,
 * which means a restart mid-sweep loses nothing and there is no state to keep
 * in sync with the poll loop.
 *
 * Exactly once
 * ------------
 * Archiving goes through the same claimFlightState ledger that stops VA
 * takeoff/landing events being announced twice. A claim is taken before the
 * upload and released if the upload fails, so a flight is never archived twice
 * and never silently dropped because of one bad request.
 *
 * The candidate window (ARCHIVE_MAX_AGE_MS) is deliberately kept shorter than
 * the ledger's own 48-hour purge. If it ever grew past it, a flight could fall
 * out of the ledger while still being a candidate and be archived a second
 * time — so the two are asserted against each other at startup rather than
 * left as a comment nobody reads.
 */

'use strict';

const history = require('./history.cjs');

const intEnv = (name, dflt) => {
  const parsed = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : dflt;
};

const ARCHIVE_BACKEND_URL = (process.env.ARCHIVE_BACKEND_URL || process.env.VA_BACKEND_URL ||
  'https://site--indgo-backend--6dmjph8ltlhv.code.run').replace(/\/+$/, '');

// How long a flight must be absent from the live feed before it counts as over.
// Long enough to ride out a dropped poll or a brief API gap, short enough that
// a pilot finds the replay waiting for them.
const GRACE_MS = intEnv('ARCHIVE_GRACE_MINUTES', 15) * 60 * 1000;

// How far back a sweep will look for things it has not archived yet. Must stay
// under the claim ledger's 48h purge — see the note above.
const MAX_AGE_MS = intEnv('ARCHIVE_MAX_AGE_HOURS', 24) * 60 * 60 * 1000;
const LEDGER_RETENTION_MS = 48 * 60 * 60 * 1000;

const SWEEP_MS = intEnv('ARCHIVE_SWEEP_MINUTES', 5) * 60 * 1000;
const BATCH = intEnv('ARCHIVE_BATCH', 25);

// Quality gate. A trail with a handful of points is someone loading in, moving
// a few metres and quitting — archiving those forever fills the bucket with
// things nobody wants to replay.
const MIN_POINTS = intEnv('ARCHIVE_MIN_POINTS', 20);
const MIN_DISTANCE_NM = intEnv('ARCHIVE_MIN_DISTANCE_NM', 10);

const ENABLED = !['0', 'false', 'no', 'off'].includes(
  String(process.env.ARCHIVE_ENABLED ?? '').trim().toLowerCase()
);

if (MAX_AGE_MS >= LEDGER_RETENTION_MS) {
  console.warn(
    `[archivist] ⚠️ ARCHIVE_MAX_AGE_HOURS (${MAX_AGE_MS / 3600000}h) is not shorter than the ` +
    `claim ledger's 48h retention. Flights could be archived twice. Clamping to 24h.`
  );
}
const EFFECTIVE_MAX_AGE_MS = Math.min(MAX_AGE_MS, LEDGER_RETENTION_MS / 2);

const R_NM = 3440.065;
function distanceNM(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R_NM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Is this trail worth keeping forever?
 *
 * Distance is measured along the path rather than end to end, so a circuit that
 * lands back where it started still counts as flying.
 */
function isWorthArchiving(path) {
  if (!Array.isArray(path) || path.length < MIN_POINTS) return false;

  let flown = 0;
  for (let i = 1; i < path.length; i++) {
    flown += distanceNM(path[i - 1].lat, path[i - 1].lon, path[i].lat, path[i].lon);
    if (flown >= MIN_DISTANCE_NM) return true;
  }
  return false;
}

/**
 * Finds flights that have gone quiet and have not been archived yet.
 *
 * Ordered oldest first so a backlog drains in the order it built up, and
 * bounded so one sweep can never take an unbounded slice of the table.
 */
function findCandidates(now = Date.now()) {
  return history._db
    .prepare(`
      SELECT flightId, userId, callsign, aircraftName, liveryName, lastSeen
      FROM flight_history
      WHERE lastSeen < ? AND lastSeen >= ?
      ORDER BY lastSeen ASC
      LIMIT ?
    `)
    .all(now - GRACE_MS, now - EFFECTIVE_MAX_AGE_MS, BATCH);
}

const UPLOAD_TIMEOUT_MS = intEnv('ARCHIVE_UPLOAD_TIMEOUT_MS', 30000);

async function uploadTrail(row, path) {
  const res = await fetch(`${ARCHIVE_BACKEND_URL}/api/trails`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // A hung request would otherwise hold the sweep open indefinitely, and with
    // it the trail it is carrying. Timing out releases the claim and retries on
    // the next pass, which is what should happen anyway.
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    body: JSON.stringify({
      userId: row.userId,
      flightId: row.flightId,
      // The stored file stays a bare array of points, which is what
      // replayBrowser.js feeds straight into the replay engine. Anything richer
      // would have to go beside the file, not inside it.
      trail: path
    })
  });

  if (!res.ok) {
    throw new Error(`archive upload failed: ${res.status} ${res.statusText}`);
  }
}

/**
 * One pass. Returns a small summary so the caller (and the tests) can see what
 * happened without reading the logs.
 */
// A sweep uploads serially, so a slow or timing-out archive can take longer
// than the interval between sweeps. Without this the timer would stack passes
// on top of each other, each re-reading the same candidates and holding another
// trail in memory while it waited.
let sweeping = false;

async function sweepOnce(now = Date.now()) {
  const result = { considered: 0, archived: 0, skipped: 0, failed: 0, busy: false };
  if (!ENABLED) return result;
  if (sweeping) {
    result.busy = true;
    return result;
  }
  sweeping = true;
  try {
    return await runSweep(now, result);
  } finally {
    sweeping = false;
  }
}

async function runSweep(now, result) {

  let candidates;
  try {
    candidates = findCandidates(now);
  } catch (e) {
    console.warn('[archivist] Could not read candidates:', e.message);
    return result;
  }

  for (const row of candidates) {
    result.considered++;

    // Claim first so two overlapping sweeps cannot both upload the same flight.
    if (!history.claimFlightState(row.flightId, 'archived')) continue;

    try {
      const path = await history.getFlightPath(row.flightId);

      if (!isWorthArchiving(path)) {
        // Keep the claim. This flight will never be worth archiving, and
        // releasing it would only mean re-deciding that every five minutes.
        result.skipped++;
        continue;
      }

      await uploadTrail(row, path);
      result.archived++;
    } catch (e) {
      // Release so the next sweep tries again — a failed upload must not cost
      // the pilot their replay.
      history.releaseFlightState(row.flightId, 'archived');
      result.failed++;
      console.warn(`[archivist] ${row.flightId} could not be archived:`, e.message);
    }
  }

  if (result.archived || result.failed) {
    console.log(
      `[archivist] Swept ${result.considered}: archived ${result.archived}, ` +
      `skipped ${result.skipped}, failed ${result.failed}.`
    );
  }
  return result;
}

let timer = null;

/** Begins sweeping. Safe to call twice; the second call is ignored. */
function start() {
  if (!ENABLED) {
    console.log('[archivist] Disabled by ARCHIVE_ENABLED.');
    return;
  }
  if (timer) return;

  console.log(
    `[archivist] Archiving finished flights to ${ARCHIVE_BACKEND_URL} — ` +
    `${GRACE_MS / 60000}min grace, sweeping every ${SWEEP_MS / 60000}min.`
  );

  const tick = () => {
    sweepOnce().catch(e => console.warn('[archivist] Sweep failed:', e.message));
  };

  // First pass shortly after boot, then on the interval.
  setTimeout(tick, 60 * 1000);
  timer = setInterval(tick, SWEEP_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = {
  start,
  stop,
  sweepOnce,
  // Exported for tests.
  isWorthArchiving,
  findCandidates
};
