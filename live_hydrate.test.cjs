/**
 * live_hydrate.test.cjs — turning a feed flight into a live-status position.
 *
 * Run with: npm test   (or: node live_hydrate.test.cjs)
 *
 * The whole snapshot is hydrated in a single SQL statement, and every position
 * column on `pilot_live_status` carries a check constraint. So one aircraft
 * reporting a heading of 4,000,000 degrees does not lose its own position — it
 * aborts the statement and loses everybody's. That is the failure this file
 * exists for, and it is invisible until the day a feed reading goes strange.
 *
 * The gating that decides WHETHER to hydrate lives in the database on purpose
 * (a sim that is still talking always wins) and is asserted in
 * `supabase/tests/live_status.sql` in the iOS repo, against a real Postgres.
 */

const assert = require('assert');
const { hydrationRow } = require('./live_hydrate.cjs');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const at = (position) => ({ flightId: 'F1', position });

/* =========================
 * The happy path
 * ========================= */

test('a cruising flight becomes a position', () => {
  const row = hydrationRow('F1', at({
    lat: 51.4775, lon: -0.4614, alt_ft: 35012.4, gs_kt: 470.6,
    vs_fpm: -512.2, heading_deg: 279.55,
  }));
  assert.deepStrictEqual(row, {
    flight_id: 'F1',
    latitude: 51.4775,
    longitude: -0.4614,
    altitude_msl: 35012,
    heading: 280,
    ground_speed_knots: 471,
    vertical_speed_fpm: -512,
  });
});

test('latitude and longitude keep their precision', () => {
  const row = hydrationRow('F1', at({ lat: 51.4775123, lon: -0.4614987 }));
  assert.strictEqual(row.latitude, 51.4775123);
  assert.strictEqual(row.longitude, -0.4614987);
});

/* =========================
 * Nothing to place it by
 * ========================= */

test('a flight with no position at all is skipped', () => {
  assert.strictEqual(hydrationRow('F1', { flightId: 'F1' }), null);
  assert.strictEqual(hydrationRow('F1', null), null);
});

test('a position missing its coordinates is skipped', () => {
  assert.strictEqual(hydrationRow('F1', at({ alt_ft: 35000 })), null);
  assert.strictEqual(hydrationRow('F1', at({ lat: 51.5 })), null);
});

test('coordinates off the planet are skipped rather than clamped', () => {
  // Clamping would place the aeroplane at the pole, confidently and wrongly.
  // There is no position here, so the row is not offered.
  assert.strictEqual(hydrationRow('F1', at({ lat: 191, lon: 0 })), null);
  assert.strictEqual(hydrationRow('F1', at({ lat: 0, lon: -400 })), null);
  assert.strictEqual(hydrationRow('F1', at({ lat: NaN, lon: 0 })), null);
  assert.strictEqual(hydrationRow('F1', at({ lat: 0, lon: Infinity })), null);
});

/* =========================
 * The readings that would abort the statement
 * ========================= */

test('an absurd altitude is clamped to the column, not sent as-is', () => {
  const row = hydrationRow('F1', at({ lat: 0, lon: 0, alt_ft: 1e9 }));
  assert.strictEqual(row.altitude_msl, 90000);
  const below = hydrationRow('F1', at({ lat: 0, lon: 0, alt_ft: -99999 }));
  assert.strictEqual(below.altitude_msl, -2000);
});

test('an absurd groundspeed and vertical speed are clamped too', () => {
  const row = hydrationRow('F1', at({ lat: 0, lon: 0, gs_kt: 99999, vs_fpm: -1e6 }));
  assert.strictEqual(row.ground_speed_knots, 1200);
  assert.strictEqual(row.vertical_speed_fpm, -30000);
});

test('a heading past the top wraps rather than clamping', () => {
  // 361 degrees is one degree, not due south. Clamping to 360 would have been
  // wrong by the width of the compass.
  assert.strictEqual(hydrationRow('F1', at({ lat: 0, lon: 0, heading_deg: 361 })).heading, 1);
  assert.strictEqual(hydrationRow('F1', at({ lat: 0, lon: 0, heading_deg: -90 })).heading, 270);
  assert.strictEqual(hydrationRow('F1', at({ lat: 0, lon: 0, heading_deg: 720 })).heading, 0);
});

test('a missing reading is null rather than zero', () => {
  // Zero is a real altitude, a real heading and a real groundspeed. Sending it
  // for a reading the feed did not give would put a cruising aeroplane on the
  // ground pointing north.
  const row = hydrationRow('F1', at({ lat: 51.5, lon: -0.5 }));
  assert.strictEqual(row.altitude_msl, null);
  assert.strictEqual(row.heading, null);
  assert.strictEqual(row.ground_speed_knots, null);
  assert.strictEqual(row.vertical_speed_fpm, null);
});

test('a non-numeric reading is null rather than NaN', () => {
  const row = hydrationRow('F1', at({ lat: 0, lon: 0, alt_ft: '35000', heading_deg: null }));
  assert.strictEqual(row.altitude_msl, null);
  assert.strictEqual(row.heading, null);
});

test('the flight id sent is the one asked for, not the one on the flight', () => {
  // The id that matters is the key the live status was published under. They
  // are the same id in practice; matching on the caller's is what makes that a
  // fact rather than an assumption.
  const row = hydrationRow('WANTED', { flightId: 'OTHER', position: { lat: 1, lon: 2 } });
  assert.strictEqual(row.flight_id, 'WANTED');
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
console.log(`\n${tests.length - failed} passing${failed ? `, ${failed} failing` : ''}`);
process.exit(failed ? 1 : 0);
