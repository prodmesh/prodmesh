// Per-room OBS topic. One shared read-only WebSocket per room, regardless of
// how many dashboards display its health widget.
import * as hub from './streamHub.js';
import { rooms } from './roomsStore.js';
import * as settings from './settings.js';
import * as obs from './integrations/obs.js';

export const obsTopic = (roomId) => `room:${roomId}:obs`;
const watchers = new Map();
const states = new Map();
const wait = (ms, signal) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
async function watch(roomId, signal) {
  let last = '';
  while (!signal.aborted) {
    const value = settings.getIntegrationSettings().obs === false
      ? { configured: false, connected: false, disabled: true }
      : await obs.status(roomId).catch((err) => ({ connected: false, error: String(err?.message ?? err) }));
    if (value.disabled) obs.stop(roomId);
    const key = JSON.stringify(value);
    if (key !== last) { last = key; states.set(roomId, value); hub.publish(obsTopic(roomId), value); }
    await wait(value.disabled ? 5_000 : 1_000, signal);
  }
}
function start(roomId) { if (watchers.has(roomId) || !rooms[roomId]) return; const controller = new AbortController(); watchers.set(roomId, controller); watch(roomId, controller.signal).catch(() => {}); }
function stop(roomId) { watchers.get(roomId)?.abort(); watchers.delete(roomId); states.delete(roomId); obs.stop(roomId); }
hub.registerTopic('room:*:obs', { valid: (roomId) => Boolean(rooms[roomId]), start, stop, snapshot: (roomId) => states.get(roomId) });
export function stopAll() { for (const roomId of [...watchers.keys()]) stop(roomId); }
