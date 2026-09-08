import { Lock } from 'lucide-react';
import { getRoom, type RoomMeta, type RoomState } from '../api';
import { useQuery } from '../lib/useQuery';
import { roomKey } from '../lib/keys';
import { useTopic, roomTopic } from '../lib/stream';
import type { WidgetProps } from './types';

// What mode the room is in, in the room's own colour.
//
// READ-ONLY on purpose. Changing mode is a confirm dialog, a locked-schedule
// PIN and a permission — a control surface, not a tile — and it already has
// one at Room → Status. This answers the question a screen on a wall is for:
// is the room set up for what is about to happen in it.
//
// Which is also why it never renders empty. Loudness and viewers are absent
// most of the week and say nothing rather than lie about a zero; a room always
// has a mode, so a blank cell here would read as a fault rather than as quiet.

const MODES_STALE_MS = 10 * 60_000; // labels and colours change when an admin edits them

export function RoomModeWidget({ roomId }: WidgetProps) {
  // Pushed, not polled: the room's mode watcher already runs once for the
  // whole building, and a mode change has to appear on every screen at once.
  const state = useTopic<RoomState>(roomTopic.mode(roomId));
  // The push carries a mode ID. Its label and colour are configuration, and
  // this is the same key Views and Room use — a dashboard holding this widget
  // pays no extra request for it.
  const room = useQuery<RoomMeta>(roomKey(roomId), () => getRoom(roomId), {
    staleMs: MODES_STALE_MS,
  }).data;

  if (room?.roomModeEnabled === false) return null;

  const mode = room?.modes.find((m) => m.id === state?.mode) ?? null;
  const protection = state?.protection;

  const label = mode
    ? mode.label
    : state && room
      // Companion answered with something no configured mode matches. Naming
      // it beats "Unknown", because the raw value is what an admin needs in
      // order to fix the mapping.
      ? state.raw || 'Unknown mode'
      : 'Connecting…';

  // `error` is the ONLY reliable signal, and the obvious tests are both wrong:
  // readRoomState falls back to `source: 'mock', online: false` when a live
  // room's Companion throws, so a broken room and a mock room are otherwise
  // indistinguishable. `error` is set on that fallback path alone.
  //
  // Worth calling out loudly rather than quietly, because the mode shown
  // BESIDE it is then the last-known mock value — a plausible word the room is
  // not necessarily in.
  const offline = Boolean(state?.error);

  const detail = offline
    ? 'Companion offline — last known mode'
    : protection?.active
      ? (protection.label ?? 'Schedule protection')
      : null;

  return (
    <div className={`wgt wgt--mode${offline ? ' wgt--fault' : ''}`}>
      {protection?.active && (
        <span className="wgt__status" title={protection.label ?? 'Schedule protection'}>
          <Lock size={13} /> Locked
        </span>
      )}

      <p className="wgt__value" style={mode ? { color: mode.color } : undefined}>
        {label}
      </p>

      {detail && <p className="wgt__detail">{detail}</p>}
    </div>
  );
}
