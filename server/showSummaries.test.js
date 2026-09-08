import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenOnLoopback } from './testServer.js';

// Isolated store, then import the app (which won't listen on its own).
process.env.PRODMESH_DATA_DIR = mkdtempSync(join(tmpdir(), 'prodmesh-summaries-'));
const { app } = await import('./index.js');
const timeline = await import('./timeline.js');
const auth = await import('./authStore.js');
const splStore = await import('./splStore.js');
const summaries = await import('./showSummaries.js');

const ROOM = 'north-youth'; // exists in the seed config (mock room)
const T0 = Date.now() - 3_600_000; // "an hour ago" — inside any retention window

let base;
let server;
// After-action reports are behind reports.view (operational plan notes stay
// open — camera ops need to know who is next; retrospective analysis doesn't
// need to be public). These tests read them, so they read them as someone who
// is allowed to.
const viewerGroup = auth.createGroup({ name: 'Report Viewers', permissions: ['reports.view'] });
auth.createUser({ username: 'reportviewer', displayName: 'Report Viewer', pin: '8642', groupIds: [viewerGroup.id] });
const viewerStation = auth.registerStation({ name: 'Report Viewer Station' });
let viewer; // headers

before(async () => {
  ({ server, base } = await listenOnLoopback(app));
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Prodmesh-Station': viewerStation.token },
    body: JSON.stringify({ username: 'reportviewer', pin: '8642' }),
  });
  viewer = { headers: { Authorization: `Bearer ${(await login.json()).token}` } };
});
after(() => server.close());

// A finished two-item show with three SPL samples, ended T0+150s.
const INST = 'plan-sum__time-1';
function recordFinishedShow() {
  const ctx = { roomId: ROOM, planId: 'plan-sum', timeId: 'time-1' };
  timeline.ensure(INST, { ...ctx, planTitle: 'Summary Test Service', dates: 'July 27' });
  timeline.recordActive(INST, ctx, { itemId: 'i1', itemName: 'Welcome', plannedLength: 60 }, T0);
  timeline.recordActive(INST, ctx, { itemId: 'i2', itemName: 'Message', plannedLength: 30 }, T0 + 60_000);
  splStore.record(ROOM, INST, T0 + 1_000, 85);
  splStore.record(ROOM, INST, T0 + 2_000, 95);
  splStore.record(ROOM, INST, T0 + 3_000, 90, 12.5);
  timeline.finalize(INST, T0 + 150_000);
}

test('refresh builds the summary row from the timeline and SPL samples', () => {
  recordFinishedShow();
  const row = summaries.refresh(INST);

  assert.equal(row.roomId, ROOM);
  assert.equal(row.planId, 'plan-sum');
  assert.equal(row.timeId, 'time-1');
  assert.equal(row.planTitle, 'Summary Test Service');
  assert.equal(row.itemCount, 2);
  assert.equal(row.startedAt, T0);
  assert.equal(row.completedAt, T0 + 150_000);
  assert.equal(row.plannedSeconds, 90);
  assert.equal(row.actualSeconds, 150); // 60s + 90s (finalize closes item 2)
  assert.equal(row.spl.count, 3);
  assert.equal(row.spl.peak, 95);
  assert.ok(row.spl.leq > 85 && row.spl.leq < 95); // energy average, pulled up by 95
  assert.deepEqual(row.spl.ca, { avg: 12.5, max: 12.5 });
});

test('reopening a show clears the completion stamp in the summary', () => {
  timeline.reopen(INST);
  assert.equal(summaries.refresh(INST).completedAt, null);
  timeline.finalize(INST, T0 + 150_000); // restore for later tests
  summaries.refresh(INST);
});

test('GET /api/history serves the summary rows, newest first', async () => {
  // A second, later, label-less show — exercises ordering and null labels.
  const ctx = { roomId: ROOM, planId: 'plan-sum2', timeId: 'time-1' };
  timeline.recordActive('plan-sum2__time-1', ctx, { itemId: 'a', itemName: 'Only' }, T0 + 500_000);
  timeline.finalize('plan-sum2__time-1', T0 + 560_000);
  summaries.refresh('plan-sum2__time-1');

  const res = await fetch(`${base}/api/history`, viewer);
  assert.equal(res.status, 200);
  const { shows } = await res.json();

  const ids = shows.map((s) => s.instanceId);
  assert.ok(ids.indexOf('plan-sum2__time-1') < ids.indexOf(INST), 'newest first');

  const row = shows.find((s) => s.instanceId === INST);
  assert.equal(row.planTitle, 'Summary Test Service');
  assert.equal(row.roomName, 'Youth Room'); // resolved from the live rooms map (DB topology)
  assert.deepEqual(row.totals, { planned: 90, actual: 150, delta: 60 });
  assert.equal(row.spl.peak, 95);
  assert.ok('target' in row.spl && 'limit' in row.spl); // room targets applied at read
});

test('syncFromTimelines backfills timelines that predate the summary table', () => {
  // A timeline recorded without any summary write (pre-summaries build).
  const ctx = { roomId: ROOM, planId: 'plan-legacy', timeId: 'default' };
  timeline.recordActive('plan-legacy__default', ctx, { itemId: 'x', itemName: 'Legacy' }, T0);
  timeline.finalize('plan-legacy__default', T0 + 60_000);
  assert.equal(summaries.get('plan-legacy__default'), null);

  summaries.resetSyncFlag();
  summaries.syncFromTimelines();

  const row = summaries.get('plan-legacy__default');
  assert.equal(row.itemCount, 1);
  assert.equal(row.completedAt, T0 + 60_000);

  // Already-summarized rows aren't rebuilt into duplicates.
  summaries.resetSyncFlag();
  summaries.syncFromTimelines();
  assert.equal(summaries.listAll().filter((r) => r.instanceId === 'plan-legacy__default').length, 1);
});

