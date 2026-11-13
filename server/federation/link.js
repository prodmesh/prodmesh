// ─────────────────────────────────────────────────────────────────────────────
//  THE FEDERATION LINK  —  ProdMesh to ProdMesh, and nothing else (ADR 0017).
//
//  A second HTTPS listener, separate from the dashboard, serving only
//  /federation/v1. A firewall that lets another campus reach this port
//  exposes this protocol and nothing more, and the dashboard's routes do not
//  exist here at all.
//
//  Mutual TLS on the #49 certificates. Neither side chains to a CA: each
//  presents its self-signed certificate, and each authenticates the other by
//  looking its fingerprint up in federation_peers. A request on an unknown
//  certificate is refused before any handler acts on it. The pin IS the
//  authentication; there is no bearer token on this link to leak.
//
//  Outbound, the TLS handshake is done first and the fingerprint checked
//  before a single HTTP byte is written. That matters most when redeeming a
//  join token, whose request body carries a secret.
//
//  Never a forwarder (ADR 0016). Every route here is a named operation that
//  this server performs itself. There is no route that relays a call onward.
// ─────────────────────────────────────────────────────────────────────────────

import https from 'node:https';
import tls from 'node:tls';
import express from 'express';
import * as store from './store.js';
import * as health from '../health.js';
import * as auth from '../authStore.js';
import { getIdentity, privateIdentity } from '../identity.js';
import { getVersion } from '../deployment.js';
import { sourceIp, lockedFor, recordFailure } from '../credentialThrottle.js';

export const healthKey = (systemId) => `peer:${systemId}`;
const CONNECT_TIMEOUT_MS = 5000;
const PROBE_MS = Number(process.env.PRODMESH_FEDERATION_PROBE_MS) > 0
  ? Number(process.env.PRODMESH_FEDERATION_PROBE_MS) : 60_000;

// ── Outbound: one pinned request ─────────────────────────────────────────────

/**
 * Call a peer. `fingerprint` is the only thing trusted: the handshake must
 * present exactly that certificate, or nothing is sent.
 *
 * Resolves { status, body, certificate } (certificate = what the peer
 * presented, PEM). Rejects with a message fit for an Admin screen.
 */
export function request({ address, fingerprint }, method, path, body) {
  const target = store.parseAddress(address);
  if (!target) return Promise.reject(new Error(`Bad peer address: ${address}`));
  const { tlsKeyPem, certificatePem } = privateIdentity();
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };

    const socket = tls.connect({
      host: target.host,
      port: target.port,
      key: tlsKeyPem,
      cert: certificatePem,
      // Trust is the fingerprint check below, not a CA chain: there is none.
      rejectUnauthorized: false,
      // SNI must be a hostname, never an IP literal.
      servername: /^[\d.]+$/.test(target.host) ? undefined : target.host,
      timeout: CONNECT_TIMEOUT_MS,
    });
    socket.once('timeout', () => { socket.destroy(); fail(new Error(`No answer from ${address}`)); });
    socket.once('error', (err) => fail(new Error(describeError(err, address))));
    socket.once('secureConnect', () => {
      const presented = socket.getPeerX509Certificate();
      if (!presented || presented.fingerprint256 !== fingerprint) {
        socket.destroy();
        return fail(new Error(`${address} presented a different certificate than the one pinned. It may be a different server`));
      }
      socket.setTimeout(0);
      const certificate = presented.toString();
      const req = https.request({
        method,
        path,
        createConnection: () => socket,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': payload.length } : {}),
          // Every call says where this server can be reached now. The peer
          // trusts it because it arrived on a pinned, authenticated link —
          // this is how a DHCP lease change heals itself (ADR 0017).
          'X-ProdMesh-Federation-Address': store.federationAddress(),
        },
        timeout: CONNECT_TIMEOUT_MS,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { /* not JSON */ }
          if (!settled) { settled = true; resolve({ status: res.statusCode, body: parsed, certificate }); }
        });
      });
      req.once('timeout', () => { req.destroy(); fail(new Error(`${address} stopped answering`)); });
      req.once('error', (err) => fail(new Error(describeError(err, address))));
      req.end(payload ?? undefined);
    });
  });
}

