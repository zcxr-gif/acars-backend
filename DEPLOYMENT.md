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
