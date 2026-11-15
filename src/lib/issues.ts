// Issues (the server's alerts, #47) as the screen needs them. Every surface
// answers three questions in this order: what, since when, is someone on it.
// See docs/design/alerts-ux.md.

import { useEffect, useRef, useState } from 'react';
import type { Issue } from '../api';
import { issuesTopic, useTopic } from './stream';

/** Every open issue on this server, live. Undefined until the stream answers. */
export function useOpenIssues(): Issue[] | undefined {
  return useTopic<Issue[]>(issuesTopic);
}

/** Issues that belong to this room's own pages. An org-wide issue (Planning
 *  Center down) has no room and lives in the sidebar's notifications only. */
export const forRoom = (issues: Issue[] | undefined, roomId: string) =>
  (issues ?? []).filter((i) => i.roomIds.includes(roomId));

/** Red if anything open is red: a show is live where it matters. */
export const worst = (issues: Issue[]) =>
  issues.some((i) => i.severity === 'critical') ? 'critical' : issues.length ? 'warning' : null;

export const clock = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export function duration(ms: number) {
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** "ProPresenter unreachable": the title without the room, for a room's own page. */
export function shortTitle(issue: Issue) {
  const t = issue.title.replace(/ is unreachable$/, ' unreachable');
  const at = t.indexOf(' · ');
  return at >= 0 ? t.slice(at + 3) : t;
}

/** The title as a list elsewhere wants it: "Main Auditorium · ProPresenter unreachable". */
export const fullTitle = (issue: Issue) => issue.title.replace(/ is unreachable$/, ' unreachable');

/** What it means for the people in the room, in their words. */
const AFFECTS: Record<string, string> = {
  proPresenter: 'Run of Show cannot follow ProPresenter, and slides and timers stop updating.',
  companion: 'Room modes cannot be read or changed from ProdMesh.',
  analysis: 'Loudness is not being measured.',
  planningCenter: 'Plans, items and times cannot be refreshed.',
  pcCalendar: 'The calendar cannot be refreshed.',
  youtube: 'Viewer counts are not being recorded.',
  captions: 'Captions are not reaching ProdMesh.',
  slack: 'Issues cannot be sent to Slack.',
  resi: 'Resi status is not updating.',
  restream: 'Restream status is not updating.',
  peer: 'That server’s campuses cannot be viewed from here.',
};

export const affects = (issue: Issue) => (issue.integration ? AFFECTS[issue.integration] ?? null : null);

/**
 * Issues that just cleared, for one minute: people want to see a thing come
 * back, not merely stop being red. The topic only carries what is open, so a
 * clear is an id that was there and is not any more.
 */
export function useJustCleared(open: Issue[] | undefined, keepMs = 60_000) {
  const prev = useRef<Map<number, Issue>>(new Map());
  const [cleared, setCleared] = useState<Array<Issue & { clearedAt: number }>>([]);

  useEffect(() => {
    if (open === undefined) return;
    const now = Date.now();
    const ids = new Set(open.map((i) => i.id));
    const gone = [...prev.current.values()].filter((i) => !ids.has(i.id));
    prev.current = new Map(open.map((i) => [i.id, i]));
    setCleared((c) => [
      ...c.filter((x) => !ids.has(x.id) && now - x.clearedAt < keepMs),
      ...gone.map((i) => ({ ...i, clearedAt: now })),
    ]);
  }, [open, keepMs]);

  useEffect(() => {
    if (!cleared.length) return;
    const next = Math.min(...cleared.map((c) => c.clearedAt + keepMs)) - Date.now();
    const t = setTimeout(() => setCleared((c) => c.filter((x) => Date.now() - x.clearedAt < keepMs)), Math.max(0, next));
    return () => clearTimeout(t);
  }, [cleared, keepMs]);

  return cleared;
}
