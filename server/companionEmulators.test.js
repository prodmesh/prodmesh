import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { listCompanionEmulators } from './companionEmulators.js';

// The frames below are verbatim from a real Companion 4 on 2026-09-08. The
// subscription answers `started` first and the payload arrives in a SECOND
// frame, so a client that reads only the first reply gets nothing — which is
// the shape this module exists to absorb.
const STARTED = { id: 1, result: { type: 'started' } };
const DATA = {
  id: 1,
  result: {
    type: 'data',
    data: [{ id: 'LeqG7hIEDm1rJffJW6hhU', name: 'Booth emulator' }],
  },
};

function fakeCompanion(frames, { holdOpen = false } = {}) {
  const wss = new WebSocketServer({ port: 0 });
  wss.on('connection', (ws) => {
    ws.on('message', () => {
      for (const f of frames) ws.send(JSON.stringify(f));
      // Companion keeps streaming changes; the client must not wait for a close.
      if (!holdOpen) setTimeout(() => ws.send(JSON.stringify({ id: 1, result: { type: 'data', data: [] } })), 50);
    });
  });
  return { port: () => wss.address().port, close: () => new Promise((r) => wss.close(r)) };
}

test('the emulator list comes from the second frame, not the first', async () => {
  const srv = fakeCompanion([STARTED, DATA]);
  try {
    const list = await listCompanionEmulators({ host: '127.0.0.1', port: srv.port() });
    assert.deepEqual(list, [{ id: 'LeqG7hIEDm1rJffJW6hhU', name: 'Booth emulator' }]);
  } finally {
    await srv.close();
  }
});

test('a superjson-enveloped payload is read too', async () => {
  // tRPC wraps payloads as {json: …} on other paths; accepting both is what
  // keeps this working if Companion ever normalizes this one.
  const srv = fakeCompanion([STARTED, { id: 1, result: { type: 'data', data: { json: [{ id: 'a', name: 'Wing' }] } } }]);
  try {
    assert.deepEqual(await listCompanionEmulators({ host: '127.0.0.1', port: srv.port() }), [{ id: 'a', name: 'Wing' }]);
  } finally {
    await srv.close();
  }
});

test('no emulators is an empty list, not an error', async () => {
  // What a fresh Companion actually answers — verified live before one existed.
  const srv = fakeCompanion([STARTED, { id: 1, result: { type: 'data', data: [] } }]);
  try {
    assert.deepEqual(await listCompanionEmulators({ host: '127.0.0.1', port: srv.port() }), []);
  } finally {
    await srv.close();
  }
});

test('entries missing an id or name are dropped rather than rendered blank', async () => {
  const srv = fakeCompanion([STARTED, { id: 1, result: { type: 'data', data: [
    { id: 'ok', name: 'Zed' }, { id: 'no-name' }, { name: 'no-id' }, { id: 'ok2', name: 'Alpha' },
  ] } }]);
  try {
    // …and sorted by name, so the picker is stable between loads.
    assert.deepEqual(await listCompanionEmulators({ host: '127.0.0.1', port: srv.port() }),
      [{ id: 'ok2', name: 'Alpha' }, { id: 'ok', name: 'Zed' }]);
  } finally {
    await srv.close();
  }
});

test('a host that never answers rejects rather than hanging the settings page', async () => {
  // TEST-NET-1 is guaranteed unroutable.
  await assert.rejects(() => listCompanionEmulators({ host: '192.0.2.99', port: 8000 }), /Could not connect|in time/);
});

test('no host is refused before a socket is opened', () => {
  assert.throws(() => listCompanionEmulators({}), /Set a Companion host/);
});

test('an aborted request settles', async () => {
  const srv = fakeCompanion([STARTED], { holdOpen: true }); // started, then silence
  const ctl = new AbortController();
  try {
    const p = listCompanionEmulators({ host: '127.0.0.1', port: srv.port() }, ctl.signal);
    setTimeout(() => ctl.abort(), 50);
    await assert.rejects(() => p, /aborted/);
  } finally {
    await srv.close();
  }
});
