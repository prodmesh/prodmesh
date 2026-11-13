// Admin → Linked servers: pairing this ProdMesh server with another (ADR 0017).
//
// A server, not a campus. One server can run several campuses (Admin →
// Campuses), and campuses are what users see; this page only links the boxes.
//
// Three things on one page, in the order an admin meets them: switch the
// federation link on and say where it listens; pair, by issuing a join token
// or redeeming one; and the servers already paired. Everything here talks to
// this server; the other campus is only ever reached by the server itself.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Network, Trash2 } from 'lucide-react';
import { HelpTip } from '../components/HelpTip';
import { SelectField } from '../components/SelectField';
import { Switch } from '../components/Switch';
import {
  acceptPeer,
  cancelJoinToken,
  checkPeer,
  createJoinToken,
  getFederation,
  redeemJoinToken,
  removePeer,
  saveFederationConfig,
  setPeerAddress,
  type FederationOverview,
  type FederationPeer,
} from '../api';
import { Msg, fail, ok, type Feedback } from './settingsShared';

// The page polls while open: an Accept at the other server, or a server going
// unreachable, should show here without a reload.
const REFRESH_MS = 5000;
// Beyond this the other server's clock will start to break cross-site sign-in
// (ADR 0014), so it is worth saying before anyone tries.
const SKEW_WARN_MS = 30_000;

