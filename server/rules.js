// ─────────────────────────────────────────────────────────────────────────────
//  RULES  —  what a signal means, and what to do about it (ADR 0019).
//
//  Rules are DATA, even while only this file writes them. 1.6 stores user
//  rules and gives them a UI, and it should do that by adding rows, not by
//  rewriting this evaluator. So a built-in rule has exactly the shape a stored
//  one will:
//
//    { id, name,
//      match:     { kind, source?, roomId? },        which signals start it
//      condition: { for?: ms },                       still true this long later
//      resolveOn: { kind },                           same subject: it cleared
//      actions:   [{ type: 'alert', severity, notify?, escalate? }] }
//
//  1.5 has one action type, `alert` (alerts.js). Room-changing actions arrive
//  later and will go through the same permission, lockout and audit path as a
//  person (ADR 0019, "Actions go through the same door as a person").
//
//  THE LIVE SHOW COMES FIRST. Batches arrive after they are written, and are
//  evaluated SLICE signals at a time with a yield between, so a backlog from a
//  storm cannot hold the event loop.
//
//  LOOPS ARE BOUNDED. A signal an action caused carries `cause: { rule, depth }`.
//  A rule never fires on its own action's signals, and nothing is evaluated at
//  depth MAX_DEPTH; the stop is recorded as a signal itself.
//
//  TRUST. An `unauthenticated` signal (a forged trap is two lines of code) may
//  raise an alert, but will not drive an action that changes a room unless the
//  rule says `acceptUnauthenticated: true`. Only `local` signals exist in 1.5.
// ─────────────────────────────────────────────────────────────────────────────

import * as signals from './signals.js';
import * as alerts from './alerts.js';
import { unexpected } from './health.js';

export const MAX_DEPTH = 3;
const SLICE = 50;

/** Actions that cannot change anything in a room. */
const OBSERVE_ONLY = new Set(['alert']);

export const BUILT_IN_RULES = [
  {
    id: 'integration-unreachable',
    name: 'An integration is unreachable',
    builtIn: true,
    match: { kind: 'integration.down' },
    // 30 seconds of being down, on top of the two failed requests that made it
    // "down" at all. A ProPresenter restart between songs is not an incident.
    condition: { for: 30_000 },
    resolveOn: { kind: 'integration.up' },
    actions: [
      {
        type: 'alert',
        severity: 'warning',
        // Recorded and shown always; sent to Slack only when it can interrupt
        // a service. Escalates later if a show starts while it is still open.
        escalate: { during: 'show-live', severity: 'critical', notify: 'slack' },
      },
    ],
  },
];

let rules = BUILT_IN_RULES;
const byId = (id) => rules.find((r) => r.id === id) ?? null;

const pending = new Map(); // `${rule.id}|${subject}` → timeout, for `condition.for`
const work = [];
let draining = false;
let ctx = { live: () => false };

const subjectKey = (rule, s) => `${rule.id}|${s.subject ?? s.roomId ?? ''}`;

function matches(m, s) {
  if (!m) return false;
  if (m.kind && m.kind !== s.kind) return false;
  if (m.source && m.source !== s.source) return false;
  if (m.roomId && m.roomId !== s.roomId) return false;
  return true;
}

/** The actions a rule may take for this signal, after the trust check. */
export function permitted(rule, s) {
  if (s.trust !== 'unauthenticated' || rule.acceptUnauthenticated) return rule.actions;
  return rule.actions.filter((a) => OBSERVE_ONLY.has(a.type));
}

function act(rule, s) {
  for (const action of permitted(rule, s)) {
    if (action.type === 'alert') alerts.raise(rule, action, s, ctx);
  }
}

function evaluate(s) {
  // First: the guard's own record is never evaluated, or it would trip the
  // guard again and record itself forever.
  if (s.kind === 'rules.loop_stopped') return;
  const depth = s.cause?.depth ?? 0;
  if (depth >= MAX_DEPTH) {
    signals.emit({
      kind: 'rules.loop_stopped',
      source: 'rules',
      severity: 'warning',
      summary: `Stopped a chain of automations ${depth} steps deep`,
      data: { kind: s.kind, rule: s.cause?.rule ?? null },
      cause: { rule: null, depth: depth + 1 },
    });
    return;
  }

  if (s.kind === 'show.started') alerts.escalateFor(byId, ctx);

  for (const rule of rules) {
    if (s.cause?.rule === rule.id) continue;
    try {
      if (rule.resolveOn && matches(rule.resolveOn, s)) {
        const k = subjectKey(rule, s);
        clearTimeout(pending.get(k));
        pending.delete(k);
        alerts.resolve(rule, s);
      }
      if (!matches(rule.match, s)) continue;
      const wait = rule.condition?.for ?? 0;
      if (!wait) {
        act(rule, s);
        continue;
      }
      const k = subjectKey(rule, s);
      if (pending.has(k)) continue; // already waiting on the first one
      const t = setTimeout(() => {
        pending.delete(k);
        try {
          act(rule, s);
        } catch (err) {
          unexpected(`rule ${rule.id}`, err);
        }
      }, wait);
      t.unref?.();
      pending.set(k, t);
    } catch (err) {
      // Our bug, not the church's outage, and one rule's bug must not stop
      // the others from seeing this signal.
      unexpected(`rule ${rule.id}`, err);
    }
  }
}

function drain() {
  const slice = work.splice(0, SLICE);
  for (const s of slice) evaluate(s);
  if (work.length) setImmediate(drain);
  else draining = false;
}

function onBatch(batch) {
  work.push(...batch);
  if (!draining) {
    draining = true;
    setImmediate(drain);
  }
}

let unsubscribe = null;

/**
 * Start evaluating. `live(roomIds, scope)` says whether a show is live where a
 * signal applies: in one of `roomIds`, or anywhere for scope 'org'. Never for
 * scope 'peer': a linked server's outage interrupts no show here.
 */
export function init({ isRoomLive, anyLive }) {
  ctx = {
    live: (roomIds, scope) => {
      if (scope === 'peer') return false;
      if (scope === 'org' || !roomIds?.length) return anyLive();
      return roomIds.some((id) => isRoomLive(id));
    },
  };
  unsubscribe?.();
  unsubscribe = signals.onBatch(onBatch);
}

/** Tests only: swap the rule set, or restore the built-ins. */
export function setRulesForTest(next = BUILT_IN_RULES) {
  rules = next;
}

/** Tests only. */
export function reset() {
  for (const t of pending.values()) clearTimeout(t);
  pending.clear();
  work.length = 0;
  draining = false;
  rules = BUILT_IN_RULES;
}

/** Tests only: is anything still waiting to be evaluated? */
export const idle = () => !draining && work.length === 0;
