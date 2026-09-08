// ─────────────────────────────────────────────────────────────────────────────
//  ROOM CONNECTIVITY  —  per-room integration config migrating out of
//  rooms.config.js and into SQLite (ADR 0009), one integration at a time.
//
//  Migrated so far:
//    planningCenter — which PC service types feed the room
//    analysis       — SPL source (Smaart, ProdMesh Remote RTA, or OSM) + dB goals
//    proPresenter   — the room's ProPresenter API (host/port, optional timer)
//    companion      — Companion host/port + state variable + the room's MODES
//                     (stored as one blob; applied onto the legacy room keys
//                     `companion`/`state`/`mock`/`modes` so consumers never
//                     change; never cleared — "no Companion" is mock:true)
//
//  On first boot each integration seeds from what rooms.config.js declares;
//  after that the database owns it and the file entry is only a fresh-install
//  seed. Seeding is per-integration, so deployments that predate a migration
//  adopt their file config the first time they boot with it.
//
//  Live propagation: every consumer (event endpoints, show manager, autostart)
//  reads `room.<integration>` off the shared in-memory rooms map, so
//  applyConnectivity() assigns the stored values onto those room objects —
//  edits take effect immediately, no restart, no consumer changes. The
//  exception is long-lived watchers (SPL, PP timer, an active show's poller):
//  they capture the config object when they start, so the setters also notify
//  onConnectivityChange listeners, which restart any affected watcher.
// ─────────────────────────────────────────────────────────────────────────────
import { getDb } from './db.js';
import { rooms } from './roomsStore.js';
import { SOURCES } from './integrations/analysis.js';
import * as captions from './integrations/captions.js';

const PC = 'planningCenter';
const ANALYSIS = 'analysis';
const PP = 'proPresenter';
const COMPANION = 'companion';
const YOUTUBE = 'youtube';
const CAPTIONS = 'captions';
const OBS = 'obs';
const INTEGRATIONS = [PC, ANALYSIS, PP, COMPANION, YOUTUBE, CAPTIONS, OBS];

// Long-lived per-room work (the show manager's watchers) registers here to be
// restarted when a room's config changes — applyConnectivity() alone can't
// reach config objects captured at watcher start.
const changeListeners = new Set();
export function onConnectivityChange(fn) {
  changeListeners.add(fn);
}
function notifyChange(roomId, integration) {
  for (const fn of changeListeners) fn(roomId, integration);
}

/**
 * A device address must be a bare hostname or IP — nothing that can reshape
 * the URL it gets interpolated into.
 *
 * Every integration builds `http://${host}:${port}` and appends a fixed path.
 * With only a length check, a trailing `#` made that appended path a fragment
 * and handed the operator the whole URL — so `config.manage` became an
 * authenticated read-anything primitive, with the response body echoed back
 * through the Companion status chip. `/`, `?`, `#`, `@` and `:` are the
 * characters that make that possible, so none of them survive.
 */
function validateHost(input, what) {
  const host = String(input ?? '').trim();
  if (!host || host.length > 100) throw new Error(`${what} (max 100 characters)`);
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host; // IPv6 literal
  const ok = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/i.test(bare) || /^[0-9a-f:.]+$/i.test(bare);
  if (!ok) throw new Error(`${what} must be a hostname or IP address, with no path, port, or credentials`);
  return host;
}

export function validateServiceTypes(input) {
  if (!Array.isArray(input)) throw new Error('serviceTypes must be an array');
  if (input.length > 10) throw new Error('Too many service types (max 10)');
  const seen = new Set();
  return input.map((st) => {
    const id = String(st?.id ?? '').trim();
    const name = String(st?.name ?? '').trim();
    if (!/^\d{1,12}$/.test(id)) throw new Error(`Service type id "${id}" must be numeric (from Planning Center)`);
    if (seen.has(id)) throw new Error(`Duplicate service type id "${id}"`);
    seen.add(id);
    if (!name || name.length > 60) throw new Error('Each service type needs a name (max 60 characters)');
    return { id, name };
  });
}

