// ─────────────────────────────────────────────────────────────────────────────
//  ORG-LEVEL INTEGRATION TOPICS  —  `integration:<id>`
//
//  Restream and Resi are not per-room: their credentials live in secrets.json,
//  not room connectivity, so they have no room id to key a topic on. Every
//  other topic in the app is `room:*:<name>` — these are the first that are not.
//  The hub needed nothing for that: `resolve()` matches on segment count and
//  literals, and calls start/stop with whatever `*` captured, which here is
//  nothing at all.
//
//  Both widget families previously polled their own HTTP route on a client
//  interval, which is the multiplication ADR 0010 exists to remove (four Resi
//  widgets at 3s ≈ 66 requests a minute, per tab, for one shared fact). One
//  server-side producer per integration, refcounted by subscribers, publishing
//  only on change, is the pattern the other twelve topics already use.
//
//  Polling the service at all is also where "disabled" has to be enforced. The
//  Admin toggle used to be advisory — it hid widgets while the box went on
//  talking to the service every few seconds. A disabled integration is not
//  polled here, and says so on the topic so a stale saved dashboard can explain
//  itself rather than sit blank.
// ─────────────────────────────────────────────────────────────────────────────
import * as hub from './streamHub.js';
import * as settings from './settings.js';
import * as resi from './integrations/resi.js';
import * as restream from './integrations/restream.js';

export const integrationTopic = (id) => `integration:${id}`;

// How often the producer asks the service while somebody is watching. These
// match the intervals the widgets used when they polled for themselves, so
// nothing gets fresher or staler than it already was.
const PRODUCERS = new Map([
  ['resi', { intervalMs: 3_000, read: () => resi.status() }],
  ['restream', {
    intervalMs: 15_000,
    // restream.status() rejects when unconfigured or upstream fails; resi's
    // resolves with its own offline shape. Normalize here so the topic always
    // carries a state snapshot — conflation in the hub depends on that.
    read: () => restream.status().catch((err) => ({
      connected: false, status: 'offline', error: String(err?.message ?? err),
    })),
  }],
]);

// While disabled we still tick, so re-enabling in Admin recovers on its own
// rather than waiting for a restart — but we never call the service.
const DISABLED_POLL_MS = 5_000;

const watchers = new Map(); // id -> AbortController
const states = new Map(); // id -> last published snapshot

const wait = (ms, signal) => new Promise((resolve) => {
  if (signal.aborted) return resolve();
  const timer = setTimeout(resolve, ms); timer.unref?.();
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

function publishIfChanged(id, value) {
  const previous = states.get(id);
  if (previous && JSON.stringify(previous) === JSON.stringify(value)) return;
  states.set(id, value);
  hub.publish(integrationTopic(id), value);
}

async function watch(id, producer, signal) {
  let stoppedForDisabled = false;
  while (!signal.aborted) {
    if (settings.getIntegrationSettings()[id] === false) {
      // A websocket-backed producer can otherwise remain connected after the
      // integration is disabled. Close it once, while still leaving this loop
      // alive so that enabling the integration recovers without a restart.
      if (!stoppedForDisabled) producer.stop?.();
      stoppedForDisabled = true;
      publishIfChanged(id, { connected: false, disabled: true });
      await wait(DISABLED_POLL_MS, signal);
      continue;
    }
    stoppedForDisabled = false;
    // A producer read must never end the loop: this is the only thing keeping
    // the topic alive for every subscriber, and one bad response is not an
    // outage worth dropping them for.
    try { publishIfChanged(id, await producer.read()); }
    catch (err) { publishIfChanged(id, { connected: false, error: String(err?.message ?? err) }); }
    await wait(producer.intervalMs, signal);
  }
}

function start(id) {
  if (watchers.has(id)) return;
  const producer = PRODUCERS.get(id);
  if (!producer) return;
  const controller = new AbortController();
  watchers.set(id, controller);
  watch(id, producer, controller.signal).catch(() => {});
}

function stop(id) {
  watchers.get(id)?.abort();
  watchers.delete(id);
  states.delete(id);
  PRODUCERS.get(id)?.stop?.();
}

hub.registerTopic('integration:*', {
  valid: (id) => PRODUCERS.has(id),
  start,
  stop,
  snapshot: (id) => states.get(id),
});

export function stopAll() {
  for (const id of [...watchers.keys()]) stop(id);
}
