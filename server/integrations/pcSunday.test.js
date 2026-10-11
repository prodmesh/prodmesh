import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.PRODMESH_DATA_DIR = mkdtempSync(join(tmpdir(), 'prodmesh-pcsunday-'));
const secrets = await import('../secrets.js');
const pco = await import('./planningCenter.js');
secrets.setSecrets({ 'planningCenter.appId': 'test-app', 'planningCenter.secret': 'test-secret' });
const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; pco.clearCache(); });
test('Sunday discovery uses date filters rather than future-only plans', async () => {
  let requested;
  globalThis.fetch = async url => {
    requested = new URL(url);
    return { ok: true, json: async () => ({ data: [{ id: '100', attributes: { sort_date: '2026-10-11T12:00:00Z' } }], meta: { total_count: 1 } }) };
  };
  const plans = await pco.getPlansForSunday({ id: '10', name: 'Sunday' }, '2026-10-11');
  assert.equal(plans[0].id, '100');
  assert.equal(requested.searchParams.get('filter'), 'after,before');
  assert.equal(requested.searchParams.get('after'), '2026-10-09T00:00:00.000Z');
  assert.equal(requested.searchParams.get('before'), '2026-10-13T00:00:00.000Z');
});
test('team paging retains person IDs from included resources past the first hundred', async () => {
  const calls = [];
  globalThis.fetch = async url => {
    const parsed = new URL(url); calls.push(parsed);
    const offset = Number(parsed.searchParams.get('offset'));
    const data = Array.from({ length: offset === 0 ? 100 : 1 }, (_, i) => ({ id: String(offset+i), attributes: { name: `Volunteer ${offset+i}` }, relationships: { person: { data: { type: 'Person', id: String(900000+offset+i) } } } }));
    return { ok: true, json: async () => ({ data, meta: { total_count: 101 }, included: [] }) };
  };
  const team = await pco.getPlanTeamMembers({ id: '10' }, '100');
  assert.equal(team.length, 101); assert.equal(team.at(-1).personId, '900100');
  assert.equal(calls.length, 2); assert.equal(calls[1].searchParams.get('offset'), '100');
});
