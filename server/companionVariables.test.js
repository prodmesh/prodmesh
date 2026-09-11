// The Companion variable watcher against a fake Companion, driven through the
// real hub. Separate from streamHub.test.js, which resets the hub's registry —
// that would take this module's own registration with it.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PRODMESH_DATA_DIR = mkdtempSync(join(tmpdir(), 'prodmesh-cvars-'));
const hub = await import('./streamHub.js');
const { rooms } = await import('./roomsStore.js');
const cvars = await import('./companionVariables.js');
const views = await import('./views.js');

// north-youth ships simulated and has no ProPresenter or analysis, so nothing
// else in the process starts polling because of these tests.
const ROOM = 'north-youth';

/** A fake Companion that answers from `values`; unknown names 404 the way the
 *  real one does (verified against Companion 2026-09-01: body "Not found"). */
async function fakeCompanion(values) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push(req.url);
    const name = decodeURIComponent(req.url.split('/').at(-2) ?? '');
    if (!(name in values)) {
      res.statusCode = 404;
      return res.end('Not found');
    }
    res.end(String(values[name]));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  rooms[ROOM].mock = false;
  rooms[ROOM].companion = { host: '127.0.0.1', port: srv.address().port };
  return {
    seen,
    values,
    close: () => {
      srv.closeAllConnections?.();
      return new Promise((r) => srv.close(r));
    },
  };
}

/** Collects the values written to one subscriber, by topic. */
function fakeRes() {
  const got = new Map();
  return {
    got,
    write(chunk) {
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const { topic, data } = JSON.parse(line.slice(5));
        got.set(topic, [...(got.get(topic) ?? []), data]);
      }
      return true;
    },
    once() {},
    /** Every value this subscriber has been sent for one variable. */
    frames: (label, name) => got.get(cvars.variableTopic(ROOM, label, name)) ?? [],
  };
}

const topic = (label, name) => cvars.variableTopic(ROOM, label, name);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until `check` passes, so a passing test costs one cycle rather than a
 *  fixed sleep long enough for the slowest machine. */
async function until(check, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return true;
    await wait(25);
  }
  return check();
}

afterEach(() => {
  cvars.stopAll();
  rooms[ROOM].mock = true;
  rooms[ROOM].companion = {};
});

test('a topic names a room and a variable, and nothing else', () => {
  assert.ok(hub.isValidTopic(topic('custom', 'roomState')));
  assert.ok(hub.isValidTopic(topic('internal', 'time_hms')));
  assert.ok(hub.isValidTopic(topic('shure-api', 'battery.1')));

  // Subscribing STARTS WORK, so an unknown room or a name that is not a name
  // must never reach the poller — this is the resource-exhaustion guard, not
  // tidiness. (The hub drops invalid topics individually, so a stale widget
  // costs its own row and not the whole dashboard.)
  assert.equal(hub.isValidTopic(cvars.variableTopic('no-such-room', 'custom', 'x')), false);
  assert.equal(hub.isValidTopic(topic('custom', 'room state')), false, 'a space');
  assert.equal(hub.isValidTopic(topic('custom', 'a/b')), false, 'a path separator');
  assert.equal(hub.isValidTopic(topic('custom', '')), false, 'nothing at all');
  assert.equal(hub.isValidTopic(topic('custom', 'x'.repeat(65))), false, 'too long');
});

test('a room may only have so many distinct variables watched at once', async () => {
  const res = fakeRes();
  const many = Array.from({ length: cvars.MAX_PER_ROOM }, (_, i) => topic('custom', `v${i}`));
  hub.subscribe(res, many);

  // At the cap: one more DISTINCT variable is refused…
  assert.equal(hub.isValidTopic(topic('custom', 'oneMore')), false);
  // …but the ones already watched stay valid however many browsers ask, since
  // the cap bounds polling, not viewers.
  assert.ok(hub.isValidTopic(topic('custom', 'v0')));

  hub.unsubscribe(res);
  assert.ok(hub.isValidTopic(topic('custom', 'oneMore')), 'the cap lifts when the watcher stops');
});

test('a subscriber gets the value, and gets it again only when it changes', async () => {
  const srv = await fakeCompanion({ roomState: 'SUNDAY' });
  const res = fakeRes();
  try {
    hub.subscribe(res, [topic('custom', 'roomState')]);
    await until(() => res.frames('custom', 'roomState').length === 1);
    assert.deepEqual(res.frames('custom', 'roomState'), [{ value: 'SUNDAY', status: 'ok' }]);

    // A poll that finds the same value publishes nothing: an idle rack of
    // variables must cost the browsers no traffic at all.
    srv.values.roomState = 'MIDWEEK';
    await until(() => res.frames('custom', 'roomState').length === 2, 6000);
    assert.deepEqual(res.frames('custom', 'roomState'), [
      { value: 'SUNDAY', status: 'ok' },
      { value: 'MIDWEEK', status: 'ok' },
    ], 'exactly one frame per change, however many polls happened between');
  } finally {
    hub.unsubscribe(res);
    await srv.close();
  }
});

