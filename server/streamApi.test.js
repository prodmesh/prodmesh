// The multiplexed stream endpoint (GET /api/stream) against the real Express
// app. Separate from streamHub.test.js because that file resets the hub's
// registry, which would take the app's own topics with it.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenOnLoopback } from './testServer.js';

process.env.PRODMESH_DATA_DIR = mkdtempSync(join(tmpdir(), 'prodmesh-streamapi-'));
const hub = await import('./streamHub.js');

const { app } = await import('./index.js');
const sm = await import('./showManager.js');

// north-youth: mock Companion, no ProPresenter/analysis — subscribing starts no
// device polling, so the endpoint test observes pure fan-out.
const ROOM = 'north-youth';

let server;
let base;
before(async () => {
  ({ server, base } = await listenOnLoopback(app));
});
after(() => {
  server.closeAllConnections?.();
  server.close();
});

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
          if (line.startsWith(':')) continue;
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trim());
        }
        if (data.length) events.push({ event, data: JSON.parse(data.join('\n')) });
      }
    },
  };
}

async function openStream(ctl, topics) {
  const url = `${base}/api/stream?topics=${encodeURIComponent(topics.join(','))}`;
  const res = await fetch(url, { signal: ctl.signal });
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

test('/api/stream: one connection carries several topics, and unknown ones are ignored', async () => {
  const ctl = new AbortController();
  try {
    const stream = await openStream(ctl, [
      sm.showTopic(ROOM),
      sm.splTopic(ROOM),
      `room:no-such-room:show`, // must not open a producer, must not kill the rest
    ]);

    await waitFor(
      () => stream.events.some((e) => e.data.topic === sm.showTopic(ROOM)),
      'the show snapshot',
    );
    const show = stream.events.find((e) => e.data.topic === sm.showTopic(ROOM));
    assert.equal(show.event, 'msg');
    assert.equal(show.data.data.active, false);
    assert.equal(hub.subscriberCount('room:no-such-room:show'), 0);

    // A server-side change reaches this connection on its own topic.
    await sm.startShow(ROOM, 'mock-500005-0', 'default');
    await waitFor(
      () => stream.events.some((e) => e.data.topic === sm.showTopic(ROOM) && e.data.data.active),
      'the active show frame',
    );
  } finally {
    ctl.abort();
    if (sm.getState(ROOM).active) sm.endShow(ROOM);
  }
});

test('/api/stream: disconnecting releases every topic the connection held', async () => {
  const ctl = new AbortController();
  const stream = await openStream(ctl, [sm.showTopic(ROOM), sm.timerTopic(ROOM)]);
  await waitFor(() => stream.events.length >= 1, 'the connect frames');
  assert.equal(hub.subscriberCount(sm.showTopic(ROOM)), 1);

  ctl.abort();
  await waitFor(
    () => hub.subscriberCount(sm.showTopic(ROOM)) === 0 && hub.subscriberCount(sm.timerTopic(ROOM)) === 0,
    'the server to release both topics',
  );
});
