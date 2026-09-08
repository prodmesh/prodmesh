import { useSyncExternalStore } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
//  useTopic — live server values over ONE EventSource per browser tab.
//
//  Companion piece to useQuery: that one shares request/response data, this one
//  shares the push stream. A widget names a topic; the module keeps a single
//  connection carrying every topic anything on screen currently wants.
//
//  Why one connection matters: browsers allow six per origin on HTTP/1.1, and
//  this is a LAN appliance with no TLS and so no HTTP/2. A stream per room
//  meant a six-room wall display silently lost its sixth. See server/streamHub.js.
//
//  The topic set changes as widgets mount and unmount, and SSE is one-way — so
//  a change means reconnecting with a new query string. Reconnects are
//  debounced, which is the whole reason a twelve-widget page opens one
//  connection rather than twelve in sequence.
// ─────────────────────────────────────────────────────────────────────────────

type Listener = () => void;

const refs = new Map<string, number>(); // topic -> mounted subscribers
const listeners = new Map<string, Set<Listener>>();
const values = new Map<string, unknown>();

let source: EventSource | null = null;
let connected = ''; // the topic list `source` was opened with
let pending: ReturnType<typeof setTimeout> | null = null;
let reconnect: ReturnType<typeof setTimeout> | null = null;

// Long enough to batch a page's worth of mounting widgets into one connection,
// short enough that nobody perceives it.
const CONNECT_DEBOUNCE_MS = 30;

function notify(topic: string) {
  const subs = listeners.get(topic);
  if (subs) for (const fn of subs) fn();
}

function wanted() {
  return [...refs.keys()].sort().join(',');
}

function connect() {
  pending = null;
  if (reconnect) { clearTimeout(reconnect); reconnect = null; }
  const topics = wanted();
  if (topics === connected && source) return;

  source?.close();
  source = null;
  connected = topics;
  if (!topics) return;

  const es = new EventSource(`/api/stream?topics=${encodeURIComponent(topics)}`);
  source = es;
  es.addEventListener('msg', (e) => {
    try {
      const { topic, data } = JSON.parse((e as MessageEvent).data);
      values.set(topic, data);
      notify(topic);
    } catch {
      /* a malformed frame must not tear down the connection */
    }
  });
  // Native EventSource retries, but some browsers leave a dead LAN stream in
  // CONNECTING indefinitely after a PP/server outage. Own a bounded reconnect
  // so the current topic snapshot is re-requested without an operator refresh.
  es.onerror = () => {
    if (source !== es || reconnect) return;
    es.close(); source = null; connected = '';
    reconnect = setTimeout(() => { reconnect = null; connect(); }, 1000);
  };
}

function schedule() {
  if (pending) clearTimeout(pending);
  pending = setTimeout(connect, CONNECT_DEBOUNCE_MS);
}

function acquire(topic: string) {
  refs.set(topic, (refs.get(topic) ?? 0) + 1);
  if (refs.get(topic) === 1) schedule();
}

function release(topic: string) {
  const n = (refs.get(topic) ?? 1) - 1;
  if (n > 0) {
    refs.set(topic, n);
    return;
  }
  refs.delete(topic);
  // Keep the last value: a widget that unmounts and remounts (a tab switch,
  // a re-render across a route change) should paint immediately rather than
  // flash empty while the reconnect and its snapshot land.
  schedule();
}

/**
 * Subscribe to one server topic, e.g. `room:north-main:spl`.
 * Returns undefined until the first value arrives.
 */
export function useTopic<T>(topic: string | null): T | undefined {
  return useSyncExternalStore(
    (onChange) => {
      if (topic == null) return () => {};
      let subs = listeners.get(topic);
      if (!subs) {
        subs = new Set();
        listeners.set(topic, subs);
      }
      subs.add(onChange);
      acquire(topic);
      return () => {
        subs.delete(onChange);
        if (!subs.size) listeners.delete(topic);
        release(topic);
      };
    },
    () => (topic == null ? undefined : (values.get(topic) as T | undefined)),
  );
}

/** Topic-name builders, so a typo is a compile error rather than a dead widget. */
export const roomTopic = {
  show: (roomId: string) => `room:${roomId}:show`,
  timer: (roomId: string) => `room:${roomId}:timer`,
  spl: (roomId: string) => `room:${roomId}:spl`,
  rta: (roomId: string) => `room:${roomId}:rta`,
  mode: (roomId: string) => `room:${roomId}:mode`,
  /** One Companion variable, addressed as Companion addresses it: label:name,
   *  which is two topic segments because the hub's `*` captures exactly one. */
  companionVar: (roomId: string, label: string, name: string) =>
    `room:${roomId}:var:${label}:${name}`,
  youtube: (roomId: string) => `room:${roomId}:youtube`,
  health: (roomId: string) => `room:${roomId}:health`,
  video: (roomId: string) => `room:${roomId}:video`,
  captions: (roomId: string) => `room:${roomId}:captions`,
  lyrics: (roomId: string) => `room:${roomId}:lyrics`,
  proPresenter: (roomId: string) => `room:${roomId}:propresenter`,
  obs: (roomId: string) => `room:${roomId}:obs`,
};

/**
 * Org-level integrations (Restream, Resi) have no room to key a topic on —
 * their credentials are institution-wide. Same single connection, same
 * refcounting; the id is not a room id, which is why it is a separate accessor
 * rather than a `roomTopic` entry taking a misleading argument.
 */
export const integrationTopic = (id: 'resi' | 'restream') => `integration:${id}`;

/** Test hook: drop the connection and every cached value. */
export function resetStream() {
  if (pending) clearTimeout(pending);
  pending = null;
  if (reconnect) clearTimeout(reconnect);
  reconnect = null;
  source?.close();
  source = null;
  connected = '';
  refs.clear();
  listeners.clear();
  values.clear();
}
