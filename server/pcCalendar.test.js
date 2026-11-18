import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenOnLoopback } from './testServer.js';

// Isolated store, then import the app (which won't listen on its own).
process.env.PRODMESH_DATA_DIR = mkdtempSync(join(tmpdir(), 'prodmesh-cal-'));
const { app } = await import('./index.js');
const cal = await import('./integrations/pcCalendar.js');
const connectivity = await import('./connectivity.js');
const pco = await import('./integrations/planningCenter.js');

let base;
let server;
before(async () => {
  ({ server, base } = await listenOnLoopback(app));
});
after(() => server.close());

// A Sunday→Saturday week around a fixed reference date.
function weekOf(dateStr) {
  const start = new Date(dateStr);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - start.getDay());
  return { start: start.getTime(), end: start.getTime() + 7 * 86_400_000 };
}

test('mock instances cover the weekly pattern and match seeded rooms', async () => {
  const { start, end } = weekOf('2026-08-05'); // Sun Aug 2 – Sat Aug 8
  const { live, reason, events } = await cal.getCalendarData(start, end);
  assert.equal(live, false);
  assert.equal(reason, 'no-token');

  const sunday = events.find((e) => e.name === 'Sunday Services');
  assert.ok(sunday, 'Sunday Services present');
  assert.deepEqual(sunday.roomIds, ['north-main']); // location → live rooms map
  assert.equal(new Date(sunday.startsAt).getDay(), 0);
  assert.ok(new Date(sunday.endsAt) > new Date(sunday.startsAt));

  const youth = events.filter((e) => e.location === 'Youth Room');
  assert.equal(youth.length, 2); // Youth Sunday + Youth Night
  assert.ok(youth.every((e) => e.roomIds.includes('north-youth')));

  // The deliberately-unmapped location surfaces with no roomIds.
  const memorial = events.find((e) => e.name === 'Memorial Service');
  assert.deepEqual(memorial.roomIds, []);
  assert.equal(memorial.approval, 'P');

  // Sorted by start, all within range.
  const times = events.map((e) => new Date(e.startsAt).getTime());
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  assert.ok(times.every((t) => t >= start && t < end));
});

test('a connected event links to its own date\'s plan, and only to one it can open', async () => {
  // Demo data: Sunday Services is connected to the Sunday type, which the
  // demo Main Auditorium follows; demo Services has a plan every Sunday.
  const sunday = new Date();
  sunday.setHours(0, 0, 0, 0);
  sunday.setDate(sunday.getDate() + ((7 - sunday.getDay()) % 7));
  const { start, end } = weekOf(sunday.toISOString());
  const { events } = await cal.getCalendarData(start, end);
  assert.deepEqual(events.find((e) => e.name === 'Sunday Services').show, { roomId: 'north-main', planId: 'mock-500001-0' });
  assert.equal(events.find((e) => e.name === 'Youth Sunday').show, null);

  // Two rooms following the type, neither booked: no guess.
  const plain = { id: 'x', name: 'X', startsAt: new Date(sunday.getTime() + 9 * 3_600_000).toISOString(), roomIds: [], serviceTypeIds: ['500005'] };
  connectivity.setPlanningCenter('north-chapel', [{ id: '500005', name: 'Youth Service' }]);
  try {
    const [linked] = await cal.withShows([plain]);
    assert.equal(linked.show, null);
    const [booked] = await cal.withShows([{ ...plain, roomIds: ['north-chapel'] }]);
    assert.deepEqual(booked.show, { roomId: 'north-chapel', planId: 'mock-500005-0' });
  } finally {
    connectivity.setPlanningCenter('north-chapel', []);
  }
});

test('mock ids are deterministic (stable across refetches)', async () => {
  cal.clearCache();
  const { start, end } = weekOf('2026-08-05');
  const { events } = await cal.getCalendarData(start, end);
  assert.ok(events.some((e) => e.id === 'mock-sunday-services-2026-08-02'));
});

