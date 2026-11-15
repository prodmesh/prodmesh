// The alert routes: seeing open alerts needs nothing and leaks no address;
// acknowledging needs alerts.acknowledge and is audited; the signal log, which
// does carry addresses, needs system.logs. Mode changes made here are signals.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenOnLoopback } from './testServer.js';

process.env.PRODMESH_DATA_DIR = mkdtempSync(join(tmpdir(), 'prodmesh-alerts-api-'));
const { app } = await import('./index.js');
const auth = await import('./authStore.js');
const alerts = await import('./alerts.js');
const signals = await import('./signals.js');
const rules = await import('./rules.js');

const ackGroup = auth.createGroup({ name: 'On call', permissions: ['alerts.acknowledge', 'rooms.mode.change'] });
const logsGroup = auth.createGroup({ name: 'Log readers', permissions: ['system.logs'] });
auth.createUser({ username: 'oncall', displayName: 'On Call', pin: '2468', groupIds: [ackGroup.id] });
auth.createUser({ username: 'reader', displayName: 'Reader', pin: '3579', groupIds: [logsGroup.id] });
const station = auth.registerStation({ name: 'Alerts Test Station' });

let base;
let server;
let oncall;
let reader;
let alertId;

const req = (method, path, token, body) =>
  fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Prodmesh-Station': station.token,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

before(async () => {
  ({ server, base } = await listenOnLoopback(app));
  const login = async (username, pin) => (await (await req('POST', '/api/auth/login', null, { username, pin })).json()).token;
  oncall = await login('oncall', '2468');
  reader = await login('reader', '3579');
  const rule = rules.BUILT_IN_RULES[0];
  const a = alerts.raise(rule, rule.actions[0], {
    kind: 'integration.down',
    subject: 'proPresenter@192.0.2.15:1025',
    summary: 'Main Auditorium · ProPresenter is unreachable',
    data: { roomIds: ['north-main'], scope: 'room', error: 'ECONNREFUSED 192.0.2.15:1025' },
  }, { live: () => false });
  alertId = a.id;
  signals.emit({ kind: 'integration.down', source: 'health', subject: 'proPresenter@192.0.2.15:1025', data: { error: 'ECONNREFUSED 192.0.2.15:1025' } });
  signals.flushNow();
});
after(() => server.close());

test('anyone can see open alerts, and what they see carries no address', async () => {
  const res = await fetch(`${base}/api/alerts`);
  assert.equal(res.status, 200);
  const { open } = await res.json();
  assert.equal(open.length, 1);
  assert.equal(open[0].title, 'Main Auditorium · ProPresenter is unreachable');
  assert.deepEqual(open[0].roomIds, ['north-main']);
  assert.doesNotMatch(JSON.stringify(open), /192\.0\.2|subject|slack|dedupe/);
});

test('acknowledging needs alerts.acknowledge, names the person, and is audited', async () => {
  assert.equal((await req('POST', `/api/alerts/${alertId}/acknowledge`, null)).status, 401);
  assert.equal((await req('POST', `/api/alerts/${alertId}/acknowledge`, reader)).status, 403);

  const res = await req('POST', `/api/alerts/${alertId}/acknowledge`, oncall);
  assert.equal(res.status, 200);
  const { alert } = await res.json();
  assert.equal(alert.state, 'acknowledged');
  assert.equal(alert.ackedBy, 'On Call');

  const audit = auth.listAudit(20).find((r) => r.action === 'alerts.acknowledge' && r.result === 'allowed');
  assert.ok(audit, 'an acknowledgement is a claim somebody is handling it, so it is on the record');
  assert.equal((await req('POST', '/api/alerts/99999/acknowledge', oncall)).status, 404);
});

test('the signal log and alert history need system.logs', async () => {
  assert.equal((await req('GET', '/api/signals', null)).status, 401);
  assert.equal((await req('GET', '/api/signals', oncall)).status, 403);
  const res = await req('GET', '/api/signals?kind=integration.', reader);
  assert.equal(res.status, 200);
  const { signals: list } = await res.json();
  assert.ok(list.some((s) => s.kind === 'integration.down' && s.data.error.includes('192.0.2.15')));
  assert.equal((await req('GET', '/api/alerts/history', reader)).status, 200);
  assert.equal((await req('GET', '/api/alerts/history', oncall)).status, 403);
});

test('a mode change made here is one signal, naming who made it', async () => {
  // north-youth is a mock room: the press lands without a network call.
  const res = await req('POST', '/api/rooms/north-youth/mode', oncall, { mode: 'sunday' });
  assert.equal(res.status, 200, await res.clone().text());
  signals.flushNow();
  const [changed] = signals.list({ kind: 'room.mode.changed', roomId: 'north-youth' });
  assert.ok(changed);
  assert.equal(changed.data.mode, 'sunday');
  assert.equal(changed.data.by, 'On Call');
});

test('Admin → Monitoring needs settings.manage and shows rules as data', async () => {
  assert.equal((await req('GET', '/api/monitoring', oncall)).status, 403);
  const admin = auth.createGroup({ name: 'Settings', permissions: ['settings.manage'] });
  auth.createUser({ username: 'settler', displayName: 'Settler', pin: '5791', groupIds: [admin.id] });
  const token = (await (await req('POST', '/api/auth/login', null, { username: 'settler', pin: '5791' })).json()).token;
  const res = await req('GET', '/api/monitoring', token);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.rules[0].id, 'integration-unreachable');
  assert.ok(body.rooms.some((r) => r.id === 'north-main'));
  assert.equal(body.slack.configured, false);
  assert.equal((await req('POST', '/api/monitoring/test', token)).status, 409, 'nothing to test without Slack');
});
