// ─────────────────────────────────────────────────────────────────────────────
//  STREAM STORE  —  YouTube Live viewer counts captured while a show is live.
//
//  Sibling of splStore.js, same instanceId key (planId__timeId), so the Show
//  Report can join timing, loudness and viewership.
//
//  Worth remembering why this table exists at all: YouTube reports
//  `concurrentViewers` only DURING a broadcast and discards it afterwards. If
//  we don't write it down as it happens, the number is gone. That makes these
//  rows the primary record, not a cache of something recoverable — which is
//  why retention is generous and the aggregate is copied into show_summaries
//  before samples are ever pruned.
// ─────────────────────────────────────────────────────────────────────────────

import { getDb } from './db.js';
import { pruneTable, register } from './retention.js';

export function record(roomId, instanceId, ts, viewers) {
  getDb()
    .prepare('INSERT INTO stream_samples (room_id, instance_id, ts, viewers) VALUES (?, ?, ?, ?)')
    .run(roomId, instanceId, ts, viewers);
}

/**
 * Aggregate a service instance → { count, peak, avg, from, to }.
 *
 * A plain mean, not an energy average: viewers are a count of people, and
 * "average concurrent viewers" is the ordinary arithmetic thing everyone
 * means by it. (Contrast splStore.leq, where the energy average is the whole
 * point.)
 */
export function aggregate(instanceId) {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS count, MAX(viewers) AS peak, AVG(viewers) AS avg,
              MIN(ts) AS "from", MAX(ts) AS "to"
         FROM stream_samples WHERE instance_id = ?`,
    )
    .get(instanceId);
  if (!row || row.count === 0) return null;
  return {
    count: row.count,
    peak: row.peak,
    avg: Math.round(row.avg),
    from: row.from,
    to: row.to,
  };
}

/**
 * The curve, thinned to at most `maxPoints` evenly-spaced samples.
 *
 * A 90-minute service at 30s intervals is ~180 rows, which a sparkline cannot
 * usefully draw and nobody can see. Thinning happens here rather than in the
 * browser so the report response stays small on a booth machine's wifi.
 */
export function series(instanceId, maxPoints = 60) {
  const rows = getDb()
    .prepare('SELECT ts, viewers FROM stream_samples WHERE instance_id = ? ORDER BY ts')
    .all(instanceId);
  if (rows.length <= maxPoints) return rows;
  const step = (rows.length - 1) / (maxPoints - 1);
  // Always keep the first and last point: a curve that doesn't start where the
  // service started reads as missing data.
  return Array.from({ length: maxPoints }, (_, i) => rows[Math.round(i * step)]);
}

/** Running stats seed for a (re)starting show — continues where it left off. */
export function runningStats(instanceId) {
  const agg = aggregate(instanceId);
  return agg
    ? { n: agg.count, sum: agg.avg * agg.count, peak: agg.peak }
    : { n: 0, sum: 0, peak: null };
}

/** Erase one instance's samples (deleting a recorded show). */
export function removeInstance(instanceId) {
  return getDb().prepare('DELETE FROM stream_samples WHERE instance_id = ?').run(instanceId).changes;
}

// ── Retention ────────────────────────────────────────────────────────────────
// Longer default than SPL (365 vs 90 days): a year of attendance curves is the
// comparison a church actually wants ("how did this Easter compare"), the rows
// are ~1/30th the volume of SPL, and unlike SPL this data cannot be
// regenerated from anywhere if it is thrown away.

export function prune(days = Number(process.env.PRODMESH_STREAM_RETENTION_DAYS ?? 365), isBusy) {
  return pruneTable({ table: 'stream_samples', days, isBusy, label: 'viewer samples' });
}

/** Prune daily, in chunks and never while a show is live (retention.js). */
export function startRetention() {
  register('viewer samples', (isBusy) => prune(undefined, isBusy));
}
