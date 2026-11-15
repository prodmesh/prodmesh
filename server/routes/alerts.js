// Alerts and signals (#47, ADRs 0015 and 0019).
//
// Seeing what is wrong needs no permission: a red banner on a booth display
// is the point, and the open list is already on the unauthenticated `alerts`
// topic. What it carries is alerts.publicView, which never includes a host,
// port or error string. The signal log does carry those (an integration's
// error text is "ECONNREFUSED 192.0.2.10:1025"), so it sits behind
// system.logs, beside Admin → Logs.

import express from 'express';
import * as alerts from '../alerts.js';
import * as signals from '../signals.js';
import { requirePermission, auditSuccess } from '../httpAuth.js';
import { actorOf, roomDevices } from '../signalProducers.js';
import * as rules from '../rules.js';
import * as roomHealth from '../roomHealth.js';
import * as slack from '../integrations/slack.js';
import { rooms } from '../roomsStore.js';

const router = express.Router();

router.get('/api/alerts', (_req, res) => {
  res.json({ open: alerts.listOpen().map(alerts.publicView) });
});

router.get('/api/alerts/history', requirePermission('system.logs'), (req, res) => {
  res.json({ alerts: alerts.listRecent({ limit: req.query.limit, before: req.query.before }) });
});

router.post('/api/alerts/:alertId/acknowledge', requirePermission('alerts.acknowledge'), (req, res) => {
  const id = Number(req.params.alertId);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Unknown alert' });
  const existing = alerts.get(id);
  if (!existing) return res.status(404).json({ error: 'Unknown alert' });
  const a = alerts.acknowledge(id, actorOf(req));
  if (!a) return res.status(409).json({ error: 'This alert has already cleared' });
  auditSuccess(req, 'alerts.acknowledge', { resourceType: 'alert', resourceId: String(id), details: { title: a.title } });
  res.json({ alert: alerts.publicView(a) });
});

router.get('/api/signals', requirePermission('system.logs'), (req, res) => {
  const kind = typeof req.query.kind === 'string' ? req.query.kind.slice(0, 80) : null;
  const roomId = typeof req.query.roomId === 'string' ? req.query.roomId.slice(0, 80) : null;
  res.json({ signals: signals.list({ limit: req.query.limit, before: req.query.before, kind, roomId }) });
});

// Admin → Monitoring: is it sending, what is it watching, and on what rule.
router.get('/api/monitoring', requirePermission('settings.manage'), (_req, res) => {
  res.json({
    slack: { configured: slack.isConfigured() },
    rooms: Object.values(rooms).map((room) => ({
      id: room.id,
      name: room.name,
      site: room.site ?? null,
      // Why its devices are being checked right now: the server's own reason
      // first, otherwise a screen has the room open, otherwise nothing is.
      watching: roomHealth.heldFor(room.id) ?? (roomHealth.isWatched(room.id) ? 'screen' : null),
      lastChecked: roomHealth.observedAt(room.id),
      // The live probe's answer while one runs; otherwise each device's last
      // known result, so a room nobody is watching still shows what it has.
      integrations: roomHealth.current(room.id)?.integrations ?? roomDevices(room),
    })),
    rules: rules.BUILT_IN_RULES,
  });
});

// The single most reassuring thing a monitor can do is prove, on a Tuesday,
// that it will reach you on Sunday.
router.post('/api/monitoring/test', requirePermission('settings.manage'), async (req, res) => {
  if (!slack.isConfigured()) return res.status(409).json({ error: 'Slack is not connected' });
  try {
    await slack.postMessage(
      `:wave: Test from ProdMesh, sent by ${slack.escapeText(actorOf(req))}. Issues during a live show will post here.`,
    );
    auditSuccess(req, 'settings.manage', { resourceType: 'monitoring-test' });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: String(err.message ?? err).slice(0, 200) });
  }
});

export default router;
