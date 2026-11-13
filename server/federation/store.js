// ─────────────────────────────────────────────────────────────────────────────
//  FEDERATION STORE  —  configuration, peers and join tokens (ADR 0017).
//
//  Persistence and validation only. Talking to a peer is link.js; deciding
//  who may do what is the routes'. Nothing here touches the network except to
//  read this machine's own interfaces.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import os from 'node:os';
import { getDb } from '../db.js';
import { getIdentity } from '../identity.js';

const CONFIG_KEY = 'federation';
export const DEFAULT_PORT = 8443;
export const TOKEN_PREFIX = 'pmjoin1.';
export const TOKEN_TTL_MS = 30 * 60 * 1000;

const digest = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

// ── This machine's interfaces ────────────────────────────────────────────────

/** Non-loopback IPv4 interfaces, by name. IPv6 is a later concern: every
 *  church network this has been planned against addresses devices by v4. */
export function listInterfaces() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}

const multiHomed = () => new Set(listInterfaces().map((i) => i.name)).size > 1;

/** The address an interface name currently has, or null. Resolved every time
 *  the listener starts, so a DHCP lease change never strands it. */
export function addressOf(ifname) {
  return listInterfaces().find((i) => i.name === ifname)?.address ?? null;
}

// ── Addresses ────────────────────────────────────────────────────────────────

/** host or host:port → { host, port } or null. Hostnames and IPv4 only; never
 *  a scheme or a path, because this is spliced into a TLS connect. */
export function parseAddress(value, defaultPort = DEFAULT_PORT) {
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)(?::(\d{1,5}))?$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : defaultPort;
  if (port < 1 || port > 65535) return null;
  return { host: m[1], port };
}

const formatAddress = ({ host, port }) => `${host}:${port}`;

// ── Configuration ────────────────────────────────────────────────────────────

/**
 * enabled  — off by default: a single-site church never opens the port.
 * bind     — 'all', or an interface NAME (resolved to its address at listen).
 * port     — the federation listener's port.
 * address  — what peers should dial. Empty means "this machine's primary
 *            address", which is right on a flat single-NIC network and is
 *            only typed when it is wrong (multi-homed, NAT, Docker, DNS).
 * dashboardUrl — where a BROWSER at another campus opens this server (ADR
 *            0018). Not the federation address: another port, maybe another
 *            name, maybe https. Empty means the federation host on the
 *            dashboard port, typed only when that is wrong.
 */
export function getConfig() {
  const row = getDb().prepare('SELECT value FROM app_config WHERE key = ?').get(CONFIG_KEY);
  const stored = row ? JSON.parse(row.value) : {};
  return { enabled: false, bind: 'all', port: DEFAULT_PORT, address: '', dashboardUrl: '', ...stored };
}

