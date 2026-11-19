import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from './AppShell';
import { emitTopic } from '../test/fakeEventSource';
import type { AuthStatus } from '../api';

const api = vi.hoisted(() => ({
  getAbout: vi.fn(),
  getAuthStatus: vi.fn(),
  getConfig: vi.fn(),
  logoutAdmin: vi.fn(),
  registerStation: vi.fn(),
  loginUser: vi.fn(),
  getAssistance: vi.fn(async () => ({ active: false })),
  requestAssistance: vi.fn(),
  dismissAssistance: vi.fn(),
  // Linked servers' campuses for the picker (ADR 0018); none here.
  getRemoteCampuses: vi.fn(async () => []),
  isVisiting: vi.fn(() => false),
  // The sidebar asks for the church's uploaded logo and falls back to the
  // bundled one when the endpoint 404s.
  logoSrc: (stamp?: number | null) => `/api/branding/logo${stamp ? `?v=${stamp}` : ''}`,
}));

vi.mock('../api', () => api);

const authenticated: AuthStatus = {
  authenticated: true,
  admin: true,
  setupNeeded: false,
  user: {
    id: 'user-1',
    username: 'srivera',
    displayName: 'Sam Rivera',
    planningCenterPersonId: 'P900001',
    avatarUrl: 'https://example.test/srivera.jpg',
  },
  permissions: ['*'],
  station: {
    id: 'station-1',
    name: 'FOH – Producer',
    campusId: 'north',
    roomId: null,
    roomOnly: false,
  },
};

function renderShell(path = '/admin/users') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/admin/users" element={<div>Users page content</div>} />
          <Route path="/admin/general" element={<div>General page content</div>} />
          <Route path="/admin/integrations" element={<div>Integrations page content</div>} />
          <Route path="/admin/checklists" element={<div>Checklists page content</div>} />
          <Route path="/room/:roomId" element={<div>Room page content</div>} />
          <Route path="/room/:roomId/views" element={<div>Room dashboards content</div>} />
          <Route path="/dashboards" element={<div>Dashboards page content</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('AppShell identity and Admin navigation', () => {
  beforeEach(() => {
    api.getAbout.mockResolvedValue({ version: '1.0.0' });
    api.getConfig.mockResolvedValue({
      name: 'Test Church',
      sites: [{ id: 'north', name: 'North Campus', status: 'active', auditoriums: [] }],
    });
    api.getAuthStatus.mockResolvedValue(authenticated);
    api.logoutAdmin.mockResolvedValue(undefined);
  });

  it('shows Admin subnavigation and the Planning Center avatar', async () => {
    renderShell();

    expect(await screen.findByRole('link', { name: 'Users & access' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'General' })).toHaveAttribute('href', '/admin/general');
    expect(screen.getByRole('link', { name: 'Integrations' })).toHaveAttribute('href', '/admin/integrations');
    expect(screen.getByRole('link', { name: 'Stations' })).toHaveAttribute('href', '/admin/stations');
    expect(screen.getByRole('link', { name: 'Checklists' })).toHaveAttribute('href', '/admin/checklists');
    expect(screen.getByRole('button', { name: /Sam Rivera/ }).querySelector('img')).toHaveAttribute(
      'src',
      authenticated.user?.avatarUrl,
    );
  });

  it('keeps the Admin sections reachable with the sidebar collapsed', async () => {
    // They were a sublist inside the sidebar, hidden along with its labels.
    localStorage.setItem('prodmesh.sidebar', 'rail');
    try {
      renderShell();
      const panel = await screen.findByRole('navigation', { name: 'Admin' });
      expect(within(panel).getByRole('link', { name: 'Users & access' })).toHaveAttribute('aria-current', 'page');
    } finally {
      localStorage.removeItem('prodmesh.sidebar');
    }
  });

  it('shows the Admin panel only on Admin pages', async () => {
    renderShell('/room/north-main');
    expect(await screen.findByText('Room page content')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Admin' })).not.toBeInTheDocument();
  });

  it('dismisses the account menu by toggle, click-away, and Escape', async () => {
    const user = userEvent.setup();
    renderShell();
    const account = await screen.findByRole('button', { name: /Sam Rivera/ });

    await user.click(account);
    expect(screen.getByRole('button', { name: 'Lock station' })).toBeInTheDocument();
    await user.click(account);
    expect(screen.queryByRole('button', { name: 'Lock station' })).not.toBeInTheDocument();

    await user.click(account);
    await user.click(screen.getByText('Users page content'));
    expect(screen.queryByRole('button', { name: 'Lock station' })).not.toBeInTheDocument();

    await user.click(account);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: 'Lock station' })).not.toBeInTheDocument();
  });

  it('requires confirmation before locking the station', async () => {
    const user = userEvent.setup();
    renderShell();
    const account = await screen.findByRole('button', { name: /Sam Rivera/ });

    await user.click(account);
    await user.click(screen.getByRole('button', { name: 'Lock station' }));
    expect(api.logoutAdmin).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: /Lock FOH – Producer/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.logoutAdmin).not.toHaveBeenCalled();

    await user.click(account);
    await user.click(screen.getByRole('button', { name: 'Lock station' }));
    const buttons = screen.getAllByRole('button', { name: 'Lock station' });
    await user.click(buttons.at(-1)!);
    await waitFor(() => expect(api.logoutAdmin).toHaveBeenCalledOnce());
  });
});

