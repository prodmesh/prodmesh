import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Home } from './Home';
import { ChurchContext } from '../layout/church';
import { CampusContext, ALL_CAMPUSES } from '../layout/campus';
import { emitTopic } from '../test/fakeEventSource';
import type { RemoteServer, RoomMeta } from '../api';
import type { Church } from '../types';

const api = vi.hoisted(() => ({
  getRooms: vi.fn(),
  getEnabledIntegrations: vi.fn(),
  getRemoteCampuses: vi.fn(),
  getRoomService: vi.fn(),
}));
vi.mock('../api', async (importOriginal) => ({ ...await importOriginal<typeof import('../api')>(), ...api }));

const church: Church = {
  name: 'Grace Church',
  sites: [
    { id: 'north', name: 'North Campus', status: 'active', auditoriums: [] },
  ],
};
const room = (id: string, site: string): RoomMeta => ({
  id, name: id === 'north-main' ? 'Main Auditorium' : 'Youth Room', site,
  hasCompanion: false, roomModeEnabled: true, modes: [],
});
const SOUTH = '11111111-2222-3333-4444-555555555555';
const south = (over: Partial<RemoteServer> = {}): RemoteServer => ({
  systemId: SOUTH, name: 'Grace — South', dashboardUrl: 'http://192.0.2.20:8080',
  reachable: true, lastSeenAt: Date.now(), fetchedAt: Date.now(),
  campuses: [{ id: 'south', name: 'South Campus', rooms: [{ id: 'south-main', name: 'Sanctuary' }] }],
  ...over,
});

function renderHome(campusId = ALL_CAMPUSES) {
  return render(
    <MemoryRouter>
      <ChurchContext.Provider value={church}>
        <CampusContext.Provider value={{ campusId, setCampusId: () => {} }}>
          <Home />
        </CampusContext.Provider>
      </ChurchContext.Provider>
    </MemoryRouter>,
  );
}

describe('Home with linked servers (ADR 0018)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getRooms.mockResolvedValue([room('north-main', 'north')]);
    api.getEnabledIntegrations.mockResolvedValue({ enabled: { companion: true } });
    api.getRoomService.mockResolvedValue({ configured: false, live: false, plans: [] });
  });

  it('a single campus needs no header', async () => {
    api.getRemoteCampuses.mockResolvedValue([]);
    renderHome();
    expect(await screen.findByText('Main Auditorium')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 3 })).not.toBeInTheDocument();
  });

  it('groups cards under a header per campus, this server first, then each linked one', async () => {
    api.getRemoteCampuses.mockResolvedValue([south()]);
    renderHome();
    expect(await screen.findByText('Sanctuary')).toBeInTheDocument();
    const heads = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(heads).toEqual(['North Campus', 'South CampusGrace — South']);
    expect(screen.getByText('02 ROOMS')).toBeInTheDocument();

    // A remote card opens the room on the other server, in this tab.
    const card = screen.getByText('Sanctuary').closest('a')!;
    expect(card).toHaveAttribute('href', 'http://192.0.2.20:8080/visit#to=%2Froom%2Fsouth-main');
    expect(card).not.toHaveAttribute('target');
  });

  it('draws the digest, says when a value is stale, and greys an unreachable server', async () => {
    api.getRemoteCampuses.mockResolvedValue([south()]);
    renderHome();
    await screen.findByText('Sanctuary');
    const now = Date.now();
    await emitTopic({
      [`site:${SOUTH}:summary`]: {
        systemId: SOUTH, reachable: true, fetchedAt: now, error: null,
        rooms: { 'south-main': {
          mode: { id: 'service', label: 'Service', color: '#22c55e', online: true, locked: false, observedAt: now - 5 * 60_000 },
          show: { active: true, startedAt: now - 60_000, observedAt: now },
          next: { title: 'Sunday 11am', dates: 'Nov 15', at: null, observedAt: now },
        } },
      },
    });
    const card = screen.getByText('Sanctuary').closest('a')!;
    expect(within(card).getByText('Service')).toBeInTheDocument();
    expect(within(card).getByText('LIVE')).toBeInTheDocument();
    expect(within(card).getByText('5m old')).toBeInTheDocument();
    expect(within(card).getByText('Sunday 11am')).toBeInTheDocument();

    await emitTopic({
      [`site:${SOUTH}:summary`]: { systemId: SOUTH, reachable: false, fetchedAt: now, error: 'No answer', rooms: {} },
    });
    expect(within(card).getByText('UNREACHABLE')).toBeInTheDocument();
    expect(within(card).queryByText('LIVE')).not.toBeInTheDocument();
    expect(card).toHaveClass('roomcard--unreachable');
  });

  it('choosing a linked campus shows only it, named with its server', async () => {
    api.getRemoteCampuses.mockResolvedValue([south()]);
    renderHome(`${SOUTH}/south`);
    expect(await screen.findByText('Sanctuary')).toBeInTheDocument();
    expect(screen.queryByText('Main Auditorium')).not.toBeInTheDocument();
    expect(screen.getByText('South Campus · Grace — South')).toBeInTheDocument();
  });

  it('a server that gave no usable address gets a card that is not a link', async () => {
    api.getRemoteCampuses.mockResolvedValue([south({ dashboardUrl: null })]);
    renderHome();
    await screen.findByText('Sanctuary');
    expect(screen.getByText('Sanctuary').closest('a')).toBeNull();
  });
});
