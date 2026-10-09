import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { RoomStatus } from './RoomStatus';
import type { RoomMeta, RoomState } from '../api';

const api = vi.hoisted(() => ({
  getRoom: vi.fn(),
  getRoomState: vi.fn(),
  setRoomMode: vi.fn(),
  getRoomPlan: vi.fn(),
}));

// Partial mock: OverrideRequiredError must be the REAL class so the page's
// `instanceof` check in confirmMode sees the same constructor the mock throws.
vi.mock('../api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api')>(),
  ...api,
}));

// ServicePanel fetches Planning Center data on its own — out of scope here.
vi.mock('../components/ServicePanel', () => ({
  ServicePanel: () => <div data-testid="service-panel" />,
}));

import { OverrideRequiredError } from '../api';
import { clearQueryCache } from '../lib/useQuery';
import { emitTopic } from '../test/fakeEventSource';
import { ChurchContext } from '../layout/church';

const room: RoomMeta = {
  id: 'north-main',
  name: 'Main Auditorium',
  site: 'north',
  hasCompanion: true,
  modes: [
    { id: 'show', label: 'Show', color: '#e33', isStandby: false },
    { id: 'walkin', label: 'Walk In', color: '#3a6', isStandby: false },
    { id: 'off', label: 'Standby', color: '#667', isStandby: true },
  ],
};

const baseState: RoomState = {
  mode: 'walkin',
  raw: 'walkin',
  online: true,
  source: 'companion',
  protection: { active: false, label: null, lockedModes: [], enforced: false },
};

const lockedState: RoomState = {
  ...baseState,
  protection: {
    active: true,
    label: 'Sunday services',
    lockedModes: ['off'],
    enforced: true,
  },
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/room/north-main']}>
      <Routes>
        <Route path="/room/:roomId" element={<RoomStatus />} />
      </Routes>
    </MemoryRouter>,
  );
}

const dialog = () => screen.getByRole('dialog');

// Room Mode collapses whenever the room is OUT of Standby, so any test that
// drives the mode buttons has to open it first — exactly as an operator would.
// Returns a scope for the panel BODY: the collapsed header repeats the current
// mode's name, so an unscoped query for it matches the header too.
async function openModePanel(user: ReturnType<typeof userEvent.setup>) {
  const head = await screen.findByRole('button', { name: /Room Mode/ });
  if (head.getAttribute('aria-expanded') === 'false') await user.click(head);
  return within(document.getElementById(head.getAttribute('aria-controls')!)!);
}

beforeEach(() => {
  clearQueryCache();
  api.getRoom.mockResolvedValue(room);
  api.getRoomState.mockResolvedValue(baseState);
  api.setRoomMode.mockReset();
  api.getRoomPlan.mockReset();
  api.getRoomPlan.mockResolvedValue({
    live: true,
    plan: {
      id: 'plan-1', serviceTypeId: 'st', serviceTypeName: 'Sunday', title: 'July 27 Service',
      seriesTitle: null, dates: 'July 27', sortDate: null, items: [],
      times: [{ id: 't-svc', name: '1st Service', startsAt: '2026-07-26T16:00:00Z', endsAt: null, type: 'service' }],
    },
  });
});

