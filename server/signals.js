// ─────────────────────────────────────────────────────────────────────────────
//  SIGNALS  —  facts about things that changed (ADR 0019).
//
//  A signal is append-only: an integration went down, a show item started, a
//  room changed mode. Rules (rules.js) decide what a signal means; this module
//  only records it and hands it on.
//
//  THE LIVE SHOW COMES FIRST. The process that records signals is the process
//  serving the show's SSE stream, and better-sqlite3 is synchronous, so:
//
//    • emit() is a queue push. It never touches the database and never waits.
//      The show manager's 800 ms poll calls it and must not notice.
//    • The queue drains on setImmediate, writing everything pending in ONE
//      transaction. A burst of a hundred signals is one write, not a hundred.
//    • The queue is bounded. Past MAX_QUEUE new signals are counted and
//      dropped, and the count is recorded as one `signals.dropped` signal when
//      the queue has room again. Losing detail in a storm is acceptable;
//      stalling the show is not.
//    • Listeners (the rule evaluator) are called after the write, with the
//      batch, and each in its own try. A listener's error is our bug, logged
//      through unexpected(), never the church's outage.
//
//  Signals record changes, not continuous state. A slide advance is not a
//  signal (hundreds per service, and the timeline already has them); an item
//  starting is (about thirty).
// ─────────────────────────────────────────────────────────────────────────────

import { getDb } from './db.js';
import { unexpected } from './health.js';
import { pruneTable, register } from './retention.js';

export const TRUST = ['local', 'authenticated', 'unauthenticated'];
export const SEVERITIES = ['info', 'warning', 'error', 'critical'];

const MAX_QUEUE = 1000;
const MAX_TEXT = 300; // summary
const MAX_DATA = 4096; // serialized data, bytes-ish (UTF-16 units)

const queue = [];
let scheduled = false;
let dropped = 0;
const listeners = new Set();

const clip = (s, n) => (s == null ? null : String(s).slice(0, n));

function boundedData(data) {
  if (data == null) return null;
  let json;
  try {
    json = JSON.stringify(data);
  } catch {
    return JSON.stringify({ unserializable: true });
  }
  return json.length <= MAX_DATA ? json : JSON.stringify({ truncated: true, size: json.length });
}

/**
 * Record a signal. Returns at once; the write happens on the next turn of the
 * event loop. Returns false if the queue was full and the signal was dropped.
 *
 *   emit({ kind: 'integration.down', source: 'health', subject: key,
 *          roomId, severity: 'error', summary, data })
 *
 * `trust` defaults to 'local' — our own code. `cause` is set by actions:
 * { rule, depth } — see rules.js.
 */
export function emit(signal) {
  if (queue.length >= MAX_QUEUE) {
    dropped += 1;
    return false;
  }
  queue.push({
    ts: signal.ts ?? Date.now(),
    kind: String(signal.kind),
    source: String(signal.source ?? 'local'),
    roomId: signal.roomId ?? null,
    siteId: signal.siteId ?? null,
    subject: clip(signal.subject, 200),
    severity: SEVERITIES.includes(signal.severity) ? signal.severity : null,
    trust: TRUST.includes(signal.trust) ? signal.trust : 'local',
    summary: clip(signal.summary, MAX_TEXT),
    data: signal.data ?? null,
    cause: signal.cause ?? null,
  });
  if (!scheduled) {
    scheduled = true;
    setImmediate(flush);
  }
  return true;
}

let insert = null;
function insertBatch(batch) {
  const db = getDb();
  insert ??= db.prepare(
    `INSERT INTO signals (ts, kind, source, room_id, site_id, subject, severity, trust, summary, data, cause)
     VALUES (@ts, @kind, @source, @roomId, @siteId, @subject, @severity, @trust, @summary, @data, @cause)`,
  );
  db.transaction(() => {
    for (const s of batch) {
      const { lastInsertRowid } = insert.run({
        ...s,
        data: boundedData(s.data),
        cause: s.cause ? JSON.stringify(s.cause) : null,
      });
      s.id = Number(lastInsertRowid);
    }
  })();
}

function flush() {
  scheduled = false;
  if (!queue.length) return;
  const batch = queue.splice(0, queue.length);
  if (dropped) {
    batch.push({
      ts: Date.now(),
      kind: 'signals.dropped',
      source: 'signals',
      roomId: null,
      siteId: null,
      subject: null,
      severity: 'warning',
      trust: 'local',
      summary: `${dropped} signals dropped while the queue was full`,
      data: { count: dropped },
      cause: null,
    });
    dropped = 0;
  }
  try {
    insertBatch(batch);
  } catch (err) {
    // A failed write must not lose the rules' view of what happened, nor
    // throw out of a setImmediate into the process.
    unexpected('signals', err);
  }
  for (const fn of listeners) {
    try {
      fn(batch);
    } catch (err) {
      unexpected('signals listener', err);
    }
  }
}

/** Called with each written batch, in emit order. Returns an unsubscribe. */
export function onBatch(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const fromRow = (r) => ({
  id: r.id,
  ts: r.ts,
  kind: r.kind,
  source: r.source,
  roomId: r.room_id,
  siteId: r.site_id,
  subject: r.subject,
  severity: r.severity,
  trust: r.trust,
  summary: r.summary,
  data: r.data ? JSON.parse(r.data) : null,
  cause: r.cause ? JSON.parse(r.cause) : null,
});

/**
 * Newest first. `before` pages backwards by id; `kind` matches exactly or by
 * prefix when it ends in '.' ('integration.'); `roomId` filters by room.
 */
export function list({ limit = 100, before = null, kind = null, roomId = null } = {}) {
  const where = [];
  const args = {};
  if (before != null) { where.push('id < @before'); args.before = Number(before); }
  if (kind) {
    if (kind.endsWith('.')) { where.push('kind >= @lo AND kind < @hi'); args.lo = kind; args.hi = `${kind.slice(0, -1)}/`; }
    else { where.push('kind = @kind'); args.kind = kind; }
  }
  if (roomId) { where.push('room_id = @roomId'); args.roomId = roomId; }
  const n = Math.max(1, Math.min(500, Number(limit) || 100));
  return getDb()
    .prepare(`SELECT * FROM signals ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ${n}`)
    .all(args)
    .map(fromRow);
}

export function prune(days = Number(process.env.PRODMESH_SIGNAL_RETENTION_DAYS ?? 90), isBusy) {
  return pruneTable({ table: 'signals', days, isBusy, label: 'signals' });
}

export function startRetention() {
  register('signals', (isBusy) => prune(undefined, isBusy));
}

/** Tests: write anything pending now, synchronously. */
export function flushNow() {
  flush();
}

/** Tests only. */
export function reset() {
  queue.length = 0;
  dropped = 0;
  scheduled = false;
  listeners.clear();
}

/** Tests only: how many are waiting to be written. */
export const pendingCount = () => queue.length;
