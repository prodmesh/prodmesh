// ─────────────────────────────────────────────────────────────────────────────
//  BACKUP & RESTORE  —  one file that carries an installation.
//
//  For the person who set prodmesh up once and does not want to do it again
//  when the machine dies. So it has to restore into something USABLE: the
//  Planning Center token, the PINs, the users. Which means the file is as
//  sensitive as the server itself, and everything here is arranged around
//  that being true rather than around pretending it is not.
//
//  Two facts shape the format.
//
//  1. COPYING prodmesh.db WHILE THE SERVER RUNS PRODUCES A CORRUPT BACKUP.
//     WAL means recent commits live in `-wal`, not in the `.db` file, so a
//     plain copy is a database missing its newest transactions — and it fails
//     silently, which is the worst way for a backup to fail. `VACUUM INTO`
//     writes a consistent single-file snapshot from a live database. That is
//     the only correct way to do this and it is not the obvious one.
//
//  2. THE HISTORY IS 99% OF THE BYTES AND ALMOST NONE OF THE VALUE. Measured
//     on a real installation: 164,496 of ~170,000 rows were SPL samples, and
//     the database was 16 MB. Everything a person would grieve — rooms,
//     integrations, users, permissions, dashboards, checklists — came to about
//     450 rows and tens of kilobytes. So history is opt-in, and the default
//     backup is small enough that nobody thinks twice about taking one.
// ─────────────────────────────────────────────────────────────────────────────

