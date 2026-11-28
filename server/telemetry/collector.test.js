// A whole report, built from a booted server with the demo topology, must
// validate against the schema and contain nothing that names the church: no
// room id or name, no campus, no device address, no install path, no host
// name, no linked server's id. The oracle is the live configuration itself,
// so a new identifying field that reaches a report fails this test without
// anyone having to think of it first.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA = mkdtempSync(join(tmpdir(), 'prodmesh-collector-'));
process.env.PRODMESH_DATA_DIR = DATA;

// A previous run that crashed, with an address in its message and an absolute
// path in its stack, as lifecycle.js would have left it.
mkdirSync(join(DATA, 'telemetry'), { recursive: true });
writeFileSync(join(DATA, 'telemetry', 'running.json'), JSON.stringify({ pid: process.pid, version: '1.5.0', bootedAt: 1_000, aliveAt: 61_000 }));
writeFileSync(join(DATA, 'telemetry', 'fatal.json'), JSON.stringify({
  at: 61_000, origin: 'uncaughtException', version: '1.5.0', name: 'Error',
  message: 'socket hang up talking to 192.0.2.44:1025',
  stack: `Error: socket hang up\n    at Socket.onClose (${process.cwd()}/server/integrations/proPresenter.js:120:7)\n    at /Users/booth-admin/elsewhere.js:1:1`,
}));

const lifecycle = await import('../lifecycle.js');
lifecycle.begin({ version: '1.6.0' });
const { rooms } = await import('../roomsStore.js');
const { getChurch } = await import('../appConfig.js');
const health = await import('../health.js');
const backup = await import('../backup.js');
const versions = await import('./versions.js');
const collector = await import('./collector.js');
const { validate, fieldPaths, ERRORS_MAX } = await import('./schema.js');

collector.start();

const PEER = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const roomId = Object.keys(rooms)[0];

test('the demo topology gives the leak check something to find', () => {
  assert.ok(roomId, 'a room exists');
  assert.ok(getChurch().sites.length > 0);
});

test('a full report validates', () => {
  collector._resetForTests();
  health.declare('proPresenter@192.0.2.15:1025');
  health.declare(`peer:${PEER}`);
  versions.noteProductVersion('proPresenter', 'ProPresenter 21.1 · Booth-Mac');
  health.unexpected(`autostart ${roomId}`, new TypeError("Cannot read properties of undefined (reading 'items')"));
  const report = collector.buildReport();
  assert.deepEqual(validate(report), []);
});

test('nothing in a report names the church, its rooms, its devices or its machine', () => {
  const text = JSON.stringify(collector.buildReport());
  const church = getChurch();
  const forbidden = new Set([
    ...Object.keys(rooms),
    ...Object.values(rooms).map((r) => r.name),
    ...church.sites.flatMap((s) => [s.id, s.name]),
    ...church.sites.flatMap((s) => (s.auditoriums ?? []).flatMap((a) => [a.id, a.name])),
    PEER,
    'Booth-Mac',
    DATA,
    process.cwd(),
  ]);
  // Device addresses, wherever the room config keeps them.
  for (const host of JSON.stringify(rooms).match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) ?? []) forbidden.add(host);
  forbidden.add('192.0.2.15');
  forbidden.add('192.0.2.44');
  // The machine's own name, where it is distinctive enough to search for.
  if (os.hostname().length >= 6) forbidden.add(os.hostname());

  for (const word of forbidden) {
    if (!word || String(word).length < 4) continue; // "Main" would match the schema's own words
    assert.ok(!text.includes(String(word)), `report contains ${JSON.stringify(word)}`);
  }
});

test('errors: scrubbed on the way in, grouped, counted past the log throttle', () => {
  collector._resetForTests();
  const err = () => new RangeError(`bad index into ${roomId} at 192.0.2.9`);
  // Same line, three times inside the once-a-minute log throttle.
  for (let i = 0; i < 3; i += 1) health.unexpected(`show ${roomId}`, err());
  const { errors } = collector.buildReport();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].count, 3);
  assert.equal(errors[0].where, 'show');
  // The scrubber alone would pass the room id, written as a plain word; this
  // server knows its own names and takes them out too.
  assert.equal(errors[0].message, 'bad index into <name> at <ip>');
});

test("this server's own names come out of messages: church, people, rooms", async () => {
  collector._resetForTests();
  const auth = await import('../authStore.js');
  auth.createUser({ username: 'srivera', displayName: 'Sam Rivera', pin: '2468', groupIds: [] });
  const church = getChurch().name;
  collector.recordError('signals', new Error(`no PIN for Sam Rivera (srivera) at ${church} in ${rooms[roomId].name}`));
  const [e] = collector.buildReport().errors;
  assert.equal(e.message, 'no PIN for <name> (<name>) at <name> in <name>');
});

