import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRooms, validateSchedules, validateView } from './validate.js';

const goodRoom = {
  r1: {
    id: 'r1',
    name: 'Room One',
    mock: true,
    companion: { host: '10.0.0.5', port: 8000 },
    state: { variable: 'roomState' },
    modes: [
      { id: 'sunday', label: 'Sunday', match: 'SUNDAY', press: { page: 1, row: 0, column: 1 } },
    ],
  },
};

test('validateRooms accepts a well-formed config', () => {
  assert.doesNotThrow(() => validateRooms(structuredClone(goodRoom)));
});

test('validateRooms rejects a key/id mismatch', () => {
  const bad = { r1: { ...goodRoom.r1, id: 'other' } };
  assert.throws(() => validateRooms(bad), /must match its key/);
});

test('validateRooms accepts an empty mode list for an optional Room Mode setup', () => {
  const room = { r1: { ...goodRoom.r1, roomMode: false, modes: [] } };
  assert.doesNotThrow(() => validateRooms(room));
});

test('validateRooms rejects duplicate mode ids', () => {
  const m = { id: 'sunday', label: 'S', match: 'SUNDAY' };
  const bad = { r1: { ...goodRoom.r1, modes: [m, { ...m }] } };
  assert.throws(() => validateRooms(bad), /duplicate mode id/);
});

test('validateRooms rejects a non-integer press location', () => {
  const bad = structuredClone(goodRoom);
  bad.r1.modes[0].press.column = 'x';
  assert.throws(() => validateRooms(bad), /press\.column must be an integer/);
});

test('validateRooms requires companion+variable for live rooms', () => {
  const bad = { r1: { ...goodRoom.r1, mock: false, companion: undefined } };
  assert.throws(() => validateRooms(bad), /no companion\.host/);
});

test('validateSchedules accepts valid windows and rejects bad ones', () => {
  assert.doesNotThrow(() =>
    validateSchedules({ r1: [{ id: 'w', label: 'x', days: [0, 6], start: '07:00', end: '13:30', lock: ['standby'] }] }));
  assert.throws(() => validateSchedules({ r1: [{ days: [9], start: '07:00', end: '08:00', lock: [] }] }), /days/);
  assert.throws(() => validateSchedules({ r1: [{ days: [0], start: '7am', end: '08:00', lock: [] }] }), /HH:MM/);
});

// ── Views ───────────────────────────────────────────────────────────────────

const view = (over = {}) => ({ kind: 'dashboard', name: 'FOH', slug: 'foh', widgets: [], ...over });
// Each widget has its own authored size, and the validator now enforces it —
// so a fixture has to be a size that widget is actually allowed to be.
const SIZES = {
  countdown: [2, 1], loudness: [2, 1], 'loudness-trend': [2, 1], viewers: [1, 1],
  'run-of-show': [2, 3], 'now-next': [3, 1], 'room-mode': [2, 1], clock: [2, 1],
  'room-health': [1, 1],
};
const at = (type, x, y, w, h) => {
  const [dw, dh] = SIZES[type] ?? [1, 1];
  return { type, x, y, w: w ?? dw, h: h ?? dh };
};

test('validateView normalizes: derives the grid, orders by (y,x), drops junk', () => {
  const out = validateView(view({
    name: '  FOH  ',
    widgets: [at('viewers', 3, 1), at('countdown', 0, 0, 2, 1)],
  }));
  assert.equal(out.name, 'FOH', 'trimmed');
  assert.equal(out.columns, 6, 'derived from kind, never taken from the client');
  assert.equal(out.maxRows, null, 'a dashboard grows');
  assert.deepEqual(out.widgets.map((w) => w.type), ['countdown', 'viewers'], 'reading order');
  assert.deepEqual(out.widgets.map((w) => w.position), [0, 1]);

  // A client cannot pick its own grid.
  assert.equal(validateView(view({ columns: 12000, maxRows: 999 })).columns, 6);
  assert.equal(validateView(view({ kind: 'display', slug: 'wall' })).maxRows, 3);
});

