import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CheckCircle2, RefreshCw } from 'lucide-react';
import { deleteHistoryShow, getReport, getRoomPlan, type ServiceIssue, type ServicePlan, type TimingReport } from '../api';
import { useQuery } from '../lib/useQuery';
import { reportKey } from '../lib/keys';
import { Sparkline } from '../components/Sparkline';

function mmss(sec: number) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function signed(sec: number) {
  const sign = sec > 0 ? '+' : sec < 0 ? '−' : '';
  return `${sign}${mmss(Math.abs(sec))}`;
}

const db = (v: number | null) => (v == null ? '—' : `${v.toFixed(1)} dB`);

function splZone(value: number | null, spl: { limit: number | null }) {
  return value != null && spl.limit != null && value > spl.limit ? 'over' : 'ok';
}

export function ServiceReport() {
  const { roomId = '', planId = '' } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const timeId = params.get('time');
  const [plan, setPlan] = useState<ServicePlan | null>(null);
  const [resetStep, setResetStep] = useState<0 | 1 | 2>(0);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetErr, setResetErr] = useState<string | null>(null);

  useEffect(() => {
    getRoomPlan(roomId, planId).then((r) => setPlan(r.plan)).catch(() => {});
  }, [roomId, planId]);

  // Refresh while the service is live; useful glancing at it during the debrief.
  const reportQ = useQuery<TimingReport | null>(
    reportKey(roomId, planId, timeId),
    () => getReport(roomId, planId, timeId),
    { pollMs: 5000, staleMs: 2000 },
  );
  const report = reportQ.data ?? null;
  const load = reportQ.refetch;

  const backToRun = `/room/${roomId}/run/${planId}${timeId ? `?time=${timeId}` : ''}`;
  const instanceId = `${planId}__${timeId ?? 'default'}`;

  const resetThisService = async () => {
    setResetBusy(true);
    setResetErr(null);
    try {
      await deleteHistoryShow(instanceId);
      navigate('/analytics');
    } catch (e) {
      setResetErr(e instanceof Error ? e.message : String(e));
    } finally {
      setResetBusy(false);
    }
  };

  // "Youth Service · Getting Over Yourself · July 6 · 9:30 AM" — which service
  // instance this report is for.
  const time = plan?.times.find((t) => t.id === timeId) ?? null;
  const clock = time?.startsAt
    ? new Date(time.startsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : time?.name ?? null;
  const serviceLine = plan
    ? [plan.serviceTypeName, plan.title, plan.dates, clock].filter(Boolean).join(' · ')
    : null;

  return (
    <div className="report">
      <div className="pagehead">
        <div>
          <Link className="backlink" to={backToRun}>← Run of Show</Link>
          <h1 className="pagehead__title">Show Report</h1>
          {serviceLine && <p className="pagehead__sub">{serviceLine}</p>}
        </div>
        <div className="pagehead__right">
          {report?.completedAt && (
            <span className="svc__badge svc__badge--live">
              <CheckCircle2 size={12} /> Completed{' '}
              {new Date(report.completedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
            </span>
          )}
          <button className="btn btn--sm" onClick={load}>
            <RefreshCw size={13} /> Refresh
          </button>
        </div>
      </div>

      {report?.restricted ? (
        <p className="settings__muted">
          Sign in to see how this service ran. Show reports are limited to
          people with the “View reports” permission — the live Run of Show,
          including song leaders, stays open to everyone.
        </p>
      ) : !report || (report.items.length === 0 && !report.spl && !report.stream) ? (
        <p className="settings__muted">
          Nothing recorded yet. Timing, loudness and viewership build
          automatically while a show is live.
        </p>
      ) : (
        <>
          {report.items.length > 0 && (
            <div className="report__summary">
              <div className="report__stat">
                <span className="report__stat-label">Planned</span>
                <span className="report__stat-val">{mmss(report.totals.planned)}</span>
              </div>
              <div className="report__stat">
                <span className="report__stat-label">Actual</span>
                <span className="report__stat-val">{mmss(report.totals.actual)}</span>
              </div>
              <div className={`report__stat report__stat--${report.totals.delta > 0 ? 'over' : 'under'}`}>
                <span className="report__stat-label">{report.totals.delta > 0 ? 'Over' : 'Under'}</span>
                <span className="report__stat-val">{signed(report.totals.delta)}</span>
              </div>
            </div>
          )}

          {report.spl && (
            <div className="report__summary">
              <div className={`report__stat${splZone(report.spl.leq, report.spl) === 'over' ? ' report__stat--over' : ''}`}>
                <span className="report__stat-label">Avg loudness (Leq)</span>
                <span className="report__stat-val">{db(report.spl.leq)}</span>
              </div>
              <div className={`report__stat${splZone(report.spl.peak, report.spl) === 'over' ? ' report__stat--over' : ''}`}>
                <span className="report__stat-label">Peak</span>
                <span className="report__stat-val">{db(report.spl.peak)}</span>
              </div>
              <div className="report__stat">
                <span className="report__stat-label">Target / limit</span>
                <span className="report__stat-val">
                  {report.spl.target ?? '—'} / {report.spl.limit ?? '—'}
                </span>
              </div>
              {report.spl.ca && (
                <div className="report__stat">
                  <span className="report__stat-label">C-A avg / max</span>
                  <span className="report__stat-val">
                    {db(report.spl.ca.avg)} / {db(report.spl.ca.max)}
                  </span>
                </div>
              )}
            </div>
          )}

          {report.stream && (
            <div className="report__stream">
              <div className="report__summary report__summary--flush">
                <div className="report__stat">
                  <span className="report__stat-label">Peak viewers</span>
                  <span className="report__stat-val">{report.stream.peak.toLocaleString()}</span>
                </div>
                <div className="report__stat">
                  <span className="report__stat-label">Avg viewers</span>
                  <span className="report__stat-val">{report.stream.avg.toLocaleString()}</span>
                </div>
                <div className="report__stat">
                  <span className="report__stat-label">Watched for</span>
                  <span className="report__stat-val">
                    {mmss((report.stream.to - report.stream.from) / 1000)}
                  </span>
                </div>
              </div>
              {/* The curve exists only while the raw samples do — the KPIs above
                  outlive them, so an old report loses the graph, not the numbers. */}
              {report.stream.series && report.stream.series.length > 1 && (
                <Sparkline
                  className="report__spark"
                  points={report.stream.series.map((p) => p.viewers)}
                  label={`Concurrent viewers over the service, peaking at ${report.stream.peak}`}
                />
              )}
            </div>
          )}

          {report.items.length > 0 && (
          <table className="report__table">
            <thead>
              <tr>
                <th>#</th>
                <th>Item</th>
                <th>Planned</th>
                <th>Actual</th>
                <th>+/−</th>
                <th>Avg loudness</th>
              </tr>
            </thead>
            <tbody>
              {report.items.map((it, i) => (
                <tr key={i} className={it.ongoing ? 'report__row--live' : ''}>
                  <td className="report__num">{i + 1}</td>
                  <td>
                    {it.itemName}
                    {it.ongoing && <span className="report__live">● live</span>}
                  </td>
                  <td className="report__num">{it.plannedLength ? mmss(it.plannedLength) : '—'}</td>
                  <td className="report__num">{mmss(it.actualSeconds)}</td>
                  <td className={`report__num ${it.delta == null ? '' : it.delta > 0 ? 'report__over' : 'report__under'}`}>
                    {it.delta == null ? '—' : signed(it.delta)}
                  </td>
                  <td className="report__num">{db(it.spl?.leq ?? null)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          )}

          {/* Issues during this service (#47): the payoff of monitoring for a
              team that never reads a log. Shown as "None" too, so a clean
              service reads as checked rather than as not looked at. */}
          {report.issues && report.startedAt != null && <ReportIssues issues={report.issues} />}

          <div className="report__reset">
            <button type="button" className="btn btn--ghost" onClick={() => { setResetErr(null); setResetStep(1); }}>
              Reset data
            </button>
            <small>Remove analytics data for this service only.</small>
          </div>
        </>
      )}

      {resetStep > 0 && (
        <div className="confirm" role="dialog" aria-modal="true" aria-labelledby="reset-service-title">
          <div className="confirm__card">
            {resetStep === 1 ? (
              <>
                <p id="reset-service-title" className="confirm__text">
                  Reset data for this service? Its timing report, item loudness, and viewer data will be permanently removed.
                </p>
                <div className="confirm__buttons">
                  <button type="button" className="confirm__cancel" onClick={() => setResetStep(0)}>Cancel</button>
                  <button type="button" className="confirm__ok confirm__ok--danger" onClick={() => setResetStep(2)}>Yes, continue</button>
                </div>
              </>
            ) : (
              <>
                <p id="reset-service-title" className="confirm__text">Final confirmation: reset this service’s data now?</p>
                {resetErr && <p className="confirm__error">{resetErr}</p>}
                <div className="confirm__buttons">
                  <button type="button" className="confirm__cancel" onClick={() => setResetStep(0)} disabled={resetBusy}>Cancel</button>
                  <button type="button" className="confirm__ok confirm__ok--danger" onClick={resetThisService} disabled={resetBusy}>
                    {resetBusy ? 'Resetting…' : 'Yes, reset data'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ReportIssues({ issues }: { issues: ServiceIssue[] }) {
  const t = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const span = (ms: number) => {
    const m = Math.round(ms / 60_000);
    if (m < 1) return '< 1 min';
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
  };
  // How fast somebody said "mine": seconds matter here, so they are shown.
  const after = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : span(ms));
  const claimed = (i: ServiceIssue) =>
    i.ackedBy ? `${i.ackedBy}, ${after(i.claimedAfterMs ?? 0)} after` : '—';
  return (
    <section className="report__issues">
      <h2 className="report__sectionhead">Issues</h2>
      {issues.length === 0 ? (
        <p className="settings__muted">None.</p>
      ) : (
        <table className="report-issues">
          <thead>
            <tr><th>Issue</th><th>When</th><th>Down</th><th>Claimed</th></tr>
          </thead>
          <tbody>
            {issues.map((i) => (
              <tr key={i.id}>
                <td>
                  {i.title.replace(/ is unreachable$/, ' unreachable').replace(/^[^·]+ · /, '')}
                  {i.flapping && <span className="settings__muted"> · dropped in and out</span>}
                </td>
                <td className="report__num">{t(i.firstSeen)}{i.resolvedAt ? ` – ${t(i.resolvedAt)}` : ' – still open'}</td>
                <td className="report__num">{span((i.resolvedAt ?? Date.now()) - i.firstSeen)}</td>
                <td>{claimed(i)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
