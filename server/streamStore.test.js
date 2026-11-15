// Viewer-sample storage: aggregation, curve thinning, retention.

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PRODMESH_DATA_DIR = mkdtempSync(join(tmpdir(), 'prodmesh-stream-store-'));
const store = await import('./streamStore.js');
const { getDb } = await import('./db.js');

const INSTANCE = 'plan-1__t-svc';
const ROOM = 'north-main';

beforeEach(() => getDb().prepare('DELETE FROM stream_samples').run());

const fill = (values, startTs = 1_000_000) =>
  values.forEach((v, i) => store.record(ROOM, INSTANCE, startTs + i * 30_000, v));

test('aggregate reports peak and a plain arithmetic mean', () => {
  fill([10, 40, 70]);
  const agg = store.aggregate(INSTANCE);
  assert.equal(agg.count, 3);
  assert.equal(agg.peak, 70);
  // Deliberately NOT an energy average like SPL's Leq — these are people, and
  // "average concurrent viewers" means the ordinary mean.
  assert.equal(agg.avg, 40);
  assert.equal(agg.from, 1_000_000);
  assert.equal(agg.to, 1_060_000);
});

test('aggregate is null for a service that recorded nothing', () => {
  assert.equal(store.aggregate('never-ran'), null);
});

test('the curve is returned whole when it is short enough to draw', () => {
  fill([1, 2, 3, 4]);
  assert.deepEqual(store.series(INSTANCE, 60).map((r) => r.viewers), [1, 2, 3, 4]);
});

test('a long service is thinned, keeping the first and last points', () => {
  // 90 minutes at 30s = 180 rows: more than a sparkline can show or an eye read.
  fill(Array.from({ length: 180 }, (_, i) => i));
  const series = store.series(INSTANCE, 60);
  assert.equal(series.length, 60);
  assert.equal(series[0].viewers, 0, 'a curve must start where the service started');
  assert.equal(series.at(-1).viewers, 179, 'and end where it ended');
  // Monotonic input stays monotonic — thinning must not reorder.
  const vals = series.map((r) => r.viewers);
  assert.deepEqual(vals, [...vals].sort((a, b) => a - b));
});

test('running stats let a reopened show continue its peak and average', () => {
  fill([10, 20, 60]);
  const st = store.runningStats(INSTANCE);
  assert.equal(st.n, 3);
  assert.equal(st.peak, 60);
  assert.equal(st.sum / st.n, 30);
});

test('running stats for an unrecorded show start from zero, not from null math', () => {
  const st = store.runningStats('fresh');
  assert.deepEqual(st, { n: 0, sum: 0, peak: null });
});

test('removeInstance erases only that service', () => {
  fill([1, 2]);
  store.record(ROOM, 'other__t', 2_000_000, 99);
  assert.equal(store.removeInstance(INSTANCE), 2);
  assert.equal(store.aggregate(INSTANCE), null);
  assert.equal(store.aggregate('other__t').count, 1);
});

test('retention prunes by age, and is disabled by a non-positive window', async () => {
  const old = Date.now() - 400 * 86_400_000;
  store.record(ROOM, INSTANCE, old, 5);
  store.record(ROOM, INSTANCE, Date.now(), 6);

  assert.equal(await store.prune(0), 0, '0 days must mean "keep everything", not "delete everything"');
  assert.equal(await store.prune(-1), 0);
  assert.equal(store.aggregate(INSTANCE).count, 2);

  assert.equal(await store.prune(365), 1);
  assert.equal(store.aggregate(INSTANCE).count, 1);
});
