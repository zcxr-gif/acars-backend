/* =========================
 * Friends watchlist (capabilities, CRUD, live events)
 * =========================
 * Implements the Inflight client's watchlist contract:
 *   - GET /api/watchlist/capabilities — the master switch the client probes
 *     on boot (no auth, public CORS).
 *   - REST CRUD over the existing Supabase `user_watchlist` table (authed
 *     with the user's Supabase access token) — see supabase.cjs.
 *   - Socket.IO `watchlist_subscribe` / `watchlist_event`: diffs consecutive
 *     all-server flight snapshots and tells subscribed sockets when a watched
 *     pilot goes online/offline. Also triggers APNs pushes (push.cjs).
 *
 * Capability flags can be forced via WATCHLIST_ENABLED /
 * WATCHLIST_EVENTS_ENABLED / PUSH_ENABLED (0/false to disable); by default
 * they reflect what's actually configured, so the probe stays accurate at
 * every rollout stage.
 */

const cors = require('cors');
const supabase = require('./supabase.cjs');
const push = require('./push.cjs');

function boolEnv(name, dflt) {
  const v = String(process.env[name] ?? '').trim().toLowerCase();
  if (!v) return dflt;
  return !['0', 'false', 'no', 'off'].includes(v);
}

function capabilities() {
  return {
    ok: true,
    // CRUD needs Supabase storage AND a way to verify the caller's token.
    watchlist: boolEnv('WATCHLIST_ENABLED', supabase.hasServiceKey() && supabase.canVerifyTokens()),
    // Socket events only need the flight snapshots we already aggregate.
    events: boolEnv('WATCHLIST_EVENTS_ENABLED', true),
    // Never advertise push without working APNs credentials.
    push: push.configured() && boolEnv('PUSH_ENABLED', true),
  };
}

function apiError(status, message) {
  return { ok: false, error: { status, message } };
}

/* =========================
 * REST routes
 * ========================= */

// The capabilities probe must answer every origin (capacitor://, curl, …) and
// must be registered BEFORE the whitelist CORS middleware — same pattern as
// the public airline-logo blocklist endpoint.
function registerCapabilitiesRoute(app) {
  const publicCors = cors({ origin: '*' });
  app.options('/api/watchlist/capabilities', publicCors);
  app.get('/api/watchlist/capabilities', publicCors, (req, res) => {
    res.json(capabilities());
  });
}

function registerRoutes(app) {
  app.get('/api/watchlist', supabase.requireAuth, async (req, res) => {
    try {
      const entries = await supabase.listWatchlist(req.userId);
      res.json({ ok: true, entries });
    } catch (e) {
      console.error('[watchlist] ❌ List failed:', e.message);
      res.status(500).json(apiError(500, 'Failed to load watchlist'));
    }
  });

  app.post('/api/watchlist', supabase.requireAuth, async (req, res) => {
    const username = typeof req.body?.watchedUsername === 'string' ? req.body.watchedUsername.trim() : '';
    if (!username || username.length > 64) {
      return res.status(400).json(apiError(400, 'watchedUsername must be a non-empty string (max 64 chars)'));
    }
    try {
      const entry = await supabase.addWatchlistEntry(req.userId, username);
      if (!entry) {
        return res.status(409).json(apiError(409, 'This pilot is already on your watchlist'));
      }
      res.json({ ok: true, entry });
    } catch (e) {
      console.error('[watchlist] ❌ Add failed:', e.message);
      res.status(500).json(apiError(500, 'Failed to add watchlist entry'));
    }
  });

  app.delete('/api/watchlist/:entryId', supabase.requireAuth, async (req, res) => {
    try {
      const removed = await supabase.deleteWatchlistEntry(req.userId, req.params.entryId);
      if (!removed) {
        return res.status(404).json(apiError(404, 'Watchlist entry not found'));
      }
      res.json({ ok: true });
    } catch (e) {
      console.error('[watchlist] ❌ Delete failed:', e.message);
      res.status(500).json(apiError(500, 'Failed to delete watchlist entry'));
    }
  });
}

