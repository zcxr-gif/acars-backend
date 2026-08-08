/**
 * global_playback.test.cjs — the tiered playback window.
 *
 * Run with: npm test   (or: node global_playback.test.cjs)
 *
 * Three things are defended here, in descending order of what it costs to get
 * them wrong.
 *
 * The tier line. "Pro gets 14 days, everyone else gets a day" is the paid
 * boundary, so it is asserted directly: a free window that reaches past 24
 * hours must come back 403 and not merely clamped, because a clamp would hand
 * the free tier a silently-shortened Pro window and nobody would ever notice
 * it was broken.
 *
 * The budget. A peak-hour window over a fortnight's retention is the case that
 * used to OOM this process, so sampling must stay inside its point budget, and
 * a window that cannot fit must come back marked `truncated` rather than
 * enormous.
 *
 * The sampling grid. A replay is judged entirely on whether aircraft appear
 * when they should and move smoothly, which is the first and last in-window
 * sample plus a regular step between them.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// history.cjs opens its database at require time, so it needs a scratch
// directory before global_playback.cjs pulls it in.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'playback-test-'));
process.env.DATA_DIR = TMP_DIR;
process.env.HISTORY_MAX_DB_MB = '0';

const history = require('./history.cjs');
const playback = require('./global_playback.cjs');
const { sampleTrail, stepForWindow, insideBbox, MAX_SPAN_MS, MIN_STEP_MS, POINT_BUDGET } = playback._internals;

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/* =========================
 * Fixtures
 * ========================= */

let flightSeq = 0;
const nextFlightId = () => `PB-FLIGHT-${++flightSeq}`;

// A straight, evenly-sampled leg. `startMs` anchors it in wall-clock time so a
// test can place a flight inside or outside a window on purpose.
function leg(startMs, count, { lat = 40, lon = -70, sampleMs = 15000 } = {}) {
  const points = [];
  for (let i = 0; i < count; i++) {
    points.push({
      lat: lat + i * 0.01,
      lon: lon + i * 0.015,
      alt: 30000 + (i % 20) * 100,
      gs: 450 + (i % 5),
      hdg: (45 + i) % 360,
      time: startMs + i * sampleMs
    });
  }
  return points;
}

// Record a leg the way the poller does, one point at a time.
function record(flightId, points, { sessionId = 'server-expert', username = 'PilotOne', callsign = 'BAW117' } = {}) {
  for (const p of points) {
    history.updateBatch([{
      userId: `user-${flightId}`,
      flightId,
      callsign,
      username,
      position: {
        lat: p.lat, lon: p.lon, alt_ft: p.alt, gs_kt: p.gs,
        heading_deg: p.hdg, lastReportMs: p.time
      },
      aircraft: { aircraftId: 'ac-1', liveryId: 'lv-1', aircraftName: 'A350-900', liveryName: 'British Airways' }
    }], sessionId);
  }
  return flightId;
}

/* =========================
 * Tier limits
 * ========================= */

test('a free window may reach back a day; a Pro window may reach back a fortnight', () => {
  const now = Date.now();
  const free = playback.limitsFor(false, now);
  const pro = playback.limitsFor(true, now);

  assert.strictEqual(free.tier, 'free');
  assert.strictEqual(pro.tier, 'pro');
  assert.strictEqual(free.lookbackMs, DAY);
  assert.strictEqual(pro.lookbackMs, 14 * DAY);
  assert.strictEqual(free.earliest, now - DAY);
  assert.strictEqual(pro.earliest, now - 14 * DAY);
});

test('a free request past 24 hours is refused, not quietly clamped', () => {
  const now = Date.now();
  const res = playback.resolveWindow({ startMs: now - 3 * DAY, endMs: now - 3 * DAY + HOUR, isPro: false, now });

  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.status, 403, 'over-reaching past the tier must be 403, not 400');
  assert.match(res.message, /Pro/, 'the refusal should name the thing that lifts it');
  assert.strictEqual(res.limits.tier, 'free');
});

test('the same window is served for a Pro account', () => {
  const now = Date.now();
  const res = playback.resolveWindow({ startMs: now - 3 * DAY, endMs: now - 3 * DAY + HOUR, isPro: true, now });

  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.end - res.start, HOUR);
  assert.strictEqual(res.limits.tier, 'pro');
});

test('a Pro request past the retention ceiling is still refused', () => {
  const now = Date.now();
  const res = playback.resolveWindow({ startMs: now - 30 * DAY, endMs: now - 30 * DAY + HOUR, isPro: true, now });

  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.status, 403);
});

test('an over-long span is trimmed from the far end, keeping the chosen start', () => {
  const now = Date.now();
  const start = now - 20 * HOUR;
  const res = playback.resolveWindow({ startMs: start, endMs: start + 48 * HOUR, isPro: false, now });

  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.start, start, 'the moment the user picked must survive');
  assert.ok(res.end - res.start <= MAX_SPAN_MS, 'span exceeded the per-request cap');
});

test('an omitted end asks for a full span from the start', () => {
  const now = Date.now();
  const start = now - 20 * HOUR;
  const res = playback.resolveWindow({ startMs: start, endMs: NaN, isPro: false, now });

  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.end - res.start, MAX_SPAN_MS);
});

