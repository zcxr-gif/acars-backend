/**
 * friend_events.test.cjs — when a watched pilot's takeoff is announced.
 *
 * Run with: npm test   (or: node friend_events.test.cjs)
 *
 * Both failure modes of this engine reach somebody's lock screen, which is why
 * the rules are pinned here rather than left to be re-derived:
 *
 *   a missed takeoff — the feature quietly does nothing, and the only way to
 *     find out is to be the friend who wasn't told.
 *   a spurious takeoff — a phone buzzes at 3am because a parked aircraft's
 *     groundspeed jittered over 40 knots for one poll, or because a pilot
 *     reconnected mid-cruise.
 *
 * The second is the one that gets an app uninstalled, so the engine is
 * deliberately reluctant: it seeds on first sighting, and it wants the flip
 * confirmed across consecutive snapshots before it commits.
 */

const assert = require('assert');
const friendEvents = require('./friend_events.cjs');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/* =========================
 * Harness
 * ========================= */

// One live flight, at whatever altitude/speed the case needs.
const flight = (username, { alt = 0, gs = 0, id = `${username}-1` } = {}) => ({
  flightId: id,
  username,
  departureIcao: 'KLAX',
  arrivalIcao: 'EGLL',
  position: { lat: 33.9, lon: -118.4, alt_ft: alt, gs_kt: gs },
});

const snapshot = (...flights) => new Map(flights.map((f) => [f.username.toLowerCase(), f]));

// Feed a sequence of snapshots through the engine and collect what it emitted.
// The engine holds module-level state keyed by flightId, so each case uses its
// own flight ids rather than trying to reset it.
function run(snapshots, watched) {
  friendEvents.setEphemeralWatched(new Set(watched.map((u) => u.toLowerCase())));
  const events = [];
  for (const snap of snapshots) {
    friendEvents.processPresent(snap, (type, username) => events.push(`${type}:${username}`));
  }
  return events;
}

const parked = (u, id) => flight(u, { alt: 120, gs: 0, id });
const rolling = (u, id) => flight(u, { alt: 130, gs: 90, id });
const climbing = (u, id) => flight(u, { alt: 4000, gs: 210, id });
const cruising = (u, id) => flight(u, { alt: 33000, gs: 480, id });

/* =========================
 * Takeoff
 * ========================= */

test('a pilot who starts on the ground and rolls announces one takeoff', () => {
  const events = run(
    [
      snapshot(parked('Ana', 'a1')),
      snapshot(rolling('Ana', 'a1')),
      snapshot(climbing('Ana', 'a1')),
      snapshot(cruising('Ana', 'a1')),
    ],
    ['Ana']
  );
  assert.deepStrictEqual(events, ['takeoff:Ana']);
});

test('first sighting seeds state instead of firing', () => {
  // The commonest way to produce a phantom takeoff: a pilot who was already
  // airborne when we first saw them.
  const events = run(
    [snapshot(cruising('Ben', 'b1')), snapshot(cruising('Ben', 'b1')), snapshot(cruising('Ben', 'b1'))],
    ['Ben']
  );
  assert.deepStrictEqual(events, []);
});

test('a single jittery reading does not fire', () => {
  // One poll over the groundspeed threshold, then back on the ground. With a
  // confirm window of two, this must produce nothing at all.
  const events = run(
    [
      snapshot(parked('Cat', 'c1')),
      snapshot(rolling('Cat', 'c1')),
      snapshot(parked('Cat', 'c1')),
      snapshot(parked('Cat', 'c1')),
    ],
    ['Cat']
  );
  assert.deepStrictEqual(events, []);
});

test('a pilot nobody watches is ignored', () => {
  const events = run(
    [snapshot(parked('Dan', 'd1')), snapshot(rolling('Dan', 'd1')), snapshot(climbing('Dan', 'd1'))],
    ['SomebodyElse']
  );
  assert.deepStrictEqual(events, []);
});

/* =========================
 * Landing
 * ========================= */

test('an aircraft that comes down and slows announces one landing', () => {
  const events = run(
    [
      snapshot(cruising('Eve', 'e1')),
      snapshot(cruising('Eve', 'e1')),
      snapshot(flight('Eve', { alt: 90, gs: 25, id: 'e1' })),
      snapshot(flight('Eve', { alt: 90, gs: 10, id: 'e1' })),
    ],
    ['Eve']
  );
  assert.deepStrictEqual(events, ['landing:Eve']);
});

test('a low groundspeed reading at cruise is not a landing', () => {
  // The bug the VA detector's altitude floor exists to prevent: a garbage
  // groundspeed at FL330 must never read as a touchdown.
  const events = run(
    [
      snapshot(cruising('Fay', 'f1')),
      snapshot(cruising('Fay', 'f1')),
      snapshot(flight('Fay', { alt: 33000, gs: 0, id: 'f1' })),
      snapshot(flight('Fay', { alt: 33000, gs: 0, id: 'f1' })),
      snapshot(cruising('Fay', 'f1')),
    ],
    ['Fay']
  );
  assert.deepStrictEqual(events, []);
});

/* =========================
 * Disconnects and new flights
 * ========================= */

test('a pilot who disconnects mid-air produces no landing', () => {
  const events = run(
    [snapshot(cruising('Gus', 'g1')), snapshot(cruising('Gus', 'g1')), snapshot(), snapshot()],
    ['Gus']
  );
  assert.deepStrictEqual(events, []);
});

test('a new flight re-seeds, so respawning airborne announces nothing', () => {
  // Same pilot, new flightId — which is exactly what happens when somebody
  // ends a flight and spawns again, possibly straight into the air.
  const events = run(
    [
      snapshot(parked('Hal', 'h1')),
      snapshot(rolling('Hal', 'h1')),
      snapshot(climbing('Hal', 'h1')), // takeoff on the first flight
      snapshot(),
      snapshot(cruising('Hal', 'h2')), // new flight, already airborne
      snapshot(cruising('Hal', 'h2')),
    ],
    ['Hal']
  );
  assert.deepStrictEqual(events, ['takeoff:Hal']);
});

test('a missing position reading holds the previous state', () => {
  // No usable telemetry is not evidence of anything. It must not commit a
  // flip, and it must not cancel one either.
  const events = run(
    [
      snapshot(parked('Ivy', 'i1')),
      snapshot({ ...rolling('Ivy', 'i1'), position: null }),
      snapshot(rolling('Ivy', 'i1')),
      snapshot(climbing('Ivy', 'i1')),
    ],
    ['Ivy']
  );
  assert.deepStrictEqual(events, ['takeoff:Ivy']);
});

test('two watched pilots are tracked independently', () => {
  const events = run(
    [
      snapshot(parked('Jan', 'j1'), cruising('Kim', 'k1')),
      snapshot(rolling('Jan', 'j1'), cruising('Kim', 'k1')),
      snapshot(climbing('Jan', 'j1'), flight('Kim', { alt: 80, gs: 20, id: 'k1' })),
      snapshot(climbing('Jan', 'j1'), flight('Kim', { alt: 80, gs: 5, id: 'k1' })),
    ],
    ['Jan', 'Kim']
  );
  assert.deepStrictEqual(events.sort(), ['landing:Kim', 'takeoff:Jan']);
});

/* =========================
 * Runner
 * ========================= */
(() => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      fn();
      console.log(`  ✓ ${name}`);
    } catch (e) {
      failed++;
      console.error(`  ✗ ${name}\n    ${e.message}`);
    }
  }
  console.log(failed === 0 ? `\n${tests.length} passing` : `\n${failed} of ${tests.length} failing`);
  process.exit(failed === 0 ? 0 : 1);
})();
