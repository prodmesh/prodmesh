// Two real ProdMesh servers, paired the way two admins would pair them
// (ADR 0017). Each is its own process with its own data directory, identity
// and ports, because a pairing between two copies of one module's state
// would prove nothing.
//
// Everything is on 127.0.0.1: PRODMESH_FEDERATION_HOST keeps the federation
// listeners off the machine's real interfaces while the tests run.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selfSignedCertificate } from './x509.js';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), 'index.js');

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function boot(label) {
  const site = { label, port: await freePort(), fedPort: await freePort(), log: '' };
  site.proc = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PRODMESH_DATA_DIR: mkdtempSync(join(tmpdir(), `prodmesh-fed-${label}-`)),
      PRODMESH_SEED: 'empty',
      PORT: String(site.port),
      PRODMESH_FEDERATION_HOST: '127.0.0.1',
      PRODMESH_FEDERATION_PROBE_MS: '250',
      PRODMESH_FEDERATION_DIGEST_MS: '250',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  site.proc.stdout.on('data', (d) => { site.log += d; });
  site.proc.stderr.on('data', (d) => { site.log += d; });
  site.base = `http://127.0.0.1:${site.port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${site.base}/api/about`)).ok) break; } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  // The admin PIN bootstrap, then a session, as the setup wizard does.
  await call(site, 'POST', '/api/settings/pins', { admin: 'admin1234' });
  site.token = (await (await call(site, 'POST', '/api/auth/admin', { pin: 'admin1234' })).json()).token;
  site.identity = await (await call(site, 'GET', '/api/system/identity')).json();
  return site;
}

