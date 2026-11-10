// ─────────────────────────────────────────────────────────────────────────────
//  SYSTEM IDENTITY  —  what this ProdMesh is, independent of the machine (#49).
//
//  A peer at another campus records this server BY its identity (ADR 0014),
//  and a remote room is addressed as `<systemId>/<roomId>`. A client that
//  reconnects should find the same ProdMesh after DHCP moves it, or after the
//  church replaces the Mac mini and restores a backup onto the new one. So
//  the identity belongs to the installation, not the hardware: it lives in
//  the data directory, travels in backups, and survives a restore unchanged —
//  a new identity on restore would break every peer's pin.
//
//  Four things, generated once on first boot with node:crypto alone:
//
//    systemId      a UUID: what peers and clients key on
//    name          editable in Admin; defaults to the institution name
//    signing key   Ed25519: signs cross-site user assertions (ADR 0014)
//    certificate   self-signed ECDSA P-256: the federation link's TLS, whose
//                  SHA-256 fingerprint is what pairing pins. P-256, not
//                  Ed25519, because browsers refuse Ed25519 certificates and
//                  ADR 0016's operator tier C is a browser accepting this one.
//
//  Files, in <data>/identity/: identity.json (public), signing.key and tls.key
//  (private, 0600, like secrets.json), tls.crt (public). The name is ordinary
//  configuration and lives in the database.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, getDb } from './db.js';
import { assertNotSealed } from './restoreSeal.js';
import { selfSignedCertificate } from './x509.js';
import { getChurch } from './appConfig.js';

const DIR = join(DATA_DIR, 'identity');
const FILES = {
  meta: join(DIR, 'identity.json'),
  signingKey: join(DIR, 'signing.key'),
  tlsKey: join(DIR, 'tls.key'),
  tlsCert: join(DIR, 'tls.crt'),
};
const NAME_KEY = 'system.name';
const NAME_MAX = 80;

let cached = null;

function writePrivate(path, text) {
  writeFileSync(path, text, { mode: 0o600 });
  // An existing file keeps its old mode through a write, so say it again.
  try { chmodSync(path, 0o600); } catch { /* Windows, some mounts */ }
}

/**
 * Read the identity from disk, creating whatever is missing.
 *
 * A missing KEY on an existing identity is regenerated with a loud warning
 * rather than refused: the box must still boot on a Sunday. But it changes
 * what peers have pinned, so it is never silent.
 */
function load() {
  assertNotSealed();
  mkdirSync(DIR, { recursive: true, mode: 0o700 });

  let meta = existsSync(FILES.meta) ? JSON.parse(readFileSync(FILES.meta, 'utf8')) : null;
  const fresh = !meta?.systemId;
  if (fresh) {
    meta = { systemId: crypto.randomUUID(), createdAt: Date.now() };
    writeFileSync(FILES.meta, `${JSON.stringify(meta, null, 2)}\n`);
  }
  const warn = (what) => {
    if (!fresh) console.warn(`[identity] ${what} was missing and has been regenerated. Paired sites will need to pair again.`);
  };

  if (!existsSync(FILES.signingKey)) {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    writePrivate(FILES.signingKey, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    warn('The signing key');
  }
  let tlsKey;
  if (!existsSync(FILES.tlsKey)) {
    ({ privateKey: tlsKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }));
    writePrivate(FILES.tlsKey, tlsKey.export({ type: 'pkcs8', format: 'pem' }));
    rmSync(FILES.tlsCert, { force: true }); // a certificate for a key that no longer exists is useless
    warn('The TLS key');
  } else {
    tlsKey = crypto.createPrivateKey(readFileSync(FILES.tlsKey));
  }
  if (!existsSync(FILES.tlsCert)) {
    writeFileSync(FILES.tlsCert, selfSignedCertificate(tlsKey, { commonName: `ProdMesh ${meta.systemId}` }));
    warn('The TLS certificate');
  }

  const signingKey = crypto.createPrivateKey(readFileSync(FILES.signingKey));
  const certificatePem = readFileSync(FILES.tlsCert, 'utf8');
  const cert = new crypto.X509Certificate(certificatePem);
  if (!cert.checkPrivateKey(tlsKey)) {
    // Somebody replaced one file and not the other. Refusing would take the
    // server down; using a mismatched pair would fail every TLS handshake
    // with an error that names neither file. Re-sign, loudly.
    writeFileSync(FILES.tlsCert, selfSignedCertificate(tlsKey, { commonName: `ProdMesh ${meta.systemId}` }));
    console.warn('[identity] tls.crt did not match tls.key and has been re-signed. Paired sites will need to pair again.');
    return load();
  }

  return {
    systemId: meta.systemId,
    createdAt: meta.createdAt,
    signingKey,
    signingPublicKey: crypto.createPublicKey(signingKey).export({ type: 'spki', format: 'der' }).toString('base64'),
    tlsKeyPem: tlsKey.export({ type: 'pkcs8', format: 'pem' }),
    certificatePem,
    tlsFingerprint: cert.fingerprint256,
  };
}

function material() {
  if (!cached) cached = load();
  return cached;
}

/** The configured name, or the institution name when none is set. */
export function getSystemName() {
  const row = getDb().prepare('SELECT value FROM app_config WHERE key = ?').get(NAME_KEY);
  return (row && JSON.parse(row.value)) || getChurch().name;
}

/** Set the name; an empty string clears it back to the institution name. */
export function setSystemName(input) {
  const name = String(input ?? '').trim();
  if (name.length > NAME_MAX) throw new Error(`Keep the name under ${NAME_MAX} characters`);
  const db = getDb();
  if (name) {
    db.prepare(
      'INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(NAME_KEY, JSON.stringify(name));
  } else {
    db.prepare('DELETE FROM app_config WHERE key = ?').run(NAME_KEY);
  }
  return getSystemName();
}

/**
 * The public identity: everything a peer or client may know. No private key
 * material leaves this module except through privateIdentity().
 */
export function getIdentity() {
  const m = material();
  return {
    systemId: m.systemId,
    name: getSystemName(),
    nameIsDefault: !getDb().prepare('SELECT 1 FROM app_config WHERE key = ?').get(NAME_KEY),
    createdAt: m.createdAt,
    signingPublicKey: m.signingPublicKey,
    tlsFingerprint: m.tlsFingerprint,
  };
}

/** For the federation listener and assertion signing (#46). Never serialised. */
export function privateIdentity() {
  const m = material();
  return { signingKey: m.signingKey, tlsKeyPem: m.tlsKeyPem, certificatePem: m.certificatePem };
}

/** Test seam: forget the cached identity so the next read goes to disk. */
export function _resetForTests() {
  cached = null;
}
