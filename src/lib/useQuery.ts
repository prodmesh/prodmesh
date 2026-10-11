import { useEffect, useRef, useSyncExternalStore } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
//  useQuery — a small shared fetch cache (review item 7).
//
//  Components mounting the same key share one fetch, one cached result, and
//  (when polling) one interval — instead of every page refetching on mount
//  and running its own setInterval. Auth changes invalidate everything, so
//  logging in/out refreshes whatever is on screen.
//
//  Deliberately tiny: string keys, stale-while-revalidate, no mutations or
//  retries. Existing pages migrate opportunistically; new pages start here.
// ─────────────────────────────────────────────────────────────────────────────

interface Snapshot<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
}

interface Entry<T = unknown> {
  snapshot: Snapshot<T>;
  updatedAt: number; // 0 = never fetched / invalidated
  promise: Promise<void> | null;
  refetchAfter: boolean;
  subs: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
  fetcher: () => Promise<T>;
}

const cache = new Map<string, Entry>();

const EMPTY: Snapshot<never> = { data: undefined, error: null, loading: false };

function entryFor(key: string): Entry {
  let e = cache.get(key);
  if (!e) {
    e = {
      snapshot: { ...EMPTY },
      updatedAt: 0,
      promise: null,
      refetchAfter: false,
      subs: new Set(),
      timer: null,
      fetcher: () => Promise.reject(new Error('no fetcher')),
    };
    cache.set(key, e);
  }
  return e;
}

function notify(e: Entry) {
  for (const fn of e.subs) fn();
}

function refetch(key: string): Promise<void> {
  const e = entryFor(key);
  if (e.promise) return e.promise; // concurrent mounts share one request
  e.snapshot = { ...e.snapshot, loading: true };
  notify(e);
  e.promise = e
    .fetcher()
    .then((data) => {
      e.snapshot = { data, error: null, loading: false };
      e.updatedAt = Date.now();
    })
    .catch((err) => {
      // Keep last-known data on refresh failures — pages stay usable offline.
      e.snapshot = {
        data: e.snapshot.data,
        error: err instanceof Error ? err.message : String(err),
        loading: false,
      };
    })
    .finally(() => {
      e.promise = null;
      notify(e);
      if (e.refetchAfter) {
        e.refetchAfter = false;
        if (e.subs.size) void refetch(key);
      }
    });
  return e.promise;
}

/** Mark matching keys stale and refetch the ones something is watching. */
export function invalidate(prefix = '') {
  for (const [key, e] of cache) {
    if (!key.startsWith(prefix)) continue;
    e.updatedAt = 0;
    if (e.promise) e.refetchAfter = true;
    if (e.subs.size) refetch(key);
  }
}

// Login/logout changes what the server will say for almost any key.
if (typeof window !== 'undefined') {
  window.addEventListener('prodmesh:auth-changed', () => invalidate());
}

export interface QueryOptions {
  /** Refetch this often while mounted (shared across subscribers). */
  pollMs?: number;
  /** Serve a cached result without refetching if younger than this. Default 10s. */
  staleMs?: number;
}

export function useQuery<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  { pollMs, staleMs = 10_000 }: QueryOptions = {},
): Snapshot<T> & { refetch: () => void } {
  // Latest fetcher wins — closures over props/params stay fresh without
  // making the fetcher part of the effect dependencies.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  if (key != null) entryFor(key).fetcher = () => fetcherRef.current();

  const snapshot = useSyncExternalStore(
    (onChange) => {
      if (key == null) return () => {};
      const e = entryFor(key);
      e.subs.add(onChange);
      if (pollMs && !e.timer) e.timer = setInterval(() => refetch(key), pollMs);
      return () => {
        e.subs.delete(onChange);
        if (!e.subs.size && e.timer) {
          clearInterval(e.timer);
          e.timer = null;
        }
      };
    },
    () => (key == null ? (EMPTY as Snapshot<T>) : (entryFor(key).snapshot as Snapshot<T>)),
  );

  useEffect(() => {
    if (key == null) return;
    const e = entryFor(key);
    if (Date.now() - e.updatedAt > staleMs) refetch(key);
  }, [key, staleMs]);

  return { ...snapshot, refetch: () => key != null && refetch(key) };
}

/** Test hook: drop all cached entries (and their poll timers). */
export function clearQueryCache() {
  for (const e of cache.values()) if (e.timer) clearInterval(e.timer);
  cache.clear();
}
