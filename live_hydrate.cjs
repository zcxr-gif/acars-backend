/* =========================
 * Live status hydration — keeping a Connect flight on the map
 * =========================
 * Infinite Flight Connect is a LAN API served by the sim to whatever is on the
 * same Wi-Fi, so only the pilot's own device can read it. On a phone, the
 * moment they switch to Infinite Flight, iOS suspends Inflight and the socket
 * dies with it. There is no honest way around that — the background modes that
 * hold a socket open for fourteen hours are `audio` and `location`, and
 * claiming either to poll a flight simulator would be a lie to the user and to
 * App Review.
 *
 * The consequence was that a pilot who turned broadcasting on vanished from
 * everybody else's friends list about four minutes into the flight, at exactly
 * the point it got interesting.
 *
 * This is the half the server CAN do. `pilot_live_status.flight_id` is the same
 * id the public feed uses — that join is the whole reason the app reads it out
 * of the sim — so the aeroplane whose telemetry just went quiet is one this
 * process is already holding in memory, twice a minute, for every server. So it
 * refreshes the position from there and leaves everything Connect exists for
 * exactly as the sim last reported it, dated by `sim_live_at`.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 *   - Create a row. Hydration finds rows; the pilot's share switch is the only
 *     thing that makes one, and turning it off still deletes.
 *   - Overwrite a sim that is still talking. The database gates that, not this
 *     file: the sim samples four times a second against the feed's fifteen.
 *   - Invent fuel, gear, flaps, lights or the wind at the aircraft. The feed
 *     cannot see any of it, and a plausible guess is worse than a timestamp.
 *
 * The second job here is the notice. A pilot whose Connect link drops mid-flight
 * currently finds out when they next open the app — the one moment they can see
 * it on screen anyway, since the app is too deeply suspended to retry or to
 * announce a retry. The server can see the drop, so the server is what says so:
 * once per flight, to the pilot's own devices, and never to anyone who has not
 * had Connect working on this flight already.
 *
 * Env:
 *   LIVE_HYDRATION_ENABLED     0/false to hydrate nothing
 *   LIVE_HYDRATION_INTERVAL_MS how often a snapshot is posted (30000)
 *   CONNECT_ALERTS_ENABLED     0/false to never send the drop notice
 */

const push = require('./push.cjs');
const supabase = require('./supabase.cjs');

const HYDRATE_INTERVAL_MS = Math.max(
  5000,
  Number(process.env.LIVE_HYDRATION_INTERVAL_MS) || 30 * 1000
);

// How often the set of flight ids worth matching is re-read. Deliberately
// slower than the poller: a pilot who has only just started broadcasting waits
// at most a minute to be picked up, and the position TTL is four.
const WATCHED_TTL_MS = 60 * 1000;

function flagEnabled(name) {
  const v = String(process.env[name] ?? '').trim().toLowerCase();
  if (!v) return true;
  return !['0', 'false', 'no', 'off'].includes(v);
}

/* =========================
 * Which flights are worth matching
 * ========================= */

let watched = new Set(); // flight ids with a broadcasting pilot behind them
let watchedFetchedAt = 0;
let watchedInFlight = null;

async function refreshWatched() {
  const rows = await supabase.rpc('pilot_live_hydratable', {});
  const next = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (typeof row?.flight_id === 'string' && row.flight_id) next.add(row.flight_id);
  }
  watched = next;
  watchedFetchedAt = Date.now();
  return watched;
}

// Never awaited on the poll path. A refresh that is due kicks off in the
// background and this snapshot uses the set we already have — being one cycle
// behind a pilot who just switched broadcasting on costs them thirty seconds of
// a fourteen-hour flight.
function watchedSet() {
  if (Date.now() - watchedFetchedAt > WATCHED_TTL_MS && !watchedInFlight) {
    watchedInFlight = refreshWatched()
      .catch((e) => {
        console.warn('[hydrate] ⚠️ Could not refresh broadcast flights:', e.message);
      })
      .finally(() => { watchedInFlight = null; });
  }
  return watched;
}

/* =========================
 * Reading a position off the feed
 * ========================= */

