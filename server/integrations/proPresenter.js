// ─────────────────────────────────────────────────────────────────────────────
//  INTEGRATION: ProPresenter (official API, 7.9+)  —  live Run of Show tracking
//
//  The PC plan is pushed into ProPresenter as a playlist, so the active playlist
//  item maps 1:1 (by index) to our PC order of service. Run state comes from a
//  chunked slide stream where the PP build supports it, with polling as the
//  watchdog and fallback (see pollRunState); browsers get it over our SSE.
//
//  Per-room host/port (ProPresenter picks an ephemeral API port). No auth (LAN).
// ─────────────────────────────────────────────────────────────────────────────

import { report } from '../health.js';

const DEFAULT_PORT = 62202;

export const isConfigured = (pp) => Boolean(pp?.host);

function baseUrl(pp) {
  return `http://${pp.host}:${pp.port ?? DEFAULT_PORT}`;
}

// ── Mapping (pure, tested) ────────────────────────────────────────────────────

// The playlist-item shape this module hands to callers, from a raw
// `playlist_item` body (same nesting in /v1/playlist/active, /v1/playlist/
// focused, and playlist item listings): fields under `.id`, the active
// arrangement (which the presentation's own `current_arrangement` does NOT
// reliably report) under `.presentation_info`.
function itemShape(pli, playlistName) {
  const id = pli?.id ?? null;
  const info = pli?.presentation_info ?? {};
  return {
    index: id?.index ?? null,
    name: id?.name ?? null,
    uuid: id?.uuid ?? null,
    arrangementUuid: info.arrangement_uuid || null,
    arrangementName: info.arrangement_name || null,
    playlistName: playlistName ?? null,
  };
}

// Extract the active presentation playlist item from a /v1/playlist/active body.
export function parseActive(state) {
  const p = state?.presentation ?? {};
  return itemShape(p.playlist_item ?? null, p.playlist?.name ?? null);
}

const norm = (s) =>
  String(s ?? '').toLowerCase().replace(/\[[^\]]*\]/g, '').replace(/[^a-z0-9]/g, '');

// Tolerant name match — PP/PC titles differ in spacing/case/suffixes
// ("Break Out" vs "Breakout", "Pre Service" vs "Pre-Service Slides").
function namesMatch(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x === y || x.startsWith(y) || y.startsWith(x) || x.includes(y) || y.includes(x);
}

/**
 * Map ProPresenter's active item to a PC order-of-service item id.
 * Index is primary (the PC push preserves order); name is the sanity check
 * and the fallback when counts have diverged.
 */
export function mapIndexToItemId(items, active) {
  if (!active || active.index == null) return null;
  const at = items[active.index];
  if (at && namesMatch(at.title, active.name)) return at.id;
  const byName = items.find((it) => namesMatch(it.title, active.name));
  if (byName) return byName.id;
  return at ? at.id : null; // trust index even if names differ
}

/**
 * Mapping with per-event manual overrides layered on top (Event Detail →
 * Show Config): overrides = { '<pc item id>': { ppIndex, ppName } | { disabled: true } }. An
 * override wins by playlist index, with a tolerant-name rescue for when the
 * playlist was re-pushed and indices shifted but names survived.
 */
export function mapActiveToItemId(items, active, overrides = null) {
  if (!active || active.index == null) return null;
  if (overrides) {
    for (const [pcId, pp] of Object.entries(overrides)) {
      if (pp == null) continue;
      if (pp.disabled) continue;
      if (pp.ppIndex === active.index || (pp.ppName && namesMatch(pp.ppName, active.name))) {
        return pcId;
      }
    }
    // A PP item claimed by an override must not ALSO auto-map elsewhere…
    const auto = mapIndexToItemId(items, active);
    // …and a PC item claimed by an override must not be reachable by auto-map
    // from a different PP item (the override redirected it on purpose).
    if (auto && Object.prototype.hasOwnProperty.call(overrides, auto) && overrides[auto] != null) {
      return null;
    }
    return auto;
  }
  return mapIndexToItemId(items, active);
}

// ── Reads ─────────────────────────────────────────────────────────────────────

function withTimeout(signal, ms = 3000) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

// All reads funnel through here; the room isn't known at this depth, so health
// is keyed by the machine we actually talked to.
export const healthKey = (pp) => `proPresenter@${pp.host}:${pp.port ?? DEFAULT_PORT}`;

async function ppGet(pp, path, signal) {
  const key = healthKey(pp);
  try {
    const res = await fetch(`${baseUrl(pp)}${path}`, { signal: withTimeout(signal) });
    if (!res.ok) throw new Error(`ProPresenter ${res.status}`);
    const body = await res.json();
    report(key, true);
    return body;
  } catch (err) {
    // A caller abort (show ended, view closed) is not an integration failure;
    // an unresponsive PP surfaces as TimeoutError and is.
    if (err?.name !== 'AbortError') report(key, false, String(err.message ?? err));
    throw err;
  }
}

// Like ppGet but without health reporting — for probes where a failure is an
// expected answer (PP 21 404s the uuid playlist route), not an outage.
async function rawGet(pp, path, signal) {
  const res = await fetch(`${baseUrl(pp)}${path}`, { signal: withTimeout(signal) });
  if (!res.ok) throw new Error(`ProPresenter ${res.status}`);
  return res.json();
}

