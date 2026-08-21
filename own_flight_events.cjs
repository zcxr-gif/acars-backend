/* =========================
 * Your own flight, announced to you
 * =========================
 * The question this exists to answer is why an airline's app can say "boarding
 * has started", "we're climbing out", "cabin crew, seats for landing", and this
 * app could say nothing at all about the flight the pilot was actually flying.
 *
 * It is not that those apps talk to the aeroplane. Nothing in anybody's pocket
 * is attached to an airliner. A server watches a feed describing the whole sky,
 * notices a state change on one row of it, and pushes a sentence to the phones
 * that asked about that row. The phone contributes an address and nothing else,
 * which is exactly why it works while the phone is asleep, on the other side of
 * the world, or — the case that started this — running the simulator itself in
 * the foreground with every other app suspended behind it.
 *
 * Everything needed had been here for months and was pointed the wrong way.
 * `friend_events.cjs` already diffs consecutive snapshots and decides, with
 * hysteresis, when an aircraft has left the ground. `push.notifyAccount` already
 * addresses the person flying rather than the people watching them.
 * `pilot_profiles.if_username` is already the join from a feed row to an
 * account. What was missing is that the detector only ever ran for pilots
 * somebody ELSE was watching, and its notifications went to the watcher. The
 * one person guaranteed to care about a flight — the pilot in it — was the one
 * person nothing was addressed to.
 *
 * ## What it announces, and what it refuses to
 *
 * Three events, chosen because the feed can actually support them:
 *
 *   airborne  — a confirmed ground -> air transition, the same detector the
 *               friend takeoff notice uses.
 *   descent   — the top of descent: a flight that reached a cruise and has now
 *               been coming down for several consecutive snapshots. This is the
 *               seatbelt-sign moment, and it is the one worth a sound.
 *   landed    — a confirmed air -> ground transition.
 *
 * Not announced: anything needing height above ground. The feed carries MSL
 * altitude only, so "on final" is not derivable — an aircraft 2,000 ft over
 * Amsterdam and one 2,000 ft over Denver are the same number and a different
 * situation. Inventing it would produce an announcement that is wrong in
 * mountains, which is worse than an announcement that does not exist.
 *
 * ## Why it will not fire twice, or fire for a flight it did not watch begin
 *
 * State is keyed by `flightId` and seeded on first sighting, exactly as the
 * friend detector is: a pilot already airborne when the poller first sees them
 * — a fresh deploy, a pilot who reconnected mid-cruise — has their state
 * recorded and nothing announced. The descent notice additionally requires
 * having seen the aircraft NOT descending first, so a restart during a descent
 * stays silent rather than announcing a top of descent that happened an hour
 * ago. Each event fires at most once per flight id, and a pilot who ends one
 * flight and starts another gets a new id and a clean slate.
 *
 * Env:
 *   OWN_FLIGHT_ALERTS_ENABLED     0/false to detect nothing
 *   OWN_FLIGHT_CONFIRM_SNAPSHOTS  consecutive readings before a flip commits (2)
 *   OWN_FLIGHT_DESCENT_SNAPSHOTS  consecutive descending readings (3)
 */

const vaFilter = require('./va_filter.cjs');
const supabase = require('./supabase.cjs');

const CONFIRM_SNAPSHOTS = Math.max(1, Number(process.env.OWN_FLIGHT_CONFIRM_SNAPSHOTS) || 2);
const DESCENT_SNAPSHOTS = Math.max(1, Number(process.env.OWN_FLIGHT_DESCENT_SNAPSHOTS) || 3);

// What counts as having reached a cruise worth descending from. A circuit at
// 1,500 ft has a descent too, and nobody wants a "top of descent" notice for
// it — this is the announcement an airliner makes, and it should sound like
// one.
const CRUISE_FLOOR_FT = 12000;

// Sustained enough to be a descent rather than a level-off wobble.
const DESCENT_FPM = -400;

function enabled() {
  const v = String(process.env.OWN_FLIGHT_ALERTS_ENABLED ?? '').trim().toLowerCase();
  if (!v) return true;
  return !['0', 'false', 'no', 'off'].includes(v);
}

/* =========================
 * Who has asked to hear about their own flight
 * ========================= */

