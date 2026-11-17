// ─────────────────────────────────────────────────────────────────────────────
//  Server or client, and which server (#48, #56).
//
//  The desktop app is either THE server for a building (the Express app runs
//  in this process) or a client: a window onto a server somewhere on the LAN.
//  This module holds the decisions, with no Electron in it, so plain
//  `node --test` can cover them. main.js does the windows.
//
//  The choice lives in <userData>/desktop.json, beside the data folder rather
//  than in it: a client has no data folder at all, and the server's data
//  folder is the church's database, which a preference has no business in.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_PORT = 8080;

// ── The saved choice ────────────────────────────────────────────────────────

const prefsPath = (userData) => join(userData, 'desktop.json');

export function readPrefs(userData) {
  try {
    const p = JSON.parse(readFileSync(prefsPath(userData), 'utf8'));
    return p && typeof p === 'object' ? p : {};
  } catch {
    return {};
  }
}

export function writePrefs(userData, prefs) {
  writeFileSync(prefsPath(userData), `${JSON.stringify(prefs, null, 2)}\n`);
}

/**
 * What to do on launch: 'server', 'client', or 'choose'.
 *
 * An install that already has a data folder is a server, and is never asked.
 * It is hosting a building, and an upgrade that put "server or client?" in
 * front of a volunteer is one wrong click from every room going dark. Only a
 * computer that has never run ProdMesh gets the question.
 */
export function launchMode({ prefs, dataDirExists }) {
  if (prefs.mode === 'server') return 'server';
  if (prefs.mode === 'client' && prefs.server?.url) return 'client';
  return dataDirExists ? 'server' : 'choose';
}

// ── Addresses ───────────────────────────────────────────────────────────────

/**
 * What someone typed, as an origin: "192.0.2.10" → "http://192.0.2.10:8080".
 * Only http and https, and only the origin: the window decides the path.
 */
export function normalizeAddress(input) {
  let s = String(input ?? '').trim();
  if (!s) throw new Error('Enter an address');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
  let url;
  try {
    url = new URL(s);
  } catch {
    throw new Error('That is not an address');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Use an http address');
  if (!url.hostname) throw new Error('That is not an address');
  if (url.username || url.password) throw new Error('Leave the name and password out of the address');
  // URL drops a default port (":80"), so ask what was typed, not the parse.
  const authority = s.slice(s.indexOf('://') + 3).split(/[/?#]/)[0];
  const typedPort = /:\d+$/.test(authority.replace(/^\[[^\]]*\]/, ''));
  if (!typedPort && url.protocol === 'http:') url.port = String(DEFAULT_PORT);
  return url.origin;
}

/** The addresses a discovered server answers on, as origins to try in order. */
export function originsOf(instance) {
  const v4 = (instance.addresses ?? []).filter((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
  const v6 = (instance.addresses ?? []).filter((a) => a.includes(':') && !a.startsWith('fe80'));
  return [...v4.map((a) => `http://${a}:${instance.port}`), ...v6.map((a) => `http://[${a}]:${instance.port}`)];
}

// ── Is it a ProdMesh, and which one ─────────────────────────────────────────

/**
 * Ask an origin who it is. Every ProdMesh answers /api/system/identity
 * without a login (#49). Anything else, or nothing in time, is not one.
 */
export async function identify(origin, { fetch: f = fetch, timeoutMs = 3000 } = {}) {
  let res;
  try {
    res = await f(`${origin}/api/system/identity`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new Error('Nothing answered at that address');
  }
  let body = null;
  try { body = await res.json(); } catch { /* not JSON: not us */ }
  if (!res.ok || typeof body?.systemId !== 'string') throw new Error('That address is not a ProdMesh server');
  return { systemId: body.systemId, name: String(body.name ?? 'ProdMesh') };
}

/**
 * Where the saved server is now. The address first, since it is usually
 * right. If that is silent, or something else answers there (DHCP gave the
 * address to another box), look the server up by its id over mDNS: it is the
 * id that names the server, never the address.
 *
 * Resolves to { url, name } or null.
 */
export async function locate(saved, { identify: id = identify, browse = async () => [] } = {}) {
  try {
    const who = await id(saved.url);
    if (who.systemId === saved.systemId) return { url: saved.url, name: who.name };
  } catch { /* fall through to discovery */ }
  const found = (await browse()).filter((i) => i.systemId === saved.systemId && !i.duplicate);
  for (const inst of found) {
    for (const url of originsOf(inst)) {
      try {
        const who = await id(url);
        if (who.systemId === saved.systemId) return { url, name: who.name };
      } catch { /* try the next */ }
    }
  }
  return null;
}

// ── The window's leash ──────────────────────────────────────────────────────

/** Navigation inside the window stays on the server it is showing. */
export function sameOrigin(target, origin) {
  try {
    return new URL(target).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

/** A link out (a Planning Center plan, a help page) goes to the browser. */
export const opensExternally = (target) => /^https?:\/\//i.test(String(target));
