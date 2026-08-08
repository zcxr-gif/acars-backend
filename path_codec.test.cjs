/**
 * path_codec.test.cjs — trail storage: fidelity, size, and write cost.
 *
 * Run with: npm test   (or: node path_codec.test.cjs)
 *
 * Two things are being defended here.
 *
 * Fidelity. The binary format replaced a JSON one that clients and the ATC
 * replay already depend on, so the bar is not "close enough" — a decoded trail
 * must equal, exactly, what the old packPoint()/readPath() pair produced for
 * the same input. Anything less shows up as trails that shift slightly every
 * time a flight is reloaded.
 *
 * Cost. The point of the exercise was retention, and retention is bought with
 * bytes per point and bytes written per poll. Both are asserted rather than
 * merely reported, so a future change that quietly gives the win back fails
 * here instead of on the volume six weeks later.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// history.cjs opens its database at require time, so it needs a scratch
// directory before it is pulled in.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'history-test-'));
process.env.DATA_DIR = TMP_DIR;
process.env.HISTORY_MAX_DB_MB = '0'; // size ceiling is exercised separately

const codec = require('./path_codec.cjs');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/* =========================
 * Reference quantisation — mirrors the old packPoint()
 * ========================= */
function legacyPack(p) {
  return [
    Math.round(p.lat * 10000) / 10000,
    Math.round(p.lon * 10000) / 10000,
    Math.round(p.alt),
    Math.round(p.gs),
    p.time,
    Math.round(p.hdg || 0)
  ];
}

function legacyJson(points) {
  return JSON.stringify(points.map(legacyPack));
}

function assertSameTrail(actual, expected, label) {
  assert.strictEqual(actual.length, expected.length, `${label}: point count`);
  for (let i = 0; i < expected.length; i++) {
    const e = legacyPack(expected[i]);
    const a = actual[i];
    assert.strictEqual(a.lat, e[0], `${label}: lat at ${i}`);
    assert.strictEqual(a.lon, e[1], `${label}: lon at ${i}`);
    assert.strictEqual(a.alt, e[2], `${label}: alt at ${i}`);
    assert.strictEqual(a.gs, e[3], `${label}: gs at ${i}`);
    assert.strictEqual(a.time, e[4], `${label}: time at ${i}`);
    assert.strictEqual(a.hdg, ((e[5] % 360) + 360) % 360, `${label}: hdg at ${i}`);
  }
}

/* =========================
 * A realistic trail
 * =========================
 * Sampled the way the recorder actually samples: every 15s below the cruise
 * threshold, every 120s above it. Roughly a seven-hour transatlantic.
 */
function syntheticFlight() {
  const points = [];
  let t = 1712345678901;
  let lat = 51.4706, lon = -0.4619, alt = 0, gs = 0, hdg = 271;

  const push = () => points.push({ lat, lon, alt, gs, time: t, hdg });

  // Taxi + climb to FL360, 15s samples.
  for (let i = 0; i < 140; i++) {
    alt = Math.min(36000, i * 260);
    gs = Math.min(480, i * 4);
    lat += 0.0009 + Math.sin(i / 9) * 0.0004;
    lon -= 0.0031 + Math.cos(i / 7) * 0.0006;
    hdg = (hdg + (i % 5 === 0 ? 2 : 0)) % 360;
    t += 15000;
    push();
  }
  // Cruise, throttled to 120s samples.
  for (let i = 0; i < 170; i++) {
    alt = 36000 + (i % 3) * 1000;
    gs = 470 + (i % 11);
    lat += 0.0072 + Math.sin(i / 13) * 0.0021;
    lon -= 0.0248 + Math.cos(i / 17) * 0.0033;
    hdg = (hdg + 360 - (i % 3)) % 360;
    t += 120000;
    push();
  }
  // Descent + rollout, back to 15s.
  for (let i = 0; i < 150; i++) {
    alt = Math.max(0, 36000 - i * 245);
    gs = Math.max(0, 460 - i * 3);
    lat += 0.0011 + Math.sin(i / 8) * 0.0005;
    lon -= 0.0029 + Math.cos(i / 6) * 0.0007;
    hdg = (hdg + (i % 4 === 0 ? 359 : 1)) % 360;
    t += 15000;
    push();
  }
  return points;
}

/* =========================
 * Codec
 * ========================= */

