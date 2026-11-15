// ─────────────────────────────────────────────────────────────────────────────
//  MONITORING  —  boot wiring for signals, rules and alerts (#47, ADR 0019).
//
//  Separate from index.js so a test can bring up exactly this and nothing else.
// ─────────────────────────────────────────────────────────────────────────────

import * as show from './showManager.js';
import * as signals from './signals.js';
import * as rules from './rules.js';
import * as alerts from './alerts.js';
import * as retention from './retention.js';
import { onConnectivityChange } from './connectivity.js';
import { initHealthSignals, sweepUnconfigured, isConfiguredKey } from './signalProducers.js';
import { rooms } from './roomsStore.js';
import * as roomHealth from './roomHealth.js';
import { unexpected } from './health.js';

// The hour before a room's first service time, through an hour after its
// last: the stretch where a dead device is a Sunday-morning surprise.
export const WATCH_LEAD_MS = 60 * 60_000;
export const WATCH_TAIL_MS = 60 * 60_000;
const WATCH_EVERY_MS = 60_000;

/**
 * Decide, per room, whether the server should be checking its devices itself
 * (ADR 0019, alerts-ux.md decision 1). Shows win immediately; the service
 * window is asked of Planning Center, whose reads are cached.
 */
export async function reconcileWatching({ isRoomLive = show.isShowLive, inWindow = (id) => show.inServiceWindow(id, WATCH_LEAD_MS, WATCH_TAIL_MS) } = {}) {
  for (const roomId of Object.keys(rooms)) {
    let why = null;
    try {
      if (isRoomLive(roomId)) why = 'show';
      else if (await inWindow(roomId)) why = 'service';
    } catch (err) {
      unexpected(`watching ${roomId}`, err);
    }
    if (why) roomHealth.hold(roomId, why);
    else roomHealth.release(roomId);
  }
  // A room deleted in Admin is no longer in `rooms`; let go of it too.
  for (const roomId of roomHealth.heldRooms()) if (!rooms[roomId]) roomHealth.release(roomId);
}

let started = false;

export function startMonitoring({ retentionDelayMs, watch = true } = {}) {
  if (started) return;
  started = true;
  rules.init({ isRoomLive: show.isShowLive, anyLive: show.anyShowLive });
  // An alert left open by the last run is resolved by its integration's next
  // success, even though this process never saw it go down.
  initHealthSignals(alerts.openSubjects());
  alerts.resumeAckPolling();
  // A device removed or re-addressed in Admin never reports again under its
  // old key; close anything still open for it rather than leave it forever.
  onConnectivityChange(() => sweepUnconfigured(isConfiguredKey));
  signals.startRetention();
  retention.start({ isBusy: show.anyShowLive, firstDelayMs: retentionDelayMs });
  if (watch) {
    const tick = () => reconcileWatching().catch((err) => unexpected('watching', err));
    tick();
    setInterval(tick, WATCH_EVERY_MS).unref?.();
    // A show starting should not wait up to a minute to be watched.
    signals.onBatch((batch) => { if (batch.some((s) => s.kind === 'show.started' || s.kind === 'show.ended')) tick(); });
  }
}
