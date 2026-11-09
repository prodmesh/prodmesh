// ─────────────────────────────────────────────────────────────────────────────
//  CREDENTIAL THROTTLING  —  one counter for every door that checks a secret.
//
//  This lived inside routes/auth.js, which was fine while auth.js held every
//  door. Service tokens (ADR 0013) are checked in resolveIdentity, ahead of
//  every router, so a request authenticated by token reaches rooms.js or
//  shows.js without passing through auth.js at all. A throttle local to one
//  router does not cover a credential path that never enters it, and a path
//  that skips the lockout IS the way around it. So the counter lives here and
//  every door imports it.
//
//  Keyed on the SOURCE IP, never on station id. Stations are minted by an
//  unauthenticated endpoint, so a station-keyed counter never advances —
//  reproduced: 20 wrong PINs with a fresh station each time drew zero
//  lockouts, then the correct PIN logged in normally.
//
//  Checked BEFORE any hashing. scrypt is deliberately expensive (~24ms) and
//  synchronous, so an unthrottled guess loop also stalls the event loop —
//  every SSE stream, the ProPresenter poller, SPL capture — mid-service.
//  Refusing early bounds the number of hashes an attacker can provoke.
//
//  In-memory on purpose: a restart clears it, which costs an attacker one
//  restart they cannot cause, and a counter persisted to SQLite would be a
//  write per wrong guess.
// ─────────────────────────────────────────────────────────────────────────────

const FAILURE_CAP = 5000; // the counter map must not itself become a leak
const failures = new Map(); // key → { count, lockedUntil }

export const sourceIp = (req) => req.ip || req.socket?.remoteAddress || 'unknown';

/**
 * Escalating lockout: brief for fat fingers, punishing for a guess loop.
 * `after` differs per counter — a shared booth must not lock everyone out
 * because one volunteer mistyped five times, so the broad per-IP counter that
 * exists to catch username SPRAYING sits much higher than the per-account one.
 */
export function lockoutMs(count, after) {
  if (count < after) return 0;
  if (count < after * 2) return 60_000;
  if (count < after * 4) return 15 * 60_000;
  return 60 * 60_000;
}

/**
 * Milliseconds remaining on the longest active lock across `keys`, or 0.
 * A key is `{ k, after }`: the counter's name and how many failures it takes
 * to start locking.
 */
export function lockedFor(keys) {
  const now = Date.now();
  return Math.max(0, ...keys.map(({ k }) => (failures.get(k)?.lockedUntil ?? 0) - now));
}

export function recordFailure(keys) {
  if (failures.size >= FAILURE_CAP) {
    const now = Date.now();
    for (const [k, v] of failures) {
      if ((v.lockedUntil ?? 0) <= now) failures.delete(k);
      if (failures.size < FAILURE_CAP / 2) break;
    }
  }
  for (const { k, after } of keys) {
    const count = (failures.get(k)?.count ?? 0) + 1;
    const ms = lockoutMs(count, after);
    failures.set(k, { count, lockedUntil: ms ? Date.now() + ms : 0 });
  }
}

export const clearFailures = (keys) => keys.forEach(({ k }) => failures.delete(k));

/**
 * Answer 429 and return true if any of `keys` is locked; otherwise false.
 * One shape for every door, so a client handles a lockout once.
 */
export function refuseIfLocked(res, keys) {
  const retryAfter = lockedFor(keys);
  if (retryAfter <= 0) return false;
  res.status(429).json({ error: 'temporarily_locked', retryAfter });
  return true;
}

/** Test seam: how many counters are held. */
export const counterCount = () => failures.size;
