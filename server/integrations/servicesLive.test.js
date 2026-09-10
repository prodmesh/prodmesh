import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PRODMESH_DATA_DIR = mkdtempSync(join(tmpdir(), 'prodmesh-live-'));
const { holdsControl } = await import('./planningCenter.js');

// Planning Center has no way to END Services LIVE, and the only way to let go
// of it is toggle_control — which is a TOGGLE. From a token that does not hold
// control it TAKES control. So "release at show end" must be sure first.
const live = (controllerId) => ({
  relationships: { controller: { data: controllerId ? { type: 'Person', id: controllerId } : null } },
});

test('releases only Services LIVE that this token provably holds', () => {
  assert.equal(holdsControl(live('42'), '42'), true);
  assert.equal(holdsControl(live('42'), 42), true, 'ids compare as strings');
});

test('never snatches Services LIVE back from someone who took it over', () => {
  // A volunteer took control by hand mid-service. Releasing "our" control at
  // show end would toggle it straight out of their hands.
  assert.equal(holdsControl(live('7'), '42'), false);
});

test('does nothing when nobody holds it, or when it cannot tell who it is', () => {
  assert.equal(holdsControl(live(null), '42'), false);
  assert.equal(holdsControl(live('42'), undefined), false, 'never guess who we are');
  assert.equal(holdsControl(null, '42'), false);
});
