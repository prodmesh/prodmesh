// The SSE show-state stream contract (GET /api/rooms/:id/show/stream) plus the
// Companion-down HTTP branches, against the real Express app.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenOnLoopback } from './testServer.js';

process.env.PRODMESH_DATA_DIR = mkdtempSync(join(tmpdir(), 'prodmesh-stream-'));
const { app } = await import('./index.js');
const sm = await import('./showManager.js');
const conn = await import('./connectivity.js');
const settings = await import('./settings.js');

// north-youth: mock Companion, no ProPresenter/analysis → subscribing starts no
// watchers, so the stream test observes pure fan-out.
const ROOM = 'north-youth';
const PLAN = 'mock-500005-0';
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

// ── SSE parsing (comment/heartbeat-tolerant) ─────────────────────────────────
function sseParser() {
  let buf = '';
  const events = [];
  return {
    events,
    push(chunk) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let event = 'message';
        const data = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith(':')) continue; // comment (`: ping` heartbeat)
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trim());
        }
        if (data.length) events.push({ event, data: JSON.parse(data.join('\n')) });
      }
    },
  };
}

// Open the stream and pump it into a parser until the controller aborts.
async function openStream(ctl) {
  const res = await fetch(`${base}/api/rooms/${ROOM}/show/stream`, { signal: ctl.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const parser = sseParser();
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(dec.decode(value, { stream: true }));
      }
    } catch {
      /* aborted */
    }
  })();
  return parser;
}

async function waitFor(predicate, what, timeoutMs = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`timed out waiting for ${what}`);
}
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

test('the parser tolerates `: ping` heartbeat comments between and inside frames', () => {
  const p = sseParser();
  p.push('event: state\ndata: {"active":false}\n\n: ping\n\n');
  p.push(': ping\nevent: state\ndata: {"acti');
  p.push('ve":true}\n\n');
  assert.deepEqual(p.events, [
    { event: 'state', data: { active: false } },
    { event: 'state', data: { active: true } },
  ]);
});

test('SSE stream: state on connect, push on startShow, clean disconnect', async () => {
  const ctl = new AbortController();
  const ctl2 = new AbortController();
  try {
    const stream = await openStream(ctl);

    // On connect: the current state arrives immediately as an `event: state`.
    await waitFor(() => stream.events.length >= 1, 'the connect frame');
    assert.equal(stream.events[0].event, 'state');
    assert.equal(stream.events[0].data.active, false);

    // A server-side start fans out to the subscriber.
    await sm.startShow(ROOM, PLAN, 'svc-1');
    await waitFor(() => stream.events.some((e) => e.data.active === true), 'the active-state frame');
    const active = stream.events.find((e) => e.data.active === true);
    assert.equal(active.event, 'state');
    assert.equal(active.data.planId, PLAN);
    assert.equal(active.data.timeId, 'svc-1');
    assert.equal(active.data.roomId, ROOM);

    // Abort the fetch (browser gone) …
    ctl.abort();
    await settle(100); // let the server's req 'close' handler unsubscribe

    // … and the machinery must survive: a fresh subscriber connects and sees
    // the live show, and broadcasts still work.
    const stream2 = await openStream(ctl2);
    await waitFor(() => stream2.events.length >= 1, 'the second connect frame');
    assert.equal(stream2.events[0].data.active, true);

    sm.endShow(ROOM);
    await waitFor(() => stream2.events.some((e) => e.data.active === false), 'the end-of-show frame');
  } finally {
    ctl.abort();
    ctl2.abort();
    if (sm.getState(ROOM).active) sm.endShow(ROOM);
    await settle(50);
  }
});

test('Companion down: mode change → 502, state read → 200 with mock fallback + error', async () => {
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
    // GET state degrades gracefully: 200, mock fallback, error surfaced.
    const stateRes = await fetch(`${base}/api/rooms/${ROOM}/state`);
    assert.equal(stateRes.status, 200);
    const state = await stateRes.json();
    assert.equal(state.source, 'mock');
    assert.equal(state.online, false);
    assert.ok(state.error, 'the Companion failure must be surfaced');
    assert.ok(state.mode, 'still reports a mode from mock state');

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
