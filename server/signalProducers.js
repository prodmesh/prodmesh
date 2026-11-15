// ─────────────────────────────────────────────────────────────────────────────
//  SIGNAL PRODUCERS  —  where existing code's changes become signals.
//
//  ADR 0019: the code that notices a change emits the signal itself; nothing
//  derives changes later by diffing snapshots. Most producers are one line at
//  the point of change (showManager, the mode route). Integration health is
//  here because health.js knows keys, not rooms, and turning
//  "proPresenter@192.0.2.10:1025" into "the Auditorium's ProPresenter" needs
//  the room model, which health.js deliberately does not import.
//
//  ONE FAILED REQUEST IS NOT "DOWN". A ProPresenter poll that fails once while
//  an operator triggers a slide is noise, so `integration.down` is emitted on
//  the SECOND consecutive failure. health.js still logs the first, as it
//  always has. `integration.up` follows only a `down` this process emitted,
//  or an alert still open from before a restart, so a healthy integration
//  costs one Set lookup per report and writes nothing.
// ─────────────────────────────────────────────────────────────────────────────

import { rooms } from './roomsStore.js';
import * as health from './health.js';
import * as signals from './signals.js';
import * as ppro from './integrations/proPresenter.js';
import * as companion from './companion.js';
import * as smaart from './integrations/smaart.js';
import * as rta from './integrations/rta.js';
import * as openSoundMeter from './integrations/openSoundMeter.js';
import * as youtube from './integrations/youtube.js';
import * as captions from './integrations/captions.js';

export const DOWN_AFTER_FAILURES = 2;

const LABELS = {
  planningCenter: 'Planning Center',
  pcCalendar: 'Planning Center Calendar',
  slack: 'Slack',
  proPresenter: 'ProPresenter',
  companion: 'Companion',
  analysis: 'Audio analysis',
  youtube: 'YouTube',
  captions: 'Captions',
  resi: 'Resi',
  restream: 'Restream',
  peer: 'Linked server',
};

/** "proPresenter@host:port" → "proPresenter"; "peer:abc" → "peer". */
export const integrationOf = (key) => String(key).split(/[@:]/)[0];

export const labelFor = (key) => LABELS[integrationOf(key)] ?? integrationOf(key);

/** Health keys a room's own configuration produces. */
function roomKeys(room) {
  const keys = [];
  if (ppro.isConfigured(room.proPresenter)) keys.push(ppro.healthKey(room.proPresenter));
  if (room.companion?.host && !room.companion.mock) keys.push(companion.healthKey(room.companion));
  const a = room.analysis;
  if ((a?.host || a?.source === 'open-sound-meter') && !a.mock) {
    keys.push(a.source === 'rta' ? rta.healthKey(a) : a.source === 'open-sound-meter' ? openSoundMeter.healthKey(a) : smaart.healthKey(a));
  }
  if (youtube.isConfigured(room.youtube) && !room.youtube?.mock) keys.push(youtube.healthKey(room.youtube));
  if (captions.isConfigured(room.captions)) keys.push(captions.healthKey(room.captions));
  return keys;
}

/**
 * Which rooms a health key belongs to, and so whose show it can interrupt.
 *   scope 'room' — the rooms whose config produces it (usually one);
 *   scope 'org'  — Planning Center, Slack, Resi: every room leans on it;
 *   scope 'peer' — a linked server. Its outage is real but interrupts no
 *                  show here.
 */
export function bindingFor(key) {
  if (integrationOf(key) === 'peer') return { scope: 'peer', roomIds: [] };
  const roomIds = Object.values(rooms).filter((r) => roomKeys(r).includes(key)).map((r) => r.id);
  return roomIds.length ? { scope: 'room', roomIds } : { scope: 'org', roomIds: [] };
}

/**
 * A room's devices and the last thing each one did, whether or not anything
 * is checking them now: 'ok', 'down', or 'unknown' if never contacted since
 * boot. Ids and labels only, never an address (Admin → Monitoring).
 */
export function roomDevices(room) {
  const snap = health.snapshot();
  return roomKeys(room).map((key) => {
    const s = snap[key];
    return {
      id: integrationOf(key),
      label: labelFor(key),
      state: !s || s.ok == null ? 'unknown' : s.ok ? 'ok' : 'down',
    };
  });
}

