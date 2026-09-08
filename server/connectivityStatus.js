// On-demand "is it actually working?" checks for a room's configured
// integrations — behind the status chips on the room configuration page.
// Each check is the smallest real request the dashboard itself depends on
// (so a green dot means the integration path genuinely works), and reports
// into the health registry like any other request. Analysis sources are
// long-lived websockets rather than request/response, so they get a TCP
// reachability check combined with what the health registry last saw.

import net from 'node:net';
import * as ppro from './integrations/proPresenter.js';
import * as pco from './integrations/planningCenter.js';
import * as smaart from './integrations/smaart.js';
import * as rta from './integrations/rta.js';
import * as openSoundMeter from './integrations/openSoundMeter.js';
import * as companion from './companion.js';
import * as obs from './integrations/obs.js';
import { snapshot } from './health.js';

const errText = (err) => String(err?.message ?? err);

function tcpReachable(host, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port: Number(port) });
    let settled = false;
    const done = (ok, detail) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve({ ok, detail });
    };
    sock.setTimeout(timeoutMs, () => done(false, 'connection timed out'));
    sock.once('connect', () => done(true, null));
    sock.once('error', (err) => done(false, errText(err)));
  });
}

async function proPresenterStatus(pp) {
  if (!ppro.isConfigured(pp)) return null;
  try {
    return { ok: true, detail: await ppro.ping(pp) };
  } catch (err) {
    return { ok: false, detail: errText(err) };
  }
}

async function companionStatus(cfg) {
  if (cfg?.mock) return { ok: null, mock: true, detail: 'Simulated — room state kept in memory' };
  if (!cfg?.host) return null;
  try {
    return { ok: true, detail: await companion.ping(cfg) };
  } catch (err) {
    return { ok: false, detail: errText(err) };
  }
}

async function analysisStatus(cfg) {
  if (cfg?.mock) return { ok: null, mock: true, detail: 'Simulated meter (dev room)' };
  if (!cfg?.source) return null;
  if (cfg.source === 'open-sound-meter') {
    const snap = snapshot()[openSoundMeter.healthKey(cfg)];
    if (!snap || snap.ok == null) return { ok: null, detail: 'Waiting for Open Sound Meter multicast levels' };
    if (!snap.ok) return { ok: false, detail: snap.lastError?.message ?? 'Open Sound Meter listener error' };
    return { ok: true, detail: 'Connected' };
  }
  const label = cfg.source === 'rta' ? 'RTA app' : 'Smaart';
  const key = (cfg.source === 'rta' ? rta : smaart).healthKey(cfg);
  const reach = await tcpReachable(cfg.host, key.split(':').pop());
  if (!reach.ok) return { ok: false, detail: reach.detail };
  // The port answers; whether the API conversation itself works is what the
  // health registry saw the last time the meter actually streamed.
  const snap = snapshot()[key];
  if (snap?.ok === false) return { ok: false, detail: snap.lastError?.message ?? `${label} API error` };
  return { ok: true, detail: `${label} port answering` };
}

async function obsStatus(room) {
  if (!room.obs?.host) return null;
  const state = await obs.status(room.id, { force: true });
  return { ok: state.connected, detail: state.connected ? 'Connected to OBS Studio' : state.error ?? 'OBS Studio could not be reached' };
}

// Planning Center is cloud + shared credentials — no per-room device to poke,
// so this reads the health registry (fed by every real PCO request).
function planningCenterStatus(pcCfg) {
  if (!(pcCfg?.serviceTypes ?? []).length) return null;
  if (!pco.isConfigured()) return { ok: null, mock: true, detail: 'No credentials — demo plans' };
  const snap = snapshot().planningCenter;
  if (!snap || snap.ok == null) return { ok: null, detail: 'Not contacted since server start' };
  if (!snap.ok) return { ok: false, detail: snap.lastError?.message ?? 'API error' };
  return { ok: true, detail: 'API responding', at: snap.lastSuccess };
}

/** Probe every configured integration of one server room, concurrently. */
export async function roomStatus(room) {
  const at = Date.now();
  const [proPresenter, comp, analysis, obsState] = await Promise.all([
    proPresenterStatus(room.proPresenter),
    companionStatus(room.companion),
    analysisStatus(room.analysis),
    obsStatus(room),
  ]);
  const stamp = (s) => (s ? { at, ...s } : null);
  return {
    planningCenter: stamp(planningCenterStatus(room.planningCenter)),
    proPresenter: stamp(proPresenter),
    companion: stamp(comp),
    analysis: stamp(analysis),
    obs: stamp(obsState),
  };
}