describe('room-only station', () => {
  const lockedStation = {
    id: 'station-2',
    name: 'Lobby Display',
    campusId: 'north',
    roomId: 'north-main',
    roomOnly: true,
  };

  beforeEach(() => {
    api.getConfig.mockResolvedValue({
      name: 'Test Church',
      sites: [{
        id: 'north', name: 'North Campus', status: 'active',
        auditoriums: [{ id: 'north-main', name: 'Main Auditorium', tiles: [] }],
      }],
    });
  });

  it('in read-only mode, collapses nav to the assigned room and redirects everything else there', async () => {
    api.getAuthStatus.mockResolvedValue({
      authenticated: false, admin: false, setupNeeded: false, user: null, permissions: [],
      station: lockedStation,
    });
    renderShell('/admin/users');

    // The admin page never renders — the shell bounces to the room page.
    expect(await screen.findByText('Room page content')).toBeInTheDocument();
    expect(screen.queryByText('Users page content')).not.toBeInTheDocument();

    // Nav is just the room; the global destinations are gone.
    expect(await screen.findByRole('link', { name: 'Main Auditorium' })).toHaveAttribute('href', '/room/north-main');
    for (const gone of ['Home', 'Services', 'Calendar', 'Analytics', 'Admin']) {
      expect(screen.queryByRole('link', { name: gone })).not.toBeInTheDocument();
    }

    // The way out — logging in — stays reachable.
    expect(screen.getByRole('button', { name: /Read-only/ })).toBeInTheDocument();
  });

  it('keeps its own room\'s dashboards one click away, with no room picker (#61)', async () => {
    api.getAuthStatus.mockResolvedValue({
      authenticated: false, admin: false, setupNeeded: false, user: null, permissions: [],
      station: lockedStation,
    });
    renderShell('/room/north-main/views');

    expect(await screen.findByText('Room dashboards content')).toBeInTheDocument();
    const dashboards = await screen.findByRole('link', { name: 'Dashboards' });
    expect(dashboards).toHaveAttribute('href', '/room/north-main/views');
    // Only one of the two is "where you are".
    expect(dashboards).toHaveClass('sidebar__item--active');
    expect(screen.getByRole('link', { name: 'Main Auditorium' })).not.toHaveClass('sidebar__item--active');
  });

  it('a station assigned a display gets no dashboards link', async () => {
    api.getAuthStatus.mockResolvedValue({
      authenticated: false, admin: false, setupNeeded: false, user: null, permissions: [],
      station: { ...lockedStation, viewSlug: 'lobby' },
    });
    renderShell('/admin/users');
    // Its one link is its display; that screen IS the station's dashboard.
    expect(await screen.findByRole('link', { name: 'Main Auditorium' })).toHaveAttribute('href', '/display/north-main/lobby');
    expect(screen.queryByRole('link', { name: 'Dashboards' })).not.toBeInTheDocument();
  });

  it('a logged-in user on the same station browses freely', async () => {
    api.getAuthStatus.mockResolvedValue({ ...authenticated, station: lockedStation });
    renderShell('/admin/users');

    expect(await screen.findByText('Users page content')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Home' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Dashboards' })).toHaveAttribute('href', '/dashboards');
  });
});

