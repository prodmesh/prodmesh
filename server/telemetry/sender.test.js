// The sender, against a fake receiving end on loopback (ADR 0022 §6). Time is
// passed to tick() explicitly, so a month offline takes milliseconds.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { mkdtempSync, existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenOnLoopback } from '../testServer.js';

const DATA = mkdtempSync(join(tmpdir(), 'prodmesh-sender-'));
process.env.PRODMESH_DATA_DIR = DATA;
delete process.env.PRODMESH_TELEMETRY;

const settings = await import('../settings.js');
const deployment = await import('../deployment.js');
const collector = await import('./collector.js');
const sender = await import('./sender.js');
const { validate, ERRORS_MAX, MAX_BYTES } = await import('./schema.js');

const QUEUE = join(DATA, 'telemetry', 'pending.json');
const STATE = join(DATA, 'telemetry', 'sender.json');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ── The fake receiving end ───────────────────────────────────────────────────
let received = [];
let respond = (res) => { res.writeHead(202); res.end(); };
let server;
before(async () => {
  const s = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const key = crypto.createPublicKey({ key: Buffer.from(req.headers['x-prodmesh-key'], 'base64'), format: 'der', type: 'spki' });
      const sig = Buffer.from(String(req.headers['x-prodmesh-signature']).replace(/^ed25519=/, ''), 'base64');
      received.push({
        headers: req.headers,
        verified: crypto.verify(null, body, key, sig),
        report: JSON.parse(gunzipSync(body).toString('utf8')),
      });
      respond(res);
    });
  });
  ({ server } = await listenOnLoopback(s));
  process.env.PRODMESH_TELEMETRY_URL = `http://127.0.0.1:${server.address().port}/v1/reports`;
});
after(() => server?.close());

// ── A clean slate per test ───────────────────────────────────────────────────
const T0 = Date.UTC(2026, 10, 1, 0, 0);
let slot;
function wipe() {
  for (const f of [QUEUE, STATE]) { try { unlinkSync(f); } catch { /* none */ } }
}

beforeEach(() => {
  wipe();
  received = [];
  respond = (res) => { res.writeHead(202); res.end(); };
  sender._configureForTests();
  collector._resetForTests(T0);
  settings.setTelemetryEnabled(true, T0);
  slot = sender.nextSlot(T0, collector.telemetryId());
});

// ── Tests ────────────────────────────────────────────────────────────────────

test('off means nothing is sent, and nothing waits to be', async () => {
  settings.setTelemetryEnabled(false, T0);
  assert.equal(await sender.tick(slot + 1), 'off');
  assert.equal(received.length, 0);
  assert.equal(existsSync(QUEUE), false);
});

test('no endpoint, no sending', async () => {
  const saved = process.env.PRODMESH_TELEMETRY_URL;
  try {
    delete process.env.PRODMESH_TELEMETRY_URL;
    assert.equal(sender.DEFAULT_ENDPOINT, null, 'until the domain is decided');
    assert.equal(await sender.tick(slot + 1), 'no-endpoint');
    process.env.PRODMESH_TELEMETRY_URL = 'http://192.0.2.7/v1/reports';
    assert.equal(sender.endpoint(), null, 'plain http to anything but this machine is refused');
    process.env.PRODMESH_TELEMETRY_URL = 'https://telemetry.example.org/v1/reports';
    assert.equal(sender.endpoint()?.hostname, 'telemetry.example.org');
  } finally {
    process.env.PRODMESH_TELEMETRY_URL = saved;
  }
});