test('round-trips a single point', () => {
  const p = [{ lat: 51.4706, lon: -0.4619, alt: 82, gs: 12, time: 1712345678901, hdg: 271 }];
  assertSameTrail(codec.decodeBlob(codec.encodeAll(p)), p, 'single');
});

test('round-trips a full flight with the old format\'s precision, exactly', () => {
  const flight = syntheticFlight();
  assertSameTrail(codec.decodeBlob(codec.encodeAll(flight)), flight, 'flight');
});

test('handles southern and western hemispheres, and altitude below sea level', () => {
  const p = [
    { lat: -33.9461, lon: 151.1772, alt: -120, gs: 0, time: 1712345678901, hdg: 0 },
    { lat: -33.9502, lon: 151.1801, alt: -8, gs: 143, time: 1712345693901, hdg: 349 }
  ];
  assertSameTrail(codec.decodeBlob(codec.encodeAll(p)), p, 'hemispheres');
});

test('heading survives repeated wraps across north', () => {
  const p = [];
  let t = 1712345678901;
  // Walk all the way round twice, one degree at a time.
  for (let i = 0; i < 720; i++) {
    p.push({ lat: 10, lon: 10, alt: 30000, gs: 400, time: t, hdg: i % 360 });
    t += 15000;
  }
  assertSameTrail(codec.decodeBlob(codec.encodeAll(p)), p, 'wrap');
});

test('missing heading is treated as zero, as the old format did', () => {
  const p = [{ lat: 1.35, lon: 103.99, alt: 0, gs: 0, time: 1712345678901 }];
  const decoded = codec.decodeBlob(codec.encodeAll(p));
  assert.strictEqual(decoded[0].hdg, 0);
});

test('appending a chunk equals encoding the whole trail', () => {
  const flight = syntheticFlight();
  const a = flight.slice(0, 48);
  const b = flight.slice(48, 96);
  const c = flight.slice(96, 130);

  let blob = codec.appendChunk(null, a);
  blob = codec.appendChunk(blob, b);
  blob = codec.appendChunk(blob, c);

  assertSameTrail(codec.decodeBlob(blob), flight.slice(0, 130), 'appended');
});

test('appending nothing leaves the blob untouched', () => {
  const blob = codec.encodeAll(syntheticFlight().slice(0, 10));
  assert.strictEqual(codec.appendChunk(blob, []).length, blob.length);
  assert.strictEqual(codec.appendChunk(null, []).length, 0);
});

test('a truncated blob decodes to what survived instead of throwing', () => {
  const flight = syntheticFlight().slice(0, 100);
  const full = codec.appendChunk(codec.encodeAll(flight.slice(0, 48)), flight.slice(48));
  const torn = full.subarray(0, full.length - 7);

  const decoded = codec.decodeBlob(torn);
  assert.ok(decoded.length >= 48, `expected the sealed first chunk to survive, got ${decoded.length}`);
  assert.ok(decoded.length < flight.length, 'expected the torn tail to be dropped');
  assertSameTrail(decoded, flight.slice(0, decoded.length), 'torn');
});

test('empty and garbage input decode to an empty trail', () => {
  assert.deepStrictEqual(codec.decodeBlob(null), []);
  assert.deepStrictEqual(codec.decodeBlob(Buffer.alloc(0)), []);
  assert.deepStrictEqual(codec.decodeBlob(Buffer.from([0x00, 0x01, 0x02])), []);
});

test('costs under 11 bytes per point, at least 4x smaller than the JSON it replaced', () => {
  const flight = syntheticFlight();
  const jsonBytes = Buffer.byteLength(legacyJson(flight));

  // Encoded the way it is actually stored: sealed chunks plus a partial tail,
  // so the per-chunk absolute point is included in the measurement.
  let blob = Buffer.alloc(0);
  for (let i = 0; i < flight.length; i += 48) {
    blob = codec.appendChunk(blob, flight.slice(i, i + 48));
  }

  const perPoint = blob.length / flight.length;
  const ratio = jsonBytes / blob.length;

  console.log(
    `      ${flight.length} points — JSON ${jsonBytes}B (${(jsonBytes / flight.length).toFixed(1)}B/pt)` +
    ` vs binary ${blob.length}B (${perPoint.toFixed(1)}B/pt) — ${ratio.toFixed(1)}x smaller`
  );

  assert.ok(perPoint < 11, `expected under 11 bytes/point, got ${perPoint.toFixed(2)}`);
  assert.ok(ratio > 4, `expected at least 4x smaller, got ${ratio.toFixed(2)}x`);
});

