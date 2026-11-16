// ADR 0019, "The live show comes first", as a test: a storm of signals while a
// show is live must not stall the event loop that serves the show's SSE
// stream, nor delay the show manager's poll.
//
// The storm is deliberately worse than any building produces: integrations
// flapping across forty devices (each flap an alert write and, with a show
// live, an escalation), plus thousands of raw emits in tight bursts, enough to
// overflow the queue. A real service is about thirty item starts.
//
// The budget is set from a measured baseline (see BUDGET below), not a guess:
// on an M-series Mac this storm measured a worst stall of 10–17 ms, p99 under
// 10 ms, and the 800 ms poll slipping at most 5 ms (2026-11-14).
// The ceiling sits well above that so a loaded CI runner does not flake, and
// well below what a person would see as a stutter on a timer display.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';

process.env.PRODMESH_DATA_DIR = mkdtempSync(join(tmpdir(), 'prodmesh-signals-load-'));

const health = await import('./health.js');
const signals = await import('./signals.js');
const rules = await import('./rules.js');
const producers = await import('./signalProducers.js');

// Worst single stall allowed during the storm, in ms. About six times the
// measured worst; an 800 ms poll that slips by this much is still invisible.
const BUDGET_MAX_MS = 100;
const POLL_MS = 800;
const STORM_MS = 3000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a signal storm during a live show stays inside the event-loop budget', async () => {
  rules.init({ isRoomLive: () => true, anyLive: () => true });
  rules.setRulesForTest(rules.BUILT_IN_RULES.map((r) => ({ ...r, condition: { for: 50 } })));
  producers.initHealthSignals([]);

  // A stand-in for the show manager's poll: how late does each tick land?
  let lastTick = performance.now();
  let worstPollLateness = 0;
  const poll = setInterval(() => {
    const now = performance.now();
    worstPollLateness = Math.max(worstPollLateness, now - lastTick - POLL_MS);
    lastTick = now;
  }, POLL_MS);

  const h = monitorEventLoopDelay({ resolution: 5 });
  h.enable();

  const keys = Array.from({ length: 40 }, (_, i) => `companion@192.0.2.${100 + i}:8000`);
  const until = performance.now() + STORM_MS;
  let round = 0;
  while (performance.now() < until) {
    // Flap every device: down (two failures), and back half the time.
    for (const k of keys) {
      health.report(k, false, 'x');
      health.report(k, false, 'x');
      if (round % 2) health.report(k, true);
    }
    // And a burst of raw emits, past the queue's bound.
    for (let i = 0; i < 400; i += 1) {
      signals.emit({ kind: 'show.item.started', source: 'show', roomId: 'north-main', summary: `item ${i}` });
    }
    round += 1;
    await sleep(10);
  }
  await sleep(200); // let the backlog drain
  h.disable();
  clearInterval(poll);

  const maxMs = h.max / 1e6;
  const p99Ms = h.percentile(99) / 1e6;
  console.log(`[load] rounds=${round} loop max=${maxMs.toFixed(1)}ms p99=${p99Ms.toFixed(1)}ms poll late=${worstPollLateness.toFixed(1)}ms`);

  assert.ok(signals.list({ limit: 1 }).length > 0, 'the storm was recorded');
  assert.ok(maxMs < BUDGET_MAX_MS, `worst event-loop stall ${maxMs.toFixed(1)}ms exceeds ${BUDGET_MAX_MS}ms`);
  assert.ok(worstPollLateness < BUDGET_MAX_MS, `the show poll slipped ${worstPollLateness.toFixed(1)}ms`);
  rules.reset();
});
