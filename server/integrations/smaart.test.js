import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { setLogging, watchSpl } from './smaart.js';

// A fake Smaart API v4 server: password auth on the RPC socket, one device
// with two logging inputs, a metric stream that respects targetFPS, and the
// keypress command handler that toggles SPL logging (like Suite 9.6.4).
async function fakeSmaart({ requireAuth = true, logging = true, hasToggleCommand = true } = {}) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const seen = { authed: false, targetFPS: null, streamPath: null, logging, toggles: 0 };

  wss.on('connection', (ws, req) => {
    if (req.url === '/api/v4/') {
      ws.on('message', (data) => {
        const { sequenceNumber, action, target, properties } = JSON.parse(data);
        const reply = (response) => ws.send(JSON.stringify({ sequenceNumber, response }));
        if (action === 'get' && !target) {
          return reply({ applicationName: 'Smaart Suite', authenticationRequired: requireAuth });
        }
        if (action === 'set' && properties?.[0]?.password != null) {
          if (properties[0].password !== 'hunter2') return reply({ error: 'incorrect password' });
          seen.authed = true;
          return reply({});
        }
        if (action === 'get' && target === 'activeCalibratedInputs') {
          if (requireAuth && !seen.authed) return reply({ error: 'authentication required' });
          return reply({
            devices: seen.logging
              ? [
                  {
                    deviceName: 'OCTA-CAPTURE',
                    activeCalibratedChannels: [
                      { channelIndex: 0, channelName: 'Booth', streamEndpoint: '/api/v4/devices/OCTA-CAPTURE/channels/Booth' },
                      { channelIndex: 3, channelName: 'FOH Mic', streamEndpoint: '/api/v4/devices/OCTA-CAPTURE/channels/FOH%20Mic' },
                    ],
                  },
                ]
              : [],
          });
        }
        if (action === 'get' && target === 'commands') {
          return reply({
            commands: [
              { description: 'Cycle Skin', keypresses: ['ctrl + shift + X'] },
              ...(hasToggleCommand ? [{ description: 'Toggle SPL Logging', keypresses: ['option + L'] }] : []),
            ],
          });
        }
        if (action === 'issueCommand' && properties?.[0]?.keypress === 'option + L') {
          seen.logging = !seen.logging;
          seen.toggles += 1;
          return reply({ status: 'Toggle SPL Logging' });
        }
        reply({ error: 'unknown action' });
      });
      return;
    }
    // Metric stream connection.
    seen.streamPath = req.url;
    ws.on('message', (data) => {
      const { properties } = JSON.parse(data);
      if (properties?.[0]?.targetFPS) seen.targetFPS = properties[0].targetFPS;
    });
    const iv = setInterval(() => {
      ws.send(
        JSON.stringify({
          timestamp: '2025-07-06:T10:00:00.000-7:00',
          deviceName: 'OCTA-CAPTURE',
          channelName: 'FOH Mic',
          metrics: [{ 'FS Peak': -54.41 }, { 'SPL A Slow': 85.34 }, { 'LAeq 10': 84.9 }],
        }),
      );
    }, 20);
    ws.on('close', () => clearInterval(iv));
  });

  // Binding a host makes listen() asynchronous, so address() is null until now.
  await once(wss, 'listening');
  return {
    wss,
    seen,
    port: () => wss.address().port,
    close: () => new Promise((r) => wss.close(r)),
  };
}

// A fake Smaart v8 (as observed live on 8.5.2.2 at a church FOH):
// /api/v4/ accepts the WebSocket but never answers RPCs; the real API is the
// same dialect at /api/v3/.
async function fakeSmaartV8() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const seen = { v4Messages: 0, streamPath: null };

  wss.on('connection', (ws, req) => {
    if (req.url === '/api/v4/') {
      ws.on('message', () => { seen.v4Messages += 1; }); // silence, like the real thing
      return;
    }
    if (req.url === '/api/v3/') {
      ws.on('message', (data) => {
        const { sequenceNumber, action, target } = JSON.parse(data);
        const reply = (response) => ws.send(JSON.stringify({ sequenceNumber, response }));
        if (action === 'get' && !target) {
          return reply({ applicationName: 'Smaart v8', applicationVersion: '8.5.2.2', authenticationRequired: false });
        }
        if (action === 'get' && target === 'activeCalibratedInputs') {
          return reply({
            devices: [{
              deviceName: 'SoundGrid',
              activeCalibratedChannels: [
                { channelIndex: 0, channelName: 'FOH Mic', streamEndpoint: '/api/v3/devices/SoundGrid/channels/FOH%20Mic' },
              ],
            }],
            metrics: ['FS Peak', 'SPL A Slow', 'LAeq 10'],
          });
        }
        reply({ error: 'unknown action' });
      });
      return;
    }
    seen.streamPath = req.url;
    const iv = setInterval(() => {
      ws.send(JSON.stringify({ metrics: [{ 'SPL A Slow': 91.24 }] }));
    }, 20);
    ws.on('close', () => clearInterval(iv));
  });

  // Binding a host makes listen() asynchronous, so address() is null until now.
  await once(wss, 'listening');
  return { seen, port: () => wss.address().port, close: () => new Promise((r) => wss.close(r)) };
}