/* =========================
 * Storage
 * ========================= */

const history = require('./history.cjs');

/**
 * A trail every point of which the recorder will actually keep.
 *
 * syntheticFlight() is deliberately shaped like a real one, which means it
 * contains cruise samples closer together than CRUISE_THROTTLE_MS — and the
 * recorder is supposed to drop those. It is the right input for measuring the
 * codec and the wrong input for asserting "everything I polled came back", so
 * the storage tests use this instead: below the cruise threshold, always
 * moving, always advancing in time.
 */
function recordableFlight(n) {
  const points = [];
  let t = 1712345678901;
  for (let i = 0; i < n; i++) {
    points.push({
      lat: 40 + i * 0.0012,
      lon: -70 + i * 0.0018,
      alt: 8000 + (i % 50) * 10,
      gs: 320 + (i % 7),
      time: t,
      hdg: (90 + i) % 360
    });
    t += 15000;
  }
  return points;
}

let flightSeq = 0;
const nextFlightId = () => `TEST-FLIGHT-${++flightSeq}`;

function poll(flightId, point) {
  history.updateBatch([{
    userId: 'user-1',
    flightId,
    callsign: 'TEST123',
    position: {
      lat: point.lat,
      lon: point.lon,
      alt_ft: point.alt,
      gs_kt: point.gs,
      heading_deg: point.hdg,
      lastReportMs: point.time
    },
    aircraft: { aircraftId: 'ac-1', liveryId: 'lv-1', aircraftName: 'A350-900', liveryName: 'British Airways' }
  }]);
}

test('a trail recorded one poll at a time reads back whole and in order', async () => {
  const id = nextFlightId();
  const flight = recordableFlight(200);
  for (const p of flight) poll(id, p);

  const stored = await history.getFlightPath(id);
  assertSameTrail(stored, flight, 'polled');
});

test('untilMs clamps the trail so its tip cannot lead the live marker', async () => {
  const id = nextFlightId();
  const flight = recordableFlight(120);
  for (const p of flight) poll(id, p);

  const cutoff = flight[70].time;
  const stored = await history.getFlightPath(id, cutoff);
  assert.strictEqual(stored.length, 71);
  assert.ok(stored.every(p => p.time <= cutoff));
});

test('the per-poll write stays small no matter how long the flight gets', () => {
  const id = nextFlightId();
  const flight = recordableFlight(600);
  const tailSize = () => {
    const row = history._db
      .prepare('SELECT length(tail_blob) AS n FROM flight_history WHERE flightId = ?')
      .get(id);
    return row && row.n ? row.n : 0;
  };

  let worst = 0;
  for (const p of flight) {
    poll(id, p);
    worst = Math.max(worst, tailSize());
  }

  // This is the whole argument for chunking: the old design rewrote the entire
  // trail on every poll, so this number would have grown to tens of kilobytes.
  const jsonWhole = Buffer.byteLength(legacyJson(flight));
  console.log(`      hot write per poll: ${worst}B at worst, vs ${jsonWhole}B to rewrite the trail as JSON`);
  assert.ok(worst < 700, `expected the hot tail under 700B, got ${worst}B`);
});

test('sealed chunks accumulate instead of being rewritten', () => {
  const id = nextFlightId();
  const flight = recordableFlight(150);
  for (const p of flight) poll(id, p);

  const chunks = history._db
    .prepare('SELECT seq, points FROM flight_path_chunks WHERE flightId = ? ORDER BY seq')
    .all(id);

  assert.strictEqual(chunks.length, 3, 'expected 150 points to seal three 48-point chunks');
  assert.deepStrictEqual(chunks.map(c => c.seq), [0, 1, 2]);
  assert.ok(chunks.every(c => c.points === 48));
});

test('stationary, stale and cruise-throttled reports are still skipped', async () => {
  const id = nextFlightId();
  const base = { lat: 51.47, lon: -0.46, alt: 0, gs: 0, time: 1712345678901, hdg: 90 };

  poll(id, base);                                                        // accepted (first)
  poll(id, { ...base, time: base.time + 15000 });                        // stationary
  poll(id, { ...base, time: base.time - 5000, gs: 200 });                // stale report
  poll(id, { ...base, time: base.time + 130000, alt: 35000, gs: 470 });  // accepted (past the throttle)
  poll(id, { ...base, time: base.time + 145000, alt: 35100, gs: 471 });  // cruise-throttled

  const stored = await history.getFlightPath(id);
  assert.strictEqual(stored.length, 2, `expected 2 recorded points, got ${stored.length}`);
});

