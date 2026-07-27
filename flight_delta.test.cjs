/**
 * flight_delta.test.cjs — contract tests for the delta broadcast encoder.
 *
 * Run with: npm test   (or: node flight_delta.test.cjs)
 *
 * The encoder's output is only ever consumed by a decoder in the tracker
 * (FlightDeltaClient.js), so every test here goes through the reference
 * decoder below and asserts the client's reconstructed state is byte-for-byte
 * what the server holds. If this file and the tracker's client ever disagree,
 * planes drift on the map with nothing to indicate why — so the two must be
 * changed together.
 */

const assert = require('assert');
const zlib = require('zlib');
const flightDelta = require('./flight_delta.cjs');

/* =========================
 * Reference decoder — mirrors tracker/FlightDeltaClient.js
 * ========================= */
class RefClient {
  constructor() { this.bySlot = new Map(); this.seq = -1; this.resyncs = 0; }
  get ready() { return this.seq >= 0; }
  applySync(p) {
    this.bySlot.clear();
    this.seq = p.q;
    for (const [slot, wire] of p.f) this.bySlot.set(slot, hydrate(wire));
    return this.snapshot();
  }
  applyDelta(p) {
    if (!this.ready || p.b !== this.seq) { this.resyncs++; this.seq = -1; this.bySlot.clear(); return null; }
    this.seq = p.q;
    for (const slot of p.r) this.bySlot.delete(slot);
    for (const [slot, wire] of p.a) this.bySlot.set(slot, hydrate(wire));
    for (const t of p.p) {
      const prev = this.bySlot.get(t[0]);
      if (!prev) continue;
      this.bySlot.set(t[0], { ...prev, position: {
        lat: t[1], lon: t[2], alt_ft: t[3], gs_kt: t[4], vs_fpm: t[5],
        heading_deg: t[6], lastReport: t[7], lastReportMs: t[7],
      } });
    }
    for (const [slot, changed] of p.m) {
      const prev = this.bySlot.get(slot);
      if (!prev) continue;
      const next = { ...prev, ...changed };
      if (changed.aircraft) next.aircraft = { ...prev.aircraft, ...changed.aircraft };
      this.bySlot.set(slot, next);
    }
    assert.strictEqual(this.bySlot.size, p.c, 'delta count must match the server');
    return this.snapshot();
  }
  snapshot() { return [...this.bySlot.values()]; }
}
function hydrate(wire) {
  const p = wire.position || {};
  return { ...wire, position: { ...p, lastReport: p.lastReportMs ?? null } };
}

/* =========================
 * Fixtures
 * ========================= */
const SESSION = 'test-session';
const SERVER = 'Expert Server';
const guid = (n) => `${n}`.padStart(8, '0') + '-aaaa-4bbb-8ccc-dddddddddddd';

function makeFlight(n) {
  return {
    flightId: guid(n), userId: guid(1000 + n),
    callsign: 'DAL' + (100 + (n % 900)), username: 'pilot_' + n,
    virtualOrganization: n % 3 === 0 ? 'IndGo Virtual' : null,
    arrivalIcao: 'KJFK', departureIcao: 'KLAX',
    isVAMember: n % 3 === 0, isStaff: false, vaRole: null,
    position: {
      lat: 30 + (n % 100) * 0.37, lon: -120 + (n % 100) * 0.61,
      alt_ft: 1000 + n * 7, gs_kt: 240 + (n % 200), vs_fpm: 0,
      heading_deg: (n * 13) % 360,
      lastReport: new Date(1700000000000 + n * 1000).toISOString(),
      lastReportMs: 1700000000000 + n * 1000,
    },
    aircraft: {
      aircraftId: guid(2000 + n), liveryId: guid(3000 + n),
      aircraftName: 'Boeing 787-9', liveryName: 'Delta Air Lines',
    },
    pilotState: 0, isConnected: true,
  };
}

const round = (v, p) => (typeof v === 'number' && isFinite(v)) ? Math.round(v * p) / p : null;

