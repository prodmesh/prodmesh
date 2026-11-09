// HTTP-layer identity + permission helpers shared by all routers.

import * as auth from './authStore.js';
import { sourceIp, recordFailure, refuseIfLocked } from './credentialThrottle.js';

// Require a valid admin bearer token. Attach to any admin-only route.
export function bearer(req) {
  return (req.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
}

// One kind of identity, whichever door it came through. The admin PIN used to
// produce a second one (`req.legacyAdmin`) that every permission check had to
// remember to consult — and that no audit row could name.
//
// A service token (ADR 0013) is the third door, and it is checked here rather
// than in a router because a token request goes straight to rooms.js or
// shows.js. It is told apart from a session by its prefix, which matters for
// the throttle: a browser holding an expired SESSION sends it with every
// poll, and counting those as guesses would lock a booth out of its own
// dashboard. Only something that claims to be a token is counted when it is
// not one.
export function resolveIdentity(req, res, next) {
  const presented = bearer(req);
  if (presented.startsWith(auth.TOKEN_PREFIX)) return resolveToken(req, res, next, presented);
  req.station = auth.resolveStation(req.get('x-prodmesh-station'));
  req.auth = auth.resolveSession(presented);
  next();
}

function resolveToken(req, res, next, presented) {
  // Per source address. A token is 256 random bits, so this is not what stops
  // it being guessed; it stops an app with a revoked token, or a script, from
  // hammering every route at full speed. A valid token does NOT clear the
  // counter: a caller holding one good token could otherwise interleave it
  // with guesses and never be locked.
  const keys = [{ k: `token:${sourceIp(req)}`, after: 10 }];
  if (refuseIfLocked(res, keys)) return;
  const identity = auth.resolveServiceToken(presented);
  if (!identity) {
    recordFailure(keys);
    // An explicit refusal, even on a route anonymous could read: an
    // integrator whose token was revoked should be told so, not served
    // quietly as anonymous until their first write fails.
    return res.status(401).json({ error: 'invalid_token' });
  }
  // A token replaces a station rather than carrying one (ADR 0013): the
  // station header is how a BROWSER says which booth it is, and an app is
  // identified by its token. Ignored rather than refused, so a client that
  // sends both still works.
  req.station = null;
  req.auth = identity;
  next();
}

// Permission id → the human label Admin → Users shows for it. Sent with a
// refusal so the browser can say WHICH authority is missing without shipping a
// second copy of this list that drifts from PERMISSIONS.
const LABELS = new Map(auth.PERMISSIONS.map(([id, label]) => [id, label]));

/** The refusal body, for the routes whose check is too particular for
 *  requirePermission and which would otherwise answer in a different shape. */
export const permissionRequired = (permission) => ({
  error: 'permission_required',
  permission,
  label: LABELS.get(permission) ?? permission,
});

export function requirePermission(permission) {
  return (req, res, next) => {
    if (auth.hasPermission(req.auth, permission)) return next();
    auth.audit({
      userId: req.auth?.user?.id,
      stationId: req.station?.id,
      tokenId: req.auth?.token?.id,
      action: permission,
      result: 'denied',
      roomId: req.params.id ?? null,
      planId: req.params.planId ?? null,
    });
    // 403 vs 401 is the browser's only way to tell "this operator lacks the
    // permission" from "nobody is logged in" — two refusals that need very
    // different words on screen.
    return res.status(req.auth ? 403 : 401).json(permissionRequired(permission));
  };
}

export function auditSuccess(req, action, context = {}) {
  auth.audit({
    userId: req.auth?.user?.id,
    stationId: req.station?.id,
    tokenId: req.auth?.token?.id,
    action,
    result: 'allowed',
    roomId: req.params.id ?? null,
    planId: req.params.planId ?? null,
    ...context,
  });
}
