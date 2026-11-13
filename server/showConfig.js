// ─────────────────────────────────────────────────────────────────────────────
//  SHOW CONFIG  —  per-event automation settings (Event Detail → Show Config).
//
//  config = {
//    startItemId: '<pc item id>' | null,  // PP lands on this item → show starts
//    startAtScheduledTime: bool,          // …or each service time starts on the clock
//    endItemId:   '<pc item id>' | null,  // last slide of this item → show ends
//    map: { '<pc item id>': { ppIndex, ppName } }  // manual PC→PP overrides
//    videos: { '<time id>': '<video id>' | null }   // per service, tri-state
//    servicesLiveFromProPresenter: bool             // the show drives Services LIVE
//  }
//
//  Keyed per (roomId, planId) — per EVENT, not per service time: the 9:00 and
//  11:00 share one config, autostart picks the right time by the clock.
//
//  SERVICE TYPE DEFAULTS (#58). How a show starts and ends, and whether it
//  drives Services LIVE, is usually the same every week for one service type,
//  so it can be saved once per (room, service type) and every event of that
//  type inherits it. An event's own setting still wins, field by field: the
//  per-event record stays the place for what is particular to one Sunday.
//
//  A default names items by TITLE, not id. Planning Center gives every plan's
//  items new ids, so "Countdown" this week and "Countdown" next week share
//  nothing but the words; an id saved as a default would match nothing ever
//  again. Resolution picks the first non-header item with that title, ignoring
//  case and surrounding space. No match means no automation for that field, and
//  the widget says so — a renamed item must not start a show somewhere else.
//
//  Per room as well as per type: a service type that runs in two rooms (main
//  and overflow) should not have both driving Services LIVE.
//
//  How an event's record says "inherit": from v2, a field group that is
//  ABSENT inherits and one that is PRESENT overrides, null included — so
//  "Never" on one event can beat a default. Records written before v2 stored
//  every field, with null/false meaning "nothing set"; for them null/false
//  reads as absent. Before any default exists that is the same behaviour, and
//  afterwards it is what was meant: nobody chose "never" over a default that
//  did not exist yet.
//
//  `videos` is the exception, and deliberately so: a channel pre-creates one
//  broadcast per service, so 8:00 and 9:30 are DIFFERENT videos on the same
//  plan. It lives here rather than on the room for exactly that reason — a
//  room-level pin would attribute both services to one broadcast and report
//  the same numbers twice.
//
//  Three states per service time, and the distinction between the first two
//  is load-bearing:
//    key ABSENT  → auto: record whatever is live on the channel
//    value null  → NOT STREAMED: record nothing, and don't even look
//    value '<id>' → pinned to that broadcast
//
//  "Not streamed" is not the same as "nothing pinned". A plan often has five
//  service times of which two are broadcast; on auto, the other three would
//  happily record a stream that was left running from an earlier service and
//  attribute those viewers to a service nobody watched online. Explicit null
//  also means the watcher never starts, so no YouTube quota is spent looking
//  for a broadcast that was never going to exist.
// ─────────────────────────────────────────────────────────────────────────────

import { getDb } from './db.js';

/**
 * Services LIVE used to carry its own start condition — a trigger item, or a
 * service time — separate from the item that autostarts the show. That split is
 * gone: Services LIVE now follows the show, taking control when it starts and
 * letting go when it ends. A config saved under the old model with a Services
 * LIVE trigger but no autostart item would otherwise stop starting Services
 * LIVE at all, so its trigger is promoted to the autostart item.
 *
 * Applied on READ as well as on save, because getConfig returns stored JSON as
 * it is, and installs in the field hold rows written before this change that
 * nobody will re-save until they happen to open the event.
 *
 * Only while "ProPresenter controls Services LIVE" is on: a trigger left behind
 * after the box was unticked is not a request to autostart anything.
 *
 * A service-TIME trigger becomes a scheduled-time start. Not quite the same
 * thing: the old trigger named one service time and kept Services LIVE running
 * from then on, where the show starts at every service time of the event. Each
 * of those shows takes Services LIVE with it, so the room ends up in the same
 * place.
 */
export function promoteLegacyServicesLive(config) {
  if (!config || typeof config !== 'object') return config;
  const { servicesLiveStartMode, servicesLiveStartItemId, servicesLiveStartTimeId, ...rest } = config;
  if (rest.startItemId || rest.startAtScheduledTime || !rest.servicesLiveFromProPresenter) return rest;
  if (servicesLiveStartMode === 'service-time') {
    return servicesLiveStartTimeId ? { ...rest, startAtScheduledTime: true } : rest;
  }
  return servicesLiveStartItemId ? { ...rest, startItemId: servicesLiveStartItemId } : rest;
}

