// Who may read setup state, and who may end setup.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenOnLoopback } from './testServer.js';

process.env.PRODMESH_DATA_DIR = mkdtempSync(join(tmpdir(), 'prodmesh-setupapi-'));
process.env.PRODMESH_SEED = 'empty';

const { app } = await import('./index.js');
const auth = await import('./authStore.js');

const group = auth.createGroup({ name: 'Settings People', permissions: ['settings.manage', 'config.manage'] });
auth.createUser({ username: 'lead', displayName: 'Tech Lead', pin: '2468', groupIds: [group.id] });
const station = auth.registerStation({ name: 'Setup Test Station' });

let base;
let server;
let adminToken;
let leadToken;

before(async () => {
  ({ server, base } = await listenOnLoopback(app));
  // The wizard's own path: bootstrap the admin PIN, then sign in with it.
  await post('/api/settings/pins', { admin: 'admin1234' });
  adminToken = (await (await post('/api/auth/admin', { pin: 'admin1234' })).json()).token;
  leadToken = (await (await post('/api/auth/login', { username: 'lead', pin: '2468' }, null, station.token)).json()).token;
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
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('setup state is readable before anyone can possibly be signed in', async () => {
  // The browser has to decide whether to render the wizard on a box where no
  // credential exists yet. Nothing here is new: /api/auth/status already
  // reports setupNeeded and /api/config already lists the campuses.
  const res = await fetch(`${base}/api/setup`);
  assert.equal(res.status, 200);
  const state = await res.json();
  assert.equal(state.needed, true);
  assert.equal(state.adminPinSet, true); // set in before()
  assert.equal(state.hasCampus, false);
  assert.deepEqual(Object.keys(state).sort(), ['adminPinSet', 'completedAt', 'hasCampus', 'needed']);
});

test('ending setup is admin-only', async () => {
  assert.equal((await post('/api/setup/complete', undefined)).status, 401);

  // Not even a config.manage/settings.manage lead: dismissing setup is a
  // one-way door for the whole install, so it sits behind '*' like secrets.
  const denied = await post('/api/setup/complete', undefined, leadToken, station.token);
  assert.equal(denied.status, 403);
  assert.equal((await (await fetch(`${base}/api/setup`)).json()).needed, true, 'refusals changed nothing');

  const done = await post('/api/setup/complete', undefined, adminToken);
  assert.equal(done.status, 200);
  assert.equal((await done.json()).needed, false);
  assert.equal((await (await fetch(`${base}/api/setup`)).json()).needed, false);
});
