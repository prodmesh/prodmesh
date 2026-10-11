// readRoomState/applyMode against a Companion that is configured but not
// answering, and against a simulated room. The two used to share one shape
// (source:'mock' plus an in-memory mode), so a broken live room showed a mode
// nobody had confirmed — and after a failed press, the mode it had asked for
// (#54).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PRODMESH_DATA_DIR ??= mkdtempSync(join(tmpdir(), 'prodmesh-roommodes-'));
const { readRoomState, applyMode } = await import('./roomModes.js');

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