/** What the client should hold for a given server-side flight. */
function expected(f) {
  const p = f.position;
  return {
    flightId: f.flightId, userId: f.userId, callsign: f.callsign, username: f.username,
    virtualOrganization: f.virtualOrganization, arrivalIcao: f.arrivalIcao,
    departureIcao: f.departureIcao, isVAMember: f.isVAMember, isStaff: f.isStaff,
    vaRole: f.vaRole, pilotState: f.pilotState, isConnected: f.isConnected,
    position: {
      lat: round(p.lat, 1e6), lon: round(p.lon, 1e6), alt_ft: round(p.alt_ft, 10),
      gs_kt: round(p.gs_kt, 10), vs_fpm: round(p.vs_fpm, 1),
      heading_deg: round(p.heading_deg, 100),
      lastReport: p.lastReportMs, lastReportMs: p.lastReportMs,
    },
    aircraft: { ...f.aircraft },
  };
}
const sortKeys = (o) => (Array.isArray(o) || o === null || typeof o !== 'object')
  ? o
  : Object.keys(o).sort().reduce((acc, k) => (acc[k] = sortKeys(o[k]), acc), {});

function assertIdentical(clientFlights, serverFlights, label) {
  assert.strictEqual(clientFlights.length, serverFlights.length, `${label}: flight count`);
  const byId = new Map(clientFlights.map(f => [f.flightId, f]));
  for (const sf of serverFlights) {
    const cf = byId.get(sf.flightId);
    assert.ok(cf, `${label}: client is missing ${sf.flightId}`);
    assert.deepStrictEqual(sortKeys(cf), sortKeys(expected(sf)), `${label}: ${sf.flightId} differs`);
  }
}

/* =========================
 * Tests
 * ========================= */
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('sync reconstructs the cached snapshot exactly', () => {
  flightDelta.drop(SESSION);
  const flights = Array.from({ length: 50 }, (_, i) => makeFlight(i));
  flightDelta.seed(SESSION, SERVER, { server: SERVER, flights, timestamp: 'T0' });
  const client = new RefClient();
  assertIdentical(client.applySync(flightDelta.sync(SESSION)), flights, 'sync');
});

test('movement, joins, departures and metadata edits all round-trip', () => {
  flightDelta.drop(SESSION);
  let flights = Array.from({ length: 200 }, (_, i) => makeFlight(i));
  flightDelta.seed(SESSION, SERVER, { server: SERVER, flights, timestamp: 'T0' });
  const client = new RefClient();
  client.applySync(flightDelta.sync(SESSION));

  for (let tick = 1; tick <= 15; tick++) {
    flights = flights.map(f => ({ ...f, position: {
      ...f.position,
      lat: f.position.lat + 0.002, lon: f.position.lon + 0.003,
      alt_ft: f.position.alt_ft + 120,
      heading_deg: (f.position.heading_deg + 0.4) % 360,
      lastReportMs: f.position.lastReportMs + 15000,
    } }));
    if (tick % 3 === 0) { flights = flights.slice(1); flights.push(makeFlight(10000 + tick)); }
    if (tick % 5 === 0) {
      flights[2] = { ...flights[2], callsign: 'UAL' + tick, arrivalIcao: 'EGLL', isVAMember: true };
      flights[3] = { ...flights[3], aircraft: { ...flights[3].aircraft, liveryName: 'United Airlines' } };
    }
    const delta = flightDelta.encode(SESSION, SERVER, flights, 'T' + tick);
    assert.ok(delta, `tick ${tick}: expected a delta`);
    assertIdentical(client.applyDelta(delta), flights, `tick ${tick}`);
  }
});

test('a tick where nothing moved emits no packet and burns no sequence', () => {
  flightDelta.drop(SESSION);
  const flights = Array.from({ length: 20 }, (_, i) => makeFlight(i));
  flightDelta.seed(SESSION, SERVER, { server: SERVER, flights, timestamp: 'T0' });
  const seqBefore = flightDelta.sync(SESSION).q;
  assert.strictEqual(flightDelta.encode(SESSION, SERVER, flights, 'T1'), null);
  assert.strictEqual(flightDelta.sync(SESSION).q, seqBefore, 'sequence must not advance');
});

test('sub-precision jitter on a parked aircraft is not a change', () => {
  flightDelta.drop(SESSION);
  const flights = [makeFlight(1)];
  flightDelta.seed(SESSION, SERVER, { server: SERVER, flights, timestamp: 'T0' });
  const jittered = [{ ...flights[0], position: { ...flights[0].position, lat: flights[0].position.lat + 1e-9 } }];
  assert.strictEqual(flightDelta.encode(SESSION, SERVER, jittered, 'T1'), null);
});

