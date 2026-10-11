// Room-mode domain service: current-state reads, mode changes, and the
// lockout-override check shared by the mode endpoint and checklist actions.

import { readCustomVariable, pressButton } from './companion.js';
import { rawToModeId } from './roomModel.js';
import * as settings from './settings.js';
import * as auth from './authStore.js';

// In-memory state for simulated rooms only — a room with no Companion (a demo,
// a dev box, a room run on lockouts and checklists alone) still has a mode.
// Never used to paper over a REAL Companion that stopped answering: a booth
// display saying "Sunday" for a room nobody has confirmed is in Sunday is
// worse than saying it doesn't know (#54). Lazily keyed (?? 'standby' at reads) so rooms created after boot just work.
const mockState = Object.create(null);

// Current room mode (the body of GET /api/rooms/:id/state).
export async function readRoomState(room) {
  const protection = settings.computeProtection(room.id);

  if (room.mock || !room.companion?.host) {
    const raw = mockState[room.id] ?? 'standby';
    return { mode: rawToModeId(room, raw), raw, online: false, source: 'mock', protection };
  }

  try {
    const raw = await readCustomVariable(room.companion, room.state.variable);
    return { mode: rawToModeId(room, raw), raw, online: true, source: 'companion', protection };
  } catch (err) {
    // Unknown, not a guess. `source` stays 'companion' so a broken live room
    // and a simulated one never share a shape; `error` says why.
    return {
      mode: null,
      raw: '',
      online: false,
      source: 'companion',
      protection,
      error: String(err.message ?? err),
    };
  }
}

// Set a room's mode: presses the mapped Companion button. Shared by the mode
// endpoint and automated checklist items. Throws if Companion is unreachable.
export async function applyMode(room, mode) {
  if (room.mock || !room.companion?.host) {
    mockState[room.id] = mode.match ?? mode.id;
    return { online: false, source: 'mock' };
  }
  // A live room's mode is whatever Companion next reports — never recorded
  // here first, or a failed press would read back as the mode it asked for.
  if (mode.press) await pressButton(room.companion, mode.press);
  return { online: true, source: 'companion' };
}

// Enforce lockout: a locked mode in a protected window needs the Override PIN.
// Returns null when the change is allowed, or the 403 response body when not.
export function modeLockError(req, roomId, modeId, overridePin) {
  if (!settings.isModeLocked(roomId, modeId)) return null;
  const permitted = auth.hasPermission(req.auth, 'rooms.mode.override_lock');
  if (!permitted && !settings.verifyOverride(overridePin)) {
    return { error: 'override_required', mode: modeId };
  }
  return null;
}