import { gzipSync, gunzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, existsSync, statSync, chmodSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { getDb, closeDb, DATA_DIR, SCHEMA_VERSION } from './db.js';
import { seal } from './restoreSeal.js';
import { getVersion } from './deployment.js';

/** Envelope format. Bumped only if the SHAPE changes, not the app version. */
export const FORMAT = 1;

/** Recorded per service and prunable — the bulk, and opt-in. */
const HISTORY_TABLES = ['spl_samples', 'stream_samples', 'show_summaries'];

/**
 * Loose files worth carrying, and what they are.
 *
 * `shows/` is deliberately ABSENT: it holds shows that are running right now.
 * Restoring one onto a fresh machine would resurrect a service that is long
 * over, holding SPL logging open against a room that is dark.
 */
const FILES = ['settings.json', 'secrets.json', 'checklists.json'];
// identity/ is this installation's system id, signing key and certificate
// (#49). Restoring onto new hardware must keep it: a peer site has pinned that
// certificate, and a new one would make every pairing fail.
const DIRS = { branding: false, identity: false, timelines: true }; // value = is it history?

/**
 * Files whose MODE is part of what they are.
 *
 * secrets.js writes secrets.json 0600 and re-chmods it every time, because it
 * holds the Planning Center token and every integration credential in plain
 * text. A restore that recreates it 0644 hands the rebuilt machine a quietly
 * weaker installation than the one that was backed up — and it stays that way
 * until somebody happens to edit a secret. Found on a real restored box.
 *
 * prodmesh.db is deliberately not here: SQLite creates it 0644 itself, so
 * restoring it 0644 is parity rather than a downgrade. Tightening it belongs
 * in db.js if it belongs anywhere, not in a code path that only some
 * installations ever run.
 */
const RESTRICTED_MODE = new Map([
  ['secrets.json', 0o600],
  // The identity's private keys: whoever holds them can impersonate this
  // server to a paired campus.
  ['identity/signing.key', 0o600],
  ['identity/tls.key', 0o600],
]);

const isSafeName = (n) => /^[\w.-]+$/.test(n) && !n.startsWith('.');

function readDir(dir) {
  const abs = join(DATA_DIR, dir);
  if (!existsSync(abs)) return {};
  const out = {};
  for (const name of readdirSync(abs)) {
    if (!isSafeName(name)) continue;
    const p = join(abs, name);
    if (!statSync(p).isFile()) continue;
    out[`${dir}/${name}`] = readFileSync(p).toString('base64');
  }
  return out;
}

/**
 * A consistent snapshot of the database, as base64.
 *
 * VACUUM INTO rather than a file copy — see the header. The temp file is
 * opened again afterwards to drop the history tables, which is both simpler
 * and more faithful than rebuilding a database table by table: the schema is
 * whatever the real one is, including anything a later migration added.
 */
function snapshotDb({ history }) {
  const tmp = join(tmpdir(), `prodmesh-backup-${process.pid}-${Math.floor(Date.now())}.db`);
  rmSync(tmp, { force: true });
  try {
    getDb().exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    if (!history) {
      const copy = new Database(tmp);
      try {
        for (const t of HISTORY_TABLES) {
          // A table a future build dropped should not fail a backup.
          const known = copy.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', t);
          if (known) copy.exec(`DELETE FROM "${t}"`);
        }
        copy.exec('VACUUM'); // actually give the space back, or the file is still 16 MB
      } finally {
        copy.close();
      }
    }
    return readFileSync(tmp).toString('base64');
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Build a backup. Returns the bytes to send. */
export function createBackup({ history = false } = {}) {
  const files = {};
  for (const name of FILES) {
    const p = join(DATA_DIR, name);
    if (existsSync(p)) files[name] = readFileSync(p).toString('base64');
  }
  for (const [dir, isHistory] of Object.entries(DIRS)) {
    if (isHistory && !history) continue;
    Object.assign(files, readDir(dir));
  }

  const envelope = {
    prodmesh: 'backup',
    format: FORMAT,
    app: getVersion(),
    // The migration number this database is at. Restore compares against the
    // running build so a backup from the future is refused rather than
    // half-applied — migrations only ever run forward.
    schema: SCHEMA_VERSION,
    createdAt: Date.now(),
    history,
    files,
    db: snapshotDb({ history }),
  };
  return gzipSync(Buffer.from(JSON.stringify(envelope)), { level: 9 });
}

/**
 * Parse and vet a backup. Throws with something a person can act on — every
 * message here is read by someone whose server just died.
 */
export function readBackup(buf) {
  let envelope;
  try {
    envelope = JSON.parse(gunzipSync(buf).toString());
  } catch {
    throw new Error('That file is not a prodmesh backup, or it is damaged.');
  }
  if (envelope?.prodmesh !== 'backup') throw new Error('That file is not a prodmesh backup.');
  if (envelope.format !== FORMAT) {
    throw new Error(`This backup is format ${envelope.format}; this version reads format ${FORMAT}.`);
  }
  if (typeof envelope.db !== 'string' || !envelope.db) throw new Error('That backup has no database in it.');
  if (envelope.schema > SCHEMA_VERSION) {
    throw new Error(
      `This backup came from a newer prodmesh (database version ${envelope.schema}; this one is ${SCHEMA_VERSION}). ` +
      'Update prodmesh first, then restore.',
    );
  }
  return envelope;
}

/**
 * Write a backup over the data directory.
 *
 * The caller is responsible for refusing this on a configured installation —
 * see routes/system.js. A backup carries the admin PIN and every credential,
 * so on a box that is already set up this is not a restore, it is a takeover.
 *
 * Does NOT reload the running server. Module state all over the process was
 * built from the old database, and pretending otherwise would leave a
 * half-restored server that looks fine. The caller tells the operator to
 * restart, which is honest and cannot be subtly wrong.
 *
 * It does, however, have to SEAL the process first when the target is this
 * installation's own data directory — the restart the operator is about to
 * perform would otherwise write the old database back over the restored one.
 * restoreSeal.js has the mechanism; the order here is the fix. Seal (so
 * nothing reopens), close (so the WAL is checkpointed into the file we are
 * about to replace, not into the replacement), then write.
 */
export function restoreBackup(envelope, { dataDir = DATA_DIR } = {}) {
  const files = envelope.files ?? {};
  if (resolve(dataDir) === resolve(DATA_DIR)) {
    seal();
    closeDb();
  }
  mkdirSync(dataDir, { recursive: true });

  for (const [name, b64] of Object.entries(files)) {
    // Every path is rebuilt from vetted segments rather than trusted. A backup
    // is an uploaded file, and "../../etc/whatever" in a key would otherwise
    // write wherever it liked.
    const parts = name.split('/');
    if (parts.length > 2 || !parts.every(isSafeName)) continue;
    const target = join(dataDir, ...parts);
    mkdirSync(dirname(target), { recursive: true });
    const mode = RESTRICTED_MODE.get(name);
    writeFileSync(target, Buffer.from(b64, 'base64'), mode ? { mode } : undefined);
    if (mode) {
      // An existing file keeps its old mode through a write, so say it again —
      // exactly as secrets.js has to.
      try {
        chmodSync(target, mode);
      } catch {
        /* best effort — Windows and some mounts don't support it */
      }
    }
  }

  // The database last, and the sidecars removed with it: a stale -wal beside a
  // restored .db is a database with someone else's newest transactions in it.
  writeFileSync(join(dataDir, 'prodmesh.db'), Buffer.from(envelope.db, 'base64'));
  for (const sidecar of ['prodmesh.db-wal', 'prodmesh.db-shm']) {
    rmSync(join(dataDir, sidecar), { force: true });
  }

  return { files: Object.keys(files).length, history: Boolean(envelope.history) };
}
