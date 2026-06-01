/* =========================
 * metrics.cjs
 * Lightweight in-process diagnostics collector.
 *
 * Captures the things you need to develop against this backend and to see
 * "where it's choking / what's taking longer":
 *   - Per-endpoint Infinite Flight API timing (avg / p95 / max / last),
 *     call counts, error counts, 429 rate-limit hits, and the last error.
 *   - Poll-cycle health per background poller (duration, ok/fail, last error).
 *   - A point-in-time snapshot (process memory, uptime) that the dashboard
 *     Diagnostics tab polls over HTTP.
 *
 * Zero dependencies, no I/O. Safe to require from anywhere.
 * ========================= */

const RECENT_SAMPLES = 60; // rolling window for p95 / sparkline-style trends

/* ---- Infinite Flight API call stats, bucketed per endpoint template ---- */
const endpoints = new Map();

const ifApi = {
  total: 0,
  errors: 0,
  rate429: 0,
  lastError: null,
  lastErrorAt: null,
};

function endpointBucket(key) {
  let b = endpoints.get(key);
  if (!b) {
    b = {
      count: 0,
      errors: 0,
      totalMs: 0,
      maxMs: 0,
      lastMs: 0,
      recent: [],
      lastStatus: null,
      lastError: null,
      lastAt: null,
    };
    endpoints.set(key, b);
  }
  return b;
}

// Collapse volatile path parts (session GUIDs, numeric ids, ICAOs) so calls
// to the same logical endpoint aggregate into one row.
function templatize(url) {
  if (!url) return 'unknown';
  let p = String(url).split('?')[0];
  p = p.replace(/^https?:\/\/[^/]+/, ''); // strip protocol+host if absolute
  p = p
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':guid')
    .replace(/\/\d+(?=\/|$)/g, '/:n');
  return p || '/';
}

function percentile(arr, p) {
  if (!arr || !arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return +sorted[idx].toFixed(1);
}

/**
 * Attach request/response interceptors to an axios instance to time every
 * call. Pass-through only — never alters responses or swallows errors, so it
 * is safe to layer on top of existing interceptors (e.g. 429 retry logic).
 */
function instrumentAxios(client) {
  client.interceptors.request.use((config) => {
    config.__metricStart = process.hrtime.bigint();
    return config;
  });
  client.interceptors.response.use(
    (response) => {
      recordApiCall(response.config, response.status, null);
      return response;
    },
    (error) => {
      const status = error?.response?.status || 0;
      recordApiCall(error?.config, status, error?.message || 'request failed');
      return Promise.reject(error);
    }
  );
}

function recordApiCall(config, status, errMsg) {
  if (!config) return;
  const ms = config.__metricStart
    ? Number(process.hrtime.bigint() - config.__metricStart) / 1e6
    : 0;
  const key = `${(config.method || 'get').toUpperCase()} ${templatize(config.url)}`;
  const b = endpointBucket(key);

  b.count += 1;
  b.lastMs = ms;
  b.totalMs += ms;
  if (ms > b.maxMs) b.maxMs = ms;
  b.recent.push(ms);
  if (b.recent.length > RECENT_SAMPLES) b.recent.shift();
  b.lastStatus = status || null;
  b.lastAt = Date.now();

  ifApi.total += 1;
  const isError = !!errMsg || status >= 400 || status === 0;
  if (isError) {
    b.errors += 1;
    b.lastError = errMsg || `HTTP ${status}`;
    ifApi.errors += 1;
    ifApi.lastError = `${key} → ${b.lastError}`;
    ifApi.lastErrorAt = Date.now();
    if (status === 429) ifApi.rate429 += 1;
  }
}

/* ---- Background poller health ---- */
const polls = new Map();

function pollBucket(name) {
  let b = polls.get(name);
  if (!b) {
    b = {
      runs: 0,
      fails: 0,
      lastMs: 0,
      maxMs: 0,
      totalMs: 0,
      recent: [],
      lastAt: null,
      lastStatus: null,
      lastError: null,
      extra: null,
    };
    polls.set(name, b);
  }
  return b;
}

/**
 * Record one completed poll cycle.
 * @param {string} name      poller name, e.g. 'flights:Expert Server'
 * @param {object} info      { ms, ok, error, extra }
 */
function recordPoll(name, { ms = 0, ok = true, error = null, extra = null } = {}) {
  const b = pollBucket(name);
  b.runs += 1;
  if (!ok) b.fails += 1;
  b.lastMs = ms;
  b.totalMs += ms;
  if (ms > b.maxMs) b.maxMs = ms;
  b.recent.push(Math.round(ms));
  if (b.recent.length > RECENT_SAMPLES) b.recent.shift();
  b.lastAt = Date.now();
  b.lastStatus = ok ? 'ok' : 'error';
  if (error) b.lastError = String(error).slice(0, 300);
  if (extra && typeof extra === 'object') b.extra = extra;
}

/* ---- Snapshot for the dashboard ---- */
function snapshot(extra = {}) {
  const mem = process.memoryUsage();

  const endpointRows = [];
  for (const [key, b] of endpoints) {
    endpointRows.push({
      key,
      count: b.count,
      errors: b.errors,
      avgMs: b.count ? +(b.totalMs / b.count).toFixed(1) : 0,
      p95Ms: percentile(b.recent, 95),
      maxMs: +b.maxMs.toFixed(1),
      lastMs: +b.lastMs.toFixed(1),
      lastStatus: b.lastStatus,
      lastError: b.lastError,
      lastAt: b.lastAt,
    });
  }
  // Slowest first — the prime choke-point candidates.
  endpointRows.sort((a, b) => b.avgMs - a.avgMs);

  const pollRows = [];
  for (const [name, b] of polls) {
    pollRows.push({
      name,
      runs: b.runs,
      fails: b.fails,
      avgMs: b.runs ? +(b.totalMs / b.runs).toFixed(1) : 0,
      maxMs: +b.maxMs.toFixed(1),
      lastMs: +b.lastMs.toFixed(1),
      recent: b.recent,
      lastAt: b.lastAt,
      msSinceLast: b.lastAt ? Date.now() - b.lastAt : null,
      lastStatus: b.lastStatus,
      lastError: b.lastError,
      extra: b.extra,
    });
  }
  pollRows.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));

  return {
    now: Date.now(),
    uptimeSec: Math.round(process.uptime()),
    process: {
      pid: process.pid,
      node: process.version,
      rssMb: +(mem.rss / 1048576).toFixed(1),
      heapUsedMb: +(mem.heapUsed / 1048576).toFixed(1),
      heapTotalMb: +(mem.heapTotal / 1048576).toFixed(1),
      externalMb: +(mem.external / 1048576).toFixed(1),
    },
    ifApi: { ...ifApi, endpoints: endpointRows },
    polls: pollRows,
    ...extra,
  };
}

module.exports = {
  instrumentAxios,
  recordApiCall,
  recordPoll,
  snapshot,
};
