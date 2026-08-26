/**
 * own_flight_events.test.cjs — what the pilot's own phone is told, and when.
 *
 * Run with: npm test   (or: node own_flight_events.test.cjs)
 *
 * This engine's failure modes are the friend detector's, moved one seat over
 * and made worse by the audience. A missed takeoff is a feature that quietly
 * does nothing. A spurious one is a phone buzzing at a pilot about a flight
 * they are not making — and the descent notice has a third: firing an hour
 * late, after a redeploy, at somebody already on short final, which reads as
 * the app being broken rather than merely noisy.
 *
 * So the rules are pinned here: seed on first sighting, confirm a flip across
 * consecutive snapshots, never announce on an absence, never announce a top of
 * descent for a flight that was already coming down when we first saw it, and
 * never announce anything twice for one flight id.
 */

const assert = require('assert');
const own = require('./own_flight_events.cjs');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/* =========================
 * Harness
 * ========================= */

const flight = (username, { alt = 0, gs = 0, vs = 0, id = `${username}-1` } = {}) => ({
  flightId: id,
  username,
  callsign: 'BAW117',
  departureIcao: 'KLAX',
  arrivalIcao: 'EGLL',
  position: { lat: 33.9, lon: -118.4, alt_ft: alt, gs_kt: gs, vs_fpm: vs },
});

const snapshot = (...flights) => new Map(flights.map((f) => [f.username.toLowerCase(), f]));

/**
 * A flat earth, one airport, on the equator at the prime meridian.
 *
 * Stubbed rather than read out of `airports.json`, for two reasons. The file is
 * twelve megabytes, which is not a thing to parse to assert an inequality. And
 * with the field at 0°N 0°E, a degree of longitude is sixty nautical miles
 * exactly — so `enroute(300, …)` puts the aeroplane three hundred miles out and
 * the arithmetic under test is the only arithmetic in the test.
 */
const TEST_FIELD = { lat: 0, lon: 0 };
own.setAirportResolver((icao) => (String(icao).toUpperCase() === 'ZZZZ' ? TEST_FIELD : null));

// Ana has asked to hear about her own flight; Zoe has not.
function run(snapshots, live) {
  own.reset();
  own.setTargets(new Map([['ana', { userId: 'user-ana', handle: 'ana' }]]), live);
  const events = [];
  for (const snap of snapshots) {
    own.processPresent(snap, (kind, target) => events.push(`${kind}:${target.handle}`));
  }
  return events;
}

const parked = (u, id) => flight(u, { alt: 120, gs: 0, vs: 0, id });
const rolling = (u, id) => flight(u, { alt: 130, gs: 90, vs: 200, id });
const climbing = (u, id) => flight(u, { alt: 4000, gs: 210, vs: 2200, id });
const cruising = (u, id) => flight(u, { alt: 33000, gs: 480, vs: 0, id });
const descending = (u, id) => flight(u, { alt: 22000, gs: 440, vs: -1800, id });
const landing = (u, id) => flight(u, { alt: 100, gs: 20, vs: 0, id });

/* =========================
 * Airborne
 * ========================= */

test('a pilot who rolls and climbs is told once that she is airborne', () => {
  const events = run([
    snapshot(parked('Ana', 'a1')),
    snapshot(rolling('Ana', 'a1')),
    snapshot(climbing('Ana', 'a1')),
    snapshot(climbing('Ana', 'a1')),
  ]);
  assert.deepStrictEqual(events, ['airborne:ana']);
});

test('first sighting seeds state instead of announcing', () => {
  const events = run([
    snapshot(cruising('Ana', 'a2')),
    snapshot(cruising('Ana', 'a2')),
    snapshot(cruising('Ana', 'a2')),
  ]);
  assert.deepStrictEqual(events, []);
});

test('one jittery reading over the groundspeed threshold announces nothing', () => {
  const events = run([
    snapshot(parked('Ana', 'a3')),
    snapshot(rolling('Ana', 'a3')),
    snapshot(parked('Ana', 'a3')),
    snapshot(parked('Ana', 'a3')),
  ]);
  assert.deepStrictEqual(events, []);
});

test('a pilot who has not asked is not tracked at all', () => {
  own.reset();
  own.setTargets(new Map(), new Map());
  const events = [];
  for (const snap of [snapshot(parked('Zoe', 'z1')), snapshot(rolling('Zoe', 'z1')), snapshot(climbing('Zoe', 'z1'))]) {
    own.processPresent(snap, (kind) => events.push(kind));
  }
  assert.deepStrictEqual(events, []);
  assert.strictEqual(own.stats().tracking, 0, 'no state is held for a pilot who did not ask');
});

