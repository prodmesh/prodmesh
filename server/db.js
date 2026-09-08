// ─────────────────────────────────────────────────────────────────────────────
//  SQLITE  —  authoritative runtime state and configuration.
//
//  Per ADR 0009: server-managed config and operational facts live here; JSON
//  is a portable import/export format rather than the live source of truth.
//  Still just a file on the LAN box — zero ops, with explicit backup planned.
//  WAL mode: writes don't block reads, and the single-writer process model
//  (ADR 0004) means no contention.
//
//  Migrations are versioned via PRAGMA user_version: each entry in MIGRATIONS
//  runs once, in order, inside its own transaction, and the version advances
//  with it — a crash mid-step rolls the whole step back. Rules:
//    - NEVER edit a shipped migration; append a new one.
//    - Databases from before versioning (user_version 0 with the full schema)
//      upgrade cleanly because the baseline DDL is idempotent.
// ─────────────────────────────────────────────────────────────────────────────

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { assertNotSealed } from './restoreSeal.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.PRODMESH_DATA_DIR ?? join(__dirname, 'data');

let db = null;

export function getDb() {
  // After a restore this database is a file that no longer exists as far as
  // this process is concerned. Reopening it would write the old install's
  // pages back over the restored ones — see restoreSeal.js.
  assertNotSealed();
  if (db) return db;
  mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(join(DATA_DIR, 'prodmesh.db'));
  db.pragma('journal_mode = WAL');
  migrate(db);
  return db;
}

/**
 * Close the connection and forget it.
 *
 * Only the restore needs this, and it needs it BEFORE the file is overwritten:
 * closing afterwards is precisely the operation that undoes a restore, because
 * better-sqlite3 checkpoints the WAL into whatever is at that path by then.
 */
export function closeDb() {
  if (!db) return;
  db.close();
  db = null;
}

