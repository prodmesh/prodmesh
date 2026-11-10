// System identity (#49): created once, stable, usable for what multi-site
// needs it for — a TLS handshake pinned by fingerprint, an Ed25519 signature
// a peer can verify — and carried intact through backup and restore.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import https from 'node:https';
import { mkdtempSync, readFileSync, statSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenOnLoopback } from './testServer.js';

const DATA = mkdtempSync(join(tmpdir(), 'prodmesh-identity-'));
process.env.PRODMESH_DATA_DIR = DATA;

const identity = await import('./identity.js');
const { app } = await import('./index.js');
const backup = await import('./backup.js');
const settings = await import('./settings.js');
const { getChurch } = await import('./appConfig.js');

const DIR = join(DATA, 'identity');
const posix = process.platform !== 'win32';

let base;
let server;
before(async () => { ({ server, base } = await listenOnLoopback(app)); });
after(() => server.close());

test('first read creates an identity, and it is the same identity ever after', () => {
  const first = identity.getIdentity();
  assert.match(first.systemId, /^[0-9a-f-]{36}$/);
  for (const f of ['identity.json', 'signing.key', 'tls.key', 'tls.crt']) {
    assert.ok(existsSync(join(DIR, f)), `${f} written`);
  }
  if (posix) {
    for (const f of ['signing.key', 'tls.key']) {
      assert.equal(statSync(join(DIR, f)).mode & 0o777, 0o600, `${f} is private`);
    }
  }
  // As a restart would: forget the cache and read it back from disk.
  identity._resetForTests();
  const again = identity.getIdentity();
  assert.equal(again.systemId, first.systemId);
  assert.equal(again.tlsFingerprint, first.tlsFingerprint);
  assert.equal(again.signingPublicKey, first.signingPublicKey);
});

test('the certificate is a valid self-signed P-256 certificate for this system', () => {
  const { certificatePem, tlsKeyPem } = identity.privateIdentity();
  const cert = new crypto.X509Certificate(certificatePem);
  const me = identity.getIdentity();
  assert.equal(cert.fingerprint256, me.tlsFingerprint);
  assert.ok(cert.checkPrivateKey(crypto.createPrivateKey(tlsKeyPem)));
  assert.ok(cert.verify(cert.publicKey), 'signed by itself');
  assert.equal(cert.publicKey.asymmetricKeyDetails.namedCurve, 'prime256v1');
  assert.equal(cert.ca, false);
  assert.equal(cert.subject, `CN=ProdMesh ${me.systemId}`);
  assert.ok(new Date(cert.validTo) > new Date(Date.now() + 10 * 365 * 86_400_000), 'long-lived: it is pinned, not chained');
});