describe('a display station (#63)', () => {
  // Not room-locked: picking a display is enough on its own.
  const display = {
    id: 'station-3', name: 'Foyer TV', campusId: 'north', roomId: 'north-main',
    roomOnly: false, viewId: 'v1', viewSlug: 'lobby',
  };
  const readOnly = { authenticated: false, admin: false, setupNeeded: false, user: null, permissions: [] };

  function renderWithDisplay(path: string) {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/display/:roomId/:key" element={<div>Display content</div>} />
          <Route element={<AppShell />}>
            <Route path="/" element={<div>Home content</div>} />
            <Route path="/login" element={null} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
  }

  beforeEach(() => {
    api.getAbout.mockResolvedValue({ version: '1.0.0' });
    api.getConfig.mockResolvedValue({ name: 'Test Church', sites: [] });
    api.getAuthStatus.mockResolvedValue({ ...readOnly, station: display });
  });

  it('opens its display without the room-lock box ticked', async () => {
    renderWithDisplay('/');
    expect(await screen.findByText('Display content')).toBeInTheDocument();
  });

  it('can be got out of at /login, since a display has no login button', async () => {
    renderWithDisplay('/login');
    expect(await screen.findByRole('heading', { name: 'Log in' })).toBeInTheDocument();
    expect(screen.queryByText('Display content')).not.toBeInTheDocument();
  });

  it('cancelling the login goes back to the display', async () => {
    renderWithDisplay('/login');
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /cancel|close/i }));
    expect(await screen.findByText('Display content')).toBeInTheDocument();
  });

  it('goes to its display when one is picked for it from another machine', async () => {
    // Setting a screen up: register it, walk back to the booth, pick its
    // display. Nobody should have to walk back and reload it.
    const bare = { ...display, viewId: null, viewSlug: null };
    api.getAuthStatus.mockResolvedValue({ ...readOnly, station: bare });
    renderWithDisplay('/');
    expect(await screen.findByText('Home content')).toBeInTheDocument();

    api.getAuthStatus.mockResolvedValue({ ...readOnly, station: display });
    await emitTopic({ 'station:station-3': { changedAt: 1 } });
    expect(await screen.findByText('Display content')).toBeInTheDocument();
  });

  it('a station whose display was deleted is an ordinary browser again', async () => {
    // The server's join reads a deleted view as no assignment.
    api.getAuthStatus.mockResolvedValue({ ...readOnly, station: { ...display, viewId: null, viewSlug: null } });
    renderWithDisplay('/');
    expect(await screen.findByText('Home content')).toBeInTheDocument();
  });
});

describe('a visitor from a linked server (ADR 0018)', () => {
  beforeEach(() => {
    api.getAbout.mockResolvedValue({ version: '1.0.0' });
    api.getConfig.mockResolvedValue({ name: 'Test Church', sites: [] });
  });

  it('is not asked to name a station, and the account says where they came from', async () => {
    api.getAuthStatus.mockResolvedValue({
      ...authenticated, admin: false, permissions: ['reports.view'], station: null,
      user: { ...authenticated.user!, username: 'srivera@grace-north', originSystemId: 'peer-1' },
      visitor: { systemId: 'peer-1', server: 'Grace — North' },
    });
    renderShell('/room/north-main');
    expect(await screen.findByText(/visiting from Grace — North/)).toBeInTheDocument();
    expect(screen.queryByText('Name this machine')).not.toBeInTheDocument();
  });

  it('an anonymous browser that arrived by Open is not asked either', async () => {
    api.isVisiting.mockReturnValue(true);
    api.getAuthStatus.mockResolvedValue({ ...authenticated, authenticated: false, user: null, station: null });
    renderShell('/room/north-main');
    await screen.findByText('Room page content');
    expect(screen.queryByText('Name this machine')).not.toBeInTheDocument();
    api.isVisiting.mockReturnValue(false);
  });

  it('an unregistered browser of our own still is', async () => {
    api.getAuthStatus.mockResolvedValue({ ...authenticated, authenticated: false, user: null, station: null });
    renderShell('/room/north-main');
    expect(await screen.findByText('Name this machine')).toBeInTheDocument();
  });
});
