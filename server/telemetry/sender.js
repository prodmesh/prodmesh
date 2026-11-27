// ─────────────────────────────────────────────────────────────────────────────
//  SENDER  —  when, whether and how a report leaves (ADR 0022 §6).
//
//  Everything here is decided in tick(now), which a five-minute timer calls and
//  the tests call directly with a clock of their own. In order:
//
//    1. Switched off (or PRODMESH_TELEMETRY=off): do nothing, and delete any
//       queued report. Withdrawn consent covers data already gathered.
//    2. No endpoint: do nothing. The receiving end does not exist yet.
//    3. A show is live anywhere: wait. The payload is small, but "it never
//       does anything during a service" is worth being able to say flatly.
//    4. Told to stop (410) for this version, or backing off: wait.
//    5. Due? Once a day at this install's own minute of the day (derived from
//       its id, so a thousand churches do not all arrive at 09:00), or sooner
//       for a bug not reported before, at most once an hour.
//    6. Close the collector's window into the queue, check it against the
//       schema, sign it, send it.
//
//  The queue is ONE report, not a list: a new window merges into whatever is
//  still unsent, errors by fingerprint and counts by sum. So a box offline for
//  a month sends one report when it comes back, and the file is bounded by the
//  schema's 64 KB (fit() sheds detail to stay under it), not by time.
//
//  Response handling reads the status and nothing else. No response body is
//  ever acted on: the receiving end can say "later", "never for this version"
//  or "that was malformed", and none of those can make this server do more.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../db.js';
import { writeJsonAtomic } from '../atomicFile.js';
import * as settings from '../settings.js';
import * as deployment from '../deployment.js';
import * as collector from './collector.js';
import { validate, ERRORS_MAX, MAX_BYTES } from './schema.js';

export const TICK_EVERY_MS = 5 * 60_000;
const FIRST_TICK_MS = 60_000;
const DAY = 24 * 60 * 60_000;
const HOUR = 60 * 60_000;
const EARLY_EVERY_MS = HOUR;
const BACKOFF_MIN_MS = 5 * 60_000;
const BACKOFF_MAX_MS = 6 * HOUR;
const RETRY_AFTER_MAX_MS = DAY;
const TIMEOUT_MS = 15_000;

// Where reports go. Not decided yet (ADR 0022: the domain is open), so there
// is no default and nothing is sent. PRODMESH_TELEMETRY_URL overrides it for
// development against a local or staging receiver.
export const DEFAULT_ENDPOINT = null;

const FILES = {
  queue: () => join(DATA_DIR, 'telemetry', 'pending.json'),
  state: () => join(DATA_DIR, 'telemetry', 'sender.json'),
};

let isShowLive = () => false;
let timer = null;
let inFlight = null;
let lastLoggedProblem = null;

// ── Endpoint ─────────────────────────────────────────────────────────────────

/**
 * https only, except to this machine, so a developer can run a receiver
 * locally. Anything else is refused rather than sent in the clear.
 */
export function endpoint() {
  const raw = process.env.PRODMESH_TELEMETRY_URL || DEFAULT_ENDPOINT;
  if (!raw) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) return url;
  return null;
}

// ── Persistence ──────────────────────────────────────────────────────────────

