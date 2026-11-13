import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LinkedServersPanel } from './LinkedServers';
import type { FederationOverview } from '../api';

const api = vi.hoisted(() => ({
  getFederation: vi.fn(),
  saveFederationConfig: vi.fn(),
  createJoinToken: vi.fn(),
  cancelJoinToken: vi.fn(),
  redeemJoinToken: vi.fn(),
  acceptPeer: vi.fn(),
  checkPeer: vi.fn(),
  setPeerAddress: vi.fn(),
  removePeer: vi.fn(),
  setVisitorRules: vi.fn(),
}));
vi.mock('../api', async (importOriginal) => ({ ...await importOriginal<typeof import('../api')>(), ...api }));

const FP = 'AB:'.repeat(31) + 'AB';
const base = (over: Partial<FederationOverview> = {}): FederationOverview => ({
  config: {
    enabled: true, bind: 'all', port: 8443, address: '', effectiveAddress: '192.0.2.10:8443',
    dashboardUrl: '', effectiveDashboardUrl: 'http://192.0.2.10:8080',
    interfaces: [{ name: 'en0', address: '192.0.2.10' }], warnAllInterfaces: false,
  },
  listener: { listening: true, host: 'all', port: 8443, error: null },
  identity: { systemId: 'id-north', name: 'Grace — North', tlsFingerprint: FP },
  peers: [],
  tokens: [],
  ...over,
});
const peer = (over = {}) => ({
  systemId: 'id-south', name: 'Grace — South', address: '192.0.2.20:8443', fingerprint: FP,
  state: 'pending' as const, awaiting: 'us' as const, createdAt: 0, pairedAt: null,
  lastSeenAt: null, lastError: null, clockSkewMs: null, ...over,
});

describe('Admin → Linked servers', () => {
  beforeEach(() => vi.clearAllMocks());

  it('cannot pair until the link is on', async () => {
    api.getFederation.mockResolvedValue(base({
      config: { ...base().config, enabled: false },
      listener: { listening: false, host: null, port: null, error: null },
    }));
    render(<LinkedServersPanel />);
    expect(await screen.findByRole('button', { name: 'Create join token' })).toBeDisabled();
    expect(screen.getByText('Switch the link on first.')).toBeInTheDocument();
  });

  it('warns when a multi-homed server offers the link on every interface', async () => {
    api.getFederation.mockResolvedValue(base({
      config: { ...base().config, warnAllInterfaces: true,
        interfaces: [{ name: 'en0', address: '192.0.2.10' }, { name: 'en1', address: '198.51.100.10' }] },
    }));
    const user = userEvent.setup();
    render(<LinkedServersPanel />);
    expect(await screen.findByText(/more than one network connection/)).toBeInTheDocument();
    // Choosing an interface is the fix, and the warning goes with it.
    await user.selectOptions(screen.getByRole('combobox'), 'en0');
    expect(screen.queryByText(/more than one network connection/)).not.toBeInTheDocument();
  });

  it('a site that redeemed our token waits for Accept', async () => {
    api.getFederation.mockResolvedValue(base({ peers: [peer()] }));
    api.acceptPeer.mockResolvedValue(base({ peers: [peer({ state: 'paired', awaiting: null, lastSeenAt: Date.now() })] }));
    const user = userEvent.setup();
    render(<LinkedServersPanel />);
    expect(await screen.findByText('Waiting for you to accept')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Accept' }));
    expect(api.acceptPeer).toHaveBeenCalledWith('id-south');
    expect(await screen.findByText(/Connected/)).toBeInTheDocument();
  });

  it('pasting a token pairs, and says it is waiting on the other site', async () => {
    api.getFederation.mockResolvedValue(base());
    api.redeemJoinToken.mockResolvedValue({ ...base({ peers: [peer({ awaiting: 'them' })] }), peer: peer({ awaiting: 'them' }) });
    const user = userEvent.setup();
    render(<LinkedServersPanel />);
    await user.type(await screen.findByLabelText('Join with a token'), '  pmjoin1.abc  ');
    await user.click(screen.getByRole('button', { name: 'Pair' }));
    expect(api.redeemJoinToken).toHaveBeenCalledWith('pmjoin1.abc');
    expect(await screen.findByText('Waiting for Grace — South to accept')).toBeInTheDocument();
  });

  it('says plainly when the other side unpaired, and warns about clock skew', async () => {
    api.getFederation.mockResolvedValue(base({ peers: [
      peer({ state: 'paired', awaiting: null, lastError: 'unpaired_by_peer', lastSeenAt: Date.now() - 600_000 }),
    ] }));
    render(<LinkedServersPanel />);
    expect(await screen.findByText('No longer paired on the other server')).toBeInTheDocument();

    api.getFederation.mockResolvedValue(base({ peers: [
      peer({ state: 'paired', awaiting: null, lastSeenAt: Date.now(), clockSkewMs: -95_000 }),
    ] }));
    render(<LinkedServersPanel />);
    expect(await screen.findByText(/Clock is 95s behind/)).toBeInTheDocument();
  });

  it('says when a linked server is too old to share its campuses', async () => {
    api.getFederation.mockResolvedValue(base({ peers: [
      peer({ state: 'paired', awaiting: null, lastSeenAt: Date.now(), version: '1.4.2', sharesCampuses: false }),
    ] }));
    render(<LinkedServersPanel />);
    expect(await screen.findByText(/campuses can't be shown: update ProdMesh there \(it runs 1\.4\.2\)/)).toBeInTheDocument();
  });

  it('edits what people from a linked server may do here, from the grantable list only', async () => {
    api.getFederation.mockResolvedValue(base({
      peers: [peer({ state: 'paired', awaiting: null, lastSeenAt: Date.now(), visitorRules: [{ group: '*', permissions: ['reports.view'] }] })],
      visitorPermissions: [
        { id: 'reports.view', label: 'View reports', description: '' },
        { id: 'shows.operate', label: 'Operate shows', description: '' },
      ],
    }));
    api.setVisitorRules.mockResolvedValue(base());
    const user = userEvent.setup();
    render(<LinkedServersPanel />);
    await user.click(await screen.findByRole('button', { name: 'Visitors' }));
    const dialog = screen.getByRole('dialog', { name: /What people from Grace — South may do here/ });
    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(2);
    await user.click(within(dialog).getByRole('button', { name: 'Add group rule' }));
    await user.type(within(dialog).getByLabelText('Group name'), 'Tech Directors');
    await user.click(within(dialog).getAllByRole('checkbox', { name: 'Operate shows' })[1]);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(api.setVisitorRules).toHaveBeenCalledWith('id-south', [
      { group: '*', permissions: ['reports.view'] },
      { group: 'Tech Directors', permissions: ['shows.operate'] },
    ]);
  });

  it('confirms before removing a site', async () => {
    api.getFederation.mockResolvedValue(base({ peers: [peer({ state: 'paired', awaiting: null, lastSeenAt: Date.now() })] }));
    api.removePeer.mockResolvedValue(base());
    const user = userEvent.setup();
    render(<LinkedServersPanel />);
    await user.click(await screen.findByRole('button', { name: /Remove/ }));
    expect(api.removePeer).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: /Unpair Grace — South/ });
    await user.click(within(dialog).getByRole('button', { name: 'Remove server' }));
    expect(api.removePeer).toHaveBeenCalledWith('id-south');
  });
});