/* =========================
 * Socket subscriptions
 * ========================= */

const MAX_USERNAMES_PER_SOCKET = 500;
const socketSubs = new Map(); // socket.id -> { userId, usernames: Set<lower>, socket }

function attachSocket(socket) {
  // Each emit fully replaces this socket's subscription (not additive).
  socket.on('watchlist_subscribe', (payload) => {
    try {
      const raw = Array.isArray(payload?.usernames) ? payload.usernames : [];
      const usernames = new Set(
        raw
          .filter((u) => typeof u === 'string' && u.trim())
          .slice(0, MAX_USERNAMES_PER_SOCKET)
          .map((u) => u.trim().toLowerCase())
      );
      socketSubs.set(socket.id, {
        userId: typeof payload?.userId === 'string' ? payload.userId : null,
        usernames,
        socket,
      });
    } catch (e) {
      console.warn('[watchlist] ⚠️ Bad watchlist_subscribe payload:', e.message);
    }
  });

  socket.on('disconnect', () => {
    socketSubs.delete(socket.id);
  });
}

/* =========================
 * Presence engine
 * =========================
 * Fed the combined flights cache (every IF server) after each broadcast poll.
 * present → absent / absent → present transitions become watchlist_events.
 * A pilot must be absent for 2 consecutive snapshots before being declared
 * offline, so a one-poll telemetry gap doesn't fire offline+online.
 */

const OFFLINE_AFTER_MISSES = 2;

let primed = false; // first snapshot seeds state without firing events
const onlineFlights = new Map(); // lowercased username -> last seen flight
const missingStreak = new Map(); // lowercased username -> consecutive absences

function processSnapshot(flightsBySession) {
  const present = new Map(); // lowercased username -> flight
  const byFlightId = new Map(); // flightId -> flight (for Live Activity updates)
  for (const payload of flightsBySession.values()) {
    for (const f of payload?.flights || []) {
      if (f?.username) present.set(f.username.toLowerCase(), f);
      if (f?.flightId) byFlightId.set(f.flightId, f);
    }
  }

  if (!primed) {
    for (const [key, flight] of present) onlineFlights.set(key, flight);
    primed = true;
  } else {
    for (const [key, flight] of present) {
      missingStreak.delete(key);
      const wasOnline = onlineFlights.has(key);
      onlineFlights.set(key, flight); // keep the freshest flight for events
      if (!wasOnline) fireEvent('pilot_online', flight.username, flight);
    }

    for (const [key, lastFlight] of Array.from(onlineFlights)) {
      if (present.has(key)) continue;
      const streak = (missingStreak.get(key) || 0) + 1;
      if (streak >= OFFLINE_AFTER_MISSES) {
        onlineFlights.delete(key);
        missingStreak.delete(key);
        fireEvent('pilot_offline', lastFlight.username, null);
      } else {
        missingStreak.set(key, streak);
      }
    }
  }

  push
    .pushLiveActivityUpdates(byFlightId)
    .catch((e) => console.warn('[watchlist] ⚠️ Live activity updates failed:', e.message));
}

function fireEvent(type, username, flight) {
  const lower = String(username).toLowerCase();
  const event = { type, username, flight, timestamp: Date.now() };

  // Deliberately ignores join_server_room rooms: a friend going online on
  // Casual must still notify a client watching Expert.
  for (const sub of socketSubs.values()) {
    if (sub.usernames.has(lower)) {
      try {
        sub.socket.emit('watchlist_event', event);
      } catch (e) {
        console.warn('[watchlist] ⚠️ Event emit failed:', e.message);
      }
    }
  }

  if (type === 'pilot_online') {
    push
      .notifyWatchersPilotOnline(username, flight)
      .catch((e) => console.warn('[watchlist] ⚠️ Online push failed:', e.message));
  }
}

module.exports = {
  capabilities,
  registerCapabilitiesRoute,
  registerRoutes,
  attachSocket,
  processSnapshot,
};
