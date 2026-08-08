/* =========================
 * Global playback — the whole map, rewound
 * =========================
 *
 * The tracker could already replay one thing at a time: a single flight
 * (flightReplay.js), or the traffic inside one controller's airspace
 * (atc_history.cjs). What it could never do is the obvious thing — scrub the
 * *map itself* backwards and watch the world's traffic as it actually was.
 *
 * The data for it has been sitting in flight_history the whole time. Every
 * flight on every server is already recorded, and since the chunked-storage
 * rework that history reaches back a fortnight. This module is the reader that
 * turns that into a replayable frame of the world.
 *
 * Tiers
 * -----
 * How far back you may look is the paid line:
 *
 *   free   the last 24 hours
 *   Pro    the last 14 days (whatever HISTORY_RETENTION_HOURS actually keeps)
 *
 * The tier is resolved from `profiles.is_pro` with the service-role key, never
 * from anything the client sends. A request that asks for a window older than
 * its tier allows is answered with 403 and the window it *could* have had, so
 * the client can offer the upgrade instead of failing blankly.
 *
 * Why the window is capped as well as the lookback
 * ------------------------------------------------
 * "14 days of playback" is a lookback, not a payload. Nobody can watch two
 * weeks of world traffic in one buffer, and nothing could hold it: a busy hour
 * is thousands of flights. So a request asks for a *span* (up to MAX_SPAN),
 * positioned anywhere inside the tier's lookback. Pro's advantage is where the
 * window may sit, not how much comes back at once.
 *
 * Staying inside the memory budget
 * --------------------------------
 * Three things keep a request bounded, in the order they bite:
 *
 *   1. The candidate count is read from the index *before* the walk, so the
 *      sampling interval can be sized to the traffic actually in the window.
 *      A quiet 03:00Z window gets fine detail; a peak-hour window gets a
 *      coarser step rather than a refused request.
 *   2. Trails are streamed one at a time through forEachFlightForReplay, so
 *      peak memory is one decoded trail plus the sampled output — never the
 *      whole window.
 *   3. A hard point budget stops the walk and flags `truncated`, so a
 *      pathological window degrades into a partial answer instead of an OOM.
 */

'use strict';

const {
  forEachFlightForReplay,
  countFlightsForReplay,
  RETENTION_WINDOW_MS
} = require('./history.cjs');

