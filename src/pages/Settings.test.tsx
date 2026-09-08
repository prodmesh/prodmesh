import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { IdentityContext } from '../lib/identity';
import { CampusesPanel, LogsPanel, RoomConfigPanel, StationsPanel, SystemPanel, UserManagementPanel } from './Settings';

const api = vi.hoisted(() => ({
  getVersion: vi.fn(),
  triggerUpdate: vi.fn(),
  getUserDirectory: vi.fn(),
  createUser: vi.fn(),
  createGroup: vi.fn(),
  setUserGroups: vi.fn(),
  setUserActive: vi.fn(),
  resetUserPin: vi.fn(),
  updateGroup: vi.fn(),
  getStations: vi.fn(),
  getRooms: vi.fn(),
  getViews: vi.fn(),
  updateStation: vi.fn(),
  revokeStation: vi.fn(),
  getServerLog: vi.fn(),
  getAuditLog: vi.fn(),
  getConfig: vi.fn(),
  saveConfig: vi.fn(),
  getRoomConnectivity: vi.fn(),
  savePcServiceTypes: vi.fn(),
  saveAnalysis: vi.fn(),
  saveProPresenter: vi.fn(),
  saveCompanion: vi.fn(),
  getSettings: vi.fn(),
  saveSchedules: vi.fn(),
}));

vi.mock('../api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api')>(),
  ...api,
}));

describe('Users & access', () => {
  beforeEach(() => {
    api.getUserDirectory.mockResolvedValue({
      users: [
        {
          id: 'with-photo', username: 'photo', displayName: 'Photo User',
          planningCenterPersonId: '123', avatarUrl: 'https://example.test/photo.jpg',
          active: true, groups: [], permissions: [],
        },
        {
          id: 'without-photo', username: 'placeholder', displayName: 'Placeholder User',
          planningCenterPersonId: null, avatarUrl: null,
          active: true, groups: [], permissions: [],
        },
      ],
      groups: [],
      permissions: [],
    });
  });

  const asIdentity = (permissions: string[], ui: React.ReactElement) => render(
    <IdentityContext.Provider value={{
      authenticated: true, station: null, permissions,
      user: { id: 'me', username: 'me', displayName: 'Me', avatarUrl: null, planningCenterPersonId: null },
    } as never}>{ui}</IdentityContext.Provider>,
  );

  it('offers a PIN reset only to a full administrator', async () => {
    // Taking over an account is not something users.manage may do — see the
    // route. The button is guidance; the refusal is the server's.
    asIdentity(['users.manage'], <UserManagementPanel />);
    await screen.findByText('Photo User');
    expect(screen.queryByRole('button', { name: 'Reset PIN' })).toBeNull();

    asIdentity(['*'], <UserManagementPanel />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Reset PIN' }).length).toBeGreaterThan(0));
  });

  it('revokes access without deleting the account, and says so on the row', async () => {
    api.setUserActive.mockResolvedValue({});
    asIdentity(['*'], <UserManagementPanel />);
    const row = (await screen.findByText('Photo User')).closest('.users__row') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Revoke access' }));
    expect(api.setUserActive).toHaveBeenCalledWith('with-photo', false);
  });

  it('explains a refused group change instead of silently springing back', async () => {
    // The checkbox reverts on refresh either way; without a message that reads
    // as the click not registering rather than as a rule.
    api.setUserGroups.mockRejectedValue(new Error('cannot_grant_unheld_permissions'));
    api.getUserDirectory.mockResolvedValue({
      users: [{
        id: 'u1', username: 'vol', displayName: 'Volunteer', planningCenterPersonId: null,
        avatarUrl: null, active: true, groups: [], permissions: [],
      }],
      groups: [{ id: 'g1', name: 'Admins', permissions: ['*'] }],
      permissions: [],
    });
    asIdentity(['users.manage'], <UserManagementPanel />);
    const row = (await screen.findByText('Volunteer')).closest('.users__row') as HTMLElement;
    await userEvent.click(within(row).getByLabelText('Admins'));
    expect(await screen.findByText(/only grant permissions you hold yourself/i)).toBeInTheDocument();
  });

  it('shows a Planning Center photo or the standard placeholder for every user', async () => {
    render(<UserManagementPanel />);

    const photo = await screen.findByRole('img', { name: 'Photo User avatar' });
    const placeholder = screen.getByRole('img', { name: 'Placeholder User avatar' });
    expect(photo.querySelector('img')).toHaveAttribute('src', 'https://example.test/photo.jpg');
    expect(placeholder.querySelector('svg')).toBeInTheDocument();
  });
});

describe('Stations', () => {
  beforeEach(() => {
    api.getStations.mockResolvedValue({
      stations: [{
        id: 'station-1', name: 'Old Booth', campusId: 'north', roomId: null,
        createdAt: Date.now() - 10000, lastSeen: Date.now(), current: true,
      }],
    });
    api.getRooms.mockResolvedValue([{
      id: 'north-main', name: 'Main Auditorium', site: 'north', hasCompanion: true, modes: [],
    }]);
    api.updateStation.mockImplementation(async (_id, input) => ({
      id: 'station-1', ...input, createdAt: Date.now() - 10000, lastSeen: Date.now(), current: true,
    }));
    api.revokeStation.mockResolvedValue({ current: false });
    api.getViews.mockResolvedValue({ views: [] });
  });

  it('renames and assigns a station, then confirms before revoking it', async () => {
    const user = userEvent.setup();
    render(<StationsPanel />);

    expect(await screen.findByText(/CURRENT STATION/)).toBeInTheDocument();
    const name = screen.getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'FOH – Producer');
    await user.selectOptions(screen.getByLabelText('Room'), 'north-main');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(api.updateStation).toHaveBeenCalledWith('station-1', {
      name: 'FOH – Producer', campusId: 'north', roomId: 'north-main', roomOnly: false,
      // An ordinary browser, not a display. Sent explicitly rather than
      // omitted so assigning one and clearing it are the same shape.
      viewId: null,
    });

    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(api.revokeStation).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: /Unregister FOH – Producer/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Revoke station' }));
    expect(api.revokeStation).toHaveBeenCalledWith('station-1');
  });
});

