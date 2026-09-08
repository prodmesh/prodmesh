import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenOnLoopback } from './testServer.js';

// Isolated store + import the app (which won't listen on its own).
process.env.PRODMESH_DATA_DIR = mkdtempSync(join(tmpdir(), 'prodmesh-api-'));
process.env.PRODMESH_LOG_FILE = join(process.env.PRODMESH_DATA_DIR, 'server.log');
writeFileSync(
  process.env.PRODMESH_LOG_FILE,
  Array.from({ length: 30 }, (_, i) => `log line ${i + 1}`).join('\n') + '\n',
);
const { app } = await import('./index.js');
const settings = await import('./settings.js');
const auth = await import('./authStore.js');

// north-youth is mock:true, so mode presses resolve in-memory (no Companion).
const ROOM = 'north-youth';
settings.setPins({ admin: 'admin1234', override: '9999' });
settings.setSchedules({
  [ROOM]: [{ id: 't', label: 'Test Lock', days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59', lock: ['standby'] }],
});
const operatorGroup = auth.createGroup({ name: 'Mode Operators', permissions: ['rooms.mode.change'] });
auth.createUser({ username: 'operator', displayName: 'Test Operator', pin: '2468', groupIds: [operatorGroup.id] });
const station = auth.registerStation({ name: 'API Test Station' });

let base;
let server;
let operatorToken;
before(async () => {
  ({ server, base } = await listenOnLoopback(app));
  const login = await post('/api/auth/login', { username: 'operator', pin: '2468' }, null, station.token);
  operatorToken = (await login.json()).token;
});
after(() => server.close());

function post(path, body, token, stationToken = null) {
  return fetch(base + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(stationToken ? { 'X-Prodmesh-Station': stationToken } : {}),
    },
    body: JSON.stringify(body),
  });
}

function apiRequest(path, { method = 'GET', body, raw, token, stationToken } = {}) {
  return fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(raw ? { 'Content-Type': 'application/octet-stream' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(stationToken ? { 'X-Prodmesh-Station': stationToken } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    ...(raw ? { body: raw } : {}),
  });
}

test('admin login rejects a wrong PIN and accepts the right one', async () => {
  assert.equal((await post('/api/auth/admin', { pin: '0000' })).status, 401);
  const res = await post('/api/auth/admin', { pin: 'admin1234' });
  assert.equal(res.status, 200);
  const { token } = await res.json();
  assert.ok(token);
});

test('the admin PIN is an account, reachable through either door', async () => {
  // The reconciliation in ADR 0012. The PIN gate on the Admin page and the
  // ordinary login form are now two ways to the SAME credential — before this,
  // typing the PIN people actually know into the login box simply failed,
  // because "admin" was a hash in settings.json rather than a user.
  const viaPin = await (await post('/api/auth/admin', { pin: 'admin1234' })).json();
  assert.equal(viaPin.user.username, 'admin');
  assert.equal(viaPin.user.displayName, 'System Administrator');
  assert.deepEqual(viaPin.permissions, ['*']);

  const viaForm = await post('/api/auth/login', { username: 'admin', pin: 'admin1234' }, null, station.token);
  assert.equal(viaForm.status, 200);
  const form = await viaForm.json();
  assert.equal(form.user.id, viaPin.user.id, 'one account, not two');
  assert.deepEqual(form.permissions, ['*']);

  // Both are ordinary sessions now, so status reports a real user rather than
  // the invented `legacy-admin` it used to answer with.
  const status = await (await fetch(base + '/api/auth/status', {
    headers: { Authorization: `Bearer ${viaPin.token}` },
  })).json();
  assert.equal(status.authenticated, true);
  assert.equal(status.admin, true);
  assert.equal(status.user.id, viaPin.user.id);
});

test('an admin action is attributable to somebody', async () => {
  // The point of the change, not a nicety: admin actions used to audit with a
  // station and no user, so "who ran the update" had no answer.
  const { token } = await (await post('/api/auth/admin', { pin: 'admin1234' })).json();
  const log = await (await fetch(base + '/api/system/audit', { headers: { Authorization: `Bearer ${token}` } })).json();
  const login = log.entries.find((entry) => entry.action === 'auth.admin' && entry.result === 'allowed');
  assert.ok(login, 'the admin login is in the log');
  // The log joins to users, so a row with no user reads as a blank name. This
  // is the assertion the old behaviour could not pass.
  assert.equal(login.username, 'admin');
  assert.equal(login.userName, 'System Administrator');
});

test('the built-in admin cannot be stripped of its authority', async () => {
  // It is the way back into a box in a building. A screen that can remove its
  // group is a screen that can lock a church out of its own booth.
  const { token, user } = await (await post('/api/auth/admin', { pin: 'admin1234' })).json();
  const res = await apiRequest(`/api/users/${user.id}/groups`, { method: 'PUT', token, body: { groupIds: [] } });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /must stay an administrator/);

  // Still an admin afterwards.
  const still = await (await post('/api/auth/admin', { pin: 'admin1234' })).json();
  assert.deepEqual(still.permissions, ['*']);
});