function read(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

const DEFAULT_STATE = {
  seq: 0,
  lastAttemptAt: null,
  lastSentAt: null,
  lastResult: null, // 'sent' | 'rejected' | 'refused' | 'stopped' | 'failed'
  lastError: null,
  backoffUntil: null,
  failures: 0,
  stoppedVersion: null,
  lastEarlyAt: null,
  reported: [], // fingerprints already sent, so a known bug does not bring a report forward
};

function loadState() { return { ...DEFAULT_STATE, ...read(FILES.state(), {}) }; }
function saveState(s) { writeJsonAtomic(FILES.state(), s); }

function dropQueue() {
  try { unlinkSync(FILES.queue()); } catch { /* none */ }
}

// ── Scheduling ───────────────────────────────────────────────────────────────

/** This install's minute of the day, from its id: stable, and spread evenly. */
export function slotMinute(id) {
  return crypto.createHash('sha256').update(String(id)).digest().readUInt32BE(0) % (24 * 60);
}

/** The first time at this install's slot that is at least `after`. */
export function nextSlot(after, id) {
  const dayStart = Math.floor(after / DAY) * DAY; // UTC: a slot is a time, not a local habit
  let t = dayStart + slotMinute(id) * 60_000;
  while (t < after) t += DAY;
  return t;
}

/**
 * Due daily at the slot, the first slot after the last send. A first report
 * waits for the first slot after the switch was turned on, not for a day.
 */
function dailyDue(state, now, id) {
  const since = state.lastSentAt ?? settings.getTelemetrySettings().decidedAt ?? now;
  // At least 20 hours apart, so a slot just after a send is not taken twice.
  const after = state.lastSentAt ? state.lastSentAt + 20 * HOUR : since;
  return now >= nextSlot(after, id);
}

function earlyDue(state, report, now) {
  if (state.lastEarlyAt && now - state.lastEarlyAt < EARLY_EVERY_MS) return false;
  const known = new Set(state.reported);
  return report.errors.some((e) => !known.has(e.fingerprint))
    || Boolean(report.lifecycle.previous && !report.lifecycle.previous.endedCleanly);
}

// ── Merging windows into the queue ───────────────────────────────────────────

/** `older` is the unsent report, `newer` the window just closed. */
export function merge(older, newer) {
  if (!older) return newer;
  const errors = new Map(older.errors.map((e) => [e.fingerprint, { ...e }]));
  let dropped = older.errorsDropped + newer.errorsDropped;
  for (const e of newer.errors) {
    const had = errors.get(e.fingerprint);
    if (had) {
      had.count += e.count;
      had.firstSeen = Math.min(had.firstSeen, e.firstSeen);
      had.lastSeen = Math.max(had.lastSeen, e.lastSeen);
    } else if (errors.size < ERRORS_MAX) {
      errors.set(e.fingerprint, { ...e });
    } else {
      dropped += e.count;
    }
  }
  return {
    ...newer, // build, host, resources, shape: the latest is the truth
    seq: older.seq,
    window: { from: older.window.from, to: newer.window.to },
    errors: [...errors.values()],
    errorsDropped: dropped,
    lifecycle: {
      boots: older.lifecycle.boots + newer.lifecycle.boots,
      uncleanExits: older.lifecycle.uncleanExits + newer.lifecycle.uncleanExits,
      // The most recent unclean end is the one worth a stack.
      previous: newer.lifecycle.previous ?? older.lifecycle.previous,
    },
  };
}

/**
 * Bring a report under the schema's size limit. Fifty error groups with full
 * stacks can pass it, and the report most likely to be that big is the one
 * that matters most, so shed detail before anything is refused: frames first
 * (the top few carry the fingerprint's information), then the rarest errors,
 * which are counted in errorsDropped rather than vanishing.
 */
export function fit(report) {
  const size = (r) => Buffer.byteLength(JSON.stringify(r));
  let out = report;
  for (const keep of [8, 3]) {
    if (size(out) <= MAX_BYTES) return out;
    out = { ...out, errors: out.errors.map((e) => ({ ...e, frames: e.frames.slice(0, keep) })) };
  }
  const errors = [...out.errors].sort((a, b) => b.count - a.count);
  let dropped = out.errorsDropped;
  while (errors.length && size({ ...out, errors, errorsDropped: dropped }) > MAX_BYTES) dropped += errors.pop().count;
  return { ...out, errors, errorsDropped: dropped };
}

// ── Sending ──────────────────────────────────────────────────────────────────

function retryAfter(header, now) {
  if (!header) return null;
  const secs = Number(header);
  const at = Number.isFinite(secs) ? now + secs * 1000 : Date.parse(header);
  if (!Number.isFinite(at)) return null;
  return Math.min(Math.max(at, now + BACKOFF_MIN_MS), now + RETRY_AFTER_MAX_MS);
}

function backoff(state, now) {
  state.failures += 1;
  const delay = Math.min(BACKOFF_MIN_MS * 2 ** (state.failures - 1), BACKOFF_MAX_MS);
  return now + delay;
}

function logOnce(message) {
  if (message === lastLoggedProblem) return;
  lastLoggedProblem = message;
  console.warn(`[telemetry] ${message}`);
}

async function post(url, report) {
  const { privateKey, publicKey } = collector.telemetryIdentity();
  const body = gzipSync(Buffer.from(JSON.stringify(report)));
  // Signed over exactly the bytes sent. The receiving end binds this public
  // key to the telemetry id on first sight; afterwards only it can write there.
  const signature = crypto.sign(null, body, privateKey).toString('base64');
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
      'X-Prodmesh-Key': publicKey,
      'X-Prodmesh-Signature': `ed25519=${signature}`,
    },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'error', // a redirect is not the endpoint we were given
  });
}

/**
 * One decision. Returns what it did, for the tests and the status line:
 * 'off' | 'no-endpoint' | 'show-live' | 'stopped' | 'backoff' | 'not-due'
 * | 'sent' | 'rejected' | 'refused' | 'failed' | 'busy'.
 */
