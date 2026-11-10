// ─────────────────────────────────────────────────────────────────────────────
//  A minimal self-signed X.509 certificate writer.
//
//  Node can parse certificates (crypto.X509Certificate) and sign arbitrary
//  bytes, but it has no API that WRITES one. The usual answers are a
//  dependency (node-forge, selfsigned) or shelling out to openssl. A
//  dependency is a cost on every deploy path — the git-install church's
//  `npm ci`, the Electron bundle, the Docker image — and openssl is not on a
//  stock Windows box, where the desktop app runs. A self-signed certificate is
//  a small, fixed structure, so it is written here: DER by hand, signed with
//  node:crypto, and checked in the tests by Node's own parser and its TLS stack.
//
//  It writes exactly one shape: an X.509 v3 certificate for an ECDSA P-256 key,
//  signed by itself with ecdsa-with-SHA256. Nothing here is general-purpose
//  ASN.1, and it should not grow into it.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';

// ── DER primitives (X.690) ───────────────────────────────────────────────────

function length(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), length(body.length), body]);
const seq = (...items) => tlv(0x30, Buffer.concat(items));
const set = (...items) => tlv(0x31, Buffer.concat(items));
const explicit = (n, inner) => tlv(0xa0 + n, inner);
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const octets = (b) => tlv(0x04, b);
const bitString = (b) => tlv(0x03, Buffer.concat([Buffer.from([0]), b])); // 0 unused bits
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0]));

/** A non-negative INTEGER from big-endian bytes: leading zeros trimmed, and a
 *  0x00 prefix where the top bit would otherwise make it negative. */
function integer(bytes) {
  let b = Buffer.from(bytes);
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}

function oid(dotted) {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const out = [40 * a + b];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    for (let v = Math.floor(n / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift((v & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

/** UTCTime through 2049, GeneralizedTime from 2050, as RFC 5280 §4.1.2.5 requires. */
function time(date) {
  const iso = date.toISOString().replace(/[-:T]/g, '').slice(0, 14); // YYYYMMDDHHMMSS
  return date.getUTCFullYear() < 2050
    ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`, 'ascii'))
    : tlv(0x18, Buffer.from(`${iso}Z`, 'ascii'));
}

// ── The certificate ──────────────────────────────────────────────────────────

const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2')); // parameters absent, per RFC 5758
const name = (commonName) => seq(set(seq(oid('2.5.4.3'), utf8(commonName))));

function extension(id, critical, value) {
  return seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));
}

/**
 * Self-sign a certificate for `privateKey` (an ECDSA P-256 KeyObject).
 * Returns the PEM text.
 *
 * Usable as a TLS server AND client certificate, because the federation link
 * may grow mutual TLS. Not a CA. No subjectAltName: the federation link pins
 * this certificate's fingerprint rather than checking a hostname, and a
 * hostname baked in here would be wrong the day the box is renamed.
 */
export function selfSignedCertificate(privateKey, { commonName, notBefore = new Date(), years = 20 } = {}) {
  if (privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('selfSignedCertificate writes ECDSA P-256 certificates only');
  }
  const publicKey = crypto.createPublicKey(privateKey);
  // An hour of back-dating absorbs a peer whose clock runs slightly ahead.
  const from = new Date(notBefore.getTime() - 60 * 60 * 1000);
  const to = new Date(from);
  to.setUTCFullYear(to.getUTCFullYear() + years);

  // Random positive serial, at most 20 octets (RFC 5280 §4.1.2.2).
  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;

  const extensions = explicit(3, seq(
    extension('2.5.29.19', true, seq()), // basicConstraints: not a CA
    extension('2.5.29.15', true, Buffer.from([0x03, 0x02, 0x07, 0x80])), // keyUsage: digitalSignature
    extension('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'), oid('1.3.6.1.5.5.7.3.2'))), // serverAuth, clientAuth
  ));

  const tbs = seq(
    explicit(0, integer([2])), // v3
    integer(serial),
    ECDSA_SHA256,
    name(commonName),
    seq(time(from), time(to)),
    name(commonName),
    publicKey.export({ type: 'spki', format: 'der' }), // already a SubjectPublicKeyInfo
    extensions,
  );
  // crypto.sign emits a DER Ecdsa-Sig-Value for EC keys, which is what the
  // signatureValue BIT STRING carries.
  const signature = crypto.sign('sha256', tbs, privateKey);
  const der = seq(tbs, ECDSA_SHA256, bitString(signature));

  const b64 = der.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}