// ── ProPresenter 21 compatibility ────────────────────────────────────────────
//
//  PP 21 (verified live against 21.1, 2026-07-24) broke two PP 7 behaviors
//  this module was built on:
//    · /v1/playlist/active answers all-null even while a presentation is live.
//    · /v1/playlist/{uuid} no longer resolves uuids — playlists are addressed
//      by index path ("/v1/playlist/1/0" = second root node, first child).
//  What still works: /v1/presentation/slide_index (the active presentation's
//  uuid), /v1/playlist/focused (a full playlist_item), and playlist bodies
//  whose items carry presentation_info.presentation_uuid. So when `active`
//  reads empty, we resolve the live item by its presentation uuid instead.

/** Fetch a playlist body by uuid (PP 7) or, failing that, index path (PP 21). */
async function fetchPlaylistBody(pp, ref, signal) {
  try {
    return await rawGet(pp, `/v1/playlist/${ref.uuid}`, signal);
  } catch {
    /* PP 21 — fall through to index-path addressing */
  }
  let path = ref.path;
  if (!path) {
    const all = flattenPlaylists(await ppGet(pp, '/v1/playlists', signal));
    path = all.find((p) => p.uuid === ref.uuid)?.path;
  }
  if (!path) throw new Error(`playlist ${ref.uuid} not found in /v1/playlists`);
  return ppGet(pp, `/v1/playlist/${path.join('/')}`, signal);
}

// Per-machine cache of the focused playlist's items for uuid resolution — the
// poller asks every ~800ms and the playlist rarely changes. `missed` remembers
// presentations that aren't in the playlist (launched from the library) so
// they don't refetch every poll; misses retry after REFETCH_MS in case the
// operator edited the playlist mid-show.
const REFETCH_MS = 60_000;
const resolveCache = new Map(); // healthKey → { playlistUuid, items, missed, fetchedAt }

async function resolveByPresentation(pp, slide, signal) {
  if (!slide?.presUuid) return null;
  const focused = await ppGet(pp, '/v1/playlist/focused', signal).catch(() => null);
  const playlistName = focused?.playlist?.name ?? null;
  // Common case: the live item is also the focused one (triggering selects).
  const direct = focused?.playlist_item;
  if (direct?.presentation_info?.presentation_uuid === slide.presUuid) {
    return itemShape(direct, playlistName);
  }
  // The focused SELECTION drifted from what's live (operator arrowing around)
  // — scan the focused playlist's items for the active presentation.
  const plUuid = focused?.playlist?.uuid;
  if (!plUuid) return null;
  const key = healthKey(pp);
  let c = resolveCache.get(key);
  const hitIn = (cache) =>
    cache?.items.find((it) => it.presentation_info?.presentation_uuid === slide.presUuid);
  const staleMiss = c && c.missed.has(slide.presUuid) && Date.now() - c.fetchedAt > REFETCH_MS;
  if (!c || c.playlistUuid !== plUuid || (!hitIn(c) && (staleMiss || !c.missed.has(slide.presUuid)))) {
    const body = await fetchPlaylistBody(pp, { uuid: plUuid }, signal).catch(() => null);
    if (body) {
      c = { playlistUuid: plUuid, items: body.items ?? [], missed: new Set(), fetchedAt: Date.now() };
      resolveCache.set(key, c);
    }
  }
  const hit = hitIn(c);
  if (!hit) {
    c?.missed.add(slide.presUuid);
    return null;
  }
  return itemShape(hit, playlistName);
}

/**
 * One-shot read of the current active playlist item. On PP 21 the `active`
 * route reads null mid-show, so we fall back to resolving by the active
 * presentation's uuid; pass a pre-fetched `slide` (from readSlide) to skip
 * the extra slide_index request.
 */
export async function readActive(pp, signal, slide) {
  const parsed = parseActive(await ppGet(pp, '/v1/playlist/active', signal));
  if (parsed.index != null) return parsed;
  const s = slide === undefined ? await readSlide(pp, signal).catch(() => null) : slide;
  return (await resolveByPresentation(pp, s, signal).catch(() => null)) ?? parsed;
}

/**
 * Pick the PP playlist that belongs to a PC plan. The PC push names playlists
 * "<series> - <plan title> - <dates>" (e.g. "… - July 12, 2026"), so the plan's
 * date string is the strong signal; the title breaks ties. Pure — tested.
 * `playlists` = flattened [{uuid, name}]. Returns the best match or null.
 */
export function pickPlaylistForPlan(playlists, plan) {
  let best = null;
  let bestScore = 0;
  for (const pl of playlists) {
    const name = norm(pl.name);
    let score = 0;
    if (plan?.dates && name.includes(norm(plan.dates))) score += 2;
    if (plan?.title && name.includes(norm(plan.title))) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = pl;
    }
  }
  return best;
}

// /v1/playlists nests folders via `children` — flatten to playlist leaves,
// keeping each leaf's index path (sibling positions) for PP 21 addressing.
function flattenPlaylists(nodes, out = [], prefix = []) {
  (nodes ?? []).forEach((n, i) => {
    const path = [...prefix, i];
    if (n.field_type === 'playlist' && n.id?.uuid) out.push({ uuid: n.id.uuid, name: n.id.name ?? '', path });
    flattenPlaylists(n.children, out, path);
  });
  return out;
}