function clampInt(value, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * One feed flight, in the shape `pilot_live_hydrate` takes.
 *
 * Everything is clamped to the column's own check constraint rather than left
 * to the database to reject. The whole snapshot goes in as a single statement,
 * so one aircraft reporting a heading of 4,000,000 degrees would otherwise take
 * every other pilot's position down with it.
 */
function hydrationRow(flightId, flight) {
  const p = flight?.position;
  if (!p) return null;

  const lat = typeof p.lat === 'number' ? p.lat : null;
  const lon = typeof p.lon === 'number' ? p.lon : null;
  if (lat === null || lon === null) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  // Headings arrive as 0–360 and occasionally as a negative or a value just
  // over the top; `((x % 360) + 360) % 360` is the one normalisation that is
  // right for both rather than a clamp that would pin 361° to due north's
  // opposite.
  const heading = typeof p.heading_deg === 'number' && Number.isFinite(p.heading_deg)
    ? Math.round(((p.heading_deg % 360) + 360) % 360)
    : null;

  return {
    flight_id: flightId,
    latitude: lat,
    longitude: lon,
    altitude_msl: clampInt(p.alt_ft, -2000, 90000),
    heading,
    ground_speed_knots: clampInt(p.gs_kt, 0, 1200),
    vertical_speed_fpm: clampInt(p.vs_fpm, -30000, 30000),
  };
}

/* =========================
 * The pass
 * ========================= */

let lastRunAt = 0;
let inFlight = false;
const stat = { matched: 0, hydrated: 0, alerts: 0, lastRunAt: 0, lastError: null };

/**
 * Fed the same `flightId -> flight` map the Live Activity updates already get,
 * after each broadcast poll.
 *
 * Rate-limited rather than run every poll: the position TTL is four minutes and
 * the poller runs every few seconds, so a write every thirty seconds is well
 * inside it and is 1/10th of the row versions.
 *
 * @param {Map<string, object>} byFlightId
 */
function processSnapshot(byFlightId) {
  if (!flagEnabled('LIVE_HYDRATION_ENABLED')) return;
  if (!supabase.hasServiceKey()) return;
  if (!(byFlightId instanceof Map) || byFlightId.size === 0) return;

  const ids = watchedSet();
  if (ids.size === 0) return;

  // Never two passes at once. A slow Supabase round trip must not stack a
  // queue of snapshots that were already stale when they were built.
  if (inFlight) return;
  if (Date.now() - lastRunAt < HYDRATE_INTERVAL_MS) return;

  const rows = [];
  for (const id of ids) {
    const flight = byFlightId.get(id);
    if (!flight) continue; // on the feed's books but not in the air right now
    const row = hydrationRow(id, flight);
    if (row) rows.push(row);
  }

  stat.matched = rows.length;
  if (rows.length === 0) {
    lastRunAt = Date.now();
    return;
  }

  inFlight = true;
  lastRunAt = Date.now();

  hydrate(rows)
    .catch((e) => {
      stat.lastError = e.message;
      console.warn('[hydrate] ⚠️ Hydration pass failed:', e.message);
    })
    .finally(() => { inFlight = false; });
}

async function hydrate(rows) {
  const applied = await supabase.rpc('pilot_live_hydrate', { p_rows: rows });
  stat.hydrated = typeof applied === 'number' ? applied : 0;
  stat.lastRunAt = Date.now();
  stat.lastError = null;

  await sendDropNotices(rows.map((r) => r.flight_id));
}

/* =========================
 * "Inflight stopped reading your sim"
 * ========================= */

/**
 * Asked of the database rather than worked out here, because the answer has to
 * survive a redeploy: `pilot_connect_alerts_due` marks each flight as told in
 * the same statement that selects it. A pilot being notified twice on one
 * flight that their sim went quiet is worse than not being notified at all.
 */
async function sendDropNotices(flightIds) {
  if (!flagEnabled('CONNECT_ALERTS_ENABLED')) return;
  if (!push.configured() || flightIds.length === 0) return;

  let due = [];
  try {
    due = await supabase.rpc('pilot_connect_alerts_due', { p_flight_ids: flightIds });
  } catch (e) {
    console.warn('[hydrate] ⚠️ Could not read due Connect alerts:', e.message);
    return;
  }
  if (!Array.isArray(due) || due.length === 0) return;

  for (const row of due) {
    if (!row?.user_id) continue;
    try {
      const sent = await push.notifyAccount(row.user_id, {
        title: 'Inflight stopped reading your sim',
        subtitle: row.callsign || undefined,
        body:
          'Your flight is still on the map, but the fuel, configuration and '
          + 'lights stopped updating when Inflight went into the background. '
          + 'Split View on iPad, or a second device on the same Wi-Fi, keeps '
          + 'the link up for the whole flight.',
        kind: 'connect_dropped',
        // One per flight, matching what the database just recorded, so a
        // retry cannot stack two banners.
        collapseId: `connect-dropped-${row.flight_id}`,
        data: { flightId: row.flight_id || null, handle: row.handle || null },
      });
      if (sent > 0) stat.alerts += 1;
    } catch (e) {
      console.warn('[hydrate] ⚠️ Connect alert push failed:', e.message);
    }
  }
}

/* =========================
 * Diagnostics
 * ========================= */

// Read by `/api/admin/diagnostics`. `watching: 0` means nobody is broadcasting
// with Connect at all; a non-zero `watching` with `matched: 0` means the pilots
// who are have no flight on the feed right now, which is what a table of
// yesterday's rows waiting to be swept looks like.
function stats() {
  return {
    enabled: flagEnabled('LIVE_HYDRATION_ENABLED'),
    alertsEnabled: flagEnabled('CONNECT_ALERTS_ENABLED'),
    watching: watched.size,
    matched: stat.matched,
    hydrated: stat.hydrated,
    alerts: stat.alerts,
    lastRunAt: stat.lastRunAt || null,
    lastError: stat.lastError,
  };
}

module.exports = {
  processSnapshot,
  hydrationRow,
  refreshWatched,
  stats,
};
