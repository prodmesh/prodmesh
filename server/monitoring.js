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

let started = false;

export function startMonitoring({ retentionDelayMs } = {}) {
  if (started) return;
  started = true;
  rules.init({ isRoomLive: show.isShowLive, anyLive: show.anyShowLive });
  // An alert left open by the last run is resolved by its integration's next
  // success, even though this process never saw it go down.
  initHealthSignals(alerts.openSubjects());
  // A device removed or re-addressed in Admin never reports again under its
  // old key; close anything still open for it rather than leave it forever.
  onConnectivityChange(() => sweepUnconfigured(isConfiguredKey));
  signals.startRetention();
  retention.start({ isBusy: show.anyShowLive, firstDelayMs: retentionDelayMs });
}
