// Did the last run end cleanly? (ADR 0022 §5)
//
// The in-process tests drive begin()/markCleanExit() directly. The child-process
// tests are the ones that matter: they crash a real Node process the three ways
// a server dies, and check both that the record survives AND that the monitor
// did not change how Node died (exit code, the error on stderr).
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.PRODMESH_DATA_DIR = mkdtempSync(join(tmpdir(), 'prodmesh-lifecycle-'));
const lifecycle = await import('./lifecycle.js');
const backup = await import('./backup.js');

const fresh = () => mkdtempSync(join(tmpdir(), 'prodmesh-lifecycle-'));
const read = (dir, f) => JSON.parse(readFileSync(join(dir, f), 'utf8'));

afterEach(() => lifecycle._resetForTests());

test('a first boot leaves a marker and reports nothing about a previous run', () => {
  const dir = fresh();
  assert.equal(lifecycle.begin({ dir, version: '1.6.0', now: 1000 }), null);
  const marker = read(dir, 'running.json');
  assert.equal(marker.pid, process.pid);
  assert.equal(marker.version, '1.6.0');
  assert.deepEqual(lifecycle.summary(), { since: 1000, boots: 1, uncleanExits: 0, lastUnclean: null });
});

test('begin() twice in one process counts one boot', () => {
  const dir = fresh();
  lifecycle.begin({ dir });
  lifecycle.begin({ dir });
  assert.equal(lifecycle.summary().boots, 1);
});

test('a clean exit removes the marker, and the next boot finds nothing wrong', () => {
  const dir = fresh();
  lifecycle.begin({ dir });
  lifecycle.markCleanExit();
  assert.equal(existsSync(join(dir, 'running.json')), false);
  lifecycle._resetForTests();

  assert.equal(lifecycle.begin({ dir }), null);
  assert.equal(lifecycle.summary().boots, 2);
  assert.equal(lifecycle.summary().uncleanExits, 0);
});

test('a leftover marker is an unclean exit, dated by its last refresh', () => {
  const dir = fresh();
  // Our own pid in the marker, as after a container restart where the server
  // is always pid 1: stale, not "another process".
  writeFileSync(join(dir, 'running.json'), JSON.stringify({ pid: process.pid, version: '1.5.0', bootedAt: 1000, aliveAt: 1000 + 42 * 60_000 }));
  const previous = lifecycle.begin({ dir, version: '1.6.0' });
  assert.equal(previous.endedCleanly, false);
  assert.equal(previous.version, '1.5.0');
  assert.equal(previous.uptimeMs, 42 * 60_000);
  assert.equal(previous.fatal, null);
  const s = lifecycle.summary();
  assert.equal(s.uncleanExits, 1);
  assert.equal(s.lastUnclean.version, '1.5.0');
  assert.equal(s.lastUnclean.error, null);
  assert.equal(read(dir, 'running.json').version, '1.6.0', 'replaced by this run');
});

test('a recorded fatal error is attached to the unclean exit, then consumed', () => {
  const dir = fresh();
  lifecycle.begin({ dir, version: '1.6.0' });
  lifecycle.recordFatal(new TypeError("Cannot read properties of undefined (reading 'items')"), 'uncaughtException');
  lifecycle._resetForTests(); // the process "died": no clean exit

  const previous = lifecycle.begin({ dir });
  assert.equal(previous.endedCleanly, false);
  assert.equal(previous.fatal.name, 'TypeError');
  assert.equal(previous.fatal.origin, 'uncaughtException');
  assert.match(previous.fatal.stack, /lifecycle\.test\.js/);
  assert.equal(existsSync(join(dir, 'fatal.json')), false, 'consumed, so it is not reported twice');
  assert.deepEqual(lifecycle.summary().lastUnclean.error, {
    name: 'TypeError', message: "Cannot read properties of undefined (reading 'items')", origin: 'uncaughtException',
  });
});

