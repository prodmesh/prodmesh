// ─────────────────────────────────────────────────────────────────────────────
//  SETTINGS STORE  —  operational settings that change at runtime.
//
//  Persisted to server/data/settings.json (git-ignored, per-box). Holds the
//  Admin/Override PINs (hashed) and per-room lockout schedules. Structural
//  config (rooms, Companion hosts, button locations) stays in rooms.config.js.
//
//  This is the tier-2 store the Settings UI edits — no dependencies, just a file.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateSchedules } from './validate.js';
import { assertNotSealed } from './restoreSeal.js';
import { writeJsonAtomic } from './atomicFile.js';
import { wantsDemoSeed } from './seedMode.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Overridable so tests (and alternate deployments) can point at their own dir.
const DATA_DIR = process.env.PRODMESH_DATA_DIR ?? join(__dirname, 'data');
const FILE = join(DATA_DIR, 'settings.json');

// The example Sunday lock that ships with the demo topology. It is keyed to
// "north-main", so a real church's fresh install would open Settings to a
// protection window on a room they have never heard of — the same
// someone-else's-data problem the topology seed has, answered the same way
// (seedMode.js). It only takes effect once an Override PIN is set.
const DEMO_SCHEDULES = {
  'north-main': [
    {
      id: 'sun-services',
      label: 'Sunday Services',
      days: [0], // 0 = Sunday
      start: '07:00',
      end: '13:30',
      lock: ['standby'], // mode ids that require the Override PIN in this window
    },
  ],
};

// First-run defaults.
const DEFAULTS = {
  version: 1,
  pins: { admin: null, override: null }, // hashed "salt:hash" strings, or null
  // When the wizard finished, or null while this install is unclaimed.
  setupCompletedAt: null,
  schedules: {},
  // Integrations start enabled so upgrading an existing install never hides a
  // working widget. A false entry is the only persisted override.
  integrations: {},
};

export const INTEGRATION_IDS = [
  'planning-center', 'propresenter', 'restream', 'resi', 'obs', 'youtube', 'slack',
  'companion', 'prodmesh-rta', 'smaart', 'open-sound-meter', 'captions', 'prodcom',
];

let settings = null;

function load() {
  if (settings) return settings;
  if (existsSync(FILE)) {
    try {
      settings = { ...DEFAULTS, ...JSON.parse(readFileSync(FILE, 'utf8')) };
    } catch {
      settings = structuredClone(DEFAULTS);
    }
  } else {
    settings = structuredClone(DEFAULTS);
    if (wantsDemoSeed()) settings.schedules = structuredClone(DEMO_SCHEDULES);
    persist();
  }
  return settings;
}

function persist() {
  // `settings` is memoised and written back whole, so after a restore this
  // would rewrite the restored file from the old install's memory — admin PIN
  // included. See restoreSeal.js.
  assertNotSealed();
  writeJsonAtomic(FILE, settings);
}

// ── PIN hashing (scrypt, salted, constant-time compare) ───────────────────────
function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(pin), salt, 32);
  return `${salt.toString('hex')}:${dk.toString('hex')}`;
}

function verifyHash(pin, stored) {
  if (!stored || pin == null || pin === '') return false;
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const dk = crypto.scryptSync(String(pin), Buffer.from(saltHex, 'hex'), 32);
  const hb = Buffer.from(hashHex, 'hex');
  return dk.length === hb.length && crypto.timingSafeEqual(dk, hb);
}

/**
 * The stored admin PIN hash, for authStore to project onto the built-in
 * `admin` account. This file stays the SOURCE of that credential — it is what
 * somebody edits on the server when the PIN is forgotten, and the restore seal
 * covers it — while authorizing an admin is now an ordinary user session.
 */
export const adminPinHash = () => load().pins.admin ?? null;

// Told, not polled: server/index.js registers authStore's projection so the
// account tracks the file. A hook rather than an import because settings are a
// FILE and users are a DATABASE, and a module about the first should not have
// to know the second exists.
const adminPinListeners = new Set();
export const onAdminPinChange = (fn) => adminPinListeners.add(fn);
export const verifyOverride = (pin) => verifyHash(pin, load().pins.override);
export const isAdminSetupNeeded = () => load().pins.admin == null;
export const isOverrideSet = () => load().pins.override != null;

/**
 * Update PINs. For each of `admin` / `override`:
 *   - a non-empty string sets it
 *   - the empty string '' clears it (null)
 *   - undefined leaves it unchanged
 */
