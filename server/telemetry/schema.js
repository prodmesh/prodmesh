// ─────────────────────────────────────────────────────────────────────────────
//  SCHEMA  —  prodmesh-telemetry/1: everything a report may contain.
//
//  An allowlist, as data. The collector's output is checked against it in the
//  tests, docs/TELEMETRY.md must describe every field in it (a test enforces
//  that too), and the cloud's ingest vendors this file and rejects anything it
//  does not describe. So "this is all we send" is one file, here, in the public
//  repository, and three things hold it to account.
//
//  Free-text fields (`text`) are also checked for anything still shaped like an
//  address, a path, an email or an id after scrubbing: a report that fails is
//  a scrubber bug, and refusing it is the safe way to find out.
//
//  Changing a field's meaning or adding one is a new schema version, never an
//  edit to this one: an install keeps sending what it was built with.
// ─────────────────────────────────────────────────────────────────────────────

import { LEAK_CHECKS, FRAME_SHAPE, MESSAGE_MAX, FRAMES_MAX } from './scrub.js';

export const SCHEMA_ID = 'prodmesh-telemetry/1';
export const MAX_BYTES = 64 * 1024;
export const ERRORS_MAX = 50;

// Bucketed counts: the exact shape of a church's setup would fingerprint it.
export const COUNT_BUCKETS = ['0', '1', '2-5', '6-20', '21+'];
export const MEMORY_BUCKETS = ['<4', '4-8', '8-16', '16-32', '32+']; // GB
export const DISK_BUCKETS = ['<1', '1-5', '5-20', '20-100', '100+']; // GB free
export const DATABASE_BUCKETS = ['<10', '10-100', '100-1000', '1000+']; // MB

const T = {
  str: (pattern, max = 64) => ({ type: 'string', pattern, max }),
  text: (max) => ({ type: 'string', max, text: true }),
  int: (min = 0, max = Number.MAX_SAFE_INTEGER) => ({ type: 'integer', min, max }),
  num: (min = 0, max = Number.MAX_SAFE_INTEGER) => ({ type: 'number', min, max }),
  bool: () => ({ type: 'boolean' }),
  oneOf: (values) => ({ type: 'enum', values }),
  obj: (fields) => ({ type: 'object', fields }),
  map: (keyPattern, value, max) => ({ type: 'map', keyPattern, value, max }),
  arr: (items, max) => ({ type: 'array', items, max }),
  opt: (spec) => ({ ...spec, nullable: true }),
};

const VERSION = /^[\w.+-]{1,40}$/;
const IDENT = /^[A-Za-z_$][\w$]{0,40}$/;
const median = () => T.opt(T.num(0, 1e6));

const ERROR = T.obj({
  name: T.str(IDENT),
  message: T.text(MESSAGE_MAX),
  frames: T.arr(T.str(FRAME_SHAPE, 200), FRAMES_MAX),
  fingerprint: T.str(/^[0-9a-f]{16}$/),
});

