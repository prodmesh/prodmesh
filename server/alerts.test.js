// The alert pipeline end to end, below the HTTP layer: health reports become
// signals, the built-in rule waits out its `for`, one alert per condition,
// Slack posted once and edited in place, self-resolving, flap folding, and
// show-live escalation. Against a fake Slack Web API.

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenOnLoopback } from './testServer.js';

process.env.PRODMESH_DATA_DIR = mkdtempSync(join(tmpdir(), 'prodmesh-alerts-'));

const slackCalls = [];
let reactions = []; // what reactions.get reports
process.env.PRODMESH_ALERT_ACK_POLL_MS = '30';
const fakeSlack = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const method = new URL(req.url, 'http://fake').pathname.slice(1);
    const payload = raw ? JSON.parse(raw) : {};
    slackCalls.push({ method, payload });
    res.setHeader('Content-Type', 'application/json');
    if (method === 'chat.postMessage') {
      return res.end(JSON.stringify({ ok: true, channel: payload.channel, ts: `ts-${slackCalls.length}` }));
    }
    if (method === 'reactions.get') return res.end(JSON.stringify({ ok: true, message: { reactions } }));
    if (method === 'users.info') return res.end(JSON.stringify({ ok: true, user: { profile: { display_name: 'Riley' } } }));
    return res.end(JSON.stringify({ ok: true }));
  });
});
process.env.PRODMESH_SLACK_API = (await listenOnLoopback(fakeSlack)).base;
process.env.PRODMESH_SECRET_SLACK_BOTOAUTHTOKEN = 'xoxb-fake';
process.env.PRODMESH_SECRET_SLACK_CHANNEL = 'C-TEST';

const health = await import('./health.js');
const signals = await import('./signals.js');
const rules = await import('./rules.js');
const alerts = await import('./alerts.js');
const producers = await import('./signalProducers.js');
const { getDb } = await import('./db.js');

const PP = 'proPresenter@192.0.2.15:1025'; // north-main's ProPresenter in the default topology
const live = new Set();
const FOR = 40;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Let queued signals write, rules evaluate, `for` timers fire, Slack answer. */
async function settle(ms = FOR + 40) {
  await sleep(ms);
  signals.flushNow();
  await sleep(20);
}
const posts = () => slackCalls.filter((c) => c.method === 'chat.postMessage');
const updates = () => slackCalls.filter((c) => c.method === 'chat.update');

before(() => {
  rules.init({ isRoomLive: (id) => live.has(id), anyLive: () => live.size > 0 });
  producers.initHealthSignals([]);
});
after(() => fakeSlack.close());

beforeEach(async () => {
  await settle(10);
  rules.reset();
  rules.setRulesForTest(rules.BUILT_IN_RULES.map((r) => ({ ...r, condition: { for: FOR } })));
  producers.reset();
  alerts.resetBudget();
  health.reset();
  live.clear();
  slackCalls.length = 0;
  reactions = [];
  getDb().exec('DELETE FROM alerts; DELETE FROM signals;');
});

test('one failed request is not "down"; two are, and are recorded as a signal', async () => {
  health.report(PP, false, 'ECONNREFUSED 192.0.2.15:1025');
  await settle();
  assert.equal(signals.list({ kind: 'integration.down' }).length, 0);

  health.report(PP, false, 'ECONNREFUSED 192.0.2.15:1025');
  await settle();
  const [down] = signals.list({ kind: 'integration.down' });
  assert.ok(down, 'the second consecutive failure is a signal');
  assert.equal(down.roomId, 'north-main');
  assert.equal(down.trust, 'local');
  assert.equal(down.severity, 'error');
  assert.equal(down.summary, 'Main Auditorium · ProPresenter is unreachable');
  assert.doesNotMatch(down.summary, /192\.0\.2/, 'the summary never carries an address');
});

test('a blip that recovers inside `for` raises nothing', async () => {
  health.report(PP, false, 'x');
  health.report(PP, false, 'x');
  signals.flushNow();
  await sleep(5);
  health.report(PP, true);
  await settle();
  assert.equal(alerts.listOpen().length, 0);
  assert.equal(posts().length, 0);
});

test('outside a show: recorded and shown, not sent to Slack', async () => {
  health.report(PP, false, 'x');
  health.report(PP, false, 'x');
  await settle();
  const open = alerts.listOpen();
  assert.equal(open.length, 1);
  assert.equal(open[0].severity, 'warning');
  assert.deepEqual(open[0].roomIds, ['north-main']);
  assert.equal(posts().length, 0, 'a Tuesday outage does not page anyone');
});

