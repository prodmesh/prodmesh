// ─────────────────────────────────────────────────────────────────────────────
//  ROOM INTEGRATION HEALTH  —  one prober per room, not one per screen.
//
//  Same probe as the chips on Admin → Campuses → a room (connectivityStatus's
//  roomStatus), so a green dot here and a green chip there mean the same
//  thing: the smallest real request the dashboard depends on came back.
//
//  Two things make it safe to publish on an UNAUTHENTICATED topic when the
//  route that shares the probe needs `config.manage`:
//
//   1. REFCOUNTING. The hub starts this when the first screen subscribes and
//      stops it when the last leaves, and a room is probed once per cycle
//      however many are watching. The route is gated because each REQUEST
//      generates outbound traffic to the building's devices; here a wall of
//      displays costs exactly what one costs. That is the same property that
//      already makes the mode watcher (4s) and the SPL watcher (1s) safe, and
//      this cycle is far slower than either.
//
//   2. REDACTION. The published value says WHICH integration and WHETHER it
//      works. It never carries a host, a port, a version banner or an error
//      string. Those are the difference between "ProPresenter is down" and a
//      map of the building's network, and probe text is full of them:
//      proPresenter.ping returns the PP machine's own host description, and a
//      failed TCP connect stringifies as "ECONNREFUSED 10.x.y.z:1025".
//      companion.ping already learned this the hard way — see the comment
//      there about reporting the shape of an answer and not its bytes. The
//      detail is not lost, it is just kept where it was already: the config
//      chips and Admin → Logs, both behind a permission.
//
//  Published on CHANGE, so a healthy room costs one probe per cycle and no
//  browser traffic at all.
// ─────────────────────────────────────────────────────────────────────────────

import { rooms } from './roomsStore.js';
import * as hub from './streamHub.js';
import * as youtube from './integrations/youtube.js';
import * as captions from './integrations/captions.js';
import { roomStatus } from './connectivityStatus.js';
import { snapshot } from './health.js';

const watchers = new Map(); // roomId -> AbortController
const states = new Map();
// When each room was last READ successfully, change or not. Publishing is on
// change, so the publish time says nothing about freshness; a federation
// digest (ADR 0016) must say when the value was last confirmed.
const observed = new Map(); // roomId -> ms

/** When this room's value was last confirmed, or null if never/not watched. */
export const observedAt = (roomId) => observed.get(roomId) ?? null;
/** The last published value, or undefined while unwatched or not yet read. */
export const current = (roomId) => states.get(roomId); // roomId -> last published status

// Deliberately slow. Nothing here changes on a human timescale that matters —
// an integration that dropped thirty seconds ago is still news — and every
// cycle is real traffic to real devices in a real building.
const POLL_MS = 30_000;

export const healthTopic = (roomId) => `room:${roomId}:health`;

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = () => { clearTimeout(t); resolve(); };
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    t.unref?.(); // an idle prober must not hold an otherwise-finished process open
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Order is the order they appear on screen: cloud first, then the room's own
 *  machines, roughly in the sequence a service depends on them. */
const LABELS = {
  planningCenter: 'Planning Center',
  proPresenter: 'ProPresenter',
  companion: 'Companion',
  analysis: 'Analysis',
  youtube: 'YouTube',
  captions: 'Captions',
};

/**
 * One probe result → one dot. `null` means the room has not configured that
 * integration at all, and an unconfigured integration is not a grey dot — it
 * is absent, because a room that does not stream has nothing to say about
 * YouTube and a permanent grey dot for it is noise that trains people to
 * ignore the dots.
 */
function dot(id, s) {
  if (!s) return null;
  const state = s.mock ? 'mock' : s.ok === true ? 'ok' : s.ok === false ? 'down' : 'unknown';
  return { id, label: LABELS[id], state };
}

