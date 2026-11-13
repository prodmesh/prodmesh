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
  saveAutomationDefault: vi.fn(),
  clearAutomationDefault: vi.fn(),
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
    expect(api.saveShowConfig).toHaveBeenCalledWith('r', 'p', expect.objectContaining({ startItemId: 'worship' }));
    // Untouched, so it is not this event's own: it follows the default (#58).
    expect(api.saveShowConfig.mock.calls[0][2]).not.toHaveProperty('servicesLiveFromProPresenter');
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
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /ProPresenter controls Services LIVE/ }), 'On');
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

describe('Show Automation defaults per service type (#58)', () => {
  const sunday = { id: 'st1', name: 'Sunday Morning' };
  beforeEach(() => {
    vi.clearAllMocks();
    api.getPpPlaylist.mockResolvedValue({ playlist: null });
    api.saveShowConfig.mockImplementation(async (_room: string, _plan: string, c: ShowConfig) => c);
    api.saveAutomationDefault.mockImplementation(async (_r: string, _st: string, d: unknown) => d);
  });

  it('an event with nothing of its own shows and runs its default', () => {
    render(<ShowConfigWidget roomId="r" planId="p" items={items} times={times} saved={null} serviceType={sunday}
      automationDefault={{ startItemTitle: 'pre-service slides', startAtScheduledTime: false, endItemTitle: 'Closing', servicesLiveFromProPresenter: true }} />);
    const start = within(row(/Autostart service at/)).getByRole('combobox');
    expect(start).toHaveDisplayValue('Sunday Morning default · pre-service slides');
    expect(screen.getByText('● armed')).toBeInTheDocument();
    expect(screen.getByText(/lets go when the show ends/)).toBeInTheDocument();
  });

  it('saving as the default sends titles, not this week\u2019s item ids, and the event then follows it', async () => {
    render(<ShowConfigWidget roomId="r" planId="p" items={items} times={times} serviceType={sunday}
      saved={{ startItemId: 'worship', startAtScheduledTime: false, endItemId: 'closing', map: {}, videos: {} }} />);
    await userEvent.click(screen.getByRole('button', { name: 'Save as Sunday Morning default' }));
    expect(api.saveAutomationDefault).toHaveBeenCalledWith('r', 'st1', {
      startItemTitle: 'Worship', startAtScheduledTime: false, endItemTitle: 'Closing', servicesLiveFromProPresenter: false,
    });
    expect(api.saveShowConfig).toHaveBeenCalledWith('r', 'p', { map: {}, videos: {} });
    expect(within(row(/Autostart service at/)).getByRole('combobox')).toHaveDisplayValue('Sunday Morning default · Worship');
  });

  it('an event can override the default with Never', async () => {
    render(<ShowConfigWidget roomId="r" planId="p" items={items} times={times} saved={null} serviceType={sunday}
      automationDefault={{ startItemTitle: 'Worship', startAtScheduledTime: false, endItemTitle: null, servicesLiveFromProPresenter: false }} />);
    await userEvent.selectOptions(within(row(/Autostart service at/)).getByRole('combobox'), 'Never (start manually)');
    await userEvent.click(screen.getByRole('button', { name: 'Save automation' }));
    expect(api.saveShowConfig).toHaveBeenCalledWith('r', 'p', expect.objectContaining({ startItemId: null, startAtScheduledTime: false }));
  });

  it('warns when the default names an item this plan does not have', () => {
    render(<ShowConfigWidget roomId="r" planId="p" items={items} times={times} saved={null} serviceType={sunday}
      automationDefault={{ startItemTitle: 'Countdown', startAtScheduledTime: false, endItemTitle: null, servicesLiveFromProPresenter: false }} />);
    expect(screen.getByText(/No item titled “Countdown” in this plan/)).toBeInTheDocument();
    expect(screen.getByText('○ manual')).toBeInTheDocument();
  });
});