test('changing the admin PIN changes the account, both doors at once', async () => {
  const { token } = await (await post('/api/auth/admin', { pin: 'admin1234' })).json();
  const change = await apiRequest('/api/settings/pins', { method: 'POST', token, body: { admin: 'rotated789' } });
  assert.equal(change.status, 200);
  try {
    assert.equal((await post('/api/auth/admin', { pin: 'admin1234' })).status, 401, 'the old PIN is gone');
    const form = await post('/api/auth/login', { username: 'admin', pin: 'rotated789' }, null, station.token);
    assert.equal(form.status, 200, 'and the login form has the new one');
  } finally {
    settings.setPins({ admin: 'admin1234' }); // the rest of this file expects it
  }
});

test('settings endpoint requires an admin token', async () => {
  assert.equal((await fetch(base + '/api/settings')).status, 401);
  const { token } = await (await post('/api/auth/admin', { pin: 'admin1234' })).json();
  const ok = await fetch(base + '/api/settings', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(ok.status, 200);
});

test('user directory includes the avatar contract', async () => {
  const { token } = await (await post('/api/auth/admin', { pin: 'admin1234' })).json();
  const res = await fetch(base + '/api/users', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  const directory = await res.json();
  assert.ok(directory.users.length > 0);
  assert.ok(directory.users.every((user) => Object.hasOwn(user, 'avatarUrl')));
});

test('version reports how this copy was installed, not just a commit', async () => {
  const res = await fetch(base + '/api/system/version');
  assert.equal(res.status, 200);
  const version = await res.json();
  assert.ok(version.version, 'a release version is always present');
  assert.equal(version.deployment, 'git'); // the checkout these tests run in
  assert.equal(version.update.supported, true);
});

test('a container refuses to self-update instead of spawning a script it lacks', async () => {
  // An image has no deploy scripts and nothing to pull, and a container that
  // rewrote its own code would silently lose the change on the next restart.
  const { token } = await (await post('/api/auth/admin', { pin: 'admin1234' })).json();
  process.env.PRODMESH_CONTAINER = '1';
  try {
    const res = await apiRequest('/api/system/update', { method: 'POST', token });
    assert.equal(res.status, 409); // authorized and well-formed — just not how this install works
    const body = await res.json();
    assert.equal(body.error, 'update_not_supported');
    assert.match(body.reason, /image/i, 'says what to do instead');
  } finally {
    delete process.env.PRODMESH_CONTAINER;
  }
});

test('person search says so when no Planning Center token is connected', async () => {
  // Not an error: an install with no token still creates users, it just types
  // the person ID by hand — so the UI has to be able to tell the difference.
  const { token } = await (await post('/api/auth/admin', { pin: 'admin1234' })).json();
  const res = await fetch(base + '/api/planning-center/people?q=avery', {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { configured: false, people: [] });
});

test('admins can rename, assign, and revoke a station', async () => {
  const managed = auth.registerStation({ name: 'Temporary Booth' });
  const { token } = await (await post('/api/auth/admin', { pin: 'admin1234' })).json();

  const list = await apiRequest('/api/stations', { token, stationToken: managed.token });
  assert.equal(list.status, 200);
  assert.equal((await list.json()).stations.find((entry) => entry.id === managed.id).current, true);

  const update = await apiRequest(`/api/stations/${managed.id}`, {
    method: 'PUT', token, stationToken: managed.token,
    body: { name: 'FOH – Temporary', campusId: 'north', roomId: 'north-main' },
  });
  assert.equal(update.status, 200);
  const updated = (await update.json()).station;
  assert.equal(updated.name, 'FOH – Temporary');
  assert.equal(updated.roomId, 'north-main');
  assert.equal(updated.current, true);

  const revoke = await apiRequest(`/api/stations/${managed.id}`, {
    method: 'DELETE', token, stationToken: managed.token,
  });
  assert.equal(revoke.status, 200);
  assert.equal((await revoke.json()).current, true);
  assert.equal(auth.resolveStation(managed.token), null);
});

test('server log tail and audit trail require system.logs', async () => {
  const denied = await apiRequest('/api/system/logs', { token: operatorToken, stationToken: station.token });
  assert.equal(denied.status, 403);
  const deniedAudit = await apiRequest('/api/system/audit', { token: operatorToken, stationToken: station.token });
  assert.equal(deniedAudit.status, 403);

  const viewerGroup = auth.createGroup({ name: 'Log Viewers', permissions: ['system.logs'] });
  auth.createUser({ username: 'viewer', displayName: 'Log Viewer', pin: '1357', groupIds: [viewerGroup.id] });
  const login = await post('/api/auth/login', { username: 'viewer', pin: '1357' }, null, station.token);
  const { token } = await login.json();

  const logs = await apiRequest('/api/system/logs?lines=50', { token, stationToken: station.token });
  assert.equal(logs.status, 200);
  const body = await logs.json();
  assert.equal(body.exists, true);
  assert.equal(body.lines.length, 30);
  assert.equal(body.lines.at(-1), 'log line 30');

  const audit = await apiRequest('/api/system/audit', { token, stationToken: station.token });
  assert.equal(audit.status, 200);
  const { entries } = await audit.json();
  assert.ok(entries.length > 0);
  const loginEntry = entries.find((e) => e.action === 'auth.login' && e.username === 'viewer');
  assert.ok(loginEntry, 'expected the viewer login in the audit trail');
  assert.equal(loginEntry.stationName, 'API Test Station');
});

test('config is public to read, config.manage to write', async () => {
  const read = await fetch(base + '/api/config');
  assert.equal(read.status, 200);
  const church = await read.json();
  assert.ok(church.sites.length > 0);

  const denied = await apiRequest('/api/config', {
    method: 'PUT', body: church, token: operatorToken, stationToken: station.token,
  });
  assert.equal(denied.status, 403);

  const { token } = await (await post('/api/auth/admin', { pin: 'admin1234' })).json();
  const edited = structuredClone(church);
  edited.name = 'Renamed Institution';
  const saved = await apiRequest('/api/config', { method: 'PUT', body: edited, token });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).name, 'Renamed Institution');
  assert.equal((await (await fetch(base + '/api/config')).json()).name, 'Renamed Institution');

  const bad = await apiRequest('/api/config', { method: 'PUT', body: { name: 'X', sites: [] }, token });
  assert.equal(bad.status, 400);
});

test('room connectivity: config.manage to read AND write, live effect', async () => {
  // The read returns the production network map (device host:port, Companion
  // button coordinates), so it is gated like the writes. It used to be public.
  const anon = await fetch(`${base}/api/config/rooms/${ROOM}/connectivity`);
  assert.equal(anon.status, 401);
  assert.equal((await anon.json()).permission, 'config.manage');

  const { token } = await (await post('/api/auth/admin', { pin: 'admin1234' })).json();
  const read = await apiRequest(`/api/config/rooms/${ROOM}/connectivity`, { token });
  assert.equal(read.status, 200);
  const before = await read.json();
  assert.equal(before.hasServerRoom, true);
  assert.ok(before.planningCenter.serviceTypes.length > 0);

  const ghost = await (await apiRequest('/api/config/rooms/ghost-room/connectivity', { token })).json();
  assert.equal(ghost.hasServerRoom, false);

  const denied = await apiRequest(`/api/config/rooms/${ROOM}/connectivity/planning-center`, {
    method: 'PUT', body: { serviceTypes: [] }, token: operatorToken, stationToken: station.token,
  });
  assert.equal(denied.status, 403);

  const next = [{ id: '500005', name: 'Youth Service' }, { id: '424242', name: 'Youth Retreat' }];
  const saved = await apiRequest(`/api/config/rooms/${ROOM}/connectivity/planning-center`, {
    method: 'PUT', body: { serviceTypes: next }, token,
  });
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).planningCenter.serviceTypes, next);

  // Live effect: the checklist editor aggregates from the same room objects.
  const agg = await (await fetch(`${base}/api/checklist-templates`)).json();
  assert.ok(agg.serviceTypes.some((st) => st.name === 'Youth Retreat'));

  const bad = await apiRequest(`/api/config/rooms/${ROOM}/connectivity/planning-center`, {
    method: 'PUT', body: { serviceTypes: [{ id: 'not-numeric', name: 'X' }] }, token,
  });
  assert.equal(bad.status, 400);
});

