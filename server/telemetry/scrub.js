// ─────────────────────────────────────────────────────────────────────────────
//  SCRUB  —  what of an error may leave the building (ADR 0022 §4).
//
//  An error message is the most dangerous field in a report, because it is the
//  one we did not write: a device's reply, a parse failure quoting the JSON it
//  choked on, an address that did not answer. So the rule is generic first —
//  anything that LOOKS like an address, a path, an id or a quoted value is
//  replaced — and specific second: a short list of V8's own message shapes
//  keeps the identifier that makes the message useful, because that part is
//  our code's vocabulary, not the church's.
//
//  Stacks keep only frames whose file is ours (relative to the install root,
//  because an absolute path holds the OS username), a dependency's, or Node's
//  own. Anything else becomes <external>.
//
//  `where` labels are partly ours and partly data: `autostart ${roomId}` puts
//  a slug the church chose, and which can name it, beside our constant. Only
//  the first word is kept; the fingerprint's frames do the grouping.
//
//  This is defence in depth, not a guarantee: a message saying "user Sam not
//  found" in plain words passes. The preview in Admin exists so that a person
//  can read exactly what would be sent, and schema.js refuses a report whose
//  text still looks like any of the patterns below.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const MESSAGE_MAX = 200;
export const FRAMES_MAX = 20;
const FINGERPRINT_FRAMES = 3;

/** The install root, with forward slashes: what a frame is made relative to. */
export const INSTALL_ROOT = slashes(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));

function slashes(p) { return String(p).replace(/\\/g, '/'); }

// Order matters: a URL contains an address and a path, an email contains
// something domain-shaped, so the wider patterns go first.
const PATTERNS = [
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`)]+/gi, '<url>'],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g, '<ip>'],
  // IPv6: three or more non-empty hex groups, or a `::` form with at least
  // one group before it (fe80::1). Also eats a clock time like 10:42:05,
  // which costs nothing worth keeping. Bare ::1 is loopback and identifies
  // no one.
  [/(?<![\w:])(?:(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,6}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,5})?)(?![\w:])/gi, '<ip>'],
  // Absolute paths: POSIX home and volume roots, Windows drives, UNC shares.
  [/(?:[a-z]:[\\/]|\\\\)[^\s'"`]+/gi, '<path>'],
  [/(?<![\w.])\/(?:Users|home|Volumes|var|tmp|private|opt|srv|mnt|root|etc|Library|Applications)\/[^\s'"`]*/g, '<path>'],
  // Hostnames that only exist on a LAN: the name of the booth Mac.
  [/\b[\w-]+(?:\.[\w-]+)*\.(?:local|lan|home|internal|corp|localdomain)\b/gi, '<host>'],
  [/\d{5,}/g, '<n>'],
];

// V8's own message shapes whose quoted part is a property name from OUR code.
// "Cannot read properties of undefined (reading 'items')" without 'items' is
// a message that says nothing.
const KEEP_IDENTIFIER = /\((reading|setting) '([A-Za-z_$][\w$]{0,40})'\)/g;
const QUOTED = /'[^']*'|"[^"]*"|`[^`]*`/g;

/** Scrub an error message to something safe to send. */
export function scrubMessage(message) {
  let s = String(message ?? '').replace(/\s+/g, ' ').trim();
  // Lift the identifiers out so the quoted-string rule cannot touch them. The
  // placeholder is a private-use character, which no real message contains.
  const kept = [];
  s = s.replace(KEEP_IDENTIFIER, (_m, verb, id) => { kept.push(`(${verb} '${id}')`); return `\uE000${kept.length - 1}\uE000`; });
  for (const [re, to] of PATTERNS) s = s.replace(re, to);
  s = s.replace(QUOTED, (q) => `${q[0]}…${q[0]}`);
  s = s.replace(/\uE000(\d+)\uE000/g, (_m, i) => kept[Number(i)]);
  return s.length > MESSAGE_MAX ? `${s.slice(0, MESSAGE_MAX - 1)}…` : s;
}

/** An error's class name, if it is a plain identifier; otherwise "Error". */
export function scrubName(name) {
  return /^[A-Za-z_$][\w$]{0,40}$/.test(String(name ?? '')) ? String(name) : 'Error';
}