// The admin PIN gates a token that bypasses every permission check, so it gets
// a real floor. The override PIN only unlocks a room-mode change in front of a
// person standing at the booth, so it stays short enough to type under
// pressure. Neither had ANY minimum before — a one-character admin PIN was
// accepted, which made the brute-force path trivial.
const MIN_ADMIN_PIN = 6;
const MIN_OVERRIDE_PIN = 4;

export function setPins({ admin, override } = {}) {
  const check = (value, min, what) => {
    if (value === undefined || value === '') return;
    if (String(value).length < min) {
      const err = new Error(`${what} must be at least ${min} characters`);
      err.code = 'weak_pin';
      throw err;
    }
  };
  check(admin, MIN_ADMIN_PIN, 'Admin PIN');
  check(override, MIN_OVERRIDE_PIN, 'Override PIN');

  const s = load();
  if (admin !== undefined) s.pins.admin = admin === '' ? null : hashPin(admin);
  if (override !== undefined) s.pins.override = override === '' ? null : hashPin(override);
  persist();
  if (admin !== undefined) for (const fn of adminPinListeners) fn(s.pins.admin);
}

// ── First-run setup ───────────────────────────────────────────────────────────
//  Whether the setup wizard still has work to do. Kept here (rather than
//  inferred from "is there an admin PIN?") because the PIN is set at the FIRST
//  wizard step: inferring would declare setup finished while the church is
//  still on step two, and a reload would drop them into an app with no
//  campuses. setup.js owns the policy; this is just the stored fact.

export const getSetupCompletedAt = () => load().setupCompletedAt ?? null;

export function markSetupComplete(at = Date.now()) {
  const s = load();
  if (s.setupCompletedAt) return s.setupCompletedAt; // first stamp wins
  s.setupCompletedAt = at;
  persist();
  return at;
}

export function setSchedules(schedules) {
  const s = load();
  s.schedules = validateSchedules(schedules);
  persist();
}

export function setIntegrationEnabled(id, enabled) {
  if (!INTEGRATION_IDS.includes(id)) throw new Error(`Unknown integration "${id}"`);
  if (typeof enabled !== 'boolean') throw new Error('Integration enabled must be true or false');
  const s = load();
  s.integrations = { ...(s.integrations ?? {}), [id]: enabled };
  persist();
  return getIntegrationSettings();
}

export function getIntegrationSettings() {
  const overrides = load().integrations ?? {};
  return Object.fromEntries(INTEGRATION_IDS.map((id) => [id, overrides[id] !== false]));
}

// ── Public (safe) view for the Settings UI — never exposes hashes ─────────────
export function getPublicSettings() {
  const s = load();
  return {
    pins: { adminSet: s.pins.admin != null, overrideSet: s.pins.override != null },
    schedules: s.schedules,
    integrations: getIntegrationSettings(),
  };
}

// ── Lockout engine ────────────────────────────────────────────────────────────
/**
 * Which protection (if any) applies to a room right now.
 * `enforced` is true only when an Override PIN exists — locks are meaningless
 * without a PIN to override them, so we don't advertise them until one is set.
 */
export function computeProtection(roomId, now = new Date()) {
  const windows = load().schedules[roomId] ?? [];
  const day = now.getDay();
  const minutes = now.getHours() * 60 + now.getMinutes();
  for (const w of windows) {
    if (!Array.isArray(w.days) || !w.days.includes(day)) continue;
    const [sh, sm] = String(w.start).split(':').map(Number);
    const [eh, em] = String(w.end).split(':').map(Number);
    const start = sh * 60 + sm;
    const end = eh * 60 + em;
    if (minutes >= start && minutes < end) {
      return {
        active: true,
        label: w.label,
        lockedModes: w.lock ?? [],
        enforced: isOverrideSet(),
      };
    }
  }
  return { active: false, label: null, lockedModes: [], enforced: isOverrideSet() };
}

/** Does switching to `modeId` require the Override PIN right now? */
export function isModeLocked(roomId, modeId, now = new Date()) {
  const p = computeProtection(roomId, now);
  return p.active && p.enforced && p.lockedModes.includes(modeId);
}

// The admin bearer token used to live HERE, in a process-local Map, and to set
// a flag that skipped every permission check. It is now an ordinary row in
// user_sessions like anyone else's — which is what makes an admin action
// attributable, and incidentally means a server restart no longer signs the
// administrator out mid-service.

// App version moved to server/deployment.js — it depends on how this copy was
// installed, not on settings. It stays cached for the life of the process
// there: resolving it used to fork git TWICE per call on an unauthenticated
// endpoint (~29ms of blocked event loop each time), which froze every SSE
// stream and poller under a request flood.
