// ─────────────────────────────────────────────────────────────────────────────
//  COMPANION VARIABLE WATCHER  —  arbitrary $(label:name) values as topics.
//
//  The room-mode watcher next door reads ONE variable whose name lives in the
//  room's configuration. This one reads whatever a dashboard asks for, which
//  is a different problem: the names arrive from a stored widget config, i.e.
//  from outside, and subscribing to a topic STARTS WORK (ADR 0010). An
//  endpoint that accepts any string is therefore a way to make this server
//  hammer a Companion on someone's behalf.
//
//  Three things keep that bounded:
//
//    • Names are shape-checked, and a room may have at most MAX_PER_ROOM
//      distinct variables watched at once. Beyond that the topic is simply
//      not valid, and the hub drops it the way it drops any other — one
//      over-eager dashboard must not blank the other eleven widgets.
//    • One loop per ROOM, not per variable. Eight variables on a wall display
//      are eight small GETs per cycle from one timer, not eight timers; and
//      three browsers watching the same eight cost the same as one.
//    • How often is a stored choice, not a request (#24). Each saved widget
//      picks a refresh from a fixed menu, a variable is read at the fastest
//      refresh of any saved widget showing it, and a room's widgets together
//      may not ask for more than COMPANION_READS_PER_SECOND, refused at save.
//
//  Published on CHANGE, like the mode watcher, so a rack of variables that
//  nobody is touching costs the browsers nothing.
//
//  Addressing mirrors Companion's own: `custom` is the reserved label for
//  custom variables ($(custom:doorsOpen)), anything else is a connection label
//  ($(internal:time_hms)). Which is why the topic has two wildcards rather
//  than one — the hub's `*` captures a single ':'-separated segment, and a
//  variable reference is exactly two of them.
// ─────────────────────────────────────────────────────────────────────────────

import { rooms } from './roomsStore.js';
import * as hub from './streamHub.js';
import { readVariable } from './companion.js';
import { COMPANION_DEFAULT_REFRESH_MS, COMPANION_VAR_SEGMENT } from './validate.js';
import { companionRefreshFor } from './views.js';

/** Never sleep less than this between passes, whatever is due. The fastest
 *  refresh on the menu is a second, so a shorter gap only ever means a bug. */
const MIN_GAP_MS = 100;

/** Distinct variables one room may have watched at once, across every browser.
 *  Eight rows is a full widget; three widgets on a wall is 24. Past that a
 *  dashboard is asking this server to poll a Companion at a rate no operator
 *  chose. */
export const MAX_PER_ROOM = 24;

// What a label or a name may contain, defined once beside the thing that
// stores it — a widget config that saves is a topic this can watch.
const NAME = COMPANION_VAR_SEGMENT;

/** A wall display shows a word, not a document. Truncation is bounded frame
 *  size, and it happens HERE so a huge variable cannot be used to push memory
 *  around inside the hub's retained values. */
const MAX_VALUE = 200;

const watched = new Map(); // roomId -> Map<`label:name`, last published payload>
const loops = new Map(); // roomId -> AbortController

export const variableTopic = (roomId, label, name) => `room:${roomId}:var:${label}:${name}`;

const refKey = (label, name) => `${label}:${name}`;

const wakers = new Map(); // roomId -> end this room's current sleep early
const dueAt = new Map(); // roomId -> Map<`label:name`, when it is next due>

/**
 * The gap between passes, endable three ways: the timer, the last subscriber
 * leaving, or a new variable arriving.
 *
 * That last one is why this is not a plain sleep. A second dashboard opening
 * on a room somebody is already watching joins a loop that is mid-nap, and
 * without a nudge its rows read "…" for up to a full cycle — which looks
 * exactly like a widget that does not work.
 */
function idle(roomId, ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      if (wakers.get(roomId) === done) wakers.delete(roomId);
      resolve();
    };
    const t = setTimeout(done, ms);
    t.unref?.(); // an idle watcher must not hold an otherwise-finished process open
    signal.addEventListener('abort', done, { once: true });
    wakers.set(roomId, done);
  });
}

/**
 * Read one variable into the payload a widget renders.
 *
 * `status` is what the widget shows when there is no value, and the three
 * cases are genuinely different to whoever has to fix them: `missing` is a
 * typo in the widget's own config, `offline` is Companion or the network, and
 * `simulated` is a room that was never wired to a Companion at all. Collapsing
 * them into "—" would send an operator to the wrong machine.
 */
async function read(room, label, name) {
  if (room.mock || !room.companion?.host) return { value: null, status: 'simulated' };
  try {
    const value = await readVariable(room.companion, label, name);
    return { value: value.slice(0, MAX_VALUE), status: 'ok' };
  } catch (err) {
    if (err?.status === 404) return { value: null, status: 'missing' };
    return { value: null, status: 'offline', error: String(err?.message ?? err) };
  }
}

const changed = (a, b) => !a || a.value !== b.value || a.status !== b.status;