export async function tick(now = Date.now()) {
  if (inFlight) return 'busy';
  if (!settings.getTelemetrySettings().enabled) {
    dropQueue();
    return 'off';
  }
  const url = endpoint();
  if (!url) return 'no-endpoint';
  if (isShowLive()) return 'show-live';

  const state = loadState();
  const version = deployment.getVersion().version;
  if (state.stoppedVersion && state.stoppedVersion === version) return 'stopped';
  if (state.backoffUntil && now < state.backoffUntil) return 'backoff';

  const queued = read(FILES.queue(), null);
  const window = collector.buildReport({ now, seq: queued?.seq ?? state.seq + 1 });
  const id = collector.telemetryId();
  const early = earlyDue(state, merge(queued, window), now);
  // A queued report that failed is retried once its backoff has passed.
  const retrying = Boolean(queued) && state.failures > 0;
  if (!dailyDue(state, now, id) && !early && !retrying) return 'not-due';

  // Close the window into the queue BEFORE sending: if the process dies
  // mid-request, what was gathered is on disk, not lost.
  const report = fit(merge(queued, window));
  collector.takeWindow(now);
  report.sentAt = now;
  report.telemetryId = id; // a Reset ID while queued: the old id is not sent
  writeJsonAtomic(FILES.queue(), report);

  const problems = validate(report);
  if (problems.length) {
    // A scrubber bug. Never send it, never retry it; say so once, plainly.
    logOnce(`refused to send a report the schema rejects (a bug, please report it): ${problems.slice(0, 3).join('; ')}`);
    dropQueue();
    Object.assign(state, { lastAttemptAt: now, lastResult: 'refused', lastError: problems[0], seq: report.seq });
    saveState(state);
    return 'refused';
  }

  state.lastAttemptAt = now;
  if (early) state.lastEarlyAt = now;
  let res;
  try {
    inFlight = post(url, report);
    res = await inFlight;
  } catch (err) {
    Object.assign(state, { lastResult: 'failed', lastError: String(err?.cause?.code ?? err?.name ?? 'network'), backoffUntil: backoff(state, now) });
    saveState(state);
    return 'failed';
  } finally {
    inFlight = null;
  }

  if (res.ok) {
    dropQueue();
    const reported = new Set([...state.reported, ...report.errors.map((e) => e.fingerprint)]);
    Object.assign(state, {
      seq: report.seq, lastSentAt: now, lastResult: 'sent', lastError: null,
      backoffUntil: null, failures: 0,
      reported: [...reported].slice(-500), // bounded; an old bug brought forward again is harmless
    });
    saveState(state);
    lastLoggedProblem = null;
    return 'sent';
  }
  if (res.status === 410) {
    dropQueue();
    Object.assign(state, { lastResult: 'stopped', lastError: '410', stoppedVersion: version, seq: report.seq });
    saveState(state);
    logOnce(`the receiving end no longer accepts reports from ${version}; not sending again until an update`);
    return 'stopped';
  }
  if (res.status === 400 || res.status === 413 || res.status === 422) {
    // Malformed by its rules. Retrying the same bytes forever helps no one.
    dropQueue();
    Object.assign(state, { lastResult: 'rejected', lastError: String(res.status), seq: report.seq, failures: 0, backoffUntil: null });
    saveState(state);
    logOnce(`report rejected (${res.status}); dropped`);
    return 'rejected';
  }
  const later = res.status === 429 || res.status === 503 ? retryAfter(res.headers.get('retry-after'), now) : null;
  Object.assign(state, { lastResult: 'failed', lastError: String(res.status), backoffUntil: later ?? backoff(state, now) });
  saveState(state);
  return 'failed';
}

/** For Admin: what happened last and what happens next, without the report. */
export function status() {
  const s = loadState();
  return {
    endpoint: endpoint() != null,
    lastSentAt: s.lastSentAt,
    lastAttemptAt: s.lastAttemptAt,
    lastResult: s.lastResult,
    lastError: s.lastError,
    backoffUntil: s.backoffUntil,
    queued: existsSync(FILES.queue()),
    stopped: s.stoppedVersion != null && s.stoppedVersion === deployment.getVersion().version,
  };
}

/** Consent withdrawn: forget what was waiting to go. */
export function forgetQueued() { dropQueue(); }

/** Start the timer. `showLive` says whether any show is live right now. */
export function start({ showLive } = {}) {
  if (showLive) isShowLive = showLive;
  if (timer) return;
  const run = () => { tick().catch((err) => logOnce(`tick failed: ${err?.message ?? err}`)); };
  timer = setInterval(run, TICK_EVERY_MS);
  timer.unref();
  // A crash is most useful reported soon after the restart it caused, so the
  // first look is a minute in, once boot's own work has settled.
  setTimeout(run, FIRST_TICK_MS).unref();
}

/** Tests only. */
export function _configureForTests({ showLive = () => false } = {}) {
  isShowLive = showLive;
  lastLoggedProblem = null;
}

export { MAX_BYTES };
