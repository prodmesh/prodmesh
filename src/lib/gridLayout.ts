// Grid geometry for Views — the placement rules, with no storage and no DOM.
//
// ─────────────────────────────────────────────────────────────────────────────
//  THIS FILE IS DUPLICATED at server/gridLayout.js. Keep them in step.
//
//  The server is plain JS and this is TypeScript, and there is no build step
//  between them (the Dockerfile copies server/ raw). The codebase already
//  answers this the same way: TILE_TYPES in server/validate.js duplicates
//  src/tiles/registry.tsx.
//
//  What makes the duplication safe is that the two copies are NOT peers. The
//  server is authoritative — it validates every save. This copy exists only to
//  draw the drop shadow in the right place and grey out an impossible drop. If
//  they ever disagree, the failure is a save refused with a clear message:
//  annoying, not corrupting.
//
//  Both test files run the same case table, and each names the other.
// ─────────────────────────────────────────────────────────────────────────────

export type ViewKind = 'dashboard' | 'display';

export interface Grid {
  columns: number;
  /** null = grows downward. A number = a hard ceiling that must fit on screen. */
  maxRows: number | null;
  /** Rows an empty canvas still shows, so it looks like a canvas. */
  defaultRows?: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Placement extends Box {
  id?: string;
  type: string;
  position?: number;
}

/**
 * The two canvases, as data rather than as branches on `kind`.
 *
 * A dashboard grows downward; a display is a hard 3×3 because it is a tile on
 * a video multiview and a scrollbar there is a fault, not a feature.
 */
export const GRID: Record<ViewKind, Grid> = {
  dashboard: { columns: 6, maxRows: null, defaultRows: 5 },
  display: { columns: 3, maxRows: 3 },
};

/**
 * A dashboard's rows are "unbounded" in the sense a user means it — the canvas
 * grows as you fill it. There is still a number, because `y` round-trips
 * through a database and rendering 2^31 grid rows is a denial of service the
 * browser performs on itself.
 */
export const MAX_ROWS_HARD = 24;

export const gridFor = (kind: string): Grid | null =>
  kind === 'dashboard' || kind === 'display' ? GRID[kind] : null;

/** Do two boxes share a cell? Edge-touching is NOT overlap. */
export function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** In bounds for this grid. Says nothing about neighbours. */
export function fits(grid: Grid, box: Box): boolean {
  if (box.x < 0 || box.y < 0 || box.w < 1 || box.h < 1) return false;
  if (box.x + box.w > grid.columns) return false;
  return box.y + box.h <= (grid.maxRows ?? MAX_ROWS_HARD);
}

/**
 * Every colliding pair.
 *
 * Pairwise rather than a bitmap because the caller has to NAME both widgets in
 * the error — "Loudness overlaps Countdown" is actionable and "invalid layout"
 * is not. n ≤ 40, so this is at most 780 comparisons.
 */
export function collisions(placements: Placement[]): [Placement, Placement][] {
  const pairs: [Placement, Placement][] = [];
  for (let i = 0; i < placements.length; i += 1) {
    for (let j = i + 1; j < placements.length; j += 1) {
      if (overlaps(placements[i], placements[j])) pairs.push([placements[i], placements[j]]);
    }
  }
  return pairs;
}

/**
 * Rows the content occupies.
 *
 * The deepest placement, NOT padded up to `defaultRows`: a live dashboard that
 * reserved five rows for one widget would be four rows of nothing on a wall.
 * `defaultRows` is the EDITOR's starting canvas — somewhere to drop into — and
 * that is the editor's business, not this function's.
 */
export function rowCount(grid: Grid, placements: Placement[]): number {
  if (grid.maxRows != null) return grid.maxRows;
  return Math.max(1, placements.reduce((max, p) => Math.max(max, p.y + p.h), 0));
}

/**
 * Cell key → the id occupying it.
 *
 * A sparse Map rather than a 2D array because dashboard rows are unbounded:
 * allocating rows nobody has used is the wrong default when the whole point is
 * that the canvas grows. `ignoreId` lets the editor probe a candidate position
 * for the widget currently being dragged without colliding with itself.
 */
export function occupancy(placements: Placement[], ignoreId: string | null = null): Map<string, string> {
  const cells = new Map<string, string>();
  for (const p of placements) {
    if (p.id != null && p.id === ignoreId) continue;
    for (let dy = 0; dy < p.h; dy += 1) {
      for (let dx = 0; dx < p.w; dx += 1) cells.set(`${p.x + dx},${p.y + dy}`, p.id ?? p.type);
    }
  }
  return cells;
}

/** Is this box in bounds AND clear of everything in `cells`? */
export function isFree(grid: Grid, cells: Map<string, string>, box: Box): boolean {
  if (!fits(grid, box)) return false;
  for (let dy = 0; dy < box.h; dy += 1) {
    for (let dx = 0; dx < box.w; dx += 1) {
      if (cells.has(`${box.x + dx},${box.y + dy}`)) return false;
    }
  }
  return true;
}

/**
 * Topmost-then-leftmost free box of this size, or null if there is nowhere.
 *
 * This is what the palette's Add button uses, and it is also what tells a
 * display's palette to grey a widget out: on a dashboard it always succeeds
 * (grow downward), on a full 3×3 it returns null, which IS the "No room"
 * signal.
 */
export function findFirstFit(
  grid: Grid,
  placements: Placement[],
  size: { w: number; h: number },
): { x: number; y: number } | null {
  const cells = occupancy(placements);
  const limit = grid.maxRows ?? MAX_ROWS_HARD;
  for (let y = 0; y + size.h <= limit; y += 1) {
    for (let x = 0; x + size.w <= grid.columns; x += 1) {
      if (isFree(grid, cells, { x, y, w: size.w, h: size.h })) return { x, y };
    }
  }
  return null;
}

/**
 * The largest box between `preferred` and `min` that fits, and where it goes.
 *
 * `findFirstFit` asks one question — "does this exact rectangle exist?" — and a
 * no meant the widget could not be added at all. On a 3x3 display that is
 * brutal: a single 2x2 widget leaves five free cells but no 2x2 hole, so every
 * other 2x2 widget reads as "No room left" against a grid that is half empty.
 * The operator's only recourse was to delete something, add the new widget,
 * shrink it, and put the deleted one back.
 *
 * So try the authored size first and step down toward the widget's declared
 * minimum, largest area first, and place the biggest thing that actually fits.
 * With room, a widget still opens at the size its author chose; without room it
 * arrives small rather than not at all. Only when even the minimum has nowhere
 * to go is the answer still no — and that answer is now true.
 *
 * The floor is the widget's own claim about where it stays legible, so a
 * shrunk-to-fit placement is never one its author did not sign off on.
 */
export function findBestFit(
  grid: Grid,
  placements: Placement[],
  preferred: { w: number; h: number },
  min: { w: number; h: number } = preferred,
): { x: number; y: number; w: number; h: number } | null {
  const candidates: { w: number; h: number }[] = [];
  for (let w = Math.min(min.w, preferred.w); w <= preferred.w; w += 1) {
    for (let h = Math.min(min.h, preferred.h); h <= preferred.h; h += 1) {
      candidates.push({ w, h });
    }
  }
  // Biggest first; between equal areas prefer the shape closest to what the
  // widget asked for, so a 2x3 does not silently become a 3x2.
  candidates.sort((a, b) => (b.w * b.h) - (a.w * a.h)
    || (Math.abs(a.w - preferred.w) + Math.abs(a.h - preferred.h))
     - (Math.abs(b.w - preferred.w) + Math.abs(b.h - preferred.h)));

  for (const size of candidates) {
    const at = findFirstFit(grid, placements, size);
    if (at) return { ...at, ...size };
  }
  return null;
}

/**
 * Sort by (y, x) and renumber `position`.
 *
 * Not cosmetic: it makes the stored order the READING order, which is what
 * lets a narrow screen fall back to a single column in a sensible sequence
 * with pure CSS and no JavaScript. A 2D canvas has no honest responsive story;
 * degrading to a priority order is at least truthful.
 */
export function normalize<T extends Placement>(placements: T[]): T[] {
  return [...placements]
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((p, position) => ({ ...p, position }));
}