/* =========================
 * Top of descent
 * ========================= */

test('a cruise followed by a sustained descent announces one top of descent', () => {
  const events = run([
    snapshot(cruising('Ana', 'a4')),
    snapshot(cruising('Ana', 'a4')),
    snapshot(descending('Ana', 'a4')),
    snapshot(descending('Ana', 'a4')),
    snapshot(descending('Ana', 'a4')),
    snapshot(descending('Ana', 'a4')),
    snapshot(descending('Ana', 'a4')),
  ]);
  assert.deepStrictEqual(events, ['descent:ana']);
});

test('a flight already descending when first seen is never given a top of descent', () => {
  // The redeploy case. Restarting the poller part-way down an arrival must not
  // announce a descent that began an hour ago to somebody on short final.
  const events = run([
    snapshot(descending('Ana', 'a5')),
    snapshot(descending('Ana', 'a5')),
    snapshot(descending('Ana', 'a5')),
    snapshot(descending('Ana', 'a5')),
    snapshot(descending('Ana', 'a5')),
  ]);
  assert.deepStrictEqual(events, []);
});

test('a moment of sink in the cruise is not a descent', () => {
  const events = run([
    snapshot(cruising('Ana', 'a6')),
    snapshot(flight('Ana', { alt: 32900, gs: 480, vs: -600, id: 'a6' })),
    snapshot(cruising('Ana', 'a6')),
    snapshot(flight('Ana', { alt: 32900, gs: 480, vs: -600, id: 'a6' })),
    snapshot(cruising('Ana', 'a6')),
  ]);
  assert.deepStrictEqual(events, []);
});

test('a circuit below the cruise floor gets no top of descent', () => {
  // 1,500 ft and coming down is a landing pattern, not an arrival. An airliner
  // announcement for it would be absurd.
  const events = run([
    snapshot(flight('Ana', { alt: 1500, gs: 120, vs: 0, id: 'a7' })),
    snapshot(flight('Ana', { alt: 1400, gs: 120, vs: -700, id: 'a7' })),
    snapshot(flight('Ana', { alt: 1200, gs: 120, vs: -700, id: 'a7' })),
    snapshot(flight('Ana', { alt: 1000, gs: 120, vs: -700, id: 'a7' })),
    snapshot(flight('Ana', { alt: 800, gs: 120, vs: -700, id: 'a7' })),
  ]);
  assert.deepStrictEqual(events, []);
});

/* =========================
 * Thirty minutes out
 * ========================= */

// Distance from the field in nautical miles, straight down the equator, and
// the speed being made good at it. See TEST_FIELD above.
const enroute = (u, id, { nm, gs, alt = 33000, vs = 0 }) => ({
  flightId: id,
  username: u,
  callsign: 'BAW117',
  departureIcao: 'KLAX',
  arrivalIcao: 'ZZZZ',
  position: { lat: 0, lon: nm / 60, alt_ft: alt, gs_kt: gs, vs_fpm: vs },
});

test('a flight watched in from further out is told once when it is half an hour away', () => {
  const events = run([
    snapshot(enroute('Ana', 'p1', { nm: 400, gs: 450 })), // 53 minutes
    snapshot(enroute('Ana', 'p1', { nm: 200, gs: 450 })), // 27 — the notice
    snapshot(enroute('Ana', 'p1', { nm: 150, gs: 450 })), // closer still, silent
    snapshot(enroute('Ana', 'p1', { nm: 90, gs: 400 })),
  ]);
  assert.deepStrictEqual(events, ['approach:ana']);
});

test('a flight first seen inside the window is never told it is thirty minutes out', () => {
  // The redeploy case, and the one that would read as the app being broken:
  // announcing half an hour out to somebody already on the arrival.
  const events = run([
    snapshot(enroute('Ana', 'p2', { nm: 150, gs: 450 })),
    snapshot(enroute('Ana', 'p2', { nm: 120, gs: 450 })),
    snapshot(enroute('Ana', 'p2', { nm: 80, gs: 420 })),
  ]);
  assert.deepStrictEqual(events, []);
});

