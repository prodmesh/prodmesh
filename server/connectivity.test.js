import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PRODMESH_DATA_DIR ??= mkdtempSync(join(tmpdir(), 'prodmesh-conn-'));
process.env.PRODMESH_LOCAL_TEST = '1'; // include the dev room in the map
const { rooms } = await import('./roomsStore.js');
const conn = await import('./connectivity.js');

test('first boot seeds service types from rooms.config.js', () => {
  const stored = conn.getPlanningCenter('north-main');
  assert.ok(stored.serviceTypes.length >= 4);
  assert.ok(stored.serviceTypes.some((st) => st.name === 'Sunday'));
  assert.deepEqual(conn.getPlanningCenter('north-youth').serviceTypes, [{ id: '500005', name: 'Youth Service' }]);
});

test('setPlanningCenter validates, persists, and applies to the live rooms map', () => {
  const next = [
    { id: '500005', name: 'Youth Service' },
    { id: '999001', name: 'Youth Winter Camp' },
  ];
  conn.setPlanningCenter('north-youth', next);
  // Persisted…
  assert.deepEqual(conn.getPlanningCenter('north-youth').serviceTypes, next);
  // …and live on the shared room object every consumer holds.
  assert.deepEqual(rooms['north-youth'].planningCenter.serviceTypes, next);
});

test('first boot seeds the analysis source from rooms.config.js', () => {
  const stored = conn.getAnalysis('north-main');
  assert.equal(stored.source, 'smaart');
  assert.equal(stored.host, '192.0.2.40');
  assert.equal(stored.target, 90);
  // The dev room's mock fixture seeds too (and rooms without one stay bare).
  assert.equal(conn.getAnalysis('local-test').mock, true);
  assert.equal(conn.getAnalysis('north-youth'), null);
});

test('setAnalysis validates, persists, and applies to the live rooms map', () => {
  const clean = conn.setAnalysis('north-youth', {
    source: 'rta', host: '192.0.2.17', port: '8517',
  });
  assert.deepEqual(clean, { source: 'rta', host: '192.0.2.17', port: 8517 });
  assert.deepEqual(rooms['north-youth'].analysis, clean);
  // Clearing removes it from the database AND the live room object…
  conn.setAnalysis('north-youth', null);
  assert.equal(conn.getAnalysis('north-youth'), null);
  assert.equal(rooms['north-youth'].analysis, undefined);
});

test('Open Sound Meter uses its multicast Remote API without a host', () => {
  const clean = conn.validateAnalysis({ source: 'open-sound-meter' });
  assert.deepEqual(clean, { source: 'open-sound-meter' });
});

test('a room keeps its own dB goals, whatever a widget overrides', () => {
  // showManager stamps target/limit onto every published SPL sample and the
  // service report is written whether or not a dashboard was on screen, so
  // these cannot live only on a widget. They went missing once: the validator
  // stopped emitting them while three readers still expected them, and every
  // save silently blanked the room's thresholds.
  const cfg = conn.validateAnalysis({ source: 'smaart', host: '192.0.2.40', target: 90, limit: 95, metric: 'LAeq' });
  assert.equal(cfg.target, 90);
  assert.equal(cfg.limit, 95);
  assert.equal(cfg.metric, 'LAeq');
  // Open Sound Meter has no host but still has goals.
  assert.equal(conn.validateAnalysis({ source: 'open-sound-meter', target: 88 }).target, 88);
});

test('dB goals are range-checked and must not invert', () => {
  assert.throws(() => conn.validateAnalysis({ source: 'smaart', host: 'x', target: 20 }), /40–130 dB/);
  assert.throws(() => conn.validateAnalysis({ source: 'smaart', host: 'x', limit: 200 }), /40–130 dB/);
  assert.throws(() => conn.validateAnalysis({ source: 'smaart', host: 'x', target: 95, limit: 90 }),
    /limit must be at or above target/);
  assert.throws(() => conn.validateAnalysis({ source: 'smaart', host: 'x', metric: 'm'.repeat(61) }),
    /at most 60 characters/);
});