const intEnv = (name, dflt) => {
  const parsed = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : dflt;
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// The tiered lookback. Pro is clamped to what the recorder still holds — there
// is no point advertising fourteen days if HISTORY_RETENTION_HOURS was turned
// down to three, and a pilot who is sold "14 days" and handed an empty map has
// been sold nothing.
const FREE_LOOKBACK_MS = intEnv('PLAYBACK_FREE_LOOKBACK_HOURS', 24) * HOUR_MS;
const PRO_LOOKBACK_MS = Math.min(
  intEnv('PLAYBACK_PRO_LOOKBACK_DAYS', 14) * DAY_MS,
  RETENTION_WINDOW_MS
);

// How much wall-clock time one request may cover. Identical for both tiers:
// the paid difference is *when* you can look, not how much lands in one
// response. Keeping them the same also means a Pro request costs the server no
// more than a free one.
const MAX_SPAN_MS = intEnv('PLAYBACK_MAX_SPAN_HOURS', 6) * HOUR_MS;
const MIN_SPAN_MS = 60 * 1000;

// The recorder samples a flight about every 15 seconds, so asking for finer
// resolution than that returns duplicate points and nothing else.
const MIN_STEP_MS = intEnv('PLAYBACK_MIN_STEP_SECONDS', 15) * 1000;

// Hard ceilings. Both are deliberately generous enough that an ordinary window
// never meets them and low enough that a hostile one cannot exhaust the heap.
const POINT_BUDGET = intEnv('PLAYBACK_POINT_BUDGET', 150000);
const MAX_FLIGHTS = intEnv('PLAYBACK_MAX_FLIGHTS', 3000);

// A flight needs two in-window samples to be worth replaying: one point cannot
// move, and a frozen aircraft sitting on the map for the whole window reads as
// a bug rather than as data.
const MIN_POINTS = 2;

/* =========================
 * Tier limits
 * ========================= */

/**
 * What this caller is allowed to ask for.
 *
 * `now` is a parameter rather than a call to Date.now() so the limits a
 * response reports and the limits it was validated against are the same
 * instant — a request that straddles a millisecond boundary should not be
 * told it asked for something outside a window it was just granted.
 */
function limitsFor(isPro, now = Date.now()) {
  const lookbackMs = isPro ? PRO_LOOKBACK_MS : FREE_LOOKBACK_MS;
  return {
    tier: isPro ? 'pro' : 'free',
    lookbackMs,
    earliest: now - lookbackMs,
    latest: now,
    maxSpanMs: MAX_SPAN_MS,
    minSpanMs: MIN_SPAN_MS,
    minStepMs: MIN_STEP_MS,
    // What the *other* tier gets, so the client can render an honest upgrade
    // prompt without hard-coding the numbers in two places.
    proLookbackMs: PRO_LOOKBACK_MS,
    freeLookbackMs: FREE_LOOKBACK_MS
  };
}

/**
 * Validate a requested window against a tier.
 *
 * Returns either `{ ok: true, start, end }` with the window clamped to
 * something servable, or `{ ok: false, status, message, limits }` — where
 * `status` is 400 for a window that is malformed and 403 for one that is
 * well-formed but reaches further back than the tier allows. The client needs
 * to tell those apart: only the second one is worth showing an upgrade for.
 */
function resolveWindow({ startMs, endMs, isPro, now = Date.now() }) {
  const limits = limitsFor(isPro, now);

  if (!Number.isFinite(startMs)) {
    return { ok: false, status: 400, message: 'A numeric `start` (epoch ms) is required.', limits };
  }

  // An open-ended request means "a full span starting there", which is what a
  // client that only knows where it wants to begin should have to say.
  let start = Math.round(startMs);
  let end = Number.isFinite(endMs) ? Math.round(endMs) : start + MAX_SPAN_MS;

  if (end <= start) {
    return { ok: false, status: 400, message: '`end` must be later than `start`.', limits };
  }
  if (end - start < MIN_SPAN_MS) {
    return {
      ok: false,
      status: 400,
      message: `A playback window must cover at least ${Math.round(MIN_SPAN_MS / 1000)}s.`,
      limits
    };
  }

  // Asking for the future is not an error, it is just empty — clamp instead of
  // rejecting, so a client whose clock runs fast still gets its last minutes.
  if (end > limits.latest) end = limits.latest;
  if (end <= start) {
    return { ok: false, status: 400, message: 'That window has not happened yet.', limits };
  }

  // The tier line. Note this is checked on `start`: a window that *begins*
  // inside the allowance is served in full, so a free user asking for the last
  // hour never trips it.
  if (start < limits.earliest) {
    return {
      ok: false,
      status: 403,
      message: isPro
        ? `Recorded history reaches back ${Math.round(limits.lookbackMs / DAY_MS)} days.`
        : 'Free playback covers the last 24 hours. Inflight Pro reaches back 14 days.',
      limits
    };
  }

  // Trim an over-long span from the far end, keeping the start the user chose —
  // they picked a moment to watch from, not a moment to watch until.
  if (end - start > MAX_SPAN_MS) end = start + MAX_SPAN_MS;

  return { ok: true, start, end, limits };
}

/* =========================
 * Sampling
 * ========================= */

/**
 * Pick a sampling interval that fits the window's traffic inside the point
 * budget, rounded up to a whole number of MIN_STEP_MS so the samples land on a
 * regular grid.
 *
 * `candidates` is the indexed row count, which over-counts: it includes flights
 * whose trails only clip the window. Over-counting is the safe direction — it
 * yields a slightly coarser step, never a blown budget.
 */
function stepForWindow(spanMs, candidates) {
  const flights = Math.min(Math.max(candidates, 1), MAX_FLIGHTS);
  const perFlight = Math.max(MIN_POINTS, Math.floor(POINT_BUDGET / flights));
  const raw = Math.ceil(spanMs / perFlight);
  const step = Math.max(MIN_STEP_MS, Math.ceil(raw / MIN_STEP_MS) * MIN_STEP_MS);
  // Never so coarse that the window itself can't hold two samples.
  return Math.min(step, Math.max(MIN_STEP_MS, Math.floor(spanMs / MIN_POINTS)));
}

/**
 * Thin a trail to one point per `stepMs`, keeping the first and last in-window
 * samples whatever the arithmetic says.
 *
 * Keeping the ends matters more than it looks: they are where a flight enters
 * and leaves the window, so dropping them makes aircraft appear late and vanish
 * early — the two artefacts that make a replay feel broken.
 */
function sampleTrail(path, startMs, endMs, stepMs, bbox) {
  const out = [];
  let nextAt = startMs;
  let pending = null;

  for (const p of path) {
    if (p.time < startMs) continue;
    if (p.time > endMs) break;
    if (bbox && !insideBbox(p.lat, p.lon, bbox)) continue;

    if (p.time >= nextAt) {
      out.push(p);
      // Advance to the first grid slot after this point rather than by one
      // step, so a gap in the recording doesn't leave the grid trailing behind
      // and emit a burst of consecutive points when it resumes.
      nextAt = startMs + Math.ceil((p.time - startMs + 1) / stepMs) * stepMs;
      pending = null;
    } else {
      pending = p;
    }
  }

  // The last real sample, if the grid happened to skip it.
  if (pending && (out.length === 0 || pending.time > out[out.length - 1].time)) {
    out.push(pending);
  }
  return out;
}

/* =========================
 * Geography
 * ========================= */

/**
 * Parse a `west,south,east,north` bounding box.
 *
 * A box whose west edge is greater than its east edge is not malformed — it
 * crosses the antimeridian, which is exactly what a Pacific view looks like
 * after a pan. That case is carried through as a flag rather than rejected or,
 * worse, silently inverted into a box covering the rest of the planet.
 */
function parseBbox(raw) {
  if (!raw) return null;
  const parts = String(raw).split(',').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) return null;
  const [west, south, east, north] = parts;
  if (south > north) return null;
  if (south < -90 || north > 90) return null;
  return { west, south, east, north, wraps: west > east };
}

