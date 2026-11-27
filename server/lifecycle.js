// ─────────────────────────────────────────────────────────────────────────────
//  LIFECYCLE  —  did the last run end cleanly? (ADR 0022 §5)
//
//  A process that is crashing cannot be trusted to do anything elaborate, and
//  one that lost power does nothing at all. So the record is written on the way
//  UP and cleared on the way DOWN, and the next boot reads what was left:
//
//    running.json   written at boot, refreshed every minute (so a death can be
//                   dated to within a minute), deleted on a clean exit. Still
//                   there at the next boot = the last run did not end cleanly:
//                   a crash, a power cut, `kill -9`, a failed start.
//    fatal.json     written synchronously by the uncaught-error monitor as the
//                   process dies, so the next boot can say WHAT killed it.
//    lifecycle.json boots and unclean exits since `since`, and the last unclean
//                   exit. What Admin shows, and what telemetry will report as
//                   a crash rate per version.
//
//  All three live in <data>/telemetry/, which backup.js does not carry: a
//  restore is a new run of a new box, not a continuation of the old one's
//  history. Nothing here sends anything anywhere; telemetry reads this later,
//  and only if switched on.
//
//  The monitor is `uncaughtExceptionMonitor`, not `uncaughtException`, on
//  purpose. The monitor observes and changes nothing: Node still prints the
//  error and exits exactly as it would have, and it also fires for an
//  unhandled rejection that is about to become fatal. Installing an
//  `uncaughtException` handler instead would make every crash our job to
//  finish, and a bug in that handler would keep a broken process alive.
// ─────────────────────────────────────────────────────────────────────────────

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './db.js';
import { writeJsonAtomic } from './atomicFile.js';

const ALIVE_EVERY_MS = 60_000;
const MESSAGE_MAX = 500;
const STACK_MAX = 4000;

let state = null; // set by begin(); null until then and in tests that never boot

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

/** Errors can be anything that was thrown. Keep what is useful and bounded. */
function describe(err) {
  if (err instanceof Error) {
    return {
      name: err.name || 'Error',
      message: String(err.message ?? '').slice(0, MESSAGE_MAX),
      stack: String(err.stack ?? '').slice(0, STACK_MAX),
    };
  }
  return { name: typeof err, message: String(err).slice(0, MESSAGE_MAX), stack: '' };
}

/**
 * Start recording this run. Call once, at boot, before anything can crash
 * that we would want to hear about. Returns what the last run left behind.
 *
 * Idempotent: the desktop app and tests may reach start() more than once in
 * one process, and a second begin() must not count a second boot.
 */
export function begin({ dir = join(DATA_DIR, 'telemetry'), version = 'unknown', now = Date.now() } = {}) {
  if (state) return state.previous;
  mkdirSync(dir, { recursive: true });
  const files = {
    running: join(dir, 'running.json'),
    fatal: join(dir, 'fatal.json'),
    totals: join(dir, 'lifecycle.json'),
  };

  const marker = readJson(files.running);
  // Another server on the same data folder (a second copy started by hand, the
  // desktop app beside a service). Its marker is not ours to judge, and its
  // run is not over. Record nothing and touch nothing: our listen() is about
  // to fail with EADDRINUSE anyway, or both are running and the folder is
  // being shared, which is its own problem.
  if (marker?.pid && marker.pid !== process.pid && isAlive(marker.pid)) {
    console.warn(`[lifecycle] another process (pid ${marker.pid}) is running on this data folder; not recording this run`);
    state = { previous: null, files: null };
    return null;
  }

  const fatal = readJson(files.fatal);
  const totals = readJson(files.totals) ?? { since: now, boots: 0, uncleanExits: 0, lastUnclean: null };

  // A leftover marker is an unclean end. A fatal record without one is an
  // uncaught error the process survived (Electron shows a dialog and carries
  // on) and later left cleanly; worth showing, not worth counting as a crash.
  let previous = null;
  if (marker) {
    previous = {
      endedCleanly: false,
      version: marker.version ?? 'unknown',
      bootedAt: marker.bootedAt ?? null,
      lastAliveAt: marker.aliveAt ?? null,
      // To the last refresh: the truth is up to a minute longer.
      uptimeMs: marker.bootedAt && marker.aliveAt ? Math.max(0, marker.aliveAt - marker.bootedAt) : null,
      fatal: fatal ?? null,
    };
    totals.uncleanExits += 1;
    totals.lastUnclean = previous;
  } else if (fatal) {
    previous = { endedCleanly: true, version: fatal.version ?? 'unknown', fatal };
  }
  totals.boots += 1;

  writeJsonAtomic(files.totals, totals);
  if (fatal) { try { unlinkSync(files.fatal); } catch { /* already gone */ } }

  const run = { pid: process.pid, version, bootedAt: now, aliveAt: now };
  writeJsonAtomic(files.running, run);
  state = { previous, files, run, totals, cleared: false };

  const timer = setInterval(() => {
    if (state.cleared) return;
    state.run.aliveAt = Date.now();
    try { writeJsonAtomic(files.running, state.run); } catch { /* a full disk must not take the server with it */ }
  }, ALIVE_EVERY_MS);
  timer.unref();

  process.on('uncaughtExceptionMonitor', recordFatal);
  // Belt to markCleanExit()'s braces. Code 0 is a clean exit however it was
  // reached; anything else leaves the marker for the next boot to find.
  process.on('exit', onExit);

  report(previous);
  return previous;
}