test('a token without Calendar access (401) falls back to labeled demo data', async (t) => {
  // Env-override secrets make isConfigured() true; a stubbed fetch plays the
  // not-yet-granted Calendar API. Real transport errors must still throw.
  process.env.PRODMESH_SECRET_PLANNINGCENTER_APPID = 'app';
  process.env.PRODMESH_SECRET_PLANNINGCENTER_SECRET = 'shh';
  const realFetch = globalThis.fetch;
  t.after(() => {
    delete process.env.PRODMESH_SECRET_PLANNINGCENTER_APPID;
    delete process.env.PRODMESH_SECRET_PLANNINGCENTER_SECRET;
    globalThis.fetch = realFetch;
    cal.clearCache();
  });

  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  cal.clearCache();
  const { start, end } = weekOf('2026-08-05');
  const denied = await cal.getCalendarData(start, end);
  assert.equal(denied.live, false);
  assert.equal(denied.reason, 'not-granted');
  assert.ok(denied.events.some((e) => e.name === 'Sunday Services')); // demo, labeled

  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  cal.clearCache();
  await assert.rejects(() => cal.getCalendarData(start, end), /HTTP 500/);
});

test('normalizeInstance reads name/approval from the included Event', () => {
  const eventsById = new Map([
    ['ev1', { id: 'ev1', type: 'Event', attributes: { name: 'Night of Worship', approval_status: 'A' } }],
  ]);
  const inst = cal.normalizeInstance(
    {
      id: 'inst1',
      attributes: {
        starts_at: '2026-08-07T19:00:00Z',
        ends_at: '2026-08-07T21:00:00Z',
        all_day_event: false,
        location: 'Main Auditorium',
      },
      relationships: { event: { data: { id: 'ev1' } } },
    },
    eventsById,
  );
  assert.equal(inst.name, 'Night of Worship');
  assert.equal(inst.approval, 'A');
  assert.equal(inst.eventId, 'ev1');
  assert.deepEqual(inst.roomIds, ['north-main']);
});

// The shapes the real API answered with (docs/INTEGRATION-NOTES.md, probed
// 2026-11-17), with fictional ids. What matters: location is a street
// address, rooms arrive as resource bookings, and a canceled instance is
// still a row unless filtered.
function calendarApi(seen) {
  const instance = (id, name, bookings, extra = {}, event = 'e1') => ({
    type: 'EventInstance',
    id,
    attributes: {
      name, all_day_event: false, canceled: false, location: '1 Example Way, Anytown',
      starts_at: '2026-08-04T17:00:00Z', ends_at: '2026-08-04T19:00:00Z', ...extra,
    },
    relationships: {
      event: { data: { type: 'Event', id: event } },
      resource_bookings: { data: bookings.map((b) => ({ type: 'ResourceBooking', id: b })) },
    },
  });
  const booking = (id, resource) => ({
    type: 'ResourceBooking', id, relationships: { resource: { data: { type: 'Resource', id: resource } } },
  });
  const resource = (id, name, kind) => ({ type: 'Resource', id, attributes: { name, kind, path_name: 'North' } });
  const pages = {
    '/resources': {
      data: [resource('701', 'Auditorium', 'Room'), resource('702', 'Youth Room', 'Room'), resource('703', 'Projector', 'Resource'),
        resource('704', 'Main Auditorium', 'Room')],
    },
    '/event_instances': {
      data: [
        instance('i1', 'Encore', ['b1', 'b3']),
        instance('i2', 'Youth Night', ['b2']),
        instance('i3', 'Canceled Rehearsal', ['b4'], { canceled: true }),
        instance('i4', 'Picnic', []),
        instance('i5', 'Concert', ['b5'], {}, 'e2'),
      ],
      included: [
        { type: 'Event', id: 'e1', attributes: { name: 'Encore', approval_status: 'A' } },
        booking('b1', '701'), booking('b2', '702'), booking('b3', '703'), booking('b4', '701'),
        booking('b5', '704'),
      ],
    },
  };
  // Encore's event is connected to the Services type the demo Main
  // Auditorium follows (500001), and Services has a plan that day.
  pages['/events/e1/event_connections'] = {
    data: [{
      type: 'EventConnection', id: 'c1',
      attributes: { connected_to_id: 500001, connected_to_name: 'Sunday', connected_to_type: 'service_type', product_name: 'services' },
    }],
  };
  pages['/service_types/500001/plans'] = {
    data: [
      { id: 'p0', attributes: { sort_date: '2026-07-28T07:00:00Z', title: 'Week before' } },
      { id: 'p1', attributes: { sort_date: '2026-08-04T07:00:00Z', title: 'Encore night' } },
    ],
  };
  pages['/service_types/500001/plans/p1/plan_times'] = {
    data: [{ id: 't1', attributes: { time_type: 'service', starts_at: '2026-08-04T18:00:00Z', ends_at: '2026-08-04T19:00:00Z' } }],
  };
  return async (url) => {
    seen.push(url);
    const path = new URL(url).pathname.replace(/^\/(calendar|services)\/v2/, '');
    return { ok: true, status: 200, json: async () => pages[path] ?? { data: [] } };
  };
}

