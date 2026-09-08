import crypto from 'node:crypto';
import { getDb } from './db.js';

export const PERMISSIONS = [
  ['checklists.complete', 'Complete checklist items', 'Check or reopen startup checklist items.'],
  ['checklists.templates.edit', 'Edit checklist templates', 'Create and change checklist templates.'],
  ['rooms.mode.change', 'Change room modes', 'Change the active production mode for a room.'],
  ['rooms.mode.override_lock', 'Override protected modes', 'Bypass a scheduled room-mode lockout.'],
  ['shows.operate', 'Operate shows', 'Start, end, and manually follow a show.'],
  ['shows.configure', 'Configure show automation', 'Edit ProPresenter mappings and automation.'],
  ['propresenter.control', 'Control ProPresenter', 'Trigger ProPresenter slides and playlist items from an approved dashboard widget.'],
  ['history.delete', 'Delete recorded shows', 'Remove a recorded run of show (and its timing/loudness data) from history.'],
  ['reports.view', 'View reports', 'View completed show reports and analytics.'],
  ['settings.manage', 'Manage settings', 'Edit operational settings and schedules.'],
  ['users.manage', 'Manage users', 'Create users and assign permission groups.'],
  ['stations.manage', 'Manage stations', 'Rename, assign, and revoke registered browser stations.'],
  ['system.update', 'Run system updates', 'Install a prodmesh system update.'],
  ['system.logs', 'View logs', 'Read the server process log and the audit trail.'],
  ['config.manage', 'Manage campuses & tiles', 'Edit the institution name, sites, and Quick Access tiles.'],
  ['system.backup', 'Download backups', 'Download a full backup — it carries the Planning Center token, every PIN and every credential, so it is as sensitive as the server itself.'],
  ['views.edit', 'Edit dashboards & displays', 'Create, lay out, and delete a room’s dashboards and display screens.'],
];

const SESSION_TTL = 8 * 60 * 60 * 1000;

const id = () => crypto.randomUUID();
const digest = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const normalizePcPersonId = (value) => String(value ?? '').trim().replace(/^P(?=\d+$)/i, '');

