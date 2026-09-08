import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { widgetRegistry, widgetTypes, isWidgetType } from './registry';
import {
  MAX_WIDGET_SIZE, spanColumns, widgetAllowedOn, widgetIsUnique, widgetMax, widgetMin, type WidgetSpan,
} from './types';
import { GRID, fits } from '../lib/gridLayout';
// The backend is plain JS with no declarations, and turning on allowJs to
// import forty lines of table would pull every server module into the app's
// TypeScript project — the trade ADR 0011 already declined for gridLayout.
// A suppression in the one TEST that compares the two tables is the small end
// of that: nothing in src/ imports server code, and the bundle never sees it.
// @ts-expect-error — untyped JS, deliberately
import { WIDGET_TYPES as SERVER_TYPES } from '../../server/validate.js';
import { emitTopic } from '../test/fakeEventSource';

const api = vi.hoisted(() => ({
  getRoomService: vi.fn(),
  getRoomPlan: vi.fn(),
  getReport: vi.fn(),
}));

vi.mock('../api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api')>(),
  ...api,
}));

const plan = {
  id: 'plan-9',
  serviceTypeId: 'st',
  serviceTypeName: 'Sunday',
  title: 'August 9 Service',
  seriesTitle: null,
  dates: 'August 9',
  sortDate: null,
  times: [
    { id: 't-rehearse', name: 'Rehearsal', startsAt: '2026-08-09T14:00:00Z', endsAt: null, type: 'rehearsal' },
    { id: 't-svc', name: '1st Service', startsAt: '2026-08-09T17:00:00Z', endsAt: null, type: 'service' },
  ],
  items: [],
};

beforeEach(() => {
  // mockReset, not just mockResolvedValue: call counts otherwise accumulate
  // across tests, and "this widget did NOT fetch the other thing" is half of
  // what the placement tests below assert.
  api.getRoomService.mockReset().mockResolvedValue({ configured: true, live: true, plans: [plan] });
  api.getRoomPlan.mockReset().mockResolvedValue({ live: true, plan });
  api.getReport.mockReset().mockResolvedValue({
    items: [], totals: { planned: 0, actual: 0, delta: 0 }, completedAt: null,
  });
});

describe('the registry contract', () => {
  it('every registered widget renders from a room id and nothing else', async () => {
    // This is the whole contract, enforced mechanically: a stored layout can
    // only place a widget from data, so a widget that needs props from a
    // surrounding page cannot be placed. Adding one fails right here.
    for (const type of widgetTypes) {
      const W = widgetRegistry[type].component;
      const view = render(<W roomId="north-main" config={{}} />);
      view.unmount();
    }
  });

  it('describes every widget for the layout picker', () => {
    for (const type of widgetTypes) {
      const def = widgetRegistry[type];
      expect(def.title, `${type} needs a title`).toBeTruthy();
      expect(def.description, `${type} needs a description`).toBeTruthy();
      expect(spanColumns(def.defaultSpan), `${type} needs a usable span`).toBeGreaterThan(0);
    }
  });

  it('every widget declares a size that fits the grids it claims', () => {
    for (const type of widgetTypes) {
      const def = widgetRegistry[type];
      const { w, h } = def.size;
      expect(Number.isInteger(w) && w >= 1, `${type} needs an integer width`).toBe(true);
      expect(Number.isInteger(h) && h >= 1, `${type} needs an integer height`).toBe(true);
      expect(fits(GRID.dashboard, { x: 0, y: 0, w, h }), `${type} must fit a dashboard`).toBe(true);

      // The assertion that turns "display-safe" from a comment into something
      // the suite enforces: a display is a hard 3×3 with no scrolling, so a
      // widget that claims it must actually fit inside one.
      if (widgetAllowedOn(def, 'display')) {
        expect(fits(GRID.display, { x: 0, y: 0, w, h }), `${type} claims display but is ${w}×${h}`).toBe(true);
      }
    }
  });

  it('is one-per-view unless a widget opts out', () => {
    // Two deliberate opt-outs, for the same reason in different clothes: the
    // type alone no longer identifies the placement, and its CONFIG does.
    // Loudness — A-slow and C-slow meters side by side from one analysis
    // source. Companion variables — two racks of different variables.
    const many = new Set(['loudness', 'companion-variables', 'rta']);
    for (const type of widgetTypes) {
      expect(widgetIsUnique(widgetRegistry[type]), `${type}`).toBe(!many.has(type));
    }
  });

  it('recognises its own type names and rejects others', () => {
    expect(isWidgetType('loudness')).toBe(true);
    expect(isWidgetType('nope')).toBe(false);
  });

  it('agrees with the server, which is the authoritative copy', () => {
    // server/validate.js keeps a hand-written duplicate of this table, because
    // the backend is JS and the frontend is TS with no build step between —
    // the same arrangement TILE_TYPES has. Duplicated-by-hand is fine; SILENTLY
    // diverged is not. A widget added on one side alone is offered by the
    // editor and refused by the save, or the reverse, and neither shows up
    // until somebody arranges a dashboard and cannot store it.
    expect([...SERVER_TYPES.keys()].sort()).toEqual([...widgetTypes].sort());

    for (const type of widgetTypes) {
      const def = widgetRegistry[type];
      const server = SERVER_TYPES.get(type)!;
      expect(server.size, `${type} size`).toEqual(def.size);
      expect(server.unique, `${type} unique`).toBe(widgetIsUnique(def));
      expect(server.display, `${type} display`).toBe(widgetAllowedOn(def, 'display'));
      // Widgets start at their authored size, but the layout lets the user
      // choose any fitting size from one cell upward.
      expect({ w: 1, h: 1 }, `${type} min`).toEqual(widgetMin(def));
      expect(MAX_WIDGET_SIZE, `${type} max`).toEqual(widgetMax(def));
    }
  });
});