// lowercased Infinite Flight handle -> { userId, handle }
//
// Read from `pilot_flight_alert_targets`, which applies the switch and settles
// the one rule that must not be got wrong here: a handle claimed by two
// accounts reaches neither of them, because `if_username` is a claim and not an
// identity. See the migration.
let targets = new Map();
let targetsFetchedAt = 0;
const TARGETS_TTL_MS = 5 * 60 * 1000;

// A failed refresh is retried sooner than a successful one is repeated, but
// only sooner — never on the next snapshot. The poller runs every few seconds,
// and a Supabase outage that made this retry on every one of them would turn a
// broken dependency into a load problem on top of it.
const TARGETS_RETRY_MS = 30 * 1000;

let nextRefreshAt = 0;
let targetsInFlight = null;
let lastTargetsError = null;

async function refreshTargets() {
  // No service key is a configuration, not a failure: the whole feature is off
  // and asking again in five minutes is right. What must not happen is asking
  // again on every snapshot.
  if (!supabase.hasServiceKey()) {
    nextRefreshAt = Date.now() + TARGETS_TTL_MS;
    return targets;
  }

  let rows;
  try {
    rows = await supabase.rpc('pilot_flight_alert_targets', {});
  } catch (e) {
    lastTargetsError = e.message;
    nextRefreshAt = Date.now() + TARGETS_RETRY_MS;
    console.warn('[own-flight] ⚠️ Target refresh failed:', e.message);
    // Keep the previous map rather than going blind until it recovers.
    return targets;
  }

  if (!Array.isArray(rows)) {
    lastTargetsError = 'the target list came back in a shape this cannot read';
    nextRefreshAt = Date.now() + TARGETS_RETRY_MS;
    return targets;
  }

  const next = new Map();
  for (const row of rows) {
    const name = String(row?.if_username || '').trim().toLowerCase();
    if (!name || !row?.user_id) continue;
    next.set(name, { userId: row.user_id, handle: row.handle || null });
  }
  targets = next;
  targetsFetchedAt = Date.now();
  nextRefreshAt = targetsFetchedAt + TARGETS_TTL_MS;
  lastTargetsError = null;
  return targets;
}

// Never awaited on the poll path. Being one cycle late to notice a pilot who
// has just turned the switch on is not worth stalling the poller for.
function targetsSet() {
  if (Date.now() >= nextRefreshAt && !targetsInFlight) {
    targetsInFlight = refreshTargets()
      .catch(() => {})
      .finally(() => { targetsInFlight = null; });
  }
  return targets;
}

/** Test seam: the map without a round trip. */
function setTargets(map) {
  targets = new Map(map instanceof Map ? map : Object.entries(map || {}));
  targetsFetchedAt = Date.now();
  nextRefreshAt = targetsFetchedAt + TARGETS_TTL_MS;
}

/* =========================
 * The state machine
 * ========================= */

// flightId -> {
//   airborne: bool,        last confirmed ground/air state
//   pending: {air, n},     a flip being confirmed
//   reachedCruise: bool,   has been above the cruise floor
//   levelSeen: bool,       has been seen not-descending since reaching it
//   descending: n,         consecutive descending readings
//   told: Set<string>      events already announced for this flight
// }
const flights = new Map();

function stateFor(id) {
  let s = flights.get(id);
  if (!s) {
    s = { airborne: undefined, pending: null, reachedCruise: false, levelSeen: false, descending: 0, told: new Set() };
    flights.set(id, s);
  }
  return s;
}

/**
 * Diff one snapshot of the feed and announce what changed on the pilot's own
 * aeroplane.
 *
 * @param {Map<string, object>} present  lowercased username -> live flight
 * @param {(kind: string, target: object, flight: object) => void} emit
 */
function processPresent(present, emit) {
  if (!enabled()) return;

  targetsSet(); // refreshes in the background when stale
  const liveIds = new Set();

  for (const [lower, flight] of present) {
    if (!flight?.flightId) continue;
    const target = targets.get(lower);
    if (!target) continue; // not somebody who asked, so no state is held for them

    liveIds.add(flight.flightId);
    const state = stateFor(flight.flightId);

    trackGroundAir(state, flight, target, emit);
    trackDescent(state, flight, target, emit);
  }

  // A flight that has left the feed is finished with. Nothing is announced on
  // an absence: a pilot who disconnects mid-air has not landed, and saying so
  // would be the one kind of wrong that is embarrassing rather than merely
  // unhelpful.
  for (const id of flights.keys()) if (!liveIds.has(id)) flights.delete(id);
}

