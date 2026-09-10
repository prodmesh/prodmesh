import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PRODMESH_DATA_DIR = mkdtempSync(join(tmpdir(), 'prodmesh-showcfg-'));
const cfg = await import('./showConfig.js');
const { getDb } = await import('./db.js');

test('config round-trips per (room, plan)', () => {
  assert.equal(cfg.getConfig('r1', 'p1'), null);
  cfg.setConfig('r1', 'p1', {
    startItemId: 'worship',
    endItemId: 'closing',
    map: { worship: { ppIndex: 4, ppName: 'Call To Worship' }, skipped: null },
  });
  const got = cfg.getConfig('r1', 'p1');
  assert.equal(got.startItemId, 'worship');
  assert.equal(got.endItemId, 'closing');
  assert.deepEqual(got.map, { worship: { ppIndex: 4, ppName: 'Call To Worship' } });
  assert.equal(cfg.getConfig('r1', 'p2'), null); // other events untouched

  cfg.setConfig('r1', 'p1', { startItemId: null, endItemId: 'closing' }); // update
  assert.equal(cfg.getConfig('r1', 'p1').startItemId, null);

  cfg.clearConfig('r1', 'p1');
  assert.equal(cfg.getConfig('r1', 'p1'), null);
});

test('validation rejects bad shapes', () => {
  assert.throws(() => cfg.setConfig('r', 'p', 'nope'), /object/);
  assert.throws(() => cfg.setConfig('r', 'p', { startItemId: 5 }), /item id/);
  assert.throws(() => cfg.setConfig('r', 'p', { map: { a: { ppIndex: 'x' } } }), /ppIndex/);
  assert.throws(() => cfg.setConfig('r', 'p', { map: { a: { ppIndex: -1 } } }), /ppIndex/);
});

test('Services LIVE follows the show, so it carries no start condition of its own', () => {
  // An older client can still post the retired fields; they are not stored.
  const saved = cfg.setConfig('r-live', 'p-live', {
    startItemId: 'worship',
    servicesLiveFromProPresenter: true,
    servicesLiveStartMode: 'service-time',
    servicesLiveStartTimeId: 'time-9am',
  });
  assert.equal(saved.servicesLiveFromProPresenter, true);
  assert.equal(saved.startItemId, 'worship');
  for (const gone of ['servicesLiveStartMode', 'servicesLiveStartItemId', 'servicesLiveStartTimeId']) {
    assert.equal(gone in saved, false, `${gone} is no longer part of the config`);
  }
});

test('a Services LIVE trigger saved before the change becomes the autostart item', () => {
  // The regression this fixes: autostart could only be set through the
  // Services LIVE trigger, which wrote a field autostart never read. An event
  // configured that way has to keep starting at the same item.
  const legacy = {
    startItemId: null, endItemId: 'closing', map: {}, videos: {},
    servicesLiveFromProPresenter: true, servicesLiveStartMode: 'item', servicesLiveStartItemId: 'worship',
  };
  // On READ: rows written before this change are never re-validated until
  // somebody re-saves them, and autostart reads them every minute.
  getDb().prepare('INSERT INTO show_config (room_id, plan_id, config, updated_at) VALUES (?, ?, ?, ?)')
    .run('r-old', 'p-old', JSON.stringify(legacy), Date.now());
  const read = cfg.getConfig('r-old', 'p-old');
  assert.equal(read.startItemId, 'worship');
  assert.equal(read.endItemId, 'closing', 'the rest of the config is untouched');
  assert.equal('servicesLiveStartItemId' in read, false);
  // And on save, for a client that still posts the old shape.
  assert.equal(cfg.setConfig('r-old2', 'p-old2', legacy).startItemId, 'worship');
});

test('a legacy trigger is promoted only when it could have started anything', () => {
  const base = { servicesLiveStartMode: 'item', servicesLiveStartItemId: 'worship' };
  // The box was unticked: a leftover trigger is not a request to autostart.
  assert.equal(cfg.promoteLegacyServicesLive({ ...base, servicesLiveFromProPresenter: false }).startItemId, undefined);
  // A service TIME has no ProPresenter item to become.
  assert.equal(cfg.promoteLegacyServicesLive({
    servicesLiveFromProPresenter: true, servicesLiveStartMode: 'service-time', servicesLiveStartTimeId: 't1',
  }).startItemId, undefined);
  // An autostart item that already exists wins over the old trigger.
  assert.equal(cfg.promoteLegacyServicesLive({
    ...base, servicesLiveFromProPresenter: true, startItemId: 'welcome',
  }).startItemId, 'welcome');
});

test('a mapping can explicitly exclude an item from automatic matching', () => {
  const saved = cfg.setConfig('r-none', 'p-none', {
    map: { 'pc-no-presentation': { disabled: true } },
  });
  assert.deepEqual(saved.map, { 'pc-no-presentation': { disabled: true } });
});
