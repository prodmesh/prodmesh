import { ExternalLink, Lock, Radio } from 'lucide-react';
import { getToken, visitServer, type RemoteDigest, type RemoteRoomDigest, type RemoteServer } from '../api';

// A room on a linked server (ADR 0018), drawn from that server's digest.
//
// Read-only by design: no control on this card changes anything at the other
// campus. Opening it navigates to that server's own dashboard, where its own
// permissions apply.
//
// Every value says how fresh it is, because a healthy server can still be
// serving a reading its device stopped confirming minutes ago (ADR 0016).
// Three states, drawn differently: unreachable (the whole card greyed, with
// when we last heard), stale (that value dimmed, with its age), current.

/** Older than this, a value is shown as stale with its age. */
export const STALE_MS = 2 * 60 * 1000;

function age(ts: number) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

const stale = (observedAt: number | null | undefined) =>
  observedAt != null && Date.now() - observedAt > STALE_MS;

function Aged({ observedAt }: { observedAt: number | null | undefined }) {
  if (!stale(observedAt)) return null;
  return <span className="roomcard__age mono" title="Not confirmed recently">{age(observedAt!)} old</span>;
}

function fmtTime(at: number | null) {
  return at == null ? null : new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function RemoteRoomCard({ server, room, digest }: {
  server: RemoteServer;
  room: { id: string; name: string };
  /** The server's latest digest, or undefined until the first arrives. */
  digest: RemoteDigest | undefined;
}) {
  const unreachable = digest ? !digest.reachable : !server.reachable;
  const d: RemoteRoomDigest | undefined = digest?.reachable ? digest.rooms[room.id] : undefined;
  const mode = d?.mode;
  const next = d?.next;
  const href = server.dashboardUrl
    ? `${server.dashboardUrl}/visit#${new URLSearchParams({ to: `/room/${room.id}` })}`
    : null;

  const body = (
    <>
      <div className="roomcard__head">
        <span>
          <span className="roomcard__id mono">{room.id}</span>
          <span className="roomcard__name">{room.name}</span>
        </span>
        {d?.show?.active && !unreachable && (
          <span className="roomcard__live">
            <Radio size={12} /> LIVE
          </span>
        )}
      </div>

      {unreachable ? (
        <div className="roomcard__status">
          <span className="roomcard__metric-label">UNREACHABLE</span>
          <span className="roomcard__muted">
            {server.lastSeenAt ? `Last heard from ${age(server.lastSeenAt)} ago` : 'Not reached yet'}
          </span>
        </div>
      ) : mode ? (
        <div className={`roomcard__status${stale(mode.observedAt) ? ' roomcard__status--stale' : ''}`}>
          <span className="roomcard__metric-label">ROOM MODE</span>
          <div className="roomcard__mode">
            <span className="roomcard__dot" style={{ background: mode.color ?? 'var(--text-faint)' }} />
            <span>{mode.observedAt == null ? 'Connecting…' : mode.label ?? 'Unknown mode'}</span>
            {mode.locked && <span className="roomcard__lock" title="Schedule protection"><Lock size={12} /></span>}
            <Aged observedAt={mode.observedAt} />
          </div>
          {mode.observedAt != null && (
            <span className={`roomcard__health${mode.online ? ' roomcard__health--on' : ''}`}>
              {mode.online ? 'COMPANION ONLINE' : 'COMPANION OFFLINE'}
            </span>
          )}
        </div>
      ) : null}

      {!unreachable && (next ? (
        <div className={`roomcard__next${stale(next.observedAt) ? ' roomcard__status--stale' : ''}`}>
          <span className="roomcard__metric-label">NEXT EVENT</span>
          <span className="roomcard__next-copy">
            <span className="roomcard__next-title">{next.title ?? 'No upcoming plans'}</span>
            <span className="roomcard__next-when mono">
              {[next.dates, fmtTime(next.at)].filter(Boolean).join(' · ')}
              <Aged observedAt={next.observedAt} />
            </span>
          </span>
          {href && <ExternalLink className="roomcard__arrow" size={15} />}
        </div>
      ) : (
        <div className="roomcard__next roomcard__next--none">
          <span className="roomcard__metric-label">NEXT EVENT</span>
          <span>{!digest ? 'Connecting…' : next === null ? 'Planning Center not configured' : 'Loading schedule…'}</span>
          {href && <ExternalLink className="roomcard__arrow" size={15} />}
        </div>
      ))}
    </>
  );

  const className = `roomcard roomcard--remote${unreachable ? ' roomcard--unreachable' : ''}`;

  // Signed in here: ask this server for a pass, so the person arrives at the
  // other one known by name (ADR 0018). Not signed in, or the pass cannot be
  // had: the plain link still goes there, through /visit so that browser is
  // not asked to register as one of their stations. A modified click (new
  // tab) is left to the browser and takes the plain link.
  const open = async (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!getToken() || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    const plain = event.currentTarget.href; // currentTarget is gone after the await
    try {
      const { url } = await visitServer(server.systemId, `/room/${room.id}`);
      window.location.assign(url);
    } catch {
      window.location.assign(plain);
    }
  };

  // Same tab, so the browser's Back returns here. A server that gave no
  // usable address gets a card that is not a link rather than a broken one.
  return href
    ? <a className={className} href={href} onClick={open} title={`Open on ${server.name}`}>{body}</a>
    : <div className={className}>{body}</div>;
}
