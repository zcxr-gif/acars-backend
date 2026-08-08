/**
 * Load simulation for the trail recorder.
 *
 * Simulates a busy server: N concurrent flights polled every 15s for an
 * simulated hour, then measures the read paths. Reports throughput, database
 * growth per flight-hour, and heap after a forced GC so a leak shows up as
 * retained memory rather than noise.
 *
 * Run: node --expose-gc bench.cjs
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-'));
process.env.DATA_DIR = TMP_DIR;
process.env.HISTORY_MAX_DB_MB = '0';

const history = require('./history.cjs');

const FLIGHTS = parseInt(process.env.BENCH_FLIGHTS || '800', 10);
const POLLS = parseInt(process.env.BENCH_POLLS || '240', 10); // 240 * 15s = 1h
const START = 1712345678901;

function makeFlight(i, poll) {
  // Below the cruise threshold so every point is actually recorded — this is
  // the worst case for write volume, which is what we want to measure.
  return {
    userId: `user-${i % 500}`,
    flightId: `F-${i}`,
    callsign: `TST${i}`,
    position: {
      lat: 40 + i * 0.001 + poll * 0.0012,
      lon: -70 + i * 0.001 + poll * 0.0018,
      alt_ft: 9000 + (poll % 50) * 10,
      gs_kt: 320 + (poll % 7),
      heading_deg: (90 + poll) % 360,
      lastReportMs: START + poll * 15000
    },
    aircraft: { aircraftId: 'a', liveryId: 'l', aircraftName: 'A350-900', liveryName: 'BA' }
  };
}

function dbBytes() {
  let total = 0;
  for (const s of ['', '-wal', '-shm']) {
    try { total += fs.statSync(path.join(TMP_DIR, 'flight_history.db' + s)).size; } catch {}
  }
  return total;
}

const heap = () => { if (global.gc) global.gc(); return process.memoryUsage().heapUsed; };

(async () => {
  console.log(`Simulating ${FLIGHTS} flights x ${POLLS} polls (${(POLLS * 15 / 60).toFixed(0)} min of flying)\n`);

  const heapStart = heap();
  const t0 = Date.now();
  let slowestPoll = 0;

  for (let poll = 0; poll < POLLS; poll++) {
    const batch = [];
    for (let i = 0; i < FLIGHTS; i++) batch.push(makeFlight(i, poll));

    const pt = Date.now();
    history.updateBatch(batch);
    slowestPoll = Math.max(slowestPoll, Date.now() - pt);
  }

  const elapsed = Date.now() - t0;
  const heapEnd = heap();
  const bytes = dbBytes();

  const totalPoints = FLIGHTS * POLLS;
  console.log(`writes`);
  console.log(`  total            ${(elapsed / 1000).toFixed(1)}s for ${POLLS} polls`);
  console.log(`  mean per poll    ${(elapsed / POLLS).toFixed(1)}ms  (${FLIGHTS} flights)`);
  console.log(`  slowest poll     ${slowestPoll}ms`);
  console.log(`  per flight       ${(elapsed / totalPoints * 1000).toFixed(1)}us`);
  console.log(`  budget           15000ms per poll — using ${(elapsed / POLLS / 15000 * 100).toFixed(2)}%`);

  console.log(`\nstorage`);
  console.log(`  database         ${(bytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  per flight-hour  ${(bytes / FLIGHTS / 1024).toFixed(1)} KB`);
  console.log(`  projected 14d    ${(bytes / FLIGHTS * FLIGHTS * 24 * 14 / 1024 / 1024 / 1024).toFixed(2)} GB at this rate`);

  // Read paths
  const r0 = Date.now();
  for (let i = 0; i < 200; i++) await history.getFlightPath(`F-${i}`);
  const readMs = Date.now() - r0;

  const q0 = Date.now();
  const replay = history.getFlightsForReplay(0);
  const replayMs = Date.now() - q0;

  console.log(`\nreads`);
  console.log(`  getFlightPath    ${(readMs / 200).toFixed(2)}ms each (200 calls)`);
  console.log(`  replay window    ${replayMs}ms for ${replay.length} flights`);

  console.log(`\nmemory`);
  console.log(`  heap start       ${(heapStart / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  heap end         ${(heapEnd / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  retained         ${((heapEnd - heapStart) / 1024 / 1024).toFixed(1)} MB after GC`);

  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
  process.exit(0);
})();
