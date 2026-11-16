// ─────────────────────────────────────────────────────────────────────────────
//  ALERTS  —  the state the `alert` action keeps (ADRs 0015, 0019).
//
//  A signal is a fact; an alert is a condition currently believed wrong. Forty
//  signals from a flapping ProPresenter update ONE alert row and, at most, one
//  Slack message, edited in place as the alert moves:
//
//      open ─(someone says "on it")→ acknowledged
//        └──────────(the fault goes away)──────────→ resolved
//
//  A device alert resolves ITSELF. A help request is closed by a person,
//  because only a person knows whether help arrived; a fault is closed by the
//  fault going away. Nobody should have to confirm a recovery at 10:42 on a
//  Sunday.
//
//  NOISE IS THE FAILURE MODE. A monitor that cries wolf on its first Sunday
//  gets muted, and a muted monitor is worse than none, because everyone then
//  believes something is watching. So:
//    • the rule's `for` condition (rules.js) means nothing raises on a blip;
//    • a condition that clears and comes back within FLAP_WINDOW reopens the
//      SAME alert and edits the same Slack post, rather than posting again;
//    • recording is not notifying. By default an alert notifies only when it
//      matters NOW: a show is live in a room it affects. The same outage on a
//      Tuesday afternoon is recorded and shown, not sent;
//    • a notification budget: past BUDGET posts in BUDGET_WINDOW, the rest are
//      counted into one summary message.
//
//  Slack never holds anything up. Posting is fire-and-forget from the
//  evaluator's point of view; a slow or dead Slack delays nothing but itself.
// ─────────────────────────────────────────────────────────────────────────────

import { getDb } from './db.js';
import * as hub from './streamHub.js';
import * as slack from './integrations/slack.js';
import * as signals from './signals.js';
import { unexpected } from './health.js';
import * as auth from './authStore.js';

export const FLAP_WINDOW = 10 * 60_000;
export const FLAPPING_AT = 3; // reopenings within the window before we say "flapping"
const BUDGET = 5;
const BUDGET_WINDOW = 10 * 60_000;
const RECENT_LIMIT = 50;

export const ALERTS_TOPIC = 'alerts';

const json = (v) => (v == null ? null : JSON.stringify(v));
const parse = (s) => (s ? JSON.parse(s) : null);

function row(r) {
  if (!r) return null;
  return {
    id: r.id,
    ruleId: r.rule_id,
    dedupeKey: r.dedupe_key,
    subject: r.subject,
    roomIds: parse(r.room_ids) ?? [],
    severity: r.severity,
    state: r.state,
    title: r.title,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    count: r.count,
    flaps: r.flaps,
    ackedBy: r.acked_by,
    ackedAt: r.acked_at,
    resolvedAt: r.resolved_at,
    resolveReason: r.resolve_reason,
    notifiedAt: r.notified_at,
    slack: r.slack_ts ? { channel: r.slack_channel, ts: r.slack_ts } : null,
  };
}

/**
 * What may leave the server without a permission (the topic, the banner). A
 * FIXED set of fields, built rather than filtered, for the reason
 * roomHealth.publicHealth gives: a denylist leaks the day a field is added.
 * The subject is left out: for an integration it is "host:port".
 */
export function publicView(a) {
  return {
    id: a.id,
    title: a.title,
    // Which kind of thing, never which address: "proPresenter", not its key.
    integration: a.subject ? String(a.subject).split(/[@:]/)[0] : null,
    severity: a.severity,
    state: a.state,
    roomIds: a.roomIds,
    firstSeen: a.firstSeen,
    lastSeen: a.lastSeen,
    count: a.count,
    flapping: a.flaps >= FLAPPING_AT,
    ackedBy: a.ackedBy,
    ackedAt: a.ackedAt,
    resolvedAt: a.resolvedAt,
  };
}

export function get(id) {
  return row(getDb().prepare('SELECT * FROM alerts WHERE id = ?').get(id));
}

/** Open and acknowledged alerts, newest activity first. */
export function listOpen() {
  return getDb()
    .prepare("SELECT * FROM alerts WHERE state != 'resolved' ORDER BY last_seen DESC")
    .all()
    .map(row);
}