test('analysis source: config.manage write, password never read back', async () => {
  const denied = await apiRequest(`/api/config/rooms/${ROOM}/connectivity/analysis`, {
    method: 'PUT', body: { analysis: null }, token: operatorToken, stationToken: station.token,
  });
  assert.equal(denied.status, 403);

  const { token } = await (await post('/api/auth/admin', { pin: 'admin1234' })).json();
  const saved = await apiRequest(`/api/config/rooms/${ROOM}/connectivity/analysis`, {
    method: 'PUT',
    body: { analysis: { source: 'smaart', host: '10.0.0.5', target: 90, limit: 95, password: 'hunter2' } },
    token,
  });
  assert.equal(saved.status, 200);
  const stored = (await saved.json()).analysis;
  assert.equal(stored.password, undefined);
  assert.equal(stored.hasPassword, true);

  // Public read is redacted the same way.
  const read = await (await apiRequest(`/api/config/rooms/${ROOM}/connectivity`, { token })).json();
  assert.equal(read.analysis.host, '10.0.0.5');
  assert.equal(read.analysis.password, undefined);
  assert.equal(read.analysis.hasPassword, true);

  // A later save without a password field keeps the stored one.
  const kept = await apiRequest(`/api/config/rooms/${ROOM}/connectivity/analysis`, {
    method: 'PUT', body: { analysis: { source: 'smaart', host: '10.0.0.6' } }, token,
  });
  assert.equal((await kept.json()).analysis.hasPassword, true);

  // Switching source drops the smaart-only password; clearing removes it all.
  const rta = await apiRequest(`/api/config/rooms/${ROOM}/connectivity/analysis`, {
    method: 'PUT', body: { analysis: { source: 'rta', host: '10.0.0.7', port: 8517 } }, token,
  });
  assert.equal((await rta.json()).analysis.hasPassword, false);

  const bad = await apiRequest(`/api/config/rooms/${ROOM}/connectivity/analysis`, {
    method: 'PUT', body: { analysis: { source: 'rta' } }, token,
  });
  assert.equal(bad.status, 400);

  const cleared = await apiRequest(`/api/config/rooms/${ROOM}/connectivity/analysis`, {
    method: 'PUT', body: { analysis: null }, token,
  });
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json()).analysis, null);
});