test('a light aircraft gets the same notice at its own speed', () => {
  // 200 miles is an hour and a half at 130 knots, and sixty miles is half an
  // hour. Nothing here is an airliner's number.
  const events = run([
    snapshot(enroute('Ana', 'p3', { nm: 200, gs: 130, alt: 8000 })),
    snapshot(enroute('Ana', 'p3', { nm: 60, gs: 130, alt: 8000 })),
  ]);
  assert.deepStrictEqual(events, ['approach:ana']);
});

test('an aeroplane still on the ground is not counted down to anywhere', () => {
  const events = run([
    snapshot(enroute('Ana', 'p4', { nm: 900, gs: 0, alt: 30, vs: 0 })),
    snapshot(enroute('Ana', 'p4', { nm: 900, gs: 12, alt: 30, vs: 0 })),
  ]);
  assert.deepStrictEqual(events, []);
});

test('taxiing in at the far end is not thirty minutes from the gate', () => {
  // The arithmetic on its own would say a taxiing aeroplane four miles out is
  // twenty minutes away. Both guards — the speed floor and the distance floor
  // — exist to refuse that.
  const events = run([
    snapshot(enroute('Ana', 'p5', { nm: 400, gs: 450 })),
    snapshot(enroute('Ana', 'p5', { nm: 4, gs: 12, alt: 30 })),
  ]);
  assert.deepStrictEqual(events, []);
});

test('a flight with no destination filed is never counted down', () => {
  const noDestination = (id, nm, gs) => ({
    flightId: id,
    username: 'Ana',
    callsign: 'BAW117',
    departureIcao: 'KLAX',
    arrivalIcao: null,
    position: { lat: 0, lon: nm / 60, alt_ft: 33000, gs_kt: gs, vs_fpm: 0 },
  });
  const events = run([
    snapshot(noDestination('p6', 400, 450)),
    snapshot(noDestination('p6', 200, 450)),
    snapshot(noDestination('p6', 100, 450)),
  ]);
  assert.deepStrictEqual(events, []);
});

test('a second flight by the same pilot gets its own countdown', () => {
  const events = run([
    snapshot(enroute('Ana', 'p7', { nm: 400, gs: 450 })),
    snapshot(enroute('Ana', 'p7', { nm: 200, gs: 450 })),
    snapshot(enroute('Ana', 'p8', { nm: 400, gs: 450 })),
    snapshot(enroute('Ana', 'p8', { nm: 200, gs: 450 })),
  ]);
  assert.deepStrictEqual(events, ['approach:ana', 'approach:ana']);
});

test('the estimate is the distance over the speed being made good', () => {
  const at = (nm, gs) => own.minutesToArrival(enroute('Ana', 'x', { nm, gs }), () => TEST_FIELD);
  assert.ok(Math.abs(at(450, 450) - 60) < 1, 'four hundred and fifty miles at 450 knots is an hour');
  assert.ok(Math.abs(at(225, 450) - 30) < 1, 'half that is half an hour');
  assert.strictEqual(at(450, 40), null, 'a groundspeed that is a taxi is not a speed to anywhere');
  assert.strictEqual(at(3, 450), null, 'three miles out is not an estimate, it is an arrival');
});

/* =========================
 * Landing, and absence
 * ========================= */

test('a full flight announces airborne, descent and landed, in that order, once each', () => {
  const events = run([
    snapshot(parked('Ana', 'a8')),
    snapshot(rolling('Ana', 'a8')),
    snapshot(climbing('Ana', 'a8')),
    snapshot(cruising('Ana', 'a8')),
    snapshot(cruising('Ana', 'a8')),
    snapshot(descending('Ana', 'a8')),
    snapshot(descending('Ana', 'a8')),
    snapshot(descending('Ana', 'a8')),
    snapshot(descending('Ana', 'a8')),
    snapshot(landing('Ana', 'a8')),
    snapshot(landing('Ana', 'a8')),
    snapshot(landing('Ana', 'a8')),
  ]);
  assert.deepStrictEqual(events, ['airborne:ana', 'descent:ana', 'landed:ana']);
});

test('a pilot who disappears mid-cruise is not announced as landed', () => {
  const events = run([
    snapshot(parked('Ana', 'a9')),
    snapshot(rolling('Ana', 'a9')),
    snapshot(climbing('Ana', 'a9')),
    snapshot(cruising('Ana', 'a9')),
    snapshot(),
    snapshot(),
  ]);
  assert.deepStrictEqual(events, ['airborne:ana']);
});

