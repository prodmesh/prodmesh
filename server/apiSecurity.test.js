// Security-boundary tests: the admin-PIN bootstrap exception, login lockout,
// and the permission gates on show control + checklist mode actions. These run
// against a fresh store (no admin PIN) — api.test.js covers the configured
// steady state, this file covers the edges around getting there.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PRODMESH_DATA_DIR = mkdtempSync(join(tmpdir(), 'prodmesh-sec-'));
const { app } = await import('./index.js');
const settings = await import('./settings.js');
const auth = await import('./authStore.js');
const chkTemplates = await import('./checklistTemplates.js');

// north-youth is mock:true (no Companion network calls) with PC service type 500005.
const ROOM = 'north-youth';

const operatorGroup = auth.createGroup({ name: 'Mode Operators', permissions: ['rooms.mode.change'] });
const checkerGroup = auth.createGroup({ name: 'Checkers', permissions: ['checklists.complete'] });
const runnerGroup = auth.createGroup({ name: 'Runners', permissions: ['checklists.complete', 'rooms.mode.change'] });
auth.createUser({ username: 'operator', displayName: 'Operator', pin: '2468', groupIds: [operatorGroup.id] });
auth.createUser({ username: 'checker', displayName: 'Checker', pin: '3579', groupIds: [checkerGroup.id] });
auth.createUser({ username: 'runner', displayName: 'Runner', pin: '4680', groupIds: [runnerGroup.id] });
const station = auth.registerStation({ name: 'Security Test Station' });

let base;
let server;
let operatorToken;
let checkerToken;
let runnerToken;
before(async () => {
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  const login = async (username, pin) => {
    const res = await post('/api/auth/login', { username, pin }, null, station.token);
    return (await res.json()).token;
  };
  operatorToken = await login('operator', '2468');
  checkerToken = await login('checker', '3579');
  runnerToken = await login('runner', '4680');
});
after(() => server.close());

function post(path, body, token, stationToken = null) {
  return fetch(base + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(stationToken ? { 'X-Prodmesh-Station': stationToken } : {}),
    },
    body: JSON.stringify(body),
  });
}

test('admin-PIN bootstrap: open exactly once, admin field only', async () => {
  assert.equal(settings.isAdminSetupNeeded(), true);

  // An override-only body does NOT ride the bootstrap exception.
  assert.equal((await post('/api/settings/pins', { override: '9999' })).status, 401);

  // First-run setup: the first anonymous admin-PIN set is allowed…
  assert.equal((await post('/api/settings/pins', { admin: 'admin1234' })).status, 200);
  assert.equal(settings.isAdminSetupNeeded(), false);

  // …and never again: anonymous → 401, an authed non-admin → 403.
  assert.equal((await post('/api/settings/pins', { admin: 'admin5678' })).status, 401);
  const denied = await post('/api/settings/pins', { admin: 'admin5678' }, operatorToken, station.token);
  assert.equal(denied.status, 403);

  // The refused attempts changed nothing.
  assert.equal((await post('/api/auth/admin', { pin: 'admin5678' })).status, 401);
  assert.equal((await post('/api/auth/admin', { pin: 'admin1234' })).status, 200);
});

test('bootstrap sets ONLY the admin PIN, never the override alongside it', async () => {
  // The exception exists to let first-run setup name an admin. It used to pass
  // `override` through in the same call, so an anonymous caller who won the
  // race took the room-mode override PIN too.
  const s = await import('./settings.js');
  assert.equal(s.getPublicSettings().pins.overrideSet, false, 'no override yet');
  assert.equal(s.isAdminSetupNeeded(), false, 'admin already bootstrapped above');
});

test('weak PINs are refused: the admin PIN gates a permission bypass', async () => {
  const s = await import('./settings.js');
  assert.throws(() => s.setPins({ admin: '1234' }), /at least 6/);
  assert.throws(() => s.setPins({ override: '12' }), /at least 4/);
  // Clearing stays possible, and valid PINs still set.
  s.setPins({ admin: 'admin1234', override: '9999' });
});

