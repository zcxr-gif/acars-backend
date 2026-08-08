/**
 * archivist.test.cjs — completed flights become permanent replays.
 *
 * Run with: npm test   (or: node archivist.test.cjs)
 *
 * The archivist is the piece that was missing: the replay archive, its browse
 * UI and both profile screens all existed, but nothing ever put a flight in.
 * What matters here is that it puts each flight in exactly once, that it leaves
 * a flight alone until it is genuinely over, and that a failed upload costs the
 * pilot nothing — a dropped replay is invisible until someone goes looking for
 * it months later, so the retry path is tested rather than assumed.
 *
 * The upload itself is stubbed. This asserts the archivist's decisions, not
 * that S3 works.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-test-'));
process.env.DATA_DIR = TMP_DIR;
process.env.HISTORY_MAX_DB_MB = '0';
process.env.ARCHIVE_GRACE_MINUTES = '15';
process.env.ARCHIVE_MIN_POINTS = '20';
process.env.ARCHIVE_MIN_DISTANCE_NM = '10';

const history = require('./history.cjs');
const archivist = require('./archivist.cjs');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const MINUTE = 60 * 1000;

/* =========================
 * Fixtures
 * ========================= */

let seq = 0;
const nextFlightId = () => `ARCH-${++seq}`;

/** A trail that clears the quality gate: 60 points over roughly 30nm. */
function realFlight(startMs) {
  const points = [];
  for (let i = 0; i < 60; i++) {
    points.push({
      lat: 40 + i * 0.009,
      lon: -70,
      alt: 9000,
      gs: 300,
      time: startMs + i * 15000,
      hdg: 0
    });
  }
  return points;
}

/** Records a flight into flight_history, then backdates it to look finished. */
function recordFlight(flightId, points, lastSeen) {
  for (const p of points) {
    history.updateBatch([{
      userId: 'pilot-1',
      flightId,
      callsign: 'BAW123',
      position: {
        lat: p.lat, lon: p.lon, alt_ft: p.alt, gs_kt: p.gs,
        heading_deg: p.hdg, lastReportMs: p.time
      },
      aircraft: { aircraftId: 'a', liveryId: 'l', aircraftName: 'A350-900', liveryName: 'British Airways' }
    }]);
  }
  if (lastSeen != null) {
    history._db.prepare('UPDATE flight_history SET lastSeen = ? WHERE flightId = ?').run(lastSeen, flightId);
  }
}

/** Swaps global fetch for a recorder. Returns the captured calls. */
function stubUpload({ fail = false } = {}) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    if (fail) return { ok: false, status: 503, statusText: 'Service Unavailable' };
    return { ok: true, status: 200, statusText: 'OK' };
  };
  calls.restore = () => { global.fetch = original; };
  return calls;
}

/* =========================
 * The quality gate
 * ========================= */

test('a real flight is worth archiving', () => {
  assert.strictEqual(archivist.isWorthArchiving(realFlight(Date.now())), true);
});

test('a trail with too few points is not', () => {
  assert.strictEqual(archivist.isWorthArchiving(realFlight(Date.now()).slice(0, 5)), false);
});

test('taxiing a short distance for a long time is not', () => {
  // 60 points, but barely moving — the shape of someone loading in and quitting.
  const points = [];
  for (let i = 0; i < 60; i++) {
    points.push({ lat: 40 + i * 0.00002, lon: -70, alt: 0, gs: 8, time: Date.now() + i * 15000, hdg: 0 });
  }
  assert.strictEqual(archivist.isWorthArchiving(points), false);
});

test('a circuit that lands where it started still counts', () => {
  // Distance is measured along the path, so a loop is not zero.
  const points = [];
  for (let i = 0; i < 60; i++) {
    const angle = (i / 60) * 2 * Math.PI;
    points.push({
      lat: 40 + Math.sin(angle) * 0.15,
      lon: -70 + Math.cos(angle) * 0.15,
      alt: 3000, gs: 180, time: Date.now() + i * 15000, hdg: 0
    });
  }
  assert.strictEqual(archivist.isWorthArchiving(points), true);
});

test('empty and malformed trails are rejected rather than thrown on', () => {
  assert.strictEqual(archivist.isWorthArchiving([]), false);
  assert.strictEqual(archivist.isWorthArchiving(null), false);
});

/* =========================
 * Choosing candidates
 * ========================= */

test('a flight still being tracked is left alone', () => {
  const id = nextFlightId();
  const now = Date.now();
  recordFlight(id, realFlight(now - 60 * MINUTE), now - 2 * MINUTE); // seen 2 min ago

  const ids = archivist.findCandidates(now).map(r => r.flightId);
  assert.ok(!ids.includes(id), 'a flight seen two minutes ago is not finished');
});

