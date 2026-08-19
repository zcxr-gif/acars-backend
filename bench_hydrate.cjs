/**
 * Load simulation for live-status hydration.
 *
 * The question this answers is whether keeping suspended pilots on the map
 * costs the poll loop anything. Hydration runs inside `processSnapshot`, which
 * is on the 15s broadcast path and already has a measured budget, so the number
 * that matters is not how fast a pass is — it is how much a poll that does NOT
 * run a pass costs, because that is 100% of polls minus one a minute.
 *
 * Supabase is stubbed rather than mocked out of the path: `hasServiceKey` and
 * `rpc` are replaced on the module object, so the real guards, the real row
 * building and the real rate limiting all execute.
 *
 * Run: node --expose-gc bench_hydrate.cjs
 */

const supabase = require('./supabase.cjs');

const FLIGHTS = parseInt(process.env.BENCH_FLIGHTS || '800', 10);
const BROADCASTING = parseInt(process.env.BENCH_BROADCASTING || '200', 10);
const POLLS = parseInt(process.env.BENCH_POLLS || '240', 10); // 240 * 15s = 1h

let rpcCalls = 0;
let rowsPosted = 0;
let bytesPosted = 0;

supabase.hasServiceKey = () => true;
supabase.rpc = async (fn, body) => {
  rpcCalls += 1;
  if (fn === 'pilot_live_hydratable') {
    return Array.from({ length: BROADCASTING }, (_, i) => ({ flight_id: `F-${i}` }));
  }
  if (fn === 'pilot_live_hydrate') {
    rowsPosted += body.p_rows.length;
    bytesPosted += JSON.stringify(body).length;
    return body.p_rows.length;
  }
  if (fn === 'pilot_connect_alerts_due') return [];
  return null;
};

const hydrate = require('./live_hydrate.cjs');

function makeFlight(i, poll) {
  return {
    flightId: `F-${i}`,
    username: `pilot${i}`,
    position: {
      lat: 40 + i * 0.001 + poll * 0.0012,
      lon: -70 + i * 0.001 + poll * 0.0018,
      alt_ft: 33000 + (poll % 50) * 10,
      gs_kt: 470 + (poll % 7),
      vs_fpm: -100 + (poll % 11),
      heading_deg: (90 + poll) % 360,
    },
    aircraft: { aircraftName: 'A350-900' },
  };
}

const heap = () => { if (global.gc) global.gc(); return process.memoryUsage().heapUsed; };
const settle = () => new Promise((r) => setImmediate(r));

// A simulated clock for the whole run, because every rate limit in the module
// under test is written against `Date.now`. Stepping it 15s per poll is what
// makes 240 polls cover an hour and exercise the once-a-minute pass rather than
// running one pass and then rate-limiting the other 239.
const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;
const tick = (ms) => { clock += ms; };

(async () => {
  console.log(
    `${FLIGHTS} flights on the feed, ${BROADCASTING} of them broadcasting, `
    + `${POLLS} polls (${(POLLS * 15 / 60).toFixed(0)} min)\n`
  );

  // Prime the watched set the way the first poll would, then let it land.
  const priming = new Map();
  for (let i = 0; i < FLIGHTS; i += 1) priming.set(`F-${i}`, makeFlight(i, 0));
  hydrate.processSnapshot(priming);
  await settle();

  const heapStart = heap();

  let slowestPoll = 0;
  let totalNs = 0n;
  let passes = 0;
  let passNs = 0n;
  let slowestPass = 0;

  for (let poll = 0; poll < POLLS; poll += 1) {
    const byFlightId = new Map();
    for (let i = 0; i < FLIGHTS; i += 1) byFlightId.set(`F-${i}`, makeFlight(i, poll));

    const before = rowsPosted;
    const t = process.hrtime.bigint();
    hydrate.processSnapshot(byFlightId);
    const ns = process.hrtime.bigint() - t;

    // The post is async; let it land so `rowsPosted` reflects this poll and the
    // next one sees the real `inFlight` state rather than a queue that never
    // drains.
    await settle();
    await settle();

    const ranPass = rowsPosted > before;
    totalNs += ns;
    const ms = Number(ns) / 1e6;
    if (ms > slowestPoll) slowestPoll = ms;
    if (ranPass) {
      passes += 1;
      passNs += ns;
      if (ms > slowestPass) slowestPass = ms;
    }

    tick(15000);
  }

  Date.now = realNow;

  const heapEnd = heap();

  console.log(`polls            ${POLLS}`);
  console.log(`  mean           ${(Number(totalNs) / 1e6 / POLLS).toFixed(4)} ms`);
  console.log(`  slowest        ${slowestPoll.toFixed(3)} ms`);
  console.log(`  budget used    ${((Number(totalNs) / 1e6 / POLLS) / 15000 * 100).toFixed(5)}% of a 15s poll`);
  console.log(`\nhydration passes ${passes}`);
  if (passes) {
    console.log(`  mean           ${(Number(passNs) / 1e6 / passes).toFixed(3)} ms`);
    console.log(`  slowest        ${slowestPass.toFixed(3)} ms`);
  }
  console.log(`\nrows posted      ${rowsPosted}`);
  console.log(`bytes posted     ${(bytesPosted / 1024).toFixed(1)} KB total, `
    + `${passes ? (bytesPosted / passes / 1024).toFixed(1) : 0} KB per pass`);
  console.log(`\nheap retained    ${((heapEnd - heapStart) / 1024).toFixed(1)} KB`);
  console.log(`stats            ${JSON.stringify(hydrate.stats())}`);
})();