test('Companion connectivity: config.manage write, decomposes live, never clears', async () => {
  const denied = await apiRequest(`/api/config/rooms/${ROOM}/connectivity/companion`, {
    method: 'PUT', body: { companion: null }, token: operatorToken, stationToken: station.token,
  });
  assert.equal(denied.status, 403);

  const { token } = await (await post('/api/auth/admin', { pin: 'admin1234' })).json();
  const original = (await (await apiRequest(`/api/config/rooms/${ROOM}/connectivity`, { token })).json()).companion;
  assert.ok(original.modes.length >= 1);

  const saved = await apiRequest(`/api/config/rooms/${ROOM}/connectivity/companion`, {
    method: 'PUT',
    body: {
      companion: {
        mock: true,
        host: '10.0.0.20',
        variable: 'youthState',
        modes: [
          { id: 'service', label: 'Service', color: '#34c759', match: 'SERVICE', press: { page: 2, row: 0, column: 1 } },
          { id: 'standby', label: 'Standby', color: '#8b97a8', match: 'STANDBY', isStandby: true },
        ],
      },
    },
    token,
  });
  assert.equal(saved.status, 200);
  const stored = (await saved.json()).companion;
  assert.equal(stored.modes.length, 2);

  // The rooms listing reflects the new modes immediately.
  const listed = (await (await fetch(`${base}/api/rooms`)).json()).find((r) => r.id === ROOM);
  assert.deepEqual(listed.modes.map((m) => m.id), ['service', 'standby']);

  // Clearing is not a thing — a room always keeps its modes.
  const cleared = await apiRequest(`/api/config/rooms/${ROOM}/connectivity/companion`, {
    method: 'PUT', body: { companion: null }, token,
  });
  assert.equal(cleared.status, 400);

  // Restore the original so later tests see the seeded modes.
  const restored = await apiRequest(`/api/config/rooms/${ROOM}/connectivity/companion`, {
    method: 'PUT', body: { companion: original }, token,
  });
  assert.equal(restored.status, 200);
});

