// Companion-down HTTP branches, against the real Express app.
//
// This file used to also test GET /api/rooms/:id/show/stream. That route was
// removed in 1.5 (ADR 0013); its contract (state on connect, push on start,
// unknown rooms ignored, release on disconnect) is the topic stream's, and
// streamApi.test.js covers it there.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenOnLoopback } from './testServer.js';

process.env.PRODMESH_DATA_DIR = mkdtempSync(join(tmpdir(), 'prodmesh-stream-'));
const { app } = await import('./index.js');
const conn = await import('./connectivity.js');
const settings = await import('./settings.js');

// north-youth: the simulated-Companion room, so it can be pointed at a dead port.
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

test('Companion down: mode change → 502, state read → 200, mode unknown + error', async () => {
  // A port that is guaranteed dead: bind, read it, close.
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const deadPort = probe.address().port;
  await new Promise((r) => probe.close(r));

  // Make the mock room live, pointed at the dead port (validateCompanion
  // requires host+variable when mock:false).
  const original = conn.getCompanion(ROOM);
  assert.equal(original.mock, true); // north-youth is the simulated room
  conn.setCompanion(ROOM, { ...original, mock: false, host: '127.0.0.1', port: deadPort });
  try {
    // GET state degrades gracefully: 200, error surfaced — and the mode is
    // unknown, not a guess from simulated state (#54).
    const stateRes = await fetch(`${base}/api/rooms/${ROOM}/state`);
    assert.equal(stateRes.status, 200);
    const state = await stateRes.json();
    assert.equal(state.source, 'companion');
    assert.equal(state.online, false);
    assert.ok(state.error, 'the Companion failure must be surfaced');
    assert.equal(state.mode, null);

    // POST mode: the button press fails → 502 with the failure in the body.
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
    assert.equal(modeRes.status, 502);
    const body = await modeRes.json();
    assert.equal(body.ok, false);
    assert.equal(body.mode, 'sunday');
    assert.equal(body.online, false);
    assert.ok(body.error);
  } finally {
    conn.setCompanion(ROOM, original); // back to simulated
  }
  assert.equal((await (await fetch(`${base}/api/rooms/${ROOM}/state`)).json()).source, 'mock');
});
