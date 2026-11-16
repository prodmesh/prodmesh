// LAN discovery (#56): unique instance names by construction, a TXT record
// clients can key on, goodbyes on the way out, and a second box running as us
// surfaced rather than merged.
//
// The network half really multicasts, on a service type no real install uses,
// so it neither sees nor disturbs anything else on the segment. A machine with
// no multicast route (no network at all) skips that half rather than failing.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bonjour } from 'bonjour-service';

const DATA = mkdtempSync(join(tmpdir(), 'prodmesh-discovery-'));
process.env.PRODMESH_DATA_DIR = DATA;

const discovery = await import('./discovery.js');
const identity = await import('./identity.js');

after(async () => {
  await discovery.stopAdvertising();
  rmSync(DATA, { recursive: true, force: true });
});

const bytes = (s) => Buffer.byteLength(s, 'utf8');
const ID = '0f1e2d3c-4b5a-4968-8776-655443322110';
const TYPE = `prodmesh-test-${crypto.randomBytes(3).toString('hex')}`;

// ── Names ───────────────────────────────────────────────────────────────────

test('the instance name carries the first six of the system id', () => {
  assert.equal(discovery.instanceName('North Campus', ID), 'North Campus [0f1e2d]');
});

test('two servers with one display name still have different instance names', () => {
  const other = 'a1b2c3d4-0000-4000-8000-000000000000';
  assert.notEqual(discovery.instanceName('Youth', ID), discovery.instanceName('Youth', other));
});

test('dots survive as middle dots, because the library splits names on them', () => {
  assert.equal(discovery.instanceName('St. Example Church', ID), 'St· Example Church [0f1e2d]');
});

test('a long name is clipped to one DNS label, on a character boundary', () => {
  const name = discovery.instanceName('Église Évangélique — '.repeat(6), ID);
  assert.ok(bytes(name) <= 63, `${bytes(name)} bytes`);
  assert.match(name, /… \[0f1e2d\]$/);
  assert.doesNotMatch(name, /�/);
});

test('a duplicate adds the hostname, so a person can tell the two boxes apart', () => {
  assert.equal(discovery.instanceName('North', ID, 'booth-mini'), 'North [0f1e2d · booth-mini]');
  assert.equal(discovery.shortHost('booth-mini.local'), 'booth-mini');
  assert.equal(discovery.shortHost('booth-mini.example.org'), 'booth-mini');
});

test('on for production and the desktop, off for npm run dev, and overridable', () => {
  assert.equal(discovery.enabled({ NODE_ENV: 'production' }), true);
  assert.equal(discovery.enabled({}), Boolean(process.versions.electron));
  assert.equal(discovery.enabled({ PRODMESH_DISCOVERY: 'on' }), true);
  assert.equal(discovery.enabled({ NODE_ENV: 'production', PRODMESH_DISCOVERY: 'off' }), false);
});

// ── What a client sees ──────────────────────────────────────────────────────

const svc = (over) => ({ name: 'x', host: 'h.local', port: 8080, addresses: ['192.0.2.10'], ...over });

test('a client keys on the system id and keeps same-named servers apart', () => {
  const list = discovery.toInstances([
    svc({ txt: { id: 'aaa', name: 'Youth', v: '1.5.0', boot: '1' } }),
    svc({ txt: { id: 'bbb', name: 'Youth', v: '1.5.0', boot: '2' }, addresses: ['192.0.2.11'] }),
    svc({ txt: {} }), // not ours, or malformed: no id, not listed
  ]);
  assert.deepEqual(list.map((i) => [i.systemId, i.name, i.duplicate]), [['aaa', 'Youth', false], ['bbb', 'Youth', false]]);
});

test('one id from two running boxes is flagged on both, not merged into one', () => {
  const list = discovery.toInstances([
    svc({ host: 'old-mini.local', txt: { id: 'aaa', name: 'North', boot: '1' } }),
    svc({ host: 'new-mini.local', txt: { id: 'aaa', name: 'North', boot: '2' }, addresses: ['192.0.2.12'] }),
  ]);
  assert.equal(list.length, 2);
  assert.ok(list.every((i) => i.duplicate));
});