// Normalize + validate an analysis config; null clears it (no analyzer).
// `mock` is deliberately not settable here — it's a dev-room fixture that
// only rooms.config.js declares (and the seed preserves).
export function validateAnalysis(input) {
  if (input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('analysis must be an object');
  const source = String(input.source ?? 'smaart');
  if (!SOURCES.includes(source)) throw new Error(`Unknown analysis source "${source}"`);
  const out = { source };
  if (source !== 'open-sound-meter') out.host = validateHost(input.host, 'Analysis source needs a host');
  const port = input.port === '' || input.port == null ? null : Number(input.port);
  if (port != null) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be 1–65535');
    out.port = port;
  }
  // Room-level dB goals. Widgets may override these per placement, but the
  // room keeps its own: showManager stamps target/limit onto every published
  // SPL sample, and a service report is written whether or not any dashboard
  // was on screen. Dropping them here silently blanked both.
  for (const key of ['target', 'limit']) {
    const v = input[key] === '' || input[key] == null ? null : Number(input[key]);
    if (v == null) continue;
    if (!Number.isFinite(v) || v < 40 || v > 130) throw new Error(`${key} must be 40–130 dB`);
    out[key] = v;
  }
  if (out.target != null && out.limit != null && out.limit < out.target) {
    throw new Error('limit must be at or above target');
  }
  const metric = String(input.metric ?? '').trim();
  if (metric) {
    if (metric.length > 60) throw new Error('metric must be at most 60 characters');
    out.metric = metric;
  }
  if (source === 'smaart') {
    const password = String(input.password ?? '');
    if (password) {
      if (password.length > 100) throw new Error('password must be at most 100 characters');
      out.password = password;
    }
    if (input.logControl) out.logControl = true;
  }
  return out;
}

function readRow(roomId, integration) {
  const row = getDb().prepare(
    'SELECT config FROM room_connectivity WHERE room_id = ? AND integration = ?',
  ).get(roomId, integration);
  return row ? JSON.parse(row.config) : null;
}

function writeRow(roomId, integration, config) {
  getDb().prepare(
    `INSERT INTO room_connectivity (room_id, integration, config, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(room_id, integration) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`,
  ).run(roomId, integration, JSON.stringify(config), Date.now());
}

function deleteRow(roomId, integration) {
  getDb().prepare('DELETE FROM room_connectivity WHERE room_id = ? AND integration = ?')
    .run(roomId, integration);
}

/** The stored Planning Center config for a room (null if the room has none). */
export function getPlanningCenter(roomId) {
  return readRow(roomId, PC);
}

/** Validate + store a room's service types, then apply them live. */
export function setPlanningCenter(roomId, serviceTypes) {
  if (!rooms[roomId]) throw new Error(`Unknown room "${roomId}"`);
  const clean = { serviceTypes: validateServiceTypes(serviceTypes) };
  writeRow(roomId, PC, clean);
  applyConnectivity();
  notifyChange(roomId, PC);
  return clean;
}

/** The stored analysis-source config for a room (null if the room has none). */
/**
 * Validate a room's caption source; null clears it.
 *
 * `channels` is an ALLOWLIST of channel identities — an integer index on one
 * source, a UUID on the other, so it is stored as strings and compared as
 * strings. Empty means every channel, which is the sane default: a room that
 * has bothered to configure a caption app wants to hear it.
 */
export function validateCaptions(input) {
  if (input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('captions must be an object');
  const source = String(input.source ?? '');
  if (!captions.sourceNames.includes(source)) throw new Error(`Unknown caption source "${source}"`);
  const host = validateHost(input.host, 'Caption source needs a host');
  const out = { source, host };

  const port = input.port === '' || input.port == null ? null : Number(input.port);
  if (port != null) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be 1–65535');
    out.port = port;
  }

  // ProdCom's optional pre-shared key. Stored beside the host exactly as
  // Smaart's password is — and, like it, never published: the captions topic
  // and the health dot both carry state only, never this.
  //
  // Only kept while the source is the one that uses it, so switching away
  // drops the credential rather than leaving it in the database for an
  // integration this room no longer talks to. Same rule as the Smaart password.
  if (source === 'prodcom') {
    const key = String(input.key ?? '');
    if (key) {
      if (key.length > 200) throw new Error('key must be at most 200 characters');
      out.key = key;
    }
  }

  if (input.channels != null) {
    if (!Array.isArray(input.channels)) throw new Error('channels must be an array');
    if (input.channels.length > 64) throw new Error('at most 64 channels');
    const list = input.channels.map((c) => String(c).trim()).filter(Boolean);
    // Deduped so a doubled entry cannot make one speaker arrive twice.
    if (list.length) out.channels = [...new Set(list)];
  }
  return out;
}

/** The stored caption config for a room (null if it has none). */
export function getCaptions(roomId) {
  return readRow(roomId, CAPTIONS);
}

