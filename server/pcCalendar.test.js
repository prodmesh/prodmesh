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