test('an over-long trail is trimmed from the front, keeping the most recent flying', async () => {
  const id = nextFlightId();
  // 1600 accepted points — past MAX_POINTS_PER_FLIGHT (1500).
  let t = 1712345678901;
  const flight = [];
  for (let i = 0; i < 1600; i++) {
    flight.push({ lat: 40 + i * 0.001, lon: -70 + i * 0.001, alt: 5000, gs: 300, time: t, hdg: 90 });
    t += 15000;
  }
  for (const p of flight) poll(id, p);

  const stored = await history.getFlightPath(id);
  // Trimming works at chunk granularity and only drops a chunk when the trail
  // stays above the limit without it, so the kept length settles between
  // MAX_POINTS_PER_FLIGHT and that plus a chunk's worth of slack.
  assert.ok(stored.length < 1600, `expected trimming below the 1600 polled, got ${stored.length}`);
  assert.ok(stored.length >= 1500, `expected at least MAX_POINTS_PER_FLIGHT kept, got ${stored.length}`);
  // The front is what gets dropped — the newest point must survive.
  assert.strictEqual(stored[stored.length - 1].time, flight[flight.length - 1].time);
});

test('a legacy path_json row is migrated on its next poll without losing points', async () => {
  const id = nextFlightId();
  const flight = recordableFlight(80);

  // Write the row exactly as the previous build would have.
  history._db
    .prepare('INSERT INTO flight_history (userId, flightId, callsign, lastSeen, path_json) VALUES (?, ?, ?, ?, ?)')
    .run('user-legacy', id, 'OLD123', Date.now(), legacyJson(flight));

  // Reading it must work before any migration has happened.
  assertSameTrail(await history.getFlightPath(id), flight, 'pre-migration');

  const last = flight[flight.length - 1];
  const next = { lat: last.lat + 0.0012, lon: last.lon + 0.0018, alt: 8100, gs: 322, time: last.time + 15000, hdg: 91 };
  poll(id, next);

  const row = history._db.prepare('SELECT path_json FROM flight_history WHERE flightId = ?').get(id);
  assert.strictEqual(row.path_json, null, 'expected path_json to be cleared after migration');
  assertSameTrail(await history.getFlightPath(id), [...flight, next], 'post-migration');
});

test('the background sweep migrates legacy rows it finds', async () => {
  const id = nextFlightId();
  const flight = recordableFlight(60);
  history._db
    .prepare('INSERT INTO flight_history (userId, flightId, callsign, lastSeen, path_json) VALUES (?, ?, ?, ?, ?)')
    .run('user-legacy', id, 'OLD456', Date.now(), legacyJson(flight));

  assert.ok(history.runDeepClean() >= 1, 'expected the sweep to migrate at least one row');

  const row = history._db.prepare('SELECT path_json FROM flight_history WHERE flightId = ?').get(id);
  assert.strictEqual(row.path_json, null);
  assertSameTrail(await history.getFlightPath(id), flight, 'swept');
});

test('replay assembly returns the same trails as individual lookups', async () => {
  const ids = [nextFlightId(), nextFlightId()];
  const flight = recordableFlight(130);
  for (const id of ids) for (const p of flight) poll(id, p);

  const replay = history.getFlightsForReplay(0);
  for (const id of ids) {
    const entry = replay.find(r => r.flightId === id);
    assert.ok(entry, `expected ${id} in the replay set`);
    assertSameTrail(entry.path, flight, `replay ${id}`);
    assert.strictEqual(entry.aircraft.aircraftName, 'A350-900');
  }
});

test('purging a flight takes its chunks with it', () => {
  const id = nextFlightId();
  for (const p of recordableFlight(100)) poll(id, p);

  assert.ok(
    history._db.prepare('SELECT COUNT(*) AS n FROM flight_path_chunks WHERE flightId = ?').get(id).n > 0
  );

  // Age the row out past the retention window.
  history._db
    .prepare('UPDATE flight_history SET lastSeen = ? WHERE flightId = ?')
    .run(1, id);
  history.purgeOldData();

  assert.strictEqual(
    history._db.prepare('SELECT COUNT(*) AS n FROM flight_path_chunks WHERE flightId = ?').get(id).n,
    0,
    'orphaned chunks left behind after purge'
  );
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