function trackGroundAir(state, flight, target, emit) {
  const current = vaFilter.airborneState(flight.position);
  if (current === null) return; // no usable reading — hold the last state

  if (state.airborne === undefined) {
    // First sighting: record, announce nothing. A pilot already airborne must
    // not produce a takeoff they did not make on this connection.
    state.airborne = current;
    return;
  }

  if (current === state.airborne) {
    state.pending = null; // stable again — cancel any pending flip
    return;
  }

  if (!state.pending || state.pending.air !== current) {
    state.pending = { air: current, n: 1 };
  } else {
    state.pending.n += 1;
  }

  if (state.pending.n < CONFIRM_SNAPSHOTS) return;

  state.airborne = current;
  state.pending = null;
  announce(state, current ? 'airborne' : 'landed', target, flight, emit);
}

function trackDescent(state, flight, target, emit) {
  const alt = flight?.position?.alt_ft;
  const vs = flight?.position?.vs_fpm;
  if (typeof alt !== 'number') return;

  if (alt >= CRUISE_FLOOR_FT) state.reachedCruise = true;
  if (!state.reachedCruise) return;

  if (typeof vs !== 'number') return;

  if (vs > DESCENT_FPM) {
    // Climbing, or level. This is what a descent has to follow, and requiring
    // it is what keeps a restart part-way down the arrival silent.
    state.levelSeen = true;
    state.descending = 0;
    return;
  }

  if (!state.levelSeen) return;

  state.descending += 1;
  if (state.descending < DESCENT_SNAPSHOTS) return;

  announce(state, 'descent', target, flight, emit);
}

function announce(state, kind, target, flight, emit) {
  if (state.told.has(kind)) return;
  state.told.add(kind);
  emit(kind, target, flight);
}

/* =========================
 * What each one says
 * ========================= */

function route(flight) {
  const from = flight?.departureIcao || null;
  const to = flight?.arrivalIcao || null;
  if (from && to) return `${from} → ${to}`;
  if (to) return `to ${to}`;
  if (from) return `out of ${from}`;
  return null;
}

/**
 * The notification for one event, or null for one that should not be sent.
 *
 * Separate from the detector so the wording is testable without a device, and
 * so the two decisions — did this happen, and what do we say about it — are not
 * tangled together.
 */
function compose(kind, flight) {
  const callsign = flight?.callsign || null;
  const where = route(flight);
  const suffix = where ? ` · ${where}` : '';

  switch (kind) {
    case 'airborne':
      return {
        title: 'Airborne',
        subtitle: callsign || undefined,
        body: `You're off the ground${suffix}. Your flight is on the map — it stays there whether or not Inflight is open.`,
        kind: 'own_airborne',
        level: 'active',
        sound: false,
      };
    case 'descent':
      return {
        title: 'Top of descent',
        subtitle: callsign || undefined,
        body: where
          ? `Starting down into ${flight?.arrivalIcao || 'your destination'}. Cabin secure.`
          : 'Starting down. Cabin secure.',
        kind: 'own_descent',
        // The one worth interrupting for, and the reason a pilot in the sim
        // would want any of this: it is the moment there is something to do.
        level: 'active',
        sound: true,
      };
    case 'landed':
      return {
        title: 'On the ground',
        subtitle: callsign || undefined,
        body: flight?.arrivalIcao
          ? `Down at ${flight.arrivalIcao}. Open Inflight to record the landing from the sim.`
          : 'Down. Open Inflight to record the landing from the sim.',
        kind: 'own_landed',
        level: 'passive',
        sound: false,
      };
    default:
      return null;
  }
}

/** Diagnostics for the admin dashboard. */
function stats() {
  return {
    enabled: enabled(),
    targets: targets.size,
    tracking: flights.size,
    confirmSnapshots: CONFIRM_SNAPSHOTS,
    descentSnapshots: DESCENT_SNAPSHOTS,
    targetsAgeMs: targetsFetchedAt ? Date.now() - targetsFetchedAt : null,
    lastError: lastTargetsError,
  };
}

/** Test seam: forget every flight being tracked. */
function reset() {
  flights.clear();
}

module.exports = {
  processPresent,
  compose,
  refreshTargets,
  setTargets,
  stats,
  reset,
};
