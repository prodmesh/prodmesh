// Service tokens (ADR 0013): who may mint them, what they may carry, what
// they can reach, how they are attributed, and how the token door throttles.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenOnLoopback } from './testServer.js';

process.env.PRODMESH_DATA_DIR = mkdtempSync(join(tmpdir(), 'prodmesh-tokens-'));

const { app } = await import('./index.js');
const settings = await import('./settings.js');
const auth = await import('./authStore.js');
const sm = await import('./showManager.js');

// north-youth: simulated Companion and a mock Planning Center plan, so a show
// can start and a mode can change with no hardware.
const ROOM = 'north-youth';
const PLAN = 'mock-500005-0';

settings.setPins({ admin: 'admin1234', override: '9999' });
const managers = auth.createGroup({ name: 'User Managers', permissions: ['users.manage'] });
auth.createUser({ username: 'manager', displayName: 'Manager', pin: '2468', groupIds: [managers.id] });
const station = auth.registerStation({ name: 'Token Test Station' });

let base;
let server;
let adminToken;
let managerToken;

before(async () => {
  ({ server, base } = await listenOnLoopback(app));
  adminToken = (await (await call('POST', '/api/auth/admin', { pin: 'admin1234' })).json()).token;
  managerToken = (await (await call('POST', '/api/auth/login', { username: 'manager', pin: '2468' }, null, station.token)).json()).token;
});
after(() => {
  if (sm.getState(ROOM).active) sm.endShow(ROOM);
  server.closeAllConnections?.();
  server.close();
});

