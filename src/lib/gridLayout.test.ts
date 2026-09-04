// Grid geometry — pure integer arithmetic, no DOM.
//
// THE SAME CASE TABLE RUNS IN server/gridLayout.test.js. gridLayout.ts and
// gridLayout.js are deliberate duplicates (frontend is TS, server is JS, no
// build step between them); these twinned tests are what keeps them honest.
// Change a case here, change it there.

import { describe, expect, it } from 'vitest';
import {
  GRID,
  MAX_ROWS_HARD,
  collisions,
  findBestFit,
  findFirstFit,
  fits,
  isFree,
  normalize,
  occupancy,
  overlaps,
  rowCount,
  type Placement,
} from './gridLayout';

const box = (x: number, y: number, w = 1, h = 1) => ({ x, y, w, h });
const at = (type: string, x: number, y: number, w = 1, h = 1): Placement => ({ type, ...box(x, y, w, h) });

describe('gridLayout', () => {
  it('overlaps: edge-touching is not overlapping', () => {
    // The classic off-by-one. A 2-wide widget at x=0 occupies columns 0 and 1,
    // so x=2 is its neighbour, not its collision.
    expect(overlaps(box(0, 0, 2, 1), box(2, 0, 2, 1))).toBe(false); // side by side
    expect(overlaps(box(0, 0, 1, 2), box(0, 2, 1, 2))).toBe(false); // stacked
    expect(overlaps(box(0, 0, 2, 2), box(1, 1, 2, 2))).toBe(true); // corner into corner
    expect(overlaps(box(0, 0, 6, 5), box(3, 2))).toBe(true); // contained
    expect(overlaps(box(1, 1), box(1, 1))).toBe(true); // identical
  });

  it('fits: each boundary of each grid', () => {
    const dash = GRID.dashboard;
    expect(fits(dash, box(4, 0, 2, 1))).toBe(true); // flush against the right edge
    expect(fits(dash, box(5, 0, 2, 1))).toBe(false); // one column over
    expect(fits(dash, box(0, MAX_ROWS_HARD - 1))).toBe(true);
    expect(fits(dash, box(0, MAX_ROWS_HARD))).toBe(false);
    expect(fits(dash, box(-1, 0))).toBe(false);
    expect(fits(dash, box(0, 0, 0, 1))).toBe(false);

    const disp = GRID.display;
    expect(fits(disp, box(0, 0, 3, 3))).toBe(true); // a display filled by one widget
    expect(fits(disp, box(0, 0, 3, 4))).toBe(false); // a display never scrolls
    expect(fits(disp, box(1, 0, 3, 1))).toBe(false);
  });

  it('collisions names both widgets in a pair', () => {
    const a = at('loudness', 0, 0, 2, 2);
    const b = at('countdown', 1, 1, 2, 2);
    const c = at('viewers', 4, 0, 2, 1);
    const pairs = collisions([a, b, c]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].map((p) => p.type)).toEqual(['loudness', 'countdown']);
    expect(collisions([a, c])).toEqual([]);
  });

  it('occupancy skips the widget being dragged', () => {
    const placements: Placement[] = [
      { id: 'w1', type: 'a', ...box(0, 0, 2, 2) },
      { id: 'w2', type: 'b', ...box(2, 0) },
    ];
    expect(occupancy(placements).size).toBe(5);
    expect(occupancy(placements, 'w1').size).toBe(1); // its own cells are re-enterable
    expect(isFree(GRID.dashboard, occupancy(placements, 'w1'), box(0, 0, 2, 2))).toBe(true);
    expect(isFree(GRID.dashboard, occupancy(placements), box(0, 0, 2, 2))).toBe(false);
  });

  it('findBestFit: shrinks toward the minimum rather than refusing', () => {
    // The case this exists for. A 3x3 display holds exactly one 2x2 — any
    // second one overlaps — so a single 2x2 widget used to make five empty
    // cells unreachable to every other 2x2 widget.
    const full2x2 = [at('big', 0, 0, 2, 2)];
    expect(findFirstFit(GRID.display, full2x2, { w: 2, h: 2 })).toBeNull();
    // 1x2 rather than 1x1: the leftover column is two cells tall, and the
    // search takes the biggest thing that fits, not merely something that does.
    expect(findBestFit(GRID.display, full2x2, { w: 2, h: 2 }, { w: 1, h: 1 }))
      .toEqual({ x: 2, y: 0, w: 1, h: 2 });
  });

  it('findBestFit: takes the largest that fits, and keeps the asked-for shape', () => {
    const dash = GRID.dashboard;
    // Room for everything: nothing shrinks.
    expect(findBestFit(dash, [], { w: 2, h: 2 }, { w: 1, h: 1 }))
      .toEqual({ x: 0, y: 0, w: 2, h: 2 });
    // A 2-wide, 1-tall gap in an otherwise full first row: 2x1 beats 1x1.
    const row = [at('a', 0, 0, 4, 1), at('b', 0, 1, 6, 5)];
    expect(findBestFit({ ...dash, maxRows: 6 }, row, { w: 2, h: 2 }, { w: 1, h: 1 }))
      .toEqual({ x: 4, y: 0, w: 2, h: 1 });
  });

  it('findBestFit: without a minimum a widget does not shrink at all', () => {
    // Omitting the floor means the widget never vouched for a smaller size, so
    // the answer stays no rather than silently producing an unreadable tile.
    const full2x2 = [at('big', 0, 0, 2, 2)];
    expect(findBestFit(GRID.display, full2x2, { w: 2, h: 2 })).toBeNull();
  });

  it('findFirstFit: empty grid, into a gap, and a full display', () => {
    const dash = GRID.dashboard;
    expect(findFirstFit(dash, [], { w: 2, h: 3 })).toEqual({ x: 0, y: 0 });

    // Columns 0–1 and 3–4 taken on row 0: the 1-wide gap at column 2 is the
    // topmost-then-leftmost fit, ahead of the empty row below it.
    const withGap: Placement[] = [
      { id: 'a', type: 'a', ...box(0, 0, 2, 1) },
      { id: 'b', type: 'b', ...box(3, 0, 2, 1) },
    ];
    expect(findFirstFit(dash, withGap, { w: 1, h: 1 })).toEqual({ x: 2, y: 0 });
    expect(findFirstFit(dash, withGap, { w: 2, h: 1 })).toEqual({ x: 0, y: 1 });

    // A dashboard always has room: it grows downward.
    const deep: Placement[] = Array.from({ length: 5 }, (_, y) => ({
      id: `r${y}`, type: 'r', ...box(0, y, 6, 1),
    }));
    expect(findFirstFit(dash, deep, { w: 6, h: 1 })).toEqual({ x: 0, y: 5 });

    // A display does not. `null` is the palette's "No room" signal.
    expect(findFirstFit(GRID.display, [at('big', 0, 0, 3, 3)], { w: 1, h: 1 })).toBeNull();
    expect(findFirstFit(GRID.display, [], { w: 3, h: 1 })).toEqual({ x: 0, y: 0 });
  });

  it('rowCount is the content height, not the editor canvas', () => {
    const dash = GRID.dashboard;
    // NOT defaultRows: a live dashboard reserving five rows for one widget is
    // four rows of nothing on a wall. defaultRows is the editor's problem.
    expect(rowCount(dash, [])).toBe(1);
    expect(rowCount(dash, [at('a', 0, 0, 1, 2)])).toBe(2);
    expect(rowCount(dash, [at('a', 0, 5, 1, 3)])).toBe(8); // deepest placement wins
    expect(rowCount(GRID.display, [])).toBe(3); // a display is always exactly its grid
    expect(rowCount(GRID.display, [at('a', 0, 0)])).toBe(3);
  });

  it('normalize orders by (y, x) — stored order is reading order', () => {
    const out = normalize([at('c', 3, 1), at('a', 4, 0), at('b', 0, 0)]);
    expect(out.map((p) => p.type)).toEqual(['b', 'a', 'c']);
    expect(out.map((p) => p.position)).toEqual([0, 1, 2]);
  });
});
