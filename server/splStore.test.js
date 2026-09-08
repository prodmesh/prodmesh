import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PRODMESH_DATA_DIR = mkdtempSync(join(tmpdir(), 'prodmesh-spl-'));
const spl = await import('./splStore.js');
const smaart = await import('./integrations/smaart.js');
const { getDb } = await import('./db.js');

test('leq is an energy average, not arithmetic', () => {
  // Constant level → Leq equals it.
  assert.ok(Math.abs(spl.leq([90, 90, 90]) - 90) < 1e-9);
  // Loud minutes dominate: 80 & 90 average well above the 85 midpoint.
  const v = spl.leq([80, 90]);
  assert.ok(v > 86.5 && v < 88, `got ${v}`);
  assert.equal(spl.leq([]), null);
});

test('samples round-trip through SQLite with correct aggregates', () => {
  const inst = 'plan1__t1';
  spl.record('room-a', inst, 1000, 85);
  spl.record('room-a', inst, 2000, 95);
  spl.record('room-a', inst, 3000, 90);
  const agg = spl.aggregate(inst);
  assert.equal(agg.count, 3);
  assert.equal(agg.peak, 95);
  assert.equal(agg.from, 1000);
  assert.equal(agg.to, 3000);
  assert.ok(agg.leq > 90 && agg.leq < 93, `leq ${agg.leq}`);
  assert.equal(spl.aggregate('nope__x'), null);
});

test('aggregateRange keeps an item’s samples separate from the next item', () => {
  const inst = 'plan-range__t1';
  spl.record('room-a', inst, 1_000, 80);
  spl.record('room-a', inst, 2_000, 90);
  spl.record('room-a', inst, 3_000, 100);
  const first = spl.aggregateRange(inst, 1_000, 3_000);
  const second = spl.aggregateRange(inst, 3_000, 4_000);
  assert.equal(first.count, 2);
  assert.equal(first.peak, 90);
  assert.equal(second.count, 1);
  assert.equal(second.leq, 100);
  assert.equal(spl.aggregateRange(inst, 4_000, 4_000), null);
});

test('runningStats seeds continuation of a reopened show', () => {
  const inst = 'plan2__t1';
  spl.record('room-a', inst, 1, 88);
  spl.record('room-a', inst, 2, 92);
  const st = spl.runningStats(inst);
  assert.equal(st.n, 2);
  assert.equal(st.peak, 92);
  assert.ok(st.sumEnergy > 0);
  assert.deepEqual(spl.runningStats('fresh__t'), {
    n: 0, sumEnergy: 0, peak: null, caN: 0, caSum: 0, caMax: null,
  });
});

test('ca rides along when captured: plain mean, max, and null when absent', () => {
  const inst = 'plan3__t1';
  spl.record('room-a', inst, 1, 88, 8.0);
  spl.record('room-a', inst, 2, 92, 12.0);
  spl.record('room-a', inst, 3, 90); // a Smaart-style sample without ca
  const agg = spl.aggregate(inst);
  assert.deepEqual(agg.ca, { avg: 10, max: 12 });
  const st = spl.runningStats(inst);
  assert.equal(st.caN, 2);
  assert.equal(st.caSum, 20);
  assert.equal(st.caMax, 12);
  // No ca captured at all → the aggregate says so instead of faking zeros.
  const inst2 = 'plan3__t2';
  spl.record('room-a', inst2, 1, 88);
  assert.equal(spl.aggregate(inst2).ca, null);
});

test('mock smaart meter emits plausible samples until aborted', async () => {
  const ctl = new AbortController();
  const samples = [];
  const run = smaart.watchSpl({ mock: true }, (s) => samples.push(s), ctl.signal, 5);
  await new Promise((r) => setTimeout(r, 60));
  ctl.abort();
  await run;
  assert.ok(samples.length >= 3, `got ${samples.length}`);
  for (const s of samples) {
    assert.ok(s.spl >= 76 && s.spl <= 98, `spl ${s.spl}`);
    assert.ok(Number.isFinite(s.ts));
  }
});

test('smaart isConfigured', () => {
  assert.equal(smaart.isConfigured(undefined), false);
  assert.equal(smaart.isConfigured({ mock: true }), true);
  assert.equal(smaart.isConfigured({ host: '10.0.0.5' }), true);
  assert.equal(smaart.isConfigured({}), false);
});

test('a show left running for days can still be aggregated and ended', () => {
  // Hit on a real box 2026-08-10: a show running since the 3rd had 164,398
  // samples across 81.5 hours, and `Math.max(...values)` passes one ARGUMENT
  // per sample. V8 throws "Maximum call stack size exceeded" past ~100k, and
  // it throws inside the aggregation that ENDING a show runs — so the show
  // could not be ended at all, from the UI or from a hand-rolled request.
  //
  // 150k here rather than 164k: comfortably past the limit, still quick.
  const inst = 'marathon__t';
  const db = getDb();
  const insert = db.prepare('INSERT INTO spl_samples (room_id, instance_id, ts, spl, ca) VALUES (?,?,?,?,?)');
  db.transaction(() => {
    for (let i = 0; i < 150_000; i += 1) insert.run('r1', inst, 1000 + i, 80 + (i % 17) / 10, (i % 5) + 1);
  })();

  const agg = spl.aggregate(inst);
  assert.equal(agg.count, 150_000);
  assert.equal(agg.peak, 81.6, 'the loudest sample, found without a spread');
  assert.equal(agg.ca.max, 5);

  const st = spl.runningStats(inst);
  assert.equal(st.n, 150_000);
  assert.equal(st.peak, 81.6);
  assert.equal(st.caMax, 5);
});

test('peak survives aggregation, and pre-aggregation rows still report one', () => {
  // A row used to be one instantaneous reading. Fast analyzers turned it into
  // a second of energy-averaged samples, so the loudest moment inside that
  // second needs its own column or a transient averages away.
  const inst = 'peaks__t';
  // Two aggregated seconds: a quiet one, then one holding a 105 dB transient
  // whose Leq is only 93.4 — the number the report used to quote as the peak.
  spl.record('r1', inst, 1000, 88, null, 88);
  spl.record('r1', inst, 2000, 93.4, null, 105);

  const agg = spl.aggregate(inst);
  assert.equal(agg.peak, 105, 'the loudest sample, not the loudest bucket average');
  assert.ok(agg.leq > 91 && agg.leq < 92, `Leq stays built from bucket energy, got ${agg.leq}`);
  assert.equal(spl.runningStats(inst).peak, 105);
  assert.equal(spl.aggregateRange(inst, 1500, 2500).peak, 105, 'and per-item too');

  // Rows written before the column exists: spl IS the instantaneous peak, so
  // reading them must not report a null or skip them.
  const legacy = 'legacy__t';
  getDb()
    .prepare('INSERT INTO spl_samples (room_id, instance_id, ts, spl, ca) VALUES (?,?,?,?,?)')
    .run('r1', legacy, 1000, 97.5, null);
  assert.equal(spl.aggregate(legacy).peak, 97.5);
  assert.equal(spl.runningStats(legacy).peak, 97.5);
});