test('admin PIN guessing is throttled and audited', async () => {
  // Unthrottled this endpoint was remote code execution: its token sets
  // legacyAdmin, which bypasses every permission check including
  // POST /api/system/update. ~40 guesses/second exhausts a 4-digit PIN.
  const statuses = [];
  for (let i = 0; i < 8; i++) {
    statuses.push((await post('/api/auth/admin', { pin: `wrong${i}` })).status);
  }
  assert.ok(statuses.includes(429), `expected a lockout, got ${statuses.join(',')}`);

  // Locked out, the CORRECT PIN is refused too — no bypass by knowing it.
  const locked = await post('/api/auth/admin', { pin: 'admin1234' });
  assert.equal(locked.status, 429);
  assert.equal((await locked.json()).error, 'temporarily_locked');

  // Every failure is on the record; before this there was no trace at all.
  const denied = auth.listAudit({ limit: 200 })
    .filter((e) => e.action === 'auth.admin' && e.result === 'denied');
  assert.ok(denied.length >= 5, `expected audited denials, got ${denied.length}`);
});

test('show start/end/current require shows.operate; reads stay public', async () => {
  for (const action of ['start', 'end', 'current']) {
    const anon = await post(`/api/rooms/${ROOM}/show/${action}`, {}, null, station.token);
    assert.equal(anon.status, 401, `anonymous ${action}`);
    assert.equal((await anon.json()).error, 'permission_required');

    const denied = await post(`/api/rooms/${ROOM}/show/${action}`, {}, operatorToken, station.token);
    assert.equal(denied.status, 403, `unpermitted ${action}`);
    const body = await denied.json();
    assert.equal(body.permission, 'shows.operate');
    // The label is what the browser puts on screen ("… does not have
    // 'Operate shows'"), so a refusal that omits it degrades to the raw id.
    assert.equal(body.label, 'Operate shows');
  }
  // Booth screens are anonymous viewers — the read side must stay open.
  assert.equal((await fetch(`${base}/api/rooms/${ROOM}/show`)).status, 200);
});

