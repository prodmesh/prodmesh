// What crosses the link in ADR 0018 is rebuilt from a fixed shape on arrival,
// because a paired server may be compromised (ADR 0016). These are the
// validators; the protocol runs between two real servers in
// federation.e2e.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PRODMESH_DATA_DIR = mkdtempSync(join(tmpdir(), 'prodmesh-feddir-'));
const store = await import('./federation/store.js');
const { validateDirectory, localDirectory } = await import('./federation/directory.js');
const { validateDigest } = await import('./federation/digest.js');

test('a dashboard address is an http(s) origin and nothing else', () => {
  assert.equal(store.normalizeDashboardUrl('http://192.0.2.10:8080/'), 'http://192.0.2.10:8080');
  assert.equal(store.normalizeDashboardUrl('https://prodmesh-south.example.org'), 'https://prodmesh-south.example.org');
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'ftp://192.0.2.10', 'http://192.0.2.10/admin',
    'http://user:pw@192.0.2.10', 'http://192.0.2.10/?x=1', '192.0.2.10:8080', '']) {
    assert.equal(store.normalizeDashboardUrl(bad), null, bad);
  }
  assert.throws(() => store.setConfig({ dashboardUrl: 'javascript:alert(1)' }), /http/);
  store.setConfig({ dashboardUrl: 'http://prodmesh.example.org:8080/' });
  assert.equal(localDirectory().dashboardUrl, 'http://prodmesh.example.org:8080');
  store.setConfig({ dashboardUrl: '' });
  assert.match(localDirectory().dashboardUrl, /^http:\/\/.+:\d+$/, 'blank means this machine, on the dashboard port');
});

test('our directory changes revision exactly when its content does', () => {
  const a = localDirectory();
  assert.equal(localDirectory().revision, a.revision);
  store.setConfig({ dashboardUrl: 'http://192.0.2.99:8080' });
  assert.notEqual(localDirectory().revision, a.revision);
  store.setConfig({ dashboardUrl: '' });
});

test('a peer directory keeps only well-formed campuses and rooms', () => {
  const dir = validateDirectory({
    revision: 'abc123',
    dashboardUrl: 'javascript:alert(1)',
    campuses: [
      { id: 'south', name: '  South  ', rooms: [
        { id: 'main', name: 'Main' },
        { id: 'main', name: 'Duplicate' },
        { id: '../etc', name: 'Bad id' },
        { id: 'youth', name: 'Y'.repeat(500) },
        { id: 'blank', name: '   ' },
      ], tiles: [{ host: '192.0.2.50' }] },
      { id: 'x y', name: 'Bad campus id', rooms: [] },
      'nonsense',
    ],
    secrets: 'ignored',
  });
  assert.equal(dir.dashboardUrl, null, 'a non-origin URL never reaches an Open button');
  assert.equal(dir.campuses.length, 1);
  assert.equal(dir.campuses[0].name, 'South');
  assert.deepEqual(dir.campuses[0].rooms.map((r) => r.id), ['main', 'youth']);
  assert.equal(dir.campuses[0].rooms[1].name.length, 80);
  assert.ok(!('tiles' in dir.campuses[0]) && !('secrets' in dir));
  assert.throws(() => validateDirectory({ campuses: [] }), /revision/);
  assert.throws(() => validateDirectory(null), /not a directory/);
});

test('a peer digest names only directory rooms, and every field is checked', () => {
  const now = Date.now();
  const d = validateDigest({
    revision: 'abc123',
    generatedAt: now,
    rooms: {
      main: {
        mode: { id: 'service', label: 'Service', color: 'red;background:url(x)', online: 'yes', locked: true, observedAt: now - 5000 },
        show: { active: true, startedAt: now - 60_000, observedAt: now },
        health: { integrations: [{ id: 'proPresenter', label: 'ProPresenter', state: 'ok' }, { id: 'x', state: 'pwned' }], observedAt: 0 },
        next: { title: 'Sunday', dates: 'Nov 15', at: now + 86_400_000, observedAt: now },
        extra: '<script>',
      },
      stranger: { show: { active: true } },
    },
  }, ['main']);
  const room = d.rooms.main;
  assert.deepEqual(Object.keys(d.rooms), ['main'], 'a room the directory does not name is dropped');
  assert.equal(room.mode.color, null, 'a colour goes into a style attribute, so it must be a colour');
  assert.equal(room.mode.online, null);
  assert.equal(room.mode.locked, true);
  assert.equal(room.show.active, true);
  assert.deepEqual(room.health.integrations.map((i) => i.id), ['proPresenter']);
  assert.equal(room.health.observedAt, null, 'an absurd timestamp is unknown, not 1970');
  assert.equal(room.next.title, 'Sunday');
  assert.ok(!('extra' in room));
  assert.throws(() => validateDigest({}, ['main']), /not a digest/);
});
