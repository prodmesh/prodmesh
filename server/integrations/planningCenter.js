// ─────────────────────────────────────────────────────────────────────────────
//  INTEGRATION: Planning Center Services  (read-only plan display)
//
//  Pattern: auth → fetch → normalize → cache. Mock-first — with no credentials
//  configured it returns realistic sample plans so the UI is fully demoable;
//  drop a Personal Access Token into secrets.json and it goes live.
//
//  Auth: Personal Access Token (App ID + Secret) via HTTP Basic.
//  Base:  https://api.planningcenteronline.com/services/v2
//
//  NOTE: real-API field names (marked ⓘ) should be confirmed against live data
//  the first time a token is connected; the mock path exercises the same shapes.
// ─────────────────────────────────────────────────────────────────────────────

import { getSecret } from '../secrets.js';
import { report } from '../health.js';

const BASE = 'https://api.planningcenteronline.com/services/v2';
const CACHE_TTL_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 6000;

export function isConfigured() {
  return Boolean(getSecret('planningCenter.appId') && getSecret('planningCenter.secret'));
}

/**
 * Verify only the credential pair, without assuming this install already has a
 * room configured with a Services type. The former check fetched plans for the
 * first room type, so a perfectly valid new account was reported as rejected
 * whenever that type was stale, unavailable to the account, or simply absent.
 */
export async function checkCredentials() {
  if (!isConfigured()) return false;
  await pcGet('/service_types?per_page=1');
  return true;
}

// ── tiny TTL cache ────────────────────────────────────────────────────────────
const cache = new Map(); // key → { expires, value }
const CACHE_MAX = 200;

// Plan and person keys are bounded by the topology, but people-search keys are
// whatever someone types, so the map needs a ceiling. Expired entries go first;
// if that isn't enough, the oldest do (Map iterates in insertion order).
function prune() {
  const now = Date.now();
  for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
  for (const k of cache.keys()) {
    if (cache.size < CACHE_MAX) break;
    cache.delete(k);
  }
}

// Caches the PROMISE, not the resolved value, so callers that arrive while a
// fetch is in flight join it instead of starting their own. The people picker
// makes that concrete: it warms the roster as it mounts and then searches a
// moment later, which was two full roster fetches. Failures are evicted — a
// cached rejection would persist an outage for the whole TTL.
function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expires) return hit.value;
  const value = fn();
  if (cache.size >= CACHE_MAX) prune();
  cache.set(key, { expires: Date.now() + CACHE_TTL_MS, value });
  return value.catch((err) => {
    cache.delete(key);
    throw err;
  });
}
export function clearCache() {
  cache.clear();
}

