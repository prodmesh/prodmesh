// ─────────────────────────────────────────────────────────────────────────────
//  COLLECTOR  —  builds a prodmesh-telemetry/1 report (ADR 0022 §4).
//
//  Gathers, in memory, over a reporting window:
//    • bug groups from health.unexpected() (0015's classifier: outages never
//      arrive here), scrubbed on the way IN, so nothing unscrubbed is held;
//    • ProdMesh's own resource use, sampled once a minute;
//    • which integrations are configured, and the product version any of them
//      has told us.
//  and reads the rest (build, host, bucketed shape, lifecycle) when a report
//  is built.
//
//  It collects whether or not reporting is switched on. Nothing here is
//  persisted or sent: that is the sender's job, and the sender is what the
//  switch governs. Collecting regardless means the preview in Admin shows a
//  real report the moment someone wonders what one looks like, and costs a
//  bounded map and a one-minute timer.
//
//  buildReport() never resets anything; takeWindow() does, and only the
//  sender calls it, after a report has gone.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { mkdirSync, readFileSync, statSync, statfsSync, existsSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, getDb } from '../db.js';
import * as health from '../health.js';
import * as deployment from '../deployment.js';
import * as lifecycle from '../lifecycle.js';
import { rooms } from '../roomsStore.js';
import { getChurch } from '../appConfig.js';
import * as identity from '../identity.js';
import { clientCount } from '../streamHub.js';
import { INTEGRATIONS, productVersion, _clear as clearVersions } from './versions.js';
import { scrubError, scrubName, scrubMessage, scrubStack, fingerprint } from './scrub.js';
import {
  SCHEMA_ID, ERRORS_MAX, COUNT_BUCKETS, MEMORY_BUCKETS, DISK_BUCKETS, DATABASE_BUCKETS,
} from './schema.js';

const SAMPLE_EVERY_MS = 60_000;
const SAMPLES_MAX = 24 * 60 * 2; // two days of minutes; a window is a day

const MB = 1024 * 1024;
const GB = 1024 * MB;

// ── Buckets ──────────────────────────────────────────────────────────────────

export function countBucket(n) {
  if (!Number.isFinite(n) || n <= 0) return COUNT_BUCKETS[0];
  if (n === 1) return '1';
  if (n <= 5) return '2-5';
  if (n <= 20) return '6-20';
  return '21+';
}

function bucket(value, edges, labels) {
  if (!Number.isFinite(value)) return null;
  const i = edges.findIndex((edge) => value < edge);
  return labels[i === -1 ? labels.length - 1 : i];
}
export const memoryBucket = (bytes) => bucket(bytes / GB, [4, 8, 16, 32], MEMORY_BUCKETS);
export const diskBucket = (bytes) => bucket(bytes / GB, [1, 5, 20, 100], DISK_BUCKETS);
export const databaseBucket = (bytes) => bucket(bytes / MB, [10, 100, 1000], DATABASE_BUCKETS);

// ── State ────────────────────────────────────────────────────────────────────

let window = newWindow(Date.now());
let started = false;
let sampler = null;
let loopDelay = null;

function newWindow(now) {
  return {
    from: now,
    errors: new Map(), // fingerprint → entry
    errorsDropped: 0,
    rss: [],
    heap: [],
    streamClientsPeak: 0,
    cpu: process.cpuUsage(),
    cpuAt: process.hrtime.bigint(),
  };
}

// ── This server's own names ──────────────────────────────────────────────────
// The scrubber catches what is SHAPED like an address or a quoted value; it
// cannot know that "north-main" or "Grace Fellowship" is a name. This server
// can: it is its own configuration. So every message also has the church's,
// the system's, each campus's and room's, and each local user's names replaced.
// Longest first, so "Grace Fellowship North" goes before "Grace Fellowship".

const NAMES_TTL_MS = 60_000;
let names = { at: 0, list: [] };

function knownNames(now = Date.now()) {
  if (now - names.at < NAMES_TTL_MS) return names.list;
  const found = new Set();
  const add = (v) => { if (typeof v === 'string' && v.trim().length >= 3) found.add(v.trim()); };
  quietly(() => {
    const church = getChurch();
    add(church.name);
    for (const site of church.sites ?? []) {
      add(site.id); add(site.name);
      for (const room of site.auditoriums ?? []) { add(room.id); add(room.name); }
    }
  });
  for (const [id, room] of Object.entries(rooms)) { add(id); add(room?.name); }
  quietly(() => { add(identity.getIdentity().name); });
  quietly(() => {
    for (const u of getDb().prepare('SELECT username, display_name AS displayName FROM users').all()) { add(u.username); add(u.displayName); }
  });
  const escape = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  names = { at: now, list: [...found].sort((a, b) => b.length - a.length).map((n) => new RegExp(`(?<![\\w-])${escape(n)}(?![\\w-])`, 'gi')) };
  return names.list;
}

