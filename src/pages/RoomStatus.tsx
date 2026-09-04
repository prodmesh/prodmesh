import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { LayoutGrid, Lock, Radio, Wifi, WifiOff } from 'lucide-react';
import {
  getRoom,
  getRoomPlan,
  getRoomState,
  getEnabledIntegrations,
  setRoomMode,
  OverrideRequiredError,
  type RoomMeta,
  type RoomMode,
  type RoomState,
  type ShowState,
} from '../api';
import { useQuery } from '../lib/useQuery';
import { useTopic, roomTopic } from '../lib/stream';
import { WidgetGrid } from '../components/Widget';
import { ServicePanel } from '../components/ServicePanel';
import { Accordion } from '../components/Accordion';
import { Tile } from '../components/Tile';
import { useChurch } from '../layout/church';
import { PasswordInput } from '../components/PasswordInput';
import { CompanionSurface } from '../components/CompanionSurface';
import { IntegrationTitle } from '../components/IntegrationBrand';

// When a show is live in this room, say so LOUDLY: which service, since when,
// and one tap to the live Run of Show. (The Home tile already shows LIVE —
// this is the page that tile lands on, so it must carry the thread.)
function LiveBanner({ roomId }: { roomId: string }) {
  const show = useTopic<ShowState>(roomTopic.show(roomId));
  const active = show?.active ? show : null;
  const planQ = useQuery(
    active?.planId ? `plan:${roomId}:${active.planId}` : null,
    () => getRoomPlan(roomId, active!.planId!),
    { staleMs: 10 * 60_000 },
  );
  if (!active) return null;

  const plan = planQ.data?.plan;
  const time = plan?.times.find((t) => t.id === active.timeId) ?? null;
  const timeLabel = active.timeId?.startsWith('rehearsal')
    ? 'Rehearsal'
    : time
      ? [time.name, time.startsAt ? new Date(time.startsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null]
          .filter(Boolean)
          .join(' · ')
      : null;
  const startedAt = active.startedAt
    ? new Date(active.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : null;

  return (
    <div className="livebar">
      <span className="livebar__badge">
        <Radio size={15} /> LIVE
      </span>
      <span className="livebar__what">
        <span className="livebar__title">{plan?.title ?? 'Show in progress'}</span>
        <span className="livebar__meta">
          {[timeLabel, startedAt ? `started ${startedAt}` : null].filter(Boolean).join(' · ')}
        </span>
      </span>
      <Link
        className="btn btn--primary livebar__go"
        to={`/room/${roomId}/run/${active.planId}${active.timeId && active.timeId !== 'default' ? `?time=${active.timeId}` : ''}`}
      >
        Open Run of Show
      </Link>
    </div>
  );
}

export function RoomStatus() {
  const { roomId = '' } = useParams();
  const church = useChurch();
  const [room, setRoom] = useState<RoomMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<RoomMode | null>(null); // confirm dialog
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    getRoom(roomId)
      .then((r) => active && setRoom(r))
      .catch(() => active && setError('Room not found'));
    return () => {
      active = false;
    };
  }, [roomId]);

  // Mode is pushed from the room's shared watcher rather than polled per
  // browser. The one-shot fetch alongside it is only for first paint — this
  // page renders nothing until it has a state, and waiting on the stream's
  // connect for that would put a "Loading…" in front of the operator. After
  // the first push, the push always wins.
  const pushed = useTopic<RoomState>(roomTopic.mode(roomId));
  const initial = useQuery(`room-state:${roomId}`, () => getRoomState(roomId), {
    staleMs: 30_000,
  }).data;
  const state = pushed ?? initial ?? null;
  const enabledIntegrations = useQuery('enabled-integrations', getEnabledIntegrations, { staleMs: 60_000 }).data?.enabled;
  const companionEnabled = enabledIntegrations?.companion !== false;

  const protection = state?.protection;
  const isLocked = useCallback(
    (modeId: string) =>
      Boolean(protection?.enforced && protection.lockedModes.includes(modeId)),
    [protection],
  );

  const openConfirm = (mode: RoomMode) => {
    setPin('');
    setPinError(null);
    setPending(mode);
  };

  const confirmMode = useCallback(async () => {
    if (!pending) return;
    const locked = isLocked(pending.id);
    if (locked && !pin) {
      setPinError('Enter the override PIN to continue.');
      return;
    }
    setBusy(true);
    setPinError(null);
    try {
      await setRoomMode(roomId, pending.id, locked ? pin : undefined);
      setPending(null);
    } catch (err) {
      if (err instanceof OverrideRequiredError) {
        setPinError('Incorrect override PIN.');
      } else {
        setPinError('Something went wrong — try again.');
      }
    } finally {
      setBusy(false);
      // No refetch: the server pushes the new mode as soon as the press lands
      // (routes/rooms.js bumps the room's watcher), so every screen in the
      // building moves together rather than this one moving first.
    }
  }, [pending, roomId, pin, isLocked]);

  if (error) {
    return (
      <div className="pagemsg">
        <p>{error}</p>
        <Link className="backlink" to="/">
          ← Quick Access
        </Link>
      </div>
    );
  }

  if (!room || !state) {
    return <div className="pagemsg">Loading…</div>;
  }

  const roomModeEnabled = room.roomModeEnabled !== false;
  const currentMode = room.modes.find((m) => m.id === state.mode) ?? null;
  const inStandby = currentMode?.isStandby ?? false;
  const buttons = room.modes.filter((m) => !m.isStandby || !inStandby);
  const showProtection = Boolean(protection?.active && protection.enforced);
  const tiles = church.sites.flatMap((s) => s.auditoriums).find((a) => a.id === roomId)?.tiles ?? [];

  return (
    <div className="status">
      <div className="pagehead">
        <div>
          <h1 className="pagehead__title">{room.name}</h1>
          <p className="pagehead__sub">Room Console</p>
        </div>
        <div className="pagehead__right">
          <Link className="btn btn--sm" to={`/room/${roomId}/views`}>
            <LayoutGrid size={14} /> Dashboards
          </Link>
        </div>
      </div>

      <LiveBanner roomId={roomId} />

      {showProtection && (
        <div className="protbar">
          <Lock size={14} /> <strong>{protection!.label}</strong> — locked:{' '}
          {protection!.lockedModes
            .map((id) => room.modes.find((m) => m.id === id)?.label ?? id)
            .join(', ')}{' '}
          <span className="protbar__hint">(override PIN required)</span>
        </div>
      )}

      {companionEnabled && roomModeEnabled && <>{/* Room Mode changes once at call time and then stays put, so it only
          claims the page while the room is in Standby. Out of Standby it
          collapses to its own answer — the current mode — leaving the console
          to the things used all day. */}
      <Accordion
        title="Room Mode"
        defaultOpen={inStandby}
        summary={
          <>
            <span
              className="acc__chip"
              style={{ ['--mode-color' as string]: currentMode?.color ?? '#6b7280' }}
            >
              {currentMode?.label ?? 'Unknown'}
            </span>
            <span className={`mode-hero__conn mode-hero__conn--${state.online ? 'on' : 'off'}`}>
              {state.online ? (
                <><Wifi size={13} /> Companion live</>
              ) : (
                <><WifiOff size={13} /> Demo mode</>
              )}
            </span>
          </>
        }
      >
        <div
          className="mode-hero"
          style={{ ['--mode-color' as string]: currentMode?.color ?? '#6b7280' }}
        >
          <span className="mode-hero__label">Current mode</span>
          <span className="mode-hero__mode">{currentMode?.label ?? 'Unknown'}</span>
        </div>

        <p className="widget__hint">Set the room to…</p>
        <div className="status__buttons">
          {buttons.map((mode) => {
            const isActive = mode.id === state.mode;
            const locked = isLocked(mode.id);
            return (
              <button
                key={mode.id}
                type="button"
                className={`mode-btn${isActive ? ' mode-btn--active' : ''}${
                  mode.isStandby ? ' mode-btn--standby' : ''
                }`}
                style={{ ['--mode-color' as string]: mode.color }}
                disabled={isActive}
                onClick={() => openConfirm(mode)}
              >
                <span className="mode-btn__label">
                  {locked && <Lock size={16} aria-label="locked" />}
                  {mode.label}
                </span>
                {isActive && <span className="mode-btn__active">Active now</span>}
              </button>
            );
          })}
        </div>
      </Accordion>
      </>}

      {/* Full width: it is the widest content on the page and has no
          neighbour to sit beside now that Room Mode is a full-width panel. */}
      <WidgetGrid>
        <ServicePanel roomId={roomId} />
      </WidgetGrid>

      {companionEnabled && room.hasCompanion && (
        <Accordion
          className="acc--companion"
          title={<IntegrationTitle integration="companion">Bitfocus Companion</IntegrationTitle>}
          defaultOpen
          summary={<span className="acc__chip">Live controls</span>}
        >
          <CompanionSurface roomId={roomId} className="companion-surface--room" />
        </Accordion>
      )}

      {tiles.length > 0 && (
        <Accordion
          title="Quick Access"
          defaultOpen
          summary={<span className="acc__count">{tiles.length}</span>}
        >
          <div className="roomtiles">
            {tiles.map((tile) => (
              <Tile key={tile.id} tile={tile} />
            ))}
          </div>
        </Accordion>
      )}

      {pending && (
        <div className="confirm" role="dialog" aria-modal="true">
          <div className="confirm__card">
            <p className="confirm__text">
              Switch <strong>{room.name}</strong> to{' '}
              <strong style={{ color: pending.color }}>{pending.label}</strong>?
            </p>

            {isLocked(pending.id) && (
              <div className="confirm__lock">
                <label className="confirm__lock-label" htmlFor="override-pin">
                  <Lock size={13} /> This change is locked ({protection!.label}). Enter override PIN:
                </label>
                <PasswordInput
                  id="override-pin"
                  className="confirm__pin"
                  inputMode="numeric"
                  autoComplete="off"
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                  autoFocus
                />
              </div>
            )}

            {pinError && <p className="confirm__error">{pinError}</p>}

            <div className="confirm__buttons">
              <button
                type="button"
                className="confirm__cancel"
                onClick={() => setPending(null)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="confirm__ok"
                style={{ ['--mode-color' as string]: pending.color }}
                onClick={confirmMode}
                disabled={busy}
              >
                {busy ? 'Working…' : `Yes, ${pending.label}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
