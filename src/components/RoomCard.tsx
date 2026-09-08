import { Link } from 'react-router-dom';
import { ChevronRight, Lock, Radio } from 'lucide-react';
import {
  getRoomService,
  type RoomMeta,
  type RoomService,
  type RoomState,
  type ShowState,
} from '../api';
import { useQuery } from '../lib/useQuery';
import { useTopic, roomTopic } from '../lib/stream';

const REFRESH_MS = 30 * 1000;

function fmtNextTime(service: RoomService | null) {
  const next = service?.plans[0];
  if (!next) return null;
  const svc = next.times.filter((t) => t.type === 'service' && t.startsAt);
  // First service time still in the future; else the last one (mid-service).
  const t =
    svc.find((x) => new Date(x.startsAt!).getTime() > Date.now()) ?? svc[svc.length - 1] ?? null;
  return t?.startsAt
    ? new Date(t.startsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : null;
}

// One room on the campus Home: current mode, live-show badge, next event.
// The whole card clicks into the room's status/operate page.
export function RoomCard({ room, showRoomMode = true }: { room: RoomMeta; showRoomMode?: boolean }) {
  showRoomMode &&= room.roomModeEnabled !== false;
  // Mode and show state are pushed: Home showing six rooms used to run six
  // intervals firing three requests each, per browser, and each mode read went
  // all the way to Companion uncached. Now one shared connection carries them,
  // the server polls each room once however many screens are watching, and a
  // mode change appears immediately instead of up to 30s later.
  const state = useTopic<RoomState>(roomTopic.mode(room.id));
  const show = useTopic<ShowState>(roomTopic.show(room.id));
  // The plan is a Planning Center fetch on a slow clock, not a live value —
  // useQuery shares one request and one interval across every card and page
  // that wants it.
  const service = useQuery(`room-service:${room.id}`, () => getRoomService(room.id), {
    pollMs: REFRESH_MS,
    staleMs: REFRESH_MS,
  }).data;

  const mode = room.modes.find((m) => m.id === state?.mode) ?? null;
  const next = service?.plans[0] ?? null;
  const nextTime = fmtNextTime(service ?? null);

  return (
    <Link to={`/room/${room.id}`} className={`roomcard${showRoomMode ? '' : ' roomcard--compact'}`}>
      <div className="roomcard__head">
        <span>
          <span className="roomcard__id mono">{room.id}</span>
          <span className="roomcard__name">{room.name}</span>
        </span>
        {show?.active && (
          <span className="roomcard__live">
            <Radio size={12} /> LIVE
          </span>
        )}
      </div>

      {showRoomMode && <div className="roomcard__status">
        <span className="roomcard__metric-label">ROOM MODE</span>
        <div className="roomcard__mode">
          <span
            className="roomcard__dot"
            style={{ background: mode?.color ?? 'var(--text-faint)' }}
          />
          <span>{mode ? mode.label : state ? 'Unknown mode' : 'Connecting…'}</span>
          {state?.protection.active && (
            <span className="roomcard__lock" title={state.protection.label ?? 'Schedule protection'}>
              <Lock size={12} />
            </span>
          )}
        </div>
        <span className={`roomcard__health${state?.online ? ' roomcard__health--on' : ''}`}>
          {state?.online ? 'COMPANION ONLINE' : state ? 'COMPANION OFFLINE' : 'CONNECTING'}
        </span>
      </div>}

      {next ? (
        <div className="roomcard__next">
          <span className="roomcard__metric-label">NEXT EVENT</span>
          <span className="roomcard__next-copy">
            <span className="roomcard__next-title">{next.title}</span>
            <span className="roomcard__next-when mono">
              {[next.dates, nextTime].filter(Boolean).join(' · ')}
            </span>
          </span>
          <ChevronRight className="roomcard__arrow" size={17} />
        </div>
      ) : (
        <div className="roomcard__next roomcard__next--none">
          <span className="roomcard__metric-label">NEXT EVENT</span>
          <span>
            {service
              ? service.configured
                ? 'No upcoming plans'
                : 'Planning Center not configured'
              : 'Loading schedule…'}
          </span>
          <ChevronRight className="roomcard__arrow" size={17} />
        </div>
      )}
    </Link>
  );
}
