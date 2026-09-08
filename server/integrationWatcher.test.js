// The org-level integration topics, in their own process: importing the watcher
// registers `integration:*` on the real hub, and settings needs its own data
// dir. The point of these tests is the two things the room topics never had to
// answer — a topic with no room id in it, and a producer that must not call a
// service the administrator switched off.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PRODMESH_DATA_DIR = mkdtempSync(join(tmpdir(), 'prodmesh-integrationwatcher-'));

const hub = await import('./streamHub.js');
const settings = await import('./settings.js');
await import('./integrationWatcher.js');

const fakeRes = () => ({ write: () => true, on: () => {}, writableEnded: false, end: () => {} });

test('integration topics are valid without a room id, and only for known producers', () => {
  // Every other topic in the app is room:*:<name>. These are the first that
  // carry no room, which is the whole reason this file exists.
  assert.equal(hub.isValidTopic('integration:resi'), true);
  assert.equal(hub.isValidTopic('integration:restream'), true);
  assert.equal(hub.isValidTopic('integration:obs'), false);
  assert.equal(hub.isValidTopic('integration:nope'), false);
  // Subscribing starts work, so an unknown id must not be able to start any.
  assert.equal(hub.isValidTopic('integration:resi:extra'), false);
});

test('a disabled integration is not polled, and says so on the topic', async () => {
  settings.setIntegrationEnabled('resi', false);
  const res = fakeRes();
  const seen = [];
  // Subscribe with our own sink so we read exactly what a browser would get.
  hub.subscribe(res, ['integration:resi'], (topic, data) => seen.push([topic, data]));
  try {
    // The producer publishes its disabled snapshot on the first tick. Without
    // this the Admin toggle was advisory: it hid the widget while the box went
    // on calling Resi every three seconds.
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(seen.at(-1), ['integration:resi', { connected: false, disabled: true }]);
  } finally {
    hub.unsubscribe(res);
    settings.setIntegrationEnabled('resi', true);
  }
});

test('the producer refcounts like every other topic', () => {
  const a = fakeRes(); const b = fakeRes();
  hub.subscribe(a, ['integration:restream']);
  hub.subscribe(b, ['integration:restream']);
  assert.equal(hub.subscriberCount('integration:restream'), 2);
  hub.unsubscribe(a);
  assert.equal(hub.subscriberCount('integration:restream'), 1);
  hub.unsubscribe(b);
  assert.equal(hub.subscriberCount('integration:restream'), 0);
});
