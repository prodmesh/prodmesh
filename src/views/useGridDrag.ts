import { useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { isFree, occupancy, sizeCandidates, type Grid } from '../lib/gridLayout';
import type { WidgetSize } from '../widgets/types';
import type { ViewPlacement } from '../api';

// ─────────────────────────────────────────────────────────────────────────────
//  Dragging on the view canvas.
//
//  Pointer events with setPointerCapture, not document-level mousemove. That
//  is what makes a booth tablet and a stylus work with no extra code — and it
//  is why the canvas must carry `touch-action: none`, or the browser scrolls
//  the page instead of moving the widget.
//
//  Dragging is an ENHANCEMENT. Every palette entry also has an Add button and
//  every placed card can be moved from the keyboard, so the editor is complete
//  and testable without a single pointer event. See ViewEditor.
// ─────────────────────────────────────────────────────────────────────────────

export interface Cell {
  x: number;
  y: number;
}

/** Track geometry, measured once per drag rather than per pointermove. */
export interface Metrics {
  rect: DOMRect;
  /** Used column widths in px, as the browser resolved them. */
  cols: number[];
  /** Used row heights in px. */
  rows: number[];
  gapX: number;
  gapY: number;
}

/**
 * Parse a RESOLVED `grid-template-*` value ("184px 184px …") into numbers.
 *
 * Only px tokens count. An element the browser has not laid out reports the
 * specified value instead — "repeat(6, minmax(0px, 1fr))" — and a loose
 * parseFloat turns its tail into the number 1, i.e. one track a metre wide,
 * which silently drops every drag at (0,0). Returning nothing is what lets the
 * caller refuse the drag instead of doing the wrong thing quietly.
 */
export const tracksOf = (value: string): number[] =>
  value
    .split(/\s+/)
    .filter((t) => /^-?\d*\.?\d+px$/.test(t))
    .map(parseFloat);

/**
 * Which track an offset falls in.
 *
 * Walks the ACTUAL track sizes rather than dividing by a count. Rows are
 * `minmax(unit, auto)` so a widget with tall content makes its row taller than
 * its neighbours — divide-by-count silently drifts a whole row down the canvas
 * the moment that happens, and the drop lands somewhere the cursor never was.
 * Clamped at both ends: past the last track means the last track, and the
 * editor renders a spare row so there is somewhere to extend into.
 */
export function trackIndex(tracks: number[], gap: number, offset: number): number {
  if (offset < 0 || tracks.length === 0) return 0;
  let edge = 0;
  for (let i = 0; i < tracks.length; i += 1) {
    edge += tracks[i] + (i < tracks.length - 1 ? gap : 0);
    if (offset < edge) return i;
  }
  return tracks.length - 1;
}

/**
 * Which cell is under the pointer.
 *
 * Exported and pure because this is the half unit tests can certify: jsdom
 * cannot simulate a drag, so the gesture itself is verified by hand on a mouse
 * and a touchscreen, and the arithmetic is verified here.
 */
export function cellFromPoint(m: Metrics, clientX: number, clientY: number): Cell {
  return {
    x: trackIndex(m.cols, m.gapX, clientX - m.rect.left),
    y: trackIndex(m.rows, m.gapY, clientY - m.rect.top),
  };
}

/**
 * Where a dragged box's top-left lands, given where inside it the pointer took
 * hold.
 *
 * The grab offset is in GRID UNITS, not pixels. Without it, grabbing a 2×3
 * widget by its bottom-right corner teleports its top-left under the cursor
 * and the whole thing jumps.
 */
export function boxFromPointer(m: Metrics, at: Cell, grab: Cell, size: WidgetSize): Cell {
  const limit = (v: number, span: number, max: number) => Math.max(0, Math.min(v, max - span));
  return {
    x: limit(at.x - grab.x, size.w, m.cols.length),
    // Rows are unbounded on a dashboard, so only the top is clamped here;
    // isFree() is what refuses a drop past the bottom of a display.
    y: Math.max(0, at.y - grab.y),
  };
}

export interface SizeBounds {
  min: WidgetSize;
  max: WidgetSize;
}

/**
 * The size a resize drag has reached: the origin stays put and the far corner
 * follows the pointer, clamped to what the widget allows.
 *
 * Exported and pure because the first version of this was glue inside the
 * pointermove handler, reading its bounds from the wrong value — and glue
 * inside a pointer handler is precisely what jsdom cannot test. It shipped
 * clamping every drag to 1×1.
 */
export function resizeFromPointer(origin: Cell, under: Cell, bounds: SizeBounds): WidgetSize {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));
  return {
    w: clamp(under.x - origin.x + 1, bounds.min.w, bounds.max.w),
    h: clamp(under.y - origin.y + 1, bounds.min.h, bounds.max.h),
  };
}

export type Drag =
  | { kind: 'none' }
  | {
      kind: 'add' | 'move' | 'resize';
      /** Registry type for an add; the placement id for a move or resize. */
      ref: string;
      size: WidgetSize;
      grab: Cell;
      at: Cell | null;
      ok: boolean;
      /** Captured at pointerdown for a resize — the caller resolves them from
       *  the widget TYPE, which `ref` is not once a placement exists. */
      bounds?: SizeBounds;
    };

