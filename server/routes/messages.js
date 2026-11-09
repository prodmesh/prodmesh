import express from 'express';
import { getDb } from '../db.js';
import { auditSuccess, bearer, requirePermission } from '../httpAuth.js';
import * as store from '../messagingStore.js';
import { syncSunday } from '../messagingSchedule.js';
import { issueStreamTicket } from '../messagingStream.js';
const router = express.Router();
router.use('/api/messages', (req, res, next) => {
  if (!req.auth) return res.status(401).json({ error: 'Sign in to use Messages' });
  next();
});
router.post('/api/messages/stream-ticket', (req, res) => {
  try { res.json({ ticket: issueStreamTicket(bearer(req)) }); }
  catch { res.status(429).json({ error: 'Too many stream connections' }); }
});
router.get('/api/messages', async (req, res) => {
  const siteId = req.query.site ? String(req.query.site) : null;
  if (siteId && !store.site(siteId)) return res.status(404).json({ error: 'Unknown site' });
  // Syncing never grants administrative authority: only the existing explicit
  // PC person link can add a user; station campus is not an access credential.
  const sites = getDb().prepare("SELECT id FROM sites WHERE status='active'").all();
  for (const s of sites.filter(s => !siteId || s.id === siteId)) {
    store.resolveSunday(s.id);
    syncSunday(s.id).catch(() => {});
  }
  res.json({ threads: store.listThreads(req.auth, siteId), manage: store.manager(req.auth) });
});
function access(req, res, next) {
  const t = store.thread(req.params.threadId);
  if (!store.accessible(req.auth, t)) return res.status(404).json({ error: 'Conversation unavailable' });
  store.resolveSunday(t.site_id); // lazy lifecycle also guards after long downtime
  req.thread = store.thread(t.id); next();
}
router.use('/api/messages/:threadId', access);
router.get('/api/messages/:threadId', (req, res) => {
  const parse = value => value === undefined ? undefined : Number(value);
  const before = parse(req.query.before), after = parse(req.query.after);
  if ([before, after].some(n => n !== undefined && (!Number.isSafeInteger(n) || n < 0))) return res.status(400).json({ error: 'Invalid cursor' });
  const messages = store.listMessages(req.thread.id, before, after);
  res.json({ thread: store.summary(req.thread, req.auth), members: store.members(req.thread.id), messages,
    hasMore: messages.length === 50 });
});
router.post('/api/messages/:threadId/messages', (req, res) => {
  if (!store.members(req.thread.id).some(m => m.id === req.auth.user.id)) return res.status(403).json({ error: 'Only team members can send' });
  try { res.status(201).json({ message: store.sendMessage(req.thread.id, req.auth.user.id, req.body?.body) }); }
  catch (err) { res.status(err.status ?? 400).json({ error: err.message }); }
});
router.post('/api/messages/:threadId/read', (req, res) => {
  try { store.markRead(req.thread.id, req.auth.user.id, req.body?.messageId); res.json({ ok: true }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
router.get('/api/messages/:threadId/directory', requirePermission('messages.manage'), (_req, res) => {
  res.json({ users: getDb().prepare('SELECT id,display_name AS displayName FROM users WHERE active=1 ORDER BY display_name').all() });
});
router.put('/api/messages/:threadId/members/:userId', requirePermission('messages.manage'), (req, res) => {
  if (typeof req.body?.remove !== 'boolean') return res.status(400).json({ error: 'Specify remove' });
  try {
    store.setMember(req.thread.id, req.params.userId, req.body.remove);
    auditSuccess(req, 'messages.manage', { resourceType: 'message-thread', resourceId: req.thread.id, details: { operation: req.body.remove ? 'remove-member' : 'add-member', userId: req.params.userId } });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
router.put('/api/messages/:threadId/status', requirePermission('messages.manage'), (req, res) => {
  const status = req.body?.status;
  if (!['active', 'locked', 'archived'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  if (req.thread.service_date < store.localDate(Date.now(), store.site(req.thread.site_id).timezone)) return res.status(400).json({ error: 'Previous Sundays remain archived' });
  getDb().prepare('UPDATE message_threads SET status=?,archived_at=? WHERE id=?').run(status, status === 'archived' ? Date.now() : null, req.thread.id);
  store.bump(req.thread.id);
  auditSuccess(req, 'messages.manage', { resourceType: 'message-thread', resourceId: req.thread.id, details: { operation: status } });
  res.json({ ok: true });
});
router.post('/api/messages/:threadId/sync', requirePermission('messages.manage'), async (req, res) => {
  if (req.thread.status !== 'active') return res.status(400).json({ error: 'Only the active Sunday can sync' });
  await syncSunday(req.thread.site_id, { force: true }); store.bump(req.thread.id); res.json({ ok: true });
});
router.delete('/api/messages/:threadId/messages/:messageId', (req, res) => {
  const message = getDb().prepare('SELECT * FROM messages WHERE thread_id=? AND id=?').get(req.thread.id, req.params.messageId);
  if (!message) return res.status(404).json({ error: 'Message unavailable' });
  if (req.thread.status !== 'active') return res.status(400).json({ error: 'Conversation is read-only' });
  if (message.sender_user_id !== req.auth.user.id && !store.manager(req.auth)) return res.status(403).json({ error: 'Cannot delete this message' });
  getDb().prepare('UPDATE messages SET deleted_at=? WHERE id=?').run(Date.now(), message.id); store.bump(req.thread.id);
  if (message.sender_user_id !== req.auth.user.id) auditSuccess(req, 'messages.manage', { resourceType: 'message', resourceId: String(message.id), details: { operation: 'delete' } });
  res.json({ ok: true });
});
export default router;
