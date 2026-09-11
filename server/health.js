// ─────────────────────────────────────────────────────────────────────────────
//  INTEGRATION HEALTH  —  in-memory per-integration status registry.
//
//  The transport choke points (the one place each integration really talks to
//  the network) call report(key, ok, message) on every real request, so the
//  graceful-degradation fallbacks above them can stay — what happened underneath
//  is now recorded and visible at GET /api/system/health.
//
//  Logging follows the smaart.js watcher pattern: ONE line when an integration
//  goes down (the ok→fail transition) and one when it recovers — never one per
//  retry, so a Sunday-morning outage is a grep-able pair of lines, not a flood.
//
//  Keys are stable identifiers ("planningCenter", "proPresenter@host:port",
//  "companion@host:port", "analysis@host:port") — bounded by the number of
//  configured integrations, so the Map cannot grow without bound.
// ─────────────────────────────────────────────────────────────────────────────

const integrations = new Map(); // key → { lastSuccess, lastError, consecutiveFailures }

/**
 * Register a configured integration before it's ever contacted, so the health
 * surface lists everything that SHOULD be reachable — not just what happened
 * to be used since boot. A declared-but-uncontacted entry reports ok: null.
 */
export function declare(key) {
  if (!integrations.has(key)) {
    integrations.set(key, { lastSuccess: null, lastError: null, consecutiveFailures: 0 });
  }
}

/** Record one real request's outcome for an integration key. */
export function report(key, ok, errorMessage) {
  let e = integrations.get(key);
  if (!e) {
    e = { lastSuccess: null, lastError: null, consecutiveFailures: 0 };
    integrations.set(key, e);
  }
  if (ok) {
    if (e.consecutiveFailures > 0) {
      console.log(
        `[health] ${key}: recovered after ${e.consecutiveFailures} failure${e.consecutiveFailures === 1 ? '' : 's'}`,
      );
    }
    e.lastSuccess = Date.now();
    e.consecutiveFailures = 0;
  } else {
    e.consecutiveFailures += 1;
    e.lastError = { ts: Date.now(), message: String(errorMessage ?? 'unknown error') };
    if (e.consecutiveFailures === 1) console.error(`[health] ${key}: ${e.lastError.message}`);
  }
}

// ── Outage or bug? ────────────────────────────────────────────────────────────
//  The fallbacks above the choke points exist for OUTAGES, but they caught
//  everything. A TypeError in a Planning Center parser read exactly like
//  "Planning Center is down", and a bare catch in the autostart loop could
//  disarm autostart with nothing in the log (#41), which on a Sunday presents
//  as "the show just didn't start". So the choke points tag what they throw
//  with outage(), and code above them can tell the two apart. An outage takes
//  its fallback quietly, because report() has already logged it. Anything else
//  takes the fallback too, so a service is never interrupted by it, but it is
//  logged with its stack.

/** Tag an error thrown at a transport choke point as an outage of `key`. */
export function outage(err, key) {
  if (err && typeof err === 'object') err.outage = key;
  return err;
}

export const isOutage = (err) => Boolean(err?.outage);

const UNEXPECTED_EVERY_MS = 60_000;
const unexpectedSeen = new Map(); // `${where}|${message}` → when it was last logged

/**
 * Log an error that is not an outage, with its stack. At most once a minute per
 * place and message: a bug inside an 800ms poll is one line a minute, not a
 * flood that buries everything else in Admin → Logs. Returns whether it logged.
 */
export function unexpected(where, err, now = Date.now()) {
  if (isOutage(err)) return false;
  const key = `${where}|${err?.message ?? err}`;
  const last = unexpectedSeen.get(key);
  if (last != null && now - last < UNEXPECTED_EVERY_MS) return false;
  // Bounded like the registry: a burst of distinct bugs resets the throttle
  // rather than growing the map.
  if (unexpectedSeen.size >= 200) unexpectedSeen.clear();
  unexpectedSeen.set(key, now);
  console.error(`[${where}] unexpected error — ${err?.stack ?? err}`);
  return true;
}

/** A .catch handler for a read the caller can do without: always the
 *  fallback, and logged unless the failure was an outage. */
export const survive = (fallback, where) => (err) => {
  unexpected(where, err);
  return fallback;
};

/** Plain-object view for the API: { [key]: { ok, lastSuccess, lastError, consecutiveFailures } }. */
export function snapshot() {
  const out = {};
  for (const [key, e] of integrations) {
    out[key] = {
      // ok = the latest report was a success (lastError is kept after
      // recovery as outage history). null = declared but never contacted yet.
      ok: e.lastSuccess == null && e.lastError == null ? null : e.consecutiveFailures === 0,
      lastSuccess: e.lastSuccess,
      lastError: e.lastError,
      consecutiveFailures: e.consecutiveFailures,
    };
  }
  return out;
}

/** Tests only — forget every recorded status. */
export function reset() {
  integrations.clear();
  unexpectedSeen.clear();
}
