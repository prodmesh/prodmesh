// The desktop app's server-or-client decisions (#48). Plain node, no Electron:
// run with the server suite by `npm test` at the repo root.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  identify, launchMode, locate, normalizeAddress, opensExternally, originsOf, readPrefs, sameOrigin, writePrefs,
} from './connect.js';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';

test('a computer already running a server is never asked, even with no prefs file', () => {
  assert.equal(launchMode({ prefs: {}, dataDirExists: true }), 'server');
});

test('a computer that has never run ProdMesh is asked', () => {
  assert.equal(launchMode({ prefs: {}, dataDirExists: false }), 'choose');
});

test('a saved choice is kept, and a client with no server saved is asked again', () => {
  assert.equal(launchMode({ prefs: { mode: 'server' }, dataDirExists: false }), 'server');
  assert.equal(launchMode({ prefs: { mode: 'client', server: { url: 'http://192.0.2.10:8080' } }, dataDirExists: true }), 'client');
  assert.equal(launchMode({ prefs: { mode: 'client' }, dataDirExists: false }), 'choose');
});

test('prefs survive a round trip, and a damaged file reads as no choice', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prodmesh-desktop-'));
  try {
    assert.deepEqual(readPrefs(dir), {});
    writePrefs(dir, { mode: 'client', server: { systemId: A, url: 'http://192.0.2.10:8080' } });
    assert.equal(readPrefs(dir).server.systemId, A);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('what someone types becomes an origin, with the usual port', () => {
  assert.equal(normalizeAddress('192.0.2.10'), 'http://192.0.2.10:8080');
  assert.equal(normalizeAddress(' 192.0.2.10:3000 '), 'http://192.0.2.10:3000');
  assert.equal(normalizeAddress('http://booth-mini.local:8080/room/main'), 'http://booth-mini.local:8080');
  assert.equal(normalizeAddress('https://prodmesh.example.org'), 'https://prodmesh.example.org');
  assert.equal(normalizeAddress('http://192.0.2.10:80'), 'http://192.0.2.10');
});

test('anything that is not an http address is refused', () => {
  for (const bad of ['', 'file:///etc/passwd', 'javascript:alert(1)', 'ftp://192.0.2.10', 'http://user:pw@192.0.2.10']) {
    assert.throws(() => normalizeAddress(bad), undefined, bad);
  }
});

test('a discovered server is tried on IPv4 first, then routable IPv6', () => {
  assert.deepEqual(
    originsOf({ port: 8080, addresses: ['fe80::1', '2001:db8::5', '192.0.2.10'] }),
    ['http://192.0.2.10:8080', 'http://[2001:db8::5]:8080'],
  );
});

const reply = (status, body) => async () => ({ ok: status < 400, status, json: async () => body });

test('identify knows a ProdMesh by its identity, and says plainly when it is not one', async () => {
  assert.deepEqual(await identify('http://x', { fetch: reply(200, { systemId: A, name: 'North' }) }), { systemId: A, name: 'North' });
  await assert.rejects(identify('http://x', { fetch: reply(200, { hello: 1 }) }), /not a ProdMesh/);
  await assert.rejects(identify('http://x', { fetch: reply(404, null) }), /not a ProdMesh/);
  await assert.rejects(identify('http://x', { fetch: async () => { throw new Error('ECONNREFUSED'); } }), /Nothing answered/);
});

const saved = { systemId: A, url: 'http://192.0.2.10:8080' };
const who = (map) => async (url) => {
  if (!(url in map)) throw new Error('Nothing answered');
  return map[url];
};

test('the saved address is used while the same server answers there', async () => {
  const at = await locate(saved, { identify: who({ 'http://192.0.2.10:8080': { systemId: A, name: 'North' } }) });
  assert.deepEqual(at, { url: 'http://192.0.2.10:8080', name: 'North' });
});

test('when DHCP moves the server, it is found again by its id', async () => {
  const at = await locate(saved, {
    identify: who({ 'http://192.0.2.20:8080': { systemId: A, name: 'North' } }),
    browse: async () => [{ systemId: A, port: 8080, addresses: ['192.0.2.20'], duplicate: false }],
  });
  assert.equal(at.url, 'http://192.0.2.20:8080');
});

test('a different server at the old address is not mistaken for ours', async () => {
  const at = await locate(saved, {
    identify: who({ 'http://192.0.2.10:8080': { systemId: B, name: 'Youth' } }),
    browse: async () => [],
  });
  assert.equal(at, null);
});

test('a server id seen on two boxes is not picked between silently', async () => {
  const at = await locate(saved, {
    identify: who({ 'http://192.0.2.30:8080': { systemId: A, name: 'North' } }),
    browse: async () => [{ systemId: A, port: 8080, addresses: ['192.0.2.30'], duplicate: true }],
  });
  assert.equal(at, null);
});

test('the window stays on its server, and links out go to the browser', () => {
  assert.equal(sameOrigin('http://192.0.2.10:8080/room/main', 'http://192.0.2.10:8080'), true);
  assert.equal(sameOrigin('http://192.0.2.11:8080/', 'http://192.0.2.10:8080'), false);
  assert.equal(sameOrigin('not a url', 'http://192.0.2.10:8080'), false);
  assert.equal(opensExternally('https://services.planningcenteronline.com/plans/1'), true);
  assert.equal(opensExternally('file:///etc/passwd'), false);
});
