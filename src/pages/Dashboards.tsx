import { useSearchParams } from 'react-router-dom';
import { getRooms } from '../api';
import { SelectField } from '../components/SelectField';
import { useCampus, inCampus } from '../layout/campus';
import { roomLabel, useChurch } from '../layout/church';
import { useIdentity } from '../lib/identity';
import { useQuery } from '../lib/useQuery';
import { ViewsList } from './ViewsIndex';

// The sidebar's Dashboards (#61): every room's dashboards and displays, one
// room at a time, in the campus the sidebar is scoped to.
//
// Which room it opens on:
//   1. the one in the address (?room=), so a link or bookmark means one room;
//   2. this station's own room, when it has one in scope — a booth machine
//      assigned to the auditorium wants the auditorium's;
//   3. the room last picked on this screen, for a station with no room;
//   4. otherwise the first room.
// Picking a room only changes what this screen shows. It does not reassign
// the station; that stays in Admin → Stations.
//
// A station LOCKED to its room never gets here: its sidebar links straight to
// that room's list instead (AppShell).

const LAST_ROOM = 'pm_dashboards_room';

function readLast(): string | null {
  try {
    return localStorage.getItem(LAST_ROOM);
  } catch {
    return null;
  }
}

function writeLast(roomId: string) {
  try {
    localStorage.setItem(LAST_ROOM, roomId);
  } catch {
    // A private window: the picker still works, it just won't remember.
  }
}

export function Dashboards() {
  const [params, setParams] = useSearchParams();
  const { campusId } = useCampus();
  const church = useChurch();
  const identity = useIdentity();
  const roomsQ = useQuery('rooms', getRooms, { staleMs: 60_000 });

  const rooms = (roomsQ.data ?? []).filter((r) => inCampus(campusId, r.site));
  const has = (id: string | null | undefined): id is string => Boolean(id) && rooms.some((r) => r.id === id);
  const asked = params.get('room');
  const stationRoom = identity?.station?.roomId;
  const last = readLast();
  const roomId = has(asked) ? asked : has(stationRoom) ? stationRoom : has(last) ? last : rooms[0]?.id ?? null;

  const pick = (id: string) => {
    writeLast(id);
    setParams({ room: id }, { replace: true });
  };

  const head = (
    <div className="pagehead">
      <div>
        <h1 className="pagehead__title">Dashboards &amp; displays</h1>
      </div>
      {rooms.length > 1 && roomId && (
        <div className="pagehead__right">
          <label className="sr-only" htmlFor="dashboards-room">Room</label>
          <SelectField id="dashboards-room" value={roomId} onChange={(e) => pick(e.target.value)}>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>{roomLabel(r.name, r.site, church, campusId)}</option>
            ))}
          </SelectField>
        </div>
      )}
    </div>
  );

  if (roomsQ.error) {
    return <div className="viewsindex">{head}<div className="pagemsg"><p>Couldn’t load the rooms.</p></div></div>;
  }
  if (!roomsQ.data) return <div className="viewsindex">{head}<div className="pagemsg">Loading…</div></div>;
  if (!roomId) return <div className="viewsindex">{head}<div className="pagemsg"><p>No rooms in this campus.</p></div></div>;

  // Keyed by room so a half-typed "New dashboard" name never carries across.
  return <ViewsList key={roomId} roomId={roomId} head={head} />;
}
