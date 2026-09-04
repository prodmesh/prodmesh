import type { ComponentType } from 'react';
import type { ViewKind } from '../lib/gridLayout';
import type { IntegrationId } from '../components/IntegrationBrand';

// ─────────────────────────────────────────────────────────────────────────────
//  Widget contract.
//
//  A widget is addressed by a STRING type and given a room plus a small config
//  object — nothing else. That constraint is the whole point: a stored
//  dashboard layout is data (`{type, roomId, config, span}`), so a widget can
//  only be placed from data if it can get everything it needs from data.
//
//  Which means widgets fetch their own state rather than receiving it as
//  props. That reads like duplicated work and isn't: subscriptions refcount
//  through useTopic, and requests share a cache key through useQuery (see
//  lib/keys.ts), so a widget on a page that already wanted the same data costs
//  nothing extra.
//
//  Not everything on a screen is a widget — but Run of Show turned out to be.
//  ADR 0010 kept its Start/End/Prev/Next as a page component on the grounds
//  that "no dashboard would ever place it"; a producer's dashboard is exactly
//  where you want Next under your thumb. What made it placeable is permission
//  gating: a widget that acts can offer its controls to whoever may use them
//  and say so plainly to whoever may not. `kinds` is how it stays off a
//  display, which is defined as non-interactive.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One line of the Companion widget.
 *
 * `variable` is written the way Companion writes it — `label:name`, where
 * `custom` is the reserved label for a custom variable and anything else is a
 * connection label (`internal:time_hms`). Stored as one string because that is
 * what an operator reads off a Companion button, and splitting it into two
 * fields would only ask them to translate.
 *
 * `ok`/`warn`/`bad` are comma-separated VALUE lists for the status bullet: the
 * values that mean each colour. Anything a row does not name is neutral, which
 * is deliberate — a grey bullet says "this is not one of the states I was told
 * about", and inventing a colour for it would be a guess shown as a fact.
 */
export interface CompanionVariableRow {
  variable: string;
  label?: string;
  display?: 'text' | 'status' | 'bar';
  ok?: string;
  warn?: string;
  bad?: string;
  /** Bar ends. Default 0–100, which is what a percentage variable already is. */
  min?: number;
  max?: number;
}

/** Per-instance settings from a stored layout. Every field is optional: a
 *  widget must render something sensible knowing only its room. */
export interface WidgetConfig {
  /** Pin to one Planning Center plan. Omitted = follow the room's next service. */
  planId?: string;
  /** Which service time within that plan. Omitted = the plan's first service. */
  timeId?: string;
  slideControls?: boolean;
  keyboardControls?: boolean;
  followActive?: boolean;
  slideMode?: 'image' | 'text';
  slideSize?: number;
  /** Per-meter thresholds and selected analyzer reading. */
  target?: number;
  limit?: number;
  metric?: string;
  weighting?: 'A' | 'B' | 'C' | 'Z';
  response?: 'Fast' | 'Slow';
  /** Room whose configured ProdMesh RTA feeds this widget. Omitted = this room. */
  sourceRoomId?: string;
  autoplay?: boolean;
  muted?: boolean;
  playerControls?: boolean;
  /** Show public Restream destination links beside each audience count. */
  destinationLinks?: boolean;
  /** Render an active YouTube destination inside the Restream widget. */
  videoPreview?: boolean;
  /** Show the optional administrator-supplied OBS program preview image. */
  obsPreview?: boolean;
  /** Reveal secondary OBS health figures such as CPU and disk headroom. */
  obsDetails?: boolean;
  aspectRatio?: '16:9' | '4:3' | '1:1';
  slides?: 'current' | 'next' | 'both';
  /**
   * Drop the branded title strip above this widget on a LIVE view.
   *
   * Not a cosmetic preference so much as a question of what the screen is for:
   * a booth dashboard wants to know which of two meters it is looking at, and
   * a foyer wall showing one big clock does not want the word "Clock" over it.
   * The editor keeps its own handle strip either way — see PlacedWidget — so
   * hiding this can never make a widget unselectable.
   */
  hideHeader?: boolean;
  /** Companion variables, one row each. The only config that is a LIST:
   *  every other widget answers one question, and this one is a rack of
   *  labelled values whose whole point is holding several at once. */
  rows?: CompanionVariableRow[];
  /** Runtime-only identity injected by ViewCanvas; never persisted. */
  viewId?: string;
  widgetId?: string;
}

export interface WidgetProps {
  roomId: string;
  config: WidgetConfig;
}

/** Column count on the 12-col grid, or one of the legacy names. */
export type WidgetSpan = 'half' | 'third' | 'two-thirds' | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