/** Only the first word of a `where` label is a constant from our code. */
export function scrubWhere(where) {
  const first = String(where ?? '').trim().split(/\s+/)[0] ?? '';
  return /^[a-z][\w-]{0,40}$/i.test(first) ? first : 'unknown';
}

// `    at fn (location)` or `    at location`, with `async ` optional.
const FRAME = /^\s*at (?:async )?(?:(.+?) \((.+)\)|(.+))$/;

function location(raw, root) {
  let loc = slashes(raw.trim());
  if (loc.startsWith('file://')) {
    try { loc = slashes(fileURLToPath(loc.replace(/:\d+:\d+$/, ''))) + (loc.match(/:\d+:\d+$/)?.[0] ?? ''); } catch { return '<external>'; }
  }
  if (loc.startsWith('node:') || loc === 'native' || loc === '<anonymous>') return loc;
  const lower = loc.toLowerCase();
  const base = `${root.replace(/\/$/, '')}/`;
  // Windows paths compare case-insensitively; POSIX ones are already exact.
  if (lower.startsWith(base.toLowerCase())) return loc.slice(base.length);
  const nm = loc.lastIndexOf('/node_modules/');
  if (nm !== -1) return loc.slice(nm + 1); // a dependency's path is public
  return '<external>';
}

function functionName(fn) {
  if (!fn) return null;
  // `new Foo`, `Object.<anonymous>`, `Router.handle [as handle]`: our code's
  // and libraries' identifiers. Anything with other characters is not.
  return /^[\w$.<>[\] ]{1,80}$/.test(fn) ? fn : '<fn>';
}

/** Stack text → an array of safe frame strings, innermost first. */
export function scrubStack(stack, root = INSTALL_ROOT) {
  const frames = [];
  for (const line of String(stack ?? '').split('\n')) {
    const m = FRAME.exec(line);
    if (!m) continue; // the message line, or anything that is not a frame
    const fn = functionName(m[1]);
    const loc = location(m[2] ?? m[3], root);
    frames.push(fn ? `${fn} (${loc})` : loc);
    if (frames.length >= FRAMES_MAX) break;
  }
  return frames;
}

/**
 * The same bug on any install and any version: where, what, and the top
 * three of OUR frames, without line and column, which move with every edit
 * to the file.
 */
export function fingerprint(where, name, frames) {
  // Our own frames only, when there are any. Node's internals and a
  // dependency's below them depend on HOW the code was reached (straight from
  // a timer, or after an await), so including them splits one bug into
  // several groups.
  const own = frames.filter((f) => !/(?:^|\()(?:node:|native|<external>|<anonymous>|node_modules\/)/.test(f));
  const top = (own.length ? own : frames).slice(0, FINGERPRINT_FRAMES).map((f) => f.replace(/:\d+:\d+(?=\)?$)/, ''));
  return crypto.createHash('sha256').update([where, name, ...top].join('\n')).digest('hex').slice(0, 16);
}

/** One error, ready for a report. `where` may be omitted (a fatal crash). */
export function scrubError(err, where = null, root = INSTALL_ROOT) {
  const name = scrubName(err?.name ?? (err instanceof Error ? 'Error' : typeof err));
  const message = scrubMessage(err?.message ?? (err instanceof Error ? '' : String(err)));
  const frames = scrubStack(err?.stack, root);
  const w = where == null ? null : scrubWhere(where);
  return { where: w, name, message, frames, fingerprint: fingerprint(w ?? '', name, frames) };
}

/**
 * What a scrubbed frame looks like: an optional function name, then a
 * relative path, a `node:` module or a placeholder, then line and column.
 * Never a leading slash or drive letter: that would be an absolute path.
 */
export const FRAME_SHAPE = /^(?:[\w$.<>[\] ]{1,80} \()?(?:<external>|<anonymous>|native|node:[\w/.-]+|(?![a-z]:)[\w@.[\]-][\w@./[\]-]*)(?::\d+:\d+)?\)?$/i;

/** Patterns schema.js re-checks on every free-text field, after scrubbing. */
export const LEAK_CHECKS = PATTERNS.map(([re]) => new RegExp(re.source, re.flags.replace('g', '')));