/** Everything, newest activity first, for history. */
export function listRecent({ limit = RECENT_LIMIT, before = null } = {}) {
  const n = Math.max(1, Math.min(200, Number(limit) || RECENT_LIMIT));
  return getDb()
    .prepare(`SELECT * FROM alerts ${before != null ? 'WHERE id < ?' : ''} ORDER BY id DESC LIMIT ${n}`)
    .all(...(before != null ? [Number(before)] : []))
    .map(row);
}

/**
 * Issues that overlapped a service in a room, for its report: anything open at
 * some point between `from` and `to` that affected that room, or every room
 * (Planning Center down). A linked server's outage interrupted nothing here.
 * The public view plus when it was claimed, which is the number that tells a
 * team whether the monitor is working for them.
 */
export function during(roomId, from, to = Date.now()) {
  return getDb()
    .prepare('SELECT * FROM alerts WHERE first_seen <= ? AND (resolved_at IS NULL OR resolved_at >= ?) ORDER BY first_seen')
    .all(to, from)
    .map(row)
    .filter((a) => !String(a.subject ?? '').startsWith('peer:'))
    .filter((a) => a.roomIds.length === 0 || a.roomIds.includes(roomId))
    .map((a) => ({ ...publicView(a), claimedAfterMs: a.ackedAt ? a.ackedAt - a.firstSeen : null }));
}

/** Subjects with an alert still open, so a restart can still resolve them. */
export const openSubjects = () => listOpen().map((a) => a.subject).filter(Boolean);

function publish() {
  hub.publish(ALERTS_TOPIC, listOpen().map(publicView));
}

hub.registerTopic(ALERTS_TOPIC, {
  // Seeing open alerts needs no permission (ADR 0015): a red banner on a booth
  // display is the point. The topic is a STATE snapshot, the whole open list,
  // so the hub's conflation under backpressure loses nothing that matters.
  snapshot: () => listOpen().map(publicView),
});

// ── Slack ─────────────────────────────────────────────────────────────────────

const clock = (ts) => new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

