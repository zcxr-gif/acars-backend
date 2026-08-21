/* =========================
 * Friend events (takeoff / landing / online / offline)
 * =========================
 * The watchlist's presence engine already knows when a watched pilot appears
 * and disappears. This adds the two events people actually wait for — the
 * moment a friend leaves the ground, and the moment they touch back down —
 * by diffing consecutive snapshots the same way `va_filter.cjs` does for VA
 * announcements.
 *
 * Deliberately the same detector as the VA path (`va_filter.airborneState`,
 * plus the same confirm-snapshots hysteresis) rather than a second opinion:
 * two ways of deciding what "airborne" means is two sets of false positives to
 * chase, and that detector has already been tuned against real traffic — it is
 * why a flight cruising at FL330 with a garbage groundspeed reading no longer
 * announces a landing.
 *
 * What is different is the scope. The VA engine watches every flight matching
 * a VA callsign; this one only ever holds state for pilots somebody is
 * actually watching, so the cost is set by the size of the watchlists rather
 * than by the size of the server.
 *
 * Env:
 *   FRIEND_CONFIRM_SNAPSHOTS   consecutive readings before a flip commits (2)
 *   FRIEND_EVENTS_ENABLED      0/false to detect nothing
 */

const vaFilter = require('./va_filter.cjs');
const push = require('./push.cjs');
const supabase = require('./supabase.cjs');

const CONFIRM_SNAPSHOTS = Math.max(1, Number(process.env.FRIEND_CONFIRM_SNAPSHOTS) || 2);

function enabled() {
  const v = String(process.env.FRIEND_EVENTS_ENABLED ?? '').trim().toLowerCase();
  if (!v) return true;
  return !['0', 'false', 'no', 'off'].includes(v);
}

/* =========================
 * Who is being watched
 * ========================= */

// The union of every watchlist, refreshed on a timer rather than per snapshot:
// the device registry is a local SQLite read, but the account-scoped half is a
// Supabase round trip and the poller runs every few seconds.
let watchedCache = new Set();
let watchedFetchedAt = 0;
const WATCHED_TTL_MS = 60 * 1000;
let watchedInFlight = null;

// Usernames subscribed by a live socket but not stored anywhere — a client
// watching the feed without having registered for pushes still deserves the
// takeoff event on its socket.
let ephemeral = new Set();

function setEphemeralWatched(usernames) {
  ephemeral = usernames instanceof Set ? usernames : new Set(usernames || []);
}

async function refreshWatched() {
  const merged = new Set(push.watchedUsernames());
  if (supabase.hasServiceKey()) {
    try {
      for (const name of await supabase.listAllWatchedUsernames()) merged.add(name);
    } catch (e) {
      console.warn('[friend-events] ⚠️ Watchlist refresh failed:', e.message);
      // Keep the previous set rather than going blind for a minute.
      for (const name of watchedCache) merged.add(name);
    }
  }
  watchedCache = merged;
  watchedFetchedAt = Date.now();
  return watchedCache;
}

// Never awaited on the poll path: a refresh that is due kicks off in the
// background and the current set is used for this snapshot. Being one cycle
// late to notice a newly added friend is not worth stalling the poller for.
function watchedSet() {
  if (Date.now() - watchedFetchedAt > WATCHED_TTL_MS && !watchedInFlight) {
    watchedInFlight = refreshWatched()
      .catch(() => {})
      .finally(() => { watchedInFlight = null; });
  }
  return watchedCache;
}

function isWatched(lowerUsername) {
  return watchedCache.has(lowerUsername) || ephemeral.has(lowerUsername);
}

/* =========================
 * Ground/air transition engine
 * ========================= */

// Keyed by flightId, not by username: a pilot who ends one flight and starts
// another gets a fresh key, which re-seeds their state. That is what stops a
// pilot who respawns already airborne from announcing a takeoff they didn't
// make.
const committed = new Map(); // flightId -> bool airborne (last confirmed)
const pending = new Map(); // flightId -> { air: bool, n: int }

/**
 * Diff one snapshot of the feed.
 *
 * Takes flights rather than a username -> flight map, and that is not a
 * tidying-up. The map was built by the caller with `present.set(username,
 * flight)`, so a pilot the feed reported twice — they are on more than one
 * server, or one server is reporting a stale session alongside the live one —
 * kept whichever aeroplane the packet happened to mention last. The other one
 * was invisible to this engine: no takeoff, no landing, nothing. State here is
 * keyed by flight id and always was, so it handles several per pilot perfectly
 * well once it is allowed to see them.
 *
 * @param {Iterable<object>} flights  live flights, in any order
 * @param {(type: string, username: string, flight: object|null) => void} emit
 */
function processPresent(flights, emit) {
  if (!enabled()) return;

  watchedSet(); // refreshes in the background when stale
  const liveIds = new Set();

  for (const flight of flights) {
    if (!flight?.flightId) continue;
    const lower = String(flight.username || '').toLowerCase();
    if (!lower) continue;
    if (!isWatched(lower)) continue;
    liveIds.add(flight.flightId);

    const current = vaFilter.airborneState(flight.position);
    if (current === null) continue; // no usable reading — hold the last state

    const previous = committed.get(flight.flightId);
    if (previous === undefined) {
      committed.set(flight.flightId, current);
      continue;
    }
    if (current === previous) {
      pending.delete(flight.flightId); // stable again — cancel any pending flip
      continue;
    }

    let flip = pending.get(flight.flightId);
    if (!flip || flip.air !== current) {
      flip = { air: current, n: 1 };
      pending.set(flight.flightId, flip);
    } else {
      flip.n += 1;
    }

    if (flip.n >= CONFIRM_SNAPSHOTS) {
      committed.set(flight.flightId, current);
      pending.delete(flight.flightId);
      emit(current ? 'takeoff' : 'landing', flight.username || lower, flight);
    }
  }

  // A pilot who disconnects mid-air produces no landing — we only ever fire on
  // an observed air→ground change, never on an absence.
  for (const id of committed.keys()) if (!liveIds.has(id)) committed.delete(id);
  for (const id of pending.keys()) if (!liveIds.has(id)) pending.delete(id);
}

/** Diagnostics for the admin dashboard. */
function stats() {
  return {
    enabled: enabled(),
    watched: watchedCache.size,
    ephemeral: ephemeral.size,
    tracking: committed.size,
    pendingFlips: pending.size,
    confirmSnapshots: CONFIRM_SNAPSHOTS,
  };
}

module.exports = {
  processPresent,
  setEphemeralWatched,
  refreshWatched,
  stats,
};