test('an uncaught error the process survived is shown but not counted as a crash', () => {
  // Electron's main process shows a dialog for an uncaught error and carries on.
  const dir = fresh();
  lifecycle.begin({ dir });
  lifecycle.recordFatal(new Error('survived'), 'uncaughtException');
  lifecycle.markCleanExit();
  lifecycle._resetForTests();

  const previous = lifecycle.begin({ dir });
  assert.equal(previous.endedCleanly, true);
  assert.equal(previous.fatal.message, 'survived');
  assert.equal(lifecycle.summary().uncleanExits, 0);
});

test('a marker held by another live process is left alone', () => {
  const dir = fresh();
  // Our parent is certainly alive and certainly not us.
  const theirs = { pid: process.ppid, version: '1.5.0', bootedAt: 1, aliveAt: 2 };
  writeFileSync(join(dir, 'running.json'), JSON.stringify(theirs));
  assert.equal(lifecycle.begin({ dir }), null);
  assert.equal(lifecycle.summary(), null, 'nothing recorded for this run');
  assert.deepEqual(read(dir, 'running.json'), theirs);
  assert.equal(existsSync(join(dir, 'lifecycle.json')), false);
});

test('backups do not carry the run history', () => {
  lifecycle.begin({ version: '1.6.0' }); // the default dir, inside PRODMESH_DATA_DIR
  assert.ok(existsSync(join(process.env.PRODMESH_DATA_DIR, 'telemetry', 'running.json')), 'on disk');
  const files = Object.keys(backup.readBackup(backup.createBackup()).files);
  assert.ok(!files.some((f) => f.startsWith('telemetry')), files.join(', '));
});

// ── Real processes ──────────────────────────────────────────────────────────

const LIFECYCLE_URL = pathToFileURL(fileURLToPath(new URL('./lifecycle.js', import.meta.url))).href;

function runChild(dir, body) {
  const script = `
    const lifecycle = await import(${JSON.stringify(LIFECYCLE_URL)});
    lifecycle.begin({ dir: ${JSON.stringify(dir)}, version: '9.9.9' });
    ${body}
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, PRODMESH_DATA_DIR: dir },
    encoding: 'utf8',
    timeout: 20_000,
  });
}

test('a real uncaught exception: recorded, and Node still dies the way it would have', () => {
  const dir = fresh();
  const child = runChild(dir, `setTimeout(() => { throw new RangeError('boom in a timer'); }, 0);`);
  assert.equal(child.status, 1, child.stderr);
  assert.match(child.stderr, /RangeError: boom in a timer/, 'Node still prints the error');
  assert.ok(existsSync(join(dir, 'running.json')), 'marker left for the next boot');
  const fatal = read(dir, 'fatal.json');
  assert.equal(fatal.name, 'RangeError');
  assert.equal(fatal.origin, 'uncaughtException');
  assert.equal(fatal.version, '9.9.9');
});

test('a real unhandled rejection: recorded with its origin', () => {
  const dir = fresh();
  const child = runChild(dir, `Promise.reject(new Error('nobody awaited this'));`);
  assert.notEqual(child.status, 0, child.stderr);
  const fatal = read(dir, 'fatal.json');
  assert.equal(fatal.message, 'nobody awaited this');
  assert.equal(fatal.origin, 'unhandledRejection');
});

test('a real process that finishes normally clears its marker', () => {
  const dir = fresh();
  const child = runChild(dir, `/* nothing left to do: the event loop drains and Node exits 0 */`);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(existsSync(join(dir, 'running.json')), false);
  assert.equal(existsSync(join(dir, 'fatal.json')), false);
});

test('a real process that exits non-zero leaves its marker', () => {
  const dir = fresh();
  const child = runChild(dir, `process.exit(1);`);
  assert.equal(child.status, 1);
  assert.ok(existsSync(join(dir, 'running.json')));
});