// ── On the wire ─────────────────────────────────────────────────────────────

const hasLan = Object.values(os.networkInterfaces()).flat().some((a) => a && !a.internal && a.family === 'IPv4');
const wire = { skip: hasLan ? false : 'no network interface to multicast on' };

const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
};

test('advertises with id, name and version in TXT, beside a same-named stranger', wire, async () => {
  identity.setSystemName('Test Campus');
  const me = identity.getIdentity();
  const s = discovery.startAdvertising({ port: 18080, type: TYPE });
  assert.equal(s.advertising, true);
  assert.equal(s.instance, discovery.instanceName('Test Campus', me.systemId));

  // A different server with the same display name, on the same segment.
  const stranger = new Bonjour();
  stranger.publish({
    name: discovery.instanceName('Test Campus', ID), type: TYPE, port: 18081, probe: false,
    txt: { id: ID, name: 'Test Campus', v: '1.5.0', boot: 'beef' },
  });

  const found = await until(async () => {
    const list = await discovery.browse({ type: TYPE, timeoutMs: 1500 });
    return list.length >= 2 ? list : null;
  }, 8000);
  await new Promise((r) => stranger.unpublishAll(() => stranger.destroy(r)));

  assert.ok(found, 'both servers answered a browse');
  const mine = found.find((i) => i.systemId === me.systemId);
  assert.equal(mine.name, 'Test Campus');
  assert.equal(mine.port, 18080);
  assert.ok(mine.version);
  assert.ok(found.find((i) => i.systemId === ID));
  assert.ok(found.every((i) => !i.duplicate));
});

test('a rename is re-announced', wire, async () => {
  identity.setSystemName('Renamed Campus');
  discovery.nameChanged();
  const me = identity.getIdentity();
  const found = await until(async () => {
    const list = await discovery.browse({ type: TYPE, timeoutMs: 1500 });
    return list.find((i) => i.systemId === me.systemId && i.name === 'Renamed Campus');
  }, 8000);
  assert.ok(found, 'the new name was seen');
  assert.equal(discovery.status().instance, discovery.instanceName('Renamed Campus', me.systemId));
});

test('another box running as us is logged and named apart, never merged', wire, async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const me = identity.getIdentity();
  const twin = new Bonjour();
  twin.publish({
    name: discovery.instanceName(me.name, me.systemId, 'old-mini'), type: TYPE, port: 18082, probe: false,
    txt: { id: me.systemId, name: me.name, v: '1.5.0', boot: 'twin' },
  });
  const seen = await until(() => discovery.status().duplicate, 8000);
  const found = await until(async () => {
    const list = await discovery.browse({ type: TYPE, timeoutMs: 1500 });
    return list.filter((i) => i.systemId === me.systemId).length >= 2 ? list : null;
  }, 8000);
  await new Promise((r) => twin.unpublishAll(() => twin.destroy(r)));

  assert.ok(seen, 'the duplicate was noticed');
  assert.match(discovery.status().instance, / · /, 'renamed with the hostname');
  assert.ok(warn.mock.calls.some((c) => /running as this one/.test(c.arguments[0])));
  const twins = found.filter((i) => i.systemId === me.systemId);
  assert.ok(twins.every((i) => i.duplicate), 'a client flags both');
});

test('stopping says goodbye, so a listening client drops it at once', wire, async () => {
  const me = identity.getIdentity();
  const listener = new Bonjour();
  const browser = listener.find({ type: TYPE });
  await until(() => browser.services.some((s) => s.txt?.id === me.systemId), 6000);
  const gone = new Promise((resolve) => {
    browser.on('down', (s) => { if (s.txt?.id === me.systemId) resolve(true); });
    setTimeout(() => resolve(false), 4000);
  });
  await discovery.stopAdvertising();
  const dropped = await gone;
  browser.stop();
  await new Promise((r) => listener.destroy(r));
  assert.equal(dropped, true);
  assert.equal(discovery.status().advertising, false);
});
