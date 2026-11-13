// ─────────────────────────────────────────────────────────────────────────────
//  DIGESTS  —  a small live summary of every room we run (ADR 0018).
//
//  Serving side. A peer asks for /federation/v1/digest every few seconds while
//  someone at that campus has All Campuses open. The answer has to come back
//  at once — no request here waits on a device (ADR 0016) — so it is read
//  from values already held, never probed on demand.
//
//  Those values come from the same watchers a browser here would start: room
//  mode and room health are refcounted topics that only poll while someone
//  subscribes. So a digest request takes a LEASE, and while the lease is live
//  this module holds an internal subscription to each room's mode and health
//  topics. When the peer stops asking, the lease lapses, the subscription is
//  dropped and the watchers stop — idle federation costs a heartbeat, not a
//  stream, at both ends.
//
//  The first answer after a lease starts therefore has nulls where nothing
//  has been read yet. That is the truth and it is said as such: every value
//  carries the time it was observed, and an unobserved one is null.
//
//  Receiving side: validateDigest, rebuilding a peer's answer field by field.
// ─────────────────────────────────────────────────────────────────────────────

import * as hub from '../streamHub.js';
import { rooms } from '../roomsStore.js';
import * as modeWatcher from '../roomStateWatcher.js';
import * as healthWatcher from '../roomHealth.js';
import * as show from '../showManager.js';
import * as pco from '../integrations/planningCenter.js';
import { stOf, upcomingForRoom } from '../roomService.js';
import { localDirectory, localRoomIds } from './directory.js';

const LEASE_MS = 45_000;
const NEXT_REFRESH_MS = 60_000;
const SWEEP_MS = 10_000;

// ── Serving: the lease ───────────────────────────────────────────────────────

// The internal subscriber. The hub keys subscribers by object identity and
// calls our sink instead of writing, so a plain object stands in for a
// response. The values themselves are read from the watchers, which keep
// their own last value and its observation time.
const holder = { federationDigest: true };
let heldTopics = '';
let leaseUntil = 0;
let sweep = null;
let nextTimer = null;
const nextEvents = new Map(); // roomId -> { title, dates, at, observedAt } | null

function hold(roomIds) {
  const topics = roomIds.flatMap((id) => [modeWatcher.modeTopic(id), healthWatcher.healthTopic(id)]);
  const key = topics.join(',');
  if (key === heldTopics) return;
  // A topology change between requests: drop and retake, so a deleted room's
  // watcher stops and a new room's starts.
  hub.unsubscribe(holder);
  heldTopics = key;
  hub.subscribe(holder, topics, () => {});
}

function release() {
  hub.unsubscribe(holder);
  heldTopics = '';
  clearInterval(sweep);
  clearInterval(nextTimer);
  sweep = null;
  nextTimer = null;
  nextEvents.clear();
}

/** First service time still ahead, else the last one (mid-service) — the
 *  same choice a room card makes, so both campuses show the same "next". */
function pickTime(times) {
  const svc = (times ?? []).filter((t) => t.type === 'service' && t.startsAt);
  const t = svc.find((x) => new Date(x.startsAt).getTime() > Date.now()) ?? svc[svc.length - 1] ?? null;
  return t ? new Date(t.startsAt).getTime() : null;
}

async function refreshNextEvents(roomIds) {
  await Promise.all(roomIds.map(async (id) => {
    const room = rooms[id];
    if (!room?.planningCenter?.serviceTypes?.length) { nextEvents.set(id, null); return; }
    try {
      const [plan] = await upcomingForRoom(room.planningCenter, 1);
      if (!plan) { nextEvents.set(id, { title: null, dates: null, at: null, observedAt: Date.now() }); return; }
      const times = await pco.getPlanTimes(stOf(plan), plan.id);
      nextEvents.set(id, { title: plan.title ?? null, dates: plan.dates ?? null, at: pickTime(times), observedAt: Date.now() });
    } catch {
      // Keep the last good answer and its (aging) observation time.
    }
  }));
}

function touch(roomIds) {
  leaseUntil = Date.now() + LEASE_MS;
  hold(roomIds);
  if (!sweep) {
    sweep = setInterval(() => { if (Date.now() > leaseUntil) release(); }, SWEEP_MS);
    sweep.unref?.();
    nextTimer = setInterval(() => { refreshNextEvents(localRoomIds()).catch(() => {}); }, NEXT_REFRESH_MS);
    nextTimer.unref?.();
    refreshNextEvents(roomIds).catch(() => {});
  }
}

