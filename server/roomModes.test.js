// readRoomState/applyMode against a Companion that is configured but not
// answering, and against a simulated room. The two used to share one shape
// (source:'mock' plus an in-memory mode), so a broken live room showed a mode
// nobody had confirmed — and after a failed press, the mode it had asked for
// (#54).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PRODMESH_DATA_DIR ??= mkdtempSync(join(tmpdir(), 'prodmesh-roommodes-'));
const { readRoomState, applyMode } = await import('./roomModes.js');
const companion = await import('./companion.js');
const health = await import('./health.js');

// A port that is guaranteed dead: bind, read it, close.
const probe = createServer();
await new Promise((r) => probe.listen(0, '127.0.0.1', r));
const deadPort = probe.address().port;
await new Promise((r) => probe.close(r));

const modes = [
  { id: 'sunday', label: 'Sunday', color: '#0f0', match: 'SUNDAY', press: { page: 1, row: 3, column: 1 } },
  { id: 'standby', label: 'Standby', color: '#888', match: 'STANDBY', press: { page: 1, row: 3, column: 2 }, isStandby: true },
];

const liveRoom = {
  id: 'rm-live',
  mock: false,
  companion: { host: '127.0.0.1', port: deadPort },
  state: { variable: 'roomState' },
  modes,
};

const simRoom = { id: 'rm-sim', mock: true, companion: { host: '192.0.2.40', port: 8000 }, state: { variable: 'roomState' }, modes };

test('an unreachable live Companion reads as unknown, not a guessed mode', async () => {
  const s = await readRoomState(liveRoom);
  assert.equal(s.mode, null);
  assert.equal(s.online, false);
  assert.equal(s.source, 'companion');
  assert.ok(s.error, 'error says why the mode is unknown');
});

test('a failed press on a live room does not read back as the mode it asked for', async () => {
  await assert.rejects(applyMode(liveRoom, modes[0]));
  const s = await readRoomState(liveRoom);
  assert.equal(s.mode, null);
});

test('a simulated room keeps its in-memory mode and is not a fault', async () => {
  const before = await readRoomState(simRoom);
  assert.equal(before.mode, 'standby');
  assert.equal(before.source, 'mock');
  assert.equal(before.error, undefined);

  assert.deepEqual(await applyMode(simRoom, modes[0]), { online: false, source: 'mock' });
  assert.equal((await readRoomState(simRoom)).mode, 'sunday');
});

// A Companion that answers, but has no $(roomState): what a church sees when
// it uses Companion for buttons and widgets and never made the room-mode
// variable (PR #53). Companion's answer for a missing variable is a 404 with
// the body "Not found" (INTEGRATION-NOTES).
test('a reachable Companion without the room-mode variable is online, with the mode unknown', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/custom-variable/roomState/value') { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200); res.end('ok');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const room = { ...liveRoom, id: 'rm-novar', companion: { host: '127.0.0.1', port: server.address().port } };
  try {
    const s = await readRoomState(room);
    assert.equal(s.mode, null);
    assert.equal(s.online, true, 'Companion answered, so it is not offline');
    assert.equal(s.error, undefined, 'and nothing is at fault');
    assert.equal(s.missingVariable, 'roomState');
    assert.equal(health.snapshot()[companion.healthKey(room.companion)].ok, true, 'health stays green');
    assert.match(await companion.ping({ ...room.companion, variable: 'roomState' }), /not defined/);
  } finally {
    server.close();
  }
});