describe('column spans', () => {
  it('maps the legacy names onto the 12-col grid', () => {
    expect(spanColumns('half')).toBe(6);
    expect(spanColumns('third')).toBe(4);
    expect(spanColumns('two-thirds')).toBe(8);
  });

  it('takes any column count a stored layout might hold, and rejects nonsense', () => {
    expect(spanColumns(1)).toBe(1);
    expect(spanColumns(5)).toBe(5);
    expect(spanColumns(12)).toBe(12);
    expect(spanColumns(undefined)).toBeNull();
    // Casts on purpose: these are the values that arrive from the DATABASE,
    // where WidgetSpan is a promise nothing has enforced. TypeScript rejecting
    // them at this call site is the point — the runtime guard is for the other
    // door.
    expect(spanColumns(0 as WidgetSpan)).toBeNull();
    expect(spanColumns(13 as WidgetSpan)).toBeNull();
    expect(spanColumns(2.5 as WidgetSpan)).toBeNull();
    expect(spanColumns('enormous' as WidgetSpan)).toBeNull();
  });
});

describe('CountdownWidget placement', () => {
  it('follows the room’s next service when no plan is pinned', async () => {
    // The dashboard case: a lobby screen must not need reconfiguring weekly.
    render(<widgetRegistry.countdown.component roomId="north-main" config={{}} />);

    await waitFor(() => expect(api.getRoomService).toHaveBeenCalledWith('north-main'));
    // The plan's first SERVICE time, not its rehearsal.
    expect(await screen.findByText(/1st Service/)).toBeInTheDocument();
    expect(api.getRoomPlan).not.toHaveBeenCalled();
  });

  it('uses the pinned plan and time when given one', async () => {
    render(
      <widgetRegistry.countdown.component
        roomId="north-main"
        config={{ planId: 'plan-9', timeId: 't-rehearse' }}
      />,
    );

    await waitFor(() => expect(api.getRoomPlan).toHaveBeenCalledWith('north-main', 'plan-9'));
    expect(await screen.findByText(/Rehearsal/)).toBeInTheDocument();
    expect(api.getRoomService).not.toHaveBeenCalled();
  });

  it('lets a running ProPresenter timer win over clock math', async () => {
    render(<widgetRegistry.countdown.component roomId="north-main" config={{}} />);
    await screen.findByText(/1st Service/);

    await emitTopic({
      'room:north-main:timer': {
        uuid: 'u1', name: 'Service Start', state: 'running',
        remainingSeconds: 300, targetSecondsOfDay: null, countsDownToTime: false,
      },
    });

    expect(await screen.findByText('05:00')).toBeInTheDocument();
    expect(screen.getByText(/Service Start/)).toBeInTheDocument();
  });
});
