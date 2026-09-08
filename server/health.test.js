// The integration-health registry: unit semantics (transition logging, snapshot
// shape, recovery), the public GET /api/system/health surface against the real
// Express app, and the transport wiring via real integration failures (a dead
// Companion host, the fake ProPresenter server).

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenOnLoopback } from './testServer.js';

process.env.PRODMESH_DATA_DIR = mkdtempSync(join(tmpdir(), 'prodmesh-health-'));
const { app } = await import('./index.js');
const conn = await import('./connectivity.js');
const settings = await import('./settings.js');
const health = await import('./health.js');
const { readActive } = await import('./integrations/proPresenter.js');
const { fakeProPresenter } = await import('./integrations/fakeProPresenter.js');

// north-youth is the simulated room — flipped live (mock:false) to exercise
// the Companion-down path, exactly like showStream.test.js does.
const ROOM = 'north-youth';
settings.setPins({ admin: 'admin1234', override: '9999' });

let server;
let base;
before(async () => {
  ({ server, base } = await listenOnLoopback(app));
});
after(() => {
  server.closeAllConnections?.();
  server.close();
});

// ── Registry unit semantics ──────────────────────────────────────────────────

test('report logs ONE line on the ok→fail transition, none on repeat failures', (t) => {
  health.reset();
  const errors = t.mock.method(console, 'error', () => {});
  health.report('planningCenter', false, 'Planning Center /plans → HTTP 401');
  health.report('planningCenter', false, 'Planning Center /plans → HTTP 401');
  health.report('planningCenter', false, 'timeout');
  assert.equal(errors.mock.callCount(), 1); // one line per outage, not per retry
  assert.equal(errors.mock.calls[0].arguments[0], '[health] planningCenter: Planning Center /plans → HTTP 401');

  const s = health.snapshot().planningCenter;
  assert.equal(s.ok, false);
  assert.equal(s.consecutiveFailures, 3);
  assert.equal(s.lastSuccess, null);
  assert.equal(s.lastError.message, 'timeout'); // latest error wins
  assert.ok(Number.isFinite(s.lastError.ts));
});

test('recovery after failures logs one line and resets the count, keeping outage history', (t) => {
  health.reset();
  t.mock.method(console, 'error', () => {});
  const logs = t.mock.method(console, 'log', () => {});
  health.report('companion@10.0.0.20:8000', false, 'fetch failed');
  health.report('companion@10.0.0.20:8000', false, 'fetch failed');
  health.report('companion@10.0.0.20:8000', true);
  health.report('companion@10.0.0.20:8000', true); // steady state stays silent
  assert.equal(logs.mock.callCount(), 1);
  assert.match(logs.mock.calls[0].arguments[0], /^\[health\] companion@10\.0\.0\.20:8000: recovered after 2 failures$/);

  const s = health.snapshot()['companion@10.0.0.20:8000'];
  assert.equal(s.ok, true);
  assert.equal(s.consecutiveFailures, 0);
  assert.ok(Number.isFinite(s.lastSuccess));
  assert.equal(s.lastError.message, 'fetch failed'); // lastError kept as history
});

test('success-only reporting never logs; keys are independent', (t) => {
  health.reset();
  const errors = t.mock.method(console, 'error', () => {});
  const logs = t.mock.method(console, 'log', () => {});
  health.report('proPresenter@10.0.0.9:62202', true);
  health.report('analysis@10.0.0.5:26000', false, 'no answering Smaart API');
  assert.equal(errors.mock.callCount(), 1); // only the analysis outage
  assert.equal(logs.mock.callCount(), 0);

  const snap = health.snapshot();
  assert.equal(snap['proPresenter@10.0.0.9:62202'].ok, true);
  assert.equal(snap['proPresenter@10.0.0.9:62202'].lastError, null);
  assert.equal(snap['analysis@10.0.0.5:26000'].ok, false);
});

// ── The HTTP surface + Companion wiring ──────────────────────────────────────