function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pin), salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPin(pin, stored) {
  if (!pin || !stored) return false;
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const actual = crypto.scryptSync(String(pin), Buffer.from(saltHex, 'hex'), 32);
  const expected = Buffer.from(hashHex, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function initialize() {
  const db = getDb();
  const now = Date.now();
  const seedPermission = db.prepare(
    'INSERT INTO permissions (id, label, description) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET label=excluded.label, description=excluded.description',
  );
  const seed = db.transaction(() => {
    for (const p of PERMISSIONS) seedPermission.run(...p);
    db.prepare(
      `INSERT INTO permission_groups (id, name, system_key, created_at)
       VALUES ('group-admin', 'Administrators', 'admin', ?)
       ON CONFLICT(id) DO NOTHING`,
    ).run(now);
  });
  seed();
}

export function registerStation({ name, campusId = null, roomId = null }) {
  const clean = String(name ?? '').trim();
  if (clean.length < 2 || clean.length > 80) throw new Error('Station name must be 2–80 characters');
  const stationId = id();
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  getDb().prepare(
    'INSERT INTO stations (id, name, campus_id, room_id, token_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(stationId, clean, campusId, roomId, digest(token), now, now);
  return { id: stationId, name: clean, campusId, roomId, roomOnly: false, token };
}

export function resolveStation(token) {
  if (!token) return null;
  // LEFT JOIN, not a second query: a display station's whole job is to render
  // one view, and the browser needs its slug on the very first request to know
  // where to send itself. The join also makes a deleted view read as no
  // assignment rather than a dangling id.
  const row = getDb().prepare(
    `SELECT s.id, s.name, s.campus_id AS campusId, s.room_id AS roomId, s.room_only AS roomOnly,
            v.id AS viewId, v.slug AS viewSlug, v.kind AS viewKind
       FROM stations s
       LEFT JOIN views v ON v.id = s.view_id
      WHERE s.token_hash = ?`,
  ).get(digest(token));
  if (row) getDb().prepare('UPDATE stations SET last_seen = ? WHERE id = ?').run(Date.now(), row.id);
  return row
    ? {
        ...row,
        roomOnly: Boolean(row.roomOnly),
        viewId: row.viewId ?? null,
        viewSlug: row.viewSlug ?? null,
        viewKind: row.viewKind ?? null,
      }
    : null;
}

export function listStations() {
  return getDb().prepare(
    `SELECT s.id, s.name, s.campus_id AS campusId, s.room_id AS roomId, s.room_only AS roomOnly,
            s.created_at AS createdAt, s.last_seen AS lastSeen,
            v.id AS viewId, v.slug AS viewSlug, v.name AS viewName
       FROM stations s
       LEFT JOIN views v ON v.id = s.view_id
      ORDER BY s.name COLLATE NOCASE`,
  ).all().map((row) => ({
    ...row,
    roomOnly: Boolean(row.roomOnly),
    viewId: row.viewId ?? null,
    viewSlug: row.viewSlug ?? null,
    viewName: row.viewName ?? null,
  }));
}

export function updateStation(
  stationId,
  { name, campusId = null, roomId = null, roomOnly = false, viewId = null },
) {
  const clean = String(name ?? '').trim();
  if (clean.length < 2 || clean.length > 80) throw new Error('Station name must be 2–80 characters');
  // A display belongs to the room the station is standing in. Assigning one
  // from another room would put a screen in the foyer showing the youth room's
  // service — the caller has no way to notice, so refuse it here.
  if (viewId) {
    const view = getDb().prepare('SELECT room_id AS roomId, kind FROM views WHERE id = ?').get(viewId);
    if (!view) throw new Error('Unknown view');
    if (view.kind !== 'display') throw new Error('Only a display can be assigned to a station');
    if (!roomId || view.roomId !== roomId) throw new Error('That display belongs to another room');
  }
  // roomOnly is meaningless without a room assignment — never persist it alone.
  const result = getDb().prepare(
    'UPDATE stations SET name = ?, campus_id = ?, room_id = ?, room_only = ?, view_id = ? WHERE id = ?',
  ).run(clean, campusId || null, roomId || null, roomId && roomOnly ? 1 : 0, viewId || null, stationId);
  if (!result.changes) throw new Error('Unknown station');
  return listStations().find((station) => station.id === stationId);
}

export function revokeStation(stationId) {
  const db = getDb();
  const station = listStations().find((entry) => entry.id === stationId);
  if (!station) throw new Error('Unknown station');
  db.transaction(() => {
    db.prepare('DELETE FROM user_sessions WHERE station_id = ?').run(stationId);
    db.prepare('DELETE FROM stations WHERE id = ?').run(stationId);
  })();
  return station;
}

function permissionsFor(userId) {
  const rows = getDb().prepare(
    `SELECT pg.system_key AS systemKey, gp.permission_id AS permission
       FROM user_groups ug
       JOIN permission_groups pg ON pg.id = ug.group_id
       LEFT JOIN group_permissions gp ON gp.group_id = pg.id
      WHERE ug.user_id = ?`,
  ).all(userId);
  if (rows.some((r) => r.systemKey === 'admin')) return ['*'];
  return [...new Set(rows.map((r) => r.permission).filter(Boolean))].sort();
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name ?? row.displayName,
    planningCenterPersonId: row.planning_center_person_id ?? row.planningCenterPersonId ?? null,
  };
}

export function authenticate(username, pin, stationId = null) {
  const row = getDb().prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE AND active = 1').get(String(username ?? '').trim());
  if (!row || !verifyPin(pin, row.pin_hash)) return null;
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  getDb().prepare(
    'INSERT INTO user_sessions (token_hash, user_id, station_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
  ).run(digest(token), row.id, stationId, now, now + SESSION_TTL);
  return { token, user: publicUser(row), permissions: permissionsFor(row.id) };
}

export function resolveSession(token) {
  if (!token) return null;
  const row = getDb().prepare(
    `SELECT s.expires_at, u.* FROM user_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND u.active = 1`,
  ).get(digest(token));
  if (!row) return null;
  if (row.expires_at <= Date.now()) {
    getDb().prepare('DELETE FROM user_sessions WHERE token_hash = ?').run(digest(token));
    return null;
  }
  return { user: publicUser(row), permissions: permissionsFor(row.id) };
}

export function destroySession(token) {
  if (token) getDb().prepare('DELETE FROM user_sessions WHERE token_hash = ?').run(digest(token));
}

// ── The built-in administrator ───────────────────────────────────────────────
//
//  The admin PIN used to be a second, parallel way to be authorized: it minted
//  a process-local token that set `req.legacyAdmin`, which short-circuited
//  EVERY permission check. Two consequences, neither of them intended.
//
//    • Nothing could say WHO did an admin thing. Audit rows carried a station
//      and no user, so "who ran the update" had no answer.
//    • The one credential everybody in a church actually knows could not be
//      typed into the login box, because it was not an account. You reached it
//      through a separate door on the Admin page — which is exactly the
//      inconsistency this replaces.
//
//  So the PIN is now the password of a real account. `settings.json` stays its
//  source of truth (that file is what somebody edits on the server when the
//  PIN is forgotten, and the restore seal covers it), and this account is a
//  PROJECTION of it: the stored hash is copied across verbatim, which is
//  possible because both sides have always hashed PINs identically — scrypt,
//  16-byte salt, 32-byte key, `salt:hash` in hex. Nobody re-enters anything,
//  and an install that upgrades into this simply finds the account there.

export const ADMIN_USERNAME = 'admin';
export const ADMIN_DISPLAY_NAME = 'System Administrator';
const ADMIN_GROUP = 'group-admin';

export const adminUser = () =>
  getDb().prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(ADMIN_USERNAME) ?? null;

/**
 * Make the built-in admin account match the stored PIN hash, creating it if
 * this install predates it. Idempotent, and cheap enough to run at every boot
 * and after every PIN change — which together are the only two moments the
 * hash can move.
 *
 * A credential that MOVED takes its sessions with it. Rotating the admin PIN
 * is what somebody does when they think it leaked, and a rotation that leaves
 * the old session alive for the rest of its eight hours answers the wrong
 * question. The cost is that an administrator changing their own PIN is signed
 * out — correct, and the same thing every password change does.
 *
 * A null hash means no admin PIN is set: a fresh install mid-wizard, or one
 * where an administrator deliberately cleared it. The account is DEACTIVATED
 * rather than deleted — audit history points at it — and deactivated really
 * does mean shut: `authenticate` and `resolveSession` both require active = 1,
 * so the last PIN stops working the moment it is cleared.
 */
export function projectAdminAccount(pinHash) {
  const db = getDb();
  const existing = adminUser();
  const dropSessions = (userId) =>
    db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(userId);

  if (!pinHash) {
    if (!existing?.active) return existing ? getUser(existing.id) : null;
    db.transaction(() => {
      db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(existing.id);
      dropSessions(existing.id);
    })();
    return getUser(existing.id);
  }

  const userId = existing?.id ?? id();
  const moved = !existing || existing.pin_hash !== pinHash || !existing.active;
  db.transaction(() => {
    if (existing) {
      if (moved) {
        db.prepare('UPDATE users SET pin_hash = ?, active = 1 WHERE id = ?').run(pinHash, userId);
        dropSessions(userId);
      }
    } else {
      db.prepare(
        'INSERT INTO users (id, username, display_name, pin_hash, planning_center_person_id, created_at) VALUES (?, ?, ?, ?, NULL, ?)',
      ).run(userId, ADMIN_USERNAME, ADMIN_DISPLAY_NAME, pinHash, Date.now());
    }
    // Membership is re-asserted rather than assumed: this account exists to be
    // the way back in, so it may not be left in the building without keys.
    db.prepare('INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)').run(userId, ADMIN_GROUP);
  })();
  return getUser(userId);
}

export function hasPermission(session, permission) {
  return Boolean(session?.permissions?.includes('*') || session?.permissions?.includes(permission));
}

export function createUser({ username, displayName, pin, planningCenterPersonId = null, groupIds = [] }) {
  const uname = String(username ?? '').trim();
  const display = String(displayName ?? '').trim();
  const pcPersonId = normalizePcPersonId(planningCenterPersonId);
  if (!/^[a-z0-9._-]{2,40}$/i.test(uname)) throw new Error('Username must be 2–40 letters, numbers, dots, dashes, or underscores');
  if (display.length < 2 || display.length > 80) throw new Error('Display name must be 2–80 characters');
  if (String(pin ?? '').length < 4) throw new Error('PIN must be at least 4 characters');
  if (pcPersonId && !/^\d+$/.test(pcPersonId)) throw new Error('Planning Center person ID must be numeric');
  const userId = id();
  const db = getDb();
  const duplicatePcUser = pcPersonId
    ? db.prepare('SELECT username, planning_center_person_id AS personId FROM users WHERE planning_center_person_id IS NOT NULL').all()
      .find((row) => normalizePcPersonId(row.personId) === pcPersonId)
    : null;
  if (duplicatePcUser) throw new Error(`Planning Center person is already assigned to @${duplicatePcUser.username}`);
  db.transaction(() => {
    db.prepare(
      'INSERT INTO users (id, username, display_name, pin_hash, planning_center_person_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(userId, uname, display, hashPin(pin), pcPersonId || null, Date.now());
    const add = db.prepare('INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)');
    for (const groupId of groupIds) add.run(userId, groupId);
  })();
  return getUser(userId);
}

export function getUser(userId) {
  const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!row) return null;
  const groups = getDb().prepare(
    `SELECT pg.id, pg.name, pg.system_key AS systemKey FROM user_groups ug
      JOIN permission_groups pg ON pg.id = ug.group_id WHERE ug.user_id = ? ORDER BY pg.name`,
  ).all(userId);
  return { ...publicUser(row), active: Boolean(row.active), groups, permissions: permissionsFor(userId) };
}

export function listDirectory() {
  const db = getDb();
  const users = db.prepare('SELECT id FROM users ORDER BY display_name').all().map((r) => getUser(r.id));
  const groups = db.prepare('SELECT id, name, system_key AS systemKey FROM permission_groups ORDER BY name').all().map((group) => ({
    ...group,
    permissions: group.systemKey === 'admin'
      ? ['*']
      : db.prepare('SELECT permission_id FROM group_permissions WHERE group_id = ? ORDER BY permission_id').all(group.id).map((r) => r.permission_id),
  }));
  const permissions = db.prepare('SELECT id, label, description FROM permissions ORDER BY id').all();
  return { users, groups, permissions };
}

export function createGroup({ name, permissions = [] }) {
  const clean = String(name ?? '').trim();
  if (clean.length < 2 || clean.length > 60) throw new Error('Group name must be 2–60 characters');
  const allowed = new Set(PERMISSIONS.map(([permission]) => permission));
  if (!permissions.every((permission) => allowed.has(permission))) throw new Error('Unknown permission');
  const groupId = id();
  const db = getDb();
  db.transaction(() => {
    db.prepare('INSERT INTO permission_groups (id, name, created_at) VALUES (?, ?, ?)').run(groupId, clean, Date.now());
    const add = db.prepare('INSERT INTO group_permissions (group_id, permission_id) VALUES (?, ?)');
    for (const permission of permissions) add.run(groupId, permission);
  })();
  return listDirectory().groups.find((group) => group.id === groupId);
}

export function updateUserGroups(userId, groupIds) {
  const db = getDb();
  if (!getUser(userId)) throw new Error('Unknown user');
  // The built-in administrator is the way back into a box in a building, and
  // a screen that can remove its authority is a screen that can lock a church
  // out of its own booth on a Sunday. Every other account is fair game.
  if (adminUser()?.id === userId && !(groupIds ?? []).includes(ADMIN_GROUP)) {
    throw new Error(`@${ADMIN_USERNAME} must stay an administrator`);
  }
  db.transaction(() => {
    db.prepare('DELETE FROM user_groups WHERE user_id = ?').run(userId);
    const add = db.prepare('INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)');
    for (const groupId of groupIds ?? []) add.run(userId, groupId);
  })();
  return getUser(userId);
}

/**
 * Set a user's PIN, ending every session that PIN opened.
 *
 * A credential that MOVED takes its sessions with it — the same rule
 * projectAdminAccount states for @admin, and for the same reason: changing a
 * PIN is what somebody does when they think it leaked, so leaving the old
 * session alive for the rest of its eight hours answers the wrong question.
 *
 * @admin is refused here on purpose. Its PIN lives in settings and is
 * projected onto the account by projectAdminAccount, so writing it directly
 * would leave the two disagreeing until the next boot — and the stale settings
 * copy is the one the login route re-projects from.
 */
export function setUserPin(userId, pin) {
  const db = getDb();
  const user = getUser(userId);
  if (!user) throw new Error('Unknown user');
  if (adminUser()?.id === userId) {
    throw new Error(`@${ADMIN_USERNAME}'s PIN is changed in Admin → General, not here`);
  }
  if (String(pin ?? '').length < 4) throw new Error('PIN must be at least 4 characters');
  db.transaction(() => {
    db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(hashPin(pin), userId);
    db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(userId);
  })();
  return getUser(userId);
}

/** Does this PIN currently open this account? For the self-service change,
 *  which must prove the person at the keyboard is the account's owner and not
 *  someone who found it logged in. */
export function pinMatches(userId, pin) {
  const row = getDb().prepare('SELECT pin_hash FROM users WHERE id = ? AND active = 1').get(userId);
  return Boolean(row && verifyPin(pin, row.pin_hash));
}

/**
 * Deactivate or restore an account. Deactivation is how a volunteer who has
 * moved on loses access; the row stays because the audit trail points at it,
 * and a deleted user would turn its own history into anonymous ids.
 *
 * `authenticate` and `resolveSession` both require active = 1, so dropping the
 * sessions here is belt-and-braces — but it makes the revocation immediate
 * rather than "immediate on their next request".
 */
export function setUserActive(userId, active) {
  const db = getDb();
  if (!getUser(userId)) throw new Error('Unknown user');
  if (!active && adminUser()?.id === userId) {
    // Same reasoning as updateUserGroups: this account is the way back into a
    // box in a building, and a screen that can switch it off is a screen that
    // can lock a church out of its own booth on a Sunday.
    throw new Error(`@${ADMIN_USERNAME} cannot be deactivated`);
  }
  db.transaction(() => {
    db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, userId);
    if (!active) db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(userId);
  })();
  return getUser(userId);
}

/**
 * Change a group's name and the permissions it carries.
 *
 * Administrators is refused: its `['*']` is computed from `system_key` in
 * listDirectory rather than stored as rows, so an edit here would write
 * permissions nothing reads and report a change that did not happen.
 */
export function updateGroup(groupId, { name, permissions }) {
  const db = getDb();
  const existing = listDirectory().groups.find((group) => group.id === groupId);
  if (!existing) throw new Error('Unknown group');
  if (existing.systemKey === 'admin') throw new Error('The Administrators group always holds every permission');
  const clean = name === undefined ? existing.name : String(name ?? '').trim();
  if (clean.length < 2 || clean.length > 60) throw new Error('Group name must be 2–60 characters');
  const next = permissions === undefined ? existing.permissions : permissions;
  const allowed = new Set(PERMISSIONS.map(([permission]) => permission));
  if (!next.every((permission) => allowed.has(permission))) throw new Error('Unknown permission');
  db.transaction(() => {
    db.prepare('UPDATE permission_groups SET name = ? WHERE id = ?').run(clean, groupId);
    db.prepare('DELETE FROM group_permissions WHERE group_id = ?').run(groupId);
    const add = db.prepare('INSERT INTO group_permissions (group_id, permission_id) VALUES (?, ?)');
    for (const permission of next) add.run(groupId, permission);
  })();
  return listDirectory().groups.find((group) => group.id === groupId);
}

export function listAudit(limit = 200) {
  const n = Math.max(1, Math.min(500, Number(limit) || 200));
  return getDb().prepare(
    `SELECT a.id, a.ts, a.action, a.resource_type AS resourceType, a.resource_id AS resourceId,
            a.room_id AS roomId, a.plan_id AS planId, a.result, a.details,
            u.display_name AS userName, u.username, s.name AS stationName
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN stations s ON s.id = a.station_id
      ORDER BY a.ts DESC, a.id DESC LIMIT ?`,
  ).all(n).map((row) => ({ ...row, details: row.details ? JSON.parse(row.details) : null }));
}

export function audit({ userId = null, stationId = null, action, resourceType = null, resourceId = null, roomId = null, planId = null, result, details = null }) {
  getDb().prepare(
    `INSERT INTO audit_log (ts, user_id, station_id, action, resource_type, resource_id, room_id, plan_id, result, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(Date.now(), userId, stationId, action, resourceType, resourceId, roomId, planId, result, details ? JSON.stringify(details) : null);
}

initialize();
