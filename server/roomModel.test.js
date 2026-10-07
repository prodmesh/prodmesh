import test from 'node:test';
import assert from 'node:assert/strict';
import { publicRoom, rawToModeId } from './roomModel.js';

const room = {
  id: 'r1',
  name: 'Room One',
  companion: { host: '10.0.0.5', port: 8000 },
  analysis: { source: 'open-sound-meter' },
  state: { variable: 'roomState' },
  modes: [
    { id: 'sunday', label: 'Sunday', color: '#0f0', match: 'SUNDAY', press: { page: 1, row: 0, column: 1 } },
    { id: 'event', label: 'Event', color: '#00f', match: 'EVENT', press: { page: 1, row: 0, column: 2 } },
    { id: 'standby', label: 'Standby', color: '#888', match: 'STANDBY', press: { page: 1, row: 0, column: 3 }, isStandby: true },
  ],
};

test('rawToModeId matches case-insensitively', () => {
  assert.equal(rawToModeId(room, 'SUNDAY'), 'sunday');
  assert.equal(rawToModeId(room, 'sunday'), 'sunday');
  assert.equal(rawToModeId(room, '  Event '), 'event');
});

test('rawToModeId returns null for unknown/empty values', () => {
  assert.equal(rawToModeId(room, 'OFF'), null);
  assert.equal(rawToModeId(room, ''), null);
  assert.equal(rawToModeId(room, null), null);
});

test('publicRoom hides button locations and match values', () => {
  const pub = publicRoom(room);
  assert.equal(pub.id, 'r1');
  assert.equal(pub.hasCompanion, true);
  assert.equal(pub.analysisSource, 'open-sound-meter');
  assert.equal(pub.modes.length, 3);
  assert.deepEqual(Object.keys(pub.modes[0]).sort(), ['color', 'id', 'isStandby', 'label']);
  assert.equal(pub.modes[2].isStandby, true);
});

test('publicRoom reports a room without a Companion as not-live', () => {
  assert.equal(publicRoom({ ...room, companion: {} }).hasCompanion, false);
  assert.equal(publicRoom({ ...room, roomMode: true, companion: {} }).roomModeEnabled, false);
});