async function loop(roomId, signal) {
  while (!signal.aborted) {
    const refs = watched.get(roomId);
    if (!refs?.size) return;
    const room = rooms[roomId];
    if (!room) return; // room vanished mid-cycle (a topology save); the abort follows

    // Variables nobody has read yet go first, and alone.
    //
    // A dashboard subscribes its cells in one tick, but the first of them
    // STARTS this loop — which then takes its list of keys before the rest
    // have been added. Without this every row but one would sit at "…" until
    // a cycle that began before it existed came round again, which on a wall
    // display is four seconds of a widget looking broken every time the page
    // loads. `null` is "never read"; a read always leaves a payload.
    const unread = [...refs.keys()].filter((key) => refs.get(key) === null);

    // How often each variable is read: the fastest refresh of any SAVED
    // Companion widget in this room showing it, from the database rather than
    // from whoever happens to be watching (#24). A variable no saved widget
    // names, such as the editor previewing a row not yet saved, reads at the
    // default.
    const periods = companionRefreshFor(roomId);
    let due = dueAt.get(roomId);
    if (!due) {
      due = new Map();
      dueAt.set(roomId, due);
    }
    const passAt = Date.now();
    const batch = unread.length ? unread : [...refs.keys()].filter((key) => (due.get(key) ?? 0) <= passAt);

    // Sequentially, deliberately: these are small GETs to one machine, and
    // firing eight at once at a Companion that is already busy driving a
    // service buys nothing worth the burst.
    for (const key of batch) {
      if (signal.aborted) return;
      const [label, name] = key.split(':');
      const next = await read(room, label, name);
      due.set(key, Date.now() + (periods.get(key) ?? COMPANION_DEFAULT_REFRESH_MS));
      // Re-read the map rather than trusting the one this cycle started with:
      // the last subscriber may have left while that request was in flight,
      // and publishing then would repopulate a topic nobody holds.
      const live = watched.get(roomId);
      if (!live?.has(key)) continue;
      if (changed(live.get(key), next)) {
        live.set(key, next);
        hub.publish(variableTopic(roomId, label, name), next);
      }
    }

    // Anything that arrived WHILE that pass was in flight is served now rather
    // than after the sleep — same reason, one tick later.
    const now = watched.get(roomId);
    if (!now?.size) continue; // the last subscriber left mid-pass; the loop's top ends it
    if ([...now.keys()].some((key) => now.get(key) === null)) continue;

    // Sleep until the next variable is due rather than for a fixed cycle, so
    // a 1-second widget and a 10-second one share one loop and one timer.
    //
    // A simulated room keeps its timer and touches no network (see read()).
    // Ending the loop instead would be cheaper and is not worth the hole it
    // leaves: a room switched out of mock in Admin would then have nothing
    // running to notice, and every screen watching it would stay simulated
    // until somebody reloaded.
    const soonest = Math.min(...[...now.keys()].map((key) => due.get(key) ?? 0));
    await idle(roomId, Math.max(MIN_GAP_MS, soonest - Date.now()), signal);
  }
}

function ensureLoop(roomId) {
  if (loops.has(roomId)) return;
  const ctl = new AbortController();
  loops.set(roomId, ctl);
  loop(roomId, ctl.signal)
    .catch(() => {})
    .finally(() => {
      if (loops.get(roomId) === ctl) loops.delete(roomId);
    });
}

function start(roomId, label, name) {
  if (!rooms[roomId]) return;
  let refs = watched.get(roomId);
  if (!refs) {
    refs = new Map();
    watched.set(roomId, refs);
  }
  if (!refs.has(refKey(label, name))) {
    if (refs.size >= MAX_PER_ROOM) return; // valid() refuses these; belt and braces
    refs.set(refKey(label, name), null);
    wakers.get(roomId)?.(); // a running loop reads it now, not next cycle
  }
  ensureLoop(roomId);
}

function stop(roomId, label, name) {
  const refs = watched.get(roomId);
  if (!refs) return;
  refs.delete(refKey(label, name));
  dueAt.get(roomId)?.delete(refKey(label, name));
  if (refs.size) return;
  watched.delete(roomId);
  dueAt.delete(roomId);
  loops.get(roomId)?.abort();
  loops.delete(roomId);
}

hub.registerTopic('room:*:var:*:*', {
  valid: (roomId, label, name) => {
    if (!rooms[roomId] || !NAME.test(label) || !NAME.test(name)) return false;
    const refs = watched.get(roomId);
    // Already watched is always valid — the cap bounds how many DISTINCT
    // variables a room polls, not how many browsers may watch them.
    return !refs || refs.has(refKey(label, name)) || refs.size < MAX_PER_ROOM;
  },
  start,
  stop,
  // Undefined until the first read lands, which tells the hub to send nothing
  // rather than paint a guess — the same contract as the mode topic.
  snapshot: (roomId, label, name) => watched.get(roomId)?.get(refKey(label, name)) ?? undefined,
});

/** Test hook: stop every loop and forget every watched variable. */
export function stopAll() {
  for (const ctl of loops.values()) ctl.abort();
  loops.clear();
  wakers.clear();
  dueAt.clear();
  watched.clear();
}