test('waits for this install’s slot, then sends a valid, signed, gzipped report', async () => {
  assert.equal(await sender.tick(slot - 60_000), 'not-due');
  assert.equal(await sender.tick(slot), 'sent');
  assert.equal(received.length, 1);
  const [r] = received;
  assert.equal(r.verified, true, 'signature checks out over the exact bytes');
  assert.equal(r.headers['content-encoding'], 'gzip');
  assert.deepEqual(validate(r.report), []);
  assert.equal(r.report.seq, 1);
  assert.equal(r.report.telemetryId, collector.telemetryId());
  assert.equal(existsSync(QUEUE), false, 'nothing left waiting');
  // Not again until tomorrow's slot.
  assert.equal(await sender.tick(slot + 6 * HOUR), 'not-due');
  assert.equal(await sender.tick(slot + DAY), 'sent');
  assert.equal(received[1].report.seq, 2);
});

test('slots spread installs over the day and stay put for each', () => {
  const minutes = new Set(Array.from({ length: 200 }, () => sender.slotMinute(crypto.randomUUID())));
  assert.ok(minutes.size > 150, `${minutes.size} distinct minutes of 200 installs`);
  const id = crypto.randomUUID();
  assert.equal(sender.slotMinute(id), sender.slotMinute(id));
});

test('never during a live show; it goes once the show ends', async () => {
  let live = true;
  sender._configureForTests({ showLive: () => live });
  assert.equal(await sender.tick(slot), 'show-live');
  assert.equal(received.length, 0);
  live = false;
  assert.equal(await sender.tick(slot + 5 * 60_000), 'sent');
});

test('a new bug brings a report forward, at most once an hour; a known one does not', async () => {
  // One code path per bug: the fingerprint includes the frames, so the same
  // error thrown from two places in the code is two bugs, by design.
  const first = () => new TypeError('first');
  const early = slot - 10 * HOUR;
  collector.recordError('signals', first(), early);
  assert.equal(await sender.tick(early), 'sent', 'a new bug goes early');
  collector.recordError('signals', new RangeError('second'), early + 10 * 60_000);
  assert.equal(await sender.tick(early + 10 * 60_000), 'not-due', 'within the hour');
  assert.equal(await sender.tick(early + HOUR), 'sent', 'the hour is up');
  // The first bug again: already reported, so it waits for the daily slot.
  collector.recordError('signals', first(), early + 2 * HOUR);
  assert.equal(await sender.tick(early + 3 * HOUR), 'not-due', 'a known bug waits for the slot');
});

test('a month offline: one bounded report when the network comes back', async () => {
  respond = (res) => { res.destroy(); }; // the connection drops, as with no route out
  let t = slot;
  let attempts = 0;
  for (let day = 0; day < 30; day += 1) {
    for (let i = 0; i < 40; i += 1) {
      const e = new Error(`bug ${day * 40 + i}`);
      e.name = `Kind${(day * 40 + i) % 90}`; // 90 kinds: more than a report holds
      collector.recordError('show', e, t);
    }
    // Tick through the day, as the five-minute timer would.
    for (let step = 0; step < 24 * 12; step += 1) {
      t += 5 * 60_000;
      if ((await sender.tick(t)) === 'failed') attempts += 1;
    }
    assert.ok(statSync(QUEUE).size <= MAX_BYTES, `day ${day}: queue ${statSync(QUEUE).size} bytes`);
  }
  assert.ok(attempts > 30 && attempts < 400, `${attempts} attempts in a month: backing off, not hammering`);

  respond = (res) => { res.writeHead(202); res.end(); };
  received = [];
  // Past whatever backoff is pending, at most six hours.
  assert.equal(await sender.tick(t + 6 * HOUR + 1), 'sent');
  assert.equal(received.length, 1);
  const { report } = received[0];
  assert.deepEqual(validate(report), []);
  assert.ok(report.errors.length <= ERRORS_MAX);
  assert.ok(report.errorsDropped > 0, 'the overflow is counted, not lost silently');
  assert.equal(report.window.from, T0, 'the report covers the whole month');
  const total = report.errors.reduce((n, e) => n + e.count, 0) + report.errorsDropped;
  assert.equal(total, 30 * 40, 'every occurrence is accounted for');
});