const roomName = (id) => rooms[id]?.name ?? id;

/** "Auditorium · ProPresenter", or just "Planning Center" for org scope. */
export function titleFor(key, binding = bindingFor(key)) {
  const label = labelFor(key);
  if (binding.scope !== 'room') return label;
  return `${binding.roomIds.map(roomName).join(', ')} · ${label}`;
}

const down = new Set(); // keys this process reported down (or found open at boot)

function integrationSignal(kind, key, extra = {}) {
  const binding = bindingFor(key);
  signals.emit({
    kind,
    source: 'health',
    subject: key,
    roomId: binding.roomIds.length === 1 ? binding.roomIds[0] : null,
    severity: kind === 'integration.down' ? 'error' : null,
    summary: `${titleFor(key, binding)} ${kind === 'integration.down' ? 'is unreachable' : 'is back'}`,
    data: { integration: integrationOf(key), scope: binding.scope, roomIds: binding.roomIds, ...extra },
  });
}

function onReport(key, ok, failuresBefore, entry) {
  if (ok) {
    if (down.delete(key)) integrationSignal('integration.up', key, { failures: failuresBefore });
    return;
  }
  if (entry.consecutiveFailures === DOWN_AFTER_FAILURES && !down.has(key)) {
    down.add(key);
    // The error text is kept in the signal for Admin, behind a permission. It
    // never reaches a public topic or Slack: a failed connect stringifies as
    // "ECONNREFUSED 192.0.2.10:1025", a map of the building's network.
    integrationSignal('integration.down', key, { error: entry.lastError?.message ?? null });
  }
}

function onForget(key) {
  if (down.delete(key)) integrationSignal('integration.up', key, { removed: true });
}

let wired = false;

/**
 * Wire health into signals. `openSubjects` are integration keys with an alert
 * still open from before a restart: their next success must resolve it, even
 * though this process never saw them go down.
 */
export function initHealthSignals(openSubjects = []) {
  for (const k of openSubjects) down.add(k);
  if (wired) return;
  wired = true;
  health.onReport(onReport);
  health.onForget(onForget);
}

/**
 * The room's configuration changed: a key no room or integration produces any
 * more will never report again, so anything still down under it is closed.
 */
export function sweepUnconfigured(stillConfigured) {
  for (const key of [...down]) {
    if (!stillConfigured(key)) {
      down.delete(key);
      integrationSignal('integration.up', key, { removed: true });
    }
  }
}

/** Is this key one some room or org integration still uses? */
export function isConfiguredKey(key) {
  if (integrationOf(key) === 'peer') return key in health.snapshot();
  if (Object.values(rooms).some((r) => roomKeys(r).includes(key))) return true;
  return ['planningCenter', 'pcCalendar', 'slack', 'resi', 'restream'].includes(integrationOf(key));
}

// ── Room mode ────────────────────────────────────────────────────────────────
//  Two places learn a room's mode: the mode route (someone pressed a button
//  here) and the mode watcher (Companion says so, perhaps because someone
//  pressed a Stream Deck). Both call noteMode; it emits only on a real change,
//  so a press that the watcher then confirms is one signal, not two. The first
//  sighting after boot is a baseline, not a change.

const lastMode = new Map(); // roomId → mode id

/** Who a request acted as, in words, for a signal's `by`. */
export const actorOf = (req) =>
  req.auth?.user?.displayName ?? (req.auth?.token ? `Token: ${req.auth.token.name}` : null) ?? req.station?.name ?? 'ProdMesh';

export function noteMode(roomId, mode, { by = null } = {}) {
  if (mode == null) return;
  const prev = lastMode.get(roomId);
  lastMode.set(roomId, mode);
  if (prev === mode) return;
  if (prev === undefined && by == null) return; // a baseline, not a change
  const room = rooms[roomId];
  const label = room?.modes?.find((m) => m.id === mode)?.label ?? mode;
  signals.emit({
    kind: 'room.mode.changed',
    source: by ? 'prodmesh' : 'companion',
    roomId,
    subject: roomId,
    summary: `${room?.name ?? roomId} → ${label}`,
    data: { mode, from: prev ?? null, by },
  });
}

/** Tests only. */
export function reset() {
  down.clear();
  lastMode.clear();
}
