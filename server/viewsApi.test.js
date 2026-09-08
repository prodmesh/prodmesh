// The Views HTTP surface: who may read (everyone) and who may write
// (views.edit). Separate from views.test.js because this file boots the app —
// one process per boot state.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenOnLoopback } from './testServer.js';

process.env.PRODMESH_DATA_DIR = mkdtempSync(join(tmpdir(), 'prodmesh-viewsapi-'));
const { app } = await import('./index.js');
const auth = await import('./authStore.js');
const views = await import('./views.js');
const { getDb } = await import('./db.js');

const ROOM = 'north-youth'; // mock:true — no Companion network calls

const editorGroup = auth.createGroup({ name: 'View Editors', permissions: ['views.edit'] });
const viewerGroup = auth.createGroup({ name: 'Just Reports', permissions: ['reports.view'] });
auth.createUser({ username: 'editor', displayName: 'Editor', pin: '1234', groupIds: [editorGroup.id] });
auth.createUser({ username: 'viewer', displayName: 'Viewer', pin: '5678', groupIds: [viewerGroup.id] });
const station = auth.registerStation({ name: 'Views Test Station' });

let base;
let server;
let editorToken;
let viewerToken;

before(async () => {
  ({ server, base } = await listenOnLoopback(app));
  const login = async (username, pin) =>
    (await (await send('POST', '/api/auth/login', { username, pin }, null)).json()).token;
  editorToken = await login('editor', '1234');
  viewerToken = await login('viewer', '5678');
});
after(() => server.close());

function send(method, path, body, token) {
  return fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Prodmesh-Station': station.token,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test('reads are open — a display has no keyboard and nobody to log it in', async () => {
  const made = views.createView({ roomId: ROOM, kind: 'display', name: 'Wall', slug: 'wall' });
  views.replaceView(made.id, {
    name: 'Wall', slug: 'wall', widgets: [{ type: 'viewers', x: 0, y: 0, w: 1, h: 1 }],
  });

  // No Authorization, no station header — a bare Raspberry Pi.
  const list = await fetch(`${base}/api/rooms/${ROOM}/views`);
  assert.equal(list.status, 200);
  assert.ok((await list.json()).views.some((v) => v.slug === 'wall'));

  const byKey = await fetch(`${base}/api/rooms/${ROOM}/views/wall`);
  assert.equal(byKey.status, 200);
  assert.equal((await byKey.json()).view.widgets.length, 1);

  assert.equal((await fetch(`${base}/api/views/${made.id}`)).status, 200);
  assert.equal((await fetch(`${base}/api/rooms/${ROOM}/views/nope`)).status, 404);
  assert.equal((await fetch(`${base}/api/rooms/no-such-room/views`)).status, 404);
});

test('writes need views.edit: 401 anonymous, 403 logged in without it', async () => {
  const body = { kind: 'dashboard', name: 'FOH', slug: 'foh' };

  const anon = await send('POST', `/api/rooms/${ROOM}/views`, body, null);
  assert.equal(anon.status, 401, 'nobody is logged in');
  assert.equal((await anon.json()).error, 'permission_required');

  const denied = await send('POST', `/api/rooms/${ROOM}/views`, body, viewerToken);
  assert.equal(denied.status, 403, 'logged in, wrong permissions');
  const refusal = await denied.json();
  assert.equal(refusal.permission, 'views.edit');
  // The browser puts this on screen, so a refusal without it reads as a raw id.
  assert.equal(refusal.label, 'Edit dashboards & displays');

  const ok = await send('POST', `/api/rooms/${ROOM}/views`, body, editorToken);
  assert.equal(ok.status, 201);
  const { view } = await ok.json();
  assert.equal(view.columns, 6);

  // …and the write is on the record, WITH its room. auditSuccess reads roomId
  // off req.params.id, which /api/views/:viewId does not have.
  const saved = await send('PUT', `/api/views/${view.id}`, {
    name: 'FOH', slug: 'foh', widgets: [{ type: 'loudness', x: 0, y: 0, w: 2, h: 1 }],
  }, editorToken);
  assert.equal(saved.status, 200);
  const entry = auth.listAudit({ limit: 50 })
    .find((e) => e.action === 'views.edit' && e.resourceId === view.id && e.details?.action === 'replace');
  assert.ok(entry, 'the replace was audited');
  assert.equal(entry.roomId, ROOM);
});

test('an unknown widget type survives a read but is refused on write', async () => {
  // A view written by a NEWER build. Reading must return it whole: dropping the
  // row would reflow the grid, rearranging a layout someone arranged by hand.
  const made = views.createView({ roomId: ROOM, kind: 'dashboard', name: 'Future', slug: 'future' });
  getDb().prepare(
    `INSERT INTO view_widgets (id, view_id, type, x, y, w, h, config, position)
     VALUES ('vw-future', ?, 'from-the-future', 0, 0, 2, 2, '{}', 0)`,
  ).run(made.id);

  const read = await fetch(`${base}/api/views/${made.id}`);
  assert.equal(read.status, 200);
  assert.deepEqual((await read.json()).view.widgets.map((w) => w.type), ['from-the-future']);

  // Writing one, though, comes from this build's own editor — so it is a bug.
  const rejected = await send('PUT', `/api/views/${made.id}`, {
    name: 'Future', slug: 'future', widgets: [{ type: 'from-the-future', x: 0, y: 0, w: 2, h: 1 }],
  }, editorToken);
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).error, /Unknown widget type/);
});

test('a bad layout is a 400, a missing view is a 404', async () => {
  const made = views.createView({ roomId: ROOM, kind: 'dashboard', name: 'Bad', slug: 'bad' });
  const overlap = await send('PUT', `/api/views/${made.id}`, {
    name: 'Bad', slug: 'bad',
    widgets: [
      { type: 'loudness', x: 0, y: 0, w: 2, h: 1 },
      { type: 'viewers', x: 1, y: 0, w: 1, h: 1 },
    ],
  }, editorToken);
  assert.equal(overlap.status, 400);
  assert.match((await overlap.json()).error, /overlap/);

  assert.equal((await send('PUT', '/api/views/nope', { name: 'x', slug: 'x', widgets: [] }, editorToken)).status, 404);
  assert.equal((await send('DELETE', '/api/views/nope', undefined, editorToken)).status, 404);

  const gone = await send('DELETE', `/api/views/${made.id}`, undefined, editorToken);
  assert.equal(gone.status, 200);
  assert.equal((await fetch(`${base}/api/views/${made.id}`)).status, 404);
});
