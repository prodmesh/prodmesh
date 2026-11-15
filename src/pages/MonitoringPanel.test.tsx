import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { MonitoringOverview } from '../api';

const api = vi.hoisted(() => ({ getMonitoring: vi.fn(), sendMonitoringTest: vi.fn() }));
vi.mock('../api', async (importOriginal) => ({ ...await importOriginal<typeof import('../api')>(), ...api }));

import { MonitoringPanel } from './MonitoringPanel';

const overview: MonitoringOverview = {
  slack: { configured: true },
  rooms: [
    { id: 'north-main', name: 'Main Auditorium', site: 'north', watching: 'service', lastChecked: Date.now() - 12_000,
      integrations: [{ id: 'proPresenter', label: 'ProPresenter', state: 'down' }, { id: 'companion', label: 'Companion', state: 'ok' }] },
    { id: 'north-youth', name: 'Youth Room', site: 'north', watching: null, lastChecked: null, integrations: null },
  ],
  rules: [{
    id: 'integration-unreachable', name: 'An integration is unreachable',
    match: { kind: 'integration.down' }, condition: { for: 30_000 }, resolveOn: { kind: 'integration.up' },
    actions: [{ type: 'alert', severity: 'warning', escalate: { during: 'show-live', severity: 'critical', notify: 'slack' } }],
  }],
};

describe('Admin → Monitoring', () => {
  it('shows what it sends, what it watches and why, and the rule as a sentence', async () => {
    api.getMonitoring.mockResolvedValue(overview);
    render(<MonitoringPanel />);
    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('Before a service')).toBeInTheDocument();
    expect(screen.getByText('Not now')).toBeInTheDocument();
    expect(screen.getByText(/12 s ago/)).toBeInTheDocument();
    expect(screen.getByText(/an integration is unreachable for 30 seconds/)).toBeInTheDocument();
    expect(screen.getByText(/send it to Slack/)).toBeInTheDocument();
  });

  it('proves it can reach Slack', async () => {
    const user = userEvent.setup();
    api.getMonitoring.mockResolvedValue(overview);
    api.sendMonitoringTest.mockResolvedValue(undefined);
    render(<MonitoringPanel />);
    await user.click(await screen.findByRole('button', { name: /Send test/ }));
    expect(api.sendMonitoringTest).toHaveBeenCalled();
    expect(await screen.findByText('Sent.')).toBeInTheDocument();
  });

  it('says plainly when Slack is not connected, and that screens still work', async () => {
    api.getMonitoring.mockResolvedValue({ ...overview, slack: { configured: false } });
    render(<MonitoringPanel />);
    expect(await screen.findByText(/Not connected\. Issues still show on screens/)).toBeInTheDocument();
  });
});
