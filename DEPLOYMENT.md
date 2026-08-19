# Deploying the recorder

Sizing notes and every knob the trail recorder exposes. Defaults are chosen for
the current Northflank instance: **0.5 vCPU, 1024 MB**.

## Memory

### Cap the V8 heap explicitly

This matters more than anything else on this page. By default V8 sizes its heap
from the memory it believes the machine has, which on a small container can be
many times the container's actual limit — on the box these defaults were
measured, the default limit resolved to **8240 MB against a 1 GB budget**. A
process in that state does not garbage-collect its way out of trouble; it grows
until the container runtime kills it, and the restart looks like a crash rather
than memory pressure.

`npm start` therefore runs with `--max-old-space-size=${NODE_HEAP_MB:-700}`.
700 MB of heap leaves roughly 300 MB for SQLite page cache, socket buffers and
everything else native. Raise `NODE_HEAP_MB` on a larger instance; keep it at
least ~250 MB below the container limit.

If the process is started by something other than `npm start`, set the same
flag via `NODE_OPTIONS`.

### Measuring

```
npm run bench          # 800 flights x 240 polls, reports throughput + retained heap
taskset -c 0 npm run bench   # single core, ~2x the times of 0.5 vCPU
```

The benchmark forces a GC and reports heap retained across ~192,000 recorded
points. It should be a fraction of a megabyte. If it climbs, something in the
recording path is holding references.

## Trail retention (`history.cjs`)

| Variable | Default | Notes |
|---|---|---|
| `HISTORY_RETENTION_HOURS` | `336` (14 days) | Age ceiling for recorded trails. |
| `HISTORY_MAX_DB_MB` | `4096` | Size ceiling. The tighter of the two wins. `0` disables it. |
| `HISTORY_CACHE_MB` | `16` | SQLite page cache. Was effectively 49 MB, which is a lot of a 1 GB container. |
| `HISTORY_CHUNK_POINTS` | `48` | Points per sealed chunk. Larger = fewer writes, bigger hot tail. |

The size ceiling is the one that keeps the instance safe: an unusually busy
fortnight degrades into a shorter window instead of filling the volume. At ~800
concurrent flights the measured cost is ~7.9 KB per flight-hour, projecting to
roughly 2 GB over 14 days — comfortably inside the default.

## Archiving (`archivist.cjs`)

| Variable | Default | Notes |
|---|---|---|
| `ARCHIVE_ENABLED` | on | Set `0`/`false` to stop promoting finished flights. |
| `ARCHIVE_BACKEND_URL` | indgo backend | Where `POST /api/trails` goes. Falls back to `VA_BACKEND_URL`. |
| `ARCHIVE_GRACE_MINUTES` | `15` | How long a flight must be gone from the live feed to count as over. |
| `ARCHIVE_MAX_AGE_HOURS` | `24` | How far back a sweep looks. Must stay under the 48h claim ledger; clamped if not. |
| `ARCHIVE_SWEEP_MINUTES` | `5` | Interval between sweeps. |
| `ARCHIVE_BATCH` | `25` | Flights considered per sweep. |
| `ARCHIVE_MIN_POINTS` | `20` | Quality gate. |
| `ARCHIVE_MIN_DISTANCE_NM` | `10` | Quality gate, measured along the path. |
| `ARCHIVE_UPLOAD_TIMEOUT_MS` | `30000` | A hung upload would otherwise hold a sweep open. |

Sweeps upload serially and refuse to overlap, so the archivist's memory cost is
one trail at a time regardless of backlog. A failed upload releases its claim
and is retried on the next sweep.

## Live status hydration (`live_hydrate.cjs`)

Keeps a pilot broadcasting through Infinite Flight Connect on the map after iOS
suspends their app behind the sim, by refreshing their position from the public
feed. It runs inside `processSnapshot`, on the 15s broadcast path, so the number
that matters is what a poll costs when it is *not* running a pass — which is
every poll but one a minute.

| Variable | Default | Notes |
|---|---|---|
| `LIVE_HYDRATION_ENABLED` | on | `0`/`false` hydrates nothing. |
| `LIVE_HYDRATION_INTERVAL_MS` | `60000` | How often a snapshot is posted. Floor of 15s. |
| `LIVE_HYDRATION_MAX_ROWS` | `500` | Rows per pass. A safety rail, not a working limit. |
| `CONNECT_ALERTS_ENABLED` | on | `0`/`false` never sends the sim-drop notice. |
| `CONNECT_ALERT_INTERVAL_MS` | `120000` | How often the drop check runs. Floor of 30s. |
| `CONNECT_ALERTS_MAX_PER_PASS` | `100` | Notices claimed per pass — see below. |

