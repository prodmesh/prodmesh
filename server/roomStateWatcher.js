// ─────────────────────────────────────────────────────────────────────────────
//  ROOM MODE WATCHER  —  one Companion poller per room, not one per browser.
//
//  `GET /api/rooms/:id/state` reads the Companion custom variable on every
//  request and caches nothing, and each RoomCard polled it on its own interval.
//  Home showing six rooms in three browsers was therefore 54 Companion reads a
//  minute for six facts. As a dashboard grid this only gets worse: every widget
//  that wants to know a room's mode would add another loop.
//
//  So mode becomes a topic. The hub starts this watcher when the first viewer
//  subscribes and stops it when the last leaves, and the room is read once per
//  cycle no matter how many are watching. The REST endpoint stays as it is —
//  it is a single read, and mock rooms and one-off checks still want it.
//
//  Published on CHANGE, not on every poll, so an idle room costs one small
//  Companion request per cycle and no traffic at all to the browsers.
// ─────────────────────────────────────────────────────────────────────────────

import { rooms } from './roomsStore.js';
import * as hub from './streamHub.js';
import { readRoomState } from './roomModes.js';

const watchers = new Map(); // roomId -> AbortController
const states = new Map();
// When each room was last READ successfully, change or not. Publishing is on
// change, so the publish time says nothing about freshness; a federation
// digest (ADR 0016) must say when the value was last confirmed.
const observed = new Map(); // roomId -> ms

/** When this room's value was last confirmed, or null if never/not watched. */
export const observedAt = (roomId) => observed.get(roomId) ?? null;
/** The last published value, or undefined while unwatched or not yet read. */
export const current = (roomId) => states.get(roomId); // roomId -> last published room state

const POLL_MS = 4000;

export const modeTopic = (roomId) => `room:${roomId}:mode`;

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = () => { clearTimeout(t); resolve(); };
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    t.unref?.(); // an idle watcher must not hold an otherwise-finished process open
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// The lockout window is part of this payload and moves on the clock, not on
// anything Companion reports — so a schedule boundary crossing has to count as
// a change or the padlock would not appear until someone pressed something.
function changeKey(state) {
  return JSON.stringify([state.mode, state.raw, state.online, state.protection]);
}

async function watch(roomId, signal) {
  let last;
  while (!signal.aborted) {
    let next = null;
    try {
      next = await readRoomState(rooms[roomId]);
    } catch {
      next = null; // room vanished mid-cycle (topology save); the abort follows
    }
    if (signal.aborted) return;
    if (next) {
      observed.set(roomId, Date.now());
      const key = changeKey(next);
      if (key !== last) {
        last = key;
        states.set(roomId, next);
        hub.publish(modeTopic(roomId), next);
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

/**
 * Re-read now instead of waiting out the poll interval. Called after a mode
 * change lands, so the operator who pressed the button — and every other
 * screen in the building — sees it move immediately rather than up to four
 * seconds later.
 */
export function bump(roomId) {
  if (!watchers.has(roomId) || !rooms[roomId]) return;
  readRoomState(rooms[roomId])
    .then((state) => {
      if (!watchers.has(roomId)) return;
      states.set(roomId, state);
      hub.publish(modeTopic(roomId), state);
    })
    .catch(() => {});
}

hub.registerTopic('room:*:mode', {
  valid: (roomId) => Boolean(rooms[roomId]),
  start,
  stop,
  // No cached value yet means the watcher has only just started; `undefined`
  // tells the hub to send nothing and let the first poll deliver it, rather
  // than paint the room with a guess.
  snapshot: (roomId) => states.get(roomId),
});

/** Test hook: stop every watcher. */
export function stopAll() {
  for (const roomId of [...watchers.keys()]) stop(roomId);
}
