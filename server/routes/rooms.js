// Rooms: listing, current state, and mode changes.

import express from 'express';

import { rooms } from '../roomsStore.js';
import { publicRoom } from '../roomModel.js';
import { requirePermission, auditSuccess } from '../httpAuth.js';
import { readRoomState, applyMode, modeLockError } from '../roomModes.js';
import { bump } from '../roomStateWatcher.js';

const router = express.Router();

router.get('/api/rooms', (_req, res) => {
  res.json(Object.values(rooms).map(publicRoom));
});

router.get('/api/rooms/:id', (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'Unknown room' });
  res.json(publicRoom(room));
});

// Current room mode.
router.get('/api/rooms/:id/state', async (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'Unknown room' });
  res.json(await readRoomState(room));
});

// Switch the room to a mode (presses the mapped Companion button).
router.post('/api/rooms/:id/mode', requirePermission('rooms.mode.change'), async (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'Unknown room' });
  if (room.roomMode === false) return res.status(409).json({ error: 'Room Mode is disabled for this room' });

  const mode = room.modes.find((m) => m.id === req.body?.mode);
  if (!mode) return res.status(400).json({ error: 'Unknown mode' });

  // Enforce lockout: a locked mode in a protected window needs the Override PIN.
  const lockError = modeLockError(req, room.id, mode.id, req.body?.overridePin);
  if (lockError) return res.status(403).json(lockError);

  try {
    const result = await applyMode(room, mode);
    bump(room.id); // push the new mode to every watching screen now, not in 4s
    auditSuccess(req, 'rooms.mode.change', { resourceType: 'room-mode', resourceId: mode.id });
    res.json({ ok: true, mode: mode.id, ...result });
  } catch (err) {
    res.status(502).json({
      ok: false,
      mode: mode.id,
      online: false,
      error: String(err.message ?? err),
    });
  }
});

export default router;
