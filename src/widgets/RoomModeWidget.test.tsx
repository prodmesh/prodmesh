import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomModeWidget } from './RoomModeWidget';
import { emitTopic } from '../test/fakeEventSource';

const api = vi.hoisted(() => ({ getRoom: vi.fn() }));
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  ...api,
}));

const MODES = [
  { id: 'sunday', label: 'Sunday Service', color: '#22c55e', isStandby: false },
  { id: 'standby', label: 'Standby', color: '#64748b', isStandby: true },
];

const state = (over = {}) => ({
  mode: 'sunday',
  raw: 'SUNDAY',
  online: true,
  source: 'companion',
  protection: { active: false, label: null, lockedModes: [], enforced: false },
  ...over,
});

const show = () => render(<RoomModeWidget roomId="north-main" config={{}} />);
const push = (data: unknown) => emitTopic({ 'room:north-main:mode': data });

beforeEach(() => {
  api.getRoom.mockReset().mockResolvedValue({
    id: 'north-main', name: 'North Main', site: null, hasCompanion: true, modes: MODES,
  });
});

describe('RoomModeWidget', () => {
  it('says it is connecting rather than rendering an empty cell', async () => {
    // Unlike loudness or viewers, a room ALWAYS has a mode — so nothing here
    // reads as a fault, not as quiet.
    show();
    expect(await screen.findByText('Connecting…')).toBeInTheDocument();
  });

  it('shows the mode in the colour the room configured for it', async () => {
    show();
    await push(state());
    const value = await screen.findByText('Sunday Service');
    expect(value).toHaveStyle({ color: 'rgb(34, 197, 94)' });
  });

  it('shows the raw value when nothing maps, because that is what fixes it', async () => {
    // Companion answered with a state string no configured mode matches. The
    // admin needs to see the string to correct the mapping; "Unknown" sends
    // them to the logs for it.
    show();
    await screen.findByText('Connecting…');
    await push(state({ mode: null, raw: 'REHEARSAL_B' }));
    expect(await screen.findByText('REHEARSAL_B')).toBeInTheDocument();
  });

  it('calls out a Companion that has stopped answering', async () => {
    // EXACTLY the shape readRoomState emits on that path (roomModes.test.js
    // pins the server side). Keep the fixture matched to the server: an
    // earlier version of this widget checked source+online, a pair the server
    // never produced together — it passed against an invented fixture and did
    // nothing in the building.
    show();
    await push(state({
      online: false, source: 'companion', raw: '', mode: null,
      error: 'connect ECONNREFUSED 127.0.0.1:8000',
    }));
    expect(await screen.findByText(/Companion offline/)).toBeInTheDocument();
    // Unknown, not a plausible word the room is not necessarily in (#54).
    expect(screen.getByText('Unknown mode')).toBeInTheDocument();
    expect(screen.queryByText('Sunday Service')).not.toBeInTheDocument();
  });

  it('does not call a mock room offline, because that is not a fault', async () => {
    // A mock room reports online:false and source:'mock' as a matter of
    // course — nothing is wired up, which is the expected state of a demo or
    // a dev box. Same two fields as the failure above; no `error`.
    show();
    await push(state({ online: false, source: 'mock' }));
    expect(await screen.findByText('Sunday Service')).toBeInTheDocument();
    expect(screen.queryByText(/Companion offline/)).not.toBeInTheDocument();
  });

  it('shows the schedule lock, with the window that caused it', async () => {
    show();
    await push(state({
      protection: {
        active: true, label: 'Sunday morning', lockedModes: ['standby'], enforced: true,
      },
    }));
    expect(await screen.findByText('Locked')).toBeInTheDocument();
    expect(screen.getByText('Sunday morning')).toBeInTheDocument();
  });

  it('reads the room once however many screens want its labels', async () => {
    // Same cache key as the Views index and the room page, which is the whole
    // reason a widget can fetch its own supporting data.
    show();
    show();
    await screen.findAllByText('Connecting…');
    expect(api.getRoom).toHaveBeenCalledTimes(1);
  });
});
