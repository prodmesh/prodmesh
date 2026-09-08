// Rooms are built from SQLite topology (roomsStore.js): a room created in
// Admin → Campuses is a real server room — endpoints, connectivity, watchers —
// with no rooms.config.js entry. This exercises the full lifecycle over HTTP.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PRODMESH_DATA_DIR = mkdtempSync(join(tmpdir(), 'prodmesh-roomsdb-'));
const { app } = await import('./index.js');
const settings = await import('./settings.js');
const auth = await import('./authStore.js');

settings.setPins({ admin: 'admin1234' });
const group = auth.createGroup({ name: 'Mode Operators', permissions: ['rooms.mode.change'] });
auth.createUser({ username: 'operator', displayName: 'Operator', pin: '2468', groupIds: [group.id] });
const station = auth.registerStation({ name: 'Rooms Test Station' });

const CHAPEL = 'north-prayer';

let base;
let server;
let adminToken;
let operatorToken;
before(async () => {
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  adminToken = (await (await post('/api/auth/admin', { pin: 'admin1234' })).json()).token;
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

function put(path, body, token) {
  return fetch(base + path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

const getRooms = async () => (await fetch(`${base}/api/rooms`)).json();
// The connectivity read is gated behind config.manage (it returns device
// addresses), so this carries the admin token like the writes do.
const getConn = async (id) =>
  (await fetch(`${base}/api/config/rooms/${id}/connectivity`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  })).json();
const getChurch = async () => (await fetch(`${base}/api/config`)).json();

// Fetch the tree, apply an edit to the north site, and save it back.
async function editTopology(fn) {
  const church = await getChurch();
  const site = church.sites.find((s) => s.id === 'north');
  fn(site, church);
  const saved = await put('/api/config', church, adminToken);
  assert.equal(saved.status, 200);
}

test('the seeded topology produces the same server rooms as before', async () => {
  const ids = (await getRooms()).map((r) => r.id);
  for (const id of ['north-main', 'north-youth', 'north-chapel']) assert.ok(ids.includes(id));
  assert.equal((await getConn('north-main')).hasServerRoom, true);
});

test('a room created in Admin → Campuses is a live server room', async () => {
  await editTopology((site) => {
    site.auditoriums.push({ id: CHAPEL, name: 'North Campus · Prayer Room', tiles: [] });
  });

  // New rooms start simulated without Room Mode. An administrator enables it
  // and adds only the controls this room actually needs.
  const listed = (await getRooms()).find((r) => r.id === CHAPEL);
  assert.ok(listed, 'chapel should be listed');
  assert.deepEqual(listed.modes, []);
  assert.equal(listed.roomModeEnabled, false);
  assert.equal(listed.hasCompanion, false); // simulated

  // The room configuration page opens with the same optional Room Mode state.
  const conn = await getConn(CHAPEL);
  assert.equal(conn.hasServerRoom, true);
  assert.equal(conn.companion.mock, true);
  assert.equal(conn.companion.roomMode, false);
  assert.deepEqual(conn.companion.modes, []);
  assert.deepEqual(conn.planningCenter, { serviceTypes: [] });

  // A disabled Room Mode cannot be changed through its old endpoint.
  const mode = await post(`/api/rooms/${CHAPEL}/mode`, { mode: 'sunday' }, operatorToken, station.token);
  assert.equal(mode.status, 409);

  // Enabling it and adding controls makes the room mode-capable.
  const saved = await put(`/api/config/rooms/${CHAPEL}/connectivity/companion`, {
    companion: {
      mock: true,
      roomMode: true,
      modes: [
        { id: 'service', label: 'Service', color: '#34c759', match: 'SERVICE' },
        { id: 'standby', label: 'Standby', color: '#8b97a8', match: 'STANDBY', isStandby: true },
      ],
    },
  }, adminToken);
  assert.equal(saved.status, 200);
  const relisted = (await getRooms()).find((r) => r.id === CHAPEL);
  assert.equal(relisted.roomModeEnabled, true);
  assert.deepEqual(relisted.modes.map((m) => m.id), ['service', 'standby']);

  const enabledMode = await post(`/api/rooms/${CHAPEL}/mode`, { mode: 'service' }, operatorToken, station.token);
  assert.equal(enabledMode.status, 200);
  assert.equal((await enabledMode.json()).mode, 'service');
});

test('renaming a room updates the live map in place', async () => {
  await editTopology((site) => {
    site.auditoriums.find((a) => a.id === CHAPEL).name = 'North Campus · Prayer Room, renamed';
  });
  const listed = (await getRooms()).find((r) => r.id === CHAPEL);
  assert.equal(listed.name, 'North Campus · Prayer Room, renamed');
  // Stored connectivity survives a rename.
  assert.deepEqual((await getConn(CHAPEL)).companion.modes.map((m) => m.id), ['service', 'standby']);
});

test('deleting a room removes it from the server; re-adding restores its config', async () => {
  await editTopology((site) => {
    site.auditoriums = site.auditoriums.filter((a) => a.id !== CHAPEL);
  });
  assert.ok(!(await getRooms()).some((r) => r.id === CHAPEL));
  assert.equal((await getConn(CHAPEL)).hasServerRoom, false);
  const mode = await post(`/api/rooms/${CHAPEL}/mode`, { mode: 'service' }, operatorToken, station.token);
  assert.equal(mode.status, 404);
  assert.equal((await fetch(`${base}/api/rooms/${CHAPEL}/state`)).status, 404);

  // Connectivity rows are kept, so re-creating the same id brings it back.
  await editTopology((site) => {
    site.auditoriums.push({ id: CHAPEL, name: 'North Campus · Prayer Room', tiles: [] });
  });
  const back = (await getRooms()).find((r) => r.id === CHAPEL);
  assert.deepEqual(back.modes.map((m) => m.id), ['service', 'standby']);
});