test('during a show: critical, ONE Slack post however many failures, then resolved in place', async () => {
  live.add('north-main');
  for (let i = 0; i < 40; i += 1) health.report(PP, false, 'x');
  await settle();
  for (let i = 0; i < 40; i += 1) health.report(PP, false, 'x');
  await settle();

  const open = alerts.listOpen();
  assert.equal(open.length, 1, 'forty failures, one alert');
  assert.equal(open[0].severity, 'critical');
  assert.equal(posts().length, 1, 'and one message');
  assert.match(posts()[0].payload.text, /Main Auditorium · ProPresenter is unreachable/);
  assert.match(posts()[0].payload.text, /a show is live/);

  health.report(PP, true);
  await settle();
  assert.equal(alerts.listOpen().length, 0, 'the fault going away resolves it; nobody confirms a recovery');
  const [last] = alerts.listRecent();
  assert.equal(last.state, 'resolved');
  assert.equal(last.resolveReason, 'recovered');
  assert.equal(posts().length, 1, 'still one message');
  assert.match(updates().at(-1).payload.text, /^:white_check_mark: ~/);
  assert.ok(slackCalls.some((c) => c.method === 'reactions.add'));
});

test('a flapping integration reopens the same alert and edits the same post', async () => {
  live.add('north-main');
  for (let round = 0; round < 4; round += 1) {
    health.report(PP, false, 'x');
    health.report(PP, false, 'x');
    await settle();
    health.report(PP, true);
    await settle(20);
  }
  const all = alerts.listRecent();
  assert.equal(all.length, 1, 'one alert row for one condition');
  assert.equal(all[0].flaps, 3);
  assert.equal(posts().length, 1, 'one Slack post, edited');
  assert.equal(alerts.publicView(all[0]).flapping, true);
});

test('an alert opened before the show escalates and is sent when the show starts', async () => {
  health.report(PP, false, 'x');
  health.report(PP, false, 'x');
  await settle();
  assert.equal(posts().length, 0);

  live.add('north-main');
  signals.emit({ kind: 'show.started', source: 'show', roomId: 'north-main' });
  await settle(20);
  assert.equal(alerts.listOpen()[0].severity, 'critical');
  assert.equal(posts().length, 1);
});

test('another room\'s show does not escalate this room\'s alert', async () => {
  health.report(PP, false, 'x');
  health.report(PP, false, 'x');
  await settle();
  live.add('north-youth');
  signals.emit({ kind: 'show.started', source: 'show', roomId: 'north-youth' });
  await settle(20);
  assert.equal(alerts.listOpen()[0].severity, 'warning');
  assert.equal(posts().length, 0);
});

test('Slack being down is an alert, never a Slack message', async () => {
  live.add('north-main');
  health.report('slack', false, 'x');
  health.report('slack', false, 'x');
  await settle();
  assert.equal(alerts.listOpen().length, 1);
  assert.equal(posts().length, 0);
});

test('a linked server going down never escalates: it interrupts no show here', async () => {
  live.add('north-main');
  health.report('peer:abc', false, 'x');
  health.report('peer:abc', false, 'x');
  await settle();
  const [a] = alerts.listOpen();
  assert.equal(a.severity, 'warning');
  assert.equal(posts().length, 0);
});

test('an alert left open by the last run resolves on the first success after restart', async () => {
  health.report(PP, false, 'x');
  health.report(PP, false, 'x');
  await settle();
  assert.equal(alerts.listOpen().length, 1);
  producers.reset(); // as if the process restarted: nothing remembered in memory
  producers.initHealthSignals(alerts.openSubjects());
  health.reset();
  health.report(PP, true);
  await settle();
  assert.equal(alerts.listOpen().length, 0);
});

test('acknowledging edits the post and names who is on it; a cleared alert cannot be claimed', async () => {
  live.add('north-main');
  health.report(PP, false, 'x');
  health.report(PP, false, 'x');
  await settle();
  const [a] = alerts.listOpen();
  const acked = alerts.acknowledge(a.id, 'Sam <https://evil.example|approve>');
  assert.equal(acked.state, 'acknowledged');
  await settle(20);
  const text = updates().at(-1).payload.text;
  assert.match(text, /:eyes: Sam &lt;https:\/\/evil\.example\|approve&gt; is on it/);
  assert.doesNotMatch(text, /<https:\/\/evil/);

  health.report(PP, true);
  await settle();
  assert.equal(alerts.acknowledge(a.id, 'Sam'), null);
});

test('one escaper: crafted text cannot inject a link or ping the channel', () => {
  const text = alerts.slackText({
    title: 'Booth <https://evil.example|Click to approve> @channel & co',
    state: 'open',
    severity: 'critical',
    firstSeen: Date.now(),
    flaps: 0,
  });
  assert.doesNotMatch(text, /<https:/);
  assert.match(text, /&lt;https:\/\/evil\.example\|Click to approve&gt;/);
  assert.doesNotMatch(text, /@channel\b/);
  assert.match(text, /&amp; co/);
});

