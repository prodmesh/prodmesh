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
import { actorOf } from '../signalProducers.js';

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

export default router;
