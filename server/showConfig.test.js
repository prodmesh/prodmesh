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
  // A service TIME has no ProPresenter item to become; it starts on the clock.
  const clock = cfg.promoteLegacyServicesLive({
    servicesLiveFromProPresenter: true, servicesLiveStartMode: 'service-time', servicesLiveStartTimeId: 't1',
  });
  assert.equal(clock.startAtScheduledTime, true);
  assert.equal(clock.startItemId, undefined);
  assert.equal('servicesLiveStartTimeId' in clock, false);
  // An autostart item that already exists wins over the old trigger.
  assert.equal(cfg.promoteLegacyServicesLive({
    ...base, servicesLiveFromProPresenter: true, startItemId: 'welcome',
  }).startItemId, 'welcome');
});

test('an event starts on the clock or at an item, never both', () => {
  const saved = cfg.setConfig('r-clock', 'p-clock', { startAtScheduledTime: true, startItemId: 'worship' });
  assert.equal(saved.startAtScheduledTime, true);
  assert.equal(saved.startItemId, null, 'an item left over from before the switch is dropped');
  assert.equal(cfg.setConfig('r-clock', 'p-clock', { startItemId: 'worship' }).startAtScheduledTime, false);
});

test('a mapping can explicitly exclude an item from automatic matching', () => {
  const saved = cfg.setConfig('r-none', 'p-none', {
    map: { 'pc-no-presentation': { disabled: true } },
  });
  assert.deepEqual(saved.map, { 'pc-no-presentation': { disabled: true } });
});

// ── Service type defaults (#58) ──────────────────────────────────────────────

const items = [
  { id: 'h1', title: 'Countdown', type: 'header' }, // a header never matches
  { id: 'i1', title: '  countdown ', type: 'item' },
  { id: 'i2', title: 'Dismissal', type: 'item' },
];

test('an event with nothing of its own inherits its service type default, by title', () => {
  assert.equal(cfg.effectiveConfig('rd', 'p-none', 'st1', items), null, 'nothing anywhere is nothing');
  cfg.setTypeDefault('rd', 'st1', { startItemTitle: 'Countdown', endItemTitle: 'Dismissal', servicesLiveFromProPresenter: true });
  const eff = cfg.effectiveConfig('rd', 'p-none', 'st1', items);
  assert.equal(eff.startItemId, 'i1', 'matched ignoring case and space, skipping the header');
  assert.equal(eff.endItemId, 'i2');
  assert.equal(eff.servicesLiveFromProPresenter, true);
  assert.equal(cfg.mayAutostart('rd', 'p-none', 'st1'), true);
  // Another service type, or another room, is unaffected.
  assert.equal(cfg.effectiveConfig('rd', 'p-none', 'st2', items), null);
  assert.equal(cfg.effectiveConfig('other-room', 'p-none', 'st1', items), null);
});

test('an event overrides its default field by field, and Never beats a default', () => {
  cfg.setTypeDefault('ro', 'st1', { startItemTitle: 'Countdown', endItemTitle: 'Dismissal', servicesLiveFromProPresenter: true });
  // Only the end is this event's own; the start and Services LIVE still inherit.
  cfg.setConfig('ro', 'p1', { endItemId: 'i1' });
  let eff = cfg.effectiveConfig('ro', 'p1', 'st1', items);
  assert.deepEqual([eff.startItemId, eff.endItemId, eff.servicesLiveFromProPresenter], ['i1', 'i1', true]);

  // An explicit Never and an explicit off are kept, and win.
  cfg.setConfig('ro', 'p1', { startItemId: null, startAtScheduledTime: false, servicesLiveFromProPresenter: false });
  eff = cfg.effectiveConfig('ro', 'p1', 'st1', items);
  assert.deepEqual([eff.startItemId, eff.startAtScheduledTime, eff.endItemId, eff.servicesLiveFromProPresenter], [null, false, 'i2', false]);
  assert.equal(cfg.mayAutostart('ro', 'p1', 'st1'), false);

  // A mapping saved on its own does not detach the event from its default.
  cfg.setConfig('ro', 'p2', { map: { i1: { ppIndex: 0, ppName: 'Walk-in' } } });
  assert.equal(cfg.effectiveConfig('ro', 'p2', 'st1', items).startItemId, 'i1');
});

test('a default can start on the clock, and a title the plan lacks starts nothing', () => {
  cfg.setTypeDefault('rc', 'st1', { startAtScheduledTime: true, startItemTitle: 'Countdown' });
  assert.equal(cfg.getTypeDefault('rc', 'st1').startItemTitle, null, 'one way to start, as per event');
  assert.equal(cfg.effectiveConfig('rc', 'p', 'st1', items).startAtScheduledTime, true);

  cfg.setTypeDefault('rc', 'st1', { startItemTitle: 'Renamed Item' });
  const eff = cfg.effectiveConfig('rc', 'p', 'st1', items);
  assert.equal(eff.startItemId, null, 'never falls back to some other item');
  assert.equal(cfg.mayAutostart('rc', 'p', 'st1'), true, 'the cheap check cannot know yet');

  cfg.clearTypeDefault('rc', 'st1');
  assert.equal(cfg.getTypeDefault('rc', 'st1'), null);
  assert.throws(() => cfg.setTypeDefault('rc', 'st1', { startItemTitle: 7 }), /item title/);
});

test('records saved before defaults existed read null as "nothing set", so they inherit', () => {
  // The v1 shape: every field stored, null/false where nothing was chosen.
  getDb().prepare('INSERT INTO show_config (room_id, plan_id, config, updated_at) VALUES (?, ?, ?, ?)').run(
    'rl', 'p-old', JSON.stringify({ startItemId: null, startAtScheduledTime: false, endItemId: 'own-end', map: {}, videos: { t1: null }, servicesLiveFromProPresenter: false }), 1,
  );
  cfg.setTypeDefault('rl', 'st1', { startItemTitle: 'Countdown', endItemTitle: 'Dismissal', servicesLiveFromProPresenter: true });
  const eff = cfg.effectiveConfig('rl', 'p-old', 'st1', items);
  assert.equal(eff.startItemId, 'i1');
  assert.equal(eff.endItemId, 'own-end', 'what it did choose still wins');
  assert.equal(eff.servicesLiveFromProPresenter, true);
  assert.deepEqual(eff.videos, { t1: null }, 'videos stay per event');
});