test('an outage is the church’s business and never reaches a report', () => {
  collector._resetForTests();
  health.unexpected('watching', health.outage(new Error('ECONNREFUSED'), 'proPresenter@192.0.2.15:1025'));
  assert.deepEqual(collector.buildReport().errors, []);
});

test('error groups are capped, and the overflow is counted', () => {
  collector._resetForTests();
  for (let i = 0; i < ERRORS_MAX + 7; i += 1) {
    const e = new Error('distinct');
    e.name = `Kind${i}`; // a different name is a different group
    collector.recordError('signals', e);
  }
  const r = collector.buildReport();
  assert.equal(r.errors.length, ERRORS_MAX);
  assert.equal(r.errorsDropped, 7);
  assert.deepEqual(validate(r), []);
});

test('integrations are listed by allowlisted name only, with digits-only versions', () => {
  versions.noteProductVersion('proPresenter', 'ProPresenter 21.1 · Booth-Mac');
  versions.noteProductVersion(`peer:${PEER}`, '1.6.0'); // not an integration: ignored
  const { integrations } = collector.buildReport().shape;
  assert.deepEqual(integrations.proPresenter, { version: '21.1' });
  for (const name of Object.keys(integrations)) assert.ok(versions.INTEGRATIONS.has(name), name);
  assert.ok(!Object.keys(integrations).some((k) => k.startsWith('peer')), 'a linked server is not an integration');
});

test('the crash the last run left is in the report, scrubbed', () => {
  const { previous, uncleanExits } = collector.buildReport().lifecycle;
  assert.equal(uncleanExits, 1);
  assert.equal(previous.endedCleanly, false);
  assert.equal(previous.version, '1.5.0');
  assert.equal(previous.uptimeMs, 60_000);
  assert.equal(previous.error.message, 'socket hang up talking to <ip>');
  assert.deepEqual(previous.error.frames, [
    'Socket.onClose (server/integrations/proPresenter.js:120:7)',
    '<external>',
  ]);
});

test('building a report changes nothing; taking the window starts a new one', () => {
  collector._resetForTests();
  collector.recordError('alerts', new Error('once'));
  assert.equal(collector.buildReport().errors.length, 1);
  assert.equal(collector.buildReport().errors.length, 1, 'a preview is not a send');
  collector.takeWindow();
  assert.equal(collector.buildReport().errors.length, 0);
});

test('a boot and the crash before it are reported once, not in every window', () => {
  collector._resetForTests();
  assert.equal(collector.buildReport().lifecycle.boots, 1);
  assert.notEqual(collector.buildReport().lifecycle.previous, null);
  collector.takeWindow();
  const next = collector.buildReport().lifecycle;
  assert.deepEqual(next, { boots: 0, uncleanExits: 0, previous: null });
  collector._resetForTests();
});

test('the telemetry id is random, stable, resettable, and not in backups', () => {
  const id = collector.telemetryId();
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(collector.telemetryId(), id);
  const fresh = collector.resetTelemetryId();
  assert.notEqual(fresh, id);
  assert.equal(collector.telemetryId(), fresh);
  assert.ok(existsSync(join(DATA, 'telemetry', 'id.json')));
  const files = Object.keys(backup.readBackup(backup.createBackup()).files);
  assert.ok(!files.some((f) => f.includes('telemetry')), files.join(', '));
});

test('the schema refuses fields it does not describe, and text that still leaks', () => {
  const r = collector.buildReport();
  assert.match(validate({ ...r, roomName: 'x' }).join('\n'), /roomName: not in the schema/);
  assert.match(validate({ ...r, host: { ...r.host, hostname: 'x' } }).join('\n'), /host\.hostname: not in the schema/);
  const leaky = { ...r, errors: [{ where: 'show', name: 'Error', message: 'from 192.0.2.9', frames: ['/Users/x/server/a.js:1:1'], fingerprint: '0123456789abcdef', count: 1, firstSeen: 0, lastSeen: 0 }] };
  const problems = validate(leaky).join('\n');
  assert.match(problems, /errors\[0\]\.message: still looks like/);
  assert.match(problems, /errors\[0\]\.frames\[0\]: does not match/);
});

test('docs/TELEMETRY.md describes every field the schema allows', async () => {
  const { readFileSync } = await import('node:fs');
  const doc = readFileSync(new URL('../../docs/TELEMETRY.md', import.meta.url), 'utf8');
  const missing = fieldPaths().filter((p) => !doc.includes(`\`${p}\``));
  assert.deepEqual(missing, [], 'add these to docs/TELEMETRY.md');
});