function describeError(err, address) {
  if (err.code === 'ECONNREFUSED') return `Nothing is listening at ${address}. Is federation switched on there?`;
  if (err.code === 'ENOTFOUND') return `Cannot resolve ${address}`;
  if (err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH') return `No route to ${address}`;
  if (err.code === 'ETIMEDOUT') return `No answer from ${address}`;
  return `${address}: ${err.message}`;
}

const myIdentity = () => {
  const me = getIdentity();
  return { systemId: me.systemId, name: me.name, address: store.federationAddress(), signingPublicKey: me.signingPublicKey };
};

// ── Inbound: the federation app ──────────────────────────────────────────────

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

// Who is calling, from the TLS session — never from anything in the request.
app.use((req, res, next) => {
  const presented = req.socket.getPeerX509Certificate?.();
  if (!presented) return res.status(401).json({ error: 'certificate_required' });
  req.presented = presented;
  req.peer = store.peerByFingerprint(presented.fingerprint256);
  next();
});

/**
 * Redeem a join token: the one route an unknown certificate may call. The
 * secret proves the caller was handed a token; the certificate it presented
 * becomes the pin. It is recorded as awaiting an admin here (ADR 0017's
 * Accept step), so an intercepted token cannot pair silently.
 */
app.post('/federation/v1/pair', (req, res) => {
  const keys = [{ k: `fedpair:${sourceIp(req)}`, after: 5 }];
  const retryAfter = lockedFor(keys);
  if (retryAfter > 0) return res.status(429).json({ error: 'temporarily_locked', retryAfter });

  let them;
  try {
    them = store.validateIdentity(req.body?.identity);
  } catch (err) {
    return res.status(400).json({ error: String(err.message) });
  }
  if (!store.consumeJoinToken(String(req.body?.secret ?? ''), them.systemId)) {
    recordFailure(keys);
    auth.audit({ action: 'federation.pair', result: 'denied', details: { from: sourceIp(req), name: them.name } });
    return res.status(403).json({ error: 'That join token is not valid: expired, already used, or cancelled. Ask for a new one' });
  }
  try {
    store.upsertPeer({
      ...them,
      certificate: req.presented.toString(),
      fingerprint: req.presented.fingerprint256,
      awaiting: 'us',
    });
  } catch (err) {
    return res.status(err.code === 'already_paired' ? 409 : 400).json({ error: String(err.message) });
  }
  auth.audit({
    action: 'federation.pair', result: 'allowed', resourceType: 'peer', resourceId: them.systemId,
    details: { stage: 'redeemed', name: them.name, from: sourceIp(req) },
  });
  res.status(201).json({ identity: myIdentity(), state: 'pending' });
});

// Everything below needs a pinned peer.
app.use((req, res, next) => {
  if (!req.peer) return res.status(403).json({ error: 'not_paired' });
  next();
});

/**
 * Liveness, and the channel that keeps both records current: the caller's
 * address and name ride along, authenticated by the link they arrive on.
 *
 * A server only probes peers it has accepted, so a probe from a peer that
 * this side is still awaiting IS that peer's acceptance (ADR 0017).
 */
app.get('/federation/v1/hello', (req, res) => {
  const peer = req.peer;
  if (peer.state === 'pending' && peer.awaiting === 'them') {
    store.markPaired(peer.system_id);
    auth.audit({ action: 'federation.pair', result: 'allowed', resourceType: 'peer', resourceId: peer.system_id, details: { stage: 'accepted-by-peer', name: peer.name } });
    startProbe(peer.system_id);
  }
  const now = store.peerRow(peer.system_id);
  store.recordContact(peer.system_id, {
    ok: true,
    address: now.state === 'paired' ? req.get('x-prodmesh-federation-address') : null,
  });
  res.json({
    systemId: getIdentity().systemId,
    name: getIdentity().name,
    version: getVersion().version,
    now: Date.now(),
    // How THIS side sees the pair, so the caller can show "waiting".
    state: now.state === 'paired' ? 'paired' : 'pending',
  });
});

/** The other side removed us. Agree, so both lists say the same thing. */
app.post('/federation/v1/unpair', (req, res) => {
  store.markRemoved(req.peer.system_id);
  stopProbe(req.peer.system_id);
  auth.audit({ action: 'federation.unpair', result: 'allowed', resourceType: 'peer', resourceId: req.peer.system_id, details: { by: 'peer', name: req.peer.name } });
  res.json({ ok: true });
});

app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

// ── The listener ─────────────────────────────────────────────────────────────

let listener = null;
let listenerState = { listening: false, host: null, port: null, error: null };
let retryTimer = null;

export const listenerStatus = () => ({ ...listenerState });

/** (Re)start the listener to match the configuration. Safe to call any time. */
export async function applyConfig() {
  clearTimeout(retryTimer);
  await closeListener();
  const cfg = store.getConfig();
  if (!cfg.enabled) {
    listenerState = { listening: false, host: null, port: null, error: null };
    stopAllProbes();
    return listenerStatus();
  }
  // An interface is resolved to its address NOW, so a DHCP change is picked
  // up at the next start. A missing interface (cable out, not up yet at boot)
  // retries rather than failing for good.
  // PRODMESH_FEDERATION_HOST pins the listener to one literal address. Tests
  // set it to 127.0.0.1 so a test run never opens a port on a laptop's
  // church-wifi interface. Not for production: Admin's interface choice is.
  const host = process.env.PRODMESH_FEDERATION_HOST
    || (cfg.bind === 'all' ? undefined : store.addressOf(cfg.bind));
  if (!host && cfg.bind !== 'all') {
    listenerState = { listening: false, host: null, port: cfg.port, error: `Interface ${cfg.bind} has no IPv4 address` };
    retryTimer = setTimeout(applyConfig, 60_000);
    retryTimer.unref?.();
    return listenerStatus();
  }
  const { tlsKeyPem, certificatePem } = privateIdentity();
  const server = https.createServer({
    key: tlsKeyPem,
    cert: certificatePem,
    requestCert: true,
    rejectUnauthorized: false, // the fingerprint lookup above is the check
  }, app);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(cfg.port, host, resolve);
    });
  } catch (err) {
    listenerState = {
      listening: false, host: host ?? 'all', port: cfg.port,
      error: err.code === 'EADDRINUSE' ? `Port ${cfg.port} is already in use` : String(err.message),
    };
    return listenerStatus();
  }
  listener = server;
  listenerState = { listening: true, host: host ?? 'all', port: server.address().port, error: null };
  startAllProbes();
  return listenerStatus();
}