export function useGridDrag({
  canvas,
  grid,
  placements,
  onAdd,
  onMove,
  onResize,
}: {
  canvas: RefObject<HTMLDivElement | null>;
  grid: Grid;
  placements: ViewPlacement[];
  onAdd: (type: string, at: Cell, size: WidgetSize) => void;
  onMove: (id: string, at: Cell) => void;
  onResize: (id: string, size: WidgetSize) => void;
}) {
  const [drag, setDrag] = useState<Drag>({ kind: 'none' });
  const metrics = useRef<Metrics | null>(null);

  const measure = (): Metrics | null => {
    const el = canvas.current;
    if (!el) return null;
    const style = getComputedStyle(el);
    const cols = tracksOf(style.gridTemplateColumns);
    const rows = tracksOf(style.gridTemplateRows);
    // No resolved tracks means the canvas has no layout yet. Dragging against
    // guessed geometry would land the widget somewhere the cursor never was,
    // so there is nothing to do but decline.
    if (!cols.length || !rows.length) return null;
    return {
      rect: el.getBoundingClientRect(),
      cols,
      rows,
      gapX: parseFloat(style.columnGap) || 0,
      gapY: parseFloat(style.rowGap) || 0,
    };
  };

  const begin = (
    kind: 'add' | 'move' | 'resize',
    ref: string,
    size: WidgetSize,
    grab: Cell,
    e: ReactPointerEvent,
    bounds?: SizeBounds,
  ) => {
    // Left button / primary touch only: a right-click drag would leave the
    // context menu open over a half-moved widget.
    if (e.button !== 0) return;
    e.preventDefault();
    // Capture is what routes the rest of the gesture here rather than to
    // whatever is under the cursor. It throws if the pointer is no longer
    // active — a mouse released outside the window, a touch already cancelled
    // — and losing capture is worth degrading for, not crashing the editor for.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* the drag still works while the pointer stays over this element */
    }
    const m = measure();
    if (!m) return;
    metrics.current = m;
    setDrag({ kind, ref, size, grab, at: null, ok: false, bounds });
  };

  const move = (e: ReactPointerEvent) => {
    if (drag.kind === 'none') return;
    const m = metrics.current;
    if (!m) return;
    const under = cellFromPoint(m, e.clientX, e.clientY);
    const cells = occupancy(placements, drag.kind === 'add' ? null : drag.ref);

    if (drag.kind === 'resize' && drag.bounds) {
      // Growing INTO a neighbour is refused rather than shoving it: a layout
      // should not rearrange itself behind you.
      const origin = drag.grab;
      const size = resizeFromPointer(origin, under, drag.bounds);
      setDrag({ ...drag, size, at: origin, ok: isFree(grid, cells, { ...origin, ...size }) });
      return;
    }

    // An add carries the widget's authored size as `max` and its declared
    // floor as `min`. Where the full size will not fit under the pointer, try
    // smaller ones rather than only reporting a refusal: the person has already
    // chosen WHERE, so the only thing left to negotiate is how big. The ghost
    // resizes as they move, which is the feedback that makes it obvious.
    if (drag.kind === 'add' && drag.bounds) {
      for (const size of sizeCandidates(drag.bounds.max, drag.bounds.min)) {
        const box = boxFromPointer(m, under, drag.grab, size);
        if (isFree(grid, cells, { ...box, ...size })) {
          setDrag({ ...drag, size, at: box, ok: true });
          return;
        }
      }
      // Nothing fits here, so hold the authored size and let it read as refused
      // — a ghost that shrank AND stayed red would suggest the size was at
      // fault when the position is.
      const box = boxFromPointer(m, under, drag.grab, drag.bounds.max);
      setDrag({ ...drag, size: drag.bounds.max, at: box, ok: false });
      return;
    }

    const at = boxFromPointer(m, under, drag.grab, drag.size);
    setDrag({ ...drag, at, ok: isFree(grid, cells, { ...at, ...drag.size }) });
  };

  const end = () => {
    if (drag.kind !== 'none' && drag.at && drag.ok) {
      if (drag.kind === 'add') onAdd(drag.ref, drag.at, drag.size);
      else if (drag.kind === 'resize') onResize(drag.ref, drag.size);
      else onMove(drag.ref, drag.at);
    }
    metrics.current = null;
    setDrag({ kind: 'none' });
  };

  const cancel = () => {
    metrics.current = null;
    setDrag({ kind: 'none' });
  };

  /** Spread onto a palette entry. */
  const addHandlers = (type: string, size: WidgetSize, min: WidgetSize = size) => ({
    onPointerDown: (e: ReactPointerEvent) =>
      begin('add', type, size, { x: 0, y: 0 }, e, { min, max: size }),
    onPointerMove: move,
    onPointerUp: end,
    onPointerCancel: cancel,
  });

  /** Spread onto a placed card's drag handle. */
  const moveHandlers = (placement: ViewPlacement) => ({
    onPointerDown: (e: ReactPointerEvent) => {
      const m = measure();
      if (!m) return;
      const under = cellFromPoint(m, e.clientX, e.clientY);
      metrics.current = m;
      begin(
        'move',
        placement.id,
        { w: placement.w, h: placement.h },
        { x: under.x - placement.x, y: under.y - placement.y },
        e,
      );
    },
    onPointerMove: move,
    onPointerUp: end,
    onPointerCancel: cancel,
  });

  /** Spread onto a placed card's resize grip. `grab` carries the ORIGIN here,
   *  not an offset — the corner being dragged is the far one. */
  const resizeHandlers = (placement: ViewPlacement, bounds: SizeBounds) => ({
    onPointerDown: (e: ReactPointerEvent) => {
      e.stopPropagation(); // the card's move handler is the parent
      begin(
        'resize',
        placement.id,
        { w: placement.w, h: placement.h },
        { x: placement.x, y: placement.y },
        e,
        bounds,
      );
    },
    onPointerMove: move,
    onPointerUp: end,
    onPointerCancel: cancel,
  });

  return { drag, addHandlers, moveHandlers, resizeHandlers };
}
