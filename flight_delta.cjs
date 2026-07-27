/* =========================
 * flight_delta.cjs — delta encoder for the live flight broadcast
 * =========================
 *
 * WHY
 * ---
 * `all_flights_update` ships the full simplified flight list to every client
 * on every poll. On a busy Expert Server that is ~900 flights ≈ 600 KB of JSON
 * every 15s, per client — ~140 MB/hour each. Almost all of it is unchanged:
 * a flight's id, callsign, username, VA fields and airframe never move for the
 * life of the flight, and a parked aircraft's position doesn't either.
 *
 * This module keeps, per IF session, the last snapshot we broadcast and emits
 * only what actually changed. Combined with permessage-deflate that takes the
 * same tick from ~600 KB to ~20 KB.
 *
 * WIRE FORMAT
 * -----------
 * Keys are short because they repeat once per aircraft.
 *
 *   all_flights_sync   { server, sessionId, t, q, c, f: [[slot, flight], …] }
 *     Full state plus the slot assignments. Sent when a client joins the delta
 *     room and whenever it asks to resync. `q` is the sequence it is now at.
 *
 *   all_flights_delta  { server, sessionId, t, q, b, c, a, p, m, r }
 *     q  sequence of this packet, b = the sequence it applies on top of.
 *        A client whose last applied sequence != b has missed a packet and
 *        must request a resync.
 *     c  total flight count after the delta is applied (sanity check).
 *     a  added flights:   [[slot, flight], …]      (full objects)
 *     p  moved flights:   [[slot, lat, lon, alt_ft, gs_kt, vs_fpm,
 *                          heading_deg, lastReportMs], …]
 *     m  changed fields:  [[slot, {partial}], …]   (rare: callsign/route/VA)
 *     r  removed flights: [slot, …]
 *
 * A "slot" is a small integer this module assigns to a flight for the life of
 * that flight, so position updates cost ~3 characters of identifier instead of
 * a 36-character GUID. Slots are recycled once a flight leaves.
 *
 * `lastReport` is not sent — the client reconstructs it from `lastReportMs`,
 * which every consumer in the tracker already accepts in place of the string.
 */

// Rounding applied before both diffing and sending. Doing it before the diff is
// the point: a parked aircraft whose floats jitter in the last decimal place
// then produces no update at all. The precision left is far finer than anything
// the map can render — lat/lon to ~0.1 m, heading to 1/100°.
const POS_ROUND = {
  lat: 1e6,
  lon: 1e6,
  alt_ft: 10,
  gs_kt: 10,
  vs_fpm: 1,
  heading_deg: 100,
};

// Scalar fields compared to decide whether a flight needs a metadata update.
// These change rarely (a callsign edit, a flight plan filed mid-flight, the VA
// roster poll landing) but they do change, so they can't just ride the `add`.
const META_FIELDS = [
  'userId', 'callsign', 'username', 'virtualOrganization',
  'arrivalIcao', 'departureIcao', 'isVAMember', 'isStaff', 'vaRole',
  'pilotState', 'isConnected',
];

const AIRCRAFT_FIELDS = ['aircraftId', 'liveryId', 'aircraftName', 'liveryName'];

function round(v, factor) {
  return (typeof v === 'number' && isFinite(v)) ? Math.round(v * factor) / factor : null;
}

/**
 * Strip a simplified flight down to what goes on the wire, with positions
 * rounded so the diff below is stable.
 */
function toWire(f) {
  const p = f.position || {};
  const a = f.aircraft || {};
  const wire = {
    flightId: f.flightId,
    position: {
      lat: round(p.lat, POS_ROUND.lat),
      lon: round(p.lon, POS_ROUND.lon),
      alt_ft: round(p.alt_ft, POS_ROUND.alt_ft),
      gs_kt: round(p.gs_kt, POS_ROUND.gs_kt),
      vs_fpm: round(p.vs_fpm, POS_ROUND.vs_fpm),
      heading_deg: round(p.heading_deg, POS_ROUND.heading_deg),
      lastReportMs: typeof p.lastReportMs === 'number' ? p.lastReportMs : null,
    },
    aircraft: {
      aircraftId: a.aircraftId ?? null,
      liveryId: a.liveryId ?? null,
      aircraftName: a.aircraftName ?? null,
      liveryName: a.liveryName ?? null,
    },
  };
  for (const k of META_FIELDS) wire[k] = f[k] ?? null;
  return wire;
}

function positionChanged(a, b) {
  return a.lat !== b.lat || a.lon !== b.lon || a.alt_ft !== b.alt_ft ||
         a.gs_kt !== b.gs_kt || a.vs_fpm !== b.vs_fpm ||
         a.heading_deg !== b.heading_deg || a.lastReportMs !== b.lastReportMs;
}

/**
 * Fields that differ between the previously sent flight and the new one, or
 * null when nothing outside the position moved.
 */
function diffMeta(prev, next) {
  let changed = null;
  for (const k of META_FIELDS) {
    if (prev[k] !== next[k]) (changed || (changed = {}))[k] = next[k];
  }
  let acChanged = null;
  for (const k of AIRCRAFT_FIELDS) {
    if (prev.aircraft[k] !== next.aircraft[k]) (acChanged || (acChanged = {}))[k] = next.aircraft[k];
  }
  if (acChanged) (changed || (changed = {})).aircraft = acChanged;
  return changed;
}

/* =========================
 * Per-session state
 * ========================= */

// sessionId -> { seq, nextSlot, freeSlots, bySlot, byFlightId, server, t, count }
const states = new Map();

// Rolling counters for the diagnostics endpoint.
const stats = { deltas: 0, syncs: 0, resyncs: 0, samples: 0, wireBytes: 0, fullBytes: 0 };

