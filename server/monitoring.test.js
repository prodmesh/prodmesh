// The server watches a room's devices itself before a service and during a
// show (alerts-ux.md decision 1), and lets go afterwards unless a screen is
// still watching.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PRODMESH_DATA_DIR = mkdtempSync(join(tmpdir(), 'prodmesh-monitoring-'));
const { reconcileWatching } = await import('./monitoring.js');
const roomHealth = await import('./roomHealth.js');
const hub = await import('./streamHub.js');

after(() => roomHealth.stopAll());

test('a live show, then a service window, then neither', async () => {
  await reconcileWatching({ isRoomLive: (id) => id === 'north-main', inWindow: async (id) => id === 'north-youth' });
  assert.equal(roomHealth.heldFor('north-main'), 'show');
  assert.equal(roomHealth.heldFor('north-youth'), 'service');
  assert.equal(roomHealth.heldFor('north-chapel'), null);
  assert.equal(roomHealth.isWatched('north-main'), true, 'held means probed, with no screen open');

  await reconcileWatching({ isRoomLive: () => false, inWindow: async () => false });
  assert.equal(roomHealth.heldFor('north-main'), null);
  assert.equal(roomHealth.isWatched('north-main'), false, 'nothing watching, nothing probed');
});

test('letting go does not stop a probe a screen still wants', async () => {
  const res = { write: () => true, once: () => {}, on: () => {} };
  hub.subscribe(res, [roomHealth.healthTopic('north-main')], () => {});
  await reconcileWatching({ isRoomLive: (id) => id === 'north-main', inWindow: async () => false });
  await reconcileWatching({ isRoomLive: () => false, inWindow: async () => false });
  assert.equal(roomHealth.isWatched('north-main'), true);
  hub.unsubscribe(res);
  assert.equal(roomHealth.isWatched('north-main'), false);
});

test('a Planning Center failure for one room does not stop the others being decided', async () => {
  await reconcileWatching({
    isRoomLive: () => false,
    inWindow: async (id) => { if (id === 'north-main') throw new Error('boom'); return id === 'north-youth'; },
  });
  assert.equal(roomHealth.heldFor('north-youth'), 'service');
  await reconcileWatching({ isRoomLive: () => false, inWindow: async () => false });
});