test('notification budget: past five posts in the window, the rest are held for one summary', async () => {
  live.add('north-main');
  const keys = Array.from({ length: 8 }, (_, i) => `companion@192.0.2.${40 + i}:8000`);
  // Org-scoped keys (no room uses them) escalate while any show is live.
  for (const k of keys) {
    health.report(k, false, 'x');
    health.report(k, false, 'x');
  }
  await settle();
  assert.equal(alerts.listOpen().length, 8, 'everything is recorded');
  assert.equal(posts().length, 5, 'only five are sent');
});

test('a rule that throws does not stop the others, and is not an outage', async () => {
  const seen = [];
  rules.setRulesForTest([
    { id: 'boom', name: 'boom', match: { kind: 'test.ping' }, actions: [{ type: 'alert', get severity() { throw new Error('boom'); } }] },
    { id: 'ok', name: 'ok', match: { kind: 'test.ping' }, actions: [{ type: 'alert', severity: 'warning' }] },
  ]);
  const off = signals.onBatch((b) => seen.push(...b));
  signals.emit({ kind: 'test.ping', source: 'test', subject: 'x', summary: 'ping' });
  await settle(20);
  off();
  assert.equal(seen.length >= 1, true);
  assert.equal(alerts.listOpen().filter((a) => a.ruleId === 'ok').length, 1);
});

test('a rule never fires on its own action\'s signals, and chains stop at depth 3', async () => {
  rules.setRulesForTest([
    { id: 'echo', name: 'echo', match: { kind: 'alert.raised' }, actions: [{ type: 'alert', severity: 'warning' }] },
    { id: 'seed', name: 'seed', match: { kind: 'test.seed' }, actions: [{ type: 'alert', severity: 'warning' }] },
  ]);
  signals.emit({ kind: 'test.seed', source: 'test', subject: 's', summary: 'seed' });
  await settle(30);
  await settle(30);
  // seed → alert.raised(depth 1) → echo raises → alert.raised(depth 2, cause echo)
  // → echo skips its own. One seed alert, one echo alert, no runaway.
  const open = alerts.listOpen();
  assert.equal(open.filter((a) => a.ruleId === 'seed').length, 1);
  assert.equal(open.filter((a) => a.ruleId === 'echo').length, 1);

  signals.emit({ kind: 'alert.raised', source: 'test', subject: 'deep', cause: { rule: 'other', depth: 3 } });
  await settle(20);
  assert.equal(signals.list({ kind: 'rules.loop_stopped' }).length, 1);
});

test('unauthenticated signals may raise alerts but not drive room-changing actions', () => {
  const rule = { id: 'trap', match: { kind: 'device.trap' }, actions: [{ type: 'alert' }, { type: 'companion.press' }] };
  const forged = { kind: 'device.trap', trust: 'unauthenticated' };
  assert.deepEqual(rules.permitted(rule, forged).map((a) => a.type), ['alert']);
  assert.deepEqual(rules.permitted(rule, { ...forged, trust: 'local' }).map((a) => a.type), ['alert', 'companion.press']);
  assert.deepEqual(
    rules.permitted({ ...rule, acceptUnauthenticated: true }, forged).map((a) => a.type),
    ['alert', 'companion.press'],
    'only a rule that explicitly accepts it',
  );
});

test('👀 on the Slack post claims the issue, by that person, on the record', async () => {
  const auth = await import('./authStore.js');
  live.add('north-main');
  health.report(PP, false, 'x');
  health.report(PP, false, 'x');
  await settle();
  assert.equal(posts().length, 1);
  reactions = [{ name: 'eyes', users: ['U123'], count: 1 }];
  await settle(120);
  const [a] = alerts.listOpen();
  assert.equal(a.state, 'acknowledged');
  assert.equal(a.ackedBy, 'Riley');
  assert.match(updates().at(-1).payload.text, /:eyes: Riley is on it/);
  assert.ok(auth.listAudit(20).some((r) => r.action === 'alerts.acknowledge'));
});

test('a service report gets the issues that overlapped it in that room, with time to claim', async () => {
  const t0 = Date.now();
  live.add('north-main');
  health.report(PP, false, 'x');
  health.report(PP, false, 'x');
  health.report('planningCenter', false, 'x');
  health.report('planningCenter', false, 'x');
  health.report('peer:far', false, 'x');
  health.report('peer:far', false, 'x');
  await settle();
  const [pp] = alerts.listOpen().filter((a) => a.subject === PP);
  alerts.acknowledge(pp.id, 'Sam');

  const issues = alerts.during('north-main', t0, Date.now());
  assert.deepEqual(issues.map((i) => i.title).sort(), [
    'Main Auditorium · ProPresenter is unreachable',
    'Planning Center is unreachable',
  ], 'its own room and the whole org, never a linked server');
  assert.ok(issues.find((i) => i.title.includes('ProPresenter')).claimedAfterMs >= 0);
  assert.equal(alerts.during('north-youth', t0).length, 1, 'another room sees only the org-wide one');
  assert.equal(alerts.during('north-main', Date.now() + 60_000, Date.now() + 120_000).length, 2, 'still open, so it overlaps later too');
});
