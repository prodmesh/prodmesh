import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { Issue } from '../api';

const api = vi.hoisted(() => ({ claimIssue: vi.fn() }));
vi.mock('../api', async (importOriginal) => ({ ...await importOriginal<typeof import('../api')>(), ...api }));

import { IssueStrip } from './Issues';
import { Notifications } from './Notifications';
import { emitTopic } from '../test/fakeEventSource';

const at = new Date('2026-11-15T17:12:00Z').getTime();
const issue = (over: Partial<Issue> = {}): Issue => ({
  id: 1,
  title: 'Main Auditorium · ProPresenter is unreachable',
  integration: 'proPresenter',
  severity: 'warning',
  state: 'open',
  roomIds: ['north-main'],
  firstSeen: at,
  lastSeen: at,
  count: 1,
  flapping: false,
  ackedBy: null,
  ackedAt: null,
  resolvedAt: null,
  ...over,
});

const strip = () =>
  render(<MemoryRouter><IssueStrip roomId="north-main" /></MemoryRouter>);

beforeEach(() => api.claimIssue.mockReset());

describe('IssueStrip', () => {
  it('says nothing while the room is fine', async () => {
    strip();
    await emitTopic({ alerts: [] });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('answers what, since when, and who: amber with no show live', async () => {
    strip();
    await emitTopic({ alerts: [issue()] });
    const s = screen.getByRole('status');
    expect(s).toHaveClass('issuestrip--warning');
    expect(within(s).getByText('ProPresenter unreachable')).toBeInTheDocument();
    expect(s).toHaveTextContent(/since \d{1,2}:12/);
    expect(within(s).getByRole('button', { name: /I’m on it/ })).toBeInTheDocument();
  });

  it('is red when a show is live, and names who claimed it instead of offering the button', async () => {
    strip();
    await emitTopic({ alerts: [issue({ severity: 'critical', state: 'acknowledged', ackedBy: 'Sam' })] });
    const s = screen.getByRole('status');
    expect(s).toHaveClass('issuestrip--critical');
    expect(s).toHaveTextContent('Sam is on it');
    expect(within(s).queryByRole('button', { name: /I’m on it/ })).toBeNull();
  });

  it('ignores other rooms and org-wide issues: those live in the sidebar', async () => {
    strip();
    await emitTopic({ alerts: [issue({ roomIds: ['north-youth'] }), issue({ id: 2, title: 'Planning Center is unreachable', roomIds: [] })] });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('collapses several issues into one line, with details beside the page', async () => {
    const user = userEvent.setup();
    strip();
    await emitTopic({ alerts: [issue(), issue({ id: 2, title: 'Main Auditorium · Companion is unreachable', integration: 'companion' })] });
    expect(screen.getByRole('status')).toHaveTextContent('2 issues · ProPresenter unreachable, Companion unreachable');
    await user.click(screen.getByRole('button', { name: 'Details' }));
    const sheet = screen.getByRole('complementary', { name: 'Issues' });
    expect(within(sheet).getByText(/Room modes cannot be read or changed/)).toBeInTheDocument();
    expect(within(sheet).getAllByRole('button', { name: /I’m on it/ })).toHaveLength(2);
  });

  it('claims it with one press', async () => {
    const user = userEvent.setup();
    api.claimIssue.mockResolvedValue(issue({ state: 'acknowledged', ackedBy: 'Sam' }));
    strip();
    await emitTopic({ alerts: [issue()] });
    await user.click(screen.getByRole('button', { name: /I’m on it/ }));
    expect(api.claimIssue).toHaveBeenCalledWith(1);
  });

  it('shows it coming back for a moment, rather than just going quiet', async () => {
    strip();
    await emitTopic({ alerts: [issue()] });
    await emitTopic({ alerts: [] });
    const s = screen.getByRole('status');
    expect(s).toHaveClass('issuestrip--clear');
    expect(s).toHaveTextContent(/ProPresenter back · down/);
  });

  it('says when it keeps dropping out', async () => {
    strip();
    await emitTopic({ alerts: [issue({ flapping: true })] });
    expect(screen.getByRole('status')).toHaveTextContent(/dropping in and out since/);
  });
});

describe('Notifications', () => {
  const sidebar = () => render(<MemoryRouter><Notifications /></MemoryRouter>);

  it('is quiet with nothing open', async () => {
    const user = userEvent.setup();
    sidebar();
    await emitTopic({ alerts: [] });
    const button = screen.getByRole('button', { name: 'Notifications' });
    expect(button).not.toHaveClass('notify--warning');
    await user.click(button);
    expect(screen.getByRole('dialog', { name: 'Notifications' })).toHaveTextContent('All clear.');
  });

  it('counts everything open, takes the worst colour, and lists org-wide issues too', async () => {
    const user = userEvent.setup();
    sidebar();
    await emitTopic({
      alerts: [
        issue({ severity: 'critical' }),
        issue({ id: 2, title: 'Planning Center is unreachable', integration: 'planningCenter', roomIds: [] }),
      ],
    });
    const button = screen.getByRole('button', { name: 'Notifications: 2 open' });
    expect(button).toHaveClass('notify--critical');
    await user.click(button);
    const panel = screen.getByRole('dialog', { name: 'Notifications' });
    expect(within(panel).getByRole('link', { name: 'Main Auditorium · ProPresenter unreachable' })).toHaveAttribute('href', '/room/north-main');
    expect(within(panel).getByText('Planning Center unreachable')).toBeInTheDocument();
  });
});