export function scrubNames(text) {
  let out = String(text ?? '');
  for (const re of knownNames()) out = out.replace(re, '<name>');
  return out;
}

/** Called by health.unexpected() for every bug, before its log throttle. */
export function recordError(where, err, now = Date.now()) {
  const e = scrubError(err, where);
  e.message = scrubNames(e.message);
  const existing = window.errors.get(e.fingerprint);
  if (existing) {
    existing.count += 1;
    existing.lastSeen = now;
    return;
  }
  if (window.errors.size >= ERRORS_MAX) { window.errorsDropped += 1; return; }
  window.errors.set(e.fingerprint, { ...e, count: 1, firstSeen: now, lastSeen: now });
}

function sample() {
  const m = process.memoryUsage();
  window.rss.push(m.rss);
  window.heap.push(m.heapUsed);
  if (window.rss.length > SAMPLES_MAX) { window.rss.shift(); window.heap.shift(); }
  window.streamClientsPeak = Math.max(window.streamClientsPeak, clientCount());
}

/** Start sampling and listening. Idempotent; the timer never holds the process open. */
export function start() {
  if (started) return;
  started = true;
  health.onUnexpected(recordError);
  loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
  sample();
  sampler = setInterval(sample, SAMPLE_EVERY_MS);
  sampler.unref();
}

/** Close the window: the sender calls this once a report has been accepted. */
export function takeWindow(now = Date.now()) {
  window = newWindow(now);
  loopDelay?.reset();
  bootReported = true;
}

// This process's start, and how the run before it ended, belong to the first
// report after boot and no other: a server up for a week would otherwise
// report the same crash seven times.
let bootReported = false;

// ── The telemetry id (ADR 0022 §1, §6) ───────────────────────────────────────
// Random, not the system id (which mDNS broadcasts and every peer holds), and
// kept in data/telemetry/, which backups do not carry: a restore is a new
// install as far as telemetry knows.

const ID_FILE = () => join(DATA_DIR, 'telemetry', 'id.json');