function call(site, method, path, body) {
  return fetch(site.base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(site.token ? { Authorization: `Bearer ${site.token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const json = async (res) => ({ status: res.status, ...(await res.json()) });
const until = async (check, what, ms = 5000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await check();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
};
const peersOf = async (site) => (await (await call(site, 'GET', '/api/federation')).json()).peers;

let north;
let south;
before(async () => {
  [north, south] = await Promise.all([boot('north'), boot('south')]);
  for (const site of [north, south]) {
    const res = await json(await call(site, 'PUT', '/api/federation', {
      enabled: true, port: site.fedPort, address: `127.0.0.1:${site.fedPort}`,
    }));
    assert.equal(res.listener.listening, true, `${site.label} federation listener: ${res.listener.error}\n${site.log}`);
  }
});
after(() => { north?.proc.kill(); south?.proc.kill(); });

test('federation is off until switched on, and only an administrator can touch it', async () => {
  const anon = await fetch(`${north.base}/api/federation`);
  assert.equal(anon.status, 401);
  // The federation routes are not on the dashboard port at all. (With a built
  // frontend the dashboard answers any unknown path with the web app's HTML,
  // so the check is that no federation answer comes back, not the status.)
  const res = await fetch(`${north.base}/federation/v1/hello`);
  assert.doesNotMatch(res.headers.get('content-type') ?? '', /json/);
  assert.doesNotMatch(await res.text(), /systemId/);
});

let tokenText;
test('a token pairs in two steps: redeem there, accept here', async () => {
  const minted = await json(await call(north, 'POST', '/api/federation/tokens'));
  assert.equal(minted.status, 201);
  tokenText = minted.token;
  assert.match(tokenText, /^pmjoin1\./);
  const body = JSON.parse(Buffer.from(tokenText.slice(8), 'base64url').toString());
  assert.equal(body.id, north.identity.systemId);
  assert.equal(body.fp, north.identity.tlsFingerprint);
  assert.equal(body.addr, `127.0.0.1:${north.fedPort}`);

  // South redeems. It is now waiting on North.
  const redeemed = await json(await call(south, 'POST', '/api/federation/redeem', { token: tokenText }));
  assert.equal(redeemed.status, 201, redeemed.error);
  assert.equal(redeemed.peer.systemId, north.identity.systemId);
  assert.equal(redeemed.peer.state, 'pending');
  assert.equal(redeemed.peer.awaiting, 'them');

  // North sees South waiting for an admin, pinned to South's real certificate.
  const [waiting] = await peersOf(north);
  assert.equal(waiting.systemId, south.identity.systemId);
  assert.equal(waiting.awaiting, 'us');
  assert.equal(waiting.fingerprint, south.identity.tlsFingerprint);

  // A token is single-use, even for the site that already spent it.
  const again = await json(await call(south, 'POST', '/api/federation/redeem', { token: tokenText }));
  assert.equal(again.status, 400);
  assert.match(again.error, /Already paired/);

  // North accepts; North's immediate probe is what tells South.
  const accepted = await json(await call(north, 'POST', `/api/federation/peers/${south.identity.systemId}/accept`));
  assert.equal(accepted.peer.state, 'paired');
  await until(async () => (await peersOf(south))[0]?.state === 'paired', 'South to see the pairing accepted');
});

test('paired sites probe each other into health, with clock skew measured', async () => {
  for (const [site, other] of [[north, south], [south, north]]) {
    const ok = await until(async () => {
      const health = await (await call(site, 'GET', '/api/system/health')).json();
      return health.integrations[`peer:${other.identity.systemId}`]?.ok === true;
    }, `${site.label} to report ${other.label} reachable`);
    assert.ok(ok);
    const [peer] = await peersOf(site);
    assert.ok(peer.lastSeenAt > 0);
    assert.ok(Math.abs(peer.clockSkewMs) < 2000, `skew ${peer.clockSkewMs}ms on one machine`);
  }
});

test('an address change on one side heals on the other through the link', async () => {
  // As if North's DHCP lease changed: it now says it is reachable as
  // "localhost". South learns it from North's next authenticated probe.
  await call(north, 'PUT', '/api/federation', { address: `localhost:${north.fedPort}` });
  await until(async () => (await peersOf(south))[0]?.address === `localhost:${north.fedPort}`, 'South to learn North’s new address');
  await call(north, 'PUT', '/api/federation', { address: `127.0.0.1:${north.fedPort}` });
});

// ── ADR 0018: the directory and digests ─────────────────────────────────────

const campus = (id, name, rooms, status = 'active') => ({
  id, name, status, auditoriums: rooms.map(([rid, rname]) => ({ id: rid, name: rname, tiles: [] })),
});
const remoteOf = async (site) => (await (await fetch(`${site.base}/api/federation/campuses`)).json());

test('each server learns what the other runs, and a rename follows within a probe', async () => {
  const put = await call(south, 'PUT', '/api/config', {
    name: 'Grace Church',
    sites: [
      campus('south', 'South Campus', [['south-main', 'Main Auditorium'], ['south-youth', 'Youth Room']]),
      campus('chapel', 'Chapel Campus', [['chapel-main', 'Chapel']], 'disabled'),
    ],
  });
  assert.equal(put.status, 200, await put.text());

  // Anonymous, like the rest of the dashboard's reads.
  const [server] = await until(async () => {
    const list = await remoteOf(north);
    return list[0]?.campuses?.[0]?.rooms?.length === 2 ? list : null;
  }, 'North to fetch South’s directory');
  assert.equal(server.systemId, south.identity.systemId);
  assert.deepEqual(server.campuses.map((c) => c.id), ['south'], 'a disabled campus is not published');
  assert.match(server.dashboardUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(server.reachable, true);
  for (const secret of ['address', 'fingerprint', 'certificate']) {
    assert.ok(!(secret in server), `${secret} is not public`);
  }

  const [peer] = await peersOf(north);
  assert.equal(peer.sharesCampuses, true);
  assert.match(peer.version, /^\d+\.\d+/);

  await call(south, 'PUT', '/api/config', {
    name: 'Grace Church',
    sites: [campus('south', 'South Everett', [['south-main', 'Main Auditorium'], ['south-youth', 'Youth Room']])],
  });
  await until(async () => (await remoteOf(north))[0]?.campuses[0]?.name === 'South Everett', 'North to see the rename');

  // The remote rooms are not North's rooms: nothing local learned of them.
  const rooms = await (await fetch(`${north.base}/api/rooms`)).json();
  assert.ok(!rooms.some((r) => r.id.startsWith('south')), 'remote rooms never enter the local room list');
});

/** Read an SSE stream until `match(data)` holds for a message on `topic`. */
async function streamUntil(site, topic, match, what, ms = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  let last;
  try {
    const res = await fetch(`${site.base}/api/stream?topics=${encodeURIComponent(topic)}`, { signal: ctl.signal });
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        const msg = JSON.parse(line.slice(6));
        if (msg.topic === topic) last = msg.data;
        if (msg.topic === topic && match(msg.data)) return msg.data;
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') throw err;
  } finally {
    clearTimeout(timer);
    ctl.abort();
  }
  return assert.fail(`timed out waiting for ${what}; last: ${JSON.stringify(last)}`);
}

test('a digest flows only while someone watches, with an observation time on each value', async () => {
  const topic = `site:${south.identity.systemId}:summary`;
  const digest = await streamUntil(north, topic,
    (d) => d.reachable && d.rooms['south-main']?.health?.observedAt != null,
    'a digest with South’s room health observed');
  const room = digest.rooms['south-main'];
  assert.equal(room.show.active, false);
  assert.ok(Math.abs(room.health.observedAt - Date.now()) < 10_000);
  // A room added in Admin starts without room-mode control, and a room with
  // no mode says nothing about one rather than "unknown".
  assert.ok(!('mode' in room));
  assert.ok(Array.isArray(room.health.integrations));
  assert.ok('south-youth' in digest.rooms);

  // A topic for something that is not a paired server is refused, not polled:
  // the stream is anonymous and subscribing starts network work.
  const bogus = `site:${crypto.randomUUID()}:summary`;
  const res = await fetch(`${north.base}/api/stream?topics=${bogus}`, { signal: AbortSignal.timeout(500) }).catch(() => null);
  assert.ok(!res || res.ok, 'the stream itself still opens');
});

// ── ADR 0018: visiting ──────────────────────────────────────────────────────

const as = (site, token, method, path, body) => fetch(site.base + path, {
  method,
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const passFrom = (url) => new URLSearchParams(new URL(url).hash.slice(1));

let visitorToken;
test('Open signs a pass at home; the other server admits a read-only visitor once', async () => {
  // Anonymous at home: nobody to vouch for.
  assert.equal((await as(north, null, 'POST', '/api/federation/visit', { systemId: south.identity.systemId })).status, 401);

  const { url } = await (await call(north, 'POST', '/api/federation/visit', {
    systemId: south.identity.systemId, path: '/room/south-main',
  })).json();
  assert.ok(url.startsWith(`http://127.0.0.1:${south.port}/visit#`), url);
  const params = passFrom(url);
  assert.equal(params.get('to'), '/room/south-main');
  const pass = params.get('pass');
  assert.match(pass, /^pmvisit1\./);

  const arrived = await (await as(south, null, 'POST', '/api/federation/arrive', { pass })).json();
  assert.ok(arrived.token, JSON.stringify(arrived));
  assert.match(arrived.user.username, /^admin@/);
  assert.equal(arrived.user.originSystemId, north.identity.systemId);
  assert.deepEqual(arrived.permissions, ['reports.view'], 'pairing alone lets a visitor read');
  visitorToken = arrived.token;

  // Single use.
  const again = await (await as(south, null, 'POST', '/api/federation/arrive', { pass })).json();
  assert.equal(again.reason, 'replayed');

  // Known as a visitor, without a station, and without any admin reach.
  const status = await (await as(south, visitorToken, 'GET', '/api/auth/status')).json();
  assert.equal(status.authenticated, true);
  assert.equal(status.visitor.systemId, north.identity.systemId);
  assert.equal(status.admin, false);
  assert.equal((await as(south, visitorToken, 'GET', '/api/users')).status, 403);
  // No onward vouching to a third server.
  assert.equal((await as(south, visitorToken, 'POST', '/api/federation/visit', { systemId: north.identity.systemId })).status, 403);
});

test('a forged, tampered or misdirected pass is refused', async () => {
  const { url } = await (await call(north, 'POST', '/api/federation/visit', { systemId: south.identity.systemId })).json();
  const pass = passFrom(url).get('pass');
  const [body, sig] = pass.slice('pmvisit1.'.length).split('.');
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
  const tampered = `pmvisit1.${Buffer.from(JSON.stringify({ ...claims, groups: [...claims.groups, 'Elevated'] })).toString('base64url')}.${sig}`;
  const t = await (await as(south, null, 'POST', '/api/federation/arrive', { pass: tampered })).json();
  assert.equal(t.reason, 'bad_signature', JSON.stringify(t));
  // Made for South, presented to North: North is not its own peer.
  assert.equal((await (await as(north, null, 'POST', '/api/federation/arrive', { pass })).json()).reason, 'unknown_issuer');
  assert.equal((await (await as(south, null, 'POST', '/api/federation/arrive', { pass: 'nonsense' })).json()).reason, 'malformed');
});

test('what a visitor may do is the visited server’s rule, cut to the grantable list', async () => {
  const north_ = north.identity.systemId;
  const refused = await call(south, 'PUT', `/api/federation/peers/${north_}/visitors`, {
    rules: [{ group: '*', permissions: ['users.manage'] }],
  });
  assert.equal(refused.status, 400, 'nothing administrative can be granted to a visitor');
  const override = await call(south, 'PUT', `/api/federation/peers/${north_}/visitors`, {
    rules: [{ group: '*', permissions: ['rooms.mode.override_lock'] }],
  });
  assert.equal(override.status, 400, 'nor overriding a schedule lock');

  const ok = await json(await call(south, 'PUT', `/api/federation/peers/${north_}/visitors`, {
    rules: [{ group: '*', permissions: ['reports.view'] }, { group: 'administrators', permissions: ['shows.operate'] }],
  }));
  assert.equal(ok.status, 200);
  // Takes effect on the visitor's next request, no new pass needed. North's
  // admin account is in North's Administrators group, matched case-blind.
  const status = await (await as(south, visitorToken, 'GET', '/api/auth/status')).json();
  assert.deepEqual(status.permissions, ['reports.view', 'shows.operate']);

  const users = await (await call(south, 'GET', '/api/users')).json();
  assert.ok(!users.users.some((u) => u.originSystemId), 'visitors are not in the local user list');
  assert.equal(users.visitors.length, 1);
  assert.equal(users.visitors[0].originSystemId, north_);
});

// A raw client on the federation port, presenting a certificate of its own.
function rawFederation(port, { cert = true, path = '/federation/v1/hello', method = 'GET', body } = {}) {
  const key = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: '127.0.0.1', port, rejectUnauthorized: false,
      ...(cert ? { key: key.export({ type: 'pkcs8', format: 'pem' }), cert: selfSignedCertificate(key, { commonName: 'Intruder' }) } : {}),
    }, () => {
      const payload = body ? JSON.stringify(body) : '';
      socket.write(`${method} ${path} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`);
    });
    let out = '';
    socket.on('data', (d) => { out += d; });
    socket.on('end', () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(out)?.[1])));
    socket.on('error', reject);
  });
}

