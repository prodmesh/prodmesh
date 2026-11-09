// The shared credential throttle, on its own: the escalation schedule and the
// bound on its memory. The doors that use it are tested through HTTP in
// apiSecurity.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lockoutMs, lockedFor, recordFailure, clearFailures, refuseIfLocked, counterCount } from './credentialThrottle.js';

test('lockout escalates: none, a minute, fifteen minutes, an hour', () => {
  assert.equal(lockoutMs(4, 5), 0);
  assert.equal(lockoutMs(5, 5), 60_000);
  assert.equal(lockoutMs(9, 5), 60_000);
  assert.equal(lockoutMs(10, 5), 15 * 60_000);
  assert.equal(lockoutMs(20, 5), 60 * 60_000);
});

test('a lock on any key refuses the request, and clearing releases it', () => {
  const keys = [{ k: 'unit:a', after: 2 }, { k: 'unit:b', after: 100 }];
  recordFailure(keys);
  assert.equal(lockedFor(keys), 0);
  recordFailure(keys);
  assert.ok(lockedFor(keys) > 0, 'the stricter key locks the pair');

  let status = null;
  let sent = null;
  const res = { status(s) { status = s; return this; }, json(b) { sent = b; return this; } };
  assert.equal(refuseIfLocked(res, keys), true);
  assert.equal(status, 429);
  assert.equal(sent.error, 'temporarily_locked');

  clearFailures(keys);
  assert.equal(lockedFor(keys), 0);
  assert.equal(refuseIfLocked(res, keys), false);
});

test('the counter map cannot grow without bound', () => {
  // A source rotating keys (one per guess) must not turn the throttle into a
  // memory leak. Unlocked entries are evicted once the cap is reached.
  for (let i = 0; i < 6000; i++) recordFailure([{ k: `spray:${i}`, after: 50 }]);
  assert.ok(counterCount() <= 5000, `held ${counterCount()} counters`);
});
