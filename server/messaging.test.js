import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { listenOnLoopback } from './testServer.js';
process.env.PRODMESH_DATA_DIR = mkdtempSync(join(tmpdir(), 'prodmesh-messaging-'));
process.env.PRODMESH_LOCAL_TEST = '1';
const auth = await import('./authStore.js');
const store = await import('./messagingStore.js');
const { syncSunday } = await import('./messagingSchedule.js');
const { getDb, migrate, SCHEMA_VERSION } = await import('./db.js');
const { replaceChurch, getChurch } = await import('./appConfig.js');
const { app } = await import('./index.js');
const hub = await import('./streamHub.js');
const { issueStreamTicket, consumeStreamTicket, privateTopicAllowed } = await import('./messagingStream.js');
const member = auth.createUser({ username: 'member', displayName: 'Team Member', pin: '1234', planningCenterPersonId: '100' });
const other = auth.createUser({ username: 'other', displayName: 'Other Member', pin: '1234' });
const outsider = auth.createUser({ username: 'outsider', displayName: 'Outsider', pin: '1234' });
const admin = auth.createUser({ username: 'teamadmin', displayName: 'Team Admin', pin: '1234', groupIds: ['group-admin'] });
const tokens = Object.fromEntries([member, other, outsider, admin].map(u => [u.id, auth.authenticate(u.username, '1234').token]));
let server, base, active;
before(async () => {
  replaceChurch({ name: 'Test Church', sites: [
    { id: 'alpha', name: 'Alpha', status: 'active', timezone: 'America/New_York', auditoriums: [] },
    { id: 'beta', name: 'Beta', status: 'active', timezone: 'Pacific/Auckland', auditoriums: [] },
  ] });
  active = store.resolveSunday('alpha');
  store.setMember(active.id, member.id);
  store.setMember(active.id, other.id);
  ({ server, base } = await listenOnLoopback(app));
});
after(() => { server.closeAllConnections(); server.close(); });
const session = u => auth.resolveSession(tokens[u.id]);
async function api(path, user = member, method = 'GET', body) {
  return fetch(`${base}/api/messages${path}`, { method, headers: { ...(user ? { Authorization: `Bearer ${tokens[user.id]}` } : {}), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

test('site timezone determines Sunday across midnight, DST, and Monday rollover', () => {
  assert.equal(store.sundayDate('2026-10-12T02:00:00Z', 'America/New_York'), '2026-10-11');
  assert.equal(store.sundayDate('2026-10-12T02:00:00Z', 'Pacific/Auckland'), '2026-10-18');
  assert.equal(store.sundayDate('2026-03-08T07:30:00Z', 'America/New_York'), '2026-03-08');
  assert.equal(store.sundayDate('2026-11-01T06:30:00Z', 'America/New_York'), '2026-11-01');
  const previous = store.resolveSunday('alpha', Date.parse('2026-09-27T12:00:00Z'));
  const next = store.resolveSunday('alpha', Date.parse('2026-09-28T04:01:00Z'));
  assert.notEqual(previous.id, next.id);
  assert.equal(store.thread(previous.id).status, 'archived');
  assert.equal(next.service_date, '2026-10-04');
});
test('concurrent resolution and database constraint enforce exactly one site/date thread', async () => {
  const results = await Promise.all(Array.from({ length: 20 }, async () => store.resolveSunday('alpha')));
  assert.equal(new Set(results.map(t => t.id)).size, 1);
  assert.throws(() => getDb().prepare('INSERT INTO message_threads(id,site_id,service_date,created_at) VALUES(?,?,?,?)').run('duplicate', 'alpha', active.service_date, Date.now()), /UNIQUE/);
  const second = new Database(join(process.env.PRODMESH_DATA_DIR, 'prodmesh.db'));
  assert.throws(() => second.prepare('INSERT INTO message_threads(id,site_id,service_date,created_at) VALUES(?,?,?,?)').run('duplicate2', 'alpha', active.service_date, Date.now()), /UNIQUE/);
  second.close();
});
test('scheduled linked users added, unmatched reported, manual removals survive refresh', async () => {
  const t = store.resolveSunday('beta');
  const client = { isConfigured: () => true, getPlansForSunday: async () => [{ id: '1' }, { id: '2' }],
    getPlanTimes: async () => [{ type: 'service', startsAt: `${t.service_date}T00:00:00Z` }],
    getPlanTeamMembers: async () => [{ personId: '100', name: 'Team Member' }, { personId: '999', name: 'Unmatched Person' }] };
  const roomMap = { one: { site: 'beta', planningCenter: { serviceTypes: [{ id: '20' }] } } };
  await syncSunday('beta', { force: true, client, roomMap });
  assert.ok(store.members(t.id).some(m => m.id === member.id && m.source === 'schedule'));
  assert.deepEqual(JSON.parse(store.thread(t.id).unmatched), [{ personId: '999', name: 'Unmatched Person' }]);
  store.setMember(t.id, member.id, true);
  await syncSunday('beta', { force: true, client, roomMap });
  assert.equal(store.members(t.id).length, 0);
  store.setMember(t.id, other.id);
  await syncSunday('beta', { force: true, client: { ...client, getPlansForSunday: async () => { throw new Error('outage'); } }, roomMap });
  assert.equal(store.thread(t.id).sync_status, 'unavailable');
  assert.equal(store.members(t.id)[0].id, other.id);
  await syncSunday('beta', { force: true, client: { ...client, getPlanTeamMembers: async () => [] }, roomMap });
  assert.equal(store.members(t.id)[0].id, other.id);
});
test('partial schedule failures commit no incomplete membership', async () => {
  const t = store.resolveSunday('beta');
  const client = { isConfigured: () => true, getPlansForSunday: async () => [{ id: '1' }, { id: '2' }],
    getPlanTimes: async () => [{ type: 'service', startsAt: `${t.service_date}T00:00:00Z` }],
    getPlanTeamMembers: async (_type, id) => { if (id === '2') throw new Error('outage'); return [{ personId: '100', name: 'Member' }]; } };
  await syncSunday('beta', { force: true, client, roomMap: { r: { site: 'beta', planningCenter: { serviceTypes: [{ id: '20' }] } } } });
  assert.equal(store.thread(t.id).sync_status, 'unavailable');
  assert.equal(store.members(t.id).length, 1);
});
test('HTTP authorization: anonymous, outsiders, wrong site and IDOR refused', async () => {
  assert.equal((await api(`/${active.id}`, null)).status, 401);
  assert.equal((await api(`/${active.id}`, outsider)).status, 404);
  assert.equal((await api(`/${active.id}/messages`, outsider, 'POST', { body: 'bad' })).status, 404);
  assert.equal((await api(`/${store.resolveSunday('beta').id}`, member)).status, 404);
  assert.equal((await api('/not-a-thread', member)).status, 404);
  assert.equal((await api(`/${active.id}`, admin)).status, 200);
  assert.equal((await api(`/${active.id}/messages`, admin, 'POST', { body: 'not a member' })).status, 403);
  const inbox = await (await api('', outsider)).json();
  assert.deepEqual(inbox.threads, []);
});
test('manual membership uses existing ACL and audit trail', async () => {
  assert.equal((await api(`/${active.id}/members/${outsider.id}`, member, 'PUT', { remove: false })).status, 403);
  assert.equal((await api(`/${active.id}/members/${outsider.id}`, admin, 'PUT', { remove: false })).status, 200);
  assert.equal((await api(`/${active.id}`, outsider)).status, 200);
  assert.equal((await api(`/${active.id}/members/${outsider.id}`, admin, 'PUT', { remove: true })).status, 200);
  assert.equal((await api(`/${active.id}`, outsider)).status, 404);
  assert.ok(auth.listAudit().some(a => a.action === 'messages.manage' && a.details?.operation === 'remove-member'));
});
test('member sends persist with session sender, size validation, ordering and bounded pagination', async () => {
  const res = await api(`/${active.id}/messages`, member, 'POST', { body: '<script>window.hacked=true</script>', sender_user_id: outsider.id });
  assert.equal(res.status, 201);
  const { message } = await res.json();
  assert.equal(message.senderId, member.id);
  assert.equal(getDb().prepare('SELECT body FROM messages WHERE id=?').get(message.id).body, '<script>window.hacked=true</script>');
  assert.equal((await api(`/${active.id}/messages`, member, 'POST', { body: 'a'.repeat(4001) })).status, 400);
  assert.equal((await api(`/${active.id}/messages`, member, 'POST', { body: '  ' })).status, 400);
  assert.equal((await api(`/${active.id}?before=nope`)).status, 400);
  const db = getDb();
  for (let i = 0; i < 60; i++) db.prepare('INSERT INTO messages(thread_id,sender_user_id,body,created_at) VALUES(?,?,?,?)').run(active.id, other.id, `message ${i}`, Date.now() - 120000);
  const page = await (await api(`/${active.id}`)).json();
  assert.equal(page.messages.length, 50); assert.equal(page.hasMore, true);
  assert.deepEqual(page.messages.map(m => m.id), page.messages.map(m => m.id).sort((a,b) => a-b));
  const older = await (await api(`/${active.id}?before=${page.messages[0].id}`)).json();
  assert.equal(older.messages.length, 11);
  assert.equal(new Set([...older.messages, ...page.messages].map(m => m.id)).size, 61);
});
test('unread increments and cursor advances monotonically without clearing unseen messages', async () => {
  assert.ok(store.unread(active.id, member.id) >= 60);
  const last = store.listMessages(active.id).at(-1).id;
  assert.equal((await api(`/${active.id}/read`, member, 'POST', { messageId: last })).status, 200);
  assert.equal(store.unread(active.id, member.id), 0);
  store.sendMessage(active.id, other.id, 'Unread');
  assert.equal(store.unread(active.id, member.id), 1);
  store.markRead(active.id, member.id, last - 1);
  assert.equal(store.unread(active.id, member.id), 1);
  const wrongThreadMessage = getDb().prepare('INSERT INTO messages(thread_id,sender_user_id,body,created_at) VALUES(?,?,?,?)').run(store.resolveSunday('beta').id, other.id, 'private', Date.now());
  assert.equal((await api(`/${active.id}/read`, member, 'POST', { messageId: Number(wrongThreadMessage.lastInsertRowid) })).status, 400);
});
test('rate limiting is per named user and persists in SQLite', () => {
  const t = store.resolveSunday('beta');
  const user = auth.createUser({ username: 'fast', displayName: 'Fast Sender', pin: '1234' });
  store.setMember(t.id, user.id);
  for (let i = 0; i < 30; i++) store.sendMessage(t.id, user.id, `m${i}`);
  assert.throws(() => store.sendMessage(t.id, user.id, 'too fast'), err => err.status === 429);
});
test('archive/lock enforce read-only and soft deletion retains auditability', async () => {
  const own = store.sendMessage(active.id, member.id, 'delete me');
  assert.equal((await api(`/${active.id}/messages/${own.id}`, other, 'DELETE')).status, 403);
  assert.equal((await api(`/${active.id}/messages/${own.id}`, admin, 'DELETE')).status, 200);
  assert.equal(store.listMessages(active.id).find(m => m.id === own.id).body, '');
  assert.equal(getDb().prepare('SELECT body FROM messages WHERE id=?').get(own.id).body, 'delete me');
  assert.ok(auth.listAudit().some(a => a.resourceId === String(own.id) && a.details?.operation === 'delete'));
  assert.equal((await api(`/${active.id}/status`, member, 'PUT', { status: 'locked' })).status, 403);
  assert.equal((await api(`/${active.id}/status`, admin, 'PUT', { status: 'locked' })).status, 200);
  assert.equal((await api(`/${active.id}/messages`, member, 'POST', { body: 'locked' })).status, 400);
  await api(`/${active.id}/status`, admin, 'PUT', { status: 'active' });
  const past = store.resolveSunday('alpha', Date.parse('2026-09-20T12:00:00Z'));
  store.setMember(past.id, member.id);
  assert.equal((await api(`/${past.id}/status`, admin, 'PUT', { status: 'active' })).status, 400);
  assert.equal((await api(`/${past.id}/messages`, member, 'POST', { body: 'archived' })).status, 400);
  const history = await (await api('', member)).json();
  assert.ok(history.threads.some(t => t.id === past.id && t.status === 'archived' && !t.isCurrent));
});
test('realtime uses existing hub: two clients receive revisions, reconnect gets snapshot', async () => {
  const frames1 = [], frames2 = [];
  const r1 = { write: f => { frames1.push(f); return true; } }, r2 = { write: f => { frames2.push(f); return true; } };
  hub.subscribe(r1, [`sunday:${member.id}`]); hub.subscribe(r2, [`sunday:${other.id}`]);
  store.sendMessage(active.id, member.id, 'Realtime');
  assert.equal(frames1.length, 2); assert.equal(frames2.length, 2);
  assert.match(frames2[1], /revision/);
  hub.unsubscribe(r1); hub.unsubscribe(r2);
  const reconnect = [];
  const r3 = { write: f => { reconnect.push(f); return true; } };
  hub.subscribe(r3, [`sunday:${member.id}`]); assert.equal(reconnect.length, 1); hub.unsubscribe(r3);
});
test('SSE tickets are one-use, private subscriptions are user-scoped and sessions revoke', async () => {
  const ticket = issueStreamTicket(tokens[member.id]);
  assert.equal(consumeStreamTicket(ticket), tokens[member.id]); assert.equal(consumeStreamTicket(ticket), null);
  assert.equal(privateTopicAllowed(`sunday:${other.id}`, session(member)), false);
  assert.equal(privateTopicAllowed(`sunday:${member.id}`, null), false);
  const { ticket: live } = await (await api('/stream-ticket', member, 'POST', {})).json();
  const controller = new AbortController();
  const response = await fetch(`${base}/api/stream?topics=sunday:${member.id}&ticket=${live}`, { signal: controller.signal });
  const reader = response.body.getReader();
  const first = await reader.read(); assert.match(new TextDecoder().decode(first.value), /revision/);
  const waiting = reader.read();
  store.sendMessage(active.id, other.id, 'Connected HTTP client');
  assert.match(new TextDecoder().decode((await waiting).value), /revision/);
  controller.abort(); await reader.cancel().catch(() => {});
  const freshUser = auth.createUser({ username: 'revoked', displayName: 'Revoked', pin: '1234' });
  const fresh = auth.authenticate(freshUser.username, '1234');
  const revokeTicket = issueStreamTicket(fresh.token); auth.destroySession(fresh.token);
  const token = consumeStreamTicket(revokeTicket);
  assert.equal(privateTopicAllowed(`sunday:${freshUser.id}`, auth.resolveSession(token)), false);
});
test('schema upgrades existing installs without replacing user/session records or resetting timezones', () => {
  const d = new Database(':memory:'); migrate(d);
  d.prepare("INSERT INTO users(id,username,display_name,pin_hash,created_at) VALUES('old','old','Old','hash',0)").run();
  d.prepare("INSERT INTO user_sessions(token_hash,user_id,created_at,expires_at) VALUES('existing-token','old',0,9999999999999)").run();
  d.exec('DROP TABLE message_threads; DROP TABLE message_thread_members; DROP TABLE messages; DROP TABLE message_reads; ALTER TABLE sites DROP COLUMN timezone;');
  d.pragma(`user_version=${SCHEMA_VERSION-1}`); migrate(d);
  assert.equal(d.prepare('SELECT user_id FROM user_sessions').get().user_id, 'old');
  assert.equal(d.prepare('SELECT id FROM users').get().id, 'old'); d.close();
  const church = getChurch();
  replaceChurch({ ...church, sites: church.sites.map(({ timezone: _timezone, ...s }) => s) });
  assert.equal(store.site('alpha').timezone, 'America/New_York');
  assert.throws(() => replaceChurch({ ...church, sites: [{ ...church.sites[0], timezone: 'invalid-zone' }] }), /timezone/);
});


test('anonymous and wrong-user HTTP streams cannot subscribe to private messaging topics', async () => {
  for (const headers of [{}, { Authorization: `Bearer ${tokens[outsider.id]}` }]) {
    const ctl = new AbortController();
    const res = await fetch(`${base}/api/stream?topics=sunday:${member.id}`, { headers, signal: ctl.signal });
    assert.equal(res.status, 200);
    assert.equal(hub.subscriberCount(`sunday:${member.id}`), 0);
    ctl.abort();
    await res.body.cancel().catch(() => {});
  }
});


test('notification previews are authorized, bounded, and exclude soft-deleted content', () => {
  const message = store.sendMessage(active.id, member.id, 'a'.repeat(300));
  const visible = store.summary(store.thread(active.id), session(other));
  assert.equal(visible.latestMessage.preview, 'a'.repeat(240) + '…');
  assert.equal(visible.latestMessage.senderId, member.id);
  getDb().prepare('UPDATE messages SET deleted_at=? WHERE id=?').run(Date.now(), message.id);
  const deleted = store.summary(store.thread(active.id), session(other));
  assert.notEqual(deleted.latestMessage.id, message.id);
  assert.equal(store.listThreads(session(outsider)).length, 0);
});