function closeListener() {
  if (!listener) return Promise.resolve();
  const s = listener;
  listener = null;
  return new Promise((resolve) => { s.closeAllConnections?.(); s.close(() => resolve()); });
}

export async function shutdown() {
  clearTimeout(retryTimer);
  stopAllProbes();
  await closeListener();
}

// ── Liveness probes ──────────────────────────────────────────────────────────

const probes = new Map(); // systemId → interval

/** Probe one peer now. Exported so Accept can confirm immediately. */
export async function probe(systemId) {
  const row = store.peerRow(systemId);
  if (!row || row.state === 'removed') return null;
  const key = healthKey(systemId);
  const t0 = Date.now();
  try {
    const { status, body } = await request(row, 'GET', '/federation/v1/hello');
    const t1 = Date.now();
    if (status === 403 && body?.error === 'not_paired') {
      store.recordContact(systemId, { ok: false, error: 'unpaired_by_peer' });
      health.report(key, false, `${row.name} no longer has this server paired`);
      return store.getPeer(systemId);
    }
    if (status !== 200) throw new Error(`${row.address} answered ${status}`);
    // The peer's clock against the midpoint of the round trip.
    const skew = Number.isFinite(body?.now) ? body.now - (t0 + t1) / 2 : null;
    store.recordContact(systemId, { ok: true, name: body?.name, clockSkewMs: skew });
    if (row.state === 'pending' && row.awaiting === 'them' && body?.state === 'paired') {
      store.markPaired(systemId);
      auth.audit({ action: 'federation.pair', result: 'allowed', resourceType: 'peer', resourceId: systemId, details: { stage: 'accepted-by-peer', name: row.name } });
    }
    health.report(key, true);
  } catch (err) {
    store.recordContact(systemId, { ok: false, error: String(err.message) });
    health.report(key, false, err.message);
  }
  return store.getPeer(systemId);
}

