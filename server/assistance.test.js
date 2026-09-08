// The assistance flow end-to-end against a fake Slack Web API: request posts
// once (idempotent), dismiss ✅s the original message, station identity is
// required, and a Slack outage surfaces to the requester instead of silently
// pretending help is coming.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenOnLoopback } from './testServer.js';

process.env.PRODMESH_DATA_DIR = mkdtempSync(join(tmpdir(), 'prodmesh-assist-'));

// Fake Slack: started before slack.js is imported so BASE picks up the URL.
const slackCalls = [];
let slackMode = 'ok';
let fakeReactions = []; // what reactions.get reports on the posted message
const fakeSlack = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://fake');
    const method = url.pathname.slice(1);
    const payload = raw ? JSON.parse(raw) : Object.fromEntries(url.searchParams);
    slackCalls.push({ method, payload });
    res.setHeader('Content-Type', 'application/json');
    if (slackMode === 'fail') return res.end(JSON.stringify({ ok: false, error: 'channel_not_found' }));
    if (method === 'chat.postMessage') {
      return res.end(JSON.stringify({ ok: true, channel: payload.channel, ts: '1234.5678' }));
    }
    if (method === 'reactions.get') {
      return res.end(JSON.stringify({ ok: true, message: { reactions: fakeReactions } }));
    }
    if (method === 'users.info') {
      return res.end(JSON.stringify({ ok: true, user: { real_name: 'Pastor Tech', profile: { display_name: 'Pastor Tech' } } }));
    }
    return res.end(JSON.stringify({ ok: true }));
  });
});
process.env.PRODMESH_ASSIST_POLL_MS = '50'; // fast ack polling for tests
process.env.PRODMESH_SLACK_API = (await listenOnLoopback(fakeSlack)).base;
process.env.PRODMESH_SLACK_ENV = 'test';
process.env.PRODMESH_SECRET_SLACK_TEST_BOTOAUTHTOKEN = 'xoxb-fake';
process.env.PRODMESH_SECRET_SLACK_TEST_CHANNEL = 'C-TEST';

const { app } = await import('./index.js');
const auth = await import('./authStore.js');

const station = auth.registerStation({ name: 'FOH – Test Booth' });

let base;
let server;
before(async () => {
  ({ server, base } = await listenOnLoopback(app));
});
after(() => {
  server.close();
  fakeSlack.close();
});

const call = (method, stationToken) =>
  fetch(`${base}/api/assistance`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(stationToken ? { 'X-Prodmesh-Station': stationToken } : {}),
    },
    ...(method === 'POST' ? { body: '{}' } : {}),
  });

test('requesting without a registered station is refused', async () => {
  const res = await call('POST', null);
  assert.equal(res.status, 400);
});

test('request posts ONE Slack message; double-tap stays one; dismiss ✅s it', async () => {
  const res = await call('POST', station.token);
  assert.equal(res.status, 200);
  const state = await res.json();
  assert.equal(state.active, true);
  assert.equal(state.userName, null); // no login — the station is the identity

  const posts = slackCalls.filter((c) => c.method === 'chat.postMessage');
  assert.equal(posts.length, 1);
  assert.match(posts[0].payload.text, /technical assistance at \*FOH – Test Booth\*/);
  assert.match(posts[0].payload.text, /Someone has requested/);
  assert.equal(posts[0].payload.channel, 'C-TEST');

  // Nervous double-tap: no second message.
  await call('POST', station.token);
  assert.equal(slackCalls.filter((c) => c.method === 'chat.postMessage').length, 1);

  // The station sees its open request.
  assert.deepEqual((await (await call('GET', station.token)).json()).active, true);

  // Dismiss reacts ✅ on the original message and clears the state.
  await call('DELETE', station.token);
  const reactions = slackCalls.filter((c) => c.method === 'reactions.add');
  assert.equal(reactions.length, 1);
  assert.equal(reactions[0].payload.timestamp, '1234.5678');
  assert.equal(reactions[0].payload.name, 'white_check_mark');
  assert.equal((await (await call('GET', station.token)).json()).active, false);
});

test('a Slack failure surfaces as an error and opens NO local request', async () => {
  slackMode = 'fail';
  const res = await call('POST', station.token);
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /Couldn't notify the tech team/);
  assert.equal((await (await call('GET', station.token)).json()).active, false);
  slackMode = 'ok';
});

test('a reported problem rides along as a Slack blockquote (mrkdwn-escaped)', async () => {
  const res = await fetch(`${base}/api/assistance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Prodmesh-Station': station.token },
    body: JSON.stringify({ message: 'No sound from pulpit mic <urgent> & loud buzz' }),
  });
  assert.equal(res.status, 200);
  const state = await res.json();
  assert.equal(state.message, 'No sound from pulpit mic <urgent> & loud buzz');

  const post = slackCalls.filter((c) => c.method === 'chat.postMessage').at(-1);
  assert.match(post.payload.text, /technical assistance at \*FOH – Test Booth\*/);
  assert.match(post.payload.text, /\n> No sound from pulpit mic &lt;urgent&gt; &amp; loud buzz/);

  await call('DELETE', station.token);
});

test('a 👀 reaction on the Slack message becomes an acknowledgment with the tech name', async () => {
  fakeReactions = [];
  await call('POST', station.token);
  assert.equal((await (await call('GET', station.token)).json()).ack, null);

  // A tech reacts 👀 in Slack; the poller picks it up within a few ticks.
  fakeReactions = [{ name: 'eyes', users: ['U777'], count: 1 }];
  await new Promise((r) => setTimeout(r, 300));

  const state = await (await call('GET', station.token)).json();
  assert.equal(state.active, true);
  assert.deepEqual(state.ack?.name, 'Pastor Tech');
  assert.ok(state.ack.at > 0);

  await call('DELETE', station.token);
  fakeReactions = [];
});
