import * as pco from './integrations/planningCenter.js';
import { rooms } from './roomsStore.js';
import { getDb } from './db.js';
import * as store from './messagingStore.js';

const runs = new Map(); // one refresh per site; bounded by configured sites
export async function syncSunday(siteId, { force = false, now = Date.now(), client = pco, roomMap = rooms } = {}) {
  const t = store.resolveSunday(siteId, now);
  const previous = runs.get(siteId);
  if (previous?.date === t.service_date) {
    if (previous.promise) return previous.promise;
    if (!force && previous.until > Date.now()) return t;
  }
  const run = { date: t.service_date, until: Date.now() + 60_000, promise: null };
  const work = (async () => {
    let status = 'manual';
    try {
      const types = new Map();
      for (const room of Object.values(roomMap).filter(r => r.site === siteId)) {
        for (const type of room.planningCenter?.serviceTypes ?? []) types.set(type.id, type);
      }
      if (client.isConfigured() && types.size) {
        const people = [];
        for (const type of types.values()) {
          for (const plan of await client.getPlansForSunday(type, t.service_date)) {
            const times = await client.getPlanTimes(type, plan.id);
            if (!times.some(time => time.type === 'service' && time.startsAt && store.localDate(time.startsAt, store.site(siteId).timezone) === t.service_date)) continue;
            people.push(...await client.getPlanTeamMembers(type, plan.id));
          }
        }
        // Commit only a complete successful refresh. Empty results are harmless
        // because reconcile only adds; no outage or cache can remove members.
        store.reconcile(t.id, [...new Map(people.map(p => [p.personId ?? p.id, p])).values()]);
        status = 'connected';
      }
    } catch { status = 'unavailable'; }
    if (store.thread(t.id).sync_status !== status) {
      getDb().prepare('UPDATE message_threads SET sync_status=? WHERE id=?').run(status, t.id);
      store.bump(t.id);
    }
    return store.thread(t.id);
  })();
  run.promise = work;
  runs.set(siteId, run);
  try { return await work; } finally { run.promise = null; }
}
// Lifecycle runs server-side even when no browser is open. There is no browser
// polling loop; integration caching and one run/site bound Planning Center work.
export function startSundayLifecycle() {
  const tick = () => {
    const ids = getDb().prepare("SELECT id FROM sites WHERE status='active'").all();
    for (const s of ids) syncSunday(s.id).catch(() => {});
    const live = new Set(ids.map(s => s.id));
    for (const id of runs.keys()) if (!live.has(id)) runs.delete(id);
  };
  tick();
  const timer = setInterval(tick, 60_000); timer.unref();
  return () => clearInterval(timer);
}