test('live bookings land in the rooms they are bound to, and canceled ones are dropped', async (t) => {
  process.env.PRODMESH_SECRET_PLANNINGCENTER_APPID = 'app';
  process.env.PRODMESH_SECRET_PLANNINGCENTER_SECRET = 'shh';
  const realFetch = globalThis.fetch;
  t.after(() => {
    delete process.env.PRODMESH_SECRET_PLANNINGCENTER_APPID;
    delete process.env.PRODMESH_SECRET_PLANNINGCENTER_SECRET;
    globalThis.fetch = realFetch;
    connectivity.setCalendar('north-main', null);
    cal.clearCache();
    pco.clearCache();
  });
  pco.clearCache();
  // "Auditorium" is the church's name for our "Main Auditorium": no name
  // match exists, so only the binding puts it there.
  connectivity.setCalendar('north-main', { resources: [{ id: '701', name: 'Auditorium' }] });
  const seen = [];
  globalThis.fetch = calendarApi(seen);
  cal.clearCache();

  const { start, end } = weekOf('2026-08-05');
  const { live, events } = await cal.getCalendarData(start, end);
  assert.equal(live, true);
  assert.ok(seen.some((u) => u.includes('filter=not_canceled')));

  const byName = Object.fromEntries(events.map((e) => [e.name, e]));
  assert.equal(byName['Canceled Rehearsal'], undefined);
  assert.deepEqual(byName.Encore.roomIds, ['north-main']); // bound; the projector is not a room
  assert.deepEqual(byName.Encore.booked, ['Auditorium']);
  assert.equal(byName.Encore.approval, 'A');
  // Unbound: an exact name counts only when one room has it. Both campuses
  // have a Youth Room, so that booking is shown by name and placed nowhere.
  assert.deepEqual(byName.Concert.roomIds, ['north-main']);
  assert.deepEqual(byName['Youth Night'].roomIds, []);
  assert.deepEqual(byName['Youth Night'].booked, ['Youth Room']);
  assert.deepEqual(byName.Picnic.roomIds, []); // a street address matches nothing
  assert.deepEqual(byName.Picnic.booked, []);

  // Connected to a service type the booked room follows: links to that
  // day's plan, in that room. Unconnected events link nowhere.
  assert.deepEqual(byName.Encore.serviceTypeIds, ['500001']);
  assert.deepEqual(byName.Encore.show, { roomId: 'north-main', planId: 'p1' });
  assert.equal(byName.Concert.show, null);

  const rooms = await cal.listRoomResources();
  assert.deepEqual(rooms.map((r) => r.name), ['Auditorium', 'Main Auditorium', 'Youth Room']);
});

test('roomIdsFor matches case-insensitively and ignores unknown names', () => {
  assert.deepEqual(cal.roomIdsFor(['main auditorium']), ['north-main']);
  assert.deepEqual(cal.roomIdsFor(['Narnia', null, '']), []);
});

test('GET /api/calendar validates the range and serves events', async () => {
  const bad = await fetch(`${base}/api/calendar?start=nope&end=2026-08-09`);
  assert.equal(bad.status, 400);

  const backwards = await fetch(
    `${base}/api/calendar?start=2026-08-09T00:00:00Z&end=2026-08-02T00:00:00Z`,
  );
  assert.equal(backwards.status, 400);

  const huge = await fetch(
    `${base}/api/calendar?start=2026-01-01T00:00:00Z&end=2026-12-01T00:00:00Z`,
  );
  assert.equal(huge.status, 400);

  const { start, end } = weekOf('2026-08-05');
  const res = await fetch(
    `${base}/api/calendar?start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.live, false); // no PAT in tests → mock mode
  assert.ok(body.events.length >= 6);
  assert.ok(body.events.every((e) => e.name && e.startsAt));
});
