// Auth: stations, login/logout/status, users and permission groups.

import express from 'express';

import { rooms } from '../roomsStore.js';
import * as settings from '../settings.js';
import * as pco from '../integrations/planningCenter.js';
import * as auth from '../authStore.js';
import { bearer, requirePermission, auditSuccess } from '../httpAuth.js';

const router = express.Router();

// Station registration is deliberately unauthenticated: it identifies the
// browser installation, but grants no authority. Naming a machine is not login,
// and a booth display has to come up without anyone signing in.
//
// It was, however, unbounded — which made it the enabler for two other
// problems: free identities to rotate through (the old station-keyed login
// lockout, now IP-keyed) and unlimited Slack posts via /api/assistance, whose
// idempotency is per-station. Registration stays open; it just isn't free
// any more. A real install registers a handful of stations, ever.
const REGISTER_LIMIT = 10; // per IP per window
const REGISTER_WINDOW_MS = 60 * 60 * 1000;
const registrations = new Map(); // ip → { count, resetAt }

router.post('/api/stations/register', (req, res) => {
  const ip = sourceIp(req);
  const now = Date.now();
  const seen = registrations.get(ip);
  const window = !seen || seen.resetAt <= now ? { count: 0, resetAt: now + REGISTER_WINDOW_MS } : seen;
  if (window.count >= REGISTER_LIMIT) {
    return res.status(429).json({ error: 'too_many_registrations', retryAfter: window.resetAt - now });
  }
  try {
    const station = auth.registerStation(req.body ?? {});
    window.count += 1;
    registrations.set(ip, window);
    if (registrations.size > 1000) {
      for (const [k, v] of registrations) if (v.resetAt <= now) registrations.delete(k);
    }
    res.status(201).json({ station });
  } catch (err) {
    res.status(400).json({ error: String(err.message ?? err) });
  }
});

router.get('/api/stations/current', (req, res) => {
  res.json({ station: req.station ?? null });
});

router.get('/api/stations', requirePermission('stations.manage'), (req, res) => {
  res.json({
    stations: auth.listStations().map((station) => ({
      ...station,
      current: station.id === req.station?.id,
    })),
  });
});

router.put('/api/stations/:stationId', requirePermission('stations.manage'), (req, res) => {
  try {
    const roomId = req.body?.roomId || null;
    const requestedCampus = req.body?.campusId || null;
    const room = roomId ? rooms[roomId] : null;
    if (roomId && !room) return res.status(400).json({ error: 'Unknown room' });
    const knownCampuses = new Set(Object.values(rooms).map((entry) => entry.site));
    if (requestedCampus && !knownCampuses.has(requestedCampus)) {
      return res.status(400).json({ error: 'Unknown campus' });
    }
    if (room && requestedCampus && room.site !== requestedCampus) {
      return res.status(400).json({ error: 'Room does not belong to that campus' });
    }
    const station = auth.updateStation(req.params.stationId, {
      name: req.body?.name,
      campusId: room?.site ?? requestedCampus,
      roomId,
      roomOnly: Boolean(req.body?.roomOnly),
      viewId: req.body?.viewId || null,
    });
    auditSuccess(req, 'stations.manage', {
      resourceType: 'station', resourceId: station.id, details: { operation: 'update' },
    });
    res.json({ station: { ...station, current: station.id === req.station?.id } });
  } catch (err) {
    res.status(String(err.message ?? err).includes('Unknown') ? 404 : 400).json({ error: String(err.message ?? err) });
  }
});

router.delete('/api/stations/:stationId', requirePermission('stations.manage'), (req, res) => {
  try {
    const current = req.station?.id === req.params.stationId;
    const station = auth.revokeStation(req.params.stationId);
    auditSuccess(req, 'stations.manage', {
      resourceType: 'station', resourceId: station.id, details: { operation: 'revoke', name: station.name },
    });
    res.json({ ok: true, current });
  } catch (err) {
    res.status(404).json({ error: String(err.message ?? err) });
  }
});

// ── Credential throttling ────────────────────────────────────────────────────
//  Keyed on the SOURCE IP, never on station id. Stations are minted by an
//  unauthenticated endpoint with no cap, so a station-keyed counter never
//  advances — reproduced: 20 wrong PINs with a fresh station each time drew
//  zero lockouts, then the correct PIN logged in normally.
//
//  Checked BEFORE any hashing. scrypt is deliberately expensive (~24ms) and
//  synchronous, so an unthrottled guess loop also stalls the event loop —
//  every SSE stream, the ProPresenter poller, SPL capture — mid-service.
//  Refusing early bounds the number of hashes an attacker can provoke.

const FAILURE_CAP = 5000; // the counter map must not itself become a leak
const failures = new Map(); // key → { count, lockedUntil }

