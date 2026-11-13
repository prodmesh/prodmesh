// Visiting's checks (ADR 0018), against a peer recorded directly, so each
// refusal can be produced exactly. The flow between two real servers is in
// federation.e2e.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PRODMESH_DATA_DIR = mkdtempSync(join(tmpdir(), 'prodmesh-fedvisit-'));
const store = await import('./federation/store.js');
const visit = await import('./federation/visit.js');
const auth = await import('./authStore.js');
const { getIdentity } = await import('./identity.js');

// A linked server we hold the signing key of.
const peerId = crypto.randomUUID();
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
store.upsertPeer({
  systemId: peerId, name: 'Grace — South', address: '192.0.2.20:8443', certificate: 'x',
  fingerprint: 'AB:'.repeat(31) + 'AB', awaiting: 'us',
  signingPublicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
});
store.markPaired(peerId);

function pass(over = {}, key = privateKey) {
  const now = Date.now();
  const claims = {
    v: 1, iss: peerId, aud: getIdentity().systemId, sub: 'u-1', username: 'alex', name: 'Alex',
    groups: ['Tech Directors'], iat: now, exp: now + 60_000, nonce: crypto.randomBytes(16).toString('hex'), ...over,
  };
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `pmvisit1.${body}.${crypto.sign(null, Buffer.from(body), key).toString('base64url')}`;
}
const reason = (fn) => { try { fn(); return 'accepted'; } catch (err) { return err.code; } };

test('a pass is checked for signer, audience, time and reuse', () => {
  assert.equal(visit.verify(pass()).username, 'alex');
  const once = pass();
  visit.verify(once);
  assert.equal(reason(() => visit.verify(once)), 'replayed');
  assert.equal(reason(() => visit.verify(pass({}, crypto.generateKeyPairSync('ed25519').privateKey))), 'bad_signature');
  assert.equal(reason(() => visit.verify(pass({ aud: crypto.randomUUID() }))), 'wrong_audience');
  assert.equal(reason(() => visit.verify(pass({ iss: crypto.randomUUID() }))), 'unknown_issuer');
  assert.equal(reason(() => visit.verify(pass({ exp: Date.now() + 3_600_000 }))), 'malformed', 'a long-lived pass is not one');
});

test('thirty seconds of clock difference is tolerated, more is named', () => {
  const now = Date.now();
  assert.equal(reason(() => visit.verify(pass({ iat: now + 20_000, exp: now + 80_000 }))), 'accepted');
  assert.equal(reason(() => visit.verify(pass({ iat: now + 90_000, exp: now + 150_000 }))), 'clock');
  assert.equal(reason(() => visit.verify(pass({ iat: now - 120_000, exp: now - 60_000 }))), 'clock');
});

test('a visitor row cannot sign in by PIN, and its permissions are the rules, cut to the list', () => {
  const userId = auth.upsertVisitor({ systemId: peerId, serverName: 'Grace — South', sub: 'u-9', username: 'sam', displayName: 'Sam', groups: ['Tech Directors'] });
  const row = auth.getUser(userId);
  assert.equal(row.username, 'sam@grace-south');
  assert.equal(auth.authenticate('sam@grace-south', '!'), null);
  assert.deepEqual(auth.createVisitorSession(userId).permissions, ['reports.view']);
  assert.ok(!auth.VISITOR_PERMISSIONS.includes('rooms.mode.override_lock'));
  auth.setVisitorRules(peerId, [{ group: 'tech directors', permissions: ['shows.operate'] }]);
  assert.deepEqual(auth.createVisitorSession(userId).permissions, ['shows.operate'], 'only the matching rule; the default is replaced');
  assert.throws(() => auth.setVisitorRules(peerId, [{ group: '*', permissions: ['system.update'] }]), /cannot be granted/);
  assert.throws(() => auth.setUserPin(userId, '123456'), /home server/);
  assert.equal(auth.upsertVisitor({ systemId: peerId, serverName: 'Grace — South', sub: 'u-9', username: 'sam', displayName: 'Samuel', groups: [] }), userId, 'the same person is the same row');
});

test('a landing path is a plain path on that server, nothing else', () => {
  assert.equal(visit.safePath('/room/south-main'), '/room/south-main');
  for (const bad of ['//evil.example', 'https://evil.example', 'javascript:alert(1)', '/room/<x>', '/a?b=c', '']) {
    assert.equal(visit.safePath(bad), '/', bad);
  }
});
