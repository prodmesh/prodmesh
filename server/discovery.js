// ─────────────────────────────────────────────────────────────────────────────
//  LAN DISCOVERY  —  finding your own building's server over mDNS (#56).
//
//  So the desktop app in client mode, and one day a phone, can offer
//  "North Campus · on Production Mac mini" instead of asking for
//  192.0.2.42:8080. It is for one building only: mDNS is link-local (TTL 1,
//  routers don't forward it), so another campus is found by redeeming a
//  pairing token (#46), never by this.
//
//  Discovery grants nothing (ADR 0014). It is a signpost to an address, and
//  everything the server would tell an unauthenticated caller anyway.
//
//  Several instances on one segment must coexist (a production box and a test
//  box, a migration with the old box still on), so:
//
//    - The instance name is unique by construction: `<name> [<first 6 of the
//      system id>]`. The library's probe-and-give-up on a clash is switched off
//      in favour of that; it would leave the box silently undiscoverable.
//    - No hostname of our own is claimed. Records point at the OS's hostname,
//      which macOS and Windows already defend.
//    - Clients key on `id` in TXT, never on the instance name or the address.
//
//  The one case construction can't settle: the SAME system id on two boxes,
//  which is a backup restored onto new hardware while the old box still runs.
//  Both have the same certificate too, since identity/ travels in the backup,
//  so the fingerprint can't tell them apart. Each process therefore carries a
//  random `boot` token in TXT. Seeing our id with another token means another
//  box is running as us: we log it loudly, and both rename to add the hostname
//  so a person can tell them apart in a list. Nothing is merged or resolved:
//  which box is the real one is a person's call.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import os from 'node:os';
import { Bonjour } from 'bonjour-service';
import * as identity from './identity.js';
import { getVersion } from './deployment.js';

export const SERVICE_TYPE = 'prodmesh';

const LABEL_MAX = 63; // bytes, one DNS label (RFC 6763 §4.1.1)
const TXT_NAME_MAX = 200; // bytes; a TXT string holds 255 with its key

const bytes = (s) => Buffer.byteLength(s, 'utf8');

/** Cut to a byte budget without splitting a character. */
function clip(s, max) {
  if (bytes(s) <= max) return s;
  let out = '';
  for (const ch of s) {
    if (bytes(out + ch) > max - 1) break;
    out += ch;
  }
  return `${out.trimEnd()}…`;
}

/** The short hostname, for telling two boxes apart: "Production-Mac-mini". */
export const shortHost = (host = os.hostname()) => host.replace(/\.local\.?$/i, '').split('.')[0];

/**
 * `<name> [<id6>]`, or `<name> [<id6> · <host>]` when another box shares the
 * id. Dots become a middle dot: the library splits instance names on '.'
 * rather than escaping, so "St. Mark's" would arrive as "St". The full name
 * travels in TXT, which is what a client shows.
 */
export function instanceName(name, systemId, host = null) {
  const tag = host ? `${systemId.slice(0, 6)} · ${host}` : systemId.slice(0, 6);
  const suffix = ` [${clip(tag.replace(/\./g, '·'), 40)}]`;
  const base = String(name).replace(/\./g, '·').replace(/\s+/g, ' ').trim() || 'ProdMesh';
  return clip(base, LABEL_MAX - bytes(suffix)) + suffix;
}

/**
 * Whether this process should advertise. On for a production server and the
 * desktop app; off for `npm run dev`, which would otherwise announce the
 * church's name on whatever network a laptop happens to be on.
 * PRODMESH_DISCOVERY=on|off overrides either way.
 */
export function enabled(env = process.env) {
  const v = String(env.PRODMESH_DISCOVERY ?? '').toLowerCase();
  if (v === 'on' || v === '1') return true;
  if (v === 'off' || v === '0') return false;
  return env.NODE_ENV === 'production' || Boolean(process.versions.electron);
}

// ── Advertising ─────────────────────────────────────────────────────────────