function duration(ms) {
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

/** The whole message for an alert's current state. Edited in place as it moves. */
export function slackText(a) {
  const title = slack.escapeText(a.title);
  if (a.state === 'resolved') {
    return `:white_check_mark: ~${title}~\nBack at ${clock(a.resolvedAt)}, after ${duration(a.resolvedAt - a.firstSeen)}.`;
  }
  const lines = [`${a.severity === 'critical' ? ':rotating_light:' : ':warning:'} *${title}*`];
  lines.push(`Since ${clock(a.firstSeen)}${a.severity === 'critical' ? ' · a show is live' : ''}.`);
  if (a.flaps >= FLAPPING_AT) lines.push(`Flapping: it has come back and dropped again ${a.flaps} times.`);
  if (a.state === 'acknowledged') lines.push(`:eyes: ${slack.escapeText(a.ackedBy ?? 'Someone')} is on it.`);
  return lines.join('\n');
}

const budget = { windowStart: 0, sent: 0, suppressed: 0, timer: null };

function spend() {
  const now = Date.now();
  if (now - budget.windowStart >= BUDGET_WINDOW) {
    budget.windowStart = now;
    budget.sent = 0;
  }
  if (budget.sent < BUDGET) {
    budget.sent += 1;
    return true;
  }
  budget.suppressed += 1;
  if (!budget.timer) {
    budget.timer = setTimeout(postSuppressed, budget.windowStart + BUDGET_WINDOW - now);
    budget.timer.unref?.();
  }
  return false;
}

function postSuppressed() {
  budget.timer = null;
  const n = budget.suppressed;
  budget.suppressed = 0;
  if (!n || !slack.isConfigured()) return;
  slack
    .postMessage(`:warning: ${n} more alert${n === 1 ? '' : 's'} were not posted here. Open ProdMesh to see them all.`)
    .catch(() => {}); // recorded in health by the client
}

const isSlackSubject = (a) => String(a.subject ?? '') === 'slack';

/** Post this alert, or edit its post if it has one. Never throws, never awaited by the caller. */
function syncSlack(a, { post = false } = {}) {
  if (!slack.isConfigured() || isSlackSubject(a)) return;
  const db = getDb();
  if (a.slack) {
    slack.updateMessage(a.slack.channel, a.slack.ts, slackText(a)).catch(() => {});
    if (a.state === 'resolved') slack.addReaction(a.slack.channel, a.slack.ts).catch(() => {});
    return;
  }
  if (!post || a.state === 'resolved' || !spend()) return;
  // Claim it before the request, so a second raise during the round trip
  // edits rather than posts twice.
  db.prepare('UPDATE alerts SET notified_at = ? WHERE id = ?').run(Date.now(), a.id);
  slack
    .postMessage(slackText(a))
    .then((posted) => {
      db.prepare('UPDATE alerts SET slack_channel = ?, slack_ts = ? WHERE id = ?').run(posted.channel, posted.ts, a.id);
      startAckPolling();
      // It may have moved on while the post was in flight.
      const now = get(a.id);
      if (now && now.state !== a.state) syncSlack(now);
    })
    .catch(() => {
      db.prepare('UPDATE alerts SET notified_at = NULL WHERE id = ?').run(a.id);
    });
}

// ── 👀 in Slack means "on it" ─────────────────────────────────────────────────
//  The same gesture the help button taught (assistance.js): a tech on their
//  phone in the hallway should not need a browser to say "mine". While any
//  posted issue is unclaimed, its reactions are read every ACK_POLL_MS; the
//  first 👀 claims it, by that person's Slack name. Polling stops when nothing
//  is waiting, so a quiet week costs no requests at all.

const ACK_EMOJI = 'eyes';
const ACK_POLL_MS = Number(process.env.PRODMESH_ALERT_ACK_POLL_MS ?? 10_000);
let ackTimer = null;

const unclaimedPosts = () => listOpen().filter((a) => a.state === 'open' && a.slack);

async function pollAcks() {
  for (const a of unclaimedPosts()) {
    try {
      const reactions = await slack.getMessageReactions(a.slack.channel, a.slack.ts);
      const eyes = reactions.find((r) => r.name === ACK_EMOJI);
      if (!eyes?.users?.length) continue;
      const name = (await slack.userName(eyes.users[0])) ?? 'Someone in Slack';
      const claimed = acknowledge(a.id, name);
      if (claimed?.state === 'acknowledged') {
        auth.audit({
          action: 'alerts.acknowledge',
          resourceType: 'alert',
          resourceId: String(a.id),
          result: 'allowed',
          details: { title: a.title, via: 'slack', slackUser: eyes.users[0], name },
        });
      }
    } catch {
      /* recorded in health by the Slack client; try again next tick */
    }
  }
  if (!unclaimedPosts().length) stopAckPolling();
}

function startAckPolling() {
  if (ackTimer || !slack.isConfigured()) return;
  ackTimer = setInterval(() => { pollAcks().catch((err) => unexpected('alerts', err)); }, ACK_POLL_MS);
  ackTimer.unref?.();
}

function stopAckPolling() {
  if (ackTimer) clearInterval(ackTimer);
  ackTimer = null;
}

/** Boot: resume watching any posted, unclaimed issue left open by the last run. */
export function resumeAckPolling() {
  if (unclaimedPosts().length) startAckPolling();
}

// ── The action ────────────────────────────────────────────────────────────────

function dedupeKeyFor(rule, signal) {
  return `${rule.id}|${signal.subject ?? signal.roomId ?? ''}`;
}

function latestFor(key) {
  return row(getDb().prepare('SELECT * FROM alerts WHERE dedupe_key = ? ORDER BY id DESC LIMIT 1').get(key));
}

function causedSignal(kind, a, rule, signal) {
  signals.emit({
    kind,
    source: 'alerts',
    roomId: a.roomIds.length === 1 ? a.roomIds[0] : null,
    subject: a.subject,
    severity: kind === 'alert.resolved' ? null : a.severity,
    summary: a.title,
    data: { alertId: a.id, state: a.state },
    cause: { rule: rule?.id ?? a.ruleId, depth: (signal?.cause?.depth ?? 0) + 1 },
  });
}

/**
 * The `alert` action. `ctx.live(roomIds, scope)` says whether a show is live
 * somewhere this alert affects, which is what turns a recorded warning into a
 * notified, critical one.
 */
export function raise(rule, action, signal, ctx) {
  const db = getDb();
  const key = dedupeKeyFor(rule, signal);
  const now = Date.now();
  const roomIds = signal.data?.roomIds ?? (signal.roomId ? [signal.roomId] : []);
  const scope = signal.data?.scope ?? (roomIds.length ? 'room' : 'org');
  const esc = action.escalate;
  const live = Boolean(esc && esc.during === 'show-live' && ctx.live(roomIds, scope));
  const severity = live ? esc.severity : action.severity;
  const notify = live ? esc.notify === 'slack' : action.notify === 'slack';

  const prev = latestFor(key);
  let a;
  if (prev && prev.state !== 'resolved') {
    db.prepare('UPDATE alerts SET last_seen = ?, count = count + 1 WHERE id = ?').run(now, prev.id);
    a = get(prev.id);
  } else if (prev && now - prev.resolvedAt < FLAP_WINDOW) {
    // Back within the flap window: the same condition, not a new one.
    db.prepare(
      `UPDATE alerts SET state = 'open', last_seen = ?, count = count + 1, flaps = flaps + 1,
         resolved_at = NULL, resolve_reason = NULL, acked_by = NULL, acked_at = NULL,
         severity = CASE WHEN ? = 'critical' THEN 'critical' ELSE severity END
       WHERE id = ?`,
    ).run(now, severity, prev.id);
    a = get(prev.id);
    causedSignal('alert.raised', a, rule, signal);
  } else {
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO alerts (rule_id, dedupe_key, subject, room_ids, severity, state, title, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
      )
      .run(rule.id, key, signal.subject ?? null, json(roomIds), severity, signal.summary ?? rule.name, signal.ts ?? now, now);
    a = get(Number(lastInsertRowid));
    causedSignal('alert.raised', a, rule, signal);
  }
  syncSlack(a, { post: notify });
  publish();
  return a;
}

/** The condition cleared. Returns the resolved alert, or null if none was open. */
export function resolve(rule, signal, reason = 'recovered') {
  const prev = latestFor(dedupeKeyFor(rule, signal));
  if (!prev || prev.state === 'resolved') return null;
  const now = Date.now();
  getDb()
    .prepare("UPDATE alerts SET state = 'resolved', resolved_at = ?, resolve_reason = ?, last_seen = ? WHERE id = ?")
    .run(now, signal.data?.removed ? 'no longer configured' : reason, now, prev.id);
  const a = get(prev.id);
  causedSignal('alert.resolved', a, rule, signal);
  syncSlack(a);
  publish();
  return a;
}

/**
 * A show started: anything already open in a room it now affects becomes
 * critical and is sent, once. "ProPresenter has been down since 9:12" matters
 * a great deal more at 10:00 than it did at 9:12.
 */
export function escalateFor(ruleById, ctx) {
  for (const a of listOpen()) {
    const rule = ruleById(a.ruleId);
    const esc = rule?.actions?.find((x) => x.type === 'alert')?.escalate;
    if (!esc || esc.during !== 'show-live' || a.severity === esc.severity) continue;
    const scope = a.roomIds.length ? 'room' : String(a.subject ?? '').startsWith('peer:') ? 'peer' : 'org';
    if (!ctx.live(a.roomIds, scope)) continue;
    getDb().prepare('UPDATE alerts SET severity = ? WHERE id = ?').run(esc.severity, a.id);
    const now = get(a.id);
    syncSlack(now, { post: esc.notify === 'slack' });
  }
  publish();
}

/** Somebody is on it. Returns the alert, or null if there is nothing open to claim. */
export function acknowledge(id, byName) {
  const a = get(id);
  if (!a || a.state !== 'open') return a && a.state === 'acknowledged' ? a : null;
  getDb()
    .prepare("UPDATE alerts SET state = 'acknowledged', acked_by = ?, acked_at = ? WHERE id = ?")
    .run(String(byName ?? 'Someone').slice(0, 80), Date.now(), id);
  const next = get(id);
  try {
    syncSlack(next);
  } catch (err) {
    unexpected('alerts', err);
  }
  publish();
  return next;
}

/** Tests only. */
export function resetBudget() {
  stopAckPolling();
  if (budget.timer) clearTimeout(budget.timer);
  Object.assign(budget, { windowStart: 0, sent: 0, suppressed: 0, timer: null });
}