describe('mode buttons', () => {
  it('renders every mode, marks the current one active and disabled', async () => {
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText('Companion live')).toBeInTheDocument();
    const panel = await openModePanel(user);
    const active = panel.getByRole('button', { name: /Walk In/ });
    expect(active).toBeDisabled();
    expect(within(active).getByText('Active now')).toBeInTheDocument();
    expect(panel.getByRole('button', { name: 'Show' })).toBeEnabled();
    expect(panel.getByRole('button', { name: 'Standby' })).toBeEnabled();
  });

  // A dead Companion and a simulated room are both online:false; only one is
  // a fault (#54). Both used to read "Demo mode".
  it('calls a live room whose Companion stopped answering offline', async () => {
    api.getRoomState.mockResolvedValue({
      ...baseState, mode: null, raw: '', online: false, error: 'connect ECONNREFUSED',
    });
    renderPage();
    expect(await screen.findByText('Companion offline')).toBeInTheDocument();
    expect(screen.queryByText('Simulated')).not.toBeInTheDocument();
  });

  it('calls a simulated room simulated, not offline', async () => {
    api.getRoomState.mockResolvedValue({ ...baseState, online: false, source: 'mock' });
    renderPage();
    expect(await screen.findByText('Simulated')).toBeInTheDocument();
    expect(screen.queryByText('Companion offline')).not.toBeInTheDocument();
  });

  it('confirms an unlocked change and follows the mode the server pushes back', async () => {
    const next = { ...baseState, mode: 'show', raw: 'show' };
    api.setRoomMode.mockResolvedValue(next);
    const user = userEvent.setup();
    renderPage();

    await openModePanel(user);
    await user.click(await screen.findByRole('button', { name: 'Show' }));
    expect(within(dialog()).getByText(/Switch/)).toBeInTheDocument();
    await user.click(within(dialog()).getByRole('button', { name: 'Yes, Show' }));

    // No PIN prompt for an unlocked mode — overridePin stays undefined.
    expect(api.setRoomMode).toHaveBeenCalledWith('north-main', 'show', undefined);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // The page does NOT paint the response; the server bumps the room's mode
    // watcher after the press so every screen moves on the same push.
    await emitTopic({ 'room:north-main:mode': next });
    const active = await screen.findByRole('button', { name: /^Show/ });
    expect(active).toBeDisabled();
    expect(within(active).getByText('Active now')).toBeInTheDocument();
  });

  it('Cancel closes the dialog without calling the API', async () => {
    const user = userEvent.setup();
    renderPage();

    await openModePanel(user);
    await user.click(await screen.findByRole('button', { name: 'Show' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.setRoomMode).not.toHaveBeenCalled();
  });
});

describe('room console layout', () => {
  it('collapses Room Mode out of Standby, still naming the current mode', async () => {
    renderPage();

    // Header answers the question without being opened…
    const head = await screen.findByRole('button', { name: /Room Mode/ });
    expect(head).toHaveAttribute('aria-expanded', 'false');
    expect(within(head).getByText('Walk In')).toBeInTheDocument();
    // …and the controls are genuinely not rendered.
    expect(screen.queryByRole('button', { name: 'Show' })).not.toBeInTheDocument();
  });

  it('opens Room Mode automatically while the room is in Standby', async () => {
    api.getRoomState.mockResolvedValue({ ...baseState, mode: 'off', raw: 'off' });
    renderPage();

    expect(await screen.findByRole('button', { name: /Room Mode/ }))
      .toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Show' })).toBeEnabled();
  });

  it('shows the room’s Quick Access tiles', async () => {
    render(
      <ChurchContext.Provider
        value={{
          name: 'Test Church',
          sites: [{
            id: 'north', name: 'North Campus', status: 'active',
            auditoriums: [{
              id: 'north-main', name: 'Main Auditorium',
              tiles: [
                { id: 't1', type: 'link', label: 'NDI Tools', url: 'https://example.test' },
                { id: 't2', type: 'screenshare', label: 'Producer Mac', host: '10.0.0.5' },
              ],
            }],
          }],
        }}
      >
        <MemoryRouter initialEntries={['/room/north-main']}>
          <Routes>
            <Route path="/room/:roomId" element={<RoomStatus />} />
          </Routes>
        </MemoryRouter>
      </ChurchContext.Provider>,
    );

    expect(await screen.findByRole('button', { name: /Quick Access/ }))
      .toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('NDI Tools')).toBeInTheDocument();
    expect(screen.getByText('Producer Mac')).toBeInTheDocument();
  });
});