function call(method, path, body, bearer = null, stationToken = null) {
  return fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...(stationToken ? { 'X-Prodmesh-Station': stationToken } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function mint(name, permissions) {
  const res = await call('POST', '/api/tokens', { name, permissions }, adminToken);
  assert.equal(res.status, 201, `mint ${name}: ${res.status}`);
  return res.json();
}

test('only a full administrator can mint, list or revoke tokens', async () => {
  assert.equal((await call('GET', '/api/tokens')).status, 401);
  assert.equal((await call('POST', '/api/tokens', { name: 'x', permissions: ['shows.operate'] })).status, 401);

  // users.manage is not enough: a token is a standing credential that never
  // sits at a keyboard.
  const denied = await call('POST', '/api/tokens', { name: 'x', permissions: ['shows.operate'] }, managerToken, station.token);
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error, 'admin_required');
  assert.equal((await call('GET', '/api/tokens', undefined, managerToken, station.token)).status, 403);

  const list = await (await call('GET', '/api/tokens', undefined, adminToken)).json();
  assert.deepEqual(list.grantable.map((p) => p.id).sort(), [...auth.TOKEN_PERMISSIONS].sort());
  assert.ok(list.grantable.every((p) => p.label), 'labels come with the grantable set');
});

test('a token may carry only the v1 write permissions, never anything sharp', async () => {
  for (const permissions of [['*'], ['system.backup'], ['system.update'], ['users.manage'], ['shows.operate', 'config.manage']]) {
    const res = await call('POST', '/api/tokens', { name: 'Too much', permissions }, adminToken);
    assert.equal(res.status, 400, `${permissions} should be refused`);
  }
  assert.equal((await call('POST', '/api/tokens', { name: 'Nothing', permissions: [] }, adminToken)).status, 400);
  assert.equal((await call('POST', '/api/tokens', { name: '  ', permissions: ['shows.operate'] }, adminToken)).status, 400);
});

test('the plaintext is shown once and never stored or listed', async () => {
  const { token, serviceToken } = await mint('Companion — Booth', ['shows.operate']);
  assert.match(token, /^pmt_[A-Za-z0-9_-]{43}$/);
  assert.equal(serviceToken.hint, token.slice(0, 8));
  assert.equal(serviceToken.createdBy, 'System Administrator');

  const listed = JSON.stringify(await (await call('GET', '/api/tokens', undefined, adminToken)).json());
  assert.ok(!listed.includes(token), 'the list must not carry the token');
  assert.ok(!listed.includes('token_hash'), 'nor its hash');
});

test('Companion can start and end a show with a token, and the audit names the token', async () => {
  const { token, serviceToken } = await mint('Companion — Stop button', ['shows.operate']);

  // The station header is ignored: a token replaces a station, it does not
  // carry one.
  const start = await call('POST', `/api/rooms/${ROOM}/show/start`, { planId: PLAN }, token, station.token);
  assert.equal(start.status, 200, await start.clone().text());
  assert.equal(sm.getState(ROOM).active, true);

  // The case that started this: "Stop Active Service in room" from a button
  // that knows nothing but a URL and a token. No body.
  const end = await call('POST', `/api/rooms/${ROOM}/show/end`, undefined, token);
  assert.equal(end.status, 200);
  assert.equal(sm.getState(ROOM).active, false);

  const rows = auth.listAudit(50).filter((r) => r.tokenName === serviceToken.name);
  assert.ok(rows.length >= 1, 'a token write is audited under the token');
  for (const row of rows) {
    assert.equal(row.userName, null, 'an app is not a person');
    assert.equal(row.stationName, null, 'and carries no station');
  }

  const after = (await (await call('GET', '/api/tokens', undefined, adminToken)).json())
    .tokens.find((t) => t.id === serviceToken.id);
  assert.ok(after.lastUsedAt, 'last use is recorded for the revoke decision');
});

test('a token is held to its permissions and to schedule lockouts', async () => {
  const { token: showsOnly } = await mint('Shows only', ['shows.operate']);
  const refused = await call('POST', `/api/rooms/${ROOM}/mode`, { mode: 'sunday' }, showsOnly);
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).permission, 'rooms.mode.change');

  // Nothing in Admin is reachable, whatever the token holds.
  assert.equal((await call('GET', '/api/system/backup', undefined, showsOnly)).status, 403);
  assert.equal((await call('GET', '/api/tokens', undefined, showsOnly)).status, 403);

  const { token: modes } = await mint('Mode buttons', ['rooms.mode.change']);
  assert.equal((await call('POST', `/api/rooms/${ROOM}/mode`, { mode: 'sunday' }, modes)).status, 200);
  settings.setSchedules({
    [ROOM]: [{ id: 'w', label: 'Always', days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59', lock: ['standby'] }],
  });
  try {
    const locked = await call('POST', `/api/rooms/${ROOM}/mode`, { mode: 'standby' }, modes);
    assert.equal(locked.status, 403);
    assert.equal((await locked.json()).error, 'override_required');
  } finally {
    settings.setSchedules({});
  }
});

test('logging out with a token does nothing to it', async () => {
  const { token } = await mint('Logout probe', ['shows.operate']);
  assert.equal((await call('POST', '/api/auth/logout', undefined, token)).status, 200);
  assert.equal((await call('GET', '/api/rooms', undefined, token)).status, 200);
});

test('a revoked token is refused outright, even where anonymous may read', async () => {
  const { token, serviceToken } = await mint('Soon revoked', ['shows.operate']);
  assert.equal((await call('GET', '/api/rooms', undefined, token)).status, 200);

  const revoked = await call('DELETE', `/api/tokens/${serviceToken.id}`, undefined, adminToken);
  assert.equal(revoked.status, 200);
  assert.ok((await revoked.json()).serviceToken.revokedAt);

  const res = await call('GET', '/api/rooms', undefined, token);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'invalid_token');
  assert.equal((await call('DELETE', '/api/tokens/no-such-token', undefined, adminToken)).status, 404);
});

// Last on purpose: it locks 127.0.0.1's token counter, and every request in
// this file comes from there.
test('wrong tokens lock the source out; stale session bearers never do', async () => {
  // A browser holding an expired session sends it on every poll. That must
  // never count as guessing, or a booth would lock itself out.
  for (let i = 0; i < 30; i++) {
    assert.equal((await call('GET', '/api/rooms', undefined, 'a'.repeat(64))).status, 200);
  }

  const { token: good } = await mint('Survives the lock?', ['shows.operate']);
  // The revoked-token test above already spent one failure from this address,
  // so count to the lock rather than assume where it falls: it must come
  // within ten wrong tokens, and every refusal before it is a 401.
  let attempts = 0;
  for (let status = 401; status === 401; attempts++) {
    status = (await call('GET', '/api/rooms', undefined, `pmt_wrong${attempts}`)).status;
    assert.ok(status === 401 || status === 429, `unexpected ${status}`);
    assert.ok(attempts < 11, 'ten wrong tokens never locked the source');
  }
  const locked = await call('GET', '/api/rooms', undefined, good);
  assert.equal(locked.status, 429, 'the lock holds even for a valid token from the same source');
  assert.equal((await locked.json()).error, 'temporarily_locked');

  // Browsers on the same address, with no token, are unaffected.
  assert.equal((await call('GET', '/api/rooms')).status, 200);
});
