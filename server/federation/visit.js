// ─────────────────────────────────────────────────────────────────────────────
//  VISITING  —  "this is Alex from North", signed (ADR 0018).
//
//  The home server vouches; the visited server decides. An assertion is a
//  short-lived, single-use statement of WHO, signed with the home server's
//  Ed25519 identity key (#49) and checked against the key the visited server
//  pinned at pairing. It is never a grant: what a visitor may do is the
//  visited server's per-peer rules, in authStore.
//
//    pmvisit1.<payload base64url>.<signature base64url>
//
//  It reaches the other server in a URL fragment, which browsers do not send
//  in the request line, a Referer, or server logs. On the wire after that it
//  rides the dashboard's own transport — plain HTTP inside a trusted path or
//  TLS, per ADR 0016's tiers. Captured, it is good for at most sixty seconds,
//  once, at one server, for what that server lets visitors do.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import { getDb } from '../db.js';
import { getIdentity, privateIdentity } from '../identity.js';
import * as store from './store.js';

export const PREFIX = 'pmvisit1.';
const LIFETIME_MS = 60_000;
// The same threshold Admin → Linked servers warns at. Within it a visit works;
// beyond it the refusal names the clock, because "I can't open the other
// campus" otherwise points nowhere (ADR 0014).
export const SKEW_MS = 30_000;

const b64 = (buf) => Buffer.from(buf).toString('base64url');

/** Sign an assertion naming `user` for the paired server `aud`. */
export function sign({ aud, user, groups }) {
  const now = Date.now();
  const payload = {
    v: 1,
    iss: getIdentity().systemId,
    aud,
    sub: user.id,
    username: user.username,
    name: user.displayName,
    groups,
    iat: now,
    exp: now + LIFETIME_MS,
    nonce: crypto.randomBytes(16).toString('hex'),
  };
  const body = b64(JSON.stringify(payload));
  const signature = crypto.sign(null, Buffer.from(body), privateIdentity().signingKey);
  return `${PREFIX}${body}.${b64(signature)}`;
}

/** A refusal with a reason a log line and the arriving page can both use. */
export class VisitError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Verify an assertion presented here. Returns its claims, with the issuing
 * peer's name, or throws a VisitError. Spends the nonce: a second
 * presentation of the same assertion fails.
 */
export function verify(text, now = Date.now()) {
  const raw = String(text ?? '').trim();
  if (!raw.startsWith(PREFIX)) throw new VisitError('malformed', 'Not a visit pass');
  const [body, sig, extra] = raw.slice(PREFIX.length).split('.');
  if (!body || !sig || extra !== undefined || raw.length > 4096) throw new VisitError('malformed', 'Not a visit pass');

  let claims;
  try { claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch {
    throw new VisitError('malformed', 'Not a visit pass');
  }
  if (claims?.v !== 1) throw new VisitError('malformed', 'Made by a different version of ProdMesh');

  // Who signed it decides which key checks it; nothing else in the claims is
  // believed until the signature is.
  const peer = typeof claims.iss === 'string' ? store.peerRow(claims.iss) : null;
  if (!peer || peer.state !== 'paired') throw new VisitError('unknown_issuer', 'That server is not linked with this one');
  const key = crypto.createPublicKey({ key: Buffer.from(peer.signing_public_key, 'base64'), format: 'der', type: 'spki' });
  let ok = false;
  try { ok = crypto.verify(null, Buffer.from(body), key, Buffer.from(sig, 'base64url')); } catch { ok = false; }
  if (!ok) throw new VisitError('bad_signature', `Not signed by ${peer.name}`);

  if (claims.aud !== getIdentity().systemId) throw new VisitError('wrong_audience', 'This pass was made for a different server');
  if (!Number.isFinite(claims.iat) || !Number.isFinite(claims.exp) || claims.exp - claims.iat > 2 * LIFETIME_MS) {
    throw new VisitError('malformed', 'Not a visit pass');
  }
  if (claims.iat > now + SKEW_MS || claims.exp < now - SKEW_MS) {
    const skew = Math.round((claims.iat - now) / 1000);
    console.warn(`[federation] visit from ${peer.name} refused: its clock is about ${Math.abs(skew)}s ${skew > 0 ? 'ahead of' : 'behind'} this one, or the pass is old`);
    throw new VisitError('clock', `The pass has expired, or the clocks on this server and ${peer.name} disagree. Check the time on both`);
  }
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 100
    || typeof claims.username !== 'string' || !claims.username
    || typeof claims.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(claims.nonce)) {
    throw new VisitError('malformed', 'Not a visit pass');
  }

  const db = getDb();
  db.prepare('DELETE FROM federation_visit_nonces WHERE expires_at < ?').run(now);
  const spent = db.prepare('INSERT OR IGNORE INTO federation_visit_nonces (nonce, expires_at) VALUES (?, ?)')
    .run(claims.nonce, claims.exp + SKEW_MS);
  if (spent.changes === 0) throw new VisitError('replayed', 'This pass has already been used. Press Open again');

  return {
    systemId: peer.system_id,
    serverName: peer.name,
    sub: claims.sub,
    username: claims.username.slice(0, 40),
    displayName: typeof claims.name === 'string' ? claims.name.slice(0, 80) : claims.username,
    groups: Array.isArray(claims.groups) ? claims.groups.filter((g) => typeof g === 'string').slice(0, 20) : [],
  };
}

/** A path on the other server to land on: absolute, same-origin, plain. */
export function safePath(value) {
  const p = String(value ?? '/');
  return /^\/(?!\/)[A-Za-z0-9/_.~-]{0,200}$/.test(p) ? p : '/';
}
