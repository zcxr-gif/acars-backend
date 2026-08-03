/**
 * discord_presence.test.cjs — contract tests for the presence routes.
 *
 * Run with: npm test   (or: node discord_presence.test.cjs)
 *
 * These routes exist to let two devices agree on one thing: which flight the
 * pilot's computer should be putting on their Discord profile. The only
 * consumer is discordPresence.js in the tracker, so every assertion here is
 * written against the exact field the client reads — if this file and that
 * client disagree, a phone silently stops driving a laptop with nothing on
 * either end to say why. The two must be changed together.
 *
 * Everything runs against a real Express app over real HTTP. Only the Supabase
 * token check is stubbed, because verifying a JWT is not what is under test.
 */

const assert = require('assert');
const express = require('express');
const http = require('http');

// Stub auth before the routes capture it: the bearer token becomes the user id,
// which keeps "two different pilots" trivial to express below.
const supabase = require('./supabase.cjs');
supabase.requireAuth = (req, res, next) => {
    const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
    if (!match) return res.status(401).json({ ok: false });
    req.userId = match[1].trim();
    next();
};
supabase.canVerifyTokens = () => true;

process.env.DISCORD_CLIENT_ID = 'test-client-id';
process.env.DISCORD_CLIENT_SECRET = 'test-secret';

const discordPresence = require('./discord_presence.cjs');

// Two servers' worth of live flights, as the poller would hold them.
const FLIGHTS_CACHE = new Map([
    ['sess-expert', {
        server: 'Expert Server',
        flights: [
            { flightId: 'flt-1', username: 'SpeedBird', callsign: 'BAW278' },
            { flightId: 'flt-x', username: 'someone-else', callsign: 'AAL1' },
        ],
    }],
    ['sess-training', {
        server: 'Training Server',
        flights: [{ flightId: 'flt-2', username: 'speedbird', callsign: 'BAW9' }],
    }],
]);

const app = express();
app.use(express.json());
discordPresence.registerRoutes(app, { getFlightsCache: () => FLIGHTS_CACHE });

let server;
let base;

