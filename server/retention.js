// ─────────────────────────────────────────────────────────────────────────────
//  RETENTION  —  age-based pruning that never competes with a live show.
//
//  Every prune used to be one `DELETE … WHERE ts < ?` at boot and then every
//  24 hours counted from boot. better-sqlite3 is synchronous, so that DELETE
//  holds the event loop for as long as it takes, and "24 hours from boot" lands
//  wherever boot happened to be: a server restarted at 10:30 on a Sunday prunes
//  at 10:30 every Sunday, mid-service, while the show's SSE pushes wait behind
//  it. ADR 0019, "The live show comes first".
//
//  So a prune here:
//    • deletes in small chunks, yielding to the event loop between them;
//    • never starts while a show is live, and stops between chunks if one
//      starts;
//    • is checked hourly and runs at most once a day, so it drifts into the
//      first quiet hour instead of pinning itself to a boot time.
//
//  Each table pruned here has an index on its timestamp (the signals-and-alerts
//  migration added the ones SPL and viewer samples lacked), so a chunk is an
//  index range read, not a scan of a table that grows by a row a second.
// ─────────────────────────────────────────────────────────────────────────────

import { getDb } from './db.js';

const CHUNK = 500;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const yieldLoop = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Delete rows older than `days` from `table` (by its `tsColumn`), CHUNK at a
 * time, until none are left or `isBusy()` says a show has started. Resolves to
 * the number of rows removed. `days` ≤ 0 or not a number disables it.
 */
export async function pruneTable({ table, tsColumn = 'ts', days, isBusy = () => false, label = table }) {
  if (!Number.isFinite(days) || days <= 0) return 0;
  const cutoff = Date.now() - days * DAY;
  const db = getDb();
  // Table and column names come from this module's callers, never a request.
  const del = db.prepare(
    `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${tsColumn} < ? LIMIT ${CHUNK})`,
  );
  let removed = 0;
  for (;;) {
    if (isBusy()) break;
    const { changes } = del.run(cutoff);
    removed += changes;
    if (changes < CHUNK) break;
    await yieldLoop();
  }
  if (removed) console.log(`[retention] ${label}: pruned ${removed} rows older than ${days} days`);
  return removed;
}

const jobs = []; // { run: () => Promise<number>, lastRun }
let timer = null;
let running = false;
let busy = () => false;

async function tick() {
  if (running || busy()) return;
  running = true;
  try {
    for (const job of jobs) {
      if (busy()) break;
      if (job.lastRun != null && Date.now() - job.lastRun < DAY - HOUR) continue;
      try {
        await job.run(busy);
        job.lastRun = Date.now();
      } catch (err) {
        console.error(`[retention] ${job.label}: ${err?.stack ?? err}`);
        job.lastRun = Date.now(); // a broken prune retries tomorrow, not hourly
      }
    }
  } finally {
    running = false;
  }
}

/**
 * Register a daily prune. `run(isBusy)` does the work; pruneTable is the usual
 * body. Registering after start() is fine.
 */
export function register(label, run) {
  jobs.push({ label, run, lastRun: null });
}

/**
 * Start the hourly check. `isBusy` reports whether a show is live anywhere;
 * nothing prunes while it is true. The first check waits a few minutes, so a
 * restart during a service does not prune the moment it comes back.
 */
export function start({ isBusy, firstDelayMs = 5 * 60_000 } = {}) {
  if (isBusy) busy = isBusy;
  if (timer) return timer;
  const first = setTimeout(() => {
    tick();
    timer = setInterval(tick, HOUR);
    timer.unref?.();
  }, firstDelayMs);
  first.unref?.();
  timer = first;
  return timer;
}

/** Tests only: run every job now, regardless of when it last ran. */
export async function runAllNow() {
  for (const job of jobs) job.lastRun = null;
  await tick();
}

/** Tests only. */
export function reset() {
  jobs.length = 0;
  if (timer) {
    clearTimeout(timer);
    clearInterval(timer);
  }
  timer = null;
  running = false;
  busy = () => false;
}
