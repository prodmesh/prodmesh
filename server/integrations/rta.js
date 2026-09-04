// ─────────────────────────────────────────────────────────────────────────────
//  INTEGRATION: ProdMesh Remote RTA  —  room loudness (SPL).
//
//  The free companion analyzer (github.com/jbeale/prodmesh-rta). Enable its
//  API under Settings → API & Streaming (default port 8517) and it pushes a
//  JSON snapshot over a plain WebSocket:
//
//   Stream  ws://<host>:<port>/api/stream
//    ← { type: 'levels', time_ms, weighting, fast_db, slow_db, leq_db,
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
 *   onSample({ ts, spl, ca?, caBand? })
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
  const spl = cfg.metric ? frame.metrics?.[cfg.metric] : frame.slow_db;
  if (typeof spl !== 'number') return null;
  const sample = { ts: Date.now(), spl: Math.round(spl * 10) / 10 };
  const centers = Array.isArray(frame.centers_hz) ? frame.centers_hz : [];
  const bands = Array.isArray(frame.bands_db) ? frame.bands_db : [];
  const peaks = Array.isArray(frame.peaks_db) ? frame.peaks_db : [];
  if (centers.length && centers.length === bands.length) {
    const spectrum = centers.map((hz, index) => ({
      hz,
      db: bands[index],
      ...(typeof peaks[index] === 'number' && Number.isFinite(peaks[index]) ? { peak: peaks[index] } : {}),
    }))
      .filter(({ hz, db }) => typeof hz === 'number' && hz > 0 && typeof db === 'number' && Number.isFinite(db));
    if (spectrum.length) {
      sample.spectrum = spectrum;
      sample.spectrumMeta = {
        fast: typeof frame.fast_db === 'number' ? frame.fast_db : null,
        slow: typeof frame.slow_db === 'number' ? frame.slow_db : null,
        leq: typeof frame.leq_db === 'number' ? frame.leq_db : null,
        weighting: typeof frame.weighting === 'string' ? frame.weighting : null,
        calibration: typeof frame.cal_db === 'number' ? frame.cal_db : null,
      };
    }
  }
  const ca = frame.metrics?.ca;
  if (typeof ca === 'number') {
    sample.ca = Math.round(ca * 10) / 10;
    const band = frame.targets?.ca;
    if (typeof band?.lo_db === 'number' && typeof band?.hi_db === 'number') {
      sample.caBand = { lo: band.lo_db, hi: band.hi_db };
    }
  }
  return sample;
}
