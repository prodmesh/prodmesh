import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { Dashboards } from './Dashboards';
import { CampusContext } from '../layout/campus';
import { ChurchContext } from '../layout/church';
import { IdentityContext } from '../lib/identity';
import { clearQueryCache } from '../lib/useQuery';
import type { AuthStatus, RoomMeta, ViewSummary } from '../api';
import type { Church } from '../types';

const api = vi.hoisted(() => ({
  getRooms: vi.fn(),
  getRoom: vi.fn(),
  getViews: vi.fn(),
  createView: vi.fn(),
}));

vi.mock('../api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api')>(),
  ...api,
}));

const rooms: RoomMeta[] = [
  { id: 'north-main', name: 'Main Auditorium', site: 'north', hasCompanion: true, modes: [] },
  { id: 'north-youth', name: 'Youth Room', site: 'north', hasCompanion: true, modes: [] },
  { id: 'south-main', name: 'Main Auditorium', site: 'south', hasCompanion: true, modes: [] },
] as RoomMeta[];

const church = {
  name: 'Test Church',
  sites: [
    { id: 'north', name: 'North Campus', status: 'active', auditoriums: [] },
    { id: 'south', name: 'South Campus', status: 'active', auditoriums: [] },
  ],
} as unknown as Church;

const view = (roomId: string, slug: string, name: string): ViewSummary => ({
  id: `${roomId}-${slug}`, roomId, kind: 'dashboard', name, slug,
  columns: 6, maxRows: null, scale: 1, position: 0, createdAt: 0, updatedAt: 0,
});

const VIEWS: Record<string, ViewSummary[]> = {
  'north-main': [view('north-main', 'foh', 'Front of House')],
  'north-youth': [view('north-youth', 'youth-booth', 'Youth Booth')],
  'south-main': [view('south-main', 'south-foh', 'South FOH')],
};

const status = (station: Partial<NonNullable<AuthStatus['station']>> | null): AuthStatus => ({
  authenticated: true, admin: false, setupNeeded: false,
  user: { id: 'u1', username: 'dana', displayName: 'Dana', planningCenterPersonId: null },
  permissions: ['views.edit'],
  station: station && { id: 's1', name: 'Booth', campusId: null, roomId: null, roomOnly: false, ...station },
} as AuthStatus);

const Where = () => <p data-testid="where">{useLocation().search}</p>;

function renderPage({ station = null, campusId = 'all', path = '/dashboards' }: {
  station?: Partial<NonNullable<AuthStatus['station']>> | null; campusId?: string; path?: string;
} = {}) {
  return render(
    <ChurchContext.Provider value={church}>
      <CampusContext.Provider value={{ campusId, setCampusId: vi.fn() }}>
        <IdentityContext.Provider value={status(station)}>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="/dashboards" element={<><Dashboards /><Where /></>} />
            </Routes>
          </MemoryRouter>
        </IdentityContext.Provider>
      </CampusContext.Provider>
    </ChurchContext.Provider>,
  );
}

beforeEach(() => {
  clearQueryCache();
  localStorage.clear();
  api.getRooms.mockReset().mockResolvedValue(rooms);
  api.getRoom.mockReset().mockImplementation(async (id: string) => rooms.find((r) => r.id === id));
  api.getViews.mockReset().mockImplementation(async (id: string) => ({ views: VIEWS[id] ?? [] }));
});

describe('Dashboards (#61)', () => {
  it('opens on the station\'s own room, and the picker can still change it', async () => {
    const user = userEvent.setup();
    renderPage({ station: { roomId: 'north-youth' } });

    expect(await screen.findByText('Youth Booth')).toBeInTheDocument();
    const picker = screen.getByLabelText('Room');
    expect(picker).toHaveValue('north-youth');

    await user.selectOptions(picker, 'north-main');
    expect(await screen.findByText('Front of House')).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('?room=north-main');
  });

  it('a station with no room opens on the room last picked here, else the first', async () => {
    const user = userEvent.setup();
    const { unmount } = renderPage();
    expect(await screen.findByText('Front of House')).toBeInTheDocument(); // first room

    await user.selectOptions(screen.getByLabelText('Room'), 'south-main');
    expect(await screen.findByText('South FOH')).toBeInTheDocument();
    unmount();

    clearQueryCache();
    renderPage();
    expect(await screen.findByText('South FOH')).toBeInTheDocument();
  });

  it('a room in the address wins over the station\'s own', async () => {
    renderPage({ station: { roomId: 'north-youth' }, path: '/dashboards?room=south-main' });
    expect(await screen.findByText('South FOH')).toBeInTheDocument();
  });

  it('offers only the sidebar\'s campus, and names rooms by campus when showing all', async () => {
    const { unmount } = renderPage({ campusId: 'north' });
    await screen.findByText('Front of House');
    expect([...screen.getByLabelText('Room').querySelectorAll('option')].map((o) => o.textContent))
      .toEqual(['Main Auditorium', 'Youth Room']);
    unmount();

    renderPage();
    await screen.findByText('Front of House');
    expect([...screen.getByLabelText('Room').querySelectorAll('option')].map((o) => o.textContent))
      .toEqual(['North Campus · Main Auditorium', 'North Campus · Youth Room', 'South Campus · Main Auditorium']);
  });

  it('a station whose room is outside the campus in view falls back rather than showing it', async () => {
    renderPage({ station: { roomId: 'south-main' }, campusId: 'north' });
    expect(await screen.findByText('Front of House')).toBeInTheDocument();
    expect(screen.queryByText('South FOH')).not.toBeInTheDocument();
  });

  it('with one room there is nothing to pick', async () => {
    api.getRooms.mockResolvedValue([rooms[0]]);
    renderPage();
    expect(await screen.findByText('Front of House')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByLabelText('Room')).not.toBeInTheDocument());
  });
});