test('a cleared analysis source stays cleared across applyConnectivity', () => {
  // north-main declares an analysis block in rooms.config.js; once cleared,
  // the seeded marker keeps the file entry from resurrecting it.
  conn.setAnalysis('north-main', null);
  conn.applyConnectivity();
  assert.equal(rooms['north-main'].analysis, undefined);
  // Restore for any later tests.
  conn.setAnalysis('north-main', { source: 'smaart', host: '192.0.2.40', port: 26000, target: 90, limit: 95 });
});

test('setAnalysis rejects bad input without changing anything', () => {
  const before = conn.getAnalysis('north-main');
  assert.throws(() => conn.setAnalysis('north-main', { source: 'loudness-o-matic', host: 'x' }), /Unknown analysis source/);
  assert.throws(() => conn.setAnalysis('north-main', { source: 'rta' }), /needs a host/);
  assert.throws(() => conn.setAnalysis('north-main', { source: 'rta', host: 'x', port: 99999 }), /Port must be/);
  assert.throws(() => conn.setAnalysis('nope', null), /Unknown room/);
  assert.deepEqual(conn.getAnalysis('north-main'), before);
});

test('the password survives storage but only for Smaart sources', () => {
  const smaart = conn.validateAnalysis({ source: 'smaart', host: 'x', password: 'hunter2' });
  assert.equal(smaart.password, 'hunter2');
  const rta = conn.validateAnalysis({ source: 'rta', host: 'x', password: 'hunter2' });
  assert.equal(rta.password, undefined);
});

test('logControl is Smaart-only and stored as a clean boolean', () => {
  const smaart = conn.validateAnalysis({ source: 'smaart', host: 'x', logControl: 1 });
  assert.equal(smaart.logControl, true);
  const off = conn.validateAnalysis({ source: 'smaart', host: 'x', logControl: false });
  assert.equal(off.logControl, undefined);
  const rta = conn.validateAnalysis({ source: 'rta', host: 'x', logControl: true });
  assert.equal(rta.logControl, undefined);
});

test('first boot seeds ProPresenter from rooms.config.js', () => {
  assert.deepEqual(conn.getProPresenter('north-main'), { host: '192.0.2.15', port: 1025 });
  assert.deepEqual(conn.getProPresenter('local-test'), { host: '127.0.0.1', port: 62202 });
  assert.equal(conn.getProPresenter('north-youth'), null);
});

test('setProPresenter validates, persists, and applies to the live rooms map', () => {
  const clean = conn.setProPresenter('north-youth', { host: '192.0.2.50', port: '62202', timer: ' Service Start ' });
  assert.deepEqual(clean, { host: '192.0.2.50', port: 62202, timer: 'Service Start' });
  assert.deepEqual(rooms['north-youth'].proPresenter, clean);
  // Clearing removes it from the database AND the live room object.
  conn.setProPresenter('north-youth', null);
  assert.equal(conn.getProPresenter('north-youth'), null);
  assert.equal(rooms['north-youth'].proPresenter, undefined);
});

test('a cleared ProPresenter stays cleared across applyConnectivity', () => {
  const before = conn.getProPresenter('north-main');
  conn.setProPresenter('north-main', null);
  conn.applyConnectivity();
  assert.equal(rooms['north-main'].proPresenter, undefined);
  conn.setProPresenter('north-main', before);
});

test('setProPresenter rejects bad input without changing anything', () => {
  const before = conn.getProPresenter('north-main');
  assert.throws(() => conn.setProPresenter('north-main', {}), /needs a host/);
  assert.throws(() => conn.setProPresenter('north-main', { host: 'x', port: 0 }), /Port must be/);
  assert.throws(() => conn.setProPresenter('north-main', { host: 'x', timer: 'y'.repeat(61) }), /at most 60/);
  assert.throws(() => conn.setProPresenter('nope', null), /Unknown room/);
  assert.deepEqual(conn.getProPresenter('north-main'), before);
});

test('first boot seeds Companion + modes from rooms.config.js', () => {
  const main = conn.getCompanion('north-main');
  assert.equal(main.mock, false);
  assert.equal(main.host, '192.0.2.10');
  assert.equal(main.port, 8000);
  assert.equal(main.variable, 'roomState');
  assert.equal(main.modes.length, 6);
  assert.deepEqual(main.modes[0], {
    id: 'sunday', label: 'Sunday', color: '#34c759', match: 'SUNDAY', press: { page: 3, row: 0, column: 1 },
  });
  assert.equal(main.modes[5].isStandby, true);
  // Mock rooms seed too — their simulated state machine needs modes.
  assert.equal(conn.getCompanion('north-youth').mock, true);
  assert.equal(conn.getCompanion('north-youth').modes.length, 4);
});

