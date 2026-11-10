// Show session (server-coordinated Run of Show).

import express from 'express';

import { rooms } from '../roomsStore.js';
import * as show from '../showManager.js';
import { requirePermission, auditSuccess } from '../httpAuth.js';

const router = express.Router();

// GET /api/rooms/:id/show/stream was removed in 1.5 (ADR 0013): it had no
// caller left in src/ once ADR 0010's topic stream superseded it, and the
// /api/v1 freeze would otherwise have promised it for all of 1.5.x. The raw
// "is the server alive" check it doubled as is
// /api/stream?topics=room:<id>:show, which is the same data.
router.get('/api/rooms/:id/show', (req, res) => res.json(show.getState(req.params.id)));

router.post('/api/rooms/:id/show/start', requirePermission('shows.operate'), async (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'Unknown room' });
  try {
    // planId is persisted (timeline JSON, show_summaries) and later replayed
    // into Planning Center request paths by backfillLabels, so it has to be
    // clean before it is STORED, not just before it is used. Charset rather
    // than digits-only: demo mode (no PC credentials) mints ids like
    // "mock-st1-0" and must keep working. This blocks every character that
    // could reshape a URL path; planningCenter.js then enforces digits-only
    // at the point a real request is actually built.
    let planId = String(req.body?.planId ?? '');
    let resolvedTimeId = null;
    if (!planId) {
      // No plan named: start the service the room is in now (ADR 0013), the
      // one autostart would pick. This is what lets a Companion button that
      // knows only a room start the right service every week.
      const current = await show.currentService(room, Date.now());
      if (!current) {
        return res.status(409).json({
          error: 'no_current_service',
          message: 'No service is on in this room now (from two hours before its first time to an hour after its last). Name a planId to start one anyway.',
        });
      }
      ({ planId } = current);
      resolvedTimeId = current.timeId;
    }
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(planId)) return res.status(400).json({ error: 'Invalid plan id' });
    // A rehearsal runs the full show machinery under its own synthetic
    // timeId, so it never overwrites the real service's timeline and is
    // identifiable (and excludable from aggregates) by the prefix alone.
    const timeId = req.body?.rehearsal
      ? `rehearsal-${Date.now()}`
      : String(req.body?.timeId || resolvedTimeId || 'default');
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(timeId)) return res.status(400).json({ error: 'Invalid time id' });
    const state = await show.startShow(req.params.id, planId, timeId);
    // Starting and ending a show were never audited, which was tolerable while
    // only a signed-in operator in the room could do it. A service token lets
    // a button anywhere on the network end the service, so who did it has to
    // be on record.
    auditSuccess(req, 'shows.operate', {
      resourceType: 'show', planId,
      details: { operation: 'start', timeId, ...(resolvedTimeId ? { resolved: true } : {}) },
    });
    res.json(state);
  } catch (err) {
    res.status(err.code === 'conflict' ? 409 : 400).json({ error: String(err.message ?? err) });
  }
});

router.post('/api/rooms/:id/show/end', requirePermission('shows.operate'), (req, res) => {
  try {
    const state = show.endShow(req.params.id);
    auditSuccess(req, 'shows.operate', { resourceType: 'show', details: { operation: 'end' } });
    res.json(state);
  } catch (err) {
    res.status(err.code === 'not_found' ? 409 : 400).json({ error: String(err.message ?? err) });
  }
});

router.post('/api/rooms/:id/show/current', requirePermission('shows.operate'), (req, res) => {
  try {
    res.json(show.setCurrent(req.params.id, { itemId: req.body?.itemId, follow: req.body?.follow }));
  } catch (err) {
    res.status(err.code === 'not_found' ? 409 : 400).json({ error: String(err.message ?? err) });
  }
});

export default router;