function getState(sessionId) {
  let st = states.get(sessionId);
  if (!st) {
    st = {
      seq: 0,
      nextSlot: 1,
      freeSlots: [],
      bySlot: new Map(),      // slot -> last sent wire object
      byFlightId: new Map(),  // flightId -> slot
      server: null,
      t: null,
      count: 0,
    };
    states.set(sessionId, st);
  }
  return st;
}

function takeSlot(st) {
  return st.freeSlots.length > 0 ? st.freeSlots.pop() : st.nextSlot++;
}

/**
 * Diff `flights` against the last state for this session and return a delta
 * packet, or null when nothing changed (in which case the sequence does not
 * advance and nothing should be emitted).
 *
 * @param {string} sessionId
 * @param {string} serverName
 * @param {Array<object>} flights - output of simplifyFlight()
 * @param {string} timestamp - the payload's ISO timestamp
 */
function encode(sessionId, serverName, flights, timestamp) {
  const st = getState(sessionId);
  st.server = serverName;
  st.t = timestamp;

  const add = [];
  const pos = [];
  const meta = [];
  const seen = new Set();

  for (const f of flights) {
    const id = f?.flightId;
    if (!id) continue;
    seen.add(id);

    const next = toWire(f);
    let slot = st.byFlightId.get(id);

    if (slot === undefined) {
      slot = takeSlot(st);
      st.byFlightId.set(id, slot);
      st.bySlot.set(slot, next);
      add.push([slot, next]);
      continue;
    }

    const prev = st.bySlot.get(slot);
    st.bySlot.set(slot, next);

    if (!prev) {
      // Shouldn't happen; re-send the whole flight so the client can't drift.
      add.push([slot, next]);
      continue;
    }

    if (positionChanged(prev.position, next.position)) {
      const p = next.position;
      pos.push([slot, p.lat, p.lon, p.alt_ft, p.gs_kt, p.vs_fpm, p.heading_deg, p.lastReportMs]);
    }
    const changed = diffMeta(prev, next);
    if (changed) meta.push([slot, changed]);
  }

  const rm = [];
  for (const [id, slot] of st.byFlightId) {
    if (seen.has(id)) continue;
    rm.push(slot);
    st.byFlightId.delete(id);
    st.bySlot.delete(slot);
    st.freeSlots.push(slot);
  }

  st.count = st.byFlightId.size;

  if (add.length === 0 && pos.length === 0 && meta.length === 0 && rm.length === 0) {
    return null; // Nothing moved — don't burn a packet or a sequence number.
  }

  const base = st.seq;
  st.seq = base + 1;
  stats.deltas++;

  return {
    server: serverName,
    sessionId,
    t: timestamp,
    q: st.seq,
    b: base,
    c: st.count,
    a: add,
    p: pos,
    m: meta,
    r: rm,
  };
}

/**
 * Full state for a client that just joined (or fell behind). Returns null when
 * this session has no state yet — the caller should seed() first.
 */
function sync(sessionId) {
  const st = states.get(sessionId);
  if (!st) return null;

  const f = new Array(st.bySlot.size);
  let i = 0;
  for (const [slot, wire] of st.bySlot) f[i++] = [slot, wire];

  stats.syncs++;
  return {
    server: st.server,
    sessionId,
    t: st.t,
    q: st.seq,
    c: st.count,
    f,
  };
}

/**
 * Build state from a cached full payload so the very first client to ask for
 * deltas can be answered without waiting for the next poll.
 */
function seed(sessionId, serverName, payload) {
  states.delete(sessionId);
  const st = getState(sessionId);
  st.server = serverName || payload?.server || null;
  st.t = payload?.timestamp || new Date().toISOString();

  for (const f of (payload?.flights || [])) {
    const id = f?.flightId;
    if (!id || st.byFlightId.has(id)) continue;
    const slot = takeSlot(st);
    st.byFlightId.set(id, slot);
    st.bySlot.set(slot, toWire(f));
  }
  st.count = st.byFlightId.size;
  return st;
}

function has(sessionId) {
  return states.has(sessionId);
}

function drop(sessionId) {
  states.delete(sessionId);
}

/** Drop state for IF sessions that no longer exist (they rotate GUIDs). */
function pruneSessions(liveSessionIds) {
  for (const id of states.keys()) {
    if (!liveSessionIds.has(id)) states.delete(id);
  }
}

function noteResync() {
  stats.resyncs++;
}

// Measuring the saving costs a second serialisation of the full payload, so it
// runs on one delta in SAMPLE_EVERY rather than all of them. The ratio is what
// matters and it is stable across ticks.
const SAMPLE_EVERY = 20;
let sampleCounter = 0;

function shouldSample() {
  return (++sampleCounter % SAMPLE_EVERY) === 0;
}

/** Record how many bytes a delta saved versus the full payload it replaced. */
function noteSavings(deltaBytes, fullBytes) {
  stats.wireBytes += deltaBytes;
  stats.fullBytes += fullBytes;
  stats.samples++;
}

function snapshot() {
  const sessions = {};
  for (const [id, st] of states) {
    sessions[id] = { server: st.server, seq: st.seq, tracked: st.byFlightId.size, slots: st.nextSlot - 1 };
  }
  const saved = stats.fullBytes > 0
    ? +(100 - (stats.wireBytes / stats.fullBytes) * 100).toFixed(1)
    : null;
  return { ...stats, savedPct: saved, sessions };
}

module.exports = {
  encode,
  sync,
  seed,
  has,
  drop,
  pruneSessions,
  noteResync,
  shouldSample,
  noteSavings,
  snapshot,
};