test('a flight gone quiet past the grace period becomes a candidate', () => {
  const id = nextFlightId();
  const now = Date.now();
  recordFlight(id, realFlight(now - 90 * MINUTE), now - 30 * MINUTE);

  const ids = archivist.findCandidates(now).map(r => r.flightId);
  assert.ok(ids.includes(id), 'a flight unseen for 30 minutes should be a candidate');
});

test('a flight older than the candidate window is not revisited', () => {
  const id = nextFlightId();
  const now = Date.now();
  recordFlight(id, realFlight(now - 40 * 60 * MINUTE), now - 30 * 60 * MINUTE); // 30h ago

  const ids = archivist.findCandidates(now).map(r => r.flightId);
  assert.ok(!ids.includes(id), 'past the window it must not come back as new work');
});

/* =========================
 * Sweeping
 * ========================= */

test('a finished flight is uploaded, once, with its trail', async () => {
  const id = nextFlightId();
  const now = Date.now();
  recordFlight(id, realFlight(now - 90 * MINUTE), now - 30 * MINUTE);

  const calls = stubUpload();
  try {
    // Fixtures from earlier tests are legitimately finished too, so this
    // asserts on this flight rather than on the size of the sweep.
    const first = await archivist.sweepOnce(now);
    assert.ok(first.archived >= 1, 'expected at least this flight archived');

    const call = calls.find(c => c.body.flightId === id);
    assert.ok(call, 'expected an upload for this flight');
    assert.ok(call.url.endsWith('/api/trails'));
    assert.strictEqual(call.body.userId, 'pilot-1');
    assert.ok(Array.isArray(call.body.trail), 'the stored file must stay a bare array');
    assert.strictEqual(call.body.trail.length, 60);
    assert.strictEqual(call.body.trail[0].lat, 40);

    // A second sweep must not send this flight again.
    await archivist.sweepOnce(now);
    const uploadsForThisFlight = calls.filter(c => c.body.flightId === id).length;
    assert.strictEqual(uploadsForThisFlight, 1, 'the same flight was uploaded twice');
  } finally {
    calls.restore();
  }
});

test('a flight that fails the quality gate is never uploaded', async () => {
  const id = nextFlightId();
  const now = Date.now();
  recordFlight(id, realFlight(now - 90 * MINUTE).slice(0, 8), now - 30 * MINUTE);

  const calls = stubUpload();
  try {
    const result = await archivist.sweepOnce(now);
    assert.ok(result.skipped >= 1, 'expected the short trail to be skipped');
    assert.ok(!calls.some(c => c.body.flightId === id), 'a junk trail was uploaded');
  } finally {
    calls.restore();
  }
});

test('a failed upload is retried on the next sweep', async () => {
  const id = nextFlightId();
  const now = Date.now();
  recordFlight(id, realFlight(now - 90 * MINUTE), now - 30 * MINUTE);

  const failing = stubUpload({ fail: true });
  try {
    const result = await archivist.sweepOnce(now);
    assert.strictEqual(result.failed, 1, 'expected the upload to be recorded as failed');
    assert.ok(failing.some(c => c.body.flightId === id));
  } finally {
    failing.restore();
  }

  // The claim must have been released, so the flight comes back around.
  const succeeding = stubUpload();
  try {
    const result = await archivist.sweepOnce(now);
    assert.strictEqual(result.archived, 1, 'a failed upload must be retried, not lost');
    assert.ok(succeeding.some(c => c.body.flightId === id));
  } finally {
    succeeding.restore();
  }
});

test('claims survive a release and re-claim cycle cleanly', () => {
  const id = nextFlightId();
  assert.strictEqual(history.claimFlightState(id, 'archived'), true, 'first claim should win');
  assert.strictEqual(history.claimFlightState(id, 'archived'), false, 'second claim should lose');
  assert.strictEqual(history.releaseFlightState(id, 'archived'), true, 'release should remove it');
  assert.strictEqual(history.claimFlightState(id, 'archived'), true, 'claimable again after release');
});

test('a sweep with nothing to do is silent and cheap', async () => {
  const calls = stubUpload();
  try {
    // Far enough in the past that every fixture is outside the window.
    const result = await archivist.sweepOnce(Date.now() - 40 * 60 * MINUTE);
    assert.strictEqual(result.archived, 0);
    assert.strictEqual(calls.length, 0);
  } finally {
    calls.restore();
  }
});

/* =========================
 * Runner
 * ========================= */
(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (e) {
      failed++;
      console.error(`  ✗ ${name}\n    ${e.message}`);
    }
  }
  console.log(failed === 0 ? `\n${tests.length} passing` : `\n${failed} of ${tests.length} failing`);

  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(failed === 0 ? 0 : 1);
})();
