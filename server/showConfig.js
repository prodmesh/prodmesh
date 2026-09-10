// ─────────────────────────────────────────────────────────────────────────────
//  SHOW CONFIG  —  per-event automation settings (Event Detail → Show Config).
//
//  config = {
//    startItemId: '<pc item id>' | null,  // PP lands on this item → show starts
//    endItemId:   '<pc item id>' | null,  // last slide of this item → show ends
//    map: { '<pc item id>': { ppIndex, ppName } }  // manual PC→PP overrides
//    videos: { '<time id>': '<video id>' | null }   // per service, tri-state
//    servicesLiveFromProPresenter: bool             // the show drives Services LIVE
//  }
//
//  Keyed per (roomId, planId) — per EVENT, not per service time: the 9:00 and
//  11:00 share one config, autostart picks the right time by the clock.
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
 * A service-TIME trigger cannot be promoted — autostart is keyed on a
 * ProPresenter item, and there is no item to promote it to. Such an event keeps
 * the checkbox and starts Services LIVE whenever its show starts, which for it
 * now means whenever somebody presses Start.
 */
export function promoteLegacyServicesLive(config) {
  if (!config || typeof config !== 'object') return config;
  const { servicesLiveStartMode, servicesLiveStartItemId, servicesLiveStartTimeId, ...rest } = config;
  if (
    !rest.startItemId
    && rest.servicesLiveFromProPresenter
    && servicesLiveStartMode !== 'service-time'
    && servicesLiveStartItemId
  ) {
    return { ...rest, startItemId: servicesLiveStartItemId };
  }
  return rest;
}

export function getConfig(roomId, planId) {
  const row = getDb()
    .prepare('SELECT config FROM show_config WHERE room_id = ? AND plan_id = ?')
    .get(roomId, planId);
  if (!row) return null;
  try {
    return promoteLegacyServicesLive(JSON.parse(row.config));
  } catch {
    return null;
  }
}

/** Validate + save. Throws on bad shape — callers map that to HTTP 400. */
export function setConfig(roomId, planId, config, nowMs = Date.now()) {
  const clean = validate(config);
  getDb()
    .prepare(
      `INSERT INTO show_config (room_id, plan_id, config, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (room_id, plan_id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`,
    )
    .run(roomId, planId, JSON.stringify(clean), nowMs);
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

  return {
    startItemId: id(config.startItemId, 'startItemId'),
    endItemId: id(config.endItemId, 'endItemId'),
    map,
    videos,
    // Services LIVE follows the show: control is taken when it starts and let
    // go when it ends. It has no start condition of its own any more — see
    // promoteLegacyServicesLive for what became of the ones stored before.
    servicesLiveFromProPresenter: Boolean(config.servicesLiveFromProPresenter),
  };
}