/** The event's own record: only the fields it overrides, plus map/videos. */
export function getConfig(roomId, planId) {
  const row = getDb()
    .prepare('SELECT config FROM show_config WHERE room_id = ? AND plan_id = ?')
    .get(roomId, planId);
  if (!row) return null;
  try {
    return fromStored(promoteLegacyServicesLive(JSON.parse(row.config)));
  } catch {
    return null;
  }
}

/** A stored record as overrides: see the header for v1 vs v2. */
function fromStored(stored) {
  const { v, ...config } = stored;
  if (v === 2) return config;
  const out = { map: config.map ?? {}, videos: config.videos ?? {} };
  if (config.startItemId || config.startAtScheduledTime) {
    out.startItemId = config.startAtScheduledTime ? null : config.startItemId;
    out.startAtScheduledTime = Boolean(config.startAtScheduledTime);
  }
  if (config.endItemId) out.endItemId = config.endItemId;
  if (config.servicesLiveFromProPresenter) out.servicesLiveFromProPresenter = true;
  return out;
}

/** Validate + save. Throws on bad shape — callers map that to HTTP 400. */
export function setConfig(roomId, planId, config, nowMs = Date.now()) {
  const clean = validate(config);
  getDb()
    .prepare(
      `INSERT INTO show_config (room_id, plan_id, config, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (room_id, plan_id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`,
    )
    .run(roomId, planId, JSON.stringify({ v: 2, ...clean }), nowMs);
  return clean;
}

export function clearConfig(roomId, planId) {
  getDb().prepare('DELETE FROM show_config WHERE room_id = ? AND plan_id = ?').run(roomId, planId);
}

function validate(input) {
  if (input == null || typeof input !== 'object') throw new Error('config must be an object');
  // An older client can still post the retired start fields.
  const config = promoteLegacyServicesLive(input);
  const id = (v, name) => {
    if (v == null || v === '') return null;
    if (typeof v !== 'string') throw new Error(`${name} must be an item id`);
    return v;
  };
  const map = {};
  if (config.map != null) {
    if (typeof config.map !== 'object') throw new Error('map must be an object');
    for (const [pcId, pp] of Object.entries(config.map)) {
      if (pp == null) continue; // "Auto" — no override
      // Explicitly un-mapped: this Planning Center item has no corresponding
      // ProPresenter presentation, so it must not fall back to order matching.
      if (pp.disabled === true) {
        map[pcId] = { disabled: true };
        continue;
      }
      if (!Number.isInteger(pp.ppIndex) || pp.ppIndex < 0) {
        throw new Error('map values need an integer ppIndex');
      }
      map[pcId] = { ppIndex: pp.ppIndex, ppName: typeof pp.ppName === 'string' ? pp.ppName : null };
    }
  }
  // Per-service broadcast. null is MEANINGFUL (not streamed) and is kept;
  // '' and undefined mean "auto" and are dropped, so only non-default states
  // are stored. Ids are charset-checked because the value is interpolated into
  // a YouTube request URL — same reasoning as validateHost.
  const videos = {};
  if (config.videos != null) {
    if (typeof config.videos !== 'object') throw new Error('videos must be an object');
    for (const [timeId, videoId] of Object.entries(config.videos)) {
      if (videoId === null) {
        videos[timeId] = null; // explicitly not streamed
        continue;
      }
      if (videoId === undefined || videoId === '') continue; // "Auto" — find what's live
      if (typeof videoId !== 'string' || videoId.length > 32 || !/^[A-Za-z0-9_-]+$/.test(videoId)) {
        throw new Error(`"${timeId}" needs a YouTube video id (letters, digits, - and _ only)`);
      }
      videos[timeId] = videoId;
    }
  }

  // Each group is stored only when the client sent it: absent inherits the
  // service type default (#58), present — null included — overrides it.
  const out = { map, videos };
  if ('startItemId' in config || 'startAtScheduledTime' in config) {
    // One way to start, not two. The UI offers both in a single dropdown; a
    // client that sends both anyway gets the clock, which is the one it chose
    // deliberately — an item id could be left over from before the switch.
    const startAtScheduledTime = Boolean(config.startAtScheduledTime);
    out.startItemId = startAtScheduledTime ? null : id(config.startItemId, 'startItemId');
    out.startAtScheduledTime = startAtScheduledTime;
  }
  if ('endItemId' in config) out.endItemId = id(config.endItemId, 'endItemId');
  // Services LIVE follows the show: control is taken when it starts and let
  // go when it ends. It has no start condition of its own any more — see
  // promoteLegacyServicesLive for what became of the ones stored before.
  if ('servicesLiveFromProPresenter' in config && config.servicesLiveFromProPresenter != null) {
    out.servicesLiveFromProPresenter = Boolean(config.servicesLiveFromProPresenter);
  }
  return out;
}