describe('live-show banner', () => {
  it('is absent when no show is running', async () => {
    renderPage();
    await screen.findByText('Companion live');
    expect(screen.queryByText('LIVE')).not.toBeInTheDocument();
  });

  it('announces the live service with its time and links to the Run of Show', async () => {
    renderPage();
    await emitTopic({
      'room:north-main:show': {
        active: true, roomId: 'north-main', planId: 'plan-1', timeId: 't-svc',
        startedAt: new Date('2026-07-26T15:58:00Z').getTime(),
      },
    });

    expect(await screen.findByText('LIVE')).toBeInTheDocument();
    expect(await screen.findByText('July 27 Service')).toBeInTheDocument();
    expect(screen.getByText(/1st Service/)).toBeInTheDocument();
    expect(screen.getByText(/started/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Run of Show' }))
      .toHaveAttribute('href', '/room/north-main/run/plan-1?time=t-svc');
  });

  it('falls back gracefully when the plan is no longer fetchable', async () => {
    api.getRoomPlan.mockRejectedValue(new Error('Plan not found'));
    renderPage();
    await emitTopic({
      'room:north-main:show': { active: true, planId: 'plan-old', timeId: 'default' },
    });

    expect(await screen.findByText('LIVE')).toBeInTheDocument();
    expect(screen.getByText('Show in progress')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Run of Show' }))
      .toHaveAttribute('href', '/room/north-main/run/plan-old');
  });
});

describe('override-PIN flow', () => {
  beforeEach(() => {
    api.getRoomState.mockResolvedValue(lockedState);
  });

  it('shows the protection banner and a lock on the locked mode', async () => {
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText('Sunday services')).toBeInTheDocument();
    expect(screen.getByText(/override PIN required/)).toBeInTheDocument();
    await openModePanel(user);
    const locked = screen.getByRole('button', { name: /Standby/ });
    expect(within(locked).getByLabelText('locked')).toBeInTheDocument();
  });

  it('requires a PIN, rejects a wrong one, and completes with the right one', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Sunday services');
    await openModePanel(user);

    await user.click(screen.getByRole('button', { name: /Standby/ }));
    const pinInput = within(dialog()).getByLabelText(/Enter override PIN/);

    // Empty PIN never reaches the server.
    await user.click(within(dialog()).getByRole('button', { name: 'Yes, Standby' }));
    expect(await screen.findByText('Enter the override PIN to continue.')).toBeInTheDocument();
    expect(api.setRoomMode).not.toHaveBeenCalled();

    // Wrong PIN → server 403 override_required → specific message, dialog stays.
    api.setRoomMode.mockRejectedValueOnce(new OverrideRequiredError());
    await user.type(pinInput, '0000');
    await user.click(within(dialog()).getByRole('button', { name: 'Yes, Standby' }));
    expect(await screen.findByText('Incorrect override PIN.')).toBeInTheDocument();
    expect(api.setRoomMode).toHaveBeenCalledWith('north-main', 'off', '0000');

    // Correct PIN → mode applies, dialog closes.
    api.setRoomMode.mockResolvedValueOnce({ ...lockedState, mode: 'off', raw: 'off' });
    await user.clear(pinInput);
    await user.type(pinInput, '4457');
    await user.click(within(dialog()).getByRole('button', { name: 'Yes, Standby' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.setRoomMode).toHaveBeenLastCalledWith('north-main', 'off', '4457');
  });

  it('reports a generic failure distinctly from a wrong PIN', async () => {
    api.setRoomMode.mockRejectedValue(new Error('HTTP 502'));
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Sunday services');
    await openModePanel(user);

    await user.click(screen.getByRole('button', { name: /Standby/ }));
    await user.type(within(dialog()).getByLabelText(/Enter override PIN/), '4457');
    await user.click(within(dialog()).getByRole('button', { name: 'Yes, Standby' }));

    expect(await screen.findByText('Something went wrong — try again.')).toBeInTheDocument();
    expect(screen.queryByText('Incorrect override PIN.')).not.toBeInTheDocument();
  });
});
