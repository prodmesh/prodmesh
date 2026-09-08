// What happens to a running server when its data directory is replaced.
//
// Its own file because the seal is one-way boot state: once this process has
// been restored onto, the database is closed and every API route answers 503.
// Nothing else in the suite can share a process with that.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { listenOnLoopback } from './testServer.js';

const DIR = mkdtempSync(join(tmpdir(), 'prodmesh-seal-'));
process.env.PRODMESH_DATA_DIR = DIR;

const { getDb } = await import('./db.js');
const backup = await import('./backup.js');
const settings = await import('./settings.js');
const secrets = await import('./secrets.js');
const seal = await import('./restoreSeal.js');
const { app } = await import('./index.js');

const churchIs = (db) => db.prepare('SELECT value FROM app_config WHERE key = ?').get('church')?.value;
const setChurch = (name) =>
  getDb().prepare('INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)').run('church', name);

/** Read the file on disk the way the NEXT boot will — its own connection. */
function onDisk() {
  const db = new Database(join(DIR, 'prodmesh.db'), { readonly: true });
  try {
    return churchIs(db);
  } finally {
    db.close();
  }
}

let base;
let server;
before(async () => {
  ({ server, base } = await listenOnLoopback(app));
});
after(() => server.close());

test('a restore survives the restart it tells the operator to perform', async () => {
  // The backup is taken from the machine that died…
  setChurch('Backed-Up Church');
  const bytes = backup.createBackup();

  // …and restored onto a fresh install, which has its own database open.
  setChurch('Fresh Install');
  const openHandle = getDb();
  assert.equal(onDisk(), 'Fresh Install');

  const res = await fetch(`${base}/api/setup/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytes,
  });
  assert.equal(res.status, 200);
  assert.match((await res.json()).restart, /restart|reopen/i);

  // The restore is on disk…
  assert.equal(onDisk(), 'Backed-Up Church');

  // …and — the actual bug — the connection that would have written the fresh
  // install's pages back over it on the way out is already closed. Before this
  // fix that handle stayed open, and closing it at shutdown silently restored
  // "Fresh Install" over the top.
  assert.throws(() => churchIs(openHandle), /not open/i);
  assert.equal(onDisk(), 'Backed-Up Church');
});

test('every route says the same thing afterwards, rather than failing its own way', async () => {
  const res = await fetch(`${base}/api/rooms`);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.error, 'restored');
  assert.match(body.message, /Restart prodmesh/);
  assert.match(body.restart, /restart|reopen/i);
});

test('nothing can reopen the database or flush a stale cache over the restored files', () => {
  // Each of these is a live path that would otherwise undo part of a restore:
  // a reopened database, settings.json rewritten whole from memory, and
  // secrets.json the same — which is how the restored admin PIN gets lost.
  assert.throws(() => getDb(), /Restart prodmesh/);
  assert.throws(() => settings.setPins({ admin: '654321' }), /Restart prodmesh/);
  assert.throws(() => secrets.setSecrets({ 'youtube.apiKey': 'key-from-the-old-install' }), /Restart prodmesh/);
});

test('the mechanism, recorded: a handle open across the swap wins', () => {
  // Why the seal exists at all. SQLite in WAL mode holds its own view of the
  // file; closing that view after the file has been replaced writes the view
  // back. No intervening write is needed — the close alone is enough. This is
  // what every restore did before the fix, at exactly the moment the operator
  // was told to restart.
  seal.unsealForTest();
  const dir = mkdtempSync(join(tmpdir(), 'prodmesh-swap-'));
  const path = join(dir, 'db.sqlite');

  const open = new Database(path);
  open.pragma('journal_mode = WAL');
  open.exec('CREATE TABLE t (v TEXT)');
  open.prepare('INSERT INTO t VALUES (?)').run('old');

  const replacement = new Database(join(dir, 'src.sqlite'));
  replacement.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('restored'); VACUUM;");
  replacement.close();

  writeFileSync(path, readFileSync(join(dir, 'src.sqlite')));
  for (const s of ['db.sqlite-wal', 'db.sqlite-shm']) rmSync(join(dir, s), { force: true });

  const read = () => {
    const db = new Database(path, { readonly: true });
    try { return db.prepare('SELECT v FROM t').get().v; } finally { db.close(); }
  };
  assert.equal(read(), 'restored', 'the bytes land');
  open.close(); // ← the restart
  assert.equal(read(), 'old', 'and the still-open handle takes them back');

  seal.seal();
});