// ── Service type defaults (#58) ──────────────────────────────────────────────

const title = (v, name) => {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || v.trim().length === 0 || v.length > 200) throw new Error(`${name} must be an item title`);
  return v.trim();
};

/** A room's default for one service type, or null. */
export function getTypeDefault(roomId, serviceTypeId) {
  if (!serviceTypeId) return null;
  const row = getDb()
    .prepare('SELECT config FROM show_config_defaults WHERE room_id = ? AND service_type_id = ?')
    .get(roomId, String(serviceTypeId));
  if (!row) return null;
  try { return JSON.parse(row.config); } catch { return null; }
}

export function setTypeDefault(roomId, serviceTypeId, input, nowMs = Date.now()) {
  if (!serviceTypeId) throw new Error('serviceTypeId is required');
  if (input == null || typeof input !== 'object') throw new Error('default must be an object');
  const startAtScheduledTime = Boolean(input.startAtScheduledTime);
  const clean = {
    startItemTitle: startAtScheduledTime ? null : title(input.startItemTitle, 'startItemTitle'),
    startAtScheduledTime,
    endItemTitle: title(input.endItemTitle, 'endItemTitle'),
    servicesLiveFromProPresenter: Boolean(input.servicesLiveFromProPresenter),
  };
  getDb()
    .prepare(
      `INSERT INTO show_config_defaults (room_id, service_type_id, config, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (room_id, service_type_id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`,
    )
    .run(roomId, String(serviceTypeId), JSON.stringify(clean), nowMs);
  return clean;
}

export function clearTypeDefault(roomId, serviceTypeId) {
  getDb().prepare('DELETE FROM show_config_defaults WHERE room_id = ? AND service_type_id = ?').run(roomId, String(serviceTypeId));
}

const norm = (s) => String(s ?? '').trim().toLowerCase();

/** This plan's item carrying a default's title: first non-header match. */
export function itemByTitle(items, wanted) {
  if (!wanted) return null;
  return (items ?? []).find((i) => (i.type ?? 'item') !== 'header' && norm(i.title) === norm(wanted)) ?? null;
}

/**
 * Could this event autostart at all, before its items are fetched? Lets the
 * autostart watcher skip Planning Center calls for events that never will.
 */
export function mayAutostart(roomId, planId, serviceTypeId) {
  const own = getConfig(roomId, planId);
  if (own && 'startAtScheduledTime' in own) return Boolean(own.startItemId || own.startAtScheduledTime);
  const def = getTypeDefault(roomId, serviceTypeId);
  return Boolean(def?.startItemTitle || def?.startAtScheduledTime);
}

/**
 * What actually runs for this event: its own overrides on top of its service
 * type's default, with default titles resolved to this plan's item ids. The
 * same shape the show has always read, so nothing downstream needs to know
 * where a field came from. Null when neither exists.
 */
export function effectiveConfig(roomId, planId, serviceTypeId, items) {
  const own = getConfig(roomId, planId);
  const def = getTypeDefault(roomId, serviceTypeId);
  if (!own && !def) return null;
  const o = own ?? {};
  const fromDefault = !('startAtScheduledTime' in o);
  return {
    startItemId: fromDefault
      ? (def?.startAtScheduledTime ? null : itemByTitle(items, def?.startItemTitle)?.id ?? null)
      : o.startItemId ?? null,
    startAtScheduledTime: fromDefault ? Boolean(def?.startAtScheduledTime) : Boolean(o.startAtScheduledTime),
    endItemId: 'endItemId' in o ? o.endItemId ?? null : itemByTitle(items, def?.endItemTitle)?.id ?? null,
    servicesLiveFromProPresenter: 'servicesLiveFromProPresenter' in o
      ? Boolean(o.servicesLiveFromProPresenter)
      : Boolean(def?.servicesLiveFromProPresenter),
    map: o.map ?? {},
    videos: o.videos ?? {},
  };
}