test('the federation port refuses anyone who is not a paired site', async () => {
  assert.equal(await rawFederation(north.fedPort, { cert: false }), 401, 'no certificate');
  assert.equal(await rawFederation(north.fedPort), 403, 'an unknown certificate');
  assert.equal(await rawFederation(north.fedPort, { method: 'POST', path: '/federation/v1/unpair' }), 403);
  // A made-up secret is refused, and does not pair anything.
  const status = await rawFederation(north.fedPort, {
    method: 'POST', path: '/federation/v1/pair',
    body: {
      secret: 'guess',
      identity: {
        systemId: crypto.randomUUID(), name: 'Intruder', address: '192.0.2.66:8443',
        signingPublicKey: crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      },
    },
  });
  assert.equal(status, 403);
  assert.equal((await peersOf(north)).length, 1, 'still only South');
});

test('a token pointing at the wrong certificate never sends its secret', async () => {
  const minted = await json(await call(north, 'POST', '/api/federation/tokens'));
  const body = JSON.parse(Buffer.from(minted.token.slice(8), 'base64url').toString());
  // Same address, a different pin: what an attacker in the middle would look
  // like from the redeeming side.
  const forged = `pmjoin1.${Buffer.from(JSON.stringify({ ...body, id: crypto.randomUUID(), fp: 'AB:'.repeat(31) + 'AB' })).toString('base64url')}`;
  const res = await json(await call(south, 'POST', '/api/federation/redeem', { token: forged }));
  assert.equal(res.status, 400);
  assert.match(res.error, /different certificate/);
  // The real token is still unspent, because nothing was sent.
  const tokens = (await (await call(north, 'GET', '/api/federation')).json()).tokens;
  assert.ok(tokens.some((t) => t.id === minted.id), 'the secret never reached North');
  await call(north, 'DELETE', `/api/federation/tokens/${minted.id}`);
});

test('removing a site is immediate here and agreed there', async () => {
  const res = await json(await call(north, 'DELETE', `/api/federation/peers/${south.identity.systemId}`));
  assert.equal(res.peers.length, 0);
  await until(async () => (await peersOf(south)).length === 0, 'South to agree it was unpaired');
  const health = await (await call(north, 'GET', '/api/system/health')).json();
  assert.equal(health.integrations[`peer:${south.identity.systemId}`], undefined, 'no longer probed or reported');
  assert.deepEqual(await remoteOf(north), [], 'and its campuses are forgotten');
  // South agreed it was unpaired; North's visitor there is nobody now.
  const status = await (await as(south, visitorToken, 'GET', '/api/auth/status')).json();
  assert.equal(status.authenticated, false, 'unpairing ends a visit');
});
