import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { DisplayView } from './DisplayView';
import { emitTopic } from '../test/fakeEventSource';
import { clearQueryCache } from '../lib/useQuery';
import type { AuthStatus, Station, View } from '../api';

const api = vi.hoisted(() => ({
  getView: vi.fn(),
  getAuthStatus: vi.fn(),
  getRoomService: vi.fn(),
  getRoomPlan: vi.fn(),
  getReport: vi.fn(),
}));

vi.mock('../api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api')>(),
  ...api,
}));

const view = (name: string): View => ({
  id: 'v1', roomId: 'north-main', kind: 'display', name, slug: 'wall',
  columns: 3, maxRows: 3, scale: 1, position: 0, createdAt: 0, updatedAt: 0,
  widgets: [{ id: 'w1', type: 'countdown', x: 0, y: 0, w: 2, h: 1, config: {} }],
});

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>;
}

function renderDisplay(key = 'wall') {
  return render(
    <MemoryRouter initialEntries={[`/display/north-main/${key}`]}>
      <Routes>
        <Route path="/display/:roomId/:key" element={<><DisplayView /><Where /></>} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

const status = (station: Partial<Station> | null, authenticated = false): AuthStatus => ({
  authenticated, admin: false, setupNeeded: false, user: null, permissions: [],
  station: station && {
    id: 's1', name: 'Foyer TV', campusId: 'north', roomId: 'north-main', roomOnly: false,
    viewId: 'v1', viewSlug: 'wall', ...station,
  },
});

const where = () => screen.getByTestId('where').textContent;

beforeEach(() => {
  clearQueryCache();
  api.getAuthStatus.mockReset().mockResolvedValue(status(null));
  api.getView.mockReset().mockResolvedValue({ view: view('Multiview') });
  api.getRoomService.mockReset().mockResolvedValue({ configured: true, live: true, plans: [] });
  api.getRoomPlan.mockReset().mockResolvedValue({ live: true, plan: null });
  api.getReport.mockReset().mockResolvedValue({
    items: [], totals: { planned: 0, actual: 0, delta: 0 }, completedAt: null,
  });
});

describe('DisplayView', () => {
  it('renders the grid and nothing else — no chrome to click', async () => {
    const { container } = renderDisplay();
    await waitFor(() => expect(container.querySelector('.viewgrid')).toBeInTheDocument());

    // It lives outside AppShell, so none of this is even in the tree.
    expect(container.querySelector('.sidebar')).toBeNull();
    expect(container.querySelector('.viewbar')).toBeNull();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('is a fixed canvas that cannot scroll — it is a tile on a multiview', async () => {
    const { container } = renderDisplay();
    await waitFor(() => expect(container.querySelector('.viewgrid')).toBeInTheDocument());
    const grid = container.querySelector('.viewgrid') as HTMLElement;
    expect(grid.className).toContain('viewgrid--fixed');
    expect(grid.style.getPropertyValue('--view-rows')).toBe('3');
    expect(grid.style.getPropertyValue('--view-columns')).toBe('3');
  });

  it('resolves an id as readily as a slug, so renaming cannot blank a screen', async () => {
    renderDisplay('v1');
    await waitFor(() => expect(api.getView).toHaveBeenCalledWith('north-main', 'v1'));
  });

  it('picks up a layout edited in the booth without anyone touching the screen', async () => {
    const { container } = renderDisplay();
    await waitFor(() => expect(container.querySelector('.viewgrid')).toBeInTheDocument());
    expect(api.getView).toHaveBeenCalledTimes(1);

    // The booth saves; the server publishes the room's views. A screen with no
    // keyboard has no other way to hear about it.
    api.getView.mockResolvedValue({ view: { ...view('Multiview'), widgets: [] } });
    await emitTopic({ 'room:north-main:views': [{ id: 'v1', slug: 'wall' }] });

    await waitFor(() => expect(api.getView).toHaveBeenCalledTimes(2));
  });

  it('magnifies the whole layout, so it stays exactly one screen', async () => {
    // A 3x3 as one tile of a video wall lands in a few hundred pixels, and type
    // sized for a desk disappears. `zoom` scales the LAYOUT, so the grid still
    // fills the screen with fewer CSS pixels — a transform would render at the
    // old size and overflow.
    api.getView.mockResolvedValue({ view: { ...view('Multiview'), scale: 2 } });
    const { container } = renderDisplay();

    await waitFor(() => expect(container.querySelector('.viewgrid')).toBeInTheDocument());
    expect((container.querySelector('.display') as HTMLElement).style.zoom).toBe('2');
  });

  it('does not set zoom at all when it is not needed', async () => {
    const { container } = renderDisplay();
    await waitFor(() => expect(container.querySelector('.viewgrid')).toBeInTheDocument());
    expect((container.querySelector('.display') as HTMLElement).style.zoom).toBe('');
  });

  it('shows nothing rather than an error nobody is there to read', async () => {
    api.getView.mockRejectedValue(new Error('HTTP 404'));
    const { container } = renderDisplay('gone');

    await waitFor(() => expect(container.querySelector('.display--blank')).toBeInTheDocument());
    // No "Loading…", no stack trace. A message left on a wall for a week stops
    // being read; a black rectangle is a fault someone notices.
    expect(container.querySelector('.display--blank')!.textContent).toBe('');
  });

  describe('following its station (#63)', () => {
    it('moves to a new display when Admin → Stations reassigns it', async () => {
      api.getAuthStatus.mockResolvedValue(status({}));
      renderDisplay();
      await waitFor(() => expect(api.getAuthStatus).toHaveBeenCalledTimes(1));
      expect(where()).toBe('/display/north-main/wall');

      // The admin saves; the server says only "you changed". The screen asks.
      api.getAuthStatus.mockResolvedValue(status({ viewId: 'v2', viewSlug: 'stage' }));
      await emitTopic({ 'station:s1': { changedAt: 1 } });
      await waitFor(() => expect(where()).toBe('/display/north-main/stage'));
    });

    it('goes back to the shell when its display is taken away', async () => {
      api.getAuthStatus.mockResolvedValue(status({}));
      renderDisplay();
      await waitFor(() => expect(api.getAuthStatus).toHaveBeenCalledTimes(1));

      api.getAuthStatus.mockResolvedValue(status({ viewId: null, viewSlug: null }));
      await emitTopic({ 'station:s1': { changedAt: 2 } });
      await waitFor(() => expect(where()).toBe('/'));
    });

    it('finds its display again after the display is renamed', async () => {
      // The address it came up on is the old slug, which no longer resolves.
      api.getView.mockRejectedValue(new Error('HTTP 404'));
      api.getAuthStatus.mockResolvedValue(status({ viewSlug: 'wall-renamed' }));
      renderDisplay('wall');
      await waitFor(() => expect(where()).toBe('/display/north-main/wall-renamed'));
    });

    it('leaves alone a laptop that opened a display to look at it', async () => {
      api.getAuthStatus.mockResolvedValue(status({ viewId: null, viewSlug: null }));
      renderDisplay();
      await waitFor(() => expect(api.getAuthStatus).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 20));
      expect(where()).toBe('/display/north-main/wall');
    });

    it('leaves alone a display station someone has logged in at', async () => {
      api.getAuthStatus.mockResolvedValue(status({ viewId: 'v2', viewSlug: 'stage' }, true));
      renderDisplay();
      await waitFor(() => expect(api.getAuthStatus).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 20));
      expect(where()).toBe('/display/north-main/wall');
    });
  });
});
