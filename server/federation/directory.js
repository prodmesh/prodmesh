// ─────────────────────────────────────────────────────────────────────────────
//  THE DIRECTORY  —  which campuses and rooms a server runs (ADR 0018).
//
//  Ours, built for a peer to fetch; theirs, cached for the All Campuses view.
//  No network here: link.js fetches, this validates and stores.
//
//  What goes out is names and ids of ACTIVE campuses and their rooms, and the
//  address a browser opens us at. Nothing a peer could use to reach a device:
//  no tiles, no hosts, no integration config (ADR 0016).
//
//  What comes in is untrusted (ADR 0016: assume the peer is compromised), so
//  it is rebuilt field by field from a fixed shape, with every string and
//  count capped, rather than stored as sent.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import { getDb } from '../db.js';
import { getChurch } from '../appConfig.js';
import { dashboardUrl, normalizeDashboardUrl } from './store.js';

export const MAX_CAMPUSES = 32;
export const MAX_ROOMS = 64; // per campus
const MAX_NAME = 80;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

// ── Ours ─────────────────────────────────────────────────────────────────────

/** What this server runs, as a peer sees it. `revision` changes iff the rest does. */
export function localDirectory() {
  const campuses = getChurch().sites
    .filter((site) => site.status === 'active')
    .map((site) => ({
      id: site.id,
      name: site.name,
      rooms: site.auditoriums.map((room) => ({ id: room.id, name: room.name })),
    }));
  const body = { dashboardUrl: dashboardUrl(), campuses };
  return { revision: hash(body), ...body };
}

/** The ids of every room we publish — the digest covers exactly these. */
export const localRoomIds = (dir = localDirectory()) => dir.campuses.flatMap((c) => c.rooms.map((r) => r.id));

// ── Theirs ───────────────────────────────────────────────────────────────────

const name = (v) => {
  const s = typeof v === 'string' ? v.trim().slice(0, MAX_NAME) : '';
  return s || null;
};

/**
 * A peer's directory, rebuilt from a fixed shape. Throws on anything that is
 * not recognisably a directory; drops individual entries that are malformed,
 * so one bad room name does not blank a whole campus.
 */
export function validateDirectory(body) {
  if (!body || typeof body !== 'object') throw new Error('not a directory');
  const revision = typeof body.revision === 'string' && /^[A-Za-z0-9]{1,64}$/.test(body.revision) ? body.revision : null;
  if (!revision) throw new Error('directory has no revision');
  if (!Array.isArray(body.campuses)) throw new Error('directory has no campuses');
  const seen = new Set();
  const campuses = [];
  for (const c of body.campuses.slice(0, MAX_CAMPUSES)) {
    if (!c || !ID.test(c.id ?? '') || !name(c.name)) continue;
    const rooms = [];
    for (const r of Array.isArray(c.rooms) ? c.rooms.slice(0, MAX_ROOMS) : []) {
      // Room ids are unique across a server (they key its rooms map), so a
      // duplicate is a malformed directory, not a second room.
      if (!r || !ID.test(r.id ?? '') || !name(r.name) || seen.has(r.id)) continue;
      seen.add(r.id);
      rooms.push({ id: r.id, name: name(r.name) });
    }
    campuses.push({ id: c.id, name: name(c.name), rooms });
  }
  return { revision, dashboardUrl: normalizeDashboardUrl(body.dashboardUrl), campuses };
}

export function storeDirectory(systemId, dir) {
  getDb().prepare(`
    INSERT INTO federation_directory (system_id, revision, body, fetched_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(system_id) DO UPDATE SET revision = excluded.revision, body = excluded.body, fetched_at = excluded.fetched_at
  `).run(systemId, dir.revision, JSON.stringify(dir), Date.now());
}

export function getDirectory(systemId) {
  const row = getDb().prepare('SELECT body, fetched_at FROM federation_directory WHERE system_id = ?').get(systemId);
  return row ? { ...JSON.parse(row.body), fetchedAt: row.fetched_at } : null;
}

export const directoryRevision = (systemId) => getDb()
  .prepare('SELECT revision FROM federation_directory WHERE system_id = ?').get(systemId)?.revision ?? null;

/** Every paired server's last directory, for the browser. No addresses, no
 *  fingerprints: anyone who can see this dashboard sees this (ADR 0018). */
export function remoteServers() {
  const rows = getDb().prepare(`
    SELECT p.system_id, p.name, p.last_seen_at, p.last_error, d.body, d.fetched_at
      FROM federation_peers p JOIN federation_directory d ON d.system_id = p.system_id
     WHERE p.state = 'paired'
     ORDER BY p.name
  `).all();
  return rows.map((row) => {
    const dir = JSON.parse(row.body);
    return {
      systemId: row.system_id,
      name: row.name,
      dashboardUrl: dir.dashboardUrl,
      reachable: !row.last_error && Boolean(row.last_seen_at),
      lastSeenAt: row.last_seen_at,
      fetchedAt: row.fetched_at,
      campuses: dir.campuses,
    };
  });
}