/** Validate + store a room's caption source (null clears it), apply live. */
export function setCaptions(roomId, config) {
  if (!rooms[roomId]) throw new Error(`Unknown room "${roomId}"`);
  const clean = validateCaptions(config);
  if (clean === null) deleteRow(roomId, CAPTIONS);
  else writeRow(roomId, CAPTIONS, clean);
  applyConnectivity();
  notifyChange(roomId, CAPTIONS);
  return clean;
}

export function getAnalysis(roomId) {
  return readRow(roomId, ANALYSIS);
}

/** Validate + store a room's analysis source (null clears it), apply live. */
export function setAnalysis(roomId, config) {
  if (!rooms[roomId]) throw new Error(`Unknown room "${roomId}"`);
  const clean = validateAnalysis(config);
  if (clean === null) deleteRow(roomId, ANALYSIS);
  else writeRow(roomId, ANALYSIS, clean);
  applyConnectivity();
  notifyChange(roomId, ANALYSIS);
  return clean;
}

// OBS WebSocket is deliberately room-scoped: a campus can have a dedicated
// control-room OBS instance for every auditorium. The password is write-only
// at the route boundary, exactly like Smaart and ProdCom credentials.
export function validateObs(input) {
  if (input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('obs must be an object');
  const out = { host: validateHost(input.host, 'OBS Studio needs a host') };
  const port = input.port === '' || input.port == null ? 4455 : Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('OBS WebSocket port must be 1–65535');
  out.port = port;
  const password = String(input.password ?? '');
  if (password) {
    if (password.length > 200) throw new Error('OBS password must be at most 200 characters');
    out.password = password;
  }
  for (const key of ['primaryAudioInput', 'previewImageUrl']) {
    const value = String(input[key] ?? '').trim();
    if (value) {
      if (value.length > 500) throw new Error(`${key} is too long`);
      out[key] = value;
    }
  }
  const warning = input.droppedFramesWarning === '' || input.droppedFramesWarning == null ? null : Number(input.droppedFramesWarning);
  if (warning != null) {
    if (!Number.isFinite(warning) || warning < 0 || warning > 100) throw new Error('Dropped-frame warning must be 0–100%');
    out.droppedFramesWarning = warning;
  }
  return out;
}

export function getObs(roomId) { return readRow(roomId, OBS); }
export function setObs(roomId, config) {
  if (!rooms[roomId]) throw new Error(`Unknown room "${roomId}"`);
  const clean = validateObs(config);
  if (clean === null) deleteRow(roomId, OBS);
  else writeRow(roomId, OBS, clean);
  applyConnectivity();
  notifyChange(roomId, OBS);
  return clean;
}

// Normalize + validate a ProPresenter config; null clears it (no ProPresenter
// in the room). `timer` names the service-start countdown timer; without it
// the first count-down-to-time timer is used.
export function validateProPresenter(input) {
  if (input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('proPresenter must be an object');
  const host = validateHost(input.host, 'ProPresenter needs a host');
  const out = { host };
  const port = input.port === '' || input.port == null ? null : Number(input.port);
  if (port != null) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be 1–65535');
    out.port = port;
  }
  const timer = String(input.timer ?? '').trim();
  if (timer) {
    if (timer.length > 60) throw new Error('timer must be at most 60 characters');
    out.timer = timer;
  }
  return out;
}

// Normalize + validate a Companion config. "no Companion" is mock:true,
// which keeps state in memory instead. Room Mode is deliberately optional:
// Companion itself is useful even in rooms that do not need a mode picker.
const MODE_ID = /^[a-z0-9][a-z0-9_-]{0,29}$/i;
const COLOR = /^#[0-9a-f]{6}$/i;
export function validateCompanion(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('companion must be an object (rooms cannot clear it — use Simulated instead)');
  }
  const out = { mock: input.mock === true, roomMode: input.roomMode !== false };
  // Optional here: a simulated room has no Companion at all. Validated the
  // same way when present.
  const host = String(input.host ?? '').trim();
  if (host) out.host = validateHost(host, 'Companion host');
  const port = input.port === '' || input.port == null ? null : Number(input.port);
  if (port != null) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be 1–65535');
    out.port = port;
  }
  const variable = String(input.variable ?? '').trim();
  if (variable.length > 60) throw new Error('variable must be at most 60 characters');
  if (variable) out.variable = variable;
  const emulator = String(input.emulator ?? '').trim();
  if (emulator && !/^[a-z0-9_-]{1,80}$/i.test(emulator)) {
    throw new Error('Companion emulator ID must be letters, digits, - or _ (max 80)');
  }
  if (emulator) out.emulator = emulator;
  if (!out.mock) {
    if (!out.host) throw new Error('A live (non-simulated) room needs a Companion host');
    if (!out.variable) throw new Error('A live (non-simulated) room needs a state variable');
  }
  if (!Array.isArray(input.modes)) throw new Error('modes must be an array');
  if (input.modes.length > 100) throw new Error('Too many modes (max 100)');
  const ids = new Set();
  out.modes = input.modes.map((m) => {
    const id = String(m?.id ?? '').trim();
    if (!MODE_ID.test(id)) throw new Error(`Mode id "${id}" must be letters, digits, - and _ (max 30)`);
    if (ids.has(id)) throw new Error(`Duplicate mode id "${id}"`);
    ids.add(id);
    const label = String(m.label ?? '').trim();
    if (!label || label.length > 40) throw new Error(`Mode "${id}" needs a label (max 40 characters)`);
    const color = String(m.color ?? '').trim();
    if (!COLOR.test(color)) throw new Error(`Mode "${id}" color must be #rrggbb`);
    const match = String(m.match ?? '').trim();
    if (!match || match.length > 40) throw new Error(`Mode "${id}" needs a match value (max 40 characters)`);
    const mode = { id, label, color, match };
    const press = m.press ?? null;
    if (press != null && press !== '') {
      const nums = ['page', 'row', 'column'].map((f) => Number(press[f]));
      if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 999)) {
        throw new Error(`Mode "${id}" button needs integer page/row/column`);
      }
      if (nums[0] < 1) throw new Error(`Mode "${id}" button page must be at least 1`);
      mode.press = { page: nums[0], row: nums[1], column: nums[2] };
    }
    if (m.isStandby) mode.isStandby = true;
    return mode;
  });
  return out;
}

