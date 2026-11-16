import { useCallback, useEffect, useState } from 'react';
import { Send } from 'lucide-react';
import {
  getMonitoring,
  getSignals,
  sendMonitoringTest,
  type MonitoringOverview,
  type MonitoringRoom,
  type MonitoringRule,
  type Signal,
} from '../api';
import { HelpTip } from '../components/HelpTip';
import { SelectField } from '../components/SelectField';
import { useChurch } from '../layout/church';

// Admin → Monitoring (#47, alerts-ux.md section 5). Where trust in the monitor
// is built: is it sending, what is it watching, and on what rule. In that
// order, because "will it reach me on Sunday?" is the first question.

const ago = (ts: number) => {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

const WATCHING: Record<NonNullable<MonitoringRoom['watching']>, string> = {
  show: 'Show live',
  service: 'Before a service',
  screen: 'Screen open',
};

function groupByCampus(rooms: MonitoringRoom[], sites: Array<{ id: string; name: string }>) {
  const groups = new Map<string | null, MonitoringRoom[]>();
  for (const r of rooms) groups.set(r.site, [...(groups.get(r.site) ?? []), r]);
  return [...groups].map(([site, list]) => ({ campus: sites.find((s) => s.id === site)?.name ?? site, rooms: list }));
}

function RoomGroup({ campus, rooms }: { campus: string | null; rooms: MonitoringRoom[] }) {
  return (
    <>
      {campus && (
        <tr className="monitor__campus"><th colSpan={4}>{campus}</th></tr>
      )}
      {rooms.map((r) => (
        <tr key={r.id}>
          <td>{r.name}</td>
          <td>
            {r.integrations?.length ? (
              <span className="monitor__dots">
                {r.integrations.map((i) => (
                  <span key={i.id} className={`monitor__dot monitor__dot--${i.state}`} title={`${i.label}: ${i.state}`}>
                    {i.label}
                  </span>
                ))}
              </span>
            ) : (
              <span className="settings__muted">None</span>
            )}
          </td>
          <td>{r.watching ? WATCHING[r.watching] : <span className="settings__muted">Not now</span>}</td>
          <td>{r.lastChecked ? ago(r.lastChecked) : <span className="settings__muted">—</span>}</td>
        </tr>
      ))}
    </>
  );
}

/** A rule as a sentence: the WHEN / THEN shape Automations will use. */
export function RuleSentence({ rule }: { rule: MonitoringRule }) {
  const secs = Math.round((rule.condition?.for ?? 0) / 1000);
  const what = rule.match.kind === 'integration.down' ? 'an integration is unreachable' : rule.match.kind;
  const alert = rule.actions.find((a) => a.type === 'alert');
  return (
    <div className="rule">
      <p><span className="rule__kw">When</span> {what}{secs ? ` for ${secs} seconds` : ''}</p>
      {alert && <p><span className="rule__kw">then</span> show an issue on the room’s screens</p>}
      {alert?.escalate?.during === 'show-live' && alert.escalate.notify === 'slack' && (
        <p><span className="rule__kw">and if a show is live</span> send it to Slack</p>
      )}
      {rule.resolveOn && <p className="settings__muted">It clears itself when the integration answers again.</p>}
    </div>
  );
}

export function MonitoringPanel() {
  const church = useChurch();
  const [data, setData] = useState<MonitoringOverview | null>(null);
  const [error, setError] = useState('');
  const [test, setTest] = useState<'idle' | 'sending' | 'sent' | string>('idle');

  const refresh = useCallback(async () => {
    try {
      setData(await getMonitoring());
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  const sendTest = async () => {
    setTest('sending');
    try {
      await sendMonitoringTest();
      setTest('sent');
    } catch (err) {
      setTest(err instanceof Error ? err.message : 'Failed');
    }
  };

  if (error) return <p className="settings__error">{error}</p>;
  if (!data) return <p className="settings__muted">Loading…</p>;

  return (
    <>
      <section className="panel">
        <p className="section-label">Sending</p>
        <h2 className="panel__title">Slack</h2>
        {data.slack.configured ? (
          <div className="monitor__send">
            <span className="monitor__ok">Connected</span>
            <button className="btn btn--sm" onClick={sendTest} disabled={test === 'sending'}>
              <Send size={13} /> {test === 'sending' ? 'Sending…' : 'Send test'}
            </button>
            {test === 'sent' && <span className="settings__muted">Sent.</span>}
            {test !== 'idle' && test !== 'sending' && test !== 'sent' && <span className="settings__error">{test}</span>}
          </div>
        ) : (
          <p className="settings__muted">
            Not connected. Issues still show on screens. Connect Slack in Admin → Integrations.
          </p>
        )}
      </section>

      <section className="panel">
        <p className="section-label">Watching</p>
        <h2 className="panel__title">
          Rooms
          <HelpTip text="A room’s devices are checked every 30 seconds while a show is live, from an hour before its services, or while a screen has the room open. Otherwise nothing is checking them." />
        </h2>
        <table className="monitor__rooms">
          <thead>
            <tr><th>Room</th><th>Devices</th><th>Checking</th><th>Last checked</th></tr>
          </thead>
          <tbody>
            {/* Grouped by campus: two campuses each have a "Youth Room". */}
            {groupByCampus(data.rooms, church.sites).map(({ campus, rooms }) => (
              <RoomGroup key={campus ?? '-'} campus={campus} rooms={rooms} />
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <p className="section-label">Rules</p>
        <h2 className="panel__title">
          Built in
          <HelpTip text="When an issue opens, and when it is sent. Writing your own arrives with Automations." />
        </h2>
        {data.rules.map((rule) => <RuleSentence key={rule.id} rule={rule} />)}
      </section>
    </>
  );
}

// Admin → Logs → Signals: the raw stream, for whoever is debugging. Carries
// device addresses in its detail, which is why it is behind system.logs.
const KINDS = [
  { value: '', label: 'Everything' },
  { value: 'integration.', label: 'Integrations' },
  { value: 'show.', label: 'Shows' },
  { value: 'room.', label: 'Room modes' },
  { value: 'alert.', label: 'Issues' },
];

export function SignalsLog() {
  const [kind, setKind] = useState('');
  const [signals, setSignals] = useState<Signal[] | null>(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      setSignals((await getSignals({ kind, limit: 200 })).signals);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [kind]);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <section className="panel audittrail">
      <div className="audittrail__head">
        <div>
          <p className="section-label">Diagnostics</p>
          <h2 className="panel__title">
            Signals
            <HelpTip text="Everything ProdMesh noticed changing: devices dropping and returning, shows and their items, room modes. The most recent 200." />
          </h2>
        </div>
        <div className="monitor__filters">
          <SelectField value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
            {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </SelectField>
          <button className="btn" onClick={refresh}>Refresh</button>
        </div>
      </div>
      {error && <p className="settings__error">{error}</p>}
      {signals && signals.length === 0 && <p className="settings__muted">Nothing recorded yet.</p>}
      {signals && signals.length > 0 && (
        <div className="audittrail__scroll">
          <table className="audittrail__table">
            <thead>
              <tr><th>When</th><th>Kind</th><th>What</th><th>Detail</th></tr>
            </thead>
            <tbody>
              {signals.map((s) => (
                <tr key={s.id}>
                  <td className="audittrail__when" title={new Date(s.ts).toLocaleString()}>
                    {new Date(s.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' })}
                  </td>
                  <td className="mono">{s.kind}</td>
                  <td>{s.summary ?? <span className="settings__muted">—</span>}</td>
                  <td className="settings__muted monitor__detail">
                    {[s.subject, typeof s.data?.error === 'string' ? s.data.error : null, typeof s.data?.by === 'string' ? `by ${s.data.by}` : null]
                      .filter(Boolean).join(' · ') || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