/** Minimal JSON client so the test exercises real HTTP, not the router directly. */
function call(method, path, { token = null, body = null } = {}) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const req = http.request(`${base}${path}`, {
            method,
            headers: {
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
            },
        }, (res) => {
            let raw = '';
            res.on('data', (chunk) => { raw += chunk; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(raw); } catch (_) { /* non-JSON body */ }
                resolve({ status: res.statusCode, json });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

const PHONE = 'user-alice';
const OTHER = 'user-bob';

let pass = 0;
const ok = (name) => { pass += 1; console.log(`  ✓ ${name}`); };

(async () => {
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;

    try {
        // ── The probe the client boots on ───────────────────────────────────
        console.log('\nWhat the client is told it can do\n');
        {
            const { status, json } = await call('GET', '/api/discord/presence/config');
            assert.strictEqual(status, 200);
            // Field names read verbatim by DiscordPresence.init().
            assert.strictEqual(json.enabled, true);
            assert.strictEqual(json.clientId, 'test-client-id');
            assert.strictEqual(json.externalAssets, false, 'no bot token configured');
            assert.strictEqual(json.remote, true, 'remote control needs verifiable tokens');
            ok('config carries enabled, clientId, externalAssets and remote');
        }

        // ── An account that has never picked anything ───────────────────────
        console.log('\nA fresh account\n');
        {
            const { json } = await call('GET', '/api/discord/presence/target', { token: PHONE });
            assert.strictEqual(json.target, null);
            assert.strictEqual(json.revision, 0);
            assert.deepStrictEqual(json.host, { online: false, connected: false });
            ok('reads back empty, with no laptop online');

            const un = await call('GET', '/api/discord/presence/target');
            assert.strictEqual(un.status, 401);
            ok('and is refused without a token');
        }

        // ── The phone choosing a flight ─────────────────────────────────────
        console.log('\nThe phone picks a flight\n');
        {
            const { json } = await call('PUT', '/api/discord/presence/target', {
                token: PHONE,
                body: { target: { flightId: 'flt-2', username: 'speedbird', label: 'BAW9', server: 'Training Server' } },
            });
            assert.strictEqual(json.revision, 1, 'every write bumps the revision');
            assert.deepStrictEqual(json.target, {
                flightId: 'flt-2', username: 'speedbird', label: 'BAW9', server: 'Training Server',
            });
            ok('stores flightId, username, label and server');
        }
        {
            // The record is echoed to the pilot's other devices, so it must
            // hold nothing a client wasn't asked for.
            const { json } = await call('PUT', '/api/discord/presence/target', {
                token: OTHER,
                body: { target: { username: 'wingman', evil: '<script>', flightId: 'f'.repeat(500) } },
            });
            assert.deepStrictEqual(Object.keys(json.target).sort(), ['flightId', 'label', 'server', 'username']);
            assert.strictEqual(json.target.flightId.length, 128, 'oversized ids are bounded');
            assert.strictEqual(json.target.label, 'wingman', 'label defaults to the username');
            ok('unknown fields are dropped and lengths bounded');

            const bad = await call('PUT', '/api/discord/presence/target', { token: PHONE, body: { target: {} } });
            assert.strictEqual(bad.status, 400);
            ok('a target with no username is refused');
        }

        // ── The laptop picking it up ────────────────────────────────────────
        console.log('\nThe laptop checks in\n');
        {
            // A tab that has applied nothing yet sends revision 0.
            const { json } = await call('POST', '/api/discord/presence/session', {
                token: PHONE,
                body: { connected: true, revision: 0, target: null },
            });
            assert.strictEqual(json.changed, true, 'the laptop is behind, so it must re-apply');
            assert.strictEqual(json.revision, 1);
            assert.strictEqual(json.target.flightId, 'flt-2');
            assert.strictEqual(json.host.online, true);
            assert.strictEqual(json.host.connected, true);
            ok('hands the laptop the phone\'s pick, and marks it changed');

            const caught = await call('POST', '/api/discord/presence/session', {
                token: PHONE,
                body: { connected: true, revision: 1, target: json.target },
            });
            assert.strictEqual(caught.json.changed, false);
            ok('and stops saying so once it has caught up');
        }
        {
            // The rule that matters: a heartbeat still carrying the old target
            // must never undo a pick the phone made a moment ago.
            await call('PUT', '/api/discord/presence/target', {
                token: PHONE,
                body: { target: { flightId: 'flt-1', username: 'speedbird', label: 'BAW278', server: 'Expert Server' } },
            });
            const { json } = await call('POST', '/api/discord/presence/session', {
                token: PHONE,
                body: { connected: true, revision: 1, target: { flightId: 'flt-2', username: 'speedbird', label: 'BAW9' } },
            });
            assert.strictEqual(json.target.flightId, 'flt-1', 'the newer pick survives');
            assert.strictEqual(json.revision, 2);
            assert.strictEqual(json.changed, true);
            ok('a stale heartbeat cannot clobber a newer pick');
        }

        // ── Surviving a restart ─────────────────────────────────────────────
        console.log('\nAfter the backend restarts\n');
        {
            const FRESH = 'user-carol';
            // Nothing held for this account — the laptop's own target seeds it,
            // which is what makes a redeploy cost one poll instead of the flight.
            const { json } = await call('POST', '/api/discord/presence/session', {
                token: FRESH,
                body: { connected: true, revision: 7, target: { flightId: 'flt-1', username: 'speedbird', label: 'BAW278' } },
            });
            assert.strictEqual(json.revision, 7);
            assert.strictEqual(json.target.flightId, 'flt-1');
            assert.strictEqual(json.changed, false, 'the laptop is already showing it');
            ok('an empty store is re-seeded from the tab that is broadcasting');
        }

        // ── Laptop liveness ─────────────────────────────────────────────────
        console.log('\nWhether the laptop is really there\n');
        {
            const SLEEPY = 'user-dave';
            await call('PUT', '/api/discord/presence/target', {
                token: SLEEPY, body: { target: { username: 'speedbird' } },
            });
            await call('POST', '/api/discord/presence/session', {
                token: SLEEPY, body: { connected: false, revision: 1 },
            });

            const up = await call('GET', '/api/discord/presence/target', { token: SLEEPY });
            assert.strictEqual(up.json.host.online, true);
            assert.strictEqual(up.json.host.connected, false);
            ok('a tab that is open but has no Discord reads as online, not connected');

            // Jump past the stale window rather than waiting it out.
            const realNow = Date.now;
            Date.now = () => realNow() + 60 * 1000;
            try {
                const gone = await call('GET', '/api/discord/presence/target', { token: SLEEPY });
                assert.strictEqual(gone.json.host.online, false);
                assert.strictEqual(gone.json.host.connected, false);
                assert.strictEqual(gone.json.target.username, 'speedbird', 'the pick is kept for its return');
                ok('a tab that stops heartbeating goes offline, keeping the pick');
            } finally {
                Date.now = realNow;
            }
        }

        // ── Accounts don't leak into each other ─────────────────────────────
        console.log('\nOne account per pilot\n');
        {
            const mine = await call('GET', '/api/discord/presence/target', { token: PHONE });
            const theirs = await call('GET', '/api/discord/presence/target', { token: OTHER });
            assert.strictEqual(mine.json.target.flightId, 'flt-1');
            assert.strictEqual(theirs.json.target.username, 'wingman');
            ok('two pilots keep separate targets');
        }

        // ── Stopping ────────────────────────────────────────────────────────
        console.log('\nStopping the broadcast\n');
        {
            const { json } = await call('PUT', '/api/discord/presence/target', {
                token: PHONE, body: { clear: true },
            });
            assert.strictEqual(json.target, null);
            assert.strictEqual(json.revision, 3, 'clearing is a change like any other');
            ok('clear empties the target and bumps the revision');

            const { json: seen } = await call('POST', '/api/discord/presence/session', {
                token: PHONE, body: { connected: true, revision: 2, target: null },
            });
            assert.strictEqual(seen.changed, true);
            assert.strictEqual(seen.target, null);
            ok('and the laptop is told to stop');
        }

        // ── Every flight a pilot has up ─────────────────────────────────────
        console.log('\nA pilot on two servers\n');
        {
            const { json } = await call('GET', '/api/discord/presence/pilot-flights?username=speedbird');
            assert.strictEqual(json.flights.length, 2, 'both servers are searched');
            const byId = Object.fromEntries(json.flights.map((f) => [f.flightId, f]));
            assert.strictEqual(byId['flt-1'].server, 'Expert Server');
            assert.strictEqual(byId['flt-2'].server, 'Training Server');
            ok('returns both flights, each tagged with its server');

            // The lookup is how the picker finds a pilot at all, so a casing
            // mismatch between the account name and the feed must not hide it.
            const cased = await call('GET', '/api/discord/presence/pilot-flights?username=SPEEDBIRD');
            assert.strictEqual(cased.json.flights.length, 2);
            ok('and matches the username regardless of case');

            const none = await call('GET', '/api/discord/presence/pilot-flights?username=nobody');
            assert.deepStrictEqual(none.json.flights, []);
            ok('an unknown pilot is empty, not an error');

            const bad = await call('GET', '/api/discord/presence/pilot-flights');
            assert.strictEqual(bad.status, 400);
            ok('and a missing username is refused');
        }

        console.log(`\n${pass} checks passed\n`);
    } finally {
        server.close();
    }
})().catch((err) => {
    console.error(`\n✗ ${err.message}\n`);
    if (server) server.close();
    process.exit(1);
});
