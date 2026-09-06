// ─────────────────────────────────────────────────────────────────────────────
//  INTEGRATION: ProdMesh Remote RTA  —  room loudness (SPL).
//
//  The free companion analyzer (github.com/jbeale/prodmesh-rta). Enable its
//  API under Settings → API & Streaming (default port 8517) and it pushes a
//  JSON snapshot over a plain WebSocket:
//
//   Stream  ws://<host>:<port>/api/stream
//    ← { type: 'levels', time_ms, weighting, fast_db, slow_db, leq_db,
//        spl: { A: { fast_db, slow_db }, B: { ... }, C: { ... }, Z: { ... } },
//        bands_db: [...], metrics: { laf, las, leq, leqS, leqL, ... }, alarm }
//    Pushed at the app's configured stream rate (1–20 Hz); the current
//    snapshot arrives immediately on connect. Levels are null until the
//    input has audio. Read-only — the client never sends anything.
//
//  config = { host, port?, metric?, target?, limit? }
//    metric: a metric id from the `metrics` map (e.g. 'las', 'leqS').
//            Default slow_db — same meaning as Smaart's "SPL A Slow" when the
//            app is A-weighted, so reports stay comparable across sources.
//    target/limit: dB goals per room, same semantics as the Smaart config.
//
//  Like the Smaart watcher: retries forever with backoff (app closed between
//  services, machine asleep) and resolves only when aborted.
// ─────────────────────────────────────────────────────────────────────────────
import WebSocket from 'ws';
import { report } from '../health.js';

export const isConfigured = (cfg) => Boolean(cfg && cfg.host);

// Health key shared with smaart.js — both are the room's "analysis" source.
export const healthKey = (cfg) => `analysis@${cfg.host}:${cfg.port ?? 8517}`;

const RETRY_MS = 5000;
const CONNECT_TIMEOUT_MS = 8000;
const STALE_STREAM_MS = 15000; // no frames for this long → reconnect

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => { clearTimeout(t); resolve(); };
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Emit ≤1 sample/interval until the signal aborts:
 *   onSample({ ts, spl, readings?, ca?, caBand? })
 * readings contains each RTA-provided A/B/C/Z × Fast/Slow value. It is a
 * single shared stream, so dashboard widgets choose independently without
 * sending commands that could change another widget's reading.
 * ca = the app's C-A ratio (C-weighted minus A-weighted energy, dB) — the
 * bass-pressure indicator; caBand = its target range when one is configured
 * in the app ({ lo, hi }). Both ride along only when the stream carries them.
 */
export async function watchSpl(cfg, onSample, signal, intervalMs = 1000) {
  let warned = false;
  const state = { announced: false };
  while (!signal.aborted) {
    try {
      await streamOnce(cfg, onSample, signal, intervalMs, state);
      warned = false;
    } catch (err) {
      if (!signal.aborted) {
        report(healthKey(cfg), false, err.message);
        if (!warned) {
          console.error(`[rta] ${cfg.host}:${cfg.port ?? 8517}: ${err.message} — retrying`);
          warned = true; // one line per outage, not one per retry
        }
      }
      state.announced = false;
    }
    await sleep(RETRY_MS, signal);
  }
}

function streamOnce(cfg, onSample, signal, intervalMs, state) {
  const url = `ws://${cfg.host}:${cfg.port ?? 8517}/api/stream`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { handshakeTimeout: CONNECT_TIMEOUT_MS });
    let stale = null;
    let lastEmit = 0;
    const bump = () => {
      clearTimeout(stale);
      stale = setTimeout(() => finish(new Error('stream went quiet')), STALE_STREAM_MS);
    };
    const finish = (err) => {
      clearTimeout(stale);
      signal.removeEventListener('abort', onAbort);
      ws.close();
      err ? reject(err) : resolve();
    };
    const onAbort = () => finish();
    signal.addEventListener('abort', onAbort, { once: true });
    ws.on('error', (err) => finish(err));
    ws.on('close', () => finish(new Error('stream closed')));
    ws.on('open', bump);
    ws.on('message', (data) => {
      bump();
      const sample = sampleFrom(data, cfg, state);
      // The app pushes at its own rate (up to 20 Hz); keep our sampling rate.
      // The quarter-interval slack keeps a stream paced near intervalMs from
      // skipping every other frame over timing jitter.
      if (sample && Date.now() - lastEmit >= intervalMs * 0.75) {
        lastEmit = Date.now();
        onSample(sample);
      }
    });
  });
}

// Build a sample from a levels frame. Levels are null until the analyzer's
// input has audio — those frames keep the stream alive but yield no sample
// (the meter simply stays dark, like Smaart before logging starts).
const WEIGHTINGS = ['A', 'B', 'C', 'Z'];
const RESPONSES = ['Fast', 'Slow'];

function round(value) {
  return Math.round(value * 10) / 10;
}

function readingsFrom(frame) {
  const readings = {};
  for (const weighting of WEIGHTINGS) {
    const source = frame.spl?.[weighting] ?? frame.spl?.[weighting.toLowerCase()];
    for (const response of RESPONSES) {
      const key = response === 'Fast' ? 'fast' : 'slow';
      // Current RTA releases group each response beneath its weighting:
      //   spl: { A: { fast_db, slow_db }, ... }
      // An earlier concurrent-readings build grouped the inverse way:
      //   spl: { fast_db: { a, b, c, z }, slow_db: { a, b, c, z } }
      // Accept both while deployments upgrade independently.
      const value = source?.[`${key}_db`] ?? source?.[key]
        ?? frame.spl?.[`${key}_db`]?.[weighting]
        ?? frame.spl?.[`${key}_db`]?.[weighting.toLowerCase()];
      if (typeof value === 'number' && Number.isFinite(value)) readings[`SPL ${weighting} ${response}`] = round(value);
    }
  }

  // Older RTA releases expose only the measurement selected in their own UI.
  // Keep that one available until the analyzer is upgraded, without pretending
  // it supplies the other seven independent readings.
  if (!Object.keys(readings).length && WEIGHTINGS.includes(frame.weighting)) {
    for (const response of RESPONSES) {
      const value = frame[response === 'Fast' ? 'fast_db' : 'slow_db'];
      if (typeof value === 'number' && Number.isFinite(value)) readings[`SPL ${frame.weighting} ${response}`] = round(value);
    }
  }
  return readings;
}

function sampleFrom(data, cfg, state) {
  let frame;
  try {
    frame = JSON.parse(data);
  } catch {
    return null;
  }
  if (frame?.type !== 'levels') return null;
  if (!state.announced) {
    report(healthKey(cfg), true); // first levels frame — the app is streaming
    console.log(`[rta] ${cfg.host}: ProdMesh Remote RTA (${frame.weighting ?? '?'}-weighted)`);
    state.announced = true;
  }
  const readings = readingsFrom(frame);
  const spl = cfg.metric ? frame.metrics?.[cfg.metric] : readings['SPL A Slow'] ?? frame.slow_db;
  if (typeof spl !== 'number') return null;
  const sample = { ts: Date.now(), spl: round(spl) };
  if (Object.keys(readings).length) sample.readings = readings;
  const ca = frame.metrics?.ca;
  if (typeof ca === 'number') {
    sample.ca = round(ca);
    const band = frame.targets?.ca;
    if (typeof band?.lo_db === 'number' && typeof band?.hi_db === 'number') {
      sample.caBand = { lo: band.lo_db, hi: band.hi_db };
    }
  }
  return sample;
}
