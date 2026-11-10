// The v1 control surface end to end, as an integrator drives it: a token, a
// room id, and nothing else.
//
// PRODMESH_AUTOSTART_TEST makes "the current service" ignore the arm window,
// so a start with no planId works on a Tuesday. It is set before import
// because showManager reads it once, which is why this is its own file —
// apiV1.test.js tests the window itself and needs it unset.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenOnLoopback } from './testServer.js';

process.env.PRODMESH_DATA_DIR = mkdtempSync(join(tmpdir(), 'prodmesh-apiv1w-'));
process.env.PRODMESH_AUTOSTART_TEST = '1';

const { app } = await import('./index.js');
const auth = await import('./authStore.js');
const sm = await import('./showManager.js');
const chkTemplates = await import('./checklistTemplates.js');

const ROOM = 'north-youth';

let base;
let server;
before(async () => { ({ server, base } = await listenOnLoopback(app)); });
after(() => {
  if (sm.getState(ROOM).active) sm.endShow(ROOM);
  server.closeAllConnections?.();
  server.close();
});

const { token } = auth.createServiceToken({
  name: 'Companion — Booth',
  permissions: ['shows.operate', 'rooms.mode.change', 'checklists.complete'],
});
// What Companion's Generic HTTP sends for a button with no body: the header,
// and nothing else — not even a Content-Type.
const press = (path) => fetch(`${base}/api/v1${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
const send = (path, body) => fetch(`${base}/api/v1${path}`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('Start and End buttons that know only the room', async () => {
  const start = await press(`/rooms/${ROOM}/show/start`);
  assert.equal(start.status, 200, await start.clone().text());
  const state = sm.getState(ROOM);
  assert.equal(state.active, true);
  assert.match(state.planId, /^mock-/, 'the current plan was found, not invented');
  assert.match(state.timeId, /^svc-/, 'and a service time, never the rehearsal');

  // Pressing Start twice is refused, not a second show.
  assert.equal((await press(`/rooms/${ROOM}/show/start`)).status, 409);

  const end = await press(`/rooms/${ROOM}/show/end`);
  assert.equal(end.status, 200);
  assert.equal(sm.getState(ROOM).active, false);
  // And End with nothing running says so.
  assert.equal((await press(`/rooms/${ROOM}/show/end`)).status, 409);

  const started = auth.listAudit(20).find((r) => r.tokenName === 'Companion — Booth' && r.details?.operation === 'start');
  assert.equal(started?.details.resolved, true, 'the audit says the plan was chosen for the caller');
});

test('naming a plan still works, and an explicit time wins over the resolved one', async () => {
  const plan = (await (await fetch(`${base}/api/v1/rooms/${ROOM}/service`)).json()).plans[0].id;
  assert.equal((await send(`/rooms/${ROOM}/show/start`, { planId: plan, timeId: 'svc-2' })).status, 200);
  assert.equal(sm.getState(ROOM).timeId, 'svc-2');
  assert.equal((await press(`/rooms/${ROOM}/show/end`)).status, 200);
  assert.equal((await send(`/rooms/${ROOM}/show/start`, { planId: '../../etc' })).status, 400);
});

test('mode, jump-to-item and checklist writes through v1', async () => {
  assert.equal((await send(`/rooms/${ROOM}/mode`, { mode: 'sunday' })).status, 200);
  const state = await (await fetch(`${base}/api/v1/rooms/${ROOM}/state`)).json();
  assert.equal(state.mode, 'sunday');

  assert.equal((await press(`/rooms/${ROOM}/show/start`)).status, 200);
  try {
    assert.equal((await send(`/rooms/${ROOM}/show/current`, { follow: true })).status, 200);
  } finally {
    await press(`/rooms/${ROOM}/show/end`);
  }

  const service = await (await fetch(`${base}/api/v1/rooms/${ROOM}/service`)).json();
  const plan = service.plans[0];
  chkTemplates.setTemplate(plan.serviceTypeId, [{ id: 'mics', label: 'Mics checked' }]);
  const tick = await send(`/rooms/${ROOM}/event/${plan.id}/checklist/mics`, { done: true });
  assert.equal(tick.status, 200);
  assert.equal((await tick.json()).checklist.find((i) => i.id === 'mics').done, true);
});