/** The stored Companion config for a room (null only pre-seed). */
export function getCompanion(roomId) {
  return readRow(roomId, COMPANION);
}

/** Validate + store a room's Companion config (never null), apply live. */
export function setCompanion(roomId, config) {
  if (!rooms[roomId]) throw new Error(`Unknown room "${roomId}"`);
  const clean = validateCompanion(config);
  writeRow(roomId, COMPANION, clean);
  applyConnectivity();
  notifyChange(roomId, COMPANION);
  return clean;
}

/** A room's effective Companion config in stored-blob shape — used to seed
 *  first boots and to show a room that has no row yet (a room created in
 *  Admin → Campuses) with its live defaults ready to edit. */
export function companionFromRoom(room) {
  return {
    mock: Boolean(room.mock),
    ...(room.companion?.host ? { host: room.companion.host } : {}),
    ...(room.companion?.port != null ? { port: room.companion.port } : {}),
    ...(room.state?.variable ? { variable: room.state.variable } : {}),
    ...(room.companion?.emulator ? { emulator: room.companion.emulator } : {}),
    roomMode: room.roomMode !== false,
    modes: room.modes,
  };
}

// Companion is stored as one blob but lives on four legacy room keys.
function applyCompanion(room, stored) {
  room.mock = stored.mock;
  room.companion = stored.host
    ? { host: stored.host, ...(stored.port != null ? { port: stored.port } : {}), ...(stored.emulator ? { emulator: stored.emulator } : {}) }
    : {};
  room.state = { variable: stored.variable };
  room.roomMode = stored.roomMode;
  room.modes = stored.modes;
}

/** The stored ProPresenter config for a room (null if the room has none). */
export function getProPresenter(roomId) {
  return readRow(roomId, PP);
}

/** Validate + store a room's ProPresenter config (null clears it), apply live. */
export function setProPresenter(roomId, config) {
  if (!rooms[roomId]) throw new Error(`Unknown room "${roomId}"`);
  const clean = validateProPresenter(config);
  if (clean === null) deleteRow(roomId, PP);
  else writeRow(roomId, PP, clean);
  applyConnectivity();
  notifyChange(roomId, PP);
  return clean;
}