test('a dropped packet is caught by the sequence, not applied silently', () => {
  flightDelta.drop(SESSION);
  let flights = Array.from({ length: 30 }, (_, i) => makeFlight(i));
  flightDelta.seed(SESSION, SERVER, { server: SERVER, flights, timestamp: 'T0' });
  const client = new RefClient();
  client.applySync(flightDelta.sync(SESSION));

  flights = flights.map(f => ({ ...f, position: { ...f.position, lat: f.position.lat + 1 } }));
  flightDelta.encode(SESSION, SERVER, flights, 'T-lost'); // never delivered
  flights = flights.map(f => ({ ...f, position: { ...f.position, lat: f.position.lat + 1 } }));
  const next = flightDelta.encode(SESSION, SERVER, flights, 'T-next');

  assert.strictEqual(client.applyDelta(next), null, 'gapped delta must be rejected');
  assert.strictEqual(client.resyncs, 1);
  assert.strictEqual(client.ready, false, 'client must discard state it cannot trust');

  // …and a resync puts it back exactly.
  assertIdentical(client.applySync(flightDelta.sync(SESSION)), flights, 'after resync');
  flights = flights.map(f => ({ ...f, position: { ...f.position, lon: f.position.lon + 0.01 } }));
  assertIdentical(client.applyDelta(flightDelta.encode(SESSION, SERVER, flights, 'T-after')), flights, 'post-resync');
});

test('slots are recycled so their numbers stay small', () => {
  flightDelta.drop(SESSION);
  let flights = Array.from({ length: 10 }, (_, i) => makeFlight(i));
  flightDelta.seed(SESSION, SERVER, { server: SERVER, flights, timestamp: 'T0' });
  for (let i = 0; i < 50; i++) {
    flights = [...flights.slice(1), makeFlight(50000 + i)];
    flightDelta.encode(SESSION, SERVER, flights, 'T' + i);
  }
  const slots = flightDelta.sync(SESSION).f.map(([slot]) => slot);
  assert.ok(Math.max(...slots) <= 11, `slots should be recycled, saw ${Math.max(...slots)}`);
});

test('state for a session that no longer exists is pruned', () => {
  flightDelta.drop(SESSION);
  flightDelta.seed(SESSION, SERVER, { server: SERVER, flights: [makeFlight(1)], timestamp: 'T0' });
  assert.ok(flightDelta.has(SESSION));
  flightDelta.pruneSessions(new Set(['some-other-session']));
  assert.strictEqual(flightDelta.has(SESSION), false);
});

test('a delta is an order of magnitude smaller than the snapshot it replaces', () => {
  flightDelta.drop(SESSION);
  let flights = Array.from({ length: 900 }, (_, i) => makeFlight(i));
  flightDelta.seed(SESSION, SERVER, { server: SERVER, flights, timestamp: 'T0' });
  flights = flights.map(f => ({ ...f, position: {
    ...f.position, lat: f.position.lat + 0.002, lon: f.position.lon + 0.003,
    lastReportMs: f.position.lastReportMs + 15000,
  } }));
  const payload = { server: SERVER, sessionId: SESSION, count: flights.length, flights, timestamp: 'T1' };
  const delta = flightDelta.encode(SESSION, SERVER, flights, 'T1');

  const full = JSON.stringify(payload).length;
  const inc = JSON.stringify(delta).length;
  const fullGz = zlib.deflateSync(Buffer.from(JSON.stringify(payload))).length;
  const incGz = zlib.deflateSync(Buffer.from(JSON.stringify(delta))).length;
  console.log(`    900 flights: full ${(full / 1024).toFixed(0)} KB (${(fullGz / 1024).toFixed(0)} KB deflated)` +
              ` -> delta ${(inc / 1024).toFixed(0)} KB (${(incGz / 1024).toFixed(0)} KB deflated)`);
  assert.ok(inc < full / 5, 'delta should be well under a fifth of the full payload');
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
    failed++;
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
}
console.log(failed === 0 ? `\n${tests.length} passing` : `\n${failed} of ${tests.length} failing`);
process.exit(failed === 0 ? 0 : 1);