Everything here no-ops without `SUPABASE_SERVICE_ROLE_KEY`.

### Why one pass a minute and not one every fifteen seconds

The position TTL is four minutes, so anything under that keeps a pilot live and
the obvious tuning is "as often as possible". That is the wrong ceiling. This is
a write to a row Postgres does not overwrite in place, and the `fillfactor = 70`
and dropped-`updated_at`-index work on `pilot_live_status` exists to keep the
dead-tuple cost of a fourteen-hour flight bounded.

So the rule is: **never write more often than the app it stands in for**, which
broadcasts every 45s in the cruise. Sixty seconds is that, and comfortably
inside the TTL, and costs 60 row versions an hour per suspended pilot against
the app's own 80.

### Why the notice claims a bounded number

`pilot_connect_alerts_due` marks a flight as told **in the same statement** that
hands it over, because the alternative — the backend remembering — does not
survive a redeploy, and a pilot told twice on one flight that their sim went
quiet is worse than not being told.

The cost of that is that marking and delivering are two systems and only the
first is transactional. So the function takes a limit, and the backend asks for
no more than it will actually push through APNs on this pass. Anything over it
is still due on the next pass rather than marked told and silently skipped.
`CONNECT_ALERTS_MAX_PER_PASS` is therefore also roughly how long a pass can be
held open by a mass drop — pushes go out one device at a time.

### Measured

```
node --expose-gc bench_hydrate.cjs        # Node side, Supabase stubbed
BENCH_BROADCASTING=5000 node --expose-gc bench_hydrate.cjs   # the safety rail
```

800 flights on the feed, 200 of them broadcasting and suspended, 240 polls
(one simulated hour), single core:

| | |
|---|---|
| Mean per poll | **0.048 ms** — 0.0003% of the 15s budget |
| Slowest poll | 0.77 ms |
| Hydration passes | 60, mean 0.17 ms |
| Posted | 29.6 KB per pass |
| Heap retained | **330 KB**, flat from 1 hour to 4 |

At 5,000 broadcasting — far past anything real — the batch cap holds it to 500
rows and 74 KB per pass, 2.3 ms worst poll, 1.6 MB retained.

The database half, measured on a throwaway Postgres 16 with the migrations
applied, 200 suspended pilots, 60 passes:

| | |
|---|---|
| `pilot_live_hydrate` | **13.2 ms** mean, 20.0 ms worst, once a minute |
| HOT updates | **97.1%** (11,845 of 12,200) |
| Table size | 80 kB → **176 kB** after an hour, and stable |
| `pilot_connect_alerts_due` | 4.0 ms claiming 100, 2.1 ms for the rest |

97% HOT is the number to watch: it is what the fillfactor is for, and it is why
an hour of hydration adds 96 kB rather than the 3.6 MB the raw row-version count
would suggest. If it falls, something has added an index on a column one of
these writes touches — `latitude`, `longitude`, `altitude_msl`, `heading`,
`ground_speed_knots`, `vertical_speed_fpm`, `position_source`, `last_live_at` or
`updated_at`. The dropped `pilot_live_status_fresh_idx` is the cautionary tale.

## What to watch after deploying

- **First boot after upgrading** runs a bounded migration of legacy `path_json`
  trails, 500 rows at a time, re-arming every 5s until done. It logs
  `Migrated N legacy trails`. This is the only sustained extra load, and it
  stops permanently once the table has cycled through.
- **`[history] Over size ceiling`** means the size cap is doing its job and
  retention is effectively shorter than `HISTORY_RETENTION_HOURS`. Either raise
  the volume or accept the shorter window.
- **`[archivist] ... could not be archived`** is retried automatically. Sustained
  failures mean the archive backend is unreachable, not that flights are lost.
- **`liveHydration` on `/api/admin/diagnostics`.** `watching: 0` means nobody is
  broadcasting through Connect at all; a non-zero `watching` with `matched: 0`
  means none of them has a flight on the feed right now. `lastError` holds the
  last failure. A Supabase outage shows here as a stale `lastRunAt` and does
  **not** turn into a retry storm — the refresh clock is stamped whether or not
  the fetch worked, so a failure costs a minute of staleness rather than a
  request every three seconds.
