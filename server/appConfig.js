// ─────────────────────────────────────────────────────────────────────────────
//  APP CONFIG  —  Admin-owned institution topology in SQLite (ADR 0009).
//
//  The tree the frontend renders (institution name → sites → rooms → Quick
//  Access tiles) lives in the sites / site_rooms / tiles tables and is served
//  by GET /api/config. Admin → Campuses edits it with a whole-tree save
//  (transactional replace, same pattern as checklist templates), so related
//  changes land atomically and the browser never carries its own topology.
//
//  Tile structure is relational; per-type leaf fields (host, url, username, …)
//  are a validated JSON blob per tile. Seeded once from topologySeed.js when
//  the tables are empty (fresh install / first boot after this feature).
// ─────────────────────────────────────────────────────────────────────────────
import { getDb } from './db.js';
import { validateChurch } from './validate.js';
import { seedChurch } from './topologySeed.js';
import { wantsDemoSeed } from './seedMode.js';

const INSTITUTION_KEY = 'institution';

/** The whole tree, shaped exactly like the frontend's Church type. */
export function getChurch() {
  const db = getDb();
  const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(INSTITUTION_KEY);
  const name = row ? JSON.parse(row.value).name : 'Production Dashboard';
  const sites = db.prepare('SELECT id, name, status, timezone FROM sites ORDER BY position').all();
  const rooms = db.prepare('SELECT id, site_id AS siteId, name FROM site_rooms ORDER BY position').all();
  const tiles = db.prepare('SELECT id, room_id AS roomId, type, label, note, icon, config FROM tiles ORDER BY position').all();

  return {
    name,
    sites: sites.map((site) => ({
      id: site.id,
      name: site.name,
      status: site.status,
      ...(site.timezone ? { timezone: site.timezone } : {}),
      auditoriums: rooms.filter((r) => r.siteId === site.id).map((room) => ({
        id: room.id,
        name: room.name,
        tiles: tiles.filter((t) => t.roomId === room.id).map((tile) => ({
          id: tile.id,
          type: tile.type,
          label: tile.label,
          ...(tile.note ? { note: tile.note } : {}),
          ...(tile.icon ? { icon: tile.icon } : {}),
          ...JSON.parse(tile.config),
        })),
      })),
    })),
  };
}

/** Validate + atomically replace the whole tree. Returns the stored result. */
export function replaceChurch(input) {
  const clean = validateChurch(input);
  const db = getDb();
  const oldZones = new Map(db.prepare('SELECT id, timezone FROM sites').all().map(s => [s.id, s.timezone]));
  db.transaction(() => {
    db.prepare('DELETE FROM tiles').run();
    db.prepare('DELETE FROM site_rooms').run();
    db.prepare('DELETE FROM sites').run();
    db.prepare(
      'INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(INSTITUTION_KEY, JSON.stringify({ name: clean.name }));

    const addSite = db.prepare('INSERT INTO sites (id, name, status, position, timezone) VALUES (?, ?, ?, ?, ?)');
    const addRoom = db.prepare('INSERT INTO site_rooms (id, site_id, name, position) VALUES (?, ?, ?, ?)');
    const addTile = db.prepare(
      'INSERT INTO tiles (id, room_id, type, label, note, icon, config, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    clean.sites.forEach((site, si) => {
      addSite.run(site.id, site.name, site.status, si, site.timezone ?? oldZones.get(site.id) ?? null);
      site.auditoriums.forEach((room, ri) => {
        addRoom.run(room.id, site.id, room.name, ri);
        room.tiles.forEach((tile, ti) => {
          const { id, type, label, note, icon, ...extras } = tile;
          addTile.run(id, room.id, type, label, note ?? null, icon ?? null, JSON.stringify(extras), ti);
        });
      });
    });
  })();
  return getChurch();
}

// Whether first boot installs the demo topology (the demo church's campuses,
// rooms and device IPs — the fixture every server test is built on) is the
// same question several stores ask, so it lives in seedMode.js. A church
// installing prodmesh must never inherit someone else's campuses, and the
// first-run wizard has nothing to do if a campus already exists.

// First boot: an existing installation keeps looking exactly the way its static
// config did. A fresh real install starts EMPTY, so setup can ask the church
// who they are rather than presenting them with someone else's campuses.
function seedIfEmpty() {
  const count = getDb().prepare('SELECT COUNT(*) AS n FROM sites').get().n;
  if (count > 0) return;
  if (wantsDemoSeed()) return replaceChurch(seedChurch);
  console.log('[config] fresh install — no campuses yet; run first-time setup');
}

seedIfEmpty();