test('validateView drops unknown widget config keys rather than rejecting', () => {
  // Same discipline as validateTile: a view written by a newer build should
  // lose the field this one doesn't understand, not fail to save.
  const out = validateView(view({
    widgets: [{ ...at('countdown', 0, 0), config: { planId: 'p1', timeId: 't1', junk: 'x', nested: {} } }],
  }));
  assert.deepEqual(out.widgets[0].config, { planId: 'p1', timeId: 't1' });
  assert.deepEqual(validateView(view({ widgets: [at('countdown', 0, 0)] })).widgets[0].config, {});
});

test('validateView keeps the header switch, which every widget has', () => {
  const config = (over) => validateView(view({
    widgets: [{ ...at('clock', 0, 0), config: over }],
  })).widgets[0].config;

  assert.deepEqual(config({ hideHeader: true }), { hideHeader: true });
  assert.deepEqual(config({ hideHeader: false }), { hideHeader: false });
  // Same discipline as every other flag: a non-boolean is dropped, not
  // coerced, so "yes" from a hand-edited layout does not become true.
  assert.deepEqual(config({ hideHeader: 'yes' }), {});
  assert.deepEqual(config({}), {});
});

test('validateView normalizes Companion variable rows and refuses bad ones', () => {
  const rows = (list) => validateView(view({
    widgets: [{ type: 'companion-variables', x: 0, y: 0, w: 2, h: 2, config: { rows: list } }],
  })).widgets[0].config.rows;

  assert.deepEqual(rows([{ variable: ' custom:roomState ', label: ' Mode ', display: 'status', ok: 'SUNDAY', junk: 1 }]),
    [{ variable: 'custom:roomState', label: 'Mode', display: 'status', ok: 'SUNDAY' }],
    'trimmed, junk dropped');
  assert.deepEqual(rows([{ variable: 'internal:time_hms' }]),
    [{ variable: 'internal:time_hms', display: 'text' }],
    'text is the default display');
  assert.deepEqual(rows([{ variable: 'atem:program', display: 'sideways' }])[0].display, 'text',
    'an unknown display falls back rather than failing the save');
  assert.deepEqual(rows([{ variable: 'x:y', display: 'bar', min: '10', max: '20' }])[0],
    { variable: 'x:y', display: 'bar', min: 10, max: 20 });

  // A malformed variable THROWS, unlike an unknown key: the row would render a
  // permanent blank, and save time is the only moment anyone is looking.
  for (const bad of ['', 'roomState', 'custom:room state', 'a:b:c', 'custom:' + 'x'.repeat(65)]) {
    assert.throws(() => rows([{ variable: bad }]), /not a Companion variable/, bad || '(empty)');
  }
  assert.throws(() => rows(Array.from({ length: 9 }, () => ({ variable: 'custom:a' }))), /at most 8 variables/);
  assert.throws(() => rows([{ variable: 'custom:a', label: 'x'.repeat(41) }]), /at most 40 characters/);
  assert.throws(() => rows([{ variable: 'custom:a', ok: 'x'.repeat(121) }]), /at most 120 characters/);
  assert.throws(() => rows([{ variable: 'custom:a', display: 'bar', min: 5, max: 5 }]), /above its min/);
  assert.throws(() => rows([{ variable: 'custom:a', display: 'bar', max: 'lots' }]), /must be a number/);

  // Two of them, which no other widget may be — the whole point of the rack.
  assert.doesNotThrow(() => validateView(view({
    widgets: [
      { type: 'companion-variables', x: 0, y: 0, w: 2, h: 2, config: {} },
      { type: 'companion-variables', x: 2, y: 0, w: 2, h: 2, config: {} },
    ],
  })));
});

