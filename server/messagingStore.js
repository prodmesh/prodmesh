// Sunday Team uses named users, SQLite and the existing global ACL. Membership
// is the site-scoped boundary for operators; messages.manage is global admin authority.
import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';
import { hasPermission } from './authStore.js';
import * as hub from './streamHub.js';

export function localDate(now, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now));
  const part = name => parts.find(p => p.type === name).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function sundayDate(now, timezone) {
  const date = new Date(`${localDate(now, timezone)}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + (7 - date.getUTCDay()) % 7);
  return date.toISOString().slice(0, 10);
}
export const site = id => getDb().prepare("SELECT id,name,COALESCE(timezone,'UTC') AS timezone FROM sites WHERE id=? AND status='active'").get(id);
export const thread = id => getDb().prepare('SELECT * FROM message_threads WHERE id=?').get(id);
export const manager = session => hasPermission(session, 'messages.manage');
export function accessible(session, t) {
  if (!session || !t || !site(t.site_id)) return false;
  return manager(session) || Boolean(getDb().prepare('SELECT 1 FROM message_thread_members WHERE thread_id=? AND user_id=? AND removed_at IS NULL').get(t.id, session.user.id));
}
export function resolveSunday(siteId, now = Date.now()) {
  const s = site(siteId);
  if (!s) throw new Error('Unknown active site');
  const date = sundayDate(now, s.timezone);
  const db = getDb();
  return db.transaction(() => {
    const expired = db.prepare("SELECT id FROM message_threads WHERE site_id=? AND service_date<? AND status!='archived'").all(siteId, localDate(now, s.timezone));
    db.prepare("UPDATE message_threads SET status='archived',archived_at=? WHERE site_id=? AND service_date<? AND status!='archived'").run(now, siteId, localDate(now, s.timezone));
    db.prepare('INSERT OR IGNORE INTO message_threads(id,site_id,service_date,created_at) VALUES(?,?,?,?)').run(randomUUID(), siteId, date, now);
    for (const t of expired) bump(t.id);
    return db.prepare('SELECT * FROM message_threads WHERE site_id=? AND service_date=? AND service_plan_id IS NULL').get(siteId, date);
  })();
}
export function members(id) {
  return getDb().prepare(`SELECT u.id,u.display_name AS displayName,m.membership_source AS source
    FROM message_thread_members m JOIN users u ON u.id=m.user_id
    WHERE m.thread_id=? AND m.removed_at IS NULL AND u.active=1 ORDER BY u.display_name`).all(id);
}
export function setMember(id, userId, remove = false) {
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM users WHERE id=? AND active=1').get(userId)) throw new Error('Unknown active user');
  db.prepare(`INSERT INTO message_thread_members(thread_id,user_id,membership_source,joined_at,removed_at)
    VALUES(?,?,'manual',?,?) ON CONFLICT(thread_id,user_id) DO UPDATE SET
    membership_source='manual',removed_at=excluded.removed_at`).run(id, userId, Date.now(), remove ? Date.now() : null);
  bump(id, userId);
}
// Additive reconciliation intentionally retains missing assignments. A manual
// removal is a tombstone: subsequent schedule refreshes must not undo it.
export function reconcile(id, people) {
  const db = getDb();
  const unmatched = [];
  db.transaction(() => {
    for (const p of people) {
      const personId = String(p.personId ?? '').replace(/^P(?=\d+$)/i, '');
      const user = personId ? db.prepare('SELECT id FROM users WHERE planning_center_person_id=? AND active=1').get(personId) : null;
      if (!user) { unmatched.push({ personId, name: p.name }); continue; }
      db.prepare("INSERT OR IGNORE INTO message_thread_members(thread_id,user_id,membership_source,joined_at) VALUES(?,?,'schedule',?)").run(id, user.id, Date.now());
    }
    db.prepare("UPDATE message_threads SET sync_status='connected',unmatched=? WHERE id=?").run(JSON.stringify(unmatched), id);
  })();
  bump(id);
}
export function listMessages(id, before, after) {
  const db = getDb();
  const projection = `SELECT m.id,m.thread_id AS threadId,m.sender_user_id AS senderId,u.display_name AS senderName,
    CASE WHEN m.deleted_at IS NULL THEN m.body ELSE '' END AS body,m.created_at AS createdAt,
    m.deleted_at AS deletedAt FROM messages m LEFT JOIN users u ON u.id=m.sender_user_id`;
  if (after != null) return db.prepare(`${projection} WHERE m.thread_id=? AND m.id>? ORDER BY m.id LIMIT 50`).all(id, after);
  return db.prepare(`${projection} WHERE m.thread_id=? AND m.id<? ORDER BY m.id DESC LIMIT 50`).all(id, before ?? Number.MAX_SAFE_INTEGER).reverse();
}
export function sendMessage(id, userId, body, now = Date.now()) {
  if (typeof body !== 'string' || !body.trim() || body.length > 4000) throw new Error('Message must be 1–4000 characters');
  const t = thread(id);
  if (!t || t.status !== 'active' || t.service_date < localDate(now, site(t.site_id).timezone)) throw new Error('Conversation is read-only');
  const db = getDb();
  // Persisted per-user rate limit survives reconnects and server restarts.
  if (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE sender_user_id=? AND created_at>?').get(userId, now - 60_000).n >= 30) {
    const error = new Error('Please wait before sending more messages'); error.status = 429; throw error;
  }
  const result = db.prepare('INSERT INTO messages(thread_id,sender_user_id,body,created_at) VALUES(?,?,?,?)').run(id, userId, body.trim(), now);
  bump(id);
  return listMessages(id, Number(result.lastInsertRowid) + 1).at(-1);
}
export function markRead(id, userId, cursor) {
  const db = getDb();
  if (!Number.isSafeInteger(cursor) || cursor < 0 || (cursor && !db.prepare('SELECT 1 FROM messages WHERE thread_id=? AND id=?').get(id, cursor))) throw new Error('Invalid read position');
  db.prepare(`INSERT INTO message_reads(thread_id,user_id,last_read_message_id) VALUES(?,?,?)
    ON CONFLICT(thread_id,user_id) DO UPDATE SET last_read_message_id=MAX(last_read_message_id,excluded.last_read_message_id)`).run(id, userId, cursor);
  hub.publish(`sunday:${userId}`, revision(userId));
}
export function unread(id, userId) {
  return getDb().prepare(`SELECT COUNT(*) AS n FROM messages WHERE thread_id=? AND sender_user_id!=? AND deleted_at IS NULL
    AND id>COALESCE((SELECT last_read_message_id FROM message_reads WHERE thread_id=? AND user_id=?),0)`).get(id, userId, id, userId).n;
}
export function summary(t, session) {
  const latest = getDb().prepare(`SELECT m.id,m.sender_user_id AS senderId,u.display_name AS senderName,CASE WHEN length(m.body)>240 THEN substr(m.body,1,240)||'…' ELSE m.body END AS preview FROM messages m LEFT JOIN users u ON u.id=m.sender_user_id WHERE m.thread_id=? AND m.deleted_at IS NULL ORDER BY m.id DESC LIMIT 1`).get(t.id);
  return { id: t.id, siteId: t.site_id, siteName: site(t.site_id)?.name, timezone: site(t.site_id)?.timezone,
    serviceDate: t.service_date, isCurrent: t.service_date === sundayDate(Date.now(), site(t.site_id).timezone), status: t.status, memberCount: members(t.id).length, unread: unread(t.id, session.user.id),
    latestMessage: latest ?? null,
    canSend: t.status === 'active' && members(t.id).some(m => m.id === session.user.id),
    ...(manager(session) ? { syncStatus: t.sync_status, unmatched: JSON.parse(t.unmatched) } : {}) };
}
export function listThreads(session, siteId) {
  return getDb().prepare('SELECT * FROM message_threads WHERE (? IS NULL OR site_id=?) ORDER BY service_date DESC LIMIT 100').all(siteId ?? null, siteId ?? null)
    .filter(t => accessible(session, t)).map(t => summary(t, session));
}
function revision(userId) { return { revision: randomUUID(), userId }; }
export function bump(id, extraUser) {
  const ids = new Set(getDb().prepare('SELECT user_id FROM message_thread_members WHERE thread_id=?').all(id).map(m => m.user_id));
  for (const u of getDb().prepare(`SELECT DISTINCT ug.user_id FROM user_groups ug JOIN permission_groups g ON g.id=ug.group_id
    LEFT JOIN group_permissions p ON p.group_id=g.id WHERE g.system_key='admin' OR p.permission_id='messages.manage'`).all()) ids.add(u.user_id);
  if (extraUser) ids.add(extraUser);
  for (const uid of ids) if (hub.subscriberCount(`sunday:${uid}`)) hub.publish(`sunday:${uid}`, revision(uid));
}
hub.registerTopic('sunday:*', { valid: uid => Boolean(getDb().prepare('SELECT 1 FROM users WHERE id=? AND active=1').get(uid)), snapshot: revision });
