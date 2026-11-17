// ─────────────────────────────────────────────────────────────────────────────
//  INTEGRATION: Planning Center Calendar  (read-only room bookings)
//
//  The authoritative event→room→time source (STATE.md roadmap item): what is
//  booked in which room, when. Same pattern as the Services client: auth →
//  fetch → normalize → cache, mock-first so the UI is demoable before the
//  Calendar product is granted to our token.
//
//  Auth: the same Personal Access Token as Services (products share the PAT;
//  Calendar just needs to be enabled for it).
//  Base:  https://api.planningcenteronline.com/calendar/v2
//
//  Field names were verified against a real (test) organization 2026-11-17 —
//  docs/INTEGRATION-NOTES.md, "Calendar — probed against a test organization".
//  The two things the first draft guessed wrong shape everything below:
//  an instance's `location` is free text (in practice a street address), so
//  rooms come from its resource bookings; and a church's resource names are
//  its own ("Auditorium"), not ours ("Main Auditorium"), so a room is BOUND to
//  resources by id in Admin (room.calendar.resources) rather than matched.
// ─────────────────────────────────────────────────────────────────────────────

import { getSecret } from '../secrets.js';
import { report } from '../health.js';
import { rooms } from '../roomsStore.js';

const BASE = 'https://api.planningcenteronline.com/calendar/v2';
const CACHE_TTL_MS = 5 * 60 * 1000; // bookings change more often than plans
const TIMEOUT_MS = 6000;

export function isConfigured() {
  return Boolean(getSecret('planningCenter.appId') && getSecret('planningCenter.secret'));
}

// ── tiny TTL cache ────────────────────────────────────────────────────────────
const cache = new Map(); // key → { expires, value }
async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expires) return hit.value;
  const value = await fn();
  cache.set(key, { expires: Date.now() + CACHE_TTL_MS, value });
  return value;
}
export function clearCache() {
  cache.clear();
}