// The point of the certificate: a peer that has pinned this fingerprint can
// open TLS to this server, and one pinned to anything else cannot.
test('Node TLS accepts the certificate when its fingerprint is pinned, and refuses otherwise', async () => {
  const { certificatePem, tlsKeyPem } = identity.privateIdentity();
  const { tlsFingerprint } = identity.getIdentity();
  const tlsServer = https.createServer({ key: tlsKeyPem, cert: certificatePem }, (_req, res) => res.end('ok'));
  await new Promise((r) => tlsServer.listen(0, '127.0.0.1', r));
  const { port } = tlsServer.address();

  // How the federation client will connect: trust exactly this certificate,
  // and check the fingerprint instead of a hostname.
  const connect = (pin) => new Promise((resolve) => {
    const req = https.get({
      host: '127.0.0.1', port, path: '/', ca: certificatePem, agent: false,
      checkServerIdentity: (_host, cert) => (
        cert.fingerprint256 === pin ? undefined : new Error(`fingerprint ${cert.fingerprint256} is not the pinned one`)
      ),
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', (err) => resolve(err));
  });
  try {
    assert.equal(await connect(tlsFingerprint), 200);
    const refused = await connect('00:'.repeat(31) + '00');
    assert.ok(refused instanceof Error, 'a different pin must fail the handshake');
    assert.match(refused.message, /not the pinned one/);
  } finally {
    tlsServer.close();
  }
});

test('a peer can verify what this server signs, from the public key it publishes', () => {
  const statement = Buffer.from(JSON.stringify({ user: 'u-1', aud: 'peer-system', exp: Date.now() + 60_000 }));
  const signature = crypto.sign(null, statement, identity.privateIdentity().signingKey);
  const published = crypto.createPublicKey({
    key: Buffer.from(identity.getIdentity().signingPublicKey, 'base64'), format: 'der', type: 'spki',
  });
  assert.equal(published.asymmetricKeyType, 'ed25519');
  assert.ok(crypto.verify(null, statement, published, signature));
  assert.ok(!crypto.verify(null, Buffer.from('tampered'), published, signature));
});

test('the name defaults to the institution, can be set, and clears back', () => {
  assert.equal(identity.getIdentity().name, getChurch().name);
  assert.equal(identity.getIdentity().nameIsDefault, true);
  assert.equal(identity.setSystemName('  Grace Fellowship — North  '), 'Grace Fellowship — North');
  assert.equal(identity.getIdentity().nameIsDefault, false);
  assert.throws(() => identity.setSystemName('x'.repeat(81)), /under 80/);
  assert.equal(identity.setSystemName(''), getChurch().name);
});

test('the API publishes the public identity and nothing private', async () => {
  const about = await (await fetch(`${base}/api/about`)).json();
  const me = identity.getIdentity();
  assert.equal(about.systemId, me.systemId);
  assert.equal(about.systemName, me.name);
  // v1 serves the same answer: the new fields are additive.
  assert.deepEqual(await (await fetch(`${base}/api/v1/about`)).json(), about);

  const res = await fetch(`${base}/api/system/identity`);
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.ok(!/PRIVATE KEY|tlsKey|signingKey"/.test(text), 'no private material');
  const body = JSON.parse(text);
  assert.equal(body.tlsFingerprint, me.tlsFingerprint);
  assert.equal(body.signingPublicKey, me.signingPublicKey);
  assert.equal((await fetch(`${base}/api/v1/system/identity`)).status, 404, 'not frozen into v1 yet');
});

test('renaming needs config.manage', async () => {
  const put = (token) => fetch(`${base}/api/system/identity`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ name: 'Grace Fellowship — South' }),
  });
  assert.equal((await put()).status, 401);
  settings.setPins({ admin: 'admin1234' });
  const { token } = await (await fetch(`${base}/api/auth/admin`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: 'admin1234' }),
  })).json();
  const res = await put(token);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).name, 'Grace Fellowship — South');
  identity.setSystemName('');
});

test('backup and restore carry the identity unchanged, keys still private', () => {
  const into = mkdtempSync(join(tmpdir(), 'prodmesh-identity-restore-'));
  backup.restoreBackup(backup.readBackup(backup.createBackup()), { dataDir: into });
  for (const f of ['identity.json', 'signing.key', 'tls.key', 'tls.crt']) {
    assert.deepEqual(readFileSync(join(into, 'identity', f)), readFileSync(join(DIR, f)), `${f} identical`);
  }
  if (posix) {
    for (const f of ['signing.key', 'tls.key']) {
      assert.equal(statSync(join(into, 'identity', f)).mode & 0o777, 0o600, `restored ${f} is still private`);
    }
  }
});

test('a lost key is regenerated, loudly, under the same system id', () => {
  const before = identity.getIdentity();
  rmSync(join(DIR, 'tls.key'));
  identity._resetForTests();
  const warnings = [];
  const warn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    const afterLoss = identity.getIdentity();
    assert.equal(afterLoss.systemId, before.systemId, 'still the same system');
    assert.notEqual(afterLoss.tlsFingerprint, before.tlsFingerprint, 'but a new certificate');
    assert.ok(warnings.some((w) => /pair again/.test(w)), 'and it says what that costs');
  } finally {
    console.warn = warn;
  }
});

test('a certificate that does not match its key is re-signed rather than served', () => {
  const other = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
  writeFileSync(join(DIR, 'tls.key'), other.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  identity._resetForTests();
  const warn = console.warn;
  console.warn = () => {};
  try {
    const { certificatePem, tlsKeyPem } = identity.privateIdentity();
    assert.ok(new crypto.X509Certificate(certificatePem).checkPrivateKey(crypto.createPrivateKey(tlsKeyPem)));
  } finally {
    console.warn = warn;
  }
});