test('setCompanion persists and decomposes onto the four legacy room keys', () => {
  const clean = conn.setCompanion('north-youth', {
    mock: false,
    host: '192.0.2.22',
    port: '8000',
    variable: 'youthState',
    modes: [
      { id: 'service', label: 'Service', color: '#34C759', match: 'SERVICE', press: { page: '2', row: '1', column: '0' } },
      { id: 'standby', label: 'Standby', color: '#8b97a8', match: 'STANDBY', isStandby: true },
    ],
  });
  assert.equal(clean.port, 8000);
  assert.deepEqual(clean.modes[0].press, { page: 2, row: 1, column: 0 });
  assert.equal(clean.modes[1].press, undefined); // buttonless mode is allowed
  // Decomposed onto the live room object every consumer reads.
  const room = rooms['north-youth'];
  assert.equal(room.mock, false);
  assert.deepEqual(room.companion, { host: '192.0.2.22', port: 8000 });
  assert.equal(room.state.variable, 'youthState');
  assert.equal(room.modes.length, 2);
  // Back to simulated: host becomes optional.
  conn.setCompanion('north-youth', { mock: true, modes: clean.modes });
  assert.equal(rooms['north-youth'].mock, true);
  assert.deepEqual(rooms['north-youth'].companion, {});
});

test('setCompanion rejects bad input without changing anything', () => {
  const before = conn.getCompanion('north-youth');
  const modes = before.modes;
  assert.throws(() => conn.setCompanion('north-youth', null), /must be an object/);
  assert.throws(() => conn.setCompanion('north-youth', { mock: false, variable: 'v', modes }), /needs a Companion host/);
  assert.throws(() => conn.setCompanion('north-youth', { mock: false, host: 'x', modes }), /needs a state variable/);
  assert.throws(
    () => conn.setCompanion('north-youth', { mock: true, modes: [modes[0], modes[0]] }),
    /Duplicate mode id/,
  );
  assert.throws(
    () => conn.setCompanion('north-youth', { mock: true, modes: [{ ...modes[0], color: 'green' }] }),
    /color must be/,
  );
  assert.throws(
    () => conn.setCompanion('north-youth', { mock: true, modes: [{ ...modes[0], match: '' }] }),
    /needs a match value/,
  );
  assert.throws(
    () => conn.setCompanion('north-youth', { mock: true, modes: [{ ...modes[0], press: { page: 0, row: 0, column: 1 } }] }),
    /page must be at least 1/,
  );
  assert.throws(
    () => conn.setCompanion('north-youth', { mock: true, modes: [{ ...modes[0], press: { page: 1, row: 'x', column: 1 } }] }),
    /integer page\/row\/column/,
  );
  assert.deepEqual(conn.getCompanion('north-youth'), before);
});

test('Companion can keep a blank mode list while Room Mode is disabled', () => {
  const clean = conn.setCompanion('north-youth', { mock: true, roomMode: false, modes: [] });
  assert.deepEqual(clean, { mock: true, roomMode: false, modes: [] });
  assert.equal(rooms['north-youth'].roomMode, false);
  assert.deepEqual(rooms['north-youth'].modes, []);
});

test('setPlanningCenter rejects bad input without changing anything', () => {
  const before = conn.getPlanningCenter('north-chapel');
  assert.throws(() => conn.setPlanningCenter('north-chapel', [{ id: 'abc', name: 'X' }]), /must be numeric/);
  assert.throws(() => conn.setPlanningCenter('north-chapel', [{ id: '1', name: '' }]), /needs a name/);
  assert.throws(
    () => conn.setPlanningCenter('north-chapel', [{ id: '1', name: 'A' }, { id: '1', name: 'B' }]),
    /Duplicate/,
  );
  assert.throws(() => conn.setPlanningCenter('nope', []), /Unknown room/);
  assert.deepEqual(conn.getPlanningCenter('north-chapel'), before);
});