test('a new flight id starts clean rather than inheriting the last one', () => {
  const events = run([
    snapshot(parked('Ana', 'a10')),
    snapshot(rolling('Ana', 'a10')),
    snapshot(climbing('Ana', 'a10')),
    // Ends that flight and starts another, already airborne.
    snapshot(cruising('Ana', 'a11')),
    snapshot(cruising('Ana', 'a11')),
    snapshot(cruising('Ana', 'a11')),
  ]);
  assert.deepStrictEqual(events, ['airborne:ana'], 'the second flight is seeded, not announced');
});

/* =========================
 * Recognised by the flight, not by the name
 * ========================= */

test('a pilot with no handle at all is reached by the flight id her app published', () => {
  // The case the by-name join cannot serve, and the reason the second one
  // exists: nothing in this snapshot says "zoe" anywhere the engine looks.
  own.reset();
  own.setTargets(new Map(), new Map([['z-9', { userId: 'user-zoe', handle: 'zoe' }]]));
  const events = [];
  for (const snap of [
    snapshot(parked('Zoe', 'z-9')),
    snapshot(rolling('Zoe', 'z-9')),
    snapshot(climbing('Zoe', 'z-9')),
  ]) {
    own.processPresent(snap, (kind, target) => events.push(`${kind}:${target.handle}`));
  }
  assert.deepStrictEqual(events, ['airborne:zoe']);
});

test('a pilot found by both routes is announced to once', () => {
  const events = run(
    [
      snapshot(parked('Ana', 'a12')),
      snapshot(rolling('Ana', 'a12')),
      snapshot(climbing('Ana', 'a12')),
    ],
    new Map([['a12', { userId: 'user-ana', handle: 'ana' }]])
  );
  assert.deepStrictEqual(events, ['airborne:ana']);
});

test('the flight id wins when the two disagree', () => {
  // The handle is typed into a text box and the flight id came out of the
  // running simulator. When they name different accounts, the simulator is the
  // one that was actually there.
  own.setTargets(
    new Map([['ana', { userId: 'user-typed', handle: 'typed' }]]),
    new Map([['a13', { userId: 'user-sim', handle: 'sim' }]])
  );
  assert.strictEqual(own.identify('ana', 'a13').userId, 'user-sim');
  assert.strictEqual(own.identify('ana', 'unknown-flight').userId, 'user-typed');
  assert.strictEqual(own.identify('nobody', 'unknown-flight'), null);
});

/* =========================
 * What it says
 * ========================= */

test('the two notices with something to do about them are the ones that make a sound', () => {
  const f = flight('Ana');
  assert.strictEqual(own.compose('descent', f).sound, true);
  assert.strictEqual(own.compose('approach', f).sound, true);
  assert.strictEqual(own.compose('airborne', f).sound, false);
  assert.strictEqual(own.compose('landed', f).sound, false);
});

test('the descent notice is active and the landing notice is not', () => {
  const f = flight('Ana');
  assert.strictEqual(own.compose('descent', f).level, 'active');
  assert.strictEqual(own.compose('approach', f).level, 'active');
  assert.strictEqual(own.compose('landed', f).level, 'passive');
});

test('the arrival notice names the field, and the window it fires in', () => {
  const notice = own.compose('approach', flight('Ana'));
  assert.strictEqual(notice.kind, 'own_approach');
  assert.ok(notice.title.startsWith(String(own.APPROACH_MINUTES)),
    `the title leads with the number that decides it: ${notice.title}`);
  assert.ok(notice.body.includes('EGLL'), `the body names the destination: ${notice.body}`);
});

test('a flight with no route still composes a sentence', () => {
  const bare = { flightId: 'x', username: 'Ana', position: {} };
  for (const kind of ['airborne', 'descent', 'approach', 'landed']) {
    const notice = own.compose(kind, bare);
    assert.ok(notice.body && !notice.body.includes('undefined') && !notice.body.includes('null'),
      `${kind} reads as a sentence without a route: ${notice.body}`);
  }
});

test('an unknown event composes nothing rather than an empty banner', () => {
  assert.strictEqual(own.compose('teleported', flight('Ana')), null);
});

/* =========================
 * Runner
 * ========================= */

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
}
console.log(failed ? `\n${failed} failing` : `\n${tests.length} passing`);
process.exit(failed ? 1 : 0);