const sourceIp = (req) => req.ip || req.socket?.remoteAddress || 'unknown';

/**
 * Escalating lockout: brief for fat fingers, punishing for a guess loop.
 * `after` differs per counter — a shared booth must not lock everyone out
 * because one volunteer mistyped five times, so the broad per-IP counter that
 * exists to catch username SPRAYING sits much higher than the per-account one.
 */
function lockoutMs(count, after) {
  if (count < after) return 0;
  if (count < after * 2) return 60_000;
  if (count < after * 4) return 15 * 60_000;
  return 60 * 60_000;
}

/** Milliseconds remaining on the longest active lock across `keys`, or 0. */
function lockedFor(keys) {
  const now = Date.now();
  return Math.max(0, ...keys.map(({ k }) => (failures.get(k)?.lockedUntil ?? 0) - now));
}

function recordFailure(keys) {
  if (failures.size >= FAILURE_CAP) {
    const now = Date.now();
    for (const [k, v] of failures) {
      if ((v.lockedUntil ?? 0) <= now) failures.delete(k);
      if (failures.size < FAILURE_CAP / 2) break;
    }
  }
  for (const { k, after } of keys) {
    const count = (failures.get(k)?.count ?? 0) + 1;
    const ms = lockoutMs(count, after);
    failures.set(k, { count, lockedUntil: ms ? Date.now() + ms : 0 });
  }
}

const clearFailures = (keys) => keys.forEach(({ k }) => failures.delete(k));

router.post('/api/auth/login', (req, res) => {
  if (!req.station) return res.status(400).json({ error: 'station_required' });
  const username = String(req.body?.username ?? '').toLowerCase();
  // Per-username so one locked account doesn't lock the booth out of every
  // account; plus a looser per-IP counter so username SPRAYING is bounded too.
  const keys = [
    { k: `u:${sourceIp(req)}:${username}`, after: 5 },
    { k: `ip:${sourceIp(req)}`, after: 50 }, // spray guard only — see lockoutMs
  ];
  const retryAfter = lockedFor(keys);
  if (retryAfter > 0) return res.status(429).json({ error: 'temporarily_locked', retryAfter });

  // @admin is an account like any other here — the reason this reconciliation
  // exists is that it was not, and typing the PIN people actually know into
  // the login box simply failed.
  auth.projectAdminAccount(settings.adminPinHash());
  const session = auth.authenticate(req.body?.username, req.body?.pin, req.station.id);
  if (!session) {
    recordFailure(keys);
    auth.audit({ stationId: req.station.id, action: 'auth.login', result: 'denied', details: { username: req.body?.username ?? '' } });
    return res.status(401).json({ error: 'Bad username or PIN' });
  }
  clearFailures(keys);
  auth.audit({ userId: session.user.id, stationId: req.station.id, action: 'auth.login', result: 'allowed' });
  res.json(session);
});

// The admin PIN, the short way in — Admin → enter PIN, no username.
//
// It is the SAME credential as logging in as @admin, because the PIN is that
// account's PIN (authStore.projectAdminAccount). What it no longer is, is a
// second kind of authority: this hands back an ordinary session, so an admin
// action is attributable, survives a restart, and is revoked by logging out
// like anyone else's.
//
// The throttle stays where it was and matters as much: a session with '*' can
// POST /api/system/update, which spawns update.sh. Unthrottled, that is remote
// code execution — measured at ~40 guesses/second, a 4-digit PIN falls in
// about four minutes.
router.post('/api/auth/admin', (req, res) => {
  const keys = [{ k: `admin:${sourceIp(req)}`, after: 5 }];
  const retryAfter = lockedFor(keys);
  if (retryAfter > 0) return res.status(429).json({ error: 'temporarily_locked', retryAfter });

  // Kept in step here as well as at boot, so a PIN changed on another server
  // process — or edited into settings.json by an administrator who has been
  // locked out — takes effect at the next attempt.
  auth.projectAdminAccount(settings.adminPinHash());
  // A station is optional on purpose: this door is reachable before a browser
  // has registered one, which is the point of a way back in.
  const session = auth.authenticate(auth.ADMIN_USERNAME, req.body?.pin, req.station?.id ?? null);
  if (!session) {
    recordFailure(keys);
    auth.audit({
      stationId: req.station?.id ?? null, action: 'auth.admin', result: 'denied',
      details: { ip: sourceIp(req) },
    });
    return res.status(401).json({ error: 'Bad PIN' });
  }
  clearFailures(keys);
  auth.audit({ userId: session.user.id, stationId: req.station?.id ?? null, action: 'auth.admin', result: 'allowed' });
  res.json(session);
});