/**
 * Normalize + validate a YouTube Live config; null clears it (the room isn't
 * streamed). A CHANNEL only — the room owns the channel, a service time owns
 * the video.
 *
 * There is deliberately no room-level video id. A church's channel pre-creates
 * one broadcast per service, so an 8:00 and a 9:30 on the same Sunday are
 * different videos in the same room; pinning at the room would attribute both
 * to one broadcast and report identical numbers twice. Per-service pins live
 * in show_config (`videos`), edited on Event Detail. Normally nothing needs
 * pinning: the watcher finds whatever is live on the channel.
 *
 * The id is charset-checked, not merely length-checked, because it is
 * interpolated into a request URL — same reasoning as validateHost().
 */
export function validateYouTube(input) {
  if (input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('youtube must be an object');

  const id = (v, what, max) => {
    const s = String(v ?? '').trim();
    if (!s) return null;
    if (s.length > max || !/^[A-Za-z0-9_-]+$/.test(s)) {
      throw new Error(`${what} must be a YouTube id (letters, digits, - and _ only)`);
    }
    return s;
  };

  const channelId = id(input.channelId, 'Channel ID', 64);
  if (!channelId) return null; // no channel = the room isn't streamed
  return { channelId };
}

/** The stored YouTube config for a room (null if it isn't streamed). */
export function getYouTube(roomId) {
  return readRow(roomId, YOUTUBE);
}

/** Validate + store a room's YouTube Live source (null clears it), apply live. */
export function setYouTube(roomId, config) {
  if (!rooms[roomId]) throw new Error(`Unknown room "${roomId}"`);
  const clean = validateYouTube(config);
  if (clean === null) deleteRow(roomId, YOUTUBE);
  else writeRow(roomId, YOUTUBE, clean);
  applyConnectivity();
  notifyChange(roomId, YOUTUBE);
  return clean;
}

/**
 * Assign stored connectivity onto the live rooms map (boot + after saves).
 * Once an integration has been seeded the database is authoritative: a room
 * with no row has that integration cleared, even if rooms.config.js still
 * declares one (the file entry is only a fresh-install seed).
 */
export function applyConnectivity() {
  const marker = getDb().prepare('SELECT value FROM app_config WHERE key = ?');
  for (const integration of INTEGRATIONS) {
    const seeded = Boolean(marker.get(`connectivity_seeded:${integration}`));
    for (const room of Object.values(rooms)) {
      const stored = readRow(room.id, integration);
      if (stored) {
        if (integration === COMPANION) applyCompanion(room, stored);
        else room[integration] = stored;
      } else if (seeded && integration !== COMPANION) {
        // Companion rows are never deleted, so a missing row just means this
        // room predates the migration — leave its file config in place.
        delete room[integration];
      }
    }
  }
}

// First boot with each integration: adopt what rooms.config.js declares so
// behavior doesn't change, then let the database own it. A marker (not a row
// count) records that seeding ran, so clearing every row of an integration
// doesn't resurrect the file config on the next boot. Databases seeded before
// markers existed just gain the marker.
function seedIfEmpty() {
  const db = getDb();
  const count = db.prepare('SELECT COUNT(*) AS n FROM room_connectivity WHERE integration = ?');
  const marker = db.prepare('SELECT value FROM app_config WHERE key = ?');
  const setMarker = db.prepare('INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)');
  const seeders = {
    [PC]: (room) =>
      room.planningCenter?.serviceTypes?.length
        ? { serviceTypes: room.planningCenter.serviceTypes }
        : null,
    [ANALYSIS]: (room) => room.analysis ?? null,
    [PP]: (room) => room.proPresenter ?? null,
    [COMPANION]: companionFromRoom,
    // youtube has no rooms.config.js predecessor to adopt — it arrived after
    // the file stopped being anything but a fresh-install seed. Seeding still
    // runs so the marker is set and the database is authoritative from boot
    // one, rather than the integration looking "never seeded" forever.
    [YOUTUBE]: (room) => room.youtube ?? null,
    // No rooms.config.js predecessor — captions arrived after the file stopped
    // being anything but a fresh-install seed. Seeding still runs so the marker
    // is set and the database owns it from boot one.
    [CAPTIONS]: (room) => room.captions ?? null,
    [OBS]: (room) => room.obs ?? null,
  };
  for (const integration of INTEGRATIONS) {
    const key = `connectivity_seeded:${integration}`;
    if (marker.get(key)) continue;
    if (count.get(integration).n === 0) {
      for (const room of Object.values(rooms)) {
        const cfg = seeders[integration](room);
        if (cfg) writeRow(room.id, integration, cfg);
      }
    }
    setMarker.run(key, '1');
  }
}

seedIfEmpty();
applyConnectivity();
