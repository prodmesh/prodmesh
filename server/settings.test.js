import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point the store at a throwaway dir BEFORE importing settings.
process.env.PRODMESH_DATA_DIR = mkdtempSync(join(tmpdir(), 'prodmesh-settings-'));
const settings = await import('./settings.js');

test('PIN hashing verifies correct PINs and rejects wrong ones', () => {
  assert.equal(settings.isAdminSetupNeeded(), true);
  settings.setPins({ admin: 'admin1234', override: '9999' });
  assert.equal(settings.isAdminSetupNeeded(), false);
  assert.equal(settings.verifyOverride('9999'), true);
  assert.equal(settings.verifyOverride(''), false);

  // The admin PIN is no longer verified here — it is the built-in account's
  // PIN, and this file only STORES the hash. Same format both sides (scrypt,
  // salt:hash in hex), which is what lets authStore project it verbatim onto
  // that account rather than making anyone re-enter it.
  assert.match(settings.adminPinHash(), /^[0-9a-f]{32}:[0-9a-f]{64}$/);
});

test('an admin PIN change tells whoever is listening', () => {
  // server/index.js is the listener, and what it does with this is refresh the
  // `admin` account. Registering it there rather than importing authStore here
  // keeps a module about a FILE from depending on the database.
  const seen = [];
  settings.onAdminPinChange((hash) => seen.push(hash));

  settings.setPins({ override: '1111' });
  assert.deepEqual(seen, [], 'the override PIN is not the admin PIN');

  settings.setPins({ admin: 'changed456' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0], settings.adminPinHash());

  settings.setPins({ admin: '' });
  assert.deepEqual(seen.at(-1), null, 'cleared, so there is nothing to project');
  settings.setPins({ admin: 'admin1234' }); // put it back for the tests below
});

test('clearing the override PIN disables it', () => {
  settings.setPins({ override: '' });
  assert.equal(settings.isOverrideSet(), false);
  settings.setPins({ override: '4321' });
  assert.equal(settings.isOverrideSet(), true);
});

test('computeProtection is active only inside the window', () => {
  const now = new Date(2026, 6, 1, 9, 30); // fixed instant
  settings.setSchedules({
    r1: [{ id: 'w', label: 'Service', days: [now.getDay()], start: '09:00', end: '10:00', lock: ['standby'] }],
  });
  const inside = settings.computeProtection('r1', now);
  assert.equal(inside.active, true);
  assert.deepEqual(inside.lockedModes, ['standby']);
  assert.equal(inside.enforced, true); // override PIN is set

  const outside = settings.computeProtection('r1', new Date(2026, 6, 1, 11, 0));
  assert.equal(outside.active, false);
});

test('isModeLocked only locks listed modes during the window', () => {
  const now = new Date(2026, 6, 1, 9, 30);
  assert.equal(settings.isModeLocked('r1', 'standby', now), true);
  assert.equal(settings.isModeLocked('r1', 'sunday', now), false);
  assert.equal(settings.isModeLocked('r1', 'standby', new Date(2026, 6, 1, 11, 0)), false);
});

test('locks are not enforced without an override PIN', () => {
  settings.setPins({ override: '' });
  const now = new Date(2026, 6, 1, 9, 30);
  assert.equal(settings.computeProtection('r1', now).enforced, false);
  assert.equal(settings.isModeLocked('r1', 'standby', now), false);
});

// The admin's bearer token used to be an in-memory Map here. It is a row in
// user_sessions now (authStore), so its test lives with the rest of session
// handling — see authStore.test.js and api.test.js.


test('integrations are enabled by default and can be disabled individually', () => {
  assert.equal(settings.getIntegrationSettings().resi, true);
  assert.equal(settings.getIntegrationSettings().obs, true);
  const updated = settings.setIntegrationEnabled('resi', false);
  assert.equal(updated.resi, false);
  assert.equal(settings.getPublicSettings().integrations.resi, false);
  assert.throws(() => settings.setIntegrationEnabled('not-an-integration', false), /Unknown integration/);
});
