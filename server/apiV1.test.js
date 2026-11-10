// The /api/v1 contract (ADR 0013): what it serves, what it refuses, that it
// agrees with the handlers it fronts, the fields it promises, and the rule
// that picks "the current service" for a start that names no plan.
//
// The ADR's known limit is that a frozen surface is only as honest as its
// tests: nothing else fails when a response shape changes. These are those
// tests. A failure here is a broken promise to an integrator, so the fix is
// almost never to edit the test.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listenOnLoopback } from './testServer.js';

process.env.PRODMESH_DATA_DIR = mkdtempSync(join(tmpdir(), 'prodmesh-apiv1-'));
delete process.env.PRODMESH_AUTOSTART_TEST; // the window rule is under test here

const { app } = await import('./index.js');
const { V1, matchV1 } = await import('./apiV1.js');
const { rooms } = await import('./roomsStore.js');
const sm = await import('./showManager.js');
const auth = await import('./authStore.js');

const ROOM = 'north-youth'; // simulated Companion, mock Planning Center plans
const __dirname = dirname(fileURLToPath(import.meta.url));

let base;
let server;
before(async () => { ({ server, base } = await listenOnLoopback(app)); });
after(() => { server.closeAllConnections?.(); server.close(); });

const get = (path) => fetch(base + path);

test('docs/API.md lists exactly the allowlist, so the published contract cannot drift', () => {
  const doc = readFileSync(join(__dirname, '..', 'docs', 'API.md'), 'utf8');
  const documented = [...doc.matchAll(/^\| (GET|POST|PUT|DELETE) \| \/api\/v1(\S+) \| (\S+) \|/gm)]
    .map(([, method, path, permission]) => `${method} ${path} ${permission === '—' ? '' : permission}`.trim())
    .sort();
  const enforced = V1.map((e) => `${e.method} ${e.path} ${e.permission ?? ''}`.trim()).sort();
  assert.deepEqual(documented, enforced);
});

test('anything not on the list is 404 under v1, however real it is under /api', async () => {
  for (const path of [
    '/api/v1', '/api/v1/', '/api/v1/settings', '/api/v1/tokens', '/api/v1/system/backup',
    '/api/v1/system/audit', '/api/v1/users', `/api/v1/rooms/${ROOM}/views`,
    `/api/v1/rooms/${ROOM}/propresenter`, `/api/v1/rooms/${ROOM}/show/stream`,
    '/api/v1/rooms/a/b/c/d/e',
  ]) {
    const res = await get(path);
    assert.equal(res.status, 404, path);
    assert.equal((await res.json()).error, 'not_in_v1', path);
  }
  // …while the unversioned route it would have mirrored is alive.
  assert.equal((await get('/api/system/version')).status, 200);
});

test('the right path with the wrong method is a 405 that names the right one', async () => {
  const res = await get(`/api/v1/rooms/${ROOM}/show/end`);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'POST');
  assert.deepEqual((await res.json()).allowed, ['POST']);
  assert.equal(matchV1('HEAD', '/rooms'), matchV1('GET', '/rooms'), 'HEAD rides on GET');
});

test('v1 answers exactly as the unversioned route does: one handler, two doors', async () => {
  const plan = (await (await get(`/api/rooms/${ROOM}/service`)).json()).plans[0].id;
  for (const path of [
    '/rooms', `/rooms/${ROOM}`, `/rooms/${ROOM}/show`, `/rooms/${ROOM}/service`, '/services',
    `/rooms/${ROOM}/plan/${plan}`, `/rooms/${ROOM}/plan/${plan}/report`, '/about', '/system/version',
    '/calendar?start=2026-01-01T00:00:00Z&end=2026-01-08T00:00:00Z',
  ]) {
    const [v1, legacy] = await Promise.all([get(`/api/v1${path}`), get(`/api${path}`)]);
    assert.equal(v1.status, legacy.status, path);
    assert.deepEqual(await v1.json(), await legacy.json(), path);
  }
});

// The fields an integrator may rely on. Adding fields never fails these;
// removing or renaming a promised one does, which is the point.
const has = (obj, keys, where) => {
  for (const k of keys) assert.ok(Object.hasOwn(obj, k), `${where} must carry '${k}'`);
};