export function setConfig(input) {
  const next = { ...getConfig() };
  if (input.enabled !== undefined) next.enabled = input.enabled === true;
  if (input.port !== undefined) {
    const port = Number(input.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be 1024–65535');
    next.port = port;
  }
  if (input.bind !== undefined) {
    const bind = String(input.bind);
    if (bind !== 'all' && !listInterfaces().some((i) => i.name === bind)) {
      throw new Error(`No network interface named ${bind}`);
    }
    next.bind = bind;
  }
  if (input.address !== undefined) {
    const address = String(input.address).trim();
    if (address && !parseAddress(address, next.port)) throw new Error('Address must be a hostname or IPv4 address, optionally with :port');
    next.address = address;
  }
  if (input.dashboardUrl !== undefined) {
    const url = String(input.dashboardUrl).trim();
    if (url && !normalizeDashboardUrl(url)) throw new Error('Dashboard address must be an http:// or https:// address with no path, like http://192.0.2.10:8080');
    next.dashboardUrl = url ? normalizeDashboardUrl(url) : '';
  }
  getDb().prepare(
    'INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(CONFIG_KEY, JSON.stringify(next));
  return next;
}

/** What peers should dial, as host:port. */
export function federationAddress(cfg = getConfig()) {
  if (cfg.address) return formatAddress(parseAddress(cfg.address, cfg.port));
  const own = cfg.bind !== 'all' ? addressOf(cfg.bind) : null;
  const host = own ?? listInterfaces()[0]?.address ?? '127.0.0.1';
  return formatAddress({ host, port: cfg.port });
}

/**
 * An absolute http(s) origin, or null. Used for our own setting and for the
 * one a peer sends in its directory, which is only ever a navigation target
 * for a browser — this server never fetches it — but is still refused unless
 * it is plainly an origin, so a peer cannot hand our users a javascript: or
 * data: URL behind an Open button.
 */
export function normalizeDashboardUrl(value) {
  const text = String(value ?? '').trim();
  if (!text || text.length > 300) return null;
  let url;
  try { url = new URL(text); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  return url.origin;
}

/** Where a browser elsewhere opens this server's dashboard. */
export function dashboardUrl(cfg = getConfig()) {
  if (cfg.dashboardUrl) return cfg.dashboardUrl;
  const { host } = parseAddress(federationAddress(cfg), cfg.port);
  return `http://${host}:${Number(process.env.PORT) || 8080}`;
}

/** Everything the Admin screen shows about this side, with the warning ADR
 *  0017 asks for: binding everything on a multi-homed box. */
export function describe() {
  const cfg = getConfig();
  return {
    ...cfg,
    effectiveAddress: federationAddress(cfg),
    effectiveDashboardUrl: dashboardUrl(cfg),
    interfaces: listInterfaces(),
    warnAllInterfaces: cfg.bind === 'all' && multiHomed(),
  };
}

// ── Peers ────────────────────────────────────────────────────────────────────

function publicPeer(row) {
  return {
    systemId: row.system_id,
    name: row.name,
    address: row.address,
    fingerprint: row.fingerprint,
    state: row.state,
    awaiting: row.awaiting,
    createdAt: row.created_at,
    pairedAt: row.paired_at,
    lastSeenAt: row.last_seen_at,
    lastError: row.last_error,
    clockSkewMs: row.clock_skew_ms,
  };
}

export const listPeers = ({ includeRemoved = false } = {}) => getDb()
  .prepare(`SELECT * FROM federation_peers ${includeRemoved ? '' : "WHERE state != 'removed'"} ORDER BY name`)
  .all().map(publicPeer);

/** The full row, certificate included, for link.js. */
export const peerRow = (systemId) => getDb().prepare('SELECT * FROM federation_peers WHERE system_id = ?').get(systemId) ?? null;

/** The live (not removed) peer presenting this certificate fingerprint. */
export const peerByFingerprint = (fingerprint) => getDb()
  .prepare("SELECT * FROM federation_peers WHERE fingerprint = ? AND state != 'removed'").get(fingerprint) ?? null;

export const getPeer = (systemId) => {
  const row = peerRow(systemId);
  return row ? publicPeer(row) : null;
};

/**
 * Validate what a site says about itself. Its certificate is NOT in here:
 * that comes from the TLS session, never from a request body.
 */
export function validateIdentity(input) {
  const systemId = String(input?.systemId ?? '');
  if (!UUID.test(systemId)) throw new Error('A peer needs a system id');
  if (systemId === getIdentity().systemId) throw new Error('That is this server’s own token');
  const name = String(input?.name ?? '').trim().slice(0, 80) || 'ProdMesh';
  const address = parseAddress(input?.address);
  if (!address) throw new Error('A peer needs a federation address');
  let signingPublicKey;
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(String(input?.signingPublicKey ?? ''), 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('not ed25519');
    signingPublicKey = key.export({ type: 'spki', format: 'der' }).toString('base64');
  } catch {
    throw new Error('A peer needs an Ed25519 signing key');
  }
  return { systemId, name, address: formatAddress(address), signingPublicKey };
}

/** Record a peer, replacing a removed one with the same id (re-pairing). */
export function upsertPeer({ systemId, name, address, certificate, fingerprint, signingPublicKey, awaiting }) {
  const existing = peerRow(systemId);
  if (existing && existing.state !== 'removed') {
    throw Object.assign(new Error(`Already paired with ${existing.name}`), { code: 'already_paired' });
  }
  if (!FINGERPRINT.test(fingerprint)) throw new Error('Bad certificate fingerprint');
  const now = Date.now();
  getDb().prepare(
    `INSERT INTO federation_peers
       (system_id, name, address, certificate, fingerprint, signing_public_key, state, awaiting, created_at)
     VALUES (@systemId, @name, @address, @certificate, @fingerprint, @signingPublicKey, 'pending', @awaiting, @now)
     ON CONFLICT(system_id) DO UPDATE SET
       name = excluded.name, address = excluded.address, certificate = excluded.certificate,
       fingerprint = excluded.fingerprint, signing_public_key = excluded.signing_public_key,
       state = 'pending', awaiting = excluded.awaiting, created_at = excluded.created_at,
       paired_at = NULL, accepted_by = NULL, last_seen_at = NULL, last_error = NULL, clock_skew_ms = NULL`,
  ).run({ systemId, name, address, certificate, fingerprint, signingPublicKey, awaiting, now });
  return getPeer(systemId);
}

export function markPaired(systemId, acceptedBy = null) {
  getDb().prepare(
    "UPDATE federation_peers SET state = 'paired', awaiting = NULL, paired_at = ?, accepted_by = COALESCE(?, accepted_by) WHERE system_id = ? AND state = 'pending'",
  ).run(Date.now(), acceptedBy, systemId);
  return getPeer(systemId);
}

export function markRemoved(systemId) {
  const db = getDb();
  db.transaction(() => {
    db.prepare("UPDATE federation_peers SET state = 'removed', awaiting = NULL WHERE system_id = ?").run(systemId);
    // Unpairing forgets what they run, too (ADR 0018): an unreachable peer
    // keeps its last directory, a removed one does not.
    db.prepare('DELETE FROM federation_directory WHERE system_id = ?').run(systemId);
  })();
  return getPeer(systemId);
}

export function setPeerAddress(systemId, value) {
  const address = parseAddress(value);
  if (!address) throw new Error('Address must be a hostname or IPv4 address, optionally with :port');
  getDb().prepare('UPDATE federation_peers SET address = ? WHERE system_id = ?').run(formatAddress(address), systemId);
  return getPeer(systemId);
}

/** What one contact with a peer learned. Any field may be omitted. */
export function recordContact(systemId, { ok, error = null, name, address, clockSkewMs } = {}) {
  const row = peerRow(systemId);
  if (!row) return;
  const parsed = address ? parseAddress(address) : null;
  getDb().prepare(
    `UPDATE federation_peers SET
       last_seen_at = CASE WHEN @ok THEN @now ELSE last_seen_at END,
       last_error = @error,
       name = COALESCE(@name, name),
       address = COALESCE(@address, address),
       clock_skew_ms = COALESCE(@skew, clock_skew_ms)
     WHERE system_id = @systemId`,
  ).run({
    systemId, ok: ok ? 1 : 0, now: Date.now(), error,
    name: name ? String(name).trim().slice(0, 80) || null : null,
    address: parsed ? formatAddress(parsed) : null,
    skew: Number.isFinite(clockSkewMs) ? Math.round(clockSkewMs) : null,
  });
}

// ── Join tokens ──────────────────────────────────────────────────────────────

/** Mint a join token. Its secret exists only in the string returned. */
export function mintJoinToken({ createdBy = null } = {}) {
  const me = getIdentity();
  const secret = crypto.randomBytes(16).toString('base64url');
  const id = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = now + TOKEN_TTL_MS;
  getDb().prepare(
    'INSERT INTO federation_join_tokens (id, secret_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, digest(secret), createdBy, now, expiresAt);
  const body = { v: 1, id: me.systemId, name: me.name, addr: federationAddress(), fp: me.tlsFingerprint, secret, exp: expiresAt };
  return { id, expiresAt, token: TOKEN_PREFIX + Buffer.from(JSON.stringify(body)).toString('base64url') };
}

/** Decode a token someone pasted. Throws a message a human can act on. */
export function parseJoinToken(text) {
  const raw = String(text ?? '').trim();
  if (!raw.startsWith(TOKEN_PREFIX)) throw new Error('That is not a ProdMesh join token');
  let body;
  try {
    body = JSON.parse(Buffer.from(raw.slice(TOKEN_PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    throw new Error('The join token is damaged. Copy it again, whole');
  }
  if (body?.v !== 1) throw new Error('This join token is from a newer ProdMesh. Update this server first');
  if (!UUID.test(String(body.id)) || !FINGERPRINT.test(String(body.fp)) || !parseAddress(body.addr) || typeof body.secret !== 'string') {
    throw new Error('The join token is damaged. Copy it again, whole');
  }
  if (!(Number(body.exp) > Date.now())) throw new Error('This join token has expired. Ask for a new one');
  if (body.id === getIdentity().systemId) throw new Error('That is this server’s own token');
  return { systemId: body.id, name: String(body.name ?? ''), address: body.addr, fingerprint: body.fp, secret: body.secret, expiresAt: body.exp };
}

/**
 * Spend a token's secret. Returns true exactly once per live token: the
 * UPDATE is the check, so two redeemers racing cannot both win.
 */
export function consumeJoinToken(secret, usedBy) {
  const info = getDb().prepare(
    `UPDATE federation_join_tokens SET used_at = ?, used_by = ?
      WHERE secret_hash = ? AND used_at IS NULL AND cancelled_at IS NULL AND expires_at > ?`,
  ).run(Date.now(), usedBy, digest(secret), Date.now());
  return info.changes === 1;
}

export const listJoinTokens = () => getDb().prepare(
  `SELECT id, created_at AS createdAt, expires_at AS expiresAt FROM federation_join_tokens
    WHERE used_at IS NULL AND cancelled_at IS NULL AND expires_at > ? ORDER BY created_at DESC`,
).all(Date.now());

export function cancelJoinToken(id) {
  return getDb().prepare('UPDATE federation_join_tokens SET cancelled_at = ? WHERE id = ? AND used_at IS NULL').run(Date.now(), id).changes === 1;
}