test('a window running into the future is clamped to now rather than refused', () => {
  const now = Date.now();
  const res = playback.resolveWindow({ startMs: now - HOUR, endMs: now + 5 * HOUR, isPro: false, now });

  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.end, now);
});

test('a malformed window is a 400, and is distinguishable from a tier refusal', () => {
  const now = Date.now();
  assert.strictEqual(playback.resolveWindow({ startMs: NaN, isPro: true, now }).status, 400);
  assert.strictEqual(playback.resolveWindow({ startMs: now - HOUR, endMs: now - 2 * HOUR, isPro: true, now }).status, 400);
  assert.strictEqual(playback.resolveWindow({ startMs: now - HOUR, endMs: now - HOUR + 5000, isPro: true, now }).status, 400);
});

/* =========================
 * Sampling
 * ========================= */

test('sampling keeps the first and last in-window points', () => {
  const start = 1712345678000;
  const points = leg(start, 240);                     // one hour at 15s
  const end = start + HOUR;

  const sampled = sampleTrail(points, start, end, 60000, null);

  assert.strictEqual(sampled[0].time, points[0].time, 'the entry point was dropped');
  const lastInWindow = points.filter(p => p.time <= end).pop();
  assert.strictEqual(sampled[sampled.length - 1].time, lastInWindow.time, 'the exit point was dropped');
});

test('sampling thins to roughly one point per step', () => {
  const start = 1712345678000;
  const sampled = sampleTrail(leg(start, 240), start, start + HOUR, 60000, null);

  // 60 minutes at one per minute, ± the retained endpoint.
  assert.ok(sampled.length >= 58 && sampled.length <= 62, `expected ~60 samples, got ${sampled.length}`);
  for (let i = 1; i < sampled.length - 1; i++) {
    assert.ok(sampled[i].time - sampled[i - 1].time >= 60000, `samples ${i - 1}→${i} are closer than the step`);
  }
});

test('a gap in the recording does not produce a burst of points when it resumes', () => {
  const start = 1712345678000;
  // Ten minutes of samples, twenty minutes of silence, then ten more.
  const points = [...leg(start, 40), ...leg(start + 30 * 60000, 40)];
  const sampled = sampleTrail(points, start, start + HOUR, 60000, null);

  // The retained exit point is allowed to sit closer than a step, by design —
  // everything before it must be on the grid.
  for (let i = 1; i < sampled.length - 1; i++) {
    assert.ok(
      sampled[i].time - sampled[i - 1].time >= 60000,
      'the grid fell behind the recording and emitted consecutive raw points'
    );
  }
});

test('points outside the window are excluded from both ends', () => {
  const start = 1712345678000;
  const points = leg(start - HOUR, 480);              // two hours, starting an hour early
  const sampled = sampleTrail(points, start, start + 30 * 60000, 60000, null);

  assert.ok(sampled.every(p => p.time >= start && p.time <= start + 30 * 60000), 'a point outside the window survived');
});

test('the step grows with traffic so a busy window stays inside the budget', () => {
  const quiet = stepForWindow(HOUR, 10);
  const busy = stepForWindow(HOUR, 2500);

  assert.ok(busy > quiet, 'a busier window must be sampled more coarsely');
  assert.ok(quiet >= MIN_STEP_MS, 'never finer than the recorder actually samples');
  assert.strictEqual(quiet % MIN_STEP_MS, 0, 'the step should land on a whole number of recorder samples');

  // The estimate the step is derived from must actually hold.
  const projected = 2500 * Math.ceil(HOUR / busy);
  assert.ok(projected <= POINT_BUDGET * 1.05, `projected ${projected} points against a ${POINT_BUDGET} budget`);
});

/* =========================
 * Geography
 * ========================= */

test('a bounding box that crosses the antimeridian keeps the Pacific, not the rest of the world', () => {
  const box = playback.parseBbox('170,-40,-160,40');   // Fiji-ish, wrapping 180°
  assert.ok(box.wraps);

  assert.ok(insideBbox(-18, 178, box), 'a point just west of the dateline should be inside');
  assert.ok(insideBbox(-18, -170, box), 'a point just east of the dateline should be inside');
  assert.ok(!insideBbox(-18, 0, box), 'Greenwich is not in the South Pacific');
  assert.ok(!insideBbox(60, 178, box), 'latitude still bounds the box');
});

test('a malformed bbox is rejected rather than silently ignored', () => {
  assert.strictEqual(playback.parseBbox('1,2,3'), null);
  assert.strictEqual(playback.parseBbox('a,b,c,d'), null);
  assert.strictEqual(playback.parseBbox('0,50,10,10'), null, 'south above north');
  assert.strictEqual(playback.parseBbox('0,-100,10,10'), null, 'latitude off the planet');
});

/* =========================
 * Whole windows, against real recorded trails
 * ========================= */