test('promised response fields', async () => {
  const roomsList = await (await get('/api/v1/rooms')).json();
  assert.ok(Array.isArray(roomsList) && roomsList.length > 0);
  for (const r of roomsList) has(r, ['id', 'name', 'site', 'modes'], 'a room');
  const room = roomsList.find((r) => r.id === ROOM);
  for (const m of room.modes) has(m, ['id', 'label'], 'a mode');

  has(await (await get(`/api/v1/rooms/${ROOM}/state`)).json(), ['mode', 'online', 'source', 'protection'], 'room state');
  has(await (await get(`/api/v1/rooms/${ROOM}/show`)).json(), ['active'], 'show state');

  const service = await (await get(`/api/v1/rooms/${ROOM}/service`)).json();
  has(service, ['configured', 'plans'], 'a room service');
  for (const p of service.plans) has(p, ['id', 'serviceTypeId', 'title', 'sortDate'], 'a plan');

  has(await (await get('/api/v1/about')).json(), ['name', 'version'], 'about');
  has(await (await get('/api/v1/system/version')).json(), ['version'], 'system version');
  has(await (await get('/api/v1/system/health')).json(), ['integrations'], 'health');
});

test('a running show carries the fields a button or deck reads', async () => {
  const plan = (await (await get(`/api/rooms/${ROOM}/service`)).json()).plans[0].id;
  // A time id of its own: ending a show completes it, and a completed
  // svc-1 would change what "the current service" tests below expect.
  await sm.startShow(ROOM, plan, 'contract-probe');
  try {
    has(await (await get(`/api/v1/rooms/${ROOM}/show`)).json(), ['active', 'roomId', 'planId', 'timeId'], 'a running show');
  } finally {
    sm.endShow(ROOM);
  }
});

test('/history is the one gated read, and a token can be granted it', async () => {
  assert.equal((await get('/api/v1/history')).status, 401);
  const { token } = auth.createServiceToken({ name: 'Report puller', permissions: ['reports.view'] });
  const res = await fetch(`${base}/api/v1/history`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
});

// ── "The current service": what a start with no planId begins ────────────────

// Mock Planning Center puts 9:00 and 11:00 services (and an 8:00 rehearsal)
// on the coming Sunday, for every upcoming plan.
function comingSunday(h, m = 0) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + ((7 - d.getDay()) % 7));
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

test('the current service is the nearest service time inside the arm window', async () => {
  const room = rooms[ROOM];
  const early = await sm.currentService(room, comingSunday(7, 30));
  assert.equal(early?.timeId, 'svc-1', '7:30 is inside the window, nearest the 9:00');
  assert.match(early.planId, /^mock-/);
  assert.equal((await sm.currentService(room, comingSunday(10, 40)))?.timeId, 'svc-2', '10:40 is nearer the 11:00');
  // A rehearsal is never what a service button starts.
  assert.notEqual((await sm.currentService(room, comingSunday(8, 0)))?.timeId, 'reh-1');

  // Once the 9:00's show is completed, Start at 9:50 is the 11:00 — never
  // reopening a service that has finished.
  await sm.startShow(ROOM, early.planId, 'svc-1');
  sm.endShow(ROOM);
  assert.equal((await sm.currentService(room, comingSunday(9, 50)))?.timeId, 'svc-2');
});

test('outside the window there is no current service, rather than a guess', async () => {
  const room = rooms[ROOM];
  assert.equal(await sm.currentService(room, comingSunday(6, 30)), null, '2.5h before the first service');
  assert.equal(await sm.currentService(room, comingSunday(12, 30)), null, '1.5h after the last');
  assert.equal(await sm.currentService(room, comingSunday(10) + 3 * 86_400_000), null, 'midweek');
});

test('a room with no Planning Center plans answers 409, not a show of nothing', async () => {
  const bare = Object.values(rooms).find((r) => !(r.planningCenter?.serviceTypes ?? []).length);
  assert.ok(bare, 'the seed has a room with no service types');
  const { token } = auth.createServiceToken({ name: 'Start probe', permissions: ['shows.operate'] });
  const res = await fetch(`${base}/api/v1/rooms/${bare.id}/show/start`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'no_current_service');
  assert.equal(sm.getState(bare.id).active, false);
});
