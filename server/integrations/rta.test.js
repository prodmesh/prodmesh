import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { watchSpl, isConfigured } from './rta.js';

// A fake ProdMesh Remote RTA: pushes a `levels` snapshot on connect (like the
// real app's greeting) and then at a fixed rate.
function fakeRta({ intervalMs = 20, frame = {} } = {}) {
  const wss = new WebSocketServer({ port: 0 });
  const seen = { path: null, connections: 0 };
  const levels = () =>
    JSON.stringify({
      type: 'levels',
      time_ms: 1750000000000,
      weighting: 'A',
      cal_db: 100,
      fast_db: 86.2,
      slow_db: 85.34,
      leq_db: 84.1,
      centers_hz: [1000],
      bands_db: [60.1],
      metrics: { laf: 86.2, las: 85.34, leqS: 84.9, ca: 8.31 },
      alarm: { enabled: false, state: 0 },
      targets: { ca: { lo_db: 8, hi_db: 12 } },
      ...frame,
    });

  wss.on('connection', (ws, req) => {
    seen.path = req.url;
    seen.connections += 1;
    ws.send(levels());
    const iv = setInterval(() => ws.send(levels()), intervalMs);
    ws.on('close', () => clearInterval(iv));
  });

  return {
    seen,
    port: () => wss.address().port,
    close: () => new Promise((r) => wss.close(r)),
  };
}

function collect(cfg, sampleCount, intervalMs = 10) {
  return new Promise((resolve) => {
    const samples = [];
    const ctl = new AbortController();
    watchSpl(cfg, (s) => {
      samples.push(s);
      if (samples.length >= sampleCount) {
        ctl.abort();
        resolve(samples);
      }
    }, ctl.signal, intervalMs);
  });
}

test('isConfigured needs a host', () => {
  assert.equal(isConfigured({ host: 'x' }), true);
  assert.equal(isConfigured({}), false);
  assert.equal(isConfigured(undefined), false);
});

test('streams slow_db samples from /api/stream', async () => {
  const srv = fakeRta();
  try {
    const samples = await collect({ host: '127.0.0.1', port: srv.port() }, 3);
    assert.equal(srv.seen.path, '/api/stream');
    for (const s of samples) {
      assert.equal(s.spl, 85.3);
      assert.ok(Number.isFinite(s.ts));
      assert.equal(s.ca, 8.3);
      assert.deepEqual(s.caBand, { lo: 8, hi: 12 });
      assert.deepEqual(s.spectrum, [{ hz: 1000, db: 60.1 }]);
      assert.deepEqual(s.spectrumMeta, { fast: 86.2, slow: 85.34, leq: 84.1, weighting: 'A', calibration: 100 });
    }
  } finally {
    await srv.close();
  }
});

test('cfg.metric picks from the metrics map', async () => {
  const srv = fakeRta();
  try {
    const [s] = await collect({ host: '127.0.0.1', port: srv.port(), metric: 'leqS' }, 1);
    assert.equal(s.spl, 84.9);
  } finally {
    await srv.close();
  }
});

test('missing ca / targets just omit those fields', async () => {
  const srv = fakeRta({ frame: { metrics: { las: 85.34 }, targets: {} } });
  try {
    const [s] = await collect({ host: '127.0.0.1', port: srv.port() }, 1);
    assert.equal(s.spl, 85.3);
    assert.equal(s.ca, undefined);
    assert.equal(s.caBand, undefined);
  } finally {
    await srv.close();
  }
});

test('null levels (no input audio) yield no samples but keep the stream alive', async () => {
  const srv = fakeRta({ frame: { slow_db: null, metrics: {} } });
  try {
    const samples = [];
    const ctl = new AbortController();
    const done = watchSpl({ host: '127.0.0.1', port: srv.port() }, (s) => samples.push(s), ctl.signal, 10);
    await new Promise((r) => setTimeout(r, 150));
    ctl.abort();
    await done;
    assert.equal(samples.length, 0);
    assert.equal(srv.seen.connections, 1); // never treated silence as an outage
  } finally {
    await srv.close();
  }
});

test('throttles a fast stream down to the sampling interval', async () => {
  const srv = fakeRta({ intervalMs: 5 }); // ~200 Hz push
  try {
    const samples = [];
    const ctl = new AbortController();
    const done = watchSpl({ host: '127.0.0.1', port: srv.port() }, (s) => samples.push(s), ctl.signal, 100);
    await new Promise((r) => setTimeout(r, 350));
    ctl.abort();
    await done;
    assert.ok(samples.length >= 2 && samples.length <= 6, `got ${samples.length}`);
  } finally {
    await srv.close();
  }
});