export const SCHEMA = T.obj({
  schema: T.oneOf([SCHEMA_ID]),
  telemetryId: T.str(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  sentAt: T.int(),
  seq: T.int(),
  window: T.obj({ from: T.int(), to: T.int() }),
  build: T.obj({
    version: T.str(VERSION),
    commit: T.opt(T.str(/^[0-9a-f]{7,40}$/)),
    deployment: T.oneOf(['git', 'container', 'desktop', 'package']),
    node: T.str(VERSION),
    electron: T.opt(T.str(VERSION)),
  }),
  host: T.obj({
    platform: T.oneOf(['darwin', 'linux', 'win32', 'freebsd', 'openbsd', 'other']),
    release: T.str(/^[\w.+~-]{1,64}$/),
    arch: T.str(/^[\w]{1,16}$/),
    cpuModel: T.text(64),
    cpuCount: T.int(0, 1024),
    memoryGb: T.oneOf(MEMORY_BUCKETS),
  }),
  resources: T.obj({
    rssMb: T.obj({ median: median(), peak: median() }),
    heapMb: T.obj({ median: median(), peak: median() }),
    eventLoopDelayMs: T.obj({ p50: median(), p99: median() }),
    cpuPercent: T.opt(T.num(0, 100_000)),
    uptimeHours: T.num(0, 1e6),
    diskFreeGb: T.opt(T.oneOf(DISK_BUCKETS)),
    databaseMb: T.opt(T.oneOf(DATABASE_BUCKETS)),
    streamClientsPeak: T.oneOf(COUNT_BUCKETS),
  }),
  shape: T.obj({
    rooms: T.oneOf(COUNT_BUCKETS),
    campuses: T.oneOf(COUNT_BUCKETS),
    linkedServers: T.oneOf(COUNT_BUCKETS),
    users: T.oneOf(COUNT_BUCKETS),
    integrations: T.map(/^[A-Za-z][\w-]{0,30}$/, T.obj({ version: T.opt(T.str(/^\d+(?:\.\d+){0,3}$/, 20)) }), 30),
  }),
  errors: T.arr(T.obj({
    where: T.str(/^[a-z][\w-]{0,40}$/i),
    ...ERROR.fields,
    count: T.int(1),
    firstSeen: T.int(),
    lastSeen: T.int(),
  }), ERRORS_MAX),
  errorsDropped: T.int(),
  lifecycle: T.obj({
    boots: T.int(),
    uncleanExits: T.int(),
    previous: T.opt(T.obj({
      endedCleanly: T.bool(),
      version: T.str(VERSION),
      uptimeMs: T.opt(T.int()),
      error: T.opt(T.obj({ origin: T.oneOf(['uncaughtException', 'unhandledRejection', 'start']), ...ERROR.fields })),
    })),
  }),
});

function check(spec, value, path, errors) {
  if (value === null || value === undefined) {
    if (!spec.nullable) errors.push(`${path}: required`);
    return;
  }
  switch (spec.type) {
    case 'string':
      if (typeof value !== 'string') return errors.push(`${path}: not a string`);
      if (value.length > spec.max) errors.push(`${path}: longer than ${spec.max}`);
      if (spec.pattern && !spec.pattern.test(value)) errors.push(`${path}: does not match ${spec.pattern}`);
      if (spec.text) {
        const leak = LEAK_CHECKS.find((re) => re.test(value));
        if (leak) errors.push(`${path}: still looks like ${leak} after scrubbing`);
      }
      return;
    case 'integer':
      if (!Number.isInteger(value)) return errors.push(`${path}: not an integer`);
      if (value < spec.min || value > spec.max) errors.push(`${path}: out of range`);
      return;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return errors.push(`${path}: not a number`);
      if (value < spec.min || value > spec.max) errors.push(`${path}: out of range`);
      return;
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`${path}: not a boolean`);
      return;
    case 'enum':
      if (!spec.values.includes(value)) errors.push(`${path}: not one of ${spec.values.join(', ')}`);
      return;
    case 'array':
      if (!Array.isArray(value)) return errors.push(`${path}: not an array`);
      if (value.length > spec.max) errors.push(`${path}: more than ${spec.max} items`);
      value.forEach((v, i) => check(spec.items, v, `${path}[${i}]`, errors));
      return;
    case 'object':
    case 'map': {
      if (typeof value !== 'object' || Array.isArray(value)) return errors.push(`${path}: not an object`);
      const keys = Object.keys(value);
      if (spec.type === 'map') {
        if (keys.length > spec.max) errors.push(`${path}: more than ${spec.max} entries`);
        for (const k of keys) {
          if (!spec.keyPattern.test(k)) errors.push(`${path}.${k}: key does not match ${spec.keyPattern}`);
          check(spec.value, value[k], `${path}.${k}`, errors);
        }
        return;
      }
      for (const k of keys) if (!(k in spec.fields)) errors.push(`${path}.${k}: not in the schema`);
      for (const [k, s] of Object.entries(spec.fields)) check(s, value[k], path ? `${path}.${k}` : k, errors);
      return;
    }
    default:
      errors.push(`${path}: unknown spec type ${spec.type}`);
  }
}

/** Every problem with a report, or [] if it may be sent. */
export function validate(report) {
  const errors = [];
  check(SCHEMA, report, '', errors);
  const bytes = Buffer.byteLength(JSON.stringify(report ?? null));
  if (bytes > MAX_BYTES) errors.push(`report is ${bytes} bytes, over ${MAX_BYTES}`);
  return errors;
}

/** Dotted paths of every field, for the documentation check. `[]` marks arrays, `*` map values. */
export function fieldPaths(spec = SCHEMA, prefix = '') {
  if (spec.type === 'object') {
    return Object.entries(spec.fields).flatMap(([k, s]) => {
      const p = prefix ? `${prefix}.${k}` : k;
      return [p, ...fieldPaths(s, p)];
    });
  }
  if (spec.type === 'array') return fieldPaths(spec.items, `${prefix}[]`);
  if (spec.type === 'map') return fieldPaths(spec.value, `${prefix}.*`);
  return [];
}
