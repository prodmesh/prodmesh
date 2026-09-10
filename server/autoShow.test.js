import test from 'node:test';
import assert from 'node:assert/strict';
import { armWindow, dueScheduledTime, pickAutostartTime, shouldAutostart, shouldAutoComplete, armsAutoComplete } from './autoShow.js';
import { mapActiveToItemId } from './integrations/proPresenter.js';

const T9 = '2026-07-12T16:00:00Z'; // 9:00 local
const T11 = '2026-07-12T18:00:00Z'; // 11:00 local
const times = [
  { id: 'reh', type: 'rehearsal', startsAt: '2026-07-12T14:00:00Z' },
  { id: 't9', type: 'service', startsAt: T9 },
  { id: 't11', type: 'service', startsAt: T11 },
];

test('armWindow spans 2h before first service to 1h after last (rehearsals excluded)', () => {
  const w = armWindow(times);
  assert.equal(w.from, new Date(T9).getTime() - 2 * 3600_000);
  assert.equal(w.to, new Date(T11).getTime() + 3600_000);
  assert.equal(armWindow([{ id: 'x', type: 'rehearsal', startsAt: T9 }]), null);
});

test('pickAutostartTime picks nearest service time, skipping completed ones', () => {
  const at = (iso, deltaMin) => new Date(iso).getTime() + deltaMin * 60_000;
  const none = () => false;
  assert.equal(pickAutostartTime(times, at(T9, -2), none), 't9'); // 8:58 → 9:00
  assert.equal(pickAutostartTime(times, at(T11, -2), none), 't11'); // 10:58 → 11:00
  // 9:55 is nearer to 9:00 than 11:00, but 9:00 already completed → 11:00.
  assert.equal(pickAutostartTime(times, at(T9, 55), (id) => id === 't9'), 't11');
  // Everything completed → never start.
  assert.equal(pickAutostartTime(times, at(T11, 30), () => true), null);
});

test('dueScheduledTime starts a service at its time, and not long after', () => {
  const at = (iso, deltaMin) => new Date(iso).getTime() + deltaMin * 60_000;
  const none = () => false;
  assert.equal(dueScheduledTime(times, at(T9, -1), none), null); // 8:59 — not yet
  assert.equal(dueScheduledTime(times, at(T9, 0), none), 't9');
  assert.equal(dueScheduledTime(times, at(T9, 10), none), 't9'); // ProdMesh came back at 9:10
  assert.equal(dueScheduledTime(times, at(T9, 30), none), null); // too far in to time it truthfully
  assert.equal(dueScheduledTime(times, at(T9, 5), (id) => id === 't9'), null); // already ended
  assert.equal(dueScheduledTime(times, at(T11, 0), none), 't11');
  // The 7:00 rehearsal is not a service.
  assert.equal(dueScheduledTime(times, at('2026-07-12T14:00:00Z', 1), none), null);
  // Two due at once (a grace long enough to overlap): the later one.
  assert.equal(dueScheduledTime(times, at(T11, 5), none, 3 * 3600_000), 't11');
});

test('shouldAutostart is edge-triggered', () => {
  const cfg = { startItemId: 'worship' };
  assert.equal(shouldAutostart(cfg, 'preservice', 'worship'), true);
  assert.equal(shouldAutostart(cfg, 'worship', 'worship'), false); // no transition
  assert.equal(shouldAutostart(cfg, null, 'worship'), false); // no baseline yet
  assert.equal(shouldAutostart(cfg, 'preservice', 'announcements'), false);
  assert.equal(shouldAutostart(null, 'preservice', 'worship'), false); // unconfigured
});

