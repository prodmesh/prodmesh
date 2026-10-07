// roomStatus() probes a room's configured integrations on demand (the chips
// on the room configuration page) — exercised here against a fake PP, a fake
// Companion, and a raw TCP listener standing in for an analysis source.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PRODMESH_DATA_DIR ??= mkdtempSync(join(tmpdir(), 'prodmesh-connstatus-'));

const { roomStatus } = await import('./connectivityStatus.js');
const { fakeProPresenter } = await import('./integrations/fakeProPresenter.js');

async function fakeCompanion(value = 'SUNDAY') {
  const srv = http.createServer((req, res) => {
    if (req.url === '/api/custom-variable/roomState/value') return res.end(value);
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: () => srv.address().port, close: () => new Promise((r) => srv.close(r)) };
}

async function tcpListener() {
  const srv = net.createServer((sock) => sock.end());
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: () => srv.address().port, close: () => new Promise((r) => srv.close(r)) };
}

// A port with nothing listening (grab one, then release it).
async function deadPort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  await new Promise((r) => srv.close(r));
  return port;
}

test('roomStatus probes every configured integration', async () => {
  const pp = await fakeProPresenter();
  const companion = await fakeCompanion();
  const rtaPort = await tcpListener();
  try {
    const status = await roomStatus({
      proPresenter: { host: '127.0.0.1', port: pp.port() },
      companion: { host: '127.0.0.1', port: companion.port(), variable: 'roomState' },
      analysis: { source: 'rta', host: '127.0.0.1', port: rtaPort.port() },
      planningCenter: { serviceTypes: [{ id: '1', name: 'Sunday' }] },
    });
    assert.equal(status.proPresenter.ok, true);
    assert.match(status.proPresenter.detail, /ProPresenter 7\.9 · FAKE-PP/);
    assert.equal(status.companion.ok, true);
    assert.equal(status.companion.detail, '$(roomState) = "SUNDAY"');
    assert.equal(status.analysis.ok, true);
    assert.match(status.analysis.detail, /RTA app port answering/);
    // No PCO credentials in the test data dir → labeled demo data.
    assert.equal(status.planningCenter.ok, null);
    assert.equal(status.planningCenter.mock, true);
    assert.ok(status.proPresenter.at > 0);
  } finally {
    await Promise.all([pp.close(), companion.close(), rtaPort.close()]);
  }
});

test('roomStatus reports failures with the reason, and skips the unconfigured', async () => {
  const port = await deadPort();
  const status = await roomStatus({
    proPresenter: { host: '127.0.0.1', port },
    companion: { host: '127.0.0.1', port, variable: 'roomState' },
    analysis: { source: 'smaart', host: '127.0.0.1', port },
    planningCenter: { serviceTypes: [] },
  });
  assert.equal(status.proPresenter.ok, false);
  assert.ok(status.proPresenter.detail, 'failure carries a reason');
  assert.equal(status.companion.ok, false);
  assert.equal(status.analysis.ok, false);
  assert.equal(status.planningCenter, null, 'no service types → nothing to report');
});

test('roomStatus marks simulated analysis sources instead of probing them', async () => {
  const status = await roomStatus({
    analysis: { mock: true },
  });
  assert.deepEqual(
    { analysis: status.analysis.mock },
    { analysis: true },
  );
  assert.equal(status.analysis.ok, null);
  // There is no simulated Companion — an integration without a host is skipped
  // (not probed, not "simulated"), and one with a host gets probed.
  assert.equal(status.companion, null);
  assert.equal(status.proPresenter, null);
});