describe('Logs', () => {
  beforeEach(() => {
    api.getServerLog.mockResolvedValue({
      exists: true,
      file: '/srv/prodmesh/logs/server.log',
      size: 2048,
      mtime: Date.now(),
      truncated: false,
      lines: [
        'Production dashboard server on http://localhost:8080',
        '[smaart] 192.0.2.40: Smaart v8 8.5.2.2 via /api/v3/',
        '[autostart] north-main: armed for 900102',
      ],
    });
    api.getAuditLog.mockResolvedValue({
      entries: [{
        id: 1, ts: Date.now(), action: 'rooms.mode.change', result: 'allowed',
        resourceType: 'room-mode', resourceId: 'sunday', roomId: 'north-main', planId: null,
        userName: 'Sam', username: 'sam', stationName: 'FOH – Producer', details: null,
      }],
    });
  });

  it('shows the server log tail, filters it, and switches to the audit trail', async () => {
    const user = userEvent.setup();
    render(<LogsPanel />);

    const log = await screen.findByTestId('server-log');
    expect(log).toHaveTextContent('Smaart v8 8.5.2.2');
    expect(log).toHaveTextContent('Production dashboard server');

    await user.type(screen.getByPlaceholderText(/Filter lines/), 'smaart');
    expect(log).toHaveTextContent('Smaart v8 8.5.2.2');
    expect(log).not.toHaveTextContent('Production dashboard server');

    await user.click(screen.getByRole('button', { name: 'Audit trail' }));
    expect(await screen.findByText('rooms.mode.change')).toBeInTheDocument();
    expect(screen.getByText('Sam')).toBeInTheDocument();
    expect(screen.getByText('allowed')).toBeInTheDocument();
  });
});