/**
 * YouTube is NOT probed, and that is deliberate: every request to it is
 * metered Google quota (see integrations/youtube.js), so a status widget left
 * on a wall would spend the day buying dots. Its state is whatever the last
 * REAL request recorded — which happens whenever the room is streaming, i.e.
 * exactly when the answer matters.
 */
function youtubeDot(room) {
  if (!youtube.isConfigured(room.youtube)) return null;
  if (room.youtube?.mock) return { id: 'youtube', label: LABELS.youtube, state: 'mock' };
  const snap = snapshot()[youtube.healthKey(room.youtube)];
  if (!snap || snap.ok == null) return { id: 'youtube', label: LABELS.youtube, state: 'unknown' };
  return { id: 'youtube', label: LABELS.youtube, state: snap.ok ? 'ok' : 'down' };
}

/**
 * The redaction step, as a pure function, because it is the security-relevant
 * half and burying it inside a network loop would make it the half that never
 * gets tested. Takes a raw roomStatus() result; returns what goes on the wire.
 *
 * Note it builds the output from a FIXED set of fields rather than deleting
 * unwanted ones from the probe result. A denylist would silently start leaking
 * the day connectivityStatus adds a field.
 */
export function publicHealth(room, status, at) {
  return {
    at,
    integrations: [
      dot('planningCenter', status.planningCenter),
      dot('proPresenter', status.proPresenter),
      dot('companion', status.companion),
      dot('analysis', status.analysis),
      youtubeDot(room),
      captionsDot(room),
    ].filter(Boolean),
  };
}

/**
 * Captions are read from the health registry rather than probed, for the same
 * reason YouTube is — but a different one underneath. A probe here would mean
 * opening a second WebSocket beside the one captionWatcher already holds, and
 * that watcher reports every connect and every drop. Anything a probe could
 * learn is already recorded by the thing doing the real work.
 */
function captionsDot(room) {
  const cfg = room.captions;
  if (!captions.isConfigured(cfg)) return null;
  const snap = snapshot()[captions.healthKey(cfg)];
  if (!snap || snap.ok == null) return { id: 'captions', label: LABELS.captions, state: 'unknown' };
  return { id: 'captions', label: LABELS.captions, state: snap.ok ? 'ok' : 'down' };
}

async function probe(roomId) {
  const room = rooms[roomId];
  if (!room) return null;
  return publicHealth(room, await roomStatus(room), Date.now());
}

// `at` moves every cycle and is not a change — comparing on it would republish
// to every browser every 30 seconds for nothing.
const changeKey = (v) => JSON.stringify(v.integrations);

async function watch(roomId, signal) {
  let last;
  while (!signal.aborted) {
    let next = null;
    try {
      next = await probe(roomId);
    } catch {
      next = null; // room vanished mid-cycle (a topology save); the abort follows
    }
    if (signal.aborted) return;
    if (next) {
      observed.set(roomId, Date.now());
      const key = changeKey(next);
      if (key !== last) {
        last = key;
        states.set(roomId, next);
        hub.publish(healthTopic(roomId), next);
      }
    }
    await sleep(POLL_MS, signal);
  }
}

function start(roomId) {
  if (watchers.has(roomId) || !rooms[roomId]) return;
  const ctl = new AbortController();
  watchers.set(roomId, ctl);
  watch(roomId, ctl.signal).catch(() => {});
}

function stop(roomId) {
  watchers.get(roomId)?.abort();
  watchers.delete(roomId);
  states.delete(roomId);
  observed.delete(roomId);
}

hub.registerTopic('room:*:health', {
  valid: (roomId) => Boolean(rooms[roomId]),
  start,
  stop,
  // No cached value means the first probe has not finished. `undefined` tells
  // the hub to send nothing rather than paint a wall of grey dots that turn
  // green a moment later — which would look like a room recovering from an
  // outage it never had.
  snapshot: (roomId) => states.get(roomId),
});

/** Test hook: stop every prober. */
export function stopAll() {
  for (const roomId of [...watchers.keys()]) stop(roomId);
}