test('checklist mode actions enforce mode permission and lockouts', async () => {
  chkTemplates.setTemplate('500005', [
    { id: 'go-sunday', label: 'Set room to Sunday mode', action: { type: 'mode', mode: 'sunday' } },
    { id: 'plain', label: 'A plain item' },
  ]);
  const service = await (await fetch(`${base}/api/rooms/${ROOM}/service`)).json();
  const plan = service.plans[0];
  assert.ok(plan, 'mock Planning Center should supply a plan');
  const url = (item) => `/api/rooms/${ROOM}/event/${plan.id}/checklist/${item}`;

  // Anonymous ticking is refused outright.
  assert.equal((await post(url('plain'), { done: true }, null, station.token)).status, 401);

  // checklists.complete alone ticks plain items but cannot fire a mode action.
  assert.equal((await post(url('plain'), { done: true }, checkerToken, station.token)).status, 200);
  const noMode = await post(url('go-sunday'), { done: true }, checkerToken, station.token);
  assert.equal(noMode.status, 403);
  assert.equal((await noMode.json()).permission, 'rooms.mode.change');

  // A locked mode can't be sidestepped through the checklist…
  settings.setPins({ admin: 'admin1234', override: '9999' });
  settings.setSchedules({
    [ROOM]: [{ id: 'w', label: 'Always', days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59', lock: ['sunday'] }],
  });
  const locked = await post(url('go-sunday'), { done: true }, runnerToken, station.token);
  assert.equal(locked.status, 403);
  assert.equal((await locked.json()).error, 'override_required');

  // …until the override PIN is supplied; then the mode fires and the item ticks.
  const done = await post(url('go-sunday'), { done: true, overridePin: '9999' }, runnerToken, station.token);
  assert.equal(done.status, 200);
  const { checklist } = await done.json();
  assert.equal(checklist.find((i) => i.id === 'go-sunday').done, true);

  settings.setSchedules({});
});

test('login lockout: 5 failures lock the ip+username pair', async () => {
  // No station header → explicit station_required, not a silent 401.
  assert.equal((await post('/api/auth/login', { username: 'lockme', pin: '1111' })).status, 400);

  auth.createUser({ username: 'lockme', displayName: 'Lockout Target', pin: '7777', groupIds: [] });
  for (let i = 0; i < 5; i++) {
    const res = await post('/api/auth/login', { username: 'lockme', pin: '0000' }, null, station.token);
    assert.equal(res.status, 401, `failure ${i + 1} still reports bad credentials`);
  }

  // Once locked, even the CORRECT pin is refused until the window passes.
  const locked = await post('/api/auth/login', { username: 'lockme', pin: '7777' }, null, station.token);
  assert.equal(locked.status, 429);
  const body = await locked.json();
  assert.equal(body.error, 'temporarily_locked');
  assert.ok(body.retryAfter > 0 && body.retryAfter <= 60_000);

  // Keyed per username — one locked account must not lock a shared booth out
  // of every account.
  const other = await post('/api/auth/login', { username: 'operator', pin: '2468' }, null, station.token);
  assert.equal(other.status, 200);

  // The bypass this replaced: the counter used to be keyed on station id, and
  // station registration is unauthenticated and uncapped — so a fresh station
  // per attempt reset it every time (reproduced: 20 tries, zero lockouts).
  for (let i = 0; i < 6; i++) {
    const fresh = auth.registerStation({ name: `Rotating Station ${i}` });
    const res = await post('/api/auth/login', { username: 'lockme', pin: '0000' }, null, fresh.token);
    assert.equal(res.status, 429, `rotating stations must not reset the lockout (attempt ${i + 1})`);
  }
});

// ── Planning Center path injection ───────────────────────────────────────────
//  A planId is persisted and later replayed into PC request paths by
//  backfillLabels. Before this guard, "1/../../../people/v2/people" escaped
//  the /services/v2 prefix (fetch normalizes `..`) and reached the People API
//  with the church's PAT — congregant names, emails and addresses, readable by
//  anyone holding only shows.operate. Reproduce the exact payload, not a
//  sanitized stand-in: this is the kind of bug that returns during a refactor.

test('show start rejects plan ids that could reshape a Planning Center path', async () => {
  const runner = auth.createGroup({ name: 'PC Injection Ops', permissions: ['shows.operate'] });
  auth.createUser({ username: 'pcinj', displayName: 'PC Inj', pin: '9182', groupIds: [runner.id] });
  const res0 = await post('/api/auth/login', { username: 'pcinj', pin: '9182' }, null, station.token);
  const token = (await res0.json()).token;

  const payloads = [
    '1/../../../people/v2/people?per_page=100', // the reproduced escape
    '../../people/v2/people',
    '1%2F..%2F..%2Fpeople',                     // pre-encoded traversal
    '1?filter=x',                               // query injection
    '1#frag',                                   // fragment truncation
    '1/notes',                                  // extra path segment
  ];
  for (const planId of payloads) {
    const res = await post(`/api/rooms/${ROOM}/show/start`, { planId, timeId: 't1' }, token, station.token);
    assert.equal(res.status, 400, `planId ${JSON.stringify(planId)} must be refused`);
    assert.equal((await res.json()).error, 'Invalid plan id');
  }

  // Demo-mode ids (no PC credentials) must still be accepted — the charset
  // guard blocks URL metacharacters, it does not require digits.
  const ok = await post(`/api/rooms/${ROOM}/show/start`, { planId: 'mock-st1-0', timeId: 't1' }, token, station.token);
  assert.equal(ok.status, 200, 'demo-mode plan ids must keep working');
  await post(`/api/rooms/${ROOM}/show/end`, {}, token, station.token);
});

test('the Planning Center id guard refuses anything that is not a bare number', async () => {
  // Second line of defence, unit-tested directly: with no PC credentials the
  // client short-circuits to mock data before building a URL, so the guard is
  // unreachable through the public functions in this environment. It still has
  // to hold for installs that ARE configured, where a planId poisoned before
  // the route guard existed gets replayed by backfillLabels.
  const { pcId } = await import('./integrations/planningCenter.js');

  assert.equal(pcId('12345', 'plan id'), '12345');
  for (const bad of [
    '1/../../../people/v2/people?per_page=100',
    '../../people/v2/people',
    '1%2F..%2Fpeople',
    '1?filter=x',
    '1#frag',
    '1/notes',
    'mock-st1-0', // demo ids are fine to STORE but must never reach a real URL
    '',
    null,
    undefined,
  ]) {
    assert.throws(() => pcId(bad, 'plan id'), /Invalid Planning Center plan id/,
      `${JSON.stringify(bad)} must be refused`);
  }
});

// ── Privilege escalation ─────────────────────────────────────────────────────

test('settings.manage cannot overwrite the admin PIN (it would mint a superuser)', async () => {
  const g = auth.createGroup({ name: 'Ops Settings', permissions: ['settings.manage'] });
  auth.createUser({ username: 'opsset', displayName: 'Ops', pin: '5150', groupIds: [g.id] });
  const token = (await (await post('/api/auth/login', { username: 'opsset', pin: '5150' }, null, station.token)).json()).token;

  // Reproduced escalation: set the admin PIN, log in with it, get '*'.
  const denied = await post('/api/settings/pins', { admin: 'newadmin1' }, token, station.token);
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).permission, '*');

  // The operational half of the same screen still works for them.
  const allowed = await post('/api/settings/pins', { override: '4321' }, token, station.token);
  assert.equal(allowed.status, 200);
});