function ago(ts: number | null) {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function LinkedServersPanel() {
  const [data, setData] = useState<FederationOverview | null>(null);
  const [msg, setMsg] = useState<Feedback>(null);

  const refresh = useCallback(() => getFederation().then(setData).catch((err) => setMsg(fail(err))), []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  if (!data) return msg ? <Msg msg={msg} /> : <p className="settings__muted">Loading…</p>;

  return (
    <>
      <LinkPanel data={data} onChange={setData} />
      <PairPanel data={data} onChange={setData} />
      <PeersPanel data={data} onChange={setData} />
    </>
  );
}

// ── The link: on/off, where it listens, what peers dial ──────────────────────

function LinkPanel({ data, onChange }: { data: FederationOverview; onChange: (d: FederationOverview) => void }) {
  const { config, listener } = data;
  const [bind, setBind] = useState(config.bind);
  const [port, setPort] = useState(String(config.port));
  const [address, setAddress] = useState(config.address);
  const [dashboardUrl, setDashboardUrl] = useState(config.dashboardUrl);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Feedback>(null);
  const dirty = bind !== config.bind || port !== String(config.port) || address !== config.address
    || dashboardUrl !== config.dashboardUrl;

  const save = async (patch: Parameters<typeof saveFederationConfig>[0]) => {
    setBusy(true);
    setMsg(null);
    try {
      const next = await saveFederationConfig(patch);
      onChange(next);
      setMsg(next.listener.error ? fail(next.listener.error) : ok('Saved.'));
    } catch (err) {
      setMsg(fail(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <div>
        <p className="section-label">Federation</p>
        <h2 className="panel__title">Link to other servers
          <HelpTip text="Another ProdMesh server connects to this one on its own port, over TLS, and only after you pair them. Nothing else on this server is reachable through it, and it never reaches the other server's devices." />
        </h2>
      </div>

      <Switch
        label={config.enabled ? 'On' : 'Off'}
        checked={config.enabled}
        disabled={busy}
        onChange={(e) => save({ enabled: e.target.checked })}
      />
      {config.enabled && (
        <p className="settings__muted">
          {listener.listening
            ? <>Listening on <code>{listener.host === 'all' ? 'all interfaces' : listener.host}:{listener.port}</code>. If this computer asks whether to allow incoming connections, allow them.</>
            : <span className="settings__error">Not listening: {listener.error}</span>}
        </p>
      )}

      <div className="servers__grid">
        <label>
          <span className="panel__label">Listen on
            <HelpTip text="On a server with one network connection, all interfaces is right. With several (a leg in a control VLAN, say), choose the one other servers route to, so the link is never offered on the others." />
          </span>
          <SelectField value={bind} onChange={(e) => setBind(e.target.value)}>
            <option value="all">All interfaces</option>
            {config.interfaces.map((i) => <option key={`${i.name}-${i.address}`} value={i.name}>{i.name} — {i.address}</option>)}
          </SelectField>
        </label>
        <label>
          <span className="panel__label">Port</span>
          <input className="field mono" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} />
        </label>
        <label>
          <span className="panel__label">Other servers reach this one at
            <HelpTip text="Goes into every join token. Leave it blank to use this computer's address; type one only if that is wrong: behind NAT, in Docker, or where a DNS name is better." />
          </span>
          <input className="field mono" value={address} placeholder={config.effectiveAddress} onChange={(e) => setAddress(e.target.value)} />
        </label>
        <label>
          <span className="panel__label">People open this server at
            <HelpTip text="The dashboard address someone at another campus uses. Their room cards open it. Leave it blank to use this computer's address on the dashboard port; type one for a DNS name or https." />
          </span>
          <input className="field mono" value={dashboardUrl} placeholder={config.effectiveDashboardUrl} onChange={(e) => setDashboardUrl(e.target.value)} />
        </label>
      </div>
      {config.warnAllInterfaces && bind === 'all' && (
        <p className="settings__warn">
          This computer has more than one network connection, and the link is offered on all of them.
          Choose the one other servers use, so it is not reachable from the others.
        </p>
      )}
      <div className="panel__controls">
        <button className="btn btn--primary" disabled={!dirty || busy}
          onClick={() => save({ bind, port: Number(port), address, dashboardUrl })}>Save</button>
      </div>
      <Msg msg={msg} />
    </section>
  );
}

// ── Pairing: issue a token here, or redeem one from there ────────────────────

function PairPanel({ data, onChange }: { data: FederationOverview; onChange: (d: FederationOverview) => void }) {
  const [issued, setIssued] = useState<{ token: string; expiresAt: number } | null>(null);
  const [paste, setPaste] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Feedback>(null);
  const listening = data.listener.listening;

  const issue = async () => {
    setMsg(null);
    try {
      setIssued(await createJoinToken());
      onChange(await getFederation());
    } catch (err) {
      setMsg(fail(err));
    }
  };

  const redeem = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const next = await redeemJoinToken(paste.trim()) as FederationOverview & { peer: FederationPeer };
      onChange(next);
      setPaste('');
      setMsg(ok(`Paired with ${next.peer.name}. Waiting for them to accept.`));
    } catch (err) {
      setMsg(fail(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <div>
        <p className="section-label">Pairing</p>
        <h2 className="panel__title">Pair a server
          <HelpTip text="One server creates a join token and sends it to the other's admin, who pastes it there. Then accept it here. A token works once, for 30 minutes." />
        </h2>
      </div>
      {!listening && <p className="settings__muted">Switch the link on first.</p>}

      <div className="servers__pair">
        <div>
          <span className="panel__label">Invite a server</span>
          <div>
            <button className="btn" disabled={!listening} onClick={issue}>Create join token</button>
          </div>
          {data.tokens.length > 0 && (
            <ul className="servers__tokens">
              {data.tokens.map((t) => (
                <li key={t.id}>
                  <span className="settings__muted">Token created {ago(t.createdAt)}, expires {new Date(t.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
                  <button className="btn btn--ghost btn--sm" onClick={async () => onChange(await cancelJoinToken(t.id))}>Cancel</button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <label className="panel__label" htmlFor="join-token">Join with a token</label>
          <textarea id="join-token" className="field mono servers__paste" rows={3} spellCheck={false}
            placeholder="pmjoin1.…" value={paste} onChange={(e) => setPaste(e.target.value)} />
          <button className="btn btn--primary" disabled={!listening || busy || !paste.trim()} onClick={redeem}>Pair</button>
        </div>
      </div>
      <Msg msg={msg} />

      {issued && <JoinTokenDialog token={issued.token} expiresAt={issued.expiresAt} onClose={() => setIssued(null)} />}
    </section>
  );
}

function JoinTokenDialog({ token, expiresAt, onClose }: { token: string; expiresAt: number; onClose: () => void }) {
  const field = useRef<HTMLTextAreaElement>(null);
  const [copyLabel, setCopyLabel] = useState('Copy');

  // Same as the API token dialog: no clipboard API over plain http on a LAN
  // address, so fall back to the legacy command, then to a selection.
  const copy = async () => {
    field.current?.select();
    let copied = false;
    try {
      if (navigator.clipboard) { await navigator.clipboard.writeText(token); copied = true; }
    } catch { /* fall through */ }
    if (!copied) {
      try { copied = document.execCommand('copy'); } catch { copied = false; }
    }
    setCopyLabel(copied ? 'Copied' : 'Press ⌘/Ctrl+C');
  };

  return (
    <div className="confirm" role="dialog" aria-modal="true" aria-labelledby="join-token-title">
      <div className="confirm__card">
        <p className="eyebrow">Join token</p>
        <p className="confirm__text" id="join-token-title">
          Send this to the other server’s admin. It works once, until {new Date(expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.
        </p>
        <textarea ref={field} className="field mono tokenreveal__value" readOnly rows={5} value={token}
          aria-label="Join token" spellCheck={false} onFocus={(e) => e.currentTarget.select()} />
        <div className="confirm__buttons">
          <button className="confirm__cancel" onClick={copy}>{copyLabel}</button>
          <button className="confirm__ok" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

// ── Peers ────────────────────────────────────────────────────────────────────

function status(peer: FederationPeer, reachable: boolean) {
  if (peer.awaiting === 'us') return { tone: 'warn', text: 'Waiting for you to accept' };
  if (peer.awaiting === 'them') return { tone: 'muted', text: `Waiting for ${peer.name} to accept` };
  if (peer.lastError === 'unpaired_by_peer') return { tone: 'bad', text: 'No longer paired on the other server' };
  if (!reachable) return { tone: 'bad', text: peer.lastError ? `Unreachable: ${peer.lastError}` : 'Not yet reached' };
  return { tone: 'ok', text: `Connected · seen ${ago(peer.lastSeenAt)}` };
}

function PeersPanel({ data, onChange }: { data: FederationOverview; onChange: (d: FederationOverview) => void }) {
  const [removing, setRemoving] = useState<FederationPeer | null>(null);
  const [editing, setEditing] = useState<{ peer: FederationPeer; address: string } | null>(null);
  const [msg, setMsg] = useState<Feedback>(null);

  const act = async (fn: () => Promise<FederationOverview>, done?: string) => {
    setMsg(null);
    try {
      onChange(await fn());
      if (done) setMsg(ok(done));
    } catch (err) {
      setMsg(fail(err));
    }
  };

  return (
    <section className="panel users">
      <div>
        <p className="section-label">Federation</p>
        <h2 className="panel__title">Linked servers</h2>
      </div>
      <div className="users__list">
        {data.peers.length === 0 && <p className="settings__muted">No linked servers.</p>}
        {data.peers.map((peer) => {
          const reachable = !peer.lastError && Boolean(peer.lastSeenAt);
          const s = status(peer, reachable);
          const skewed = peer.clockSkewMs != null && Math.abs(peer.clockSkewMs) > SKEW_WARN_MS;
          return (
            <div className="users__row servers__peer" key={peer.systemId}>
              <div className="users__identity">
                <span className="users__avatar"><Network size={20} /></span>
                <span>
                  <strong>{peer.name}</strong>
                  <small><span className="mono">{peer.address}</span></small>
                </span>
              </div>
              <div className="users__summary servers__peerstatus">
                <span className={`servers__state servers__state--${s.tone}`}>{s.text}</span>
                {skewed && (
                  <span className="settings__warn"> · Clock is {Math.round(Math.abs(peer.clockSkewMs!) / 1000)}s {peer.clockSkewMs! > 0 ? 'ahead' : 'behind'}. Check the time on both servers</span>
                )}
                <code className="identity__value" title="The certificate fingerprint this server is pinned to">{peer.fingerprint}</code>
              </div>
              <div className="users__actions">
                {peer.awaiting === 'us' && (
                  <button className="btn btn--primary btn--sm" onClick={() => act(() => acceptPeer(peer.systemId), `Accepted ${peer.name}.`)}>Accept</button>
                )}
                {peer.awaiting !== 'us' && (
                  <button className="btn btn--sm" onClick={() => act(() => checkPeer(peer.systemId))}>Check</button>
                )}
                <button className="btn btn--sm" onClick={() => setEditing({ peer, address: peer.address })}>Address</button>
                <button className="btn btn--ghost btn--sm stations__revoke" onClick={() => setRemoving(peer)}><Trash2 size={13} /> Remove</button>
              </div>
            </div>
          );
        })}
      </div>
      <Msg msg={msg} />

      {editing && (
        <div className="confirm" role="dialog" aria-modal="true" aria-labelledby="peer-address-title">
          <div className="confirm__card">
            <p className="eyebrow">{editing.peer.name}</p>
            <p className="confirm__text" id="peer-address-title">Where this server’s federation link is now.</p>
            <input className="field mono tokenreveal__value" aria-label="Address" value={editing.address}
              onChange={(e) => setEditing({ ...editing, address: e.target.value })} />
            <p className="settings__muted">It usually updates itself. The pinned certificate keeps it safe to change.</p>
            <div className="confirm__buttons">
              <button className="confirm__cancel" onClick={() => setEditing(null)}>Cancel</button>
              <button className="confirm__ok" onClick={async () => {
                await act(() => setPeerAddress(editing.peer.systemId, editing.address), 'Saved.');
                setEditing(null);
              }}>Save</button>
            </div>
          </div>
        </div>
      )}

      {removing && (
        <div className="confirm" role="dialog" aria-modal="true" aria-labelledby="remove-peer-title">
          <div className="confirm__card">
            <p className="eyebrow">Remove server</p>
            <p className="confirm__text" id="remove-peer-title">
              Unpair <strong>{removing.name}</strong>? Both servers stop trusting each other now. Pairing again needs a new join token.
            </p>
            <div className="confirm__buttons">
              <button className="confirm__cancel" onClick={() => setRemoving(null)}>Cancel</button>
              <button className="confirm__ok" onClick={async () => {
                await act(() => removePeer(removing.systemId), `Removed ${removing.name}.`);
                setRemoving(null);
              }}>Remove server</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
