// End-to-end scheduled-time autostart: the per-room watcher starting real
// shows on the clock, in a room with no ProPresenter at all. Its own file
// because the env below has to be set before showManager boots.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PRODMESH_DATA_DIR = mkdtempSync(join(tmpdir(), 'prodmesh-autostart-clock-'));
process.env.PRODMESH_AUTOSTART_TEST = '1'; // don't wait days for next Sunday's 9:00
process.env.PRODMESH_AUTOSTART_POLL_MS = '100';
process.env.PRODMESH_AUTOSTART_ARM_MS = '2000';

const sm = await import('./showManager.js');
const showCfg = await import('./showConfig.js');
const timeline = await import('./timeline.js');
const pco = await import('./integrations/planningCenter.js');

// Planning Center service types (the mock supplies plans), no ProPresenter.
const ROOM = 'north-chapel';
const ST = { id: '500006', name: 'Chapel Service' };

async function waitFor(predicate, what, timeoutMs = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
}
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

after(() => {
  if (sm.getState(ROOM).active) sm.endShow(ROOM);
  showCfg.clearConfig(ROOM, plan.id); // the watcher goes idle (unref'd sleeps only)
});

const plan = (await pco.getUpcomingPlans(ST, 3))[0];

test('each service time starts once on the clock, with no ProPresenter in the room', async () => {
  showCfg.setConfig(ROOM, plan.id, { startAtScheduledTime: true });
  sm.initAutomation();

  await waitFor(() => sm.getState(ROOM).active, 'the clock to start the first service');
  const first = sm.getState(ROOM).timeId;
  assert.ok(['svc-1', 'svc-2'].includes(first), `timeId "${first}" should be a service time`);
  assert.equal(sm.getState(ROOM).ppConnected, false, 'started without ProPresenter');

  // Ending a service does not bring it back; the next one starts instead.
  sm.endShow(ROOM);
  await waitFor(() => sm.getState(ROOM).active, 'the other service time');
  const second = sm.getState(ROOM).timeId;
  assert.notEqual(second, first, 'an ended service must not start again');
  sm.endShow(ROOM);

  // Deleted as false starts, both lose completedAt — and still neither restarts.
  timeline.remove(`${plan.id}__${first}`);
  timeline.remove(`${plan.id}__${second}`);
  await settle(600);
  assert.equal(sm.getState(ROOM).active, false, 'the clock starts a service once');
});