/**
 * Probe a peer on an interval. Only peers this side has accepted (paired) or
 * is waiting on (awaiting 'them') — never one still awaiting an admin HERE,
 * because a probe from us is what tells them we accepted.
 */
export function startProbe(systemId) {
  const row = store.peerRow(systemId);
  if (!row || row.state === 'removed' || row.awaiting === 'us' || probes.has(systemId)) return;
  health.declare(healthKey(systemId));
  const timer = setInterval(() => { probe(systemId).catch(() => {}); }, PROBE_MS);
  timer.unref?.();
  probes.set(systemId, timer);
}

export function stopProbe(systemId) {
  clearInterval(probes.get(systemId));
  probes.delete(systemId);
  health.forget(healthKey(systemId));
}

function startAllProbes() {
  for (const peer of store.listPeers()) startProbe(peer.systemId);
}

function stopAllProbes() {
  for (const id of [...probes.keys()]) {
    clearInterval(probes.get(id));
    probes.delete(id);
  }
}

// ── The operations the Admin routes call ─────────────────────────────────────

/** Redeem a join token pasted here: pair with the site that issued it. */
export async function redeem(tokenText) {
  if (!listenerState.listening) {
    throw new Error('Switch federation on here first, so the other server can reach this one back');
  }
  const token = store.parseJoinToken(tokenText);
  const existing = store.getPeer(token.systemId);
  if (existing) throw new Error(`Already paired with ${existing.name}`);
  const { status, body, certificate } = await request(
    { address: token.address, fingerprint: token.fingerprint },
    'POST', '/federation/v1/pair', { secret: token.secret, identity: myIdentity() },
  );
  if (status !== 201) throw new Error(body?.error ?? `${token.address} answered ${status}`);
  const them = store.validateIdentity(body?.identity);
  if (them.systemId !== token.systemId) throw new Error('The server that answered is not the one the token names');
  const peer = store.upsertPeer({ ...them, address: token.address, certificate, fingerprint: token.fingerprint, awaiting: 'them' });
  startProbe(them.systemId);
  return peer;
}

/** An admin here accepts a site that redeemed our token. */
export async function accept(systemId, acceptedBy) {
  const row = store.peerRow(systemId);
  if (!row || row.state !== 'pending' || row.awaiting !== 'us') throw new Error('Nothing is waiting to be accepted');
  store.markPaired(systemId, acceptedBy);
  startProbe(systemId);
  // Probe now: our probe is what tells them they were accepted, so the other
  // admin sees "paired" in seconds rather than at their next minute.
  await probe(systemId).catch(() => {});
  return store.getPeer(systemId);
}

/** Remove a peer: local and immediate, then tell them, best effort. */
export async function remove(systemId) {
  const row = store.peerRow(systemId);
  if (!row || row.state === 'removed') throw new Error('Unknown server');
  stopProbe(systemId);
  store.markRemoved(systemId);
  // Told AFTER forgetting them locally: if this never arrives, their next
  // probe is refused and they show "no longer paired", which is the truth.
  if (listenerState.listening) {
    request(row, 'POST', '/federation/v1/unpair').catch(() => {});
  }
  return store.getPeer(systemId);
}