// `firstSeen` is stamped when a row is written, not when the flight flew, and
// the replay query bounds the window at both ends. So every test below closes
// its window *after* recording its fixtures — a window closed beforehand
// excludes the very flights it was set up to find, and would pass for the
// wrong reason.
const closeWindow = () => Date.now();

test('a recorded flight comes back inside its window and carries its metadata', () => {
  const start = Date.now() - 2 * HOUR;
  const id = record(nextFlightId(), leg(start, 200));

  const out = playback.buildWindow({ start, end: closeWindow() });
  const found = out.flights.find(f => f.flightId === id);

  assert.ok(found, 'the recorded flight was not in its own window');
  assert.strictEqual(found.callsign, 'BAW117');
  assert.strictEqual(found.username, 'PilotOne', 'the pilot name should be recorded, not looked up live');
  assert.strictEqual(found.aircraft.aircraftName, 'A350-900');
  assert.ok(found.path.length >= 2);
});

test('points are packed as [dt, lat, lon, alt, gs, hdg] with dt in seconds from the window start', () => {
  const start = Date.now() - 2 * HOUR;
  const id = record(nextFlightId(), leg(start + 60000, 100));

  const out = playback.buildWindow({ start, end: closeWindow() });
  const found = out.flights.find(f => f.flightId === id);

  const [dt, lat, lon, alt, gs, hdg] = found.path[0];
  assert.strictEqual(found.path[0].length, 6);
  assert.ok(dt >= 55 && dt <= 65, `expected the first sample ~60s in, got ${dt}`);
  assert.ok(dt >= 0, 'dt must be relative to the window start, not an epoch');
  assert.ok(Math.abs(lat - 40) < 1 && Math.abs(lon + 70) < 1);
  assert.ok(Number.isInteger(alt) && Number.isInteger(gs) && Number.isInteger(hdg));
});

test('a flight scoped to another server is left out', () => {
  const start = Date.now() - 2 * HOUR;
  const expert = record(nextFlightId(), leg(start, 120), { sessionId: 'server-expert' });
  const casual = record(nextFlightId(), leg(start, 120), { sessionId: 'server-casual' });

  const out = playback.buildWindow({ start, end: closeWindow(), sessionId: 'server-expert' });
  const ids = out.flights.map(f => f.flightId);

  assert.ok(ids.includes(expert));
  assert.ok(!ids.includes(casual), 'Casual traffic leaked into an Expert replay');
  assert.ok(out.skippedOtherServers >= 1);
});

test('a bounding box keeps only the flights that were inside it', () => {
  const start = Date.now() - 2 * HOUR;
  const inBox = record(nextFlightId(), leg(start, 100, { lat: 40, lon: -70 }));
  const outOfBox = record(nextFlightId(), leg(start, 100, { lat: -30, lon: 140 }));

  const out = playback.buildWindow({
    start, end: closeWindow(),
    bbox: playback.parseBbox('-80,35,-50,50')
  });
  const ids = out.flights.map(f => f.flightId);

  assert.ok(ids.includes(inBox));
  assert.ok(!ids.includes(outOfBox), 'a flight on the other side of the planet was returned');
});

test('a window that predates every recording comes back empty rather than erroring', () => {
  const out = playback.buildWindow({ start: 1000, end: 2000 * 60 });
  assert.strictEqual(out.flightCount, 0);
  assert.deepStrictEqual(out.flights, []);
});

test('the response stays inside the point budget and says so when it had to stop', () => {
  const start = Date.now() - 2 * HOUR;
  for (let i = 0; i < 25; i++) record(nextFlightId(), leg(start, 200));

  const out = playback.buildWindow({ start, end: closeWindow() });

  assert.ok(out.pointCount <= POINT_BUDGET, `budget blown: ${out.pointCount} > ${POINT_BUDGET}`);
  assert.strictEqual(typeof out.truncated, 'boolean');
  assert.ok(out.window.stepMs >= MIN_STEP_MS);
  assert.strictEqual(out.window.start, start);
});

test('flights come back in a stable order, so two fetches of a window render alike', () => {
  const start = Date.now() - 3 * HOUR;
  record(nextFlightId(), leg(start + 30 * 60000, 60));
  record(nextFlightId(), leg(start + 5 * 60000, 60));
  const end = closeWindow();

  const a = playback.buildWindow({ start, end }).flights.map(f => f.flightId);
  const b = playback.buildWindow({ start, end }).flights.map(f => f.flightId);

  assert.deepStrictEqual(a, b);
  const firstTimes = playback.buildWindow({ start, end }).flights.map(f => f.path[0][0]);
  for (let i = 1; i < firstTimes.length; i++) {
    assert.ok(firstTimes[i] >= firstTimes[i - 1], 'flights should be ordered by first appearance');
  }
});

test('a visitor that stops the walk stops it — the budget is not spent decoding the rest', () => {
  const start = Date.now() - 2 * HOUR;
  for (let i = 0; i < 5; i++) record(nextFlightId(), leg(start, 60));

  let visited = 0;
  history.forEachFlightForReplay(start, closeWindow(), () => {
    visited++;
    return visited < 2 ? undefined : false;
  });
  assert.strictEqual(visited, 2, 'returning false from the visitor did not stop the walk');
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