test('shouldAutoComplete fires only on the end item’s last slide, once armed', () => {
  const cfg = { endItemId: 'closing' };
  const cur = (itemId, slideIndex, slideCount) => ({ itemId, slideIndex, slideCount });
  assert.equal(shouldAutoComplete(cfg, cur('closing', 3, 4), true), true);
  assert.equal(shouldAutoComplete(cfg, cur('closing', 2, 4), true), false);
  assert.equal(shouldAutoComplete(cfg, cur('worship', 3, 4), true), false);
  assert.equal(shouldAutoComplete(cfg, cur('closing', null, 4), true), false); // no slide data
  assert.equal(shouldAutoComplete(cfg, cur('closing', 0, null), true), false);
  assert.equal(shouldAutoComplete({ endItemId: null }, cur('closing', 3, 4), true), false);

  // Unarmed, the last slide is treated as PP's stale-position flash — a
  // re-triggered item briefly reports where it was left last service.
  assert.equal(shouldAutoComplete(cfg, cur('closing', 3, 4), false), false);
  // …except a single-slide end item, which can only ever complete on entry.
  assert.equal(shouldAutoComplete(cfg, cur('closing', 0, 1), false), true);
});

test('armsAutoComplete arms on any non-last slide of the end item', () => {
  const cfg = { endItemId: 'closing' };
  const cur = (itemId, slideIndex, slideCount) => ({ itemId, slideIndex, slideCount });
  assert.equal(armsAutoComplete(cfg, cur('closing', 0, 4)), true);
  assert.equal(armsAutoComplete(cfg, cur('closing', 2, 4)), true);
  assert.equal(armsAutoComplete(cfg, cur('closing', 3, 4)), false); // last slide never arms
  assert.equal(armsAutoComplete(cfg, cur('worship', 0, 4)), false); // wrong item
  assert.equal(armsAutoComplete(cfg, cur('closing', null, 4)), false); // no slide data
  assert.equal(armsAutoComplete(cfg, cur('closing', 0, null)), false);
  assert.equal(armsAutoComplete(cfg, cur('closing', 0, 1)), false); // single slide: nothing to arm on
});

test('mapActiveToItemId honors manual overrides over index mapping', () => {
  const items = [
    { id: 'a', title: 'Pre Service' },
    { id: 'b', title: 'Worship' },
    { id: 'c', title: 'Message' },
  ];
  // No overrides → plain index mapping.
  assert.equal(mapActiveToItemId(items, { index: 1, name: 'Worship' }), 'b');
  // Override redirects PP item 2 to PC item 'b'.
  const map = { b: { ppIndex: 2, ppName: 'Sermon Intro' } };
  assert.equal(mapActiveToItemId(items, { index: 2, name: 'Sermon Intro' }, map), 'b');
  // Name rescue when the playlist was re-pushed and indices shifted.
  assert.equal(mapActiveToItemId(items, { index: 5, name: 'Sermon Intro' }, map), 'b');
  // The overridden PC item is no longer reachable via auto-map from PP idx 1.
  assert.equal(mapActiveToItemId(items, { index: 1, name: 'Worship' }, map), null);
  // Unrelated items still auto-map.
  assert.equal(mapActiveToItemId(items, { index: 0, name: 'Pre Service' }, map), 'a');
});

test('mapActiveToItemId does not auto-match a Planning Center item excluded by None', () => {
  const items = [{ id: 'a', title: 'Pre Service' }, { id: 'b', title: 'No PP presentation' }];
  assert.equal(
    mapActiveToItemId(items, { index: 1, name: 'No PP presentation' }, { b: { disabled: true } }),
    null,
  );
});

test('pickPlaylistForPlan matches by plan date, title as tiebreak', async () => {
  const { pickPlaylistForPlan } = await import('./integrations/proPresenter.js');
  const playlists = [
    { uuid: 'a', name: 'RECORDING NOW' },
    { uuid: 'b', name: 'Colossians - Riley - Commissioning - July 5, 2026' },
    { uuid: 'c', name: 'Summer in the Psalms - Michael - acoustic - Psalm 1 - July 12, 2026' },
  ];
  const plan = { title: 'Michael - acoustic - Psalm 1', dates: 'July 12, 2026' };
  assert.equal(pickPlaylistForPlan(playlists, plan).uuid, 'c');
  // No date/title match anywhere → null (the caller falls back to active).
  assert.equal(pickPlaylistForPlan(playlists, { title: 'Xmas Eve', dates: 'December 24, 2026' }), null);
});
