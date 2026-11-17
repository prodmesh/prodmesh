import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { Calendar } from './Calendar';
import { CampusContext } from '../layout/campus';
import { ChurchContext } from '../layout/church';
import { clearQueryCache } from '../lib/useQuery';
import type { CalendarEvent } from '../api';
import type { Church } from '../types';

const api = vi.hoisted(() => ({
  getCalendar: vi.fn(),
  getRooms: vi.fn(),
}));

vi.mock('../api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api')>(),
  ...api,
}));

// Both campuses have a "Main Auditorium" — labels must disambiguate.
const rooms = [
  { id: 'north-main', name: 'Main Auditorium', site: 'north', hasCompanion: true, modes: [] },
  { id: 'south-main', name: 'Main Auditorium', site: 'south', hasCompanion: false, modes: [] },
];

// Events pinned to "today" so they land inside the initially-rendered week.
const todayAt = (h: number) => {
  const d = new Date();
  d.setHours(h, 0, 0, 0);
  return d.toISOString();
};

const events: CalendarEvent[] = [
  {
    id: 'e1', eventId: null, name: 'Worship Rehearsal', startsAt: todayAt(18), endsAt: todayAt(21),
    allDay: false, location: 'Main Auditorium', approval: 'A', roomIds: ['north-main'],
  },
  {
    id: 'e2', eventId: null, name: 'SE Setup', startsAt: todayAt(9), endsAt: todayAt(11),
    allDay: false, location: 'Main Auditorium', approval: 'A', roomIds: ['south-main'],
  },
  {
    id: 'e3', eventId: null, name: 'Memorial Service', startsAt: todayAt(10), endsAt: todayAt(12),
    allDay: false, location: 'Chapel', approval: 'P', roomIds: [],
  },
  {
    // Real Calendar data: location is a street address, the room is a
    // booking, and nobody has bound it to a dashboard room yet.
    id: 'e4', eventId: null, name: 'Encore', startsAt: todayAt(9), endsAt: todayAt(11),
    allDay: false, location: '1 Example Way, Anytown', approval: 'A', booked: ['Auditorium'], roomIds: [],
  },
];

const church: Church = {
  name: 'Test Church',
  sites: [
    { id: 'north', name: 'North Campus', status: 'active', auditoriums: [] },
    { id: 'south', name: 'South Campus', status: 'active', auditoriums: [] },
  ],
};

function renderPage(campusId = 'all') {
  return render(
    <ChurchContext.Provider value={church}>
      <CampusContext.Provider value={{ campusId, setCampusId: vi.fn() }}>
        <MemoryRouter>
          <Calendar />
        </MemoryRouter>
      </CampusContext.Provider>
    </ChurchContext.Provider>,
  );
}

beforeEach(() => {
  clearQueryCache();
  api.getCalendar.mockReset(); // vi.fn() call counts survive restoreMocks
  api.getRooms.mockReset();
  api.getRooms.mockResolvedValue(rooms);
  api.getCalendar.mockResolvedValue({
    live: false,
    start: new Date().toISOString(),
    end: new Date().toISOString(),
    events,
  });
});

describe('Calendar', () => {
  it('renders the week of bookings with room links and the demo pill', async () => {
    renderPage();

    expect(await screen.findByText('Worship Rehearsal')).toBeInTheDocument();
    expect(screen.getByText('· demo data')).toBeInTheDocument();
    // Same-named rooms across campuses get campus-qualified labels in the
    // All Campuses view — you can tell which "Main Auditorium" is which.
    expect(screen.getByRole('link', { name: 'North Campus · Main Auditorium' }))
      .toHaveAttribute('href', '/room/north-main');
    expect(screen.getByRole('link', { name: 'South Campus · Main Auditorium' }))
      .toHaveAttribute('href', '/room/south-main');

    // Unmapped location: no link, raw location text with the pending badge.
    const memorial = screen.getByText('Memorial Service').closest('.cal-ev')!;
    expect(within(memorial as HTMLElement).getByText('Chapel')).toBeInTheDocument();
    expect(within(memorial as HTMLElement).queryByRole('link')).not.toBeInTheDocument();
    expect(within(memorial as HTMLElement).getByText('pending')).toBeInTheDocument();

    // An unbound booking names the Calendar room, not the street address.
    const encore = screen.getByText('Encore').closest('.cal-ev')! as HTMLElement;
    expect(within(encore).getByText('Auditorium')).toBeInTheDocument();
    expect(within(encore).queryByText(/Example Way/)).not.toBeInTheDocument();
  });

  it('campus filter hides other campuses but never hides unmapped bookings', async () => {
    renderPage('north');

    expect(await screen.findByText('Worship Rehearsal')).toBeInTheDocument();
    expect(screen.queryByText('SE Setup')).not.toBeInTheDocument();
    expect(screen.getByText('Memorial Service')).toBeInTheDocument();
    // Single-campus view: no prefix needed, labels stay short.
    expect(screen.getByRole('link', { name: 'Main Auditorium' }))
      .toHaveAttribute('href', '/room/north-main');
  });

  it('week navigation requests the next range', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Worship Rehearsal');
    const [firstStart] = api.getCalendar.mock.calls[0];

    await user.click(screen.getByRole('button', { name: 'Next week' }));

    await waitFor(() => expect(api.getCalendar).toHaveBeenCalledTimes(2));
    const [nextStart] = api.getCalendar.mock.calls[1];
    const delta = new Date(nextStart).getTime() - new Date(firstStart).getTime();
    expect(delta).toBe(7 * 86_400_000);

    // Back to the current week via Today.
    await user.click(screen.getByRole('button', { name: 'Today' }));
    expect(await screen.findByText('Worship Rehearsal')).toBeInTheDocument();
  });
});