// Named spans predate the numeric ones and stay as aliases — they read better
// at call sites that only ever wanted "half", and a stored layout wants to say
// 5 without inventing a name for it.
const SPAN_COLUMNS: Record<string, number> = { half: 6, third: 4, 'two-thirds': 8 };

/**
 * Resolve a span to a column count, or null if it isn't one.
 *
 * The range check looks redundant against `WidgetSpan` and is not: spans
 * arrive from a stored layout, i.e. from the database, where the type is a
 * promise the data has never been asked to keep.
 */
export function spanColumns(span: WidgetSpan | undefined): number | null {
  if (span == null) return null;
  const n = typeof span === 'number' ? span : SPAN_COLUMNS[span];
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : null;
}

/** Size on a View's 2D canvas, in grid units. */
export interface WidgetSize {
  w: number;
  h: number;
}

export interface WidgetDef {
  /** Shown in the layout picker. */
  title: string;
  /** One line on what it shows — the picker's subtitle. */
  description: string;
  /** The system that supplies the widget's primary live data. */
  integration?: IntegrationId;
  component: ComponentType<WidgetProps>;

  /** Size in grid units on a View canvas (6 wide on a dashboard, 3 on a
   *  display) — what it gets when first placed. */
  size: WidgetSize;

  /** Optional minimum size. A widget always starts at `size`, but every
   * widget can be made larger in either direction by the layout editor. */
  minSize?: WidgetSize;
  /** Retained for compatibility with existing layouts. The shared layout
   * maximum below is now used so every widget has the same resize freedom. */
  maxSize?: WidgetSize;

  /**
   * One per view? Defaults to true.
   *
   * A flag rather than a blanket rule, because the real invariant is that a
   * placement be IDENTIFIABLE. Today most widgets carry no config, so the type
   * alone identifies them and one-per-view falls out for free. A future
   * multi-instance widget — two Smaart engines in one room, one for the stream
   * and one for the house — sets `unique: false` and earns an identity in its
   * config. Mirrored in server/validate.js, which is authoritative.
   */
  unique?: boolean;

  /** Which view kinds may hold it. Defaults to both. A widget that takes
   *  actions must exclude 'display': a display is DEFINED as non-interactive. */
  kinds?: ViewKind[];

  /**
   * LEGACY: column span on the 12-column FLOW grid (`.widgets`,
   * `.ros__widgets`), which reflows to one column below 880px. Different
   * question from `size`, and not convertible: `third` is 4/12, `w:2` is 2/6,
   * and `two-thirds` has no clean 6-column equivalent. Dies with spanColumns()
   * the day Run of Show renders a stored view instead of a hard-coded row.
   */
  defaultSpan: WidgetSpan;
}

export type WidgetType =
  | 'countdown'
  | 'loudness'
  | 'loudness-trend'
  | 'rta'
  | 'viewers'
  | 'restream'
  | 'obs-health'
  | 'resi-stream'
  | 'resi-health'
  | 'resi-viewers'
  | 'resi-broadcast'
  | 'run-of-show'
  | 'now-next'
  | 'room-mode'
  | 'companion-variables'
  | 'room-health'
  | 'captions'
  | 'lyrics'
  | 'slides-left'
  | 'clock'
  | 'propresenter-slides'
  | 'propresenter-playlist'
  | 'propresenter-controls'
  | 'slide-notes'
  | 'propresenter-timers'
  | 'planning-center-service'
  | 'planning-center-timers'
  | 'planning-center-schedule'
  | 'planning-center-teams';

/** May this widget go on a view of this kind? */
export const widgetAllowedOn = (def: WidgetDef, kind: ViewKind): boolean =>
  (def.kinds ?? ['dashboard', 'display']).includes(kind);

export const MAX_WIDGET_SIZE: WidgetSize = { w: 6, h: 5 };

// Widgets keep their authored starting size, but users may resize every one
// down to a single cell. Their content then scales with the chosen cell.
export const widgetMin = (_def: WidgetDef): WidgetSize => ({ w: 1, h: 1 });
// A dashboard is six columns wide. Displays are smaller, and their grid
// validation naturally limits a resize to what fits on that display.
export const widgetMax = (_def: WidgetDef): WidgetSize => MAX_WIDGET_SIZE;

/** Can this widget be stretched at all, on either axis? */
export const widgetResizable = (def: WidgetDef): boolean => {
  const min = widgetMin(def);
  const max = widgetMax(def);
  return max.w > min.w || max.h > min.h;
};

/** One per view unless it says otherwise. */
export const widgetIsUnique = (def: WidgetDef): boolean => def.unique !== false;

export type { ViewKind };