test('Planning Center person search is gated on users.manage', async () => {
  // It exists to fill in a field on the create-user form, so it rides that
  // form's permission and no wider — the names of everyone who serves are not
  // something a booth operator needs to be able to enumerate.
  const search = (token) => fetch(`${base}/api/planning-center/people?q=avery`, {
    headers: token ? { Authorization: `Bearer ${token}`, 'X-Prodmesh-Station': station.token } : {},
  });

  assert.equal((await search(null)).status, 401);
  assert.equal((await search(operatorToken)).status, 403);

  const group = auth.createGroup({ name: 'People Importers', permissions: ['users.manage'] });
  auth.createUser({ username: 'importer', displayName: 'Importer', pin: '8282', groupIds: [group.id] });
  const token = (await (await post('/api/auth/login', { username: 'importer', pin: '8282' }, null, station.token)).json()).token;
  assert.equal((await search(token)).status, 200);
});

test('users.manage cannot promote itself or grant permissions it lacks', async () => {
  const dir = auth.listDirectory();
  const adminGroup = dir.groups.find((x) => x.systemKey === 'admin');
  const g = auth.createGroup({ name: 'User Admins', permissions: ['users.manage'] });
  const me = auth.createUser({ username: 'useradm', displayName: 'User Admin', pin: '6161', groupIds: [g.id] });
  const victim = auth.createUser({ username: 'victim', displayName: 'Victim', pin: '7171', groupIds: [] });
  const token = (await (await post('/api/auth/login', { username: 'useradm', pin: '6161' }, null, station.token)).json()).token;

  const put = (userId, groupIds) => fetch(`${base}/api/users/${userId}/groups`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Prodmesh-Station': station.token },
    body: JSON.stringify({ groupIds }),
  });

  // Self-promotion to Administrators — the one-request path to '*'.
  const selfRes = await put(me.id, [adminGroup.id]);
  assert.equal(selfRes.status, 403);
  assert.equal((await selfRes.json()).error, 'cannot_change_own_groups');

  // Promoting someone ELSE beyond your own authority is refused too.
  const overRes = await put(victim.id, [adminGroup.id]);
  assert.equal(overRes.status, 403);
  assert.equal((await overRes.json()).error, 'cannot_grant_unheld_permissions');

  // Granting what you DO hold is still allowed — this screen must stay usable.
  assert.equal((await put(victim.id, [g.id])).status, 200);
});

test('station registration is rate limited (it gated the lockout bypass)', async () => {
  const codes = [];
  for (let i = 0; i < 14; i++) {
    const res = await post('/api/stations/register', { name: `Flood Station ${i}` });
    codes.push(res.status);
  }
  assert.ok(codes.includes(429), `expected a cap, got ${codes.join(',')}`);
});

test('the SSE stream refuses unknown rooms instead of leaking a map entry', async () => {
  const res = await fetch(`${base}/api/rooms/${'Z'.repeat(200)}/show/stream`);
  assert.equal(res.status, 404);
  await res.body?.cancel?.();
});

// ── Device address validation (user-directed SSRF) ───────────────────────────