test('validateView rejects every malformed layout', () => {
  assert.throws(() => validateView(view({ kind: 'wall' })), /dashboard or display/);
  assert.throws(() => validateView(view({ name: '' })), /1–60 characters/);
  assert.throws(() => validateView(view({ name: 'x'.repeat(61) })), /1–60 characters/);
  assert.throws(() => validateView(view({ slug: 'Not A Slug' })), /lowercase letters/);
  assert.throws(() => validateView(view({ widgets: Array.from({ length: 41 }, () => at('countdown', 0, 0)) })),
    /at most 40 widgets/);
  assert.throws(() => validateView(view({ widgets: [at('nope', 0, 0)] })), /Unknown widget type "nope"/);
  assert.throws(() => validateView(view({ widgets: [at('countdown', 0, 0), at('countdown', 1, 0)] })),
    /"countdown" can only be placed once/);
  assert.throws(() => validateView(view({ widgets: [{ ...at('countdown', 0, 0), x: 1.5 }] })),
    /integer grid coordinates/);
  assert.throws(() => validateView(view({ widgets: [at('countdown', 5, 0)] })),
    /outside the 6-column grid/);
  assert.throws(() => validateView(view({ widgets: [at('countdown', 0, 24)] })), /max 24 rows/);
  assert.throws(() => validateView(view({ kind: 'display', widgets: [at('now-next', 0, 3)] })),
    /does not fit a display's 3×3 grid/);
});

test('validateView takes a scale from a short list, defaulting to actual size', () => {
  // A display is read across a room, or as one tile of a video wall. This is
  // the client's to choose — the server cannot know what screen it is on.
  assert.equal(validateView(view()).scale, 1);
  assert.equal(validateView(view({ kind: 'display', slug: 'wall', scale: 2 })).scale, 2);
  assert.equal(validateView(view({ scale: '1.5' })).scale, 1.5, 'a form field sends a string');
  // A list, not a range: a slider offering 1.37 only ever makes blurry type.
  assert.throws(() => validateView(view({ scale: 1.37 })), /scale must be one of/);
  assert.throws(() => validateView(view({ scale: 0 })), /scale must be one of/);
  assert.throws(() => validateView(view({ scale: 99 })), /scale must be one of/);
});

test('validateView gives every widget adjustable width and height', () => {
  assert.doesNotThrow(() => validateView(view({ widgets: [at('run-of-show', 0, 0, 6, 5)] })));
  assert.throws(() => validateView(view({ widgets: [at('run-of-show', 0, 0, 2, 6)] })),
    /between 1×1 and 6×5 — got 2×6/);
  assert.doesNotThrow(() => validateView(view({ widgets: [at('run-of-show', 0, 0, 1, 1)] })));
  assert.doesNotThrow(() => validateView(view({ widgets: [at('loudness', 0, 0, 4, 2)] })));
  assert.doesNotThrow(() => validateView(view({ widgets: [at('room-health', 0, 0, 6, 5)] })));
  assert.throws(() => validateView(view({ widgets: [at('room-health', 0, 0, 7, 1)] })),
    /between 1×1 and 6×5 — got 7×1/);
});

test('validateView lets a display hold every read-only widget', () => {
  // A display is defined as non-interactive, and only run-of-show acts — so
  // the rest have to actually be placeable on one. This is the door that
  // matters: the palette already hides what it should, but a stored layout is
  // data and data arrives from anywhere.
  assert.doesNotThrow(() => validateView(view({
    kind: 'display', slug: 'wall',
    widgets: [at('room-mode', 0, 0), at('clock', 0, 1), at('loudness-trend', 0, 2)],
  })));
});

test('validateView names both widgets in an overlap', () => {
  assert.throws(
    () => validateView(view({ widgets: [at('loudness', 0, 0), at('viewers', 1, 0)] })),
    /Widgets "loudness" and "viewers" overlap/,
  );
  // Edge-touching is not overlapping.
  assert.doesNotThrow(() => validateView(view({ widgets: [at('loudness', 0, 0), at('viewers', 2, 0)] })));
});
