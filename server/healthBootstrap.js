// ─────────────────────────────────────────────────────────────────────────────
//  HEALTH BOOTSTRAP  —  declare every configured integration up front.
//
//  report() registers integrations lazily on first contact, so before this,
//  /api/system/health only listed whatever happened to be used since boot —
//  a Smaart box or Companion that hadn't been touched yet was simply absent,
//  indistinguishable from "not configured". Declaring from room connectivity
//  at boot (and on every connectivity change) makes the surface complete:
//  declared-but-uncontacted entries report ok: null.
//
//  Keys come from each integration's own exported healthKey() so the declared
//  names can never drift from the reported ones.
// ─────────────────────────────────────────────────────────────────────────────

import { rooms } from './roomsStore.js';
import { onConnectivityChange } from './connectivity.js';
import { declare } from './health.js';
import * as pco from './integrations/planningCenter.js';
import * as pcCal from './integrations/pcCalendar.js';
import * as ppro from './integrations/proPresenter.js';
import * as companion from './companion.js';
import * as smaart from './integrations/smaart.js';
import * as rta from './integrations/rta.js';
import * as openSoundMeter from './integrations/openSoundMeter.js';
import * as slack from './integrations/slack.js';

export function declareConfiguredIntegrations() {
  if (pco.isConfigured()) {
    declare('planningCenter');
    declare('pcCalendar'); // same PAT; shows null until Calendar is contacted
  }
  if (slack.isConfigured()) declare('slack');
  for (const room of Object.values(rooms)) {
    if (ppro.isConfigured(room.proPresenter)) declare(ppro.healthKey(room.proPresenter));
    if (room.companion?.host) declare(companion.healthKey(room.companion));
    const a = room.analysis;
    if ((a?.host || a?.source === 'open-sound-meter') && !a.mock) {
      declare(a.source === 'rta' ? rta.healthKey(a) : a.source === 'open-sound-meter' ? openSoundMeter.healthKey(a) : smaart.healthKey(a));
    }
  }
}

/** Boot wiring: declare now and re-declare whenever connectivity changes. */
export function initHealthDeclarations() {
  declareConfiguredIntegrations();
  onConnectivityChange(declareConfiguredIntegrations);
}