// ── HTTP (real API) ───────────────────────────────────────────────────────────
//  The single place real requests happen — every caller guards with
//  isConfigured() and the TTL cache sits above, so health reflects actual
//  fetches only: mock mode and cache hits never report.
async function pcGet(path) {
  const auth = Buffer.from(`${getSecret('planningCenter.appId')}:${getSecret('planningCenter.secret')}`).toString('base64');
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Planning Center ${path} → HTTP ${res.status}`);
    const body = await res.json();
    report('planningCenter', true);
    return body;
  } catch (err) {
    report('planningCenter', false, String(err.message ?? err));
    throw err;
  }
}

async function pcPost(path, body = undefined) {
  const auth = Buffer.from(`${getSecret('planningCenter.appId')}:${getSecret('planningCenter.secret')}`).toString('base64');
  try {
    const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { Authorization: `Basic ${auth}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Planning Center ${path} → HTTP ${res.status}`);
    report('planningCenter', true);
    return res.status === 204 ? null : res.json().catch(() => null);
  } catch (err) { report('planningCenter', false, String(err.message ?? err)); throw err; }
}

// ── Normalizers (JSON:API → our clean shapes) — field names verified live ─────
function normalizePlan(serviceType, data) {
  const a = data.attributes ?? {};
  return {
    id: data.id,
    serviceTypeId: serviceType.id,
    serviceTypeName: serviceType.name,
    title: a.title || a.series_title || 'Service',
    seriesTitle: a.series_title ?? null,
    dates: a.dates ?? null, // human string, e.g. "July 5, 2026"
    sortDate: a.sort_date ?? null, // ISO
    times: [], // hydrated via getPlanTimes()
    items: [], // hydrated via getPlanItems()
  };
}

function normalizeTime(t) {
  const a = t.attributes ?? {};
  return { id: t.id, name: a.name ?? null, startsAt: a.starts_at ?? null, endsAt: a.ends_at ?? null, type: a.time_type ?? null };
}

function normalizeItem(it, notesById = new Map()) {
  const a = it.attributes ?? {};
  // "Leader" is a per-item note (category "Leader"), not a first-class field.
  let leader = null;
  for (const ref of it.relationships?.item_notes?.data ?? []) {
    const note = notesById.get(ref.id);
    if (note && String(note.category_name).toLowerCase() === 'leader') {
      leader = String(note.content ?? '').trim() || null;
      break;
    }
  }
  return {
    id: it.id,
    sequence: a.sequence ?? null,
    title: a.title ?? '',
    type: a.item_type ?? null, // e.g. "song", "header", "item"
    length: a.length ?? null, // seconds
    key: a.key_name || null, // song key, e.g. "D"
    leader,
    description: a.description ?? null,
  };
}

/**
 * Guard every id interpolated into a Planning Center path.
 *
 * PC ids are numeric. Anything else is a bug or an injection attempt: a planId
 * of "1/../../../people/v2/people?per_page=100" would otherwise reshape the
 * request — fetch normalizes the `..` segments — and reach the People API with
 * the church's PAT, returning congregant names, emails and addresses to a
 * caller who only holds shows.operate.
 *
 * Deliberately REJECTS rather than encodes. planIds are persisted (show
 * timelines, show_summaries) and replayed later by backfillLabels, so a value
 * poisoned before this guard existed must fail loudly rather than quietly
 * fetch the wrong resource. Callers already treat a throw as "plan unavailable".
 */
export function pcId(value, what) {
  const s = String(value ?? '');
  if (!/^[0-9]{1,20}$/.test(s)) throw new Error(`Invalid Planning Center ${what}`);
  return s;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Every service type this token can see, so an operator picks one instead of
 * digging a nine-digit id out of a Planning Center URL.
 *
 * `per_page=100` and no paging: a church has a handful of these — Sunday,
 * Midweek, Youth — and one that genuinely had more than a hundred would be a
 * different problem than this dropdown. An install with no token answers with
 * an empty list rather than throwing; it just types the id by hand, the way
 * the person picker falls back.
 *
 * Sorted here rather than with `order=name`. Planning Center's ordering
 * parameters differ per endpoint and this one is not something anybody has
 * confirmed against a real account — `/service_types` itself is proven, since
 * checkCredentials has always called it, so the query stays to what is known
 * to work and the sort happens where it cannot fail.
 */
export function listServiceTypes() {
  return cached('service-types', async () => {
    if (!isConfigured()) return [];
    const body = await pcGet('/service_types?per_page=100');
    return (body.data ?? [])
      .map((d) => ({ id: String(d.id), name: d.attributes?.name ?? `Service type ${d.id}` }))
      .filter((t) => /^[0-9]+$/.test(t.id))
      .sort((a, b) => a.name.localeCompare(b.name));
  });
}

/** Upcoming plans for a service type ({ id, name }). Summaries — times/items
 *  are hydrated separately (see getPlanTimes / getPlanItems). */
export function getUpcomingPlans(serviceType, limit = 3) {
  return cached(`plans:${serviceType.id}:${limit}`, async () => {
    if (!isConfigured()) return mockPlans(serviceType, limit);
    const body = await pcGet(`/service_types/${pcId(serviceType.id, 'service type id')}/plans?filter=future&order=sort_date&per_page=${Number(limit) || 3}`);
    return (body.data ?? []).map((d) => normalizePlan(serviceType, d));
  });
}

// We surface services + rehearsals; other time types (auditions, meetings,
// sound-checks tagged "other") are noise for this display.
const SHOWN_TIME_TYPES = new Set(['service', 'rehearsal']);

/** One plan fetched directly by id — works for PAST plans too, which the
 *  upcoming list can't see. Returns null when not live or the plan isn't in
 *  this service type (404). Used to backfill labels on old show timelines. */
export function getPlan(serviceType, planId) {
  return cached(`plan:${serviceType.id}:${planId}`, async () => {
    if (!isConfigured()) return null; // never fabricate labels for real history
    try {
      const body = await pcGet(`/service_types/${pcId(serviceType.id, 'service type id')}/plans/${pcId(planId, 'plan id')}`);
      return body?.data ? normalizePlan(serviceType, body.data) : null;
    } catch {
      return null;
    }
  });
}

/** A Services person profile for the signed-in prodmesh user. Services exposes
 * photo_thumbnail_url directly, so this does not require People-app access. */
export function normalizePersonId(personId) {
  return String(personId ?? '').trim().replace(/^P(?=\d+$)/i, '');
}

export function getPersonProfile(personId) {
  const normalizedId = normalizePersonId(personId);
  return cached(`person:${normalizedId}`, async () => {
    if (!isConfigured() || !normalizedId) return null;
    try {
      const body = await pcGet(`/people/${encodeURIComponent(normalizedId)}`);
      const data = body?.data;
      const a = data?.attributes ?? {};
      return data ? {
        id: data.id,
        name: a.full_name ?? a.name ?? null,
        avatarUrl: a.photo_thumbnail_url ?? null,
      } : null;
    } catch {
      return null;
    }
  });
}

// ── People search (linking a prodmesh account to a PC profile) ────────────────
//  Searches SERVICES people, not the People product. People holds the whole
//  congregation — addresses, birthdays, households; Services holds the team
//  that serves, which is the population that gets a prodmesh login. Staying in
//  Services also keeps ADR 0001's two-product ceiling intact.
//
//  Returns id, name and photo. Nothing else: the caller is picking a person,
//  not reading a contact card, so email and phone never cross the wire even
//  though the PC record carries them.

const PEOPLE_SEARCH_LIMIT = 8;
const MIN_QUERY_LENGTH = 2;
const PEOPLE_PAGE_SIZE = 100; // PC's per-page maximum
const PEOPLE_PAGE_CAP = 30; // 3000 people — a bound, not an expected limit

const normalizePerson = (d) => ({
  id: d.id,
  name: d.attributes?.full_name || d.attributes?.name || '',
  avatarUrl: d.attributes?.photo_thumbnail_url ?? null,
  // Still findable, just flagged: someone who stopped serving can still need a
  // login, and hiding them recreates "I can't find this person".
  inactive: Boolean(d.attributes?.archived_at) || d.attributes?.status === 'inactive',
});

/**
 * The whole Services roster, cached.
 *
 * Services /people IGNORES query filters — verified live 2026-07-29 against a
 * 139-person roster: where[search_name_or_email], where[first_name], ?q= and
 * ?search= all returned an identical total_count of 139. It answers a filtered
 * request with an unfiltered page and no error, so asking it to search reads
 * as "found some people, missing others" depending purely on who landed in the
 * first page. Searching therefore means holding the list ourselves.
 *
 * Cheap: 139 people is two requests in about a second, then a cache hit for
 * the next ten minutes. The page cap bounds a pathological roster rather than
 * a realistic one.
 */
export function getPeopleRoster() {
  return cached('people:roster', async () => {
    const people = [];
    let total = Infinity;
    for (let page = 0; page < PEOPLE_PAGE_CAP && people.length < total; page++) {
      const body = await pcGet(`/people?per_page=${PEOPLE_PAGE_SIZE}&offset=${people.length}`);
      const rows = body.data ?? [];
      if (!rows.length) break;
      total = body.meta?.total_count ?? people.length + rows.length;
      for (const row of rows) people.push(normalizePerson(row));
    }
    return people;
  });
}

/**
 * Never mocks — an unconfigured install returns nothing.
 *
 * The mock plans exist so the *display* is demoable; a fabricated person id is
 * a different thing entirely. It gets written into a user record and stays
 * there, so once a real token is connected that account would wear the photo
 * and identity of whoever genuinely owns that number.
 *
 * No part of the query is ever sent to Planning Center — the matching happens
 * here, over a list fetched with a fixed path.
 */
export async function searchPeople(query) {
  const q = String(query ?? '').trim();
  if (!isConfigured() || q.length < MIN_QUERY_LENGTH) return [];
  const roster = await getPeopleRoster();
  return roster
    .filter((person) => person.name && matchesName(person.name, q))
    .sort(byRelevance(q))
    .slice(0, PEOPLE_SEARCH_LIMIT);
}

/** Every word typed must appear: "ave h" finds Avery Hunt, not every Avery. */
function matchesName(name, query) {
  const haystack = name.toLowerCase();
  return query.toLowerCase().split(/\s+/).every((word) => haystack.includes(word));
}

/** Currently serving first, then the people whose name actually starts with
 *  what was typed — only eight rows show, so the order decides what's seen. */
function byRelevance(query) {
  const q = query.toLowerCase();
  const score = (p) => (p.inactive ? 2 : 0) + (p.name.toLowerCase().startsWith(q) ? 0 : 1);
  return (a, b) => score(a) - score(b) || a.name.localeCompare(b.name);
}

/** A plan's service + rehearsal times, chronological. (Auditions/meetings out.) */
export function getPlanTimes(serviceType, planId) {
  return cached(`times:${planId}`, async () => {
    if (!isConfigured()) return mockTimes();
    const body = await pcGet(`/service_types/${pcId(serviceType.id, 'service type id')}/plans/${pcId(planId, 'plan id')}/plan_times`);
    return (body.data ?? [])
      .filter((t) => SHOWN_TIME_TYPES.has(t.attributes?.time_type))
      .map(normalizeTime)
      .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
  });
}

/** The order-of-service items for one plan (with song key + leader note). */
export function getPlanItems(serviceType, planId) {
  return cached(`items:${planId}`, async () => {
    if (!isConfigured()) return mockItems();
    const body = await pcGet(
      `/service_types/${pcId(serviceType.id, 'service type id')}/plans/${pcId(planId, 'plan id')}/items?per_page=100&order=sequence&include=item_notes`,
    );
    const notesById = new Map(
      (body.included ?? []).filter((i) => i.type === 'ItemNote').map((n) => [n.id, n.attributes]),
    );
    return (body.data ?? []).map((d) => normalizeItem(d, notesById));
  });
}

/** Scheduled team members for a plan. Keep only operational assignment data;
 * contact details never leave Planning Center. */
export function getPlanTeamMembers(serviceType, planId) {
  return cached(`team-members:${planId}`, async () => {
    if (!isConfigured()) return mockTeamMembers();
    const body = await pcGet(`/service_types/${pcId(serviceType.id, 'service type id')}/plans/${pcId(planId, 'plan id')}/team_members?filter=not_declined&include=person,team&per_page=100`);
    const included = new Map((body.included ?? []).map((row) => [`${row.type}:${row.id}`, row]));
    return (body.data ?? []).map((row) => {
      const attrs = row.attributes ?? {};
      const teamRef = row.relationships?.team?.data ?? {};
      const personRef = row.relationships?.person?.data ?? {};
      const team = included.get(`${teamRef.type ?? 'Team'}:${teamRef.id}`)?.attributes ?? {};
      const person = included.get(`${personRef.type ?? 'Person'}:${personRef.id}`)?.attributes ?? {};
      return {
        id: row.id,
        name: attrs.name ?? person.full_name ?? person.name ?? 'Unassigned',
        position: attrs.team_position_name ?? 'Team member',
        teamId: teamRef.id ?? null,
        teamName: team.name ?? 'Team',
        status: attrs.status ?? null,
        photoUrl: person.photo_thumbnail_url ?? person.photo_url ?? attrs.photo_thumbnail ?? null,
      };
    });
  });
}

/** Read and advance Services LIVE. This is deliberately only called by the
 * explicit per-event automation setting, never by a passive dashboard view. */
export async function syncServicesLive(serviceType, planId, targetItemId) {
  if (!isConfigured()) throw new Error('Planning Center is not connected');
  const prefix = `/service_types/${pcId(serviceType.id, 'service type id')}/plans/${pcId(planId, 'plan id')}`;
  let body = await pcGet(`${prefix}/live?include=controller,current_item_time,next_item_time`);
  let live = Array.isArray(body.data) ? body.data[0] : body.data;
  if (!live) {
    await pcPost(`${prefix}/live`, { data: { type: 'Live' } });
    body = await pcGet(`${prefix}/live?include=controller,current_item_time,next_item_time`);
    live = Array.isArray(body.data) ? body.data[0] : body.data;
  }
  if (!live) throw new Error('Planning Center did not create a Services LIVE session');
  const links = live.links ?? {};
  const path = (name) => typeof links[name] === 'string' ? links[name].replace(BASE, '') : null;
  const controller = live.relationships?.controller?.data;
  if (!controller) {
    const take = path('toggle_control');
    if (!take) throw new Error('Planning Center did not allow Services LIVE control');
    await pcPost(take);
    return syncServicesLive(serviceType, planId, targetItemId);
  }
  const included = new Map((body.included ?? []).map((row) => [`${row.type}:${row.id}`, row]));
  const currentTimeRef = live.relationships?.current_item_time?.data;
  const currentTime = currentTimeRef ? included.get(`${currentTimeRef.type}:${currentTimeRef.id}`) : null;
  const currentItemId = currentTime?.relationships?.item?.data?.id ?? null;
  if (String(currentItemId) === String(targetItemId)) return { state: 'synced', itemId: targetItemId };
  // Item order is authoritative. Never move backward automatically: an
  // accidental PP selection must not rewind Services LIVE mid-service.
  const items = await getPlanItems(serviceType, planId);
  const at = items.findIndex((item) => String(item.id) === String(currentItemId));
  const target = items.findIndex((item) => String(item.id) === String(targetItemId));
  if (target < 0) throw new Error('Matched item is not in this Planning Center plan');
  const steps = at < 0 ? target + 1 : target - at;
  if (steps < 0) return { state: 'ahead', itemId: currentItemId };
  if (steps > 20) throw new Error('Services LIVE target is too far from the current item');
  const next = path('go_to_next_item');
  if (!next) throw new Error('Planning Center did not provide a next-item action');
  for (let i = 0; i < steps; i += 1) await pcPost(next);
  return { state: 'synced', itemId: targetItemId };
}

/** Series artwork + plan notes for the Event Detail page.
 *  Artwork lives on the plan's Series (verified live: `?include=series` →
 *  attributes.artwork_for_plan etc.); notes are the plan-level category notes. */
export function getPlanDetail(serviceType, planId) {
  return cached(`detail:${planId}`, async () => {
    if (!isConfigured()) return mockDetail();
    const [planBody, notesBody] = await Promise.all([
      pcGet(`/service_types/${pcId(serviceType.id, 'service type id')}/plans/${pcId(planId, 'plan id')}?include=series`),
      pcGet(`/service_types/${pcId(serviceType.id, 'service type id')}/plans/${pcId(planId, 'plan id')}/notes`),
    ]);
    const series = (planBody.included ?? []).find((i) => i.type === 'Series');
    const sa = series?.attributes ?? {};
    return {
      artwork: sa.has_artwork ? sa.artwork_for_plan || sa.artwork_for_dashboard || null : null,
      notes: (notesBody.data ?? [])
        .map((n) => ({
          category: n.attributes?.category_name ?? null,
          content: String(n.attributes?.content ?? '').trim(),
        }))
        .filter((n) => n.content),
    };
  });
}

// ── Mock data (used until a token is configured) ──────────────────────────────
function nextSunday(offsetWeeks = 0) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + ((7 - d.getDay()) % 7) + offsetWeeks * 7);
  return d;
}

function mockPlans(serviceType, limit) {
  return Array.from({ length: limit }, (_, i) => {
    const day = nextSunday(i);
    return {
      id: `mock-${serviceType.id}-${i}`,
      serviceTypeId: serviceType.id,
      serviceTypeName: serviceType.name,
      title: 'Weekend Service',
      seriesTitle: 'Summer in the Psalms',
      dates: day.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }),
      sortDate: day.toISOString(),
      times: [],
      items: [],
      _mock: true,
    };
  });
}

function mockTimes() {
  const day = nextSunday(0);
  const at = (h) => {
    const t = new Date(day);
    t.setHours(h, 0, 0, 0);
    return t.toISOString();
  };
  return [
    { id: 'reh-1', name: 'Run Through', startsAt: at(8), endsAt: at(9), type: 'rehearsal' },
    { id: 'svc-1', name: '1st Service', startsAt: at(9), endsAt: at(10), type: 'service' },
    { id: 'svc-2', name: '2nd Service', startsAt: at(11), endsAt: at(12), type: 'service' },
  ];
}

function mockItems() {
  const rows = [
    { title: 'Countdown', type: 'media', length: 300 },
    { title: 'Welcome', type: 'header' },
    { title: 'Announcements', type: 'item', length: 180, leader: 'Pastor Dave' },
    { title: 'Worship Set', type: 'header' },
    { title: 'Praise', type: 'song', length: 300, key: 'G', leader: 'Avery' },
    { title: 'Great Are You Lord', type: 'song', length: 330, key: 'A', leader: 'Riley' },
    { title: 'Message', type: 'header' },
    { title: 'Sermon', type: 'item', length: 1800, leader: 'Pastor Dave' },
    { title: 'Response Song', type: 'song', length: 300, key: 'D', leader: 'Avery' },
    { title: 'Dismissal', type: 'header' },
  ];
  return rows.map((r, i) => ({
    id: `mock-item-${i}`,
    sequence: i + 1,
    title: r.title,
    type: r.type,
    length: r.length ?? null,
    key: r.key ?? null,
    leader: r.leader ?? null,
    description: null,
  }));
}

function mockTeamMembers() {
  return [
    { id: 'mock-team-1', name: 'Avery', position: 'Worship Leader', teamId: 'band', teamName: 'Band', status: 'Confirmed', photoUrl: null },
    { id: 'mock-team-2', name: 'Riley', position: 'Guitar', teamId: 'band', teamName: 'Band', status: 'Confirmed', photoUrl: null },
    { id: 'mock-team-3', name: 'Pastor Dave', position: 'Speaker', teamId: 'speaking', teamName: 'Speaking', status: 'Confirmed', photoUrl: null },
  ];
}

function mockDetail() {
  return {
    artwork: null,
    notes: [
      { category: 'Production', content: 'Confetti drop during the final song — cue from FOH.' },
      { category: 'Video', content: 'Baptism video rolls right after announcements.' },
    ],
  };
}
