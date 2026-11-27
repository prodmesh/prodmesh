// The scrubber is the privacy boundary of a telemetry report (ADR 0022 §4).
// Each case below is something that must not leave the building, in the shape
// it actually arrives in. Addresses are TEST-NET-1 and names are fictional,
// because this file ships in the Docker image like everything in server/.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scrubMessage, scrubName, scrubWhere, scrubStack, scrubError, fingerprint, LEAK_CHECKS, FRAME_SHAPE, MESSAGE_MAX,
} from './scrub.js';

const ROOT = '/Users/booth-admin/prodmesh';
const leaks = (s) => LEAK_CHECKS.filter((re) => re.test(s));

test('addresses, URLs, emails, ids, paths and LAN hostnames are replaced', () => {
  const cases = [
    ['connect ECONNREFUSED 192.0.2.15:1025', 'connect ECONNREFUSED <ip>'],
    ['request to http://192.0.2.15:1025/v1/status/slide failed', 'request to <url> failed'],
    ['no user volunteer@example.org', 'no user <email>'],
    ['show 1f0e4a1c-0b6f-4c8e-9a2d-3b5c7d9e1f20 missing', 'show <uuid> missing'],
    ['getaddrinfo ENOTFOUND booth-mac.local', 'getaddrinfo ENOTFOUND <host>'],
    ['bind fe80::1c2b:3a4d:5e6f:7081 failed', 'bind <ip> failed'],
    ["ENOENT: no such file, open '/Users/booth-admin/Library/prodmesh/x.json'", "ENOENT: no such file, open '…'"],
    ['EACCES /home/srivera/prodmesh/data/settings.json', 'EACCES <path>'],
    ['EPERM C:\\Users\\srivera\\AppData\\Roaming\\ProdMesh\\x', 'EPERM <path>'],
    ['plan 81234567 not found', 'plan <n> not found'],
  ];
  for (const [input, want] of cases) {
    const got = scrubMessage(input);
    assert.equal(got, want, input);
    assert.deepEqual(leaks(got), [], `${got} still leaks`);
  }
});

test('quoted values go, whatever is in them', () => {
  // Node 20's JSON.parse message quotes the input it choked on.
  assert.equal(
    scrubMessage('Unexpected token \'S\', "Sam Rivera" is not valid JSON'),
    "Unexpected token '…', \"…\" is not valid JSON",
  );
  assert.equal(scrubMessage('Unknown playlist `Sunday 9am – Grace North`'), 'Unknown playlist `…`');
});

test("V8's own shapes keep the property name that makes them useful", () => {
  assert.equal(
    scrubMessage("Cannot read properties of undefined (reading 'items')"),
    "Cannot read properties of undefined (reading 'items')",
  );
  assert.equal(
    scrubMessage("Cannot set properties of null (setting 'mode')"),
    "Cannot set properties of null (setting 'mode')",
  );
  // Only an identifier survives, even in that position.
  assert.equal(
    scrubMessage("Cannot read properties of undefined (reading 'Sam Rivera')"),
    "Cannot read properties of undefined (reading '…')",
  );
});

test('messages are cut to length and whitespace collapsed', () => {
  const out = scrubMessage(`a\n\n  b ${'x'.repeat(500)}`);
  assert.ok(out.startsWith('a b '));
  assert.equal(out.length, MESSAGE_MAX);
  assert.ok(out.endsWith('…'));
  assert.equal(scrubMessage(undefined), '');
});

test('only a plain identifier survives as an error name', () => {
  assert.equal(scrubName('TypeError'), 'TypeError');
  assert.equal(scrubName('Error: from 192.0.2.1'), 'Error');
  assert.equal(scrubName(undefined), 'Error');
});

test('a where label keeps its constant and drops the room id beside it', () => {
  assert.equal(scrubWhere('autostart grace-north-main'), 'autostart');
  assert.equal(scrubWhere('show grace-north-main'), 'show');
  assert.equal(scrubWhere('health listener'), 'health');
  assert.equal(scrubWhere('pp-playlist'), 'pp-playlist');
  assert.equal(scrubWhere(''), 'unknown');
  assert.equal(scrubWhere('192.0.2.1 down'), 'unknown');
});

test('stack frames: ours made relative, dependencies and Node kept, the rest external', () => {
  const stack = [
    "TypeError: Cannot read properties of undefined (reading 'items')",
    `    at parsePlan (${ROOT}/server/integrations/planningCenter.js:212:31)`,
    `    at async Promise.all (index 0)`,
    `    at file://${ROOT}/server/showManager.js:88:5`,
    `    at Layer.handle [as handle_request] (${ROOT}/node_modules/express/lib/router/layer.js:95:5)`,
    '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
    '    at Object.<anonymous> (/Users/srivera/Desktop/script.js:1:1)',
  ].join('\n');
  const frames = scrubStack(stack, ROOT);
  assert.deepEqual(frames, [
    'parsePlan (server/integrations/planningCenter.js:212:31)',
    'Promise.all (<external>)', // `(index 0)` is not a location we know
    'server/showManager.js:88:5',
    'Layer.handle [as handle_request] (node_modules/express/lib/router/layer.js:95:5)',
    'process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
    'Object.<anonymous> (<external>)',
  ]);
  for (const f of frames) assert.match(f, FRAME_SHAPE);
  assert.ok(!frames.join('\n').includes('booth-admin'), 'the OS username in the install path is gone');
  assert.ok(!frames.join('\n').includes('srivera'));
});

test('Windows install paths are made relative too', () => {
  const root = 'C:/Users/booth-admin/AppData/Local/Programs/ProdMesh/resources/app.asar';
  const frames = scrubStack(
    `Error: x\n    at f (C:\\Users\\booth-admin\\AppData\\Local\\Programs\\ProdMesh\\resources\\app.asar\\server\\db.js:3:9)`,
    root,
  );
  assert.deepEqual(frames, ['f (server/db.js:3:9)']);
});

test('the fingerprint ignores line numbers and install location, not the code path', () => {
  const at = (root, line) => scrubStack(`E\n    at parsePlan (${root}/server/pc.js:${line}:3)\n    at run (${root}/server/show.js:9:1)`, root);
  const a = fingerprint('show', 'TypeError', at('/opt/prodmesh', 212));
  const b = fingerprint('show', 'TypeError', at('/Users/x/prodmesh', 219));
  assert.equal(a, b, 'same bug after an edit above it, on another install');
  assert.notEqual(a, fingerprint('show', 'RangeError', at('/opt/prodmesh', 212)));
  assert.notEqual(a, fingerprint('autostart', 'TypeError', at('/opt/prodmesh', 212)));
  assert.match(a, /^[0-9a-f]{16}$/);
});

test('scrubError accepts anything that was thrown', () => {
  const e = scrubError('a string thrown from 192.0.2.1', 'watching grace-north-main');
  assert.equal(e.where, 'watching');
  assert.equal(e.message, 'a string thrown from <ip>');
  assert.deepEqual(e.frames, []);
  assert.equal(scrubError(null).name, 'object');
});