router.post('/api/auth/logout', (req, res) => {
  const token = bearer(req);
  if (req.auth) auth.audit({ userId: req.auth.user.id, stationId: req.station?.id, action: 'auth.logout', result: 'allowed' });
  auth.destroySession(token);
  res.json({ ok: true });
});

router.get('/api/auth/status', async (req, res) => {
  // This used to invent a user for the admin token — a literal `legacy-admin`
  // object with the display name of an account that did not exist. It exists
  // now, so the honest answer and the convenient one are the same.
  const user = req.auth?.user ?? null;
  const pcProfile = user?.planningCenterPersonId
    ? await pco.getPersonProfile(user.planningCenterPersonId).catch(() => null)
    : null;
  res.json({
    authenticated: Boolean(req.auth),
    admin: auth.hasPermission(req.auth, '*'),
    setupNeeded: settings.isAdminSetupNeeded(),
    user: user ? { ...user, avatarUrl: pcProfile?.avatarUrl ?? null } : null,
    permissions: req.auth?.permissions ?? [],
    station: req.station ?? null,
  });
});

router.get('/api/users', requirePermission('users.manage'), async (_req, res) => {
  const directory = auth.listDirectory();
  directory.users = await Promise.all(directory.users.map(async (user) => {
    const profile = user.planningCenterPersonId
      ? await pco.getPersonProfile(user.planningCenterPersonId).catch(() => null)
      : null;
    return { ...user, avatarUrl: profile?.avatarUrl ?? null };
  }));
  res.json(directory);
});

// Name → person id, so an admin never has to go dig a number out of Planning
// Center. Same permission as creating the user it fills in, and no wider: the
// names of everyone who serves are not something a booth operator needs.
//
// `configured: false` is a normal answer, not an error — an install with no
// token still creates users, it just types the id by hand.
router.get('/api/planning-center/people', requirePermission('users.manage'), async (req, res) => {
  const configured = pco.isConfigured();
  if (!configured) return res.json({ configured, people: [] });
  if (!String(req.query.q ?? '').trim()) {
    // The picker asks this as it mounts, to learn whether search exists at all.
    // Pull the roster while the admin is still typing a display name, so the
    // first search is a cache hit rather than a two-request wait.
    pco.getPeopleRoster().catch(() => {});
    return res.json({ configured, people: [] });
  }
  try {
    res.json({ configured, people: await pco.searchPeople(req.query.q) });
  } catch {
    // Distinct from an empty result: "nobody by that name" and "Planning
    // Center didn't answer" must not look the same to someone searching.
    res.status(502).json({ error: 'planning_center_unavailable' });
  }
});

router.post('/api/users', requirePermission('users.manage'), (req, res) => {
  try {
    const user = auth.createUser(req.body ?? {});
    auditSuccess(req, 'users.manage', { resourceType: 'user', resourceId: user.id, details: { operation: 'create' } });
    res.status(201).json({ user });
  } catch (err) {
    const message = String(err.message ?? err);
    res.status(message.includes('UNIQUE') ? 409 : 400).json({ error: message });
  }
});

router.post('/api/groups', requirePermission('users.manage'), (req, res) => {
  try {
    const group = auth.createGroup(req.body ?? {});
    auditSuccess(req, 'users.manage', { resourceType: 'permission-group', resourceId: group.id, details: { operation: 'create' } });
    res.status(201).json({ group });
  } catch (err) {
    const message = String(err.message ?? err);
    res.status(message.includes('UNIQUE') ? 409 : 400).json({ error: message });
  }
});

router.put('/api/users/:userId/groups', requirePermission('users.manage'), (req, res) => {
  try {
    const groupIds = req.body?.groupIds ?? [];
    // No self-promotion, and no granting authority you do not hold. Without
    // this, users.manage was a one-request path to '*': add your own account
    // to Administrators. Full admins ('*') are exempt — a superuser granting
    // a subset of their own powers is the whole point of the screen.
    if (!auth.hasPermission(req.auth, '*')) {
      if (req.auth?.user?.id === req.params.userId) {
        return res.status(403).json({ error: 'cannot_change_own_groups' });
      }
      const mine = new Set(req.auth?.permissions ?? []);
      const granting = auth.listDirectory().groups
        .filter((g) => groupIds.includes(g.id))
        .flatMap((g) => g.permissions ?? []);
      const over = granting.filter((p) => !mine.has(p));
      if (over.length) {
        return res.status(403).json({ error: 'cannot_grant_unheld_permissions', permissions: over });
      }
    }
    const user = auth.updateUserGroups(req.params.userId, groupIds);
    auditSuccess(req, 'users.manage', { resourceType: 'user', resourceId: user.id, details: { operation: 'groups' } });
    res.json({ user });
  } catch (err) {
    res.status(400).json({ error: String(err.message ?? err) });
  }
});