test('429 is honoured to the second it names', async () => {
  respond = (res) => { res.writeHead(429, { 'Retry-After': '3600' }); res.end(); };
  assert.equal(await sender.tick(slot), 'failed');
  assert.equal(await sender.tick(slot + HOUR - 60_000), 'backoff');
  respond = (res) => { res.writeHead(202); res.end(); };
  assert.equal(await sender.tick(slot + HOUR), 'sent');
});

test('400 drops the report rather than retrying it forever', async () => {
  respond = (res) => { res.writeHead(400); res.end(); };
  assert.equal(await sender.tick(slot), 'rejected');
  assert.equal(existsSync(QUEUE), false, 'the rejected report is gone');
  // The next tick sends a NEW window (the slot is still due, nothing was
  // sent), not the rejected bytes again.
  respond = (res) => { res.writeHead(202); res.end(); };
  received = [];
  assert.equal(await sender.tick(slot + 10 * 60_000), 'sent');
  assert.equal(received[0].report.window.from, slot, 'starts where the rejected one ended');
});

test('410 stops this version sending, until it is updated', async () => {
  respond = (res) => { res.writeHead(410); res.end(); };
  assert.equal(await sender.tick(slot), 'stopped');
  assert.equal(await sender.tick(slot + 2 * DAY), 'stopped');
  assert.equal(sender.status().stopped, true);
  const state = JSON.parse(readFileSync(STATE, 'utf8'));
  assert.equal(state.stoppedVersion, deployment.getVersion().version);
});

test('a response body is never acted on', async () => {
  respond = (res) => { res.writeHead(202, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ enabled: false, endpoint: 'https://elsewhere.example', resetId: true })); };
  const id = collector.telemetryId();
  assert.equal(await sender.tick(slot), 'sent');
  assert.equal(collector.telemetryId(), id);
  assert.equal(settings.getTelemetrySettings().enabled, true);
});

test('turning it off forgets what was queued', async () => {
  respond = (res) => { res.writeHead(503); res.end(); };
  assert.equal(await sender.tick(slot), 'failed');
  assert.equal(existsSync(QUEUE), true);
  settings.setTelemetryEnabled(false, slot);
  assert.equal(await sender.tick(slot + DAY), 'off');
  assert.equal(existsSync(QUEUE), false);
});

test('a reset id takes effect even on a report already queued', async () => {
  respond = (res) => { res.writeHead(503); res.end(); };
  await sender.tick(slot);
  const fresh = collector.resetTelemetryId();
  respond = (res) => { res.writeHead(202); res.end(); };
  assert.equal(await sender.tick(slot + 6 * HOUR + 1), 'sent');
  assert.equal(received.at(-1).report.telemetryId, fresh);
  assert.equal(received.at(-1).verified, true, 'signed with the new key');
});

test('fit() keeps an oversized report under the limit, frames first, rarest errors last', () => {
  const big = collector.buildReport({ now: T0 });
  big.errors = Array.from({ length: ERRORS_MAX }, (_, i) => ({
    where: 'show', name: 'Error', message: 'x'.repeat(200),
    frames: Array.from({ length: 20 }, (__, j) => `fn${j} (server/some/long/path/to/module${j}.js:${i}:1)`),
    fingerprint: crypto.randomBytes(8).toString('hex'), count: i + 1, firstSeen: 0, lastSeen: 0,
  }));
  assert.ok(Buffer.byteLength(JSON.stringify(big)) > MAX_BYTES, 'the test needs an oversized report');
  const out = sender.fit(big);
  assert.ok(Buffer.byteLength(JSON.stringify(out)) <= MAX_BYTES);
  assert.deepEqual(validate(out), []);
  assert.ok(out.errors.every((e) => e.frames.length <= 8));
});

test('the telemetry key file is private from its first byte', { skip: process.platform === 'win32' }, () => {
  collector.resetTelemetryId();
  assert.equal(statSync(join(DATA, 'telemetry', 'id.json')).mode & 0o777, 0o600);
});