test('pruned SPL samples: report falls back to the summary aggregate', async () => {
  // Age this show's samples past a 90-day window, then prune.
  const OLD = Date.now() - 100 * 86_400_000;
  const ctx = { roomId: ROOM, planId: 'plan-old', timeId: 'default' };
  timeline.recordActive('plan-old__default', ctx, { itemId: 'o', itemName: 'Old', plannedLength: 60 }, OLD);
  splStore.record(ROOM, 'plan-old__default', OLD + 1_000, 88);
  splStore.record(ROOM, 'plan-old__default', OLD + 2_000, 92);
  timeline.finalize('plan-old__default', OLD + 60_000);
  summaries.refresh('plan-old__default');

  assert.equal(splStore.prune(0), 0); // disabled → no-op
  assert.equal(splStore.prune(90), 2); // only the aged samples go
  assert.equal(splStore.aggregate('plan-old__default'), null);

  // The report still carries the SPL block, served from the summary row.
  const res = await fetch(`${base}/api/rooms/${ROOM}/plan/plan-old/report`, viewer);
  const report = await res.json();
  assert.equal(report.spl.count, 2);
  assert.equal(report.spl.peak, 92);

  // A later refresh (e.g. label backfill) must not wipe the kept aggregate.
  assert.equal(summaries.refresh('plan-old__default').spl.peak, 92);

  // Recent samples survived the prune.
  assert.equal(splStore.aggregate(INST).count, 3);
});

test('rehearsal start records under a synthetic rehearsal timeId, flagged in history', async () => {
  // A user with shows.operate, since /show/start is permission-gated.
  const auth = await import('./authStore.js');
  const group = auth.createGroup({ name: 'Show Runners', permissions: ['shows.operate'] });
  auth.createUser({ username: 'runner', displayName: 'Runner', pin: '1357', groupIds: [group.id] });
  const station = auth.registerStation({ name: 'Summaries Test Station' });
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Prodmesh-Station': station.token },
    body: JSON.stringify({ username: 'runner', pin: '1357' }),
  });
  const { token } = await login.json();
  const authed = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Prodmesh-Station': station.token };

  const started = await fetch(`${base}/api/rooms/${ROOM}/show/start`, {
    method: 'POST',
    headers: authed,
    body: JSON.stringify({ planId: 'plan-sum', timeId: 'time-1', rehearsal: true }),
  });
  assert.equal(started.status, 200);
  const state = await started.json();
  assert.match(state.timeId, /^rehearsal-\d+$/); // NOT the service's time-1
  assert.equal(state.active, true);

  const ended = await fetch(`${base}/api/rooms/${ROOM}/show/end`, { method: 'POST', headers: authed });
  assert.equal(ended.status, 200);

  const { shows } = await (await fetch(`${base}/api/history`, viewer)).json();
  const rehearsalRow = shows.find((s) => s.timeId === state.timeId);
  assert.equal(rehearsalRow.rehearsal, true);
  assert.ok(rehearsalRow.completedAt, 'rehearsal completes like any show');
  // The real service instance from the earlier tests is untouched and unflagged.
  const serviceRow = shows.find((s) => s.instanceId === INST);
  assert.equal(serviceRow.rehearsal, false);
  assert.equal(serviceRow.totals.planned, 90);
});

test('DELETE /api/history/:instanceId erases a run (gated, audited, refuses live shows)', async () => {
  const auth = await import('./authStore.js');
  const splStore2 = await import('./splStore.js');
  const group = auth.createGroup({ name: 'Historians', permissions: ['history.delete', 'shows.operate'] });
  auth.createUser({ username: 'historian', displayName: 'Historian', pin: '2460', groupIds: [group.id] });
  const station = auth.registerStation({ name: 'Delete Test Station' });
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Prodmesh-Station': station.token },
    body: JSON.stringify({ username: 'historian', pin: '2460' }),
  });
  const { token } = await login.json();
  const authed = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Prodmesh-Station': station.token };

  // No permission → denied (station-only identity).
  const anon = await fetch(`${base}/api/history/plan-old__default`, { method: 'DELETE' });
  assert.equal(anon.status, 401);

  // A live show's instance is protected.
  const started = await (await fetch(`${base}/api/rooms/${ROOM}/show/start`, {
    method: 'POST', headers: authed, body: JSON.stringify({ planId: 'plan-live', timeId: 'now' }),
  })).json();
  assert.equal(started.active, true);
  const liveDel = await fetch(`${base}/api/history/plan-live__now`, { method: 'DELETE', headers: authed });
  assert.equal(liveDel.status, 409);
  await fetch(`${base}/api/rooms/${ROOM}/show/end`, { method: 'POST', headers: authed });

  // Deleting an ended run removes timeline + samples + summary + history row.
  const del = await fetch(`${base}/api/history/plan-old__default`, { method: 'DELETE', headers: authed });
  assert.equal(del.status, 200);
  assert.equal(summaries.get('plan-old__default'), null);
  assert.equal(timeline.get('plan-old__default'), null);
  assert.equal(splStore2.aggregate('plan-old__default'), null);
  const { shows } = await (await fetch(`${base}/api/history`, viewer)).json();
  assert.ok(!shows.some((s) => s.instanceId === 'plan-old__default'));

  // Deleting it again → 404.
  const again = await fetch(`${base}/api/history/plan-old__default`, { method: 'DELETE', headers: authed });
  assert.equal(again.status, 404);
});
