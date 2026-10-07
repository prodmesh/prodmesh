// Room-mode domain service: current-state reads, mode changes, and the
// lockout-override check shared by the mode endpoint and checklist actions.
//
// There is no simulated Companion state here on purpose. The read either came
// back from the room's real Companion or it did not — when it did not, the
// payload says so with `online: false` and an error, and `mode` is null rather
// than a value no Companion reported. A mode change either pressed the real
// button or it threw. Nothing in this module invents a mode to keep a screen
// populated.

import { readCustomVariable, pressButton } from './companion.js';
import { rawToModeId } from './roomModel.js';
import * as settings from './settings.js';
import * as auth from './authStore.js';

// Current room mode (the body of GET /api/rooms/:id/state). A room with no
// Companion configured has no mode to report, and that is the truth it shows.
export async function readRoomState(room) {
  const protection = settings.computeProtection(room.id);

  if (!room.companion?.host) {
    return { mode: null, raw: '', online: false, source: 'companion', protection, error: 'No Companion configured' };
  }

  try {
    const raw = await readCustomVariable(room.companion, room.state.variable);
    return { mode: rawToModeId(room, raw), raw, online: true, source: 'companion', protection };
  } catch (err) {
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
// endpoint and automated checklist items. Throws if Companion is unreachable
// or the room has no Companion configured — nothing is recorded as pressed
// that was not actually pressed.
export async function applyMode(room, mode) {
  if (!room.companion?.host) throw new Error('No Companion configured for this room');
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