import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Hand, X } from 'lucide-react';
import { claimIssue, PermissionError, type Issue } from '../api';
import { affects, clock, duration, forRoom, fullTitle, shortTitle, useJustCleared, useOpenIssues, worst } from '../lib/issues';

// Issues on screen (#47, docs/design/alerts-ux.md). Three answers, every time:
// what, since when, is someone on it. Amber when nothing live is at stake, red
// when a show is; the server decides which, and nothing here second-guesses it.

/** "I'm on it". Without the permission, the shell's login dialog opens. */
export function ClaimButton({ issue, compact = false }: { issue: Issue; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const claim = async () => {
    setBusy(true);
    setError(null);
    try {
      await claimIssue(issue.id); // the topic brings the new state to every screen
    } catch (err) {
      if (!(err instanceof PermissionError)) setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button className={`btn btn--sm issue__claim${compact ? ' issue__claim--compact' : ''}`} onClick={claim} disabled={busy}>
        <Hand size={13} /> {busy ? 'Claiming…' : 'I’m on it'}
      </button>
      {error && <span className="issue__error" role="alert">{error}</span>}
    </>
  );
}

/** Since when, and whether it keeps coming back. */
function since(issue: Issue) {
  return issue.flapping ? `dropping in and out since ${clock(issue.firstSeen)}` : `since ${clock(issue.firstSeen)}`;
}

/** Who is on it, or the button to say so. */
function Owner({ issue, compact }: { issue: Issue; compact?: boolean }) {
  if (issue.state === 'acknowledged') return <span className="issue__owner">{issue.ackedBy ?? 'Someone'} is on it</span>;
  return <ClaimButton issue={issue} compact={compact} />;
}

/** One issue as a row: the sidebar panel and the details sheet both use it. */
export function IssueRow({ issue, withRoom = false, roomLink }: { issue: Issue; withRoom?: boolean; roomLink?: string }) {
  const text = affects(issue);
  return (
    <li className={`issue issue--${issue.severity}`}>
      <span className="issue__dot" aria-hidden />
      <div className="issue__body">
        <p className="issue__title">
          {roomLink ? <Link to={roomLink}>{withRoom ? fullTitle(issue) : shortTitle(issue)}</Link> : withRoom ? fullTitle(issue) : shortTitle(issue)}
        </p>
        <p className="issue__meta">{since(issue)}</p>
        {text && <p className="issue__affects">{text}</p>}
      </div>
      <div className="issue__act">
        <Owner issue={issue} compact />
      </div>
    </li>
  );
}

/** A panel from the side, never a modal over the controls. */
export function IssueSheet({ issues, onClose, title = 'Issues' }: { issues: Issue[]; onClose: () => void; title?: string }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <aside className="issuesheet" role="complementary" aria-label={title}>
      <div className="issuesheet__head">
        <h2 className="issuesheet__title">{title}</h2>
        <button className="iconbtn" aria-label="Close" onClick={onClose}><X size={16} /></button>
      </div>
      {issues.length ? (
        <ul className="issuelist">{issues.map((i) => <IssueRow key={i.id} issue={i} />)}</ul>
      ) : (
        <p className="issuesheet__empty">All clear.</p>
      )}
    </aside>
  );
}

/**
 * The line under a room page's header while something is wrong in that room.
 * Nothing at all when the room is fine; a minute of "back" when it recovers.
 */
export function IssueStrip({ roomId }: { roomId: string }) {
  const all = useOpenIssues();
  // Memoized: a fresh array each render would re-run the just-cleared effect
  // forever, since its job is to notice the list changing.
  const open = useMemo(() => (all === undefined ? undefined : forRoom(all, roomId)), [all, roomId]);
  const cleared = useJustCleared(open);
  const [details, setDetails] = useState(false);

  if (open?.length) {
    const level = worst(open);
    const one = open.length === 1 ? open[0] : null;
    return (
      <>
        <div className={`issuestrip issuestrip--${level}`} role="status">
          <span className="issue__dot" aria-hidden />
          <span className="issuestrip__text">
            {one ? (
              <>
                <strong>{shortTitle(one)}</strong>
                <span className="issuestrip__meta"> · {since(one)}</span>
                {one.state === 'acknowledged' && <span className="issuestrip__meta"> · {one.ackedBy ?? 'Someone'} is on it</span>}
              </>
            ) : (
              <>
                <strong>{open.length} issues</strong>
                <span className="issuestrip__meta"> · {open.map(shortTitle).join(', ')}</span>
              </>
            )}
          </span>
          {one && one.state === 'open' && <ClaimButton issue={one} />}
          <button className="btn btn--sm issuestrip__details" onClick={() => setDetails(true)}>Details</button>
        </div>
        {details && <IssueSheet issues={open} onClose={() => setDetails(false)} />}
      </>
    );
  }

  if (cleared.length) {
    const c = cleared[cleared.length - 1];
    return (
      <div className="issuestrip issuestrip--clear" role="status">
        <CheckCircle2 size={15} aria-hidden />
        <span className="issuestrip__text">
          <strong>{shortTitle(c).replace(/ unreachable$/, '')} back</strong>
          <span className="issuestrip__meta"> · down {duration(c.clearedAt - c.firstSeen)}</span>
        </span>
      </div>
    );
  }
  return null;
}