function insideBbox(lat, lon, box) {
  if (lat < box.south || lat > box.north) return false;
  return box.wraps
    ? (lon >= box.west || lon <= box.east)
    : (lon >= box.west && lon <= box.east);
}

/* =========================
 * Payload
 * ========================= */

/**
 * Points go out as fixed-shape tuples:
 *
 *   [ dt, lat, lon, alt, gs, hdg ]
 *
 * `dt` is whole seconds from the window start, not an epoch — thirteen digits
 * per point, on the field that repeats most, is most of the payload for no
 * information. Everything else is already integral at rest.
 */
function packPoint(p, startMs) {
  return [
    Math.round((p.time - startMs) / 1000),
    p.lat,
    p.lon,
    Math.round(p.alt || 0),
    Math.round(p.gs || 0),
    Math.round(p.hdg || 0)
  ];
}

/**
 * Build one global playback window.
 *
 * @param {object} opts
 * @param {number} opts.start        window start, epoch ms (already validated)
 * @param {number} opts.end          window end, epoch ms
 * @param {string} [opts.sessionId]  restrict to one Infinite Flight server
 * @param {object} [opts.bbox]       parsed bounding box, or null for the world
 * @returns {object} the response body, minus the tier fields the route adds
 */
function buildWindow({ start, end, sessionId = null, bbox = null }) {
  const spanMs = end - start;
  const candidates = countFlightsForReplay(start, end);
  const stepMs = stepForWindow(spanMs, candidates);

  const flights = [];
  let pointCount = 0;
  let truncated = false;
  let skippedServer = 0;

  forEachFlightForReplay(start, end, (f) => {
    // Returning false stops the walk, so the budget is spent on building the
    // answer rather than on decoding trails that will never be sent.
    if (flights.length >= MAX_FLIGHTS || pointCount >= POINT_BUDGET) {
      truncated = true;
      return false;
    }

    // Server scoping. A row recorded before sessionId existed has none, and is
    // excluded from a scoped request rather than guessed at — putting a Casual
    // flight into an Expert replay is worse than leaving it out.
    if (sessionId && f.sessionId !== sessionId) {
      skippedServer++;
      return;
    }

    if (!Array.isArray(f.path) || f.path.length < MIN_POINTS) return;

    const sampled = sampleTrail(f.path, start, end, stepMs, bbox);
    if (sampled.length < MIN_POINTS) return;

    const ac = f.aircraft || {};
    flights.push({
      flightId: f.flightId,
      userId: f.userId || null,
      callsign: f.callsign || '',
      username: f.username || null,
      aircraft: {
        aircraftId: ac.aircraftId || null,
        liveryId: ac.liveryId || null,
        aircraftName: ac.aircraftName || null,
        liveryName: ac.liveryName || null
      },
      path: sampled.map(p => packPoint(p, start))
    });
    pointCount += sampled.length;
  });

  // Chronological by first appearance: the client draws them in this order, and
  // a stable order means two fetches of the same window render identically.
  flights.sort((a, b) => a.path[0][0] - b.path[0][0]);

  return {
    window: { start, end, stepMs, spanMs },
    sessionId,
    bbox: bbox ? { west: bbox.west, south: bbox.south, east: bbox.east, north: bbox.north } : null,
    flightCount: flights.length,
    pointCount,
    candidateCount: candidates,
    skippedOtherServers: skippedServer,
    truncated,
    flights
  };
}

module.exports = {
  limitsFor,
  resolveWindow,
  buildWindow,
  parseBbox,
  // Exercised directly by global_playback.test.cjs, which asserts on the
  // sampling grid and the antimeridian case rather than only on a whole
  // response.
  _internals: { sampleTrail, stepForWindow, insideBbox, MAX_SPAN_MS, MIN_STEP_MS, POINT_BUDGET, MAX_FLIGHTS }
};
