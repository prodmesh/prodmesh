import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ShowConfigWidget } from './ShowConfigWidget';
import type { PlanItem, PlanTime, ShowConfig } from '../api';

const api = vi.hoisted(() => ({
  getPpPlaylist: vi.fn(),
  getYouTubeBroadcasts: vi.fn(),
  saveShowConfig: vi.fn(),
  clearShowConfig: vi.fn(),
}));
vi.mock('../api', async (importOriginal) => ({ ...await importOriginal<typeof import('../api')>(), ...api }));

const items = [
  { id: 'pre', title: 'Pre-Service Slides', type: 'item' },
  { id: 'worship', title: 'Worship', type: 'song' },
  { id: 'closing', title: 'Closing', type: 'item' },
] as unknown as PlanItem[];
const times: PlanTime[] = [];

const row = (label: RegExp) => screen.getByText(label).closest('.showcfg__row') as HTMLElement;

describe('Show Automation', () => {
  beforeEach(() => {
    api.getPpPlaylist.mockResolvedValue({ playlist: null });
    api.saveShowConfig.mockImplementation(async (_room: string, _plan: string, c: ShowConfig) => c);
  });

  it('sets autostart without going anywhere near Services LIVE', async () => {
    // The regression: autostart was reachable only through a Services LIVE
    // trigger, so a church that does not use Services LIVE could not set it.
    render(<ShowConfigWidget roomId="r" planId="p" items={items} times={times} saved={null} />);
    await userEvent.selectOptions(within(row(/Autostart service at/)).getByRole('combobox'), 'worship');
    await userEvent.click(screen.getByRole('button', { name: 'Save automation' }));
    expect(api.saveShowConfig).toHaveBeenCalledWith('r', 'p', expect.objectContaining({
      startItemId: 'worship',
      servicesLiveFromProPresenter: false,
    }));
  });

  it('can start on the clock instead of a ProPresenter item', async () => {
    render(<ShowConfigWidget roomId="r" planId="p" items={items} times={times} saved={null} />);
    const select = within(row(/Autostart service at/)).getByRole('combobox');
    await userEvent.selectOptions(select, 'worship');
    await userEvent.selectOptions(select, 'Scheduled time');
    expect(screen.getByText(/starts on the clock/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save automation' }));
    // The item picked first does not survive the switch: one way to start.
    expect(api.saveShowConfig).toHaveBeenCalledWith('r', 'p', expect.objectContaining({
      startAtScheduledTime: true,
      startItemId: null,
    }));
  });

  it('adds no second dropdown when Services LIVE is ticked', async () => {
    // Two dropdowns whose difference nobody could see was half the complaint.
    render(<ShowConfigWidget roomId="r" planId="p" items={items} times={times} saved={null} />);
    const before = screen.getAllByRole('combobox').length;
    await userEvent.click(screen.getByRole('checkbox', { name: /ProPresenter controls Services LIVE/ }));
    expect(screen.getAllByRole('combobox')).toHaveLength(before);
    expect(screen.getByText(/lets go when the show ends/)).toBeInTheDocument();
  });

  it('shows a promoted legacy trigger as the autostart item', () => {
    // getConfig promotes an old Services LIVE trigger on read, so the event
    // opens showing the item it has always started at.
    render(<ShowConfigWidget roomId="r" planId="p" items={items} times={times}
      saved={{ startItemId: 'worship', endItemId: null, map: {}, videos: {}, servicesLiveFromProPresenter: true }} />);
    expect(within(row(/Autostart service at/)).getByRole('combobox')).toHaveValue('worship');
  });
});
