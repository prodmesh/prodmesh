// Room-mode domain service: current-state reads, mode changes, and the
// lockout-override check shared by the mode endpoint and checklist actions.

import { readCustomVariable, pressButton } from './companion.js';
import { rawToModeId } from './roomModel.js';
import * as settings from './settings.js';
import * as auth from './authStore.js';
import { sourceIp, lockedFor, recordFailure, clearFailures } from './credentialThrottle.js';

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
    // Companion answered but has no such variable: it is online, and the
    // room's mode is simply not something it reports. Unknown, without the
    // `error` that would mark Companion as down (PR #53).
    if (err.code === 'variable_missing') {
      return { mode: null, raw: '', online: true, source: 'companion', protection, missingVariable: room.state.variable };
    }
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
// Returns null when the change is allowed, or `{ status, body }` when not.
//
// The Override PIN is a credential like any other and goes through the shared
// throttle. It went unthrottled for as long as only a signed-in operator could
// reach it, which made it a quiet escalation: anyone holding rooms.mode.change
// could guess a 4-digit PIN that grants rooms.mode.override_lock, and stall
// the event loop with an scrypt per guess while doing it. A service token
// carrying rooms.mode.change would make that an app's loop rather than a
// person's, so it is closed before tokens exist.
//
// Asking without a PIN is not a guess — it is how the UI learns a PIN is
// needed — so only a supplied, wrong PIN counts.
export function modeLockError(req, roomId, modeId, overridePin) {
  if (!settings.isModeLocked(roomId, modeId)) return null;
  if (auth.hasPermission(req.auth, 'rooms.mode.override_lock')) return null;

  const refused = { status: 403, body: { error: 'override_required', mode: modeId } };
  if (overridePin == null || overridePin === '') return refused;

  const keys = [{ k: `override:${sourceIp(req)}`, after: 5 }];
  const retryAfter = lockedFor(keys);
  if (retryAfter > 0) return { status: 429, body: { error: 'temporarily_locked', retryAfter } };
  if (!settings.verifyOverride(overridePin)) {
    recordFailure(keys);
    return refused;
  }
  clearFailures(keys);
  return null;
}