test('device hosts must be bare hostnames or IPs, not URLs', async () => {
  const conn = await import('./connectivity.js');
  // A trailing # turned the appended fixed path into a fragment, handing the
  // operator the entire URL — config.manage became an authenticated
  // read-anything primitive, with the body echoed back via the status chip.
  const hostile = [
    '127.0.0.1:9/latest/meta-data/#',
    'user:pw@internal-admin.local/#',
    '10.0.0.5:8006/api2/json/access/ticket?x=',
    'evil.example/path',
    'host with spaces',
    '',
  ];
  for (const host of hostile) {
    assert.throws(() => conn.validateProPresenter({ host }), /host|hostname/i, `PP host ${JSON.stringify(host)}`);
    assert.throws(() => conn.validateAnalysis({ source: 'smaart', host }), /host|hostname/i, `analysis host ${JSON.stringify(host)}`);
  }
  // Real addresses still work, including hostnames and IPv6 literals.
  for (const host of ['192.0.2.15', 'pcr-propresenter.local', 'FOH-Soundgrid', '[fe80::1]']) {
    assert.equal(conn.validateProPresenter({ host }).host, host);
  }
});

test('requests with a foreign Host header are refused (DNS rebinding)', async () => {
  // Auth is a header token, so ordinary cross-origin pages cannot forge a
  // request — but rebinding makes an attacker page same-origin, at which point
  // every unauthenticated endpoint is driveable from a link opened on the
  // booth machine. The Host header is what gives it away.
  // fetch() silently drops Host (a forbidden header), so drive it raw.
  const http = await import('node:http');
  const withHost = (host) => new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: server.address().port, path: '/api/rooms', headers: { Host: host } },
      (res) => { res.resume(); resolve(res.statusCode); },
    );
    req.end();
  });

  assert.equal(await withHost('evil.example'), 403);
  // The addresses real clients actually use keep working.
  assert.equal(await withHost(`127.0.0.1:${server.address().port}`), 200);
  assert.equal(await withHost('prodmesh.local'), 200);
  assert.equal(await withHost('localhost'), 200);
});

// ── reports.view: operational context open, retrospective analysis gated ─────
//  The maintainer's rule: leader names on the Run of Show are a MUST for volunteers —
//  camera ops, switchers and FOH read them to know who is next, with nobody
//  logged in. After-action reports are a different thing and are gated.

test('plan notes and leaders stay anonymous; after-action reports do not', async () => {
  // Operational: the room, its plans, and the order of service with leaders.
  for (const path of [`/api/rooms/${ROOM}/service`, `/api/rooms/${ROOM}/show`, '/api/rooms', '/api/config']) {
    assert.equal((await fetch(base + path)).status, 200, `${path} must stay anonymous`);
  }

  // Retrospective: the cross-room history list is refused outright.
  const history = await fetch(`${base}/api/history`);
  assert.equal(history.status, 401);
  assert.equal((await history.json()).permission, 'reports.view');

  // The per-service report still answers — the Run of Show page needs to know
  // whether a service finished — but hands back no analysis.
  const report = await (await fetch(`${base}/api/rooms/${ROOM}/plan/whatever/report`)).json();
  assert.equal(report.restricted, true);
  assert.deepEqual(report.items, []);
  assert.equal(report.spl, null);
  assert.ok('completedAt' in report, 'completion stamp survives for the live page');

  // With the permission, the detail comes back and the flag is gone.
  const g = auth.createGroup({ name: 'Report Readers', permissions: ['reports.view'] });
  auth.createUser({ username: 'reader', displayName: 'Reader', pin: '3141', groupIds: [g.id] });
  const token = (await (await post('/api/auth/login', { username: 'reader', pin: '3141' }, null, station.token)).json()).token;
  const full = await (await fetch(`${base}/api/rooms/${ROOM}/plan/whatever/report`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json();
  assert.equal(full.restricted, undefined);
  assert.equal((await fetch(`${base}/api/history`, { headers: { Authorization: `Bearer ${token}` } })).status, 200);
});

// ── Logo upload (the app's only file-upload path) ────────────────────────────

test('logo upload: gated, sniffed by bytes, size-capped, served with nosniff', async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
  const put = (body, token) => fetch(`${base}/api/branding/logo`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body,
  });

  // Anonymous cannot brand the church.
  assert.equal((await put(png)).status, 401);

  // A config.manage user rather than the legacy admin PIN: the throttle test
  // above deliberately locks admin logins from this IP, and depending on it
  // here would couple these tests by execution order.
  const g = auth.createGroup({ name: 'Branders', permissions: ['config.manage'] });
  auth.createUser({ username: 'brander', displayName: 'Brander', pin: '2718', groupIds: [g.id] });
  const admin = (await (await post('/api/auth/login', { username: 'brander', pin: '2718' }, null, station.token)).json()).token;

  // An SVG is refused however it is labelled — the decision is on bytes, and
  // a same-origin SVG would execute in the origin holding the admin token.
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  assert.equal((await put(svg, admin)).status, 400);
  // …as is HTML wearing an image Content-Type.
  assert.equal((await put(Buffer.from('<!doctype html><script>x</script>'), admin)).status, 400);

  // Oversized uploads are cut off mid-stream, not buffered then rejected.
  assert.equal((await put(Buffer.alloc(300 * 1024, 1), admin)).status, 413);

  // A real PNG lands, and comes back with the SNIFFED type plus nosniff.
  assert.equal((await put(png, admin)).status, 200);
  const served = await fetch(`${base}/api/branding/logo`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(Buffer.from(await served.arrayBuffer()).equals(png));

  // Clearing reverts to "no override", which the client reads as 404.
  assert.equal((await fetch(`${base}/api/branding/logo`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${admin}` },
  })).status, 200);
  assert.equal((await fetch(`${base}/api/branding/logo`)).status, 404);
});

test('secrets are write-only over HTTP and need full admin', async () => {
  const conf = auth.createGroup({ name: 'Config Only', permissions: ['config.manage', 'settings.manage'] });
  auth.createUser({ username: 'configonly', displayName: 'Config Only', pin: '1123', groupIds: [conf.id] });
  const weak = (await (await post('/api/auth/login', { username: 'configonly', pin: '1123' }, null, station.token)).json()).token;

  const get = (token) => fetch(`${base}/api/secrets`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

  // Credentials to other systems are not an "operational setting".
  assert.equal((await get()).status, 401);
  assert.equal((await get(weak)).status, 403);

  // '*' isn't grantable — it comes from the Administrators system group.
  const adminGroup = auth.listDirectory().groups.find((x) => x.systemKey === 'admin');
  auth.createUser({ username: 'realadmin', displayName: 'Real Admin', pin: '3344', groupIds: [adminGroup.id] });
  const admin = (await (await post('/api/auth/login', { username: 'realadmin', pin: '3344' }, null, station.token)).json()).token;

  const put = (updates) => fetch(`${base}/api/secrets`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin}` },
    body: JSON.stringify({ updates }),
  });

  const SECRET = 'pco-secret-value-abc123';
  assert.equal((await put({ 'planningCenter.secret': SECRET })).status, 200);

  // The whole contract: it is stored and usable, but the API never says it.
  const body = await (await get(admin)).text();
  assert.ok(!body.includes(SECRET), 'the secret came back over the API');
  const entry = JSON.parse(body).secrets
    .flatMap((g) => g.fields)
    .find((s) => s.path === 'planningCenter.secret');
  assert.equal(entry.set, true);
  assert.equal(entry.length, SECRET.length);

  // Unknown keys are refused rather than quietly written to the file.
  assert.equal((await put({ 'evil.path': 'x' })).status, 400);

  // The audit records WHICH keys changed and never a value.
  const audit = JSON.stringify(auth.listAudit({ limit: 50 }));
  assert.ok(audit.includes('planningCenter.secret'), 'the change should be audited');
  assert.ok(!audit.includes(SECRET), 'a value leaked into the audit trail');
});

test('resetting somebody else’s PIN needs full admin, not users.manage', async () => {
  // Setting an account's PIN is taking that account over, so users.manage
  // holders are refused: otherwise the screen that exists to manage volunteers
  // is a one-request path to every authority in the building.
  const g = auth.createGroup({ name: 'PIN Admins', permissions: ['users.manage'] });
  auth.createUser({ username: 'pinadm', displayName: 'PIN Admin', pin: '8181', groupIds: [g.id] });
  const target = auth.createUser({ username: 'pintarget', displayName: 'Target', pin: '9191', groupIds: [] });
  const token = (await (await post('/api/auth/login', { username: 'pinadm', pin: '8181' }, null, station.token)).json()).token;

  const put = (tok, body) => fetch(`${base}/api/users/${target.id}/pin`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}`, 'X-Prodmesh-Station': station.token },
    body: JSON.stringify(body),
  });

  const res = await put(token, { pin: '0000' });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'admin_required');
  // …and the old PIN still works, i.e. the refusal was before any write.
  assert.ok(auth.pinMatches(target.id, '9191'));
});

test('changing your own PIN needs the current one, and ends every session', async () => {
  const user = auth.createUser({ username: 'selfserve', displayName: 'Self Serve', pin: '1212', groupIds: [] });
  const login = async (pin) =>
    (await (await post('/api/auth/login', { username: 'selfserve', pin }, null, station.token)).json()).token;
  const token = await login('1212');
  const change = (tok, body) => fetch(`${base}/api/auth/pin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}`, 'X-Prodmesh-Station': station.token },
    body: JSON.stringify(body),
  });

  // A session alone is not proof: a booth machine left signed in is the normal
  // state of a booth machine.
  const wrong = await change(token, { currentPin: '9999', newPin: '3434' });
  assert.equal(wrong.status, 403);
  assert.equal((await wrong.json()).error, 'current_pin_incorrect');

  assert.equal((await change(token, { currentPin: '1212', newPin: '3434' })).status, 200);
  assert.ok(auth.pinMatches(user.id, '3434'));
  // The session that made the change is gone with the credential it used.
  const after = await fetch(`${base}/api/users`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(after.status, 401);
  assert.ok(await login('3434'), 'the new PIN signs in');
});

test('deactivating revokes access immediately, and cannot reach @admin or yourself', async () => {
  const g = auth.createGroup({ name: 'Volunteer Admins', permissions: ['users.manage'] });
  const me = auth.createUser({ username: 'voladm', displayName: 'Volunteer Admin', pin: '2323', groupIds: [g.id] });
  const leaver = auth.createUser({ username: 'leaver', displayName: 'Leaver', pin: '4545', groupIds: [] });
  const token = (await (await post('/api/auth/login', { username: 'voladm', pin: '2323' }, null, station.token)).json()).token;
  const leaverToken = (await (await post('/api/auth/login', { username: 'leaver', pin: '4545' }, null, station.token)).json()).token;

  const setActive = (userId, active) => fetch(`${base}/api/users/${userId}/active`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Prodmesh-Station': station.token },
    body: JSON.stringify({ active }),
  });

  assert.equal((await setActive(me.id, false)).status, 403, 'the one nobody means to do');
  assert.equal((await setActive(leaver.id, false)).status, 200);
  // Revocation is immediate rather than immediate-on-next-login.
  assert.equal((await fetch(`${base}/api/auth/status`, { headers: { Authorization: `Bearer ${leaverToken}` } })
    .then((r) => r.json())).authenticated ?? false, false);
  assert.equal((await post('/api/auth/login', { username: 'leaver', pin: '4545' }, null, station.token)).status, 401);

  // Restoring works, so this is revocation and not a one-way door.
  assert.equal((await setActive(leaver.id, true)).status, 200);
  assert.ok((await post('/api/auth/login', { username: 'leaver', pin: '4545' }, null, station.token)).ok);
});

test('a group cannot be given permissions its editor does not hold', async () => {
  const g = auth.createGroup({ name: 'Group Editors', permissions: ['users.manage'] });
  auth.createUser({ username: 'grpadm', displayName: 'Group Admin', pin: '5656', groupIds: [g.id] });
  const target = auth.createGroup({ name: 'Editable', permissions: [] });
  const token = (await (await post('/api/auth/login', { username: 'grpadm', pin: '5656' }, null, station.token)).json()).token;

  const put = (groupId, body) => fetch(`${base}/api/groups/${groupId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Prodmesh-Station': station.token },
    body: JSON.stringify(body),
  });

  // Editing a group you are in is the other one-request path to '*'.
  const over = await put(target.id, { permissions: ['system.backup'] });
  assert.equal(over.status, 403);
  assert.equal((await over.json()).error, 'cannot_grant_unheld_permissions');

  assert.equal((await put(target.id, { permissions: ['users.manage'] })).status, 200);

  // Administrators is computed, not stored — editing it would report a change
  // that did not happen.
  const adminGroup = auth.listDirectory().groups.find((x) => x.systemKey === 'admin');
  assert.equal((await put(adminGroup.id, { name: 'Nope' })).status, 400);
});