test('ProPresenter connectivity: config.manage write, public read, clear', async () => {
  const denied = await apiRequest(`/api/config/rooms/${ROOM}/connectivity/propresenter`, {
    method: 'PUT', body: { proPresenter: null }, token: operatorToken, stationToken: station.token,
  });
  assert.equal(denied.status, 403);

  const { token } = await (await post('/api/auth/admin', { pin: 'admin1234' })).json();
  const saved = await apiRequest(`/api/config/rooms/${ROOM}/connectivity/propresenter`, {
    method: 'PUT',
    body: { proPresenter: { host: '10.0.0.9', port: '62202', timer: 'Service Start' } },
    token,
  });
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).proPresenter, { host: '10.0.0.9', port: 62202, timer: 'Service Start' });

  const read = await (await apiRequest(`/api/config/rooms/${ROOM}/connectivity`, { token })).json();
  assert.deepEqual(read.proPresenter, { host: '10.0.0.9', port: 62202, timer: 'Service Start' });

  const bad = await apiRequest(`/api/config/rooms/${ROOM}/connectivity/propresenter`, {
    method: 'PUT', body: { proPresenter: { port: 62202 } }, token,
  });
  assert.equal(bad.status, 400);

  const cleared = await apiRequest(`/api/config/rooms/${ROOM}/connectivity/propresenter`, {
    method: 'PUT', body: { proPresenter: null }, token,
  });
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json()).proPresenter, null);
});

test('locked mode is blocked without override, allowed with it', async () => {
  const blocked = await post(`/api/rooms/${ROOM}/mode`, { mode: 'standby' }, operatorToken, station.token);
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).error, 'override_required');

  const wrong = await post(`/api/rooms/${ROOM}/mode`, { mode: 'standby', overridePin: '0000' }, operatorToken, station.token);
  assert.equal(wrong.status, 403);

  const ok = await post(`/api/rooms/${ROOM}/mode`, { mode: 'standby', overridePin: '9999' }, operatorToken, station.token);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).mode, 'standby');
});

test('unlocked mode needs no PIN', async () => {
  const res = await post(`/api/rooms/${ROOM}/mode`, { mode: 'sunday' }, operatorToken, station.token);
  assert.equal(res.status, 200);
});

test('anonymous stations remain read-only', async () => {
  const res = await post(`/api/rooms/${ROOM}/mode`, { mode: 'sunday' }, null, station.token);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'permission_required');
});

test('room state exposes protection info', async () => {
  const state = await (await fetch(`${base}/api/rooms/${ROOM}/state`)).json();
  assert.equal(state.protection.active, true);
  assert.equal(state.protection.enforced, true);
  assert.deepEqual(state.protection.lockedModes, ['standby']);
});