// The id and its Ed25519 signing key live in one file and are replaced
// together: a fresh id with the old key would still be linkable through the
// key. The file holds a private key, so it is written 0600 from the start,
// through a temp file created with that mode, never chmod-ed after the fact.
function writeIdentity(value) {
  const file = ID_FILE();
  mkdirSync(join(DATA_DIR, 'telemetry'), { recursive: true });
  const tmp = `${file}.tmp`;
  try { unlinkSync(tmp); } catch { /* none */ }
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

function newKey() {
  return crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
}

let identityCache = null;

function ownIdentity() {
  if (identityCache) return identityCache;
  let stored = null;
  try { stored = JSON.parse(readFileSync(ID_FILE(), 'utf8')); } catch { /* none yet */ }
  if (typeof stored?.id !== 'string' || stored.id.length !== 36) return makeIdentity();
  if (typeof stored.privateKey !== 'string') {
    // An id from before signing existed: keep the id, add its key.
    stored = { ...stored, privateKey: newKey() };
    writeIdentity(stored);
  }
  const privateKey = crypto.createPrivateKey(stored.privateKey);
  identityCache = {
    id: stored.id,
    privateKey,
    publicKey: crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64'),
  };
  return identityCache;
}

function makeIdentity() {
  writeIdentity({ id: crypto.randomUUID(), createdAt: Date.now(), privateKey: newKey() });
  identityCache = null;
  return ownIdentity();
}

export const telemetryId = () => ownIdentity().id;

/** The id, its signing key, and the public half the receiving end pins to it. */
export const telemetryIdentity = () => ownIdentity();

/** A new id and key: from here on, reports cannot be joined to earlier ones. */
export function resetTelemetryId() {
  return makeIdentity().id;
}

// ── Building a report ────────────────────────────────────────────────────────

const toMb = (bytes) => Math.round((bytes / MB) * 10) / 10;
function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
const peak = (values) => (values.length ? Math.max(...values) : null);
const ms = (ns) => (Number.isFinite(ns) && ns > 0 ? Math.round(ns / 1e5) / 10 : null);

function build() {
  const v = deployment.getVersion();
  const kind = deployment.kind();
  return {
    version: v.version,
    commit: /^[0-9a-f]{7,40}$/.test(v.commit) ? v.commit : null,
    deployment: ['git', 'container', 'desktop', 'package'].includes(kind) ? kind : 'package',
    node: process.versions.node,
    electron: process.versions.electron ?? null,
  };
}

function host() {
  const platform = ['darwin', 'linux', 'win32', 'freebsd', 'openbsd'].includes(process.platform) ? process.platform : 'other';
  const model = (os.cpus()[0]?.model ?? 'unknown').replace(/[^\w @().,+-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 64);
  return {
    platform,
    release: /^[\w.+~-]{1,64}$/.test(os.release()) ? os.release() : 'unknown',
    arch: process.arch,
    cpuModel: scrubMessage(model).slice(0, 64) || 'unknown',
    cpuCount: os.cpus().length,
    memoryGb: memoryBucket(os.totalmem()),
  };
}

function resources() {
  let diskFree = null;
  try { const s = statfsSync(DATA_DIR); diskFree = s.bavail * s.bsize; } catch { /* not every platform */ }
  let dbBytes = null;
  for (const f of ['prodmesh.db', 'prodmesh.db-wal']) {
    const p = join(DATA_DIR, f);
    if (existsSync(p)) dbBytes = (dbBytes ?? 0) + statSync(p).size;
  }
  const cpu = process.cpuUsage(window.cpu);
  const elapsedUs = Number(process.hrtime.bigint() - window.cpuAt) / 1000;
  return {
    rssMb: { median: median(window.rss) && toMb(median(window.rss)), peak: peak(window.rss) && toMb(peak(window.rss)) },
    heapMb: { median: median(window.heap) && toMb(median(window.heap)), peak: peak(window.heap) && toMb(peak(window.heap)) },
    eventLoopDelayMs: { p50: ms(loopDelay?.percentile(50)), p99: ms(loopDelay?.percentile(99)) },
    // Of one core, so a busy two-core box reads 200, as `top` shows it.
    cpuPercent: elapsedUs > 0 ? Math.round(((cpu.user + cpu.system) / elapsedUs) * 1000) / 10 : null,
    uptimeHours: Math.round((process.uptime() / 3600) * 10) / 10,
    diskFreeGb: diskFree == null ? null : diskBucket(diskFree),
    databaseMb: dbBytes == null ? null : databaseBucket(dbBytes),
    streamClientsPeak: countBucket(Math.max(window.streamClientsPeak, clientCount())),
  };
}

function quietly(fn, fallback) { try { return fn(); } catch { return fallback; } }

function shape() {
  const db = quietly(() => getDb(), null);
  const count = (sql) => quietly(() => db.prepare(sql).get().n, 0);
  // Configured integrations, by the internal names health.js already keys
  // them by (`proPresenter@<host>` → proPresenter). Never the host part.
  const integrations = {};
  for (const key of Object.keys(health.snapshot())) {
    const name = key.split('@')[0];
    if (INTEGRATIONS.has(name)) {
      integrations[name] = { version: productVersion(name) };
    }
  }
  return {
    rooms: countBucket(Object.keys(rooms).length),
    campuses: countBucket(count('SELECT COUNT(*) AS n FROM sites')),
    linkedServers: countBucket(count("SELECT COUNT(*) AS n FROM federation_peers WHERE state != 'removed'")),
    // Local accounts only: a visitor is another server's user.
    users: countBucket(count('SELECT COUNT(*) AS n FROM users WHERE origin_system_id IS NULL')),
    integrations,
  };
}

function previousRun() {
  const p = lifecycle.previousRun();
  if (!p) return null;
  let error = null;
  if (p.fatal) {
    const name = scrubName(p.fatal.name);
    const frames = scrubStack(p.fatal.stack);
    error = {
      origin: ['uncaughtException', 'unhandledRejection', 'start'].includes(p.fatal.origin) ? p.fatal.origin : 'uncaughtException',
      name,
      message: scrubNames(scrubMessage(p.fatal.message)),
      frames,
      fingerprint: fingerprint('', name, frames),
    };
  }
  return {
    endedCleanly: p.endedCleanly,
    version: /^[\w.+-]{1,40}$/.test(p.version) ? p.version : 'unknown',
    uptimeMs: Number.isInteger(p.uptimeMs) ? p.uptimeMs : null,
    error,
  };
}

const minute = (t) => Math.floor(t / 60_000) * 60_000;

/**
 * The report as it would be sent now. Pure with respect to the window: it can
 * be called for a preview as often as anyone likes.
 */
export function buildReport({ now = Date.now(), seq = 0 } = {}) {
  const previous = bootReported ? null : previousRun();
  return {
    schema: SCHEMA_ID,
    telemetryId: telemetryId(),
    sentAt: now,
    seq,
    window: { from: window.from, to: now },
    build: build(),
    host: host(),
    resources: resources(),
    shape: shape(),
    // Minutes, not milliseconds: the time of a bug to the minute is enough to
    // line it up with a release, and finer says more about the room than us.
    errors: [...window.errors.values()].map((e) => ({ ...e, firstSeen: minute(e.firstSeen), lastSeen: minute(e.lastSeen) })),
    errorsDropped: window.errorsDropped,
    lifecycle: {
      boots: bootReported ? 0 : 1,
      uncleanExits: previous && !previous.endedCleanly ? 1 : 0,
      previous,
    },
  };
}

/** Tests only. */
export function _resetForTests(now = Date.now(), { bootReported: reported = false } = {}) {
  window = newWindow(now);
  bootReported = reported;
  identityCache = null;
  names = { at: 0, list: [] };
  clearVersions();
}
