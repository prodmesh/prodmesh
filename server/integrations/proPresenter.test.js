import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseActive,
  mapIndexToItemId,
  isConfigured,
  slideTotal,
  targetSecondsOfDay,
  parseHms,
  parseTimers,
  pickTimer,
  normalizePlaylist,
  normalizePlaylistItem,
  adjacentPlayable,
  runtimeFrom,
  readConsoleState,
} from './proPresenter.js';

test('isConfigured needs a host', () => {
  assert.equal(isConfigured(null), false);
  assert.equal(isConfigured({ port: 62202 }), false);
  assert.equal(isConfigured({ host: '127.0.0.1' }), true);
});

test('parseActive pulls the active playlist item (fields nested under .id)', () => {
  // Shape verified against the live ProPresenter API.
  const body = {
    presentation: {
      playlist: { uuid: 'p1', name: 'Colossians …', index: 2 },
      item: { uuid: 'pres1', name: 'Break Out', index: 4294967295 },
      playlist_item: {
        id: { uuid: 'i5', name: 'Break Out', index: 5 },
        type: 'presentation',
        presentation_info: { arrangement_name: 'AOW', arrangement_uuid: 'arr-aow' },
      },
    },
  };
  assert.deepEqual(parseActive(body), {
    index: 5,
    name: 'Break Out',
    uuid: 'i5',
    arrangementUuid: 'arr-aow',
    arrangementName: 'AOW',
    playlistName: 'Colossians …',
  });
  // Nothing triggered → playlist_item is null.
  assert.deepEqual(parseActive({ presentation: { playlist: null, playlist_item: null } }), {
    index: null, name: null, uuid: null, arrangementUuid: null, arrangementName: null, playlistName: null,
  });
});

test('playlist normalization preserves PP indexes and treats headers as non-playable', () => {
  const playlist = normalizePlaylist({ playlist: { name: 'Sunday' }, items: [
    { id: { index: 0, name: 'Walk-in' }, type: 'header' },
    { id: { index: 1, name: 'Song' }, type: 'presentation', presentation_info: { presentation_uuid: '11111111-1111-1111-1111-111111111111' } },
    { id: { index: 3, name: 'Message' }, is_pco: true, presentation_info: { presentation_uuid: '22222222-2222-2222-2222-222222222222', name: 'John 1' } },
  ] });
  assert.equal(playlist.name, 'Sunday');
  assert.deepEqual(playlist.items.map((x) => [x.index, x.triggerable, x.isPco]), [[0, false, false], [1, true, false], [3, true, true]]);
  assert.equal(playlist.items[2].presentationTitle, 'John 1');
});

test('adjacent playable skips headers and raw index gaps', () => {
  const rows = [
    normalizePlaylistItem({ id: { index: 0, name: 'Header' }, type: 'header' }),
    normalizePlaylistItem({ id: { index: 2, name: 'Song' }, presentation_info: { presentation_uuid: '11111111-1111-1111-1111-111111111111' } }),
    normalizePlaylistItem({ id: { index: 4, name: 'Folder' }, type: 'folder' }),
    normalizePlaylistItem({ id: { index: 5, name: 'Message' }, is_pco: true }),
  ];
  assert.equal(adjacentPlayable(rows, 0, 1)?.index, 2);
  assert.equal(adjacentPlayable(rows, 4, -1)?.index, 2);
  assert.equal(adjacentPlayable(rows, 2, 1)?.index, 5);
});

test('runtime separates zero-based API indexes from one-based operator labels', () => {
  assert.deepEqual(runtimeFrom({ presUuid: 'p', slideIndex: 0, totalCues: 5 }, { index: 3 }, [], null), {
    activePresentationUuid: 'p', activePlaylistIndex: 3, activeCueIndex: 0,
    activeCueNumber: 1, totalCues: 5, timers: [], video: null,
  });
});

