import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from './AppShell';
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

  it('a logged-in user on the same station browses freely', async () => {
    api.getAuthStatus.mockResolvedValue({ ...authenticated, station: lockedStation });
    renderShell('/admin/users');

    expect(await screen.findByText('Users page content')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Home' })).toBeInTheDocument();
  });
});
