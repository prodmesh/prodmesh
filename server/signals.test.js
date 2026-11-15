// The signal queue and chunked retention: the parts of ADR 0019's "the live
// show comes first" that are about not holding the event loop.

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PRODMESH_DATA_DIR = mkdtempSync(join(tmpdir(), 'prodmesh-signals-'));

const signals = await import('./signals.js');
const retention = await import('./retention.js');
const splStore = await import('./splStore.js');
const { getDb } = await import('./db.js');

const nextTurn = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  signals.reset();
  getDb().exec('DELETE FROM signals; DELETE FROM spl_samples;');
});

test('emit is a queue push: nothing is written until the next turn', async () => {
  signals.emit({ kind: 'test.a', source: 'test' });
  assert.equal(signals.list().length, 0, 'emit must not touch the database');
  assert.equal(signals.pendingCount(), 1);
  await nextTurn();
  assert.equal(signals.list().length, 1);
});

test('a burst is one batch, in emit order, handed to listeners after it is written', async () => {
  const batches = [];
  signals.onBatch((b) => batches.push(b.map((s) => [s.kind, s.id, signals.list({ limit: 500 }).length])));
  for (let i = 0; i < 100; i += 1) signals.emit({ kind: `test.${i}`, source: 'test' });
  await nextTurn();
  assert.equal(batches.length, 1, 'a hundred signals, one write');
  assert.equal(batches[0].length, 100);
  assert.equal(batches[0][0][0], 'test.0');
  assert.equal(batches[0][99][0], 'test.99');
  assert.ok(batches[0].every(([, id, written]) => id > 0 && written === 100), 'listeners see written, numbered signals');
});

test('the queue is bounded; overflow becomes one signals.dropped', async () => {
  for (let i = 0; i < 1005; i += 1) signals.emit({ kind: 'storm', source: 'test' });
  assert.equal(signals.emit({ kind: 'storm', source: 'test' }), false);
  await nextTurn();
  const [dropped] = signals.list({ kind: 'signals.dropped' });
  assert.equal(dropped.data.count, 6);
  assert.equal(signals.list({ kind: 'storm', limit: 500 }).length, 500);
});

test('a listener that throws does not stop the next one', async () => {
  let reached = false;
  signals.onBatch(() => { throw new Error('boom'); });
  signals.onBatch(() => { reached = true; });
  signals.emit({ kind: 'test.x', source: 'test' });
  await nextTurn();
  assert.equal(reached, true);
});

test('fields are bounded and trust defaults to local', async () => {
  signals.emit({
    kind: 'test.big',
    source: 'test',
    summary: 'x'.repeat(5000),
    data: { blob: 'y'.repeat(10_000) },
    trust: 'root',
    severity: 'apocalyptic',
  });
  await nextTurn();
  const [s] = signals.list();
  assert.equal(s.summary.length, 300);
  assert.deepEqual(Object.keys(s.data), ['truncated', 'size']);
  assert.equal(s.trust, 'local', 'an unknown trust level is not trusted more');
  assert.equal(s.severity, null);
});

test('list filters by exact kind or by area prefix', async () => {
  for (const kind of ['integration.down', 'integration.up', 'show.started', 'integrationx.y']) {
    signals.emit({ kind, source: 'test' });
  }
  await nextTurn();
  assert.deepEqual(signals.list({ kind: 'integration.' }).map((s) => s.kind).sort(), ['integration.down', 'integration.up']);
  assert.equal(signals.list({ kind: 'show.started' }).length, 1);
});

test('retention deletes in chunks, yielding between them', async () => {
  const old = Date.now() - 200 * 86_400_000;
  const insert = getDb().prepare('INSERT INTO spl_samples (room_id, instance_id, ts, spl) VALUES (?, ?, ?, ?)');
  getDb().transaction(() => {
    for (let i = 0; i < 1800; i += 1) insert.run('r', 'i', old + i, 80);
    insert.run('r', 'i', Date.now(), 80);
  })();
  let turns = 0;
  let counting = true;
  const tick = () => { if (counting) { turns += 1; setImmediate(tick); } };
  setImmediate(tick);
  const removed = await splStore.prune(90);
  counting = false;
  assert.equal(removed, 1800);
  assert.ok(turns >= 3, `the event loop ran between chunks (${turns} turns)`);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM spl_samples').get().n, 1);
});

test('retention catches rows inserted out of time order', async () => {
  getDb().prepare('INSERT INTO spl_samples (room_id, instance_id, ts, spl) VALUES (?, ?, ?, ?)').run('r', 'i', Date.now(), 80);
  getDb().prepare('INSERT INTO spl_samples (room_id, instance_id, ts, spl) VALUES (?, ?, ?, ?)').run('r', 'i', Date.now() - 200 * 86_400_000, 80);
  assert.equal(await splStore.prune(90), 1);
});

test('retention never runs while a show is live, and stops if one starts', async () => {
  const old = Date.now() - 200 * 86_400_000;
  const insert = getDb().prepare('INSERT INTO spl_samples (room_id, instance_id, ts, spl) VALUES (?, ?, ?, ?)');
  getDb().transaction(() => { for (let i = 0; i < 1500; i += 1) insert.run('r', 'i', old + i, 80); })();

  assert.equal(await splStore.prune(90, () => true), 0, 'a live show: nothing pruned');

  let calls = 0;
  const removed = await splStore.prune(90, () => (calls += 1) > 1); // goes live after the first chunk
  assert.equal(removed, 500);
});

test('the scheduler skips a busy server and runs each job at most daily', async () => {
  retention.reset();
  let runs = 0;
  retention.register('probe', async () => { runs += 1; return 0; });
  let busy = true;
  retention.start({ isBusy: () => busy, firstDelayMs: 60_000 });
  await retention.runAllNow();
  assert.equal(runs, 0, 'not while a show is live');
  busy = false;
  await retention.runAllNow();
  assert.equal(runs, 1);
  retention.reset();
});