test('unknown room returns 404', async () => {
  assert.equal((await fetch(base + '/api/rooms/nope/state')).status, 404);
});

test('services overview lists configured rooms (mock)', async () => {
  const body = await (await fetch(base + '/api/services')).json();
  assert.equal(body.live, false); // no PC token in tests
  assert.ok(body.services.length > 0);
  assert.ok(body.services.every((s) => s.roomId && s.serviceType));
});

test("room service returns the next plan with an order of service", async () => {
  const body = await (await fetch(`${base}/api/rooms/north-main/service`)).json();
  assert.equal(body.configured, true);
  assert.ok(body.plans.length > 0);
  assert.ok(body.plans[0].items.length > 0); // items filled for the next plan
  assert.ok(body.plans[0].times.length > 0);
});

test('a caption source stores its pre-shared key without ever handing it back', async () => {
  // Same bargain as the Smaart password: this key is the credential to a
  // private comms transcript, so it goes in and never comes out.
  const { token } = await (await post('/api/auth/admin', { pin: 'admin1234' })).json();

  const saved = await apiRequest(`/api/config/rooms/${ROOM}/connectivity/captions`, {
    method: 'PUT',
    body: { captions: { source: 'prodcom', host: '10.0.0.9', port: 24480, key: 'psk-abc', channels: ['a', 'a', 'b'] } },
    token,
  });
  assert.equal(saved.status, 200);
  const stored = (await saved.json()).captions;
  assert.equal(stored.key, undefined);
  assert.equal(stored.hasKey, true);
  assert.deepEqual(stored.channels, ['a', 'b'], 'deduped, or one speaker appears twice');

  const read = await (await apiRequest(`/api/config/rooms/${ROOM}/connectivity`, { token })).json();
  assert.equal(read.captions.host, '10.0.0.9');
  assert.equal(read.captions.key, undefined);
  assert.equal(read.captions.hasKey, true);

  // The editor is never sent the key, so a save that omits it must KEEP it —
  // otherwise every unrelated edit silently disconnects the caption feed.
  const kept = await apiRequest(`/api/config/rooms/${ROOM}/connectivity/captions`, {
    method: 'PUT', body: { captions: { source: 'prodcom', host: '10.0.0.10' } }, token,
  });
  assert.equal((await kept.json()).captions.hasKey, true);

  // The other source has no key at all, and clearing removes the row.
  const pmc = await apiRequest(`/api/config/rooms/${ROOM}/connectivity/captions`, {
    method: 'PUT', body: { captions: { source: 'prodmesh-caption', host: '10.0.0.11' } }, token,
  });
  assert.equal((await pmc.json()).captions.hasKey, false);

  const cleared = await apiRequest(`/api/config/rooms/${ROOM}/connectivity/captions`, {
    method: 'PUT', body: { captions: null }, token,
  });
  assert.equal((await cleared.json()).captions, null);

  const bad = await apiRequest(`/api/config/rooms/${ROOM}/connectivity/captions`, {
    method: 'PUT', body: { captions: { source: 'nope', host: 'h' } }, token,
  });
  assert.equal(bad.status, 400);
});

test('a backup needs its own permission, and restore is refused once set up', async () => {
  // Downloading is not "manage campuses": the file carries the Planning Center
  // token, every PIN and every credential.
  const anon = await apiRequest('/api/system/backup');
  assert.equal(anon.status, 401);
  const body = await anon.json();
  assert.equal(body.permission, 'system.backup');

  // THE load-bearing rule. This endpoint has no permission check and cannot
  // have a useful one — it runs before any credential exists. What makes that
  // safe is that it stops working the moment there is something to protect:
  // on a configured box the same request would set the admin PIN and every
  // credential from an uploaded file, i.e. a one-request takeover.
  const restore = await apiRequest('/api/setup/restore', {
    method: 'POST',
    raw: Buffer.from('anything at all'),
  });
  assert.equal(restore.status, 409);
  assert.equal((await restore.json()).error, 'already_set_up');
});
