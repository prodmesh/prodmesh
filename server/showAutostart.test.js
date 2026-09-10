import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Temp data dir → no secrets → Planning Center runs in mock mode (plans on
// next Sunday, services at 9:00 and 11:00), and configs land in a scratch db.
process.env.PRODMESH_DATA_DIR = mkdtempSync(join(tmpdir(), 'prodmesh-autostart-'));
const { nextArmedEvent } = await import('./showManager.js');
const showCfg = await import('./showConfig.js');

const room = {
  id: 'autostart-test-room',
  planningCenter: { serviceTypes: [{ id: 'st1', name: 'Sunday' }] },
};

// Mirrors the PC mock's nextSunday so the test tracks it as dates roll over.
function sundayAt(h, m = 0) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + ((7 - d.getDay()) % 7));
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

test('not armed without a config (or without a start item)', async () => {
  assert.equal(await nextArmedEvent(room, sundayAt(8, 30)), null);
  showCfg.setConfig(room.id, 'mock-st1-0', { endItemId: 'x' }); // end-only config
  assert.equal(await nextArmedEvent(room, sundayAt(8, 30)), null);
  showCfg.clearConfig(room.id, 'mock-st1-0');
});

test('armed inside the window (2h before 9:00 → 1h after 11:00), idle outside', async () => {
  showCfg.setConfig(room.id, 'mock-st1-0', { startItemId: 'start-item' });

  const armed = await nextArmedEvent(room, sundayAt(8, 30));
  assert.ok(armed, 'expected to be armed Sunday 8:30');
  assert.equal(armed.plan.id, 'mock-st1-0');
  assert.equal(armed.config.startItemId, 'start-item');
  assert.ok(armed.times.some((t) => t.type === 'service'));
  assert.ok(armed.items.length > 0);

  assert.ok(await nextArmedEvent(room, sundayAt(7, 0)), 'window opens 7:00');
  assert.ok(await nextArmedEvent(room, sundayAt(11, 55)), 'still armed near noon');
  assert.equal(await nextArmedEvent(room, sundayAt(4, 0)), null, 'too early');
  assert.equal(await nextArmedEvent(room, sundayAt(14, 0)), null, 'window closed');

  showCfg.clearConfig(room.id, 'mock-st1-0');
});

test('an event set to its scheduled time arms without a start item', async () => {
  // This room has no ProPresenter either, and a clock start needs none.
  showCfg.setConfig(room.id, 'mock-st1-0', { startAtScheduledTime: true });
  const armed = await nextArmedEvent(room, sundayAt(8, 30));
  assert.equal(armed?.config.startAtScheduledTime, true);
  assert.equal(await nextArmedEvent(room, sundayAt(14, 0)), null, 'same window as an item start');
  showCfg.clearConfig(room.id, 'mock-st1-0');
});
