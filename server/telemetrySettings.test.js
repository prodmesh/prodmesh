// Telemetry consent (ADR 0022): off by default, changed only by config.manage,
// and PRODMESH_TELEMETRY=off overrides whatever Admin says. Its own file
// because the environment variable is read live and this file toggles it.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenOnLoopback } from './testServer.js';

process.env.PRODMESH_DATA_DIR = mkdtempSync(join(tmpdir(), 'prodmesh-telemetry-'));
delete process.env.PRODMESH_TELEMETRY;
const { app } = await import('./index.js');
const settings = await import('./settings.js');

let base;
let server;
let token;
before(async () => {
  ({ server, base } = await listenOnLoopback(app));
  settings.setPins({ admin: 'admin1234' });
  ({ token } = await (await fetch(`${base}/api/auth/admin`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: 'admin1234' }),
  })).json());
});
after(() => server?.close());

const call = (method, body, auth = token) => fetch(`${base}/api/system/telemetry`, {
  method,
  headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

test('off by default, and nobody has decided yet', () => {
  assert.deepEqual(settings.getTelemetrySettings(), { enabled: false, decidedAt: null, lockedOff: false });
});

test('reading and changing it needs config.manage', async () => {
  assert.equal((await call('GET', undefined, null)).status, 401);
  assert.equal((await call('PUT', { enabled: true }, null)).status, 401);
  assert.equal(settings.getTelemetrySettings().enabled, false);
});

test('an admin turns it on and off; the choice is dated', async () => {
  const on = await call('PUT', { enabled: true });
  assert.equal(on.status, 200);
  const body = await on.json();
  assert.equal(body.enabled, true);
  assert.equal(typeof body.decidedAt, 'number');
  assert.ok('lifecycle' in body);

  const off = await (await call('PUT', { enabled: false })).json();
  assert.equal(off.enabled, false);
  assert.notEqual(off.decidedAt, null, 'turning it off is also a decision');
});

test('only a boolean is accepted', async () => {
  assert.equal((await call('PUT', { enabled: 'yes' })).status, 400);
  assert.equal((await call('PUT', {})).status, 400);
});

test('PRODMESH_TELEMETRY=off wins over Admin, and cannot be argued with', async () => {
  settings.setTelemetryEnabled(true);
  process.env.PRODMESH_TELEMETRY = 'off';
  try {
    const got = await (await call('GET')).json();
    assert.equal(got.enabled, false);
    assert.equal(got.lockedOff, true);
    assert.equal((await call('PUT', { enabled: true })).status, 400);
  } finally {
    delete process.env.PRODMESH_TELEMETRY;
  }
});

test('the environment cannot turn it on', () => {
  settings.setTelemetryEnabled(false);
  process.env.PRODMESH_TELEMETRY = 'on';
  try {
    assert.equal(settings.getTelemetrySettings().enabled, false);
  } finally {
    delete process.env.PRODMESH_TELEMETRY;
  }
});

test('the preview is the real report, valid, and needs config.manage', async () => {
  const preview = (auth) => fetch(`${base}/api/system/telemetry/preview`, { headers: auth ? { Authorization: `Bearer ${auth}` } : {} });
  assert.equal((await preview(null)).status, 401);
  const body = await (await preview(token)).json();
  assert.equal(body.report.schema, 'prodmesh-telemetry/1');
  assert.deepEqual(body.problems, []);
});

test('resetting the id needs config.manage and changes what the next report carries', async () => {
  const before = (await (await fetch(`${base}/api/system/telemetry/preview`, { headers: { Authorization: `Bearer ${token}` } })).json()).report.telemetryId;
  const reset = (auth) => fetch(`${base}/api/system/telemetry/reset-id`, { method: 'POST', headers: auth ? { Authorization: `Bearer ${auth}` } : {} });
  assert.equal((await reset(null)).status, 401);
  assert.equal((await reset(token)).status, 200);
  const after = (await (await fetch(`${base}/api/system/telemetry/preview`, { headers: { Authorization: `Bearer ${token}` } })).json()).report.telemetryId;
  assert.notEqual(after, before);
});