// PC items (subset) vs ProPresenter names that differ in spacing/case/suffix.
const items = [
  { id: 'a', title: 'Pre-Service Slides' },
  { id: 'b', title: 'Welcome/Communication' },
  { id: 'c', title: 'Breakout' },
  { id: 'd', title: 'Great Is Thy Faithfulness (Beginning To End)' },
  { id: 'e', title: 'Jesus Christ Over Everything' },
];

test('mapIndexToItemId matches by index (primary)', () => {
  assert.equal(mapIndexToItemId(items, { index: 2, name: 'Break Out' }), 'c');
  assert.equal(mapIndexToItemId(items, { index: 0, name: 'Pre Service' }), 'a');
  assert.equal(mapIndexToItemId(items, { index: 4, name: 'Jesus Christ Over Everything - [ NOW ]' }), 'e');
});

test('mapIndexToItemId falls back to name when index is off', () => {
  // index points out of range → name match rescues it
  assert.equal(mapIndexToItemId(items, { index: 99, name: 'Breakout' }), 'c');
});

test('mapIndexToItemId returns null when nothing is active', () => {
  assert.equal(mapIndexToItemId(items, { index: null, name: null }), null);
  assert.equal(mapIndexToItemId(items, null), null);
});

test('slideTotal sums raw groups when no arrangement is selected', () => {
  const pres = {
    current_arrangement: '',
    groups: [
      { uuid: 'g1', slides: [1] },
      { uuid: 'g2', slides: [1, 2, 3] },
      { uuid: 'g3', slides: [1, 2] },
    ],
    arrangements: [{ id: { uuid: 'a1' }, groups: ['g1', 'g2'] }],
  };
  assert.equal(slideTotal(pres), 6);
});

test('slideTotal expands the selected arrangement (groups repeat)', () => {
  const pres = {
    current_arrangement: 'a1',
    groups: [
      { uuid: 'v', slides: [1, 2] }, // verse: 2 slides
      { uuid: 'c', slides: [1] }, // chorus: 1 slide
    ],
    arrangements: [{ id: { uuid: 'a1' }, groups: ['v', 'c', 'v', 'c', 'c'] }], // 2+1+2+1+1 = 7
  };
  assert.equal(slideTotal(pres), 7);
});

test('slideTotal selects the arrangement from the playlist item (uuid, then name)', () => {
  const pres = {
    current_arrangement: '', // presentation does not report it — item does
    groups: [
      { uuid: 'v', slides: [1, 2] },
      { uuid: 'c', slides: [1] },
    ],
    arrangements: [
      { id: { uuid: 'now', name: 'NOW' }, groups: ['v', 'c'] }, // 3
      { id: { uuid: 'aow', name: 'AOW' }, groups: ['v', 'c', 'v', 'c', 'c'] }, // 7
    ],
  };
  assert.equal(slideTotal(pres, { uuid: 'aow' }), 7);
  assert.equal(slideTotal(pres, { name: 'AOW' }), 7);
  assert.equal(slideTotal(pres, { uuid: 'now' }), 3);
  // Unknown arrangement → raw group sum fallback.
  assert.equal(slideTotal(pres, { uuid: 'nope', name: 'nope' }), 3);
});

test('slideTotal handles null', () => {
  assert.equal(slideTotal(null), null);
});

// ── Timers (fixtures are real /v1/timers + /v1/timers/current payloads) ──────

test('targetSecondsOfDay normalizes the 12-hour time_of_day + period', () => {
  assert.equal(targetSecondsOfDay({ time_of_day: 25200, period: 'am' }), 25200); // 7:00 AM
  assert.equal(targetSecondsOfDay({ time_of_day: 19800, period: 'pm' }), 63000); // 5:30 PM
  assert.equal(targetSecondsOfDay({ time_of_day: 1800, period: 'pm' }), 45000); // 12:30 PM
  // Robust if PP ever reports absolute seconds with a redundant period.
  assert.equal(targetSecondsOfDay({ time_of_day: 63000, period: 'pm' }), 63000);
  assert.equal(targetSecondsOfDay(null), null);
});

