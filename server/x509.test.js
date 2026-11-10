// The hand-written certificate encoder, at its edges. Its ordinary output is
// exercised end to end (TLS handshake, pinning) in identity.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { selfSignedCertificate } from './x509.js';

const key = () => crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;

test('validity past 2049 switches to GeneralizedTime, and still parses', () => {
  // RFC 5280: UTCTime has a two-digit year and stops at 2049.
  const pem = selfSignedCertificate(key(), { commonName: 'Edge', notBefore: new Date('2040-06-01T00:00:00Z'), years: 20 });
  const cert = new crypto.X509Certificate(pem);
  assert.match(cert.validTo, /2060/);
  assert.match(cert.validFrom, /2040/);
});

test('a non-ASCII common name survives the round trip', () => {
  const cert = new crypto.X509Certificate(selfSignedCertificate(key(), { commonName: 'Grace Fellowship — North' }));
  assert.equal(cert.subject, 'CN=Grace Fellowship — North');
});

test('every certificate gets its own positive serial', () => {
  const k = key();
  const serials = new Set(Array.from({ length: 20 }, () => new crypto.X509Certificate(selfSignedCertificate(k, { commonName: 's' })).serialNumber));
  assert.equal(serials.size, 20);
});

test('it refuses a key it does not know how to write', () => {
  const ed = crypto.generateKeyPairSync('ed25519').privateKey;
  assert.throws(() => selfSignedCertificate(ed, { commonName: 'x' }), /P-256/);
  const p384 = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey;
  assert.throws(() => selfSignedCertificate(p384, { commonName: 'x' }), /P-256/);
});
