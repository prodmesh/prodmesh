import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Clock3, MapPin } from 'lucide-react';
import { getCalendar, getRooms, type CalendarEvent, type RoomMeta } from '../api';
import { useQuery } from '../lib/useQuery';
import { inCampus, useCampus } from '../layout/campus';
import { roomLabel, useChurch } from '../layout/church';

const DAY_MS = 86_400_000;

/** Local-midnight Sunday of the week containing `d`. */
function startOfWeek(d: Date) {
  const s = new Date(d);
  s.setHours(0, 0, 0, 0);
  s.setDate(s.getDate() - s.getDay());
  return s;
}

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function weekLabel(start: Date) {
  const end = new Date(start.getTime() + 6 * DAY_MS);
  const fmt = (d: Date, withYear: boolean) =>
    d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}) });
  return `${fmt(start, false)} – ${fmt(end, true)}`;
}

function EventChip({
  ev,
  rooms,
  label,
}: {
  ev: CalendarEvent;
  rooms: RoomMeta[];
  label: (room: RoomMeta) => string;
}) {
  const pending = ev.approval != null && ev.approval !== 'A' && ev.approval.toLowerCase() !== 'approved';
  const matched = ev.roomIds
    .map((id) => rooms.find((r) => r.id === id))
    .filter((r): r is RoomMeta => Boolean(r));
  return (
    <div className={`cal-ev${pending ? ' cal-ev--pending' : ''}`}>
      <span className="cal-ev__time">
        <Clock3 size={12} />
        {ev.allDay ? 'All day' : `${clock(ev.startsAt)}${ev.endsAt ? ` – ${clock(ev.endsAt)}` : ''}`}
        {pending && <span className="cal-ev__pending">pending</span>}
      </span>
      {/* Connected in Calendar to a Services type: the name opens that day's
          plan, the page the Services list opens. */}
      {ev.show ? (
        <Link className="cal-ev__name cal-ev__name--link" to={`/room/${ev.show.roomId}/event/${ev.show.planId}`}>
          {ev.name}
        </Link>
      ) : (
        <span className="cal-ev__name">{ev.name}</span>
      )}
      <span className="cal-ev__rooms">
        {matched.length > 0 ? (
          matched.map((r) => (
            <Link key={r.id} className="cal-ev__room" to={`/room/${r.id}`}>
              {label(r)}
            </Link>
          ))
        ) : ev.booked?.length ? (
          <span className="cal-ev__room cal-ev__room--unmapped" title="No dashboard room is bound to this Calendar room">
            <MapPin size={11} /> {ev.booked.join(', ')}
          </span>
        ) : ev.location ? (
          <span className="cal-ev__room cal-ev__room--unmapped" title="No dashboard room matches this location">
            <MapPin size={11} /> {ev.location}
          </span>
        ) : null}
      </span>
    </div>
  );
}

// Week view of Planning Center Calendar bookings across the campus's rooms —
// the event→room→time authority. Bookings in a Calendar room bound to a
// dashboard room (Room configuration) link to it; anything else shows the
// Calendar room's name, or failing that the event's raw location.
export function Calendar() {
  const { campusId } = useCampus();
  const church = useChurch();
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const label = (room: RoomMeta) => roomLabel(room.name, room.site, church, campusId);

  const startISO = weekStart.toISOString();
  const endISO = new Date(weekStart.getTime() + 7 * DAY_MS).toISOString();

  const cal = useQuery(`calendar:${startISO}`, () => getCalendar(startISO, endISO), {
    staleMs: 60_000,
    pollMs: 5 * 60_000,
  });
  const roomsQ = useQuery('rooms', getRooms, { staleMs: 60_000 });
  const rooms = roomsQ.data ?? [];

  // Campus filter: keep events matching a room in this campus — and always
  // keep unmapped ones (misconfiguration shouldn't hide a booking).
  const events = (cal.data?.events ?? []).filter((ev) => {
    if (ev.roomIds.length === 0) return true;
    return ev.roomIds.some((id) => inCampus(campusId, rooms.find((r) => r.id === id)?.site));
  });

  // First load of this week (each week is its own query, so paging to one
  // not yet fetched counts too). A failed load shows its error instead.
  const loading = !cal.data && !cal.error;

  const today = new Date();
  const days = Array.from({ length: 7 }, (_, i) => new Date(weekStart.getTime() + i * DAY_MS));
  const shift = (weeks: number) =>
    setWeekStart((s) => startOfWeek(new Date(s.getTime() + weeks * 7 * DAY_MS + DAY_MS / 2)));

  return (
    <div className="cal">
      <div className="pagehead">
        <div>
          <h1 className="pagehead__title">Calendar</h1>
          <p className="pagehead__sub">
            Room bookings · Planning Center Calendar
            {cal.data && !cal.data.live && (
              <span
                className="cal__demo"
                title={
                  cal.data.reason === 'not-granted'
                    ? 'The Planning Center token doesn’t have Calendar access yet — showing sample bookings.'
                    : 'No Planning Center token configured — showing sample bookings.'
                }
              >
                {' '}· demo data
              </span>
            )}
          </p>
        </div>
        <div className="pagehead__right cal__nav">
          <button className="btn btn--sm" onClick={() => shift(-1)} aria-label="Previous week">
            <ChevronLeft size={15} />
          </button>
          <button className="btn btn--sm" onClick={() => setWeekStart(startOfWeek(new Date()))}>
            Today
          </button>
          <button className="btn btn--sm" onClick={() => shift(1)} aria-label="Next week">
            <ChevronRight size={15} />
          </button>
          <span className="cal__range">{weekLabel(weekStart)}</span>
        </div>
      </div>

      {cal.error && !cal.data && <p className="cal__error">Couldn’t load the calendar: {cal.error}</p>}

      {/* Until this week's bookings arrive, "No bookings" would be a claim
          the page can't make yet — and it reads as an empty week that then
          fills itself in. Placeholder chips say "loading" in the same shape. */}
      <div className="cal__grid" aria-busy={loading}>
        {days.map((day) => {
          const dayEvents = events.filter((ev) => sameDay(new Date(ev.startsAt), day));
          return (
            <section key={day.toISOString()} className={`cal-day${sameDay(day, today) ? ' cal-day--today' : ''}`}>
              <header className="cal-day__head">
                <span className="cal-day__dow">{day.toLocaleDateString([], { weekday: 'short' })}</span>
                <span className="cal-day__date">{day.getDate()}</span>
              </header>
              {loading ? (
                <div className="cal-ev cal-ev--skeleton" aria-hidden>
                  <span className="cal-skel cal-skel--time" />
                  <span className="cal-skel cal-skel--name" />
                  <span className="cal-skel cal-skel--room" />
                </div>
              ) : dayEvents.length === 0 ? (
                <p className="cal-day__empty">No bookings</p>
              ) : (
                dayEvents.map((ev) => <EventChip key={ev.id} ev={ev} rooms={rooms} label={label} />)
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
