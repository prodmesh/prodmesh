// The federation store's validation (ADR 0017). The pairing protocol itself
// runs between two real servers in federation.e2e.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PRODMESH_DATA_DIR = mkdtempSync(join(tmpdir(), 'prodmesh-fedstore-'));
const store = await import('./federation/store.js');
const { getIdentity } = await import('./identity.js');

test('addresses are a host and a port, never a URL', () => {
  assert.deepEqual(store.parseAddress('192.0.2.10'), { host: '192.0.2.10', port: 8443 });
  assert.deepEqual(store.parseAddress('prodmesh-north.example.org:9443'), { host: 'prodmesh-north.example.org', port: 9443 });
  for (const bad of ['https://192.0.2.10', '192.0.2.10/x', '192.0.2.10:99999', 'a b', '', 'host:', '-host']) {
    assert.equal(store.parseAddress(bad), null, bad);
  }
});

test('configuration defaults to off, all interfaces, and validates what it is given', () => {
  const cfg = store.getConfig();
  assert.equal(cfg.enabled, false, 'a single-site church never opens the port');
  assert.equal(cfg.bind, 'all');
  assert.equal(cfg.port, 8443);
  assert.throws(() => store.setConfig({ port: 80 }), /1024/);
  assert.throws(() => store.setConfig({ bind: 'no-such-nic0' }), /No network interface/);
  assert.throws(() => store.setConfig({ address: 'https://x' }), /hostname/);
  store.setConfig({ address: 'prodmesh.example.org', port: 9443 });
  assert.equal(store.federationAddress(), 'prodmesh.example.org:9443', 'the port follows the configuration');
  store.setConfig({ address: '' });
  assert.match(store.federationAddress(), /:9443$/, 'blank means this machine, prefilled');
  store.setConfig({ port: 8443 });
});

test('a join token round-trips, and a damaged one says what to do', () => {
  const { token } = store.mintJoinToken();
  // Our own token is refused by our own parser…
  assert.throws(() => store.parseJoinToken(token), /own token/);
  // …so pretend it came from another site.
  const body = JSON.parse(Buffer.from(token.slice(8), 'base64url').toString());
  const theirs = `pmjoin1.${Buffer.from(JSON.stringify({ ...body, id: crypto.randomUUID() })).toString('base64url')}`;
  const parsed = store.parseJoinToken(`  ${theirs}\n`);
  assert.equal(parsed.fingerprint, getIdentity().tlsFingerprint);
  assert.ok(parsed.expiresAt > Date.now());

  assert.throws(() => store.parseJoinToken('hello'), /not a ProdMesh join token/);
  assert.throws(() => store.parseJoinToken(theirs.slice(0, -12)), /damaged/);
  const expired = `pmjoin1.${Buffer.from(JSON.stringify({ ...body, id: crypto.randomUUID(), exp: Date.now() - 1 })).toString('base64url')}`;
  assert.throws(() => store.parseJoinToken(expired), /expired/);
  const future = `pmjoin1.${Buffer.from(JSON.stringify({ ...body, v: 2 })).toString('base64url')}`;
  assert.throws(() => store.parseJoinToken(future), /newer ProdMesh/);
});

test('a secret is spent exactly once, and cancelling or expiry ends it', () => {
  const { token, id } = store.mintJoinToken();
  const { secret } = JSON.parse(Buffer.from(token.slice(8), 'base64url').toString());
  assert.equal(store.consumeJoinToken(secret, 'site-a'), true);
  assert.equal(store.consumeJoinToken(secret, 'site-b'), false, 'the second redeemer loses');
  assert.ok(!store.listJoinTokens().some((t) => t.id === id), 'a spent token is no longer outstanding');

  const other = store.mintJoinToken();
  const otherSecret = JSON.parse(Buffer.from(other.token.slice(8), 'base64url').toString()).secret;
  assert.equal(store.cancelJoinToken(other.id), true);
  assert.equal(store.consumeJoinToken(otherSecret, 'site-a'), false);
  assert.equal(store.consumeJoinToken('never-issued', 'site-a'), false);
});

test('what a peer says about itself is validated; its certificate is not taken from it', () => {
  const key = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const ok = store.validateIdentity({ systemId: crypto.randomUUID(), name: '  South  ', address: '192.0.2.20', signingPublicKey: key });
  assert.equal(ok.name, 'South');
  assert.equal(ok.address, '192.0.2.20:8443');
  assert.throws(() => store.validateIdentity({ ...ok, systemId: 'nope' }), /system id/);
  assert.throws(() => store.validateIdentity({ ...ok, systemId: getIdentity().systemId }), /own/);
  assert.throws(() => store.validateIdentity({ ...ok, address: 'https://evil/' }), /address/);
  const p256 = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  assert.throws(() => store.validateIdentity({ ...ok, signingPublicKey: p256 }), /Ed25519/);
  assert.ok(!('certificate' in ok) && !('fingerprint' in ok));
});
