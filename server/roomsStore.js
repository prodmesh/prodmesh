// ─────────────────────────────────────────────────────────────────────────────
//  ROOMS STORE  —  the live per-room server map, built from SQLite.
//
//  Room identity (id, name, site) comes from the site_rooms topology table
//  (Admin → Campuses); integration config comes from room_connectivity
//  (applied over these objects by connectivity.js). rooms.config.js
//  contributes only fresh-install seeds plus the PRODMESH_LOCAL_TEST dev
//  fixture — creating a room in the browser makes it a real server room with
//  endpoints, connectivity, and watchers, no file edit or redeploy.
//
//  The exported `rooms` object keeps a stable identity: rebuilds mutate it in
//  place (add / update / remove keys), so every consumer holding the map —
//  and every watcher that re-reads `rooms[roomId]` per cycle — stays current.
// ─────────────────────────────────────────────────────────────────────────────
import { getDb } from './db.js';
import './appConfig.js'; // topology seeding must run before the first build
import { rooms as seedRooms } from './rooms.config.js';

export const rooms = Object.create(null);

// A room the seed file doesn't know starts simulated with the standard mode
// set; the room configuration page takes it from there (connectivity.js
// overwrites these keys from the database on apply).
function makeRoom(row, seed) {
  const base = seed
    ? structuredClone(seed)
    : { mock: true, companion: {}, state: { variable: 'roomState' }, roomMode: false, modes: [] };
  return { ...base, id: row.id, name: row.name, site: row.siteId };
}

/** (Re)build the map from the topology tables; call after every topology save
 *  (followed by connectivity.applyConnectivity() and show.syncAutomation()). */
export function rebuildRooms() {
  const rows = getDb()
    .prepare('SELECT id, site_id AS siteId, name FROM site_rooms ORDER BY position')
    .all();
  const wanted = new Set(rows.map((r) => r.id));

  for (const row of rows) {
    const existing = rooms[row.id];
    if (existing) {
      existing.name = row.name;
      existing.site = row.siteId;
    } else {
      rooms[row.id] = makeRoom(row, seedRooms[row.id]);
    }
  }

  // Dev fixture rooms exist without a topology row (and can't be deleted).
  for (const seed of Object.values(seedRooms)) {
    if (!seed.devFixture) continue;
    wanted.add(seed.id);
    if (!rooms[seed.id]) rooms[seed.id] = structuredClone(seed);
  }

  for (const id of Object.keys(rooms)) {
    if (!wanted.has(id)) delete rooms[id];
  }
}

rebuildRooms();