/**
 * The items of the playlist to map a plan against (for the mapping-override
 * UI). Prefers the playlist that MATCHES the plan (by pushed name), so the
 * config screen shows the right service even while PP still has last week's
 * playlist open; falls back to the active playlist (matched: false → the UI
 * warns). Returns null when PP has neither. Shapes verified live:
 * /v1/playlist/{uuid} → { id, items: [{ id: {index,name,uuid}, type, … }] }.
 */
export async function readPlaylistItems(pp, signal, plan = null) {
  let target = null;
  let matched = false;
  if (plan) {
    const all = flattenPlaylists(await ppGet(pp, '/v1/playlists', signal).catch(() => []));
    const hit = pickPlaylistForPlan(all, plan);
    if (hit) {
      target = hit;
      matched = true;
    }
  }
  if (!target) {
    const active = await ppGet(pp, '/v1/playlist/active', signal);
    let pl = active?.presentation?.playlist ?? null;
    if (!pl?.uuid) {
      // PP 21 answers null here even mid-show — use the focused playlist.
      pl = (await ppGet(pp, '/v1/playlist/focused', signal).catch(() => null))?.playlist ?? null;
    }
    if (!pl?.uuid) return null;
    target = pl;
  }
  const body = await fetchPlaylistBody(pp, target, signal);
  return {
    playlistName: target.name ?? null,
    matched,
    items: (body.items ?? []).map((it) => ({
      index: it.id?.index ?? null,
      name: it.id?.name ?? '',
      type: it.type ?? 'presentation',
    })),
  };
}

/**
 * Cheapest real request — identifies the machine and app version, e.g.
 * "ProPresenter 21.1 · Booth-Mac". Reports into health like any read.
 */
export async function ping(pp, signal) {
  const v = await ppGet(pp, '/version', signal);
  return [v.host_description, v.name].filter(Boolean).join(' · ');
}

/**
 * Shape a `/v1/transport/{layer}/current` body. Exported for the tests, which
 * use the exact payloads observed on 21.4 (see INTEGRATION-NOTES).
 *
 * Returns null unless something is ACTUALLY PLAYING, and that is the whole
 * subtlety: ProPresenter keeps `uuid`, `name` and `duration` after playback
 * stops, freezes `time` wherever it landed, and leaves `/v1/status/layers`
 * reporting `media: true`. Every intuitive "is a video up?" test therefore
 * stays true forever and pins a dead counter on a wall. `is_playing` is the
 * only field that means "moving right now".
 *
 * A paused video is also reported as `is_playing: false`, identical to a
 * stopped one, so it is treated as nothing rather than guessed at. A missing
 * position beats a wrong one.
 */
export function parseTransport(body) {
  if (!body?.is_playing) return null;
  const duration = Number(body.duration);
  if (!Number.isFinite(duration) || duration <= 0) return null;
  return { name: body.name || null, duration, audioOnly: Boolean(body.audio_only) };
}

/**
 * What is playing on a media layer, and how far in — or null.
 *
 * The `presentation` layer is the media transport despite the name: a video
 * cued from the order of service plays there.
 */
export async function readTransport(pp, signal, layer = 'presentation') {
  const media = parseTransport(await ppGet(pp, `/v1/transport/${layer}/current`, signal));
  if (!media) return null;
  // A bare JSON number, not an object — 73.78204166666666.
  const seconds = await ppGet(pp, `/v1/transport/${layer}/time`, signal);
  return {
    ...media,
    // Clamped: the reported position can sit a hair past duration at the end.
    seconds: Number.isFinite(seconds) ? Math.max(0, Math.min(seconds, media.duration)) : null,
  };
}

/**
 * Current slide position within the active presentation. PP 21.4+ also
 * reports total_cues here — the arrangement-aware slide count straight from
 * the source (needed because 21.4 dropped presentation_info from the active
 * playlist item, taking the reliable arrangement read with it).
 */
/** Shape a /v1/presentation/slide_index body (same shape when streamed). */
export function parseSlide(body) {
  const pi = body?.presentation_index;
  return {
    slideIndex: pi?.index ?? null,
    presUuid: pi?.presentation_id?.uuid ?? null,
    presName: pi?.presentation_id?.name ?? null,
    totalCues: pi?.total_cues ?? null,
  };
}

export async function readSlide(pp, signal) {
  return parseSlide(await ppGet(pp, '/v1/presentation/slide_index', signal));
}

// ── The active presentation, expanded ─────────────────────────────────────────
//
//  /v1/presentation/active hands back the whole song in one response — every
//  group's name, ProPresenter's own section COLOUR, each slide's text and the
//  operator's slide notes — plus the arrangements that say what order it is
//  actually played in. Probed live 2026-08-11 on 21.4; the body shape and the
//  three traps below are in INTEGRATION-NOTES.
//
//  The trap that matters here: `groups` is the song's raw MATERIAL, not its
//  running order. A group appears once under `groups` however many times it is
//  played, and the arrangement is a list of group uuids WITH REPEATS. So the
//  presentation-level `total_cues` (14 on the probed song) is the raw sum,
//  while the arrangement people actually run is 27. Anything that indexes by
//  slide position must expand the arrangement first or it addresses the wrong
//  half of the song.

