// ─────────────────────────────────────────────────────────────────────────────
//  AUTOSTART LOGIC  —  pure helpers for show automation.
//
//  Normally the trigger is the OPERATOR, not the clock: when ProPresenter lands
//  on the configured start item, the show starts; when the last slide of the
//  configured end item shows, the show completes. "Pre-Service Slides" can sit
//  active for 30 minutes between services without tripping anything, because
//  only a transition INTO the start item arms a start (edge-triggered).
//
//  An event can instead start on the clock, at each service time — for a room
//  without ProPresenter, or a team that would rather not tie the show to what
//  the operator clicks. See dueScheduledTime.
// ─────────────────────────────────────────────────────────────────────────────

/** The clock window in which autostart watches PP for an event. */
export function armWindow(times, beforeMs = 2 * 60 * 60 * 1000, afterMs = 60 * 60 * 1000) {
  const svc = times.filter((t) => t.type === 'service' && t.startsAt);
  if (svc.length === 0) return null;
  const starts = svc.map((t) => new Date(t.startsAt).getTime());
  return { from: Math.min(...starts) - beforeMs, to: Math.max(...starts) + afterMs };
}

/**
 * Which service time a triggered start belongs to: the nearest by clock,
 * skipping times whose show already completed (a 10:58 trigger must start the
 * 11:00, not reopen the finished 9:00). Null when every time is done.
 */
export function pickAutostartTime(times, now, isCompleted) {
  const candidates = times
    .filter((t) => t.type === 'service' && t.startsAt && !isCompleted(t.id))
    .map((t) => ({ id: t.id, dist: Math.abs(new Date(t.startsAt).getTime() - now) }))
    .sort((a, b) => a.dist - b.dist);
  return candidates[0]?.id ?? null;
}

/**
 * How late a scheduled-time start may still fire. ProdMesh restarting at 9:10
 * should still start the 9:00 show; at 9:40 it should not, because a show
 * begun that far in would time the whole service from the middle and report it
 * as short. By then somebody is in the room and can press Start. Also covers a
 * 9:00 show left running past 11:00: the 11:00 starts once the 9:00 ends, if
 * that happens within the grace period.
 */
export const SCHEDULED_START_GRACE_MS = 30 * 60 * 1000;

/**
 * Which service time the clock should start now, for an event set to start at
 * its scheduled time: one whose start has passed within the grace period and
 * whose show has not already completed. When two qualify, the later one — its
 * congregation is the one arriving now. Null when nothing is due.
 */
export function dueScheduledTime(times, now, isCompleted, graceMs = SCHEDULED_START_GRACE_MS) {
  const due = times
    .filter((t) => t.type === 'service' && t.startsAt && !isCompleted(t.id))
    .map((t) => ({ id: t.id, at: new Date(t.startsAt).getTime() }))
    .filter((t) => now >= t.at && now < t.at + graceMs)
    .sort((a, b) => b.at - a.at);
  return due[0]?.id ?? null;
}

/**
 * Edge-triggered start detection. `prevItemId` is the mapped PC item from the
 * previous poll (null = no baseline yet — never trigger on the first
 * observation, so a server reboot mid-worship doesn't restart a show the
 * operator ended on purpose).
 */
export function shouldAutostart(config, prevItemId, itemId) {
  return Boolean(
    config?.startItemId &&
      itemId === config.startItemId &&
      prevItemId !== null &&
      prevItemId !== itemId,
  );
}

// Completion is edge-triggered like the start side. When an item is
// re-triggered, ProPresenter briefly reports that item's STORED slide position
// before landing on the slide the operator actually clicked — so re-opening
// the sermon in a second service flashes the first service's last slide for a
// poll cycle (observed live 2026-07-26, PP 21.1). The last slide therefore
// only completes the show after the end item has been seen on an EARLIER
// slide ("armed"). Single-slide end items still complete on entry: there is
// no earlier slide to arm on, and no stale position distinct from the real one.

/** Seeing the end item midway (any non-last slide) arms auto-complete. */
export function armsAutoComplete(config, current) {
  return Boolean(
    config?.endItemId &&
      current?.itemId === config.endItemId &&
      current.slideIndex != null &&
      current.slideCount != null &&
      current.slideIndex < current.slideCount - 1,
  );
}

/** Armed show is on the configured end item's LAST slide → complete it. */
export function shouldAutoComplete(config, current, armed) {
  return Boolean(
    config?.endItemId &&
      current?.itemId === config.endItemId &&
      current.slideIndex != null &&
      current.slideCount != null &&
      current.slideCount > 0 &&
      current.slideIndex >= current.slideCount - 1 &&
      (armed || current.slideCount === 1),
  );
}