/**
 * Change your own PIN.
 *
 * No permission gates this — it is the one account operation that needs no
 * authority beyond being the account. It does need the CURRENT PIN, because a
 * session alone only proves somebody is at a browser that was logged in, and a
 * booth machine left signed in is the normal state of a booth machine.
 *
 * Throttled on the same counter as a login: this endpoint verifies a PIN, so
 * without it, it would be a quieter door to guess at than /api/auth/login.
 */
router.post('/api/auth/pin', (req, res) => {
  const userId = req.auth?.user?.id;
  if (!userId) return res.status(401).json({ error: 'not_signed_in' });

  const keys = [{ k: `pin:${userId}`, after: 5 }];
  const retryAfter = lockedFor(keys);
  if (retryAfter > 0) return res.status(429).json({ error: 'temporarily_locked', retryAfter });

  if (!auth.pinMatches(userId, req.body?.currentPin)) {
    recordFailure(keys);
    auth.audit({ userId, stationId: req.station?.id, action: 'auth.pin.change', result: 'denied' });
    return res.status(403).json({ error: 'current_pin_incorrect' });
  }
  try {
    auth.setUserPin(userId, req.body?.newPin);
    clearFailures(keys);
    // Every session goes, including this one — see setUserPin. Saying so is the
    // difference between "you have been signed out" and "something broke".
    auditSuccess(req, 'auth.pin.change', { resourceType: 'user', resourceId: userId });
    res.json({ ok: true, signedOut: true });
  } catch (err) {
    res.status(400).json({ error: String(err.message ?? err) });
  }
});

/**
 * Reset somebody else's PIN. Full administrators only.
 *
 * Deliberately NOT `users.manage`. Setting an account's PIN is taking that
 * account over, so a users.manage holder who could do it would have a
 * one-request path to any authority in the building: reset a full admin's PIN,
 * sign in as them. That is the same escalation the groups route below refuses,
 * and it is worth less flexibility to keep the two consistent.
 */
router.put('/api/users/:userId/pin', requirePermission('users.manage'), (req, res) => {
  if (!auth.hasPermission(req.auth, '*')) {
    return res.status(403).json({ error: 'admin_required' });
  }
  try {
    const user = auth.setUserPin(req.params.userId, req.body?.pin);
    auditSuccess(req, 'users.manage', { resourceType: 'user', resourceId: user.id, details: { operation: 'pin-reset' } });
    res.json({ user });
  } catch (err) {
    res.status(400).json({ error: String(err.message ?? err) });
  }
});

/** Deactivate or restore an account — how access is revoked when somebody
 *  leaves. Not a delete: the audit trail points at these rows. */
router.put('/api/users/:userId/active', requirePermission('users.manage'), (req, res) => {
  const active = req.body?.active === true;
  if (req.auth?.user?.id === req.params.userId) {
    // Nobody has ever meant to do this, and the person who does it is by
    // definition the one who can no longer undo it.
    return res.status(403).json({ error: 'cannot_deactivate_yourself' });
  }
  if (!auth.hasPermission(req.auth, '*')) {
    const target = auth.listDirectory().users.find((u) => u.id === req.params.userId);
    const mine = new Set(req.auth?.permissions ?? []);
    const over = (target?.permissions ?? []).filter((p) => !mine.has(p));
    if (over.length) return res.status(403).json({ error: 'cannot_manage_higher_privilege', permissions: over });
  }
  try {
    const user = auth.setUserActive(req.params.userId, active);
    auditSuccess(req, 'users.manage', {
      resourceType: 'user', resourceId: user.id, details: { operation: active ? 'reactivate' : 'deactivate' },
    });
    res.json({ user });
  } catch (err) {
    res.status(400).json({ error: String(err.message ?? err) });
  }
});

/** Edit a group's name and permission set. Same rule as assigning a group:
 *  you cannot put a permission into a group that you do not hold yourself. */
router.put('/api/groups/:groupId', requirePermission('users.manage'), (req, res) => {
  try {
    const permissions = req.body?.permissions;
    if (permissions !== undefined && !auth.hasPermission(req.auth, '*')) {
      const mine = new Set(req.auth?.permissions ?? []);
      const over = permissions.filter((p) => !mine.has(p));
      if (over.length) return res.status(403).json({ error: 'cannot_grant_unheld_permissions', permissions: over });
    }
    const group = auth.updateGroup(req.params.groupId, { name: req.body?.name, permissions });
    auditSuccess(req, 'users.manage', { resourceType: 'permission-group', resourceId: group.id, details: { operation: 'update' } });
    res.json({ group });
  } catch (err) {
    res.status(400).json({ error: String(err.message ?? err) });
  }
});

export default router;