test('GET /api/system/health: starts empty, shows a dead Companion after a failed press', async () => {
  health.reset();
  const initial = await (await fetch(`${base}/api/system/health`)).json();
  assert.ok(Number.isFinite(initial.now));
  assert.deepEqual(initial.integrations, {});

  // A port that is guaranteed dead: bind, read it, close.
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const deadPort = probe.address().port;
  await new Promise((r) => probe.close(r));

  const original = conn.getCompanion(ROOM);
  assert.equal(original.mock, true);
  conn.setCompanion(ROOM, { ...original, mock: false, host: '127.0.0.1', port: deadPort });
  try {
    const { token } = await (
      await fetch(`${base}/api/auth/admin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: 'admin1234' }),
      })
    ).json();
    const modeRes = await fetch(`${base}/api/rooms/${ROOM}/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ mode: 'sunday' }),
    });
    assert.equal(modeRes.status, 502); // the press failed…

    // …and the failure is visible to an authorized reader, keyed by host.
    const body = await (await fetch(`${base}/api/system/health`, {
      headers: { Authorization: `Bearer ${token}` },
    })).json();
    assert.equal(body.redacted, false);
    const entry = body.integrations[`companion@127.0.0.1:${deadPort}`];
    assert.ok(entry, `expected companion@127.0.0.1:${deadPort} in ${JSON.stringify(Object.keys(body.integrations))}`);
    assert.equal(entry.ok, false);
    assert.ok(entry.consecutiveFailures >= 1);
    assert.equal(entry.lastSuccess, null);
    assert.ok(entry.lastError.message);

    // Anonymous callers still get the diagnosis — is Companion up? — but not
    // the address book. Keys carry no host:port and errors carry no text,
    // since a failed fetch can echo a prefix of the device's response body.
    const open = await (await fetch(`${base}/api/system/health`)).json();
    assert.equal(open.redacted, true);
    assert.ok(open.integrations.companion, 'integration is still named');
    assert.equal(open.integrations.companion.ok, false, 'and still reports the outage');
    assert.equal(open.integrations[`companion@127.0.0.1:${deadPort}`], undefined);
    assert.equal(open.integrations.companion.lastError.message, undefined);
    assert.ok(open.integrations.companion.lastError.ts > 0, 'when, but not what');
    for (const key of Object.keys(open.integrations)) {
      assert.ok(!key.includes('@'), `key ${key} still carries an address`);
    }
  } finally {
    conn.setCompanion(ROOM, original); // back to simulated
  }
});

// ── ProPresenter wiring (via the fake PP server) ─────────────────────────────

test('proPresenter health: per-host success, failures count up, recovery flips ok back', async (t) => {
  t.mock.method(console, 'error', () => {}); // the outage line is expected noise here
  const srv = await fakeProPresenter();
  const pp = { host: '127.0.0.1', port: srv.port() };
  const key = `proPresenter@127.0.0.1:${srv.port()}`;
  try {
    health.reset();
    srv.setActive(1, 'Welcome');
    await readActive(pp);
    let s = health.snapshot()[key];
    assert.equal(s.ok, true);
    assert.ok(Number.isFinite(s.lastSuccess));

    srv.failNextRequests(Infinity); // PP is now persistently broken
    await assert.rejects(readActive(pp), /ProPresenter 500/);
    await assert.rejects(readActive(pp), /ProPresenter 500/);
    s = health.snapshot()[key];
    assert.equal(s.ok, false);
    assert.equal(s.consecutiveFailures, 2);
    assert.match(s.lastError.message, /ProPresenter 500/);

    srv.failNextRequests(0); // PP comes back
    await readActive(pp);
    s = health.snapshot()[key];
    assert.equal(s.ok, true);
    assert.equal(s.consecutiveFailures, 0);
  } finally {
    await srv.close();
  }
});

test('a caller abort is not a ProPresenter failure', async () => {
  const srv = await fakeProPresenter();
  const key = `proPresenter@127.0.0.1:${srv.port()}`;
  try {
    health.reset();
    const ctl = new AbortController();
    ctl.abort(); // show ended / view closed
    await assert.rejects(readActive({ host: '127.0.0.1', port: srv.port() }, ctl.signal));
    assert.equal(health.snapshot()[key], undefined); // nothing reported
  } finally {
    await srv.close();
  }
});

// ── Boot declarations (every configured integration appears immediately) ─────

test('declareConfiguredIntegrations lists configured-but-uncontacted integrations as ok:null', async () => {
  health.reset();
  const { declareConfiguredIntegrations } = await import('./healthBootstrap.js');
  declareConfiguredIntegrations();
  const snap = health.snapshot();

  // Seeded rooms carry real ProPresenter/Companion/analysis hosts — they must
  // all be present before anything has talked to them.
  const kinds = Object.keys(snap).map((k) => k.split('@')[0]);
  assert.ok(kinds.includes('proPresenter'), 'ProPresenter declared');
  assert.ok(kinds.includes('companion'), 'Companion declared');
  assert.ok(kinds.includes('analysis'), 'analysis (Smaart/RTA) declared');
  for (const [key, e] of Object.entries(snap)) {
    assert.equal(e.ok, null, `${key} is declared but uncontacted`);
    assert.equal(e.lastSuccess, null);
    assert.equal(e.lastError, null);
  }

  // A report on a declared key flips it to a real status.
  const anyKey = Object.keys(snap)[0];
  health.report(anyKey, true);
  assert.equal(health.snapshot()[anyKey].ok, true);
  health.reset();
});