// ── HTTP (real API) ───────────────────────────────────────────────────────────
async function calGet(path) {
  const auth = Buffer.from(
    `${getSecret('planningCenter.appId')}:${getSecret('planningCenter.secret')}`,
  ).toString('base64');
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const err = new Error(`PC Calendar ${path} → HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const body = await res.json();
    report('pcCalendar', true);
    return body;
  } catch (err) {
    report('pcCalendar', false, String(err.message ?? err));
    throw err;
  }
}

// ── Room matching ─────────────────────────────────────────────────────────────
// A booking names a Calendar resource by id; our rooms are keyed by their own
// ids. A room bound to that resource in Admin (room.calendar.resources) wins.
// An unbound resource falls back to an exact case-insensitive name match, but
// only to a name exactly one room has: two campuses each with a "Youth Room"
// is the ordinary case, and guessing between them is worse than not. And
// an instance with no room booked at all falls back to its location text —
// both conservative on purpose: a wrong match books an event into the wrong
// room's view, while an unmatched one still shows with the name it was booked
// under.
export function roomIdsFor(names) {
  const wanted = new Set(
    names.filter(Boolean).map((n) => String(n).trim().toLowerCase()),
  );
  if (!wanted.size) return [];
  return Object.values(rooms)
    .filter((r) => wanted.has(r.name.trim().toLowerCase()))
    .map((r) => r.id);
}

/** Rooms booked through these resources ({ id, name }), binding first. */
export function roomIdsForResources(resources) {
  const out = new Set();
  for (const res of resources) {
    const bound = Object.values(rooms)
      .filter((r) => r.calendar?.resources?.some((b) => String(b.id) === String(res.id)))
      .map((r) => r.id);
    const named = bound.length ? [] : roomIdsFor([res.name]);
    for (const id of bound.length ? bound : named.length === 1 ? named : []) out.add(id);
  }
  return [...out];
}

// ── Normalizer (JSON:API → our clean shape) ───────────────────────────────────
// eventsById: included Event resources keyed by id (approval lives on the
// Event). bookingsById: included ResourceBookings. resourcesById: the
// organization's resources, for names and kinds — a booking carries only an
// id, and an instance books projectors and tables as well as rooms.
export function normalizeInstance(data, eventsById = new Map(), bookingsById = new Map(), resourcesById = new Map()) {
  const a = data.attributes ?? {};
  const eventRef = data.relationships?.event?.data ?? null;
  const event = eventRef ? eventsById.get(eventRef.id) : null;
  const ea = event?.attributes ?? {};
  const location = a.location ?? null;
  const booked = [];
  for (const ref of data.relationships?.resource_bookings?.data ?? []) {
    const resId = bookingsById.get(ref.id)?.relationships?.resource?.data?.id;
    if (resId == null) continue;
    const res = resourcesById.get(String(resId));
    // An unknown kind is kept: a resource created since the list was cached
    // is more likely a room someone just added than a projector.
    if (res && res.kind !== 'Room') continue;
    if (!booked.some((b) => b.id === String(resId))) booked.push({ id: String(resId), name: res?.name ?? null });
  }
  return {
    id: data.id,
    eventId: eventRef?.id ?? null,
    name: a.name ?? ea.name ?? 'Event',
    startsAt: a.starts_at ?? null,
    endsAt: a.ends_at ?? null,
    allDay: Boolean(a.all_day_event),
    location,
    approval: ea.approval_status ?? null, // 'A' | 'P' | 'R'
    // Room names as Calendar knows them, for an event no dashboard room matches.
    booked: booked.map((b) => b.name).filter(Boolean),
    roomIds: booked.length ? roomIdsForResources(booked) : roomIdsFor([location]),
  };
}

// ── Mock (no credentials / Calendar not yet granted) ──────────────────────────
// A deterministic weekly booking pattern over whatever range is asked for, in
// the server's local timezone, against rooms that exist in the live map plus
// one deliberately-unmatched location (the "Special Events" mapping problem).
const WEEKLY = [
  { dow: 0, name: 'Sunday Services', location: 'Main Auditorium', start: [7, 30], end: [13, 0], approval: 'A' },
  { dow: 0, name: 'Youth Sunday', location: 'Youth Room', start: [8, 30], end: [12, 30], approval: 'A' },
  { dow: 2, name: 'Chapel Night', location: 'Chapel', start: [17, 30], end: [21, 0], approval: 'A' },
  { dow: 3, name: 'Youth Night', location: 'Youth Room', start: [17, 30], end: [21, 30], approval: 'A' },
  { dow: 4, name: 'Worship Rehearsal', location: 'Main Auditorium', start: [18, 0], end: [21, 30], approval: 'A' },
  { dow: 6, name: 'Memorial Service', location: 'Fellowship Hall', start: [10, 0], end: [12, 0], approval: 'P' },
];

function mockInstances(startMs, endMs) {
  const out = [];
  const day = new Date(startMs);
  day.setHours(0, 0, 0, 0);
  for (; day.getTime() < endMs; day.setDate(day.getDate() + 1)) {
    for (const w of WEEKLY) {
      if (day.getDay() !== w.dow) continue;
      const at = ([h, m]) => {
        const d = new Date(day);
        d.setHours(h, m, 0, 0);
        return d;
      };
      const starts = at(w.start);
      if (starts.getTime() < startMs || starts.getTime() >= endMs) continue;
      const ymd = starts.toISOString().slice(0, 10);
      out.push({
        id: `mock-${w.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${ymd}`,
        eventId: null,
        name: w.name,
        startsAt: starts.toISOString(),
        endsAt: at(w.end).toISOString(),
        allDay: false,
        location: w.location,
        approval: w.approval,
        booked: [],
        roomIds: roomIdsFor([w.location]),
        _mock: true,
      });
    }
  }
  return out;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Bookings in [startMs, endMs) → { live, reason?, events }.
 * Mock (labeled live:false) when there's no token OR the token exists but the
 * Calendar product isn't granted to it yet (401/403) — that's a setup state,
 * not an outage, and the UI stays demoable through it. Real transport/server
 * failures still throw so outages read as outages.
 */
export async function getCalendarData(startMs, endMs) {
  if (!isConfigured()) {
    return { live: false, reason: 'no-token', events: mockInstances(startMs, endMs) };
  }
  try {
    return { live: true, events: await getEventInstances(startMs, endMs) };
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      return { live: false, reason: 'not-granted', events: mockInstances(startMs, endMs) };
    }
    throw err;
  }
}

/** Every page of a collection path (relative to BASE). */
async function calGetAll(path) {
  const out = { data: [], included: [] };
  for (let next = path, pages = 0; next && pages < 50; pages += 1) {
    const body = await calGet(next);
    out.data.push(...(body.data ?? []));
    out.included.push(...(body.included ?? []));
    // links.next is absolute, with offset= added; strip the base and follow.
    next = body.links?.next ? body.links.next.replace(BASE, '') : null;
  }
  return out;
}

/** The organization's resources: { id, name, kind, folder }. */
export function listResources() {
  return cached('resources', async () => {
    const { data } = await calGetAll('/resources?per_page=100&order=name');
    return data.map((d) => ({
      id: String(d.id),
      name: d.attributes?.name ?? `Resource ${d.id}`,
      kind: d.attributes?.kind ?? null,
      // path_name is the folder the resource sits in — usually the campus.
      folder: d.attributes?.path_name ?? '',
    }));
  });
}

/** Room resources only, sorted by folder then name, for Admin's picker. */
export async function listRoomResources() {
  return (await listResources())
    .filter((r) => r.kind === 'Room')
    .sort((a, b) => a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name));
}

/** Real-API event instances overlapping [startMs, endMs), sorted by start. */
export function getEventInstances(startMs, endMs) {
  const key = `instances:${startMs}:${endMs}`;
  return cached(key, async () => {
    // Canceled instances are returned unless filtered out, flagged
    // canceled: true — and a canceled service must not hold its room.
    const [{ data, included }, resources] = await Promise.all([
      calGetAll(
        `/event_instances?include=event,resource_bookings&filter=not_canceled&order=starts_at&per_page=100` +
        `&where[starts_at][gte]=${new Date(startMs).toISOString()}` +
        `&where[starts_at][lt]=${new Date(endMs).toISOString()}`,
      ),
      // Names are a nicety for an unbound room; the bookings still list.
      listResources().catch(() => []),
    ]);
    const eventsById = new Map();
    const bookingsById = new Map();
    for (const inc of included) {
      if (inc.type === 'Event') eventsById.set(inc.id, inc);
      else if (inc.type === 'ResourceBooking') bookingsById.set(inc.id, inc);
    }
    const resourcesById = new Map(resources.map((r) => [r.id, r]));
    return data
      .filter((d) => !d.attributes?.canceled)
      .map((d) => normalizeInstance(d, eventsById, bookingsById, resourcesById))
      .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
  });
}