describe('System', () => {
  const version = {
    version: '1.0.0', commit: 'c5b551d', subject: 'Ship it', source: 'git' as const,
    deployment: 'git' as const,
    update: { supported: true, strategy: 'git' as const, reason: null },
  };

  beforeEach(() => vi.clearAllMocks());

  it('offers an update on an install that can perform one', async () => {
    api.getVersion.mockResolvedValue(version);
    render(<SystemPanel />);

    expect(await screen.findByText('c5b551d')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update now' })).toBeInTheDocument();
  });

  it('hides the update button where it cannot work, and says what to do instead', async () => {
    // A button that does nothing is worse than no button: someone presses it
    // mid-service and reads the silence as a broken install.
    api.getVersion.mockResolvedValue({
      ...version,
      source: 'build' as const,
      deployment: 'container' as const,
      update: {
        supported: false,
        strategy: 'container' as const,
        reason: 'Update by pulling a newer image and recreating the container.',
      },
    });
    render(<SystemPanel />);

    expect(await screen.findByText(/pulling a newer image/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update now' })).not.toBeInTheDocument();
  });

  it('still names a version when there is no commit to show', async () => {
    // A release archive: it knows what version it is, just not from which commit.
    api.getVersion.mockResolvedValue({
      ...version,
      commit: 'unknown', subject: '', source: 'package' as const, deployment: 'package' as const,
      update: { supported: false, strategy: 'manual' as const, reason: 'Install the new version the same way.' },
    });
    render(<SystemPanel />);

    expect(await screen.findByText(/1\.0\.0/)).toBeInTheDocument();
    expect(screen.queryByText('unknown')).not.toBeInTheDocument();
  });
});

describe('Campuses', () => {
  const church = {
    name: 'Test Church',
    sites: [{
      id: 'north', name: 'North Campus', status: 'active' as const,
      auditoriums: [{
        id: 'north-main', name: 'Main Auditorium',
        tiles: [
          { id: 'main-companion', type: 'companion' as const, label: 'Companion', host: '192.0.2.10' },
          { id: 'main-cam', type: 'link' as const, label: 'Camera 9', url: 'http://192.0.2.20' },
        ],
      }],
    }],
  };

  beforeEach(() => {
    api.getConfig.mockReset();
    api.saveConfig.mockReset();
    api.savePcServiceTypes.mockReset();
    api.getConfig.mockResolvedValue(structuredClone(church));
    api.saveConfig.mockImplementation(async (c: unknown) => c);
    api.getRoomConnectivity.mockResolvedValue({
      hasServerRoom: true,
      planningCenter: { serviceTypes: [{ id: '500001', name: 'Sunday' }] },
      analysis: { source: 'smaart', host: '192.0.2.40', port: 26000, hasPassword: false, target: 90, limit: 95 },
      proPresenter: { host: '192.0.2.15', port: 62202 },
      companion: {
        mock: false, host: '192.0.2.51', port: 8000, variable: 'roomState',
        modes: [
          { id: 'sunday', label: 'Sunday', color: '#34c759', match: 'SUNDAY', press: { page: 1, row: 3, column: 1 } },
          { id: 'standby', label: 'Standby', color: '#8b97a8', match: 'STANDBY', press: { page: 1, row: 3, column: 4 }, isStandby: true },
        ],
      },
    });
    api.savePcServiceTypes.mockImplementation(async (_room: string, serviceTypes: unknown) => ({ serviceTypes }));
    api.saveAnalysis.mockReset();
    api.saveAnalysis.mockImplementation(async (_room: string, analysis: unknown) => analysis);
    api.saveProPresenter.mockReset();
    api.saveProPresenter.mockImplementation(async (_room: string, proPresenter: unknown) => proPresenter);
    api.saveCompanion.mockReset();
    api.saveCompanion.mockImplementation(async (_room: string, companion: unknown) => companion);
    api.getRooms.mockResolvedValue([{
      id: 'north-main', name: 'Main Auditorium', site: 'north', hasCompanion: true,
      modes: [{ id: 'sunday', label: 'Sunday', color: '#34c759', isStandby: false }, { id: 'standby', label: 'Standby', color: '#8b97a8', isStandby: true }],
    }]);
    api.getSettings.mockReset().mockResolvedValue({
      pins: { adminSet: true, overrideSet: false },
      schedules: {
        'north-main': [{ id: 'w1', label: 'Sunday Services', days: [0], start: '07:00', end: '13:30', lock: ['standby'] }],
        'north-youth': [{ id: 'w2', label: 'Youth', days: [3], start: '18:00', end: '21:00', lock: [] }],
      },
    });
    api.saveSchedules.mockReset().mockResolvedValue(undefined);
  });

  const roomPage = () => render(
    <MemoryRouter initialEntries={['/admin/campuses/north-main']}>
      <Routes>
        <Route path="/admin/campuses/:roomId" element={<RoomConfigPanel />} />
      </Routes>
    </MemoryRouter>,
  );

  /** The page is read-only cards; the whole card is the button that opens the
   *  editor. Every editing test starts here. */
  const openCard = async (user: ReturnType<typeof userEvent.setup>, title: RegExp) =>
    user.click(await screen.findByRole('button', { name: title }));

  const dialog = () => within(screen.getByRole('dialog'));

  it('overview lists rooms with Configure links; new rooms need a save first', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><CampusesPanel /></MemoryRouter>);

    expect(await screen.findByText('Main Auditorium')).toBeInTheDocument();
    expect(screen.getByText('2 tiles')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Configure' })).toHaveAttribute('href', '/admin/campuses/north-main');

    await user.click(screen.getByRole('button', { name: '+ Add room' }));
    expect(screen.getByText('save to configure')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.saveConfig).toHaveBeenCalled());
    const sent = api.saveConfig.mock.calls[0][0];
    expect(sent.sites[0].auditoriums).toHaveLength(2);
  });

  it('the page is summaries: what is set, and whether it answers', async () => {
    roomPage();
    const tiles = await screen.findByRole('button', { name: /Quick Access tiles/ });
    expect(tiles).toHaveTextContent('2 tiles');
    expect(tiles).toHaveTextContent('Companion · Camera 9');
    expect(screen.getByRole('button', { name: /Bitfocus Companion & modes/ })).toHaveTextContent('192.0.2.51:8000 · $(roomState)');
    expect(screen.getByRole('button', { name: /Analysis source/ })).toHaveTextContent('Smaart · 192.0.2.40:26000');
    expect(screen.getByRole('button', { name: /ProPresenter/ })).toHaveTextContent('192.0.2.15:62202');
    // Nothing is a form until you open one: no field on the page, no Save
    // but the header's.
    expect(screen.queryByLabelText('Host')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Save/ })).toHaveLength(1);
  });

  it('room page edits a tile host in its dialog and saves the whole tree', async () => {
    const user = userEvent.setup();
    roomPage();

    await openCard(user, /Quick Access tiles/);
    const host = dialog().getAllByLabelText('Host').find((el) => (el as HTMLInputElement).value === '192.0.2.10')!;
    await user.clear(host);
    await user.type(host, '192.0.2.17');
    await user.click(dialog().getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.saveConfig).toHaveBeenCalled());
    const sent = api.saveConfig.mock.calls[0][0];
    expect(sent.sites[0].auditoriums[0].tiles[0].host).toBe('192.0.2.17');
    // Saved → closed, and the card shows the stored tree.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('a dialog closed with edits in it discards them, and Escape will not do that', async () => {
    const user = userEvent.setup();
    roomPage();

    await openCard(user, /Quick Access tiles/);
    const label = dialog().getAllByLabelText('Label')[0];
    await user.clear(label);
    await user.type(label, 'Renamed');

    // Escape closes a clean dialog only — ten minutes of mode buttons must not
    // vanish on a reflex keypress. The button says what it will do instead.
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.click(dialog().getByRole('button', { name: 'Discard changes' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.saveConfig).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Quick Access tiles/ })).toHaveTextContent('Companion · Camera 9');

    // Clean again, so Escape may.
    await openCard(user, /Quick Access tiles/);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('edits Planning Center service types independently of the topology save', async () => {
    const user = userEvent.setup();
    roomPage();

    await openCard(user, /Planning Center service types/);
    expect(dialog().getByDisplayValue('Sunday')).toBeInTheDocument();

    await user.click(dialog().getByRole('button', { name: '+ Add service type' }));
    const names = dialog().getAllByLabelText('Name');
    const ids = dialog().getAllByLabelText('Service type ID');
    await user.type(names[names.length - 1], 'Second Service');
    await user.type(ids[ids.length - 1], '500002');
    await user.click(dialog().getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.savePcServiceTypes).toHaveBeenCalledWith('north-main', [
      { id: '500001', name: 'Sunday' },
      { id: '500002', name: 'Second Service' },
    ]));
    expect(api.saveConfig).not.toHaveBeenCalled();
    // The card shows what the server stored, not what was typed.
    await waitFor(() => expect(screen.getByRole('button', { name: /Planning Center service types/ })).toHaveTextContent('Sunday · Second Service'));
  });

  it('switches the analysis source to ProdMesh RTA and saves it', async () => {
    const user = userEvent.setup();
    roomPage();

    await openCard(user, /Analysis source/);
    expect(dialog().getByDisplayValue('192.0.2.40')).toBeInTheDocument();
    // Smaart shows the password field; RTA must not.
    expect(dialog().getByLabelText('API password')).toBeInTheDocument();

    await user.selectOptions(dialog().getByLabelText('Source'), 'rta');
    expect(dialog().queryByLabelText('API password')).not.toBeInTheDocument();
    expect(dialog().queryByText(/Start\/stop SPL logging/)).not.toBeInTheDocument();
    const host = dialog().getByLabelText('Host');
    await user.clear(host);
    await user.type(host, '192.0.2.52');
    await user.click(dialog().getByRole('button', { name: 'Save' }));

    // target/limit are edited on the widgets now, not here — but this form PUTs
    // a whole analysis object, so they must ride through a host change rather
    // than being dropped. They were, once, and every save blanked the room.
    await waitFor(() => expect(api.saveAnalysis).toHaveBeenCalledWith('north-main', {
      source: 'rta', host: '192.0.2.52', port: 26000, logControl: undefined, target: 90, limit: 95,
    }));
    expect(api.saveConfig).not.toHaveBeenCalled();
  });

  it('enables show-driven SPL log control for a Smaart source', async () => {
    const user = userEvent.setup();
    roomPage();

    await openCard(user, /Analysis source/);
    await user.click(dialog().getByText(/Start\/stop SPL logging/));
    await user.click(dialog().getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.saveAnalysis).toHaveBeenCalledWith('north-main', {
      source: 'smaart', host: '192.0.2.40', port: 26000, logControl: true, target: 90, limit: 95,
    }));
  });

  it('edits ProPresenter connectivity and clears it by blanking the host', async () => {
    const user = userEvent.setup();
    roomPage();

    await openCard(user, /ProPresenter/);
    await user.type(dialog().getByLabelText('Countdown timer'), 'Service Start');
    await user.click(dialog().getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.saveProPresenter).toHaveBeenCalledWith('north-main', {
      host: '192.0.2.15', port: 62202, timer: 'Service Start',
    }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: /ProPresenter/ })).toHaveTextContent('Countdown timer: Service Start');

    // Blanking the host means "no ProPresenter in this room" — saves a clear.
    await openCard(user, /ProPresenter/);
    await user.clear(dialog().getByLabelText('Host'));
    await user.click(dialog().getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.saveProPresenter).toHaveBeenLastCalledWith('north-main', null));
    await waitFor(() => expect(screen.getByRole('button', { name: /ProPresenter/ })).toHaveTextContent('Not in this room.'));
  });

  it('moves a mode button to a different page/row/col and adds a new mode', async () => {
    const user = userEvent.setup();
    roomPage();

    await openCard(user, /Bitfocus Companion & modes/);
    // Re-point the Sunday mode's button (first mode row) to page 3, row 0.
    const [page] = dialog().getAllByLabelText('Page');
    const [row] = dialog().getAllByLabelText('Row');
    await user.clear(page);
    await user.type(page, '3');
    await user.clear(row);
    await user.type(row, '0');

    await user.click(dialog().getByRole('button', { name: '+ Add mode' }));
    const labels = dialog().getAllByLabelText('Label');
    const ids = dialog().getAllByLabelText('ID');
    const matches = dialog().getAllByLabelText('Match');
    await user.type(labels[labels.length - 1], 'Second Service');
    await user.type(ids[ids.length - 1], 'second');
    await user.type(matches[matches.length - 1], 'SECOND');

    await user.click(dialog().getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.saveCompanion).toHaveBeenCalledWith('north-main', {
      mock: false, host: '192.0.2.51', port: 8000, variable: 'roomState',
      modes: [
        { id: 'sunday', label: 'Sunday', color: '#34c759', match: 'SUNDAY', press: { page: 3, row: 0, column: 1 } },
        { id: 'standby', label: 'Standby', color: '#8b97a8', match: 'STANDBY', press: { page: 1, row: 3, column: 4 }, isStandby: true },
        { id: 'second', label: 'Second Service', color: '#5b8def', match: 'SECOND' },
      ],
    }));
    // The card's swatches follow the stored modes.
    await waitFor(() => expect(screen.getByRole('button', { name: /Bitfocus Companion & modes/ })).toHaveTextContent('Second Service'));
  });

  it('schedules & locks live on the room page and save only this room’s windows', async () => {
    const user = userEvent.setup();
    roomPage();

    // The summary names the lock by the mode's label, not its id.
    const card = await screen.findByRole('button', { name: /Schedules & Locks/ });
    await waitFor(() => expect(card).toHaveTextContent('Sunday Services · Sun 07:00–13:30 · locks Standby'));

    await user.click(card);
    await user.click(dialog().getByRole('button', { name: '+ Window' }));
    const names = dialog().getAllByLabelText('Window name');
    await user.clear(names[1]);
    await user.type(names[1], 'Midweek');
    await user.click(dialog().getByRole('button', { name: 'Save' }));

    // The API stores every room's schedules as one map: this room's entry is
    // replaced and the other room's rides through untouched.
    await waitFor(() => expect(api.saveSchedules).toHaveBeenCalled());
    const sent = api.saveSchedules.mock.calls[0][0];
    expect(sent['north-youth']).toEqual([{ id: 'w2', label: 'Youth', days: [3], start: '18:00', end: '21:00', lock: [] }]);
    expect(sent['north-main']).toHaveLength(2);
    expect(sent['north-main'][0]).toEqual({ id: 'w1', label: 'Sunday Services', days: [0], start: '07:00', end: '13:30', lock: ['standby'] });
    expect(sent['north-main'][1]).toMatchObject({ label: 'Midweek', days: [0], start: '08:00', end: '12:00', lock: [] });
    await waitFor(() => expect(screen.getByRole('button', { name: /Schedules & Locks/ })).toHaveTextContent('Midweek · Sun 08:00–12:00'));
  });

  it('room page shows not-found for an unknown room id', async () => {
    render(
      <MemoryRouter initialEntries={['/admin/campuses/nope']}>
        <Routes>
          <Route path="/admin/campuses/:roomId" element={<RoomConfigPanel />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText(/No room "nope" exists/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '← All campuses' })).toBeInTheDocument();
  });
});