function collectSamples(cfg, count) {
  const ctl = new AbortController();
  const samples = [];
  const run = watchSpl(cfg, (s) => {
    samples.push(s);
    if (samples.length >= count) ctl.abort();
  }, ctl.signal);
  return run.then(() => samples);
}

test('real transport: auth → pick channel → stream samples', async () => {
  const srv = await fakeSmaart();
  try {
    const samples = await collectSamples(
      { host: '127.0.0.1', port: srv.port(), password: 'hunter2', channel: 'FOH Mic' },
      3,
    );
    assert.equal(samples.length, 3);
    assert.equal(samples[0].spl, 85.3); // "SPL A Slow", rounded to 1 decimal
    assert.ok(Number.isFinite(samples[0].ts));
    assert.equal(srv.seen.authed, true);
    assert.equal(srv.seen.targetFPS, 1); // throttled from 8fps to our 1s cadence
    assert.equal(decodeURIComponent(srv.seen.streamPath), '/api/v4/devices/OCTA-CAPTURE/channels/FOH Mic');
  } finally {
    await srv.close();
  }
});

test('real transport: no password needed when auth is off; default channel is the first', async () => {
  const srv = await fakeSmaart({ requireAuth: false });
  try {
    const samples = await collectSamples({ host: '127.0.0.1', port: srv.port() }, 1);
    assert.equal(samples[0].spl, 85.3);
    assert.match(decodeURIComponent(srv.seen.streamPath), /Booth$/);
  } finally {
    await srv.close();
  }
});

test('real transport: unknown metric falls back to an SPL/Leq meter, never dBFS', async () => {
  const srv = await fakeSmaart({ requireAuth: false });
  try {
    const samples = await collectSamples(
      { host: '127.0.0.1', port: srv.port(), metric: 'SPL C Slow' }, // not in frames
      1,
    );
    assert.equal(samples[0].spl, 85.3); // first SPL-family meter, not FS Peak (-54.4)
  } finally {
    await srv.close();
  }
});

test('real transport: falls back to API v3 when the v4 socket is silent (Smaart v8)', async () => {
  const srv = await fakeSmaartV8();
  try {
    const samples = await collectSamples({ host: '127.0.0.1', port: srv.port(), helloMs: 200 }, 2);
    assert.equal(samples[0].spl, 91.2);
    assert.ok(srv.seen.v4Messages >= 1, 'should have tried /api/v4/ first');
    assert.equal(decodeURIComponent(srv.seen.streamPath), '/api/v3/devices/SoundGrid/channels/FOH Mic');
  } finally {
    await srv.close();
  }
});

test('mock transport still works (rooms without Smaart hardware)', async () => {
  const samples = await collectSamples({ mock: true }, 2);
  assert.equal(samples.length, 2);
  assert.ok(samples.every((s) => s.spl >= 76 && s.spl <= 98));
});

test('setLogging: toggles on via the command handler and verifies the flip', async () => {
  const srv = await fakeSmaart({ requireAuth: false, logging: false });
  try {
    const r = await setLogging({ host: '127.0.0.1', port: srv.port() }, true);
    assert.deepEqual(r, { changed: true, logging: true });
    assert.equal(srv.seen.toggles, 1);
    assert.equal(srv.seen.logging, true);
  } finally {
    await srv.close();
  }
});

test('setLogging: no-op when the state already matches (toggle never fired)', async () => {
  const srv = await fakeSmaart({ requireAuth: false, logging: true });
  try {
    const r = await setLogging({ host: '127.0.0.1', port: srv.port() }, true);
    assert.deepEqual(r, { changed: false, logging: true });
    assert.equal(srv.seen.toggles, 0);
  } finally {
    await srv.close();
  }
});

test('setLogging: turns off, and authenticates first when required', async () => {
  const srv = await fakeSmaart({ requireAuth: true, logging: true });
  try {
    const r = await setLogging({ host: '127.0.0.1', port: srv.port(), password: 'hunter2' }, false);
    assert.deepEqual(r, { changed: true, logging: false });
    assert.equal(srv.seen.logging, false);
  } finally {
    await srv.close();
  }
});

test('setLogging: throws when Smaart exposes no toggle command', async () => {
  const srv = await fakeSmaart({ requireAuth: false, logging: false, hasToggleCommand: false });
  try {
    await assert.rejects(
      setLogging({ host: '127.0.0.1', port: srv.port() }, true),
      /no "Toggle SPL Logging" command/,
    );
  } finally {
    await srv.close();
  }
});