function roomDigest(id) {
  const room = rooms[id];
  if (!room) return null;
  const out = {};
  if (room.roomMode !== false) {
    const state = modeWatcher.current(id);
    const mode = state ? room.modes.find((m) => m.id === state.mode) : null;
    out.mode = {
      id: state?.mode ?? null,
      label: mode?.label ?? null,
      color: mode?.color ?? null,
      online: state ? Boolean(state.online) : null,
      locked: state ? Boolean(state.protection?.active) : null,
      observedAt: modeWatcher.observedAt(id),
    };
  }
  // The show is in memory and always current: it is the show manager's own
  // state, not a reading of a device.
  const s = show.getState(id);
  out.show = { active: Boolean(s.active), startedAt: s.active ? s.startedAt ?? null : null, observedAt: Date.now() };
  const health = healthWatcher.current(id);
  out.health = {
    integrations: (health?.integrations ?? []).map((d) => ({ id: d.id, label: d.label, state: d.state })),
    observedAt: healthWatcher.observedAt(id),
  };
  if (nextEvents.has(id)) out.next = nextEvents.get(id);
  return out;
}

/** The answer to /federation/v1/digest. Never waits on anything. */
export function localDigest() {
  const dir = localDirectory();
  const ids = localRoomIds(dir);
  touch(ids);
  const out = {};
  for (const id of ids) {
    const d = roomDigest(id);
    if (d) out[id] = d;
  }
  return { revision: dir.revision, generatedAt: Date.now(), rooms: out };
}

/** Test hook. */
export const stopServing = release;

// ── Receiving: a peer's digest, rebuilt ──────────────────────────────────────

const MAX_TEXT = 80;
const MAX_DOTS = 12;
const HEX_COLOR = /^#[0-9A-Fa-f]{3,8}$/;
const DOT_STATES = new Set(['ok', 'down', 'mock', 'unknown']);

const text = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, MAX_TEXT) : null);
const bool = (v) => (typeof v === 'boolean' ? v : null);

/** A timestamp within a day either side of now, or null. A peer's clock can be
 *  off; one that claims a reading from 1970 or next year is not believed. */
function when(v, now) {
  return Number.isFinite(v) && Math.abs(v - now) < 24 * 60 * 60 * 1000 ? v : null;
}
/** A planned time may be weeks out; only absurd ones are dropped. */
function future(v, now) {
  return Number.isFinite(v) && Math.abs(v - now) < 400 * 24 * 60 * 60 * 1000 ? v : null;
}

/**
 * Keep only rooms the peer's directory names, and only known fields of them.
 * Strings are capped, colours must be colours (they are put in a style
 * attribute), timestamps must be plausible. Never throws on a room; throws
 * only when the whole thing is not a digest.
 */
export function validateDigest(body, knownRoomIds, now = Date.now()) {
  if (!body || typeof body !== 'object' || !body.rooms || typeof body.rooms !== 'object') {
    throw new Error('not a digest');
  }
  const out = {};
  for (const id of knownRoomIds) {
    const r = body.rooms[id];
    if (!r || typeof r !== 'object') continue;
    const room = {};
    if (r.mode && typeof r.mode === 'object') {
      room.mode = {
        id: text(r.mode.id),
        label: text(r.mode.label),
        color: typeof r.mode.color === 'string' && HEX_COLOR.test(r.mode.color) ? r.mode.color : null,
        online: bool(r.mode.online),
        locked: bool(r.mode.locked),
        observedAt: when(r.mode.observedAt, now),
      };
    }
    if (r.show && typeof r.show === 'object') {
      room.show = { active: r.show.active === true, startedAt: when(r.show.startedAt, now), observedAt: when(r.show.observedAt, now) };
    }
    if (r.health && typeof r.health === 'object') {
      room.health = {
        integrations: (Array.isArray(r.health.integrations) ? r.health.integrations : [])
          .slice(0, MAX_DOTS)
          .filter((d) => d && text(d.id) && DOT_STATES.has(d.state))
          .map((d) => ({ id: text(d.id), label: text(d.label) ?? text(d.id), state: d.state })),
        observedAt: when(r.health.observedAt, now),
      };
    }
    if (r.next === null) room.next = null;
    else if (r.next && typeof r.next === 'object') {
      room.next = { title: text(r.next.title), dates: text(r.next.dates), at: future(r.next.at, now), observedAt: when(r.next.observedAt, now) };
    }
    out[id] = room;
  }
  return {
    revision: typeof body.revision === 'string' ? body.revision.slice(0, 64) : null,
    generatedAt: when(body.generatedAt, now),
    rooms: out,
  };
}