function onExit(code) { if (code === 0) markCleanExit(); }

/**
 * Written synchronously: by the time this runs, nothing asynchronous will.
 * Also called directly for a start that failed (`origin` 'start'), which exits
 * with code 1 and would otherwise read as a power cut at the next boot.
 */
export function recordFatal(err, origin) {
  if (!state?.files) return;
  try {
    writeFileSync(state.files.fatal, JSON.stringify({
      at: Date.now(),
      origin, // 'uncaughtException' or 'unhandledRejection'
      version: state.run.version,
      ...describe(err),
    }));
  } catch { /* dying anyway */ }
}

/**
 * This run is ending on purpose. Called from the signal handlers and by the
 * desktop app before it quits; also on any exit with code 0.
 */
export function markCleanExit() {
  if (!state?.files || state.cleared) return;
  state.cleared = true;
  try { unlinkSync(state.files.running); } catch { /* already gone */ }
}

/** One line in the log, so Admin → Logs says what happened without Admin → System. */
function report(previous) {
  if (!previous) return;
  const up = previous.uptimeMs != null ? `, up ${Math.round(previous.uptimeMs / 60_000)} min` : '';
  if (!previous.endedCleanly) {
    const why = previous.fatal ? `${previous.fatal.name}: ${previous.fatal.message}` : 'no error recorded (power loss, killed, or the machine restarted)';
    console.warn(`[lifecycle] the last run (v${previous.version}${up}) did not shut down cleanly — ${why}`);
  } else {
    console.warn(`[lifecycle] the last run (v${previous.version}) hit an uncaught error and kept going — ${previous.fatal.name}: ${previous.fatal.message}`);
  }
  if (previous.fatal?.stack) console.warn(previous.fatal.stack);
}

/**
 * For Admin and, later, telemetry. Messages and stacks are the box's own and
 * stay on it; telemetry scrubs before anything leaves (ADR 0022 §4).
 */
export function summary() {
  if (!state?.files) return null;
  const { since, boots, uncleanExits, lastUnclean } = state.totals;
  return {
    since,
    boots,
    uncleanExits,
    lastUnclean: lastUnclean && {
      version: lastUnclean.version,
      lastAliveAt: lastUnclean.lastAliveAt,
      uptimeMs: lastUnclean.uptimeMs,
      error: lastUnclean.fatal ? { name: lastUnclean.fatal.name, message: lastUnclean.fatal.message, origin: lastUnclean.fatal.origin } : null,
    },
  };
}

/** Tests only: forget this process's run so begin() can be exercised again. */
export function _resetForTests() {
  process.removeListener('uncaughtExceptionMonitor', recordFatal);
  process.removeListener('exit', onExit);
  state = null;
}
