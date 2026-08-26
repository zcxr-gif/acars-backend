/**
 * watchlist.test.cjs — who gets told a pilot came online, and who does not.
 *
 * Run with: npm test   (or: node watchlist.test.cjs)
 *
 * The presence engine is the oldest part of the notification path and had the
 * quietest bug in it. It held state for every pilot on every Infinite Flight
 * server and fired an event for each one that appeared — which meant that at a
 * busy hour, a feature about a dozen friends was doing dozens of Supabase round
 * trips per poll, inside the same loop that detects takeoffs. Nothing errored.
 * The events simply stopped being timely, and then stopped.
 *
 * So what is pinned here is the scope: state is held for watched pilots and
 * nobody else, an arrival is an arrival rather than a subscription, and a
 * disappearance still has to be confirmed before it is announced.
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Before push.cjs is loaded, so its SQLite registries land in a temp directory
// rather than in the repository's own data/.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'watchlist-test-'));

const watchlist = require('./watchlist.cjs');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/* =========================
 * Harness
 * ========================= */

/// A socket that records what it was sent, and hands back the handlers
/// `attachSocket` registered on it.
function fakeSocket(id) {
  const received = [];
  const handlers = {};
  const socket = {
    id,
    received,
    on: (event, fn) => { handlers[event] = fn; },
    emit: (_event, payload) => { received.push(payload); },
    watch: (...usernames) => handlers.watchlist_subscribe({ usernames }),
    disconnect: () => handlers.disconnect(),
  };
  watchlist.attachSocket(socket);
  return socket;
}

const flight = (username, id = `${username}-1`) => ({
  flightId: id,
  username,
  callsign: 'BAW117',
  departureIcao: 'KLAX',
  arrivalIcao: 'EGLL',
  // Level at cruise in every snapshot: this file is about presence, and a
  // ground/air transition would bring the takeoff detector into it.
  position: { lat: 33.9, lon: -118.4, alt_ft: 33000, gs_kt: 460, vs_fpm: 0 },
});

/// One poll's worth of feed, shaped as the broadcaster caches it.
const snapshot = (...flights) => new Map([['session-1', { flights }]]);

const kinds = (socket) => socket.received.map((e) => `${e.type}:${e.username}`);

/* =========================
 * Scope
 * ========================= */

test('the first snapshot seeds the world without announcing any of it', () => {
  const socket = fakeSocket('s-seed');
  socket.watch('ana');

  watchlist.processSnapshot(snapshot(flight('Ana'), flight('Zoe')));

  assert.deepStrictEqual(kinds(socket), []);
});

test('a watched pilot arriving is announced, and everybody else is not', () => {
  const socket = fakeSocket('s-arrive');
  socket.watch('ana');

  watchlist.processSnapshot(snapshot(flight('Zoe')));
  watchlist.processSnapshot(snapshot(flight('Zoe'), flight('Ana'), flight('Kai')));

  assert.deepStrictEqual(kinds(socket), ['pilot_online:Ana']);
});

test('adding somebody who is already flying is not that pilot coming online', () => {
  // The bug this is here for reads as the app inventing an event: you add a
  // friend who is mid-Atlantic, and it tells you they have just taken off.
  const socket = fakeSocket('s-late');

  watchlist.processSnapshot(snapshot(flight('Ana')));
  watchlist.processSnapshot(snapshot(flight('Ana')));

  socket.watch('ana');
  watchlist.processSnapshot(snapshot(flight('Ana')));

  assert.deepStrictEqual(kinds(socket), []);
});

test('a pilot who leaves is announced once, and only after a second miss', () => {
  const socket = fakeSocket('s-leave');
  socket.watch('ana');

  watchlist.processSnapshot(snapshot(flight('Zoe')));
  watchlist.processSnapshot(snapshot(flight('Zoe'), flight('Ana')));
  watchlist.processSnapshot(snapshot(flight('Zoe')));
  assert.deepStrictEqual(kinds(socket), ['pilot_online:Ana'], 'one missing poll is a gap, not a departure');

  watchlist.processSnapshot(snapshot(flight('Zoe')));
  watchlist.processSnapshot(snapshot(flight('Zoe')));

  assert.deepStrictEqual(kinds(socket), ['pilot_online:Ana', 'pilot_offline:Ana']);
});

test('one poll gap does not fire a departure and an arrival either side of it', () => {
  const socket = fakeSocket('s-gap');
  socket.watch('ana');

  watchlist.processSnapshot(snapshot(flight('Ana')));
  watchlist.processSnapshot(snapshot());
  watchlist.processSnapshot(snapshot(flight('Ana')));

  assert.deepStrictEqual(kinds(socket), []);
});

test('two watchers of the same pilot are both told; a third is not', () => {
  const one = fakeSocket('s-one');
  const two = fakeSocket('s-two');
  const other = fakeSocket('s-other');
  one.watch('ana');
  two.watch('ana', 'kai');
  other.watch('zoe');

  watchlist.processSnapshot(snapshot(flight('Zoe')));
  watchlist.processSnapshot(snapshot(flight('Zoe'), flight('Ana')));

  assert.deepStrictEqual(kinds(one), ['pilot_online:Ana']);
  assert.deepStrictEqual(kinds(two), ['pilot_online:Ana']);
  assert.deepStrictEqual(kinds(other), []);
});

test('a name is matched however the pilot capitalised it', () => {
  const socket = fakeSocket('s-case');
  socket.watch('  ANA  ');

  watchlist.processSnapshot(snapshot(flight('Zoe')));
  watchlist.processSnapshot(snapshot(flight('Zoe'), flight('Ana')));

  assert.deepStrictEqual(kinds(socket), ['pilot_online:Ana']);
});

test('a disconnected socket is sent nothing', () => {
  const socket = fakeSocket('s-gone');
  socket.watch('ana');

  watchlist.processSnapshot(snapshot(flight('Zoe')));
  socket.disconnect();
  watchlist.processSnapshot(snapshot(flight('Zoe'), flight('Ana')));

  assert.deepStrictEqual(kinds(socket), []);
});

/* =========================
 * Capabilities
 * ========================= */

test('the capabilities probe names every event a client can ask for', () => {
  const caps = watchlist.capabilities();

  for (const kind of ['takeoff', 'landing', 'online', 'offline']) {
    assert.ok(caps.eventKinds.includes(kind), `${kind} is offered`);
  }
  for (const key of ['ownAirborne', 'ownDescent', 'ownApproach', 'ownLanded']) {
    assert.ok(caps.ownFlightEventKinds.includes(key), `${key} is offered`);
  }
  assert.strictEqual(typeof caps.approachMinutes, 'number');
  assert.ok(caps.approachMinutes > 0, 'the arrival window is a real number of minutes');
});

/* =========================
 * Runner
 * ========================= */

let failed = 0;
for (const [name, fn] of tests) {
  try {
    // Presence is a diff against the last snapshot, so every test starts from
    // an empty sky and no subscriptions. Without this each one asserts against
    // whatever the previous one left flying.
    watchlist.reset();
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  }
}

console.log(`\n${tests.length - failed} passing${failed ? `, ${failed} failing` : ''}`);
process.exit(failed ? 1 : 0);