// Add a column to an existing table if a migration introduced it later.
function addColumn(d, table, column, decl) {
  const has = d.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`).get(table, column);
  if (!has) d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

const MIGRATIONS = [
  {
    name: 'baseline',
    up(d) {
      d.exec(`
        CREATE TABLE IF NOT EXISTS spl_samples (
          room_id     TEXT    NOT NULL,
          instance_id TEXT    NOT NULL, -- planId__timeId (same key as timelines)
          ts          INTEGER NOT NULL, -- ms since epoch
          spl         REAL    NOT NULL  -- dB SPL (A-weighted, slow)
        );
        CREATE INDEX IF NOT EXISTS spl_by_instance ON spl_samples (instance_id, ts);

        -- Startup checklist run state, per event (planId — per service, not per
        -- service time). Templates live in data/checklists.json; a row here means
        -- the item is done.
        CREATE TABLE IF NOT EXISTS checklist_state (
          room_id TEXT NOT NULL,
          plan_id TEXT NOT NULL,
          item_id TEXT NOT NULL,
          done_at INTEGER NOT NULL,
          PRIMARY KEY (room_id, plan_id, item_id)
        );

        -- Per-event show automation config (set on the Event Detail page):
        -- which PC item autostarts the show, which one auto-completes it (at its
        -- last slide), and manual PC→PP mapping overrides. JSON blob; per event
        -- like checklist_state, and disposable with it.
        CREATE TABLE IF NOT EXISTS show_config (
          room_id    TEXT    NOT NULL,
          plan_id    TEXT    NOT NULL,
          config     TEXT    NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (room_id, plan_id)
        );

        -- Institution topology (ADR 0009): what the frontend used to compile in as
        -- dashboard.config.ts. Seeded once from server/topologySeed.js, then owned
        -- by Admin → Campuses. Tiles keep per-type fields (host/url/username/…) in
        -- a validated JSON blob; the tree structure itself is relational.
        CREATE TABLE IF NOT EXISTS app_config (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sites (
          id       TEXT PRIMARY KEY,
          name     TEXT NOT NULL,
          status   TEXT NOT NULL DEFAULT 'active',
          position INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS site_rooms (
          id       TEXT PRIMARY KEY,
          site_id  TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
          name     TEXT NOT NULL,
          position INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS tiles (
          id       TEXT PRIMARY KEY,
          room_id  TEXT NOT NULL REFERENCES site_rooms(id) ON DELETE CASCADE,
          type     TEXT NOT NULL,
          label    TEXT NOT NULL,
          note     TEXT,
          icon     TEXT,
          config   TEXT NOT NULL DEFAULT '{}',
          position INTEGER NOT NULL
        );

        -- Per-room integration connectivity (ADR 0009, migrating out of
        -- rooms.config.js one integration at a time). config is a validated JSON
        -- blob per integration; rooms.config.js becomes the first-boot seed for
        -- integrations that have migrated.
        CREATE TABLE IF NOT EXISTS room_connectivity (
          room_id     TEXT NOT NULL,
          integration TEXT NOT NULL,
          config      TEXT NOT NULL,
          updated_at  INTEGER NOT NULL,
          PRIMARY KEY (room_id, integration)
        );

        -- Browser installation identity. The token is stored as a SHA-256 hash;
        -- the browser keeps the secret token. A station says WHERE an action came
        -- from, while a user session says WHO authorized it.
        CREATE TABLE IF NOT EXISTS stations (
          id         TEXT PRIMARY KEY,
          name       TEXT NOT NULL,
          campus_id  TEXT,
          room_id    TEXT,
          token_hash TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL,
          last_seen  INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS users (
          id                        TEXT PRIMARY KEY,
          username                  TEXT NOT NULL UNIQUE COLLATE NOCASE,
          display_name              TEXT NOT NULL,
          pin_hash                  TEXT NOT NULL,
          planning_center_person_id TEXT,
          active                    INTEGER NOT NULL DEFAULT 1,
          created_at                INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS permission_groups (
          id         TEXT PRIMARY KEY,
          name       TEXT NOT NULL UNIQUE,
          system_key TEXT UNIQUE,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS permissions (
          id          TEXT PRIMARY KEY,
          label       TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS user_groups (
          user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          group_id TEXT NOT NULL REFERENCES permission_groups(id) ON DELETE CASCADE,
          PRIMARY KEY (user_id, group_id)
        );

        CREATE TABLE IF NOT EXISTS group_permissions (
          group_id      TEXT NOT NULL REFERENCES permission_groups(id) ON DELETE CASCADE,
          permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
          PRIMARY KEY (group_id, permission_id)
        );

        CREATE TABLE IF NOT EXISTS user_sessions (
          token_hash TEXT PRIMARY KEY,
          user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          station_id TEXT REFERENCES stations(id) ON DELETE SET NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS sessions_by_expiry ON user_sessions (expires_at);

        CREATE TABLE IF NOT EXISTS audit_log (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          ts            INTEGER NOT NULL,
          user_id       TEXT,
          station_id    TEXT,
          action        TEXT NOT NULL,
          resource_type TEXT,
          resource_id   TEXT,
          room_id       TEXT,
          plan_id       TEXT,
          result        TEXT NOT NULL,
          details       TEXT
        );
        CREATE INDEX IF NOT EXISTS audit_by_time ON audit_log (ts DESC);
      `);
    },
  },
  {
    // Early builds of the sites table used status 'coming-soon'; the model is
    // now simply active/disabled. Was a per-boot repair before versioning.
    name: 'sites-status-active-disabled',
    up(d) {
      d.exec(`UPDATE sites SET status = 'disabled' WHERE status = 'coming-soon'`);
    },
  },
  {
    // C-A ratio (dB) captured alongside SPL when the analysis source provides
    // it (ProdMesh Remote RTA does; Smaart doesn't). High C-A = bass-heavy mix.
    name: 'spl-samples-ca',
    up(d) {
      addColumn(d, 'spl_samples', 'ca', 'REAL');
    },
  },
  {
    // One row per recorded show: the pre-aggregated facts the Analytics
    // history view needs, written when a show ends (and backfilled from the
    // JSON timelines at boot). The per-item timeline JSON stays authoritative
    // for the detailed report; this is its indexed summary. `spl` is the
    // aggregated JSON block ({count, leq, peak, from, to, ca}) — the room's
    // target/limit are applied at read time so they track current settings.
    name: 'show-summaries',
    up(d) {
      d.exec(`
        CREATE TABLE IF NOT EXISTS show_summaries (
          instance_id       TEXT PRIMARY KEY, -- planId__timeId
          room_id           TEXT,
          plan_id           TEXT,
          time_id           TEXT,
          plan_title        TEXT,
          service_type_name TEXT,
          dates             TEXT,
          time_name         TEXT,
          time_starts_at    TEXT,
          started_at        INTEGER,
          completed_at      INTEGER,
          item_count        INTEGER NOT NULL DEFAULT 0,
          planned_seconds   INTEGER NOT NULL DEFAULT 0,
          actual_seconds    INTEGER NOT NULL DEFAULT 0,
          spl               TEXT,
          updated_at        INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS summaries_by_start ON show_summaries (started_at DESC);
      `);
    },
  },
  {
    // A station assigned to a room can be pinned to it: while nobody is
    // logged in (read-only mode), the UI limits browsing to that room. A
    // kiosk-focus setting, not a security boundary — station identity is
    // browser-held and registration is open by design.
    name: 'stations-room-only',
    up(d) {
      addColumn(d, 'stations', 'room_only', 'INTEGER NOT NULL DEFAULT 0');
    },
  },

  {
    // YouTube Live concurrent viewers, sampled while a show is live.
    //
    // Its own table rather than a column on spl_samples: the two have
    // different sources, different cadences (~1/s vs ~1/30s) and either can be
    // configured without the other, so sharing rows would mean mostly-null
    // columns on both sides. Keyed by the same instance_id as timelines and
    // spl_samples so the report joins all three for free.
    //
    // This table is the ONLY record of the curve — YouTube drops
    // concurrentViewers the moment a broadcast ends.
    name: 'stream-samples',
    up(d) {
      d.exec(`
        CREATE TABLE IF NOT EXISTS stream_samples (
          room_id     TEXT    NOT NULL,
          instance_id TEXT    NOT NULL, -- planId__timeId (same key as timelines)
          ts          INTEGER NOT NULL, -- ms since epoch
          viewers     INTEGER NOT NULL  -- concurrent viewers reported by YouTube
        );
        CREATE INDEX IF NOT EXISTS idx_stream_samples_instance
          ON stream_samples (instance_id, ts);
      `);
      // The aggregate lives on the summary row too, so a report still shows
      // peak/average viewers after the raw samples age out — and because
      // YouTube cannot re-supply them, this ends up being the last copy.
      addColumn(d, 'show_summaries', 'stream', 'TEXT');
    },
  },

  {
    // Views: a room's dashboards (interactive, 6 columns, rows grow) and
    // displays (read-only, a hard 3×3 that must fit a screen — it is a tile on
    // a video multiview, where a scrollbar is a fault). One layout engine,
    // parameterised by (columns, max_rows); those are STORED rather than
    // derived from `kind` at read time, so a future 4×2 display is data rather
    // than a migration.
    //
    // room_id has NO FOREIGN KEY, deliberately, and the same goes for
    // show_config, room_connectivity, checklist_state and stations.room_id.
    // Admin → Campuses saves the whole topology by DELETE-ing and reinserting
    // site_rooms (appConfig.js), including for a pure rename — so ON DELETE
    // CASCADE would wipe every dashboard in the church the day someone renames
    // a campus. It does not today only because PRAGMA foreign_keys is never
    // set (db.js opens with WAL and nothing else), which means the FK on
    // view_id below is documentation too: deleteView() removes placements
    // explicitly, inside the transaction.
    //
    // A view whose room is gone is orphaned, not reaped — re-adding the room
    // with the same id gets its views back, and listViews() filters against
    // the live rooms map so orphans are invisible meanwhile.
    name: 'views',
    up(d) {
      d.exec(`
        CREATE TABLE IF NOT EXISTS views (
          id         TEXT PRIMARY KEY,       -- crypto.randomUUID()
          room_id    TEXT    NOT NULL,       -- site_rooms.id, unenforced (see above)
          kind       TEXT    NOT NULL CHECK (kind IN ('dashboard','display')),
          name       TEXT    NOT NULL,
          slug       TEXT    NOT NULL,       -- the URL key; stable id for a kiosk
          columns    INTEGER NOT NULL CHECK (columns BETWEEN 1 AND 12),
          max_rows   INTEGER CHECK (max_rows IS NULL OR max_rows BETWEEN 1 AND 24),
          position   INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS views_room_slug ON views (room_id, slug);
        CREATE INDEX IF NOT EXISTS views_by_room ON views (room_id, kind, position);

        CREATE TABLE IF NOT EXISTS view_widgets (
          id       TEXT PRIMARY KEY,
          view_id  TEXT    NOT NULL REFERENCES views(id) ON DELETE CASCADE,
          type     TEXT    NOT NULL,
          x        INTEGER NOT NULL CHECK (x >= 0),
          y        INTEGER NOT NULL CHECK (y >= 0),
          w        INTEGER NOT NULL CHECK (w >= 1),
          h        INTEGER NOT NULL CHECK (h >= 1),
          config   TEXT    NOT NULL DEFAULT '{}',
          position INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS view_widgets_by_view ON view_widgets (view_id, position);
      `);
    },
  },

  {
    // A station may render one view full-screen — a Raspberry Pi wired into a
    // video multiview, a lobby TV. Nullable and unenforced: unassigned is the
    // normal state, and deleting a view must leave the station alone rather
    // than taking it down with it. The display route treats a dangling id the
    // same as none.
    name: 'stations-view',
    up(d) {
      addColumn(d, 'stations', 'view_id', 'TEXT');
    },
  },

  {
    // How far to magnify a display.
    //
    // A 3x3 laid out on a booth monitor is legible; the same pixels as one
    // tile of a video wall are not — the whole grid ends up a few hundred
    // pixels across, and type sized for a desk disappears. Per VIEW rather
    // than global because the screens differ: a foyer TV and a multiview tile
    // are not the same problem.
    name: 'views-scale',
    up(d) {
      addColumn(d, 'views', 'scale', 'REAL NOT NULL DEFAULT 1');
    },
  },
  {
    // A row used to BE one instantaneous reading, so `spl` was also the peak.
    // Once fast analyzers (ProdMesh RTA at 20 Hz) began arriving, a row became
    // one second of energy-averaged samples — and a snare hit or a feedback
    // squeal averaged away, understating the reported peak by ~10 dB. `peak`
    // carries the loudest sample in that second alongside its Leq.
    //
    // Readers use `peak ?? spl`, which is right for both eras: pre-aggregation
    // rows have no peak, and their single instantaneous `spl` IS the peak.
    name: 'spl-samples-peak',
    up(d) {
      addColumn(d, 'spl_samples', 'peak', 'REAL');
    },
  },
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** Bring a database up to the current schema version. Exported for tests. */
export function migrate(d) {
  let version = d.pragma('user_version', { simple: true });
  if (version > MIGRATIONS.length) {
    throw new Error(
      `Database schema version ${version} is newer than this build understands ` +
        `(${MIGRATIONS.length}) — was the data directory used by a newer prodmesh?`,
    );
  }
  while (version < MIGRATIONS.length) {
    const step = MIGRATIONS[version];
    const next = version + 1;
    d.transaction(() => {
      step.up(d);
      d.pragma(`user_version = ${next}`);
    })();
    console.log(`[db] migration ${next}/${MIGRATIONS.length}: ${step.name}`);
    version = next;
  }
}