let state = null; // { bonjour, service, browser, port, type, boot, published, duplicate, timer }

function txtFor(me, boot) {
  return { id: me.systemId, name: clip(me.name, TXT_NAME_MAX), v: getVersion().version, boot };
}

function publish() {
  const me = identity.getIdentity();
  const name = instanceName(me.name, me.systemId, state.duplicate ? shortHost() : null);
  const txt = txtFor(me, state.boot);
  state.published = { name, txt: JSON.stringify(txt) };
  state.service = state.bonjour.publish({ name, type: state.type, port: state.port, txt, probe: false });
  state.service.on('error', (err) => console.error(`[discovery] ${err.message}`));
}

/** Withdraw the current record (a goodbye, TTL 0) and publish the new one. */
function republish() {
  const old = state.service;
  state.service = null;
  if (old) old.stop(() => { if (state && !state.service) publish(); });
  else publish();
}

/** Has the name, version or duplicate state changed since we published? */
function refresh() {
  if (!state) return;
  const me = identity.getIdentity();
  const name = instanceName(me.name, me.systemId, state.duplicate ? shortHost() : null);
  if (name !== state.published?.name || JSON.stringify(txtFor(me, state.boot)) !== state.published?.txt) republish();
}

function noticeDuplicate(service) {
  const me = identity.getIdentity();
  if (!state || service.txt?.id !== me.systemId || service.txt?.boot === state.boot) return;
  if (!state.duplicate) {
    console.warn(
      `[discovery] Another server on this network is running as this one (system ${me.systemId}), ` +
        `at ${service.host ?? 'an unknown host'}${service.referer?.address ? ` (${service.referer.address})` : ''}. ` +
        'Usually a backup restored onto new hardware while the old box still runs. ' +
        'Linked servers cannot tell the two apart: switch one off.',
    );
    state.duplicate = { host: service.host ?? null, address: service.referer?.address ?? null, since: Date.now() };
    republish();
  }
}

/**
 * Start announcing `_prodmesh._tcp` on the port the dashboard is serving.
 * Never throws: a box that can't multicast (Docker's bridge network, a locked
 * down VLAN) still serves its rooms, it just isn't discoverable.
 */
export function startAdvertising({ port, type = SERVICE_TYPE, recheckMs = 60_000 } = {}) {
  if (state) return status();
  try {
    const bonjour = new Bonjour({}, (err) => console.error(`[discovery] mDNS socket: ${err.message}`));
    state = { bonjour, port, type, boot: crypto.randomBytes(4).toString('hex'), duplicate: null, service: null, published: null };
    publish();
    // Watch our own service type, to notice another box using our identity.
    state.browser = bonjour.find({ type }, noticeDuplicate);
    state.browser.on('txt-update', noticeDuplicate);
    // A rename in Admin, or a version change: cheap to check, rare to change.
    state.timer = setInterval(refresh, recheckMs);
    state.timer.unref();
  } catch (err) {
    console.error(`[discovery] not advertising: ${err.message}`);
    state = null;
  }
  return status();
}

/** Send goodbyes and close the socket. Bounded, because it runs on the way out. */
export function stopAdvertising({ timeoutMs = 1000 } = {}) {
  if (!state) return Promise.resolve();
  const s = state;
  state = null;
  clearInterval(s.timer);
  s.browser?.stop();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(cap);
      try { s.bonjour.destroy(() => resolve()); } catch { resolve(); }
    };
    const cap = setTimeout(done, timeoutMs);
    try { s.bonjour.unpublishAll(done); } catch { done(); }
  });
}

/** Re-read the name now rather than at the next check (Admin's rename). */
export const nameChanged = () => refresh();

export function status() {
  return state
    ? { advertising: true, instance: state.published?.name ?? null, port: state.port, duplicate: state.duplicate }
    : { advertising: false };
}

// ── Browsing (the desktop's client mode, #48) ───────────────────────────────

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
