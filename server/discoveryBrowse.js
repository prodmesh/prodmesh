// ─────────────────────────────────────────────────────────────────────────────
//  Finding ProdMesh servers on this network (#56): the client half.
//
//  Separate from discovery.js, which advertises, because the desktop app
//  browses while in client mode and must not import anything that opens a
//  database: discovery.js reads the system identity, and identity.js creates
//  the data folder. This module needs only the network.
// ─────────────────────────────────────────────────────────────────────────────

import { Bonjour } from 'bonjour-service';

export const SERVICE_TYPE = 'prodmesh';

/**
 * What a client shows: one entry per running server, keyed by system id, with
 * any id seen from two boxes flagged rather than collapsed into one.
 */
export function toInstances(services) {
  const list = services
    .filter((s) => s.txt?.id)
    .map((s) => ({
      systemId: String(s.txt.id),
      name: String(s.txt.name ?? s.name),
      version: s.txt.v ? String(s.txt.v) : null,
      boot: s.txt.boot ? String(s.txt.boot) : null,
      host: s.host ?? null,
      port: s.port,
      addresses: [...new Set([...(s.addresses ?? []), ...(s.referer?.address ? [s.referer.address] : [])])],
    }));
  const boots = new Map();
  for (const i of list) boots.set(i.systemId, new Set([...(boots.get(i.systemId) ?? []), i.boot]));
  return list
    .map((i) => ({ ...i, duplicate: (boots.get(i.systemId)?.size ?? 0) > 1 }))
    .sort((a, b) => a.name.localeCompare(b.name) || String(a.host).localeCompare(String(b.host)));
}

/** Listen for `timeoutMs` and return what answered. */
export function browse({ type = SERVICE_TYPE, timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    let bonjour;
    try {
      bonjour = new Bonjour({}, () => {});
    } catch {
      resolve([]);
      return;
    }
    const browser = bonjour.find({ type });
    setTimeout(() => {
      const found = toInstances(browser.services);
      browser.stop();
      bonjour.destroy(() => resolve(found));
    }, timeoutMs);
  });
}