/** PP gives colour components as 0..1 floats. Some builds have used 0..255,
 *  which is cheap to survive and expensive to debug.
 *
 *  Pure black and pure white come back as null, NOT as a colour. Those are what
 *  ProPresenter leaves on the utility groups nobody ever styles — the "Blank"
 *  and "Clear Background" cues both arrived as rgba(0,0,0,1) on the probed
 *  song. Treating that as a deliberate choice paints a black dot and a black
 *  highlight bar onto a dark dashboard, i.e. renders them invisible; treating
 *  it as "unset" lets the widget fall back to something a person can see. */
function hexColor(c) {
  if (!c) return null;
  const parts = [c.red, c.green, c.blue];
  if (parts.some((n) => typeof n !== 'number' || Number.isNaN(n))) return null;
  const scale = parts.some((n) => n > 1) ? 1 : 255;
  const rgb = parts.map((n) => Math.max(0, Math.min(255, Math.round(n * scale))));
  if (rgb.every((n) => n === 0) || rgb.every((n) => n === 255)) return null;
  return `#${rgb.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

// PP uses `label` or `name` for some cue types (including the final utility
// cue in certain Planning Center presentations), rather than `text`.
function cueText(cue) {
  return typeof cue?.text === 'string' && cue.text.trim()
    ? cue.text
    : typeof cue?.label === 'string' && cue.label.trim()
      ? cue.label
      : typeof cue?.name === 'string' ? cue.name : '';
}

/**
 * Flatten a presentation into the cue list it is actually played as.
 *
 * Returns one entry per cue, in running order:
 *   { text, section, color, note, rep }
 * where `rep` is {at, of} for a section played several times BACK TO BACK
 * (the probed song runs Bridge 1 four times in a row) and null otherwise.
 * Consecutive only, deliberately: a chorus that comes round again later reads
 * as the chorus, but four identical bridges in a row look like a frozen screen
 * unless the position within the run is on display.
 *
 * `arrangement` = { uuid, name } from the active playlist item — PP 21.1's
 * route. `totalCues` = the count from slide_index, which is 21.4's route,
 * because 21.4 dropped presentation_info from the active playlist item and
 * leaves `current_arrangement` as an empty string. Falls back to the raw group
 * order, which is right for a presentation with no arrangements at all.
 */
export function arrangeSlides(pres, arrangement = null, totalCues = null) {
  if (!pres) return [];
  const byUuid = new Map();
  const thumbnailOffsets = new Map();
  let thumbnailOffset = 0;
  for (const g of pres.groups ?? []) {
    byUuid.set(g.uuid, g);
    // Arrangement order may repeat a group, but PP's thumbnail endpoint is
    // addressed in the source presentation's original cue order. Keep this
    // source index beside every expanded cue (ChurchBoard's key insight).
    thumbnailOffsets.set(g.uuid, thumbnailOffset);
    thumbnailOffset += (g.slides ?? []).length;
  }
  const arrs = pres.arrangements ?? [];
  const uuidsOf = (a) => (Array.isArray(a?.groups) ? a.groups : []).map((u) => (typeof u === 'string' ? u : u?.uuid));
  const lengthOf = (uuids) => uuids.reduce((s, u) => s + (byUuid.get(u)?.slides ?? []).length, 0);

  let target = null;
  if (arrangement?.uuid) target = arrs.find((a) => a.id?.uuid === arrangement.uuid);
  if (!target && arrangement?.name) target = arrs.find((a) => a.id?.name === arrangement.name);
  // 21.4: the only thing identifying the live arrangement is how long it is.
  // Ambiguous when two arrangements share a length — first wins, and the two
  // are the same length so the scroll position stays honest either way.
  if (!target && totalCues != null) target = arrs.find((a) => lengthOf(uuidsOf(a)) === totalCues);
  if (!target && pres.current_arrangement) target = arrs.find((a) => a.id?.uuid === pres.current_arrangement);

  let order = target ? uuidsOf(target) : [];
  if (lengthOf(order) === 0) order = (pres.groups ?? []).map((g) => g.uuid);

  // Number each back-to-back run before expanding, while runs are still one
  // entry per PLAY rather than one per slide.
  const runs = [];
  for (const [i, uuid] of order.entries()) {
    const prev = runs[runs.length - 1];
    if (prev && order[i - 1] === uuid) prev.push(uuid);
    else runs.push([uuid]);
  }

  const out = [];
  for (const run of runs) {
    for (const [k, uuid] of run.entries()) {
      const g = byUuid.get(uuid);
      if (!g) continue; // an arrangement referencing a deleted group
      const rep = run.length > 1 ? { at: k + 1, of: run.length } : null;
      for (const [sourceIndex, s] of (g.slides ?? []).entries()) {
        out.push({
          text: cueText(s),
          section: g.name ?? '',
          color: hexColor(g.color),
          note: s.notes || null,
          rep,
          thumbnailIndex: (thumbnailOffsets.get(uuid) ?? 0) + sourceIndex,
        });
      }
    }
  }
  return out;
}

/**
 * Total slide count of the active presentation for the given arrangement
 * (songs repeat groups, so different arrangements have different totals).
 * The length of the expansion above — one definition of "what order is this
 * played in", so a slide bar and a lyric scroll cannot disagree about it.
 */
export function slideTotal(pres, arrangement = null) {
  return arrangeSlides(pres, arrangement).length || null;
}

/** The raw `presentation` body of whatever is live. The expensive read here —
 *  a whole song — so callers cache it against the presentation uuid. */
export async function readActivePresentation(pp, signal) {
  return (await ppGet(pp, '/v1/presentation/active', signal))?.presentation ?? null;
}

async function readSlideCount(pp, signal, arrangement) {
  return slideTotal(await readActivePresentation(pp, signal), arrangement);
}

// ── Timers ────────────────────────────────────────────────────────────────────
//
//  The room's "Service Start Timer" pattern: one count-down-to-time timer, and
//  Message objects ("9:30AM", "11:00AM"…) whose timer token re-targets + starts
//  it when the operator clicks Show between services. We read the live value.

// A timer definition's count_down_to_time.time_of_day is a 12-HOUR value paired
// with an am/pm period (5:30 PM → 19800 + "pm"); normalize to absolute seconds
// since midnight. Verified against the live API.
export function targetSecondsOfDay(countDownToTime) {
  if (!countDownToTime || typeof countDownToTime.time_of_day !== 'number') return null;
  return (countDownToTime.time_of_day % 43200) + (countDownToTime.period === 'pm' ? 43200 : 0);
}

// "07:29:05" → seconds remaining.
export function parseHms(s) {
  const m = /^(\d+):(\d{2}):(\d{2})$/.exec(String(s ?? ''));
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

/** Merge /v1/timers (definitions) with /v1/timers/current (live values). */
export function parseTimers(defs, currents) {
  const byUuid = new Map((defs ?? []).map((d) => [d.id?.uuid, d]));
  return (currents ?? []).map((c) => {
    const def = byUuid.get(c.id?.uuid) ?? {};
    return {
      uuid: c.id?.uuid ?? null,
      name: c.id?.name ?? '',
      state: c.state ?? 'stopped',
      remainingSeconds: parseHms(c.time),
      targetSecondsOfDay: targetSecondsOfDay(def.count_down_to_time),
      countsDownToTime: Boolean(def.count_down_to_time),
    };
  });
}

/**
 * The room's service-start timer: the configured name if it matches, else the
 * first count-down-to-time timer, else the first timer.
 */
export function pickTimer(timers, preferredName = null) {
  if (!timers?.length) return null;
  if (preferredName) {
    const t = timers.find((x) => namesMatch(x.name, preferredName));
    if (t) return t;
  }
  return timers.find((t) => t.countsDownToTime) ?? timers[0];
}

/** One-shot read of all timers with live values. */
export async function readTimers(pp, signal) {
  const [defs, currents] = await Promise.all([
    ppGet(pp, '/v1/timers', signal),
    ppGet(pp, '/v1/timers/current', signal),
  ]);
  return parseTimers(defs, currents);
}

// ── Production-console playlist model ───────────────────────────────────────
//
// Playlist bodies have changed shape across PP 7/21 and Planning Center adds
// rows which look like presentations but cannot be triggered. Keep that mess at
// this boundary: widgets receive one stable model and never invent HTTP paths.

const detailCache = new Map(); // machine|presentation uuid -> { value, at }
const DETAIL_TTL_MS = 5 * 60_000;

const nonEmpty = (...values) => values.find((v) => typeof v === 'string' && v.trim()) ?? null;

function rawPlaylistItems(body) {
  return body?.items ?? body?.playlist_items ?? body?.children ?? [];
}

/** Normalize one playlist entry without claiming an arbitrary named node is playable. */
export function normalizePlaylistItem(raw, position = 0) {
  const id = raw?.id ?? raw?.playlist_item?.id ?? {};
  const info = raw?.presentation_info ?? raw?.presentation ?? raw?.playlist_item?.presentation_info ?? {};
  const type = String(raw?.type ?? raw?.field_type ?? raw?.item_type ?? '').toLowerCase();
  const presentationUuid = nonEmpty(
    info.presentation_uuid, info.uuid, raw?.presentation_uuid, raw?.presentation?.id?.uuid,
  );
  const isPco = Boolean(raw?.is_pco ?? raw?.planning_center ?? raw?.pco ?? info.is_pco);
  const index = Number.isInteger(id.index) ? id.index : position;
  const title = nonEmpty(id.name, raw?.name, raw?.title, info.name) ?? 'Untitled item';
  const placeholder = Boolean(raw?.placeholder) || /header|folder|placeholder/.test(type);
  return {
    index, title, type: type || (presentationUuid ? 'presentation' : 'placeholder'),
    uuid: id.uuid ?? null, presentationUuid, isPco, placeholder,
    // A PCO shell may carry a presentation UUID for reading/thumbnails while
    // refusing UUID activation, so it remains triggerable via item fallback.
    triggerable: !placeholder && (Boolean(presentationUuid) || isPco),
    presentationTitle: nonEmpty(info.name, raw?.presentation_name) ?? null,
    slides: [],
  };
}

export function normalizePlaylist(body) {
  const playlist = body?.playlist ?? body?.id ?? {};
  return {
    uuid: playlist.uuid ?? null,
    name: playlist.name ?? body?.name ?? null,
    items: rawPlaylistItems(body).map(normalizePlaylistItem),
  };
}

/** Presentation detail, cached independently of fast current-cue polling. */
export async function readPresentationDetail(pp, uuid, signal, { fresh = false } = {}) {
  if (!/^[a-z0-9-]{8,}$/i.test(String(uuid))) return null;
  const key = `${healthKey(pp)}|${uuid}`;
  const cached = detailCache.get(key);
  if (!fresh && cached && Date.now() - cached.at < DETAIL_TTL_MS) return cached.value;
  // PP's documented endpoint has varied. Keep failure local to this item.
  const value = await ppGet(pp, `/v1/presentation/${encodeURIComponent(uuid)}`, signal)
    .then((body) => body?.presentation ?? body)
    .catch(() => null);
  if (value) detailCache.set(key, { value, at: Date.now() });
  return value;
}

/** A compact current/next state. API indexes remain zero-based; display is +1. */
export function runtimeFrom(slide, active, timers, video) {
  return {
    activePresentationUuid: slide?.presUuid ?? active?.presentationUuid ?? null,
    activePlaylistIndex: active?.index ?? null,
    activeCueIndex: Number.isInteger(slide?.slideIndex) ? slide.slideIndex : null,
    activeCueNumber: Number.isInteger(slide?.slideIndex) ? slide.slideIndex + 1 : null,
    totalCues: slide?.totalCues ?? null,
    timers: timers ?? [], video: video ?? null,
  };
}

/** Read focused and active playlists separately; focused is browser state only. */
export async function readConsoleState(pp, signal) {
  const [focusedRaw, activeRaw, slide, timers, video] = await Promise.all([
    ppGet(pp, '/v1/playlist/focused', signal).catch(() => null),
    ppGet(pp, '/v1/playlist/active', signal).catch(() => null),
    readSlide(pp, signal).catch(() => null),
    readTimers(pp, signal).catch(() => []),
    readTransport(pp, signal).catch(() => null),
  ]);
  // Every read above swallows its own failure so one bad endpoint cannot erase
  // the rest. Taken together that made a dead machine indistinguishable from a
  // live one showing nothing, and the watcher published `connected: true`
  // through a total outage. A reachable PP answers at least one of these three.
  if (focusedRaw == null && activeRaw == null && slide == null) {
    throw new Error('ProPresenter unreachable');
  }
  const focusedRef = focusedRaw?.playlist ?? null;
  const activeRef = activeRaw?.presentation?.playlist ?? null;
  const focusedBody = focusedRef?.uuid
    ? await fetchPlaylistBody(pp, focusedRef, signal).catch(() => null)
    : null;
  // PP can briefly return a focused playlist shell with no body while an
  // operator changes selection. Do not let that empty shell hide a usable
  // active playlist (the watcher additionally retains the last rich state).
  const focusedPlaylist = normalizePlaylist(focusedBody ?? focusedRaw ?? {});
  const activePlaylist = normalizePlaylist(activeRaw ?? {});
  const focusedUsable = Boolean(focusedPlaylist.uuid || focusedPlaylist.items.length);
  const playlist = focusedUsable ? focusedPlaylist : activePlaylist;
  const active = parseActive(activeRaw);
  // Fetch detail lazily and independently: a malformed/missing presentation
  // must never erase the rest of the playlist.
  const items = await Promise.all(playlist.items.map(async (item) => {
    const detail = item.presentationUuid
      ? await readPresentationDetail(pp, item.presentationUuid, signal, {
        fresh: item.presentationUuid === slide?.presUuid,
      })
      : null;
    const arrangement = item.presentationUuid === slide?.presUuid
      ? { uuid: active.arrangementUuid, name: active.arrangementName }
      : null;
    return { ...item, slides: detail ? arrangeSlides(detail, arrangement, item.presentationUuid === slide?.presUuid ? slide?.totalCues : null)
      .map((cue, index) => ({ ...cue, index, number: index + 1 })) : [] };
  }));
  return {
    focusedPlaylist: { ...playlist, items, source: focusedUsable ? 'focused' : 'active-fallback' },
    activePlaylist: activeRef ? { uuid: activeRef.uuid ?? null, name: activeRef.name ?? null } : null,
    runtime: runtimeFrom(slide, active, timers, video),
  };
}

function validIndex(value) {
  return Number.isInteger(value) && value >= 0 && value <= 10_000;
}

/** Control routes commonly answer with an empty 200 body. `ppGet` is right for
 * data but treats that successful response as broken JSON; actions need their
 * own narrow transport. */
async function ppControlGet(pp, path, signal) {
  const key = healthKey(pp);
  try {
    const res = await fetch(`${baseUrl(pp)}${path}`, { signal: withTimeout(signal) });
    if (!res.ok) throw new Error(`ProPresenter ${res.status}`);
    report(key, true);
  } catch (err) {
    if (err?.name !== 'AbortError') report(key, false, String(err.message ?? err));
    throw err;
  }
}

export async function control(pp, action, input = {}, signal) {
  if (!isConfigured(pp)) throw new Error('ProPresenter is not configured');
  if (action === 'next') return ppControlGet(pp, '/v1/trigger/next', signal);
  if (action === 'previous') return ppControlGet(pp, '/v1/trigger/previous', signal);
  if (!validIndex(input.playlistIndex)) throw new Error('Invalid playlist index');
  if (action === 'presentation') {
    // UUID activation is the stable path even for PCO items when supported;
    // only fall back to their playlist position when that PP build rejects it.
    if (input.presentationUuid) {
      try { return await ppControlGet(pp, `/v1/presentation/${encodeURIComponent(input.presentationUuid)}/trigger`, signal); }
      catch { /* playlist placement is the compatibility fallback */ }
    }
    return ppControlGet(pp, `/v1/playlist/focused/${input.playlistIndex}/trigger`, signal);
  }
  if (action === 'cue') {
    if (!validIndex(input.cueIndex)) throw new Error('Invalid cue index');
    // The display number is one-based, but ProPresenter's trigger endpoint
    // itself expects the zero-based API cue index. Keep that conversion at the
    // UI boundary; sending the display number advances every mouse cue by one.
    const cueIndex = input.cueIndex;
    if (input.presentationUuid) {
      try { return await ppControlGet(pp, `/v1/presentation/${encodeURIComponent(input.presentationUuid)}/trigger/${cueIndex}`, signal); }
      catch { /* deliberate fallback below */ }
    }
    await ppControlGet(pp, `/v1/playlist/focused/${input.playlistIndex}/trigger`, signal);
    // PP applies playlist activation asynchronously. Waiting a beat prevents
    // the cue request from being aimed at the presentation that just left air.
    await new Promise((resolve) => setTimeout(resolve, 150));
    return ppControlGet(pp, `/v1/presentation/active/${cueIndex}/trigger`, signal);
  }
  throw new Error('Unknown ProPresenter action');
}

/** Find the adjacent playable row by actual playlist index, not array position:
 * headers, folders and unresolved PCO shells occupy positions too. */
export function adjacentPlayable(items, fromIndex, direction) {
  const sorted = [...(items ?? [])].sort((a, b) => a.index - b.index);
  const candidates = direction > 0 ? sorted : sorted.reverse();
  return candidates.find((item) => item.triggerable && (direction > 0 ? item.index > fromIndex : item.index < fromIndex)) ?? null;
}

export async function controlAdjacentItem(pp, direction, signal) {
  const state = await readConsoleState(pp, signal);
  const activeIndex = state.runtime.activePlaylistIndex;
  if (!Number.isInteger(activeIndex)) throw new Error('No active playlist item');
  const target = adjacentPlayable(state.focusedPlaylist.items, activeIndex, direction);
  if (!target) throw new Error(direction > 0 ? 'No next playable playlist item' : 'No previous playable playlist item');
  return control(pp, 'presentation', { playlistIndex: target.index }, signal);
}

/** Fetch a rendered cue image for our own proxy route; never send clients to
 * the device directly. Returns null for a missing thumbnail. */
export async function readThumbnail(pp, presentationUuid, cueIndex, signal) {
  if (!/^[a-z0-9-]{8,}$/i.test(String(presentationUuid)) || !validIndex(cueIndex)) return null;
  // Zero-based: the same `index` that slide_index reports and the trigger
  // routes take. This used to ask for cueIndex + 1, on the belief that the
  // endpoint was one-based. It is not, and every slide drew the NEXT slide's
  // image (#42: an intro slide showing verse 1's text, an image-only
  // presentation losing its first image). Only the last slide looked right,
  // because its +1 missed and a retry fell back to the true index. That retry
  // was the symptom being patched, not a second API variant.
  //
  // Evidence: the 7.9 OpenAPI spec names the parameter `index` with no base,
  // and independent clients that draw the LIVE slide pass slide_index straight
  // through, which would be visibly wrong if it were one-based. Not yet checked
  // against a running ProPresenter here.
  const res = await fetch(`${baseUrl(pp)}/v1/presentation/${encodeURIComponent(presentationUuid)}/thumbnail/${cueIndex}`, {
    signal: withTimeout(signal),
  });
  if (!res.ok) return null;
  const bytes = Buffer.from(await res.arrayBuffer());
  return { bytes, type: res.headers.get('content-type') || 'image/jpeg' };
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    // Detach on normal completion — a 90-minute show polls thousands of times
    // on one signal and would otherwise leak a listener per poll.
    const onAbort = () => { clearTimeout(t); resolve(); };
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ── Slide streaming ──────────────────────────────────────────────────────────
//
//  `?chunked=true` holds the connection open and emits a JSON body on every
//  change. Support is version-dependent and undocumented as such: verified
//  pushing on 21.4 (2026-07-26), while older builds answered once and went
//  quiet — which is why this is never the only source of truth. It feeds
//  pollRunState, which keeps its own timer as a watchdog and takes over the
//  moment the stream stops being trustworthy. Worst case = pure polling.

/** Split a growing buffer into complete top-level JSON objects. */
function takeJsonObjects(buf) {
  const out = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < buf.length; i += 1) {
    const c = buf[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') { if (depth === 0) start = i; depth += 1; }
    else if (c === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) { out.push(buf.slice(start, i + 1)); start = -1; }
    }
  }
  // Keep any partial object for the next chunk.
  return { objects: out, rest: start >= 0 ? buf.slice(start) : '' };
}

/**
 * Hold open /v1/presentation/slide_index?chunked=true, calling onSlide(slide)
 * for each pushed body. Resolves when the connection closes or the signal
 * aborts; rejects if it never opened. No health reporting — an unsupported
 * PP build closing the stream is an expected answer, not an outage.
 */
export async function streamSlideIndex(pp, onSlide, signal) {
  // Deliberately NOT withTimeout(): this connection is meant to stay open.
  const res = await fetch(`${baseUrl(pp)}/v1/presentation/slide_index?chunked=true`, { signal });
  if (!res.ok || !res.body) throw new Error(`ProPresenter ${res.status}`);
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    const { objects, rest } = takeJsonObjects(buf);
    buf = rest;
    for (const raw of objects) {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        continue; // framing noise — the next chunk usually completes it
      }
      onSlide(parseSlide(body));
    }
  }
}

/** sleep(), but the caller gets a handle to cut it short (a stream push). */
function sleepUntil(ms, signal, giveWake) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(t);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const t = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
    giveWake(finish);
  });
}

/**
 * Track the active item + slide progress, calling onState(state) whenever any
 * of them changes, until the signal aborts.
 *
 * Two sources, deliberately overlapping. The chunked slide stream (when the PP
 * build supports it) makes updates immediate; the timer below is the watchdog
 * that both fills in what the stream doesn't carry (the playlist item) and
 * catches anything it misses. While the stream is trusted the timer relaxes to
 * WATCHDOG_MS; if the stream drops, goes quiet through a real change, or was
 * never supported, the timer returns to `intervalMs` — i.e. exactly the
 * behavior that shipped before streaming existed.
 *
 * state = { itemIndex, itemName, slideIndex, slideCount, presName }
 */
export async function pollRunState(pp, onState, signal, intervalMs = 800) {
  let lastKey;
  let fails = 0;
  const countCache = { key: null, count: null };

  const WATCHDOG_MS = Math.max(intervalMs, 5000);
  const stream = { open: false, trusted: false, lastSlideIndex: null };
  let wake = null; // set while the loop sleeps, so a push can cut it short

  // Supervise the stream for the life of the run: reconnect while it is
  // supported, and stop trying once a build proves it is not.
  (async () => {
    let attempts = 0;
    while (!signal.aborted && attempts < 3) {
      // EVERY build answers the initial request with a snapshot, so one body
      // proves nothing — only a SUBSEQUENT push proves this build streams.
      let pushes = 0;
      try {
        attempts += 1;
        await streamSlideIndex(
          pp,
          (slide) => {
            pushes += 1;
            stream.lastSlideIndex = slide.slideIndex;
            if (pushes < 2) return; // the opening snapshot
            attempts = 0; // proven: stop counting this against the retry budget
            stream.open = true;
            stream.trusted = true;
            wake?.(); // refresh the full state now, not on the next tick
          },
          signal,
        );
      } catch {
        /* unsupported or unreachable — the watchdog carries the run */
      }
      // The stream just ended. Wake the loop rather than let it finish a
      // relaxed watchdog sleep — fast polling must resume immediately.
      const wasTrusted = stream.trusted;
      stream.open = false;
      stream.trusted = false;
      if (wasTrusted) wake?.();
      if (!signal.aborted) await sleep(1000, signal);
    }
  })();

  while (!signal.aborted) {
    try {
      const slide = await readSlide(pp, signal);
      const item = await readActive(pp, signal, slide); // slide feeds the PP 21 fallback
      fails = 0;
      // Slide count: PP 21.4+ hands it to us in slide_index (arrangement-
      // aware, zero extra requests). Older PP: it depends on the presentation
      // AND the active arrangement, so derive it from /v1/presentation/active
      // and refresh (expensive) only when either changes.
      let slideCount = slide.totalCues;
      if (slideCount == null) {
        const arrangement = { uuid: item.arrangementUuid, name: item.arrangementName };
        const cacheKey = slide.presUuid && `${slide.presUuid}|${arrangement.uuid || arrangement.name || ''}`;
        if (cacheKey && cacheKey !== countCache.key) {
          try {
            countCache.count = await readSlideCount(pp, signal, arrangement);
          } catch {
            countCache.count = null;
          }
          countCache.key = cacheKey;
        }
        slideCount = cacheKey && cacheKey === countCache.key ? countCache.count : null;
      }
      const state = {
        itemIndex: item.index,
        itemName: item.name,
        slideIndex: slide.slideIndex,
        slideCount,
        presName: slide.presName,
      };
      const key = JSON.stringify([state.itemIndex, state.slideIndex, state.slideCount]);
      if (key !== lastKey) {
        lastKey = key;
        onState(state);
      }
      // Divergence check: the watchdog found a slide the stream never pushed,
      // so the connection is open but lying (half-open socket, or a build that
      // streams selectively). Stop trusting it and go back to fast polling.
      if (stream.trusted && state.slideIndex !== stream.lastSlideIndex) {
        stream.trusted = false;
      }
    } catch (err) {
      if (++fails >= 3) throw err; // sustained failure → SSE shows offline
    }
    await sleepUntil(stream.trusted ? WATCHDOG_MS : intervalMs, signal, (fn) => { wake = fn; });
    wake = null;
  }
}