test('a variable joining a running loop is read now, not at the end of a cycle', async () => {
  // Both halves of the same bug, seen on a real dashboard: the FIRST cell to
  // subscribe starts the loop, which then takes its list of keys before the
  // other cells have been added — and a second screen opening later joins a
  // loop that is mid-nap. Either way the rows sat at "…" for a poll interval,
  // which on a wall display is a widget that looks broken.
  const srv = await fakeCompanion({ a: '1', b: '2', c: '3' });
  const res = fakeRes();
  try {
    hub.subscribe(res, [topic('custom', 'a')]);
    hub.subscribe(res, [topic('custom', 'b')]); // added while the first read is in flight
    await until(() => res.frames('custom', 'b').length === 1, 1500);
    assert.deepEqual(res.frames('custom', 'b'), [{ value: '2', status: 'ok' }], 'well inside one cycle');

    // And once the loop is asleep, a new subscriber wakes it.
    await wait(200);
    const later = fakeRes();
    hub.subscribe(later, [topic('custom', 'c')]);
    await until(() => later.frames('custom', 'c').length === 1, 1500);
    assert.deepEqual(later.frames('custom', 'c'), [{ value: '3', status: 'ok' }]);
    hub.unsubscribe(later);
  } finally {
    hub.unsubscribe(res);
    await srv.close();
  }
});

test('a variable that does not exist reads as missing, not as a dead Companion', async () => {
  const srv = await fakeCompanion({ roomState: 'SUNDAY' });
  const res = fakeRes();
  try {
    hub.subscribe(res, [topic('custom', 'typo')]);
    await until(() => res.frames('custom', 'typo').length === 1);
    // The distinction matters to whoever has to fix it: this sends them to the
    // widget's settings, `offline` would send them to the machine.
    assert.deepEqual(res.frames('custom', 'typo'), [{ value: null, status: 'missing' }]);
  } finally {
    hub.unsubscribe(res);
    await srv.close();
  }
});

test('a simulated room says so once and polls nothing', async () => {
  const srv = await fakeCompanion({ roomState: 'SUNDAY' });
  rooms[ROOM].mock = true; // configured, but the room is in mock mode
  const res = fakeRes();
  try {
    hub.subscribe(res, [topic('custom', 'roomState')]);
    await until(() => res.frames('custom', 'roomState').length === 1);
    assert.deepEqual(res.frames('custom', 'roomState'), [{ value: null, status: 'simulated' }]);
    assert.deepEqual(srv.seen, [], 'a mock room never reaches the network');
  } finally {
    hub.unsubscribe(res);
    await srv.close();
  }
});

test('one loop serves every subscriber, and the last one out stops it', async () => {
  const srv = await fakeCompanion({ a: '1', b: '2' });
  const one = fakeRes();
  const two = fakeRes();
  try {
    hub.subscribe(one, [topic('custom', 'a'), topic('custom', 'b')]);
    hub.subscribe(two, [topic('custom', 'a')]);
    await until(() => one.frames('custom', 'a').length === 1 && two.frames('custom', 'a').length === 1);

    // Two browsers watching the same variable is two reads of one poll, not
    // two pollers — the refcounting ADR 0010 kept.
    const reads = srv.seen.length;
    assert.ok(reads <= 2, `two variables, ${reads} requests`);
    assert.deepEqual(two.frames('custom', 'a'), [{ value: '1', status: 'ok' }], 'the joiner is caught up');

    hub.unsubscribe(one);
    hub.unsubscribe(two);
    const atStop = srv.seen.length;
    await wait(300);
    assert.equal(srv.seen.length, atStop, 'nobody is watching, so nothing is polled');
  } finally {
    await srv.close();
  }
});

test('a saved 1-second widget is read every second, not every four (#24)', async () => {
  const v = views.createView({ roomId: ROOM, kind: 'dashboard', name: 'Fast', slug: 'fast-cvars' });
  views.replaceView(v.id, {
    name: 'Fast', slug: 'fast-cvars',
    widgets: [{ type: 'companion-variables', x: 0, y: 0, w: 2, h: 2, config: { refreshMs: 1000, rows: [{ variable: 'custom:tick' }] } }],
  });
  const srv = await fakeCompanion({ tick: '1' });
  const res = fakeRes();
  try {
    hub.subscribe(res, [topic('custom', 'tick')]);
    await until(() => res.frames('custom', 'tick').length === 1);
    srv.values.tick = '2';
    const changedAt = Date.now();
    assert.ok(await until(() => res.frames('custom', 'tick').length === 2, 2500), 'read again');
    // The old fixed cycle would have taken up to four seconds.
    assert.ok(Date.now() - changedAt < 2000, `took ${Date.now() - changedAt}ms`);
  } finally {
    hub.unsubscribe(res);
    await srv.close();
    views.deleteView(v.id);
  }
});