test('parseHms parses remaining time', () => {
  assert.equal(parseHms('07:29:00'), 26940);
  assert.equal(parseHms('00:00:05'), 5);
  assert.equal(parseHms('garbage'), null);
  assert.equal(parseHms(null), null);
});

const TIMER_DEFS = [
  {
    id: { name: 'Service Start Timer', index: 0, uuid: '1DD1' },
    allows_overrun: false,
    count_down_to_time: { time_of_day: 19800, period: 'pm' },
  },
];
const TIMER_CURRENT = [
  { id: { uuid: '1DD1', name: 'Service Start Timer', index: 0 }, time: '07:29:00', state: 'running' },
];

test('parseTimers merges definitions with live values', () => {
  const [t] = parseTimers(TIMER_DEFS, TIMER_CURRENT);
  assert.equal(t.name, 'Service Start Timer');
  assert.equal(t.state, 'running');
  assert.equal(t.remainingSeconds, 26940);
  assert.equal(t.targetSecondsOfDay, 63000);
  assert.equal(t.countsDownToTime, true);
});

test('pickTimer prefers the configured name, then count-down-to-time', () => {
  const timers = [
    { name: 'Sermon Elapsed', countsDownToTime: false },
    { name: 'Service Start Timer', countsDownToTime: true },
  ];
  assert.equal(pickTimer(timers, 'Sermon Elapsed').name, 'Sermon Elapsed');
  assert.equal(pickTimer(timers).name, 'Service Start Timer'); // no config → countdown
  assert.equal(pickTimer([{ name: 'Only', countsDownToTime: false }]).name, 'Only');
  assert.equal(pickTimer([]), null);
});

test('an unreachable ProPresenter is an error, not an empty console', () => {
  // Every read inside readConsoleState swallows its own failure so one bad
  // endpoint cannot erase the rest. That made a dead machine look identical to
  // a live one showing nothing, and the watcher reported `connected: true`
  // right through an outage. TEST-NET-1 is guaranteed unroutable.
  return assert.rejects(
    () => readConsoleState({ host: '192.0.2.99', port: 1025 }),
    /unreachable/i,
  );
});

test('PP 21: the console resolves the live item when playlist/active is empty', async (t) => {
  // Reproduces a real service, 2026-09-06: /v1/playlist/active answered with
  // nothing while Pre-Service Slides was genuinely on screen, so the console
  // showed no active item — even though slide_index knew the presentation and
  // the focused playlist listed it. readActive already recovered from this;
  // readConsoleState had been written without the same rescue.
  const PRES = 'E7B0566B-7F6B-4BCE-B6EE-1358294E5E50';
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });

  const body = (value) => ({ ok: true, status: 200, json: async () => value, headers: new Map() });
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^http:\/\/[^/]+/, '');
    // PP 21's regression: present, well-formed, and entirely empty.
    if (path === '/v1/playlist/active') return body({ presentation: { playlist: null, playlist_item: null } });
    if (path === '/v1/presentation/slide_index') {
      return body({ presentation_index: { index: 5, presentation_id: { uuid: PRES, name: 'Pre-Service Slides' } } });
    }
    if (path === '/v1/playlist/focused') {
      return body({
        playlist: { uuid: 'PL1', name: 'Summer in the Psalms — September 6, 2026' },
        playlist_item: { id: { uuid: 'i0', name: 'Pre-Service Slides', index: 0 }, presentation_info: { presentation_uuid: PRES } },
        items: [{ id: { uuid: 'i0', name: 'Pre-Service Slides', index: 0 }, type: 'presentation', presentation_info: { presentation_uuid: PRES } }],
      });
    }
    return body({});
  };

  const state = await readConsoleState({ host: '192.0.2.15', port: 1025 });
  // The whole point: an index, not null, from the presentation uuid alone.
  assert.equal(state.runtime.activePlaylistIndex, 0);
  assert.equal(state.runtime.activePresentationUuid, PRES);
  // And the playlist it was found in is named rather than reported absent.
  assert.equal(state.activePlaylist?.name, 'Summer in the Psalms — September 6, 2026');
});
