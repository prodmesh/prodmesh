// Production dashboard backend.
//
//  • Serves the built frontend (dist/) in production.
//  • Proxies room state reads + mode triggers to Companion (avoids browser CORS).
//
// Run:  npm start      (serves dist/ + API on PORT, default 8080)
// Dev:  npm run dev     (Vite proxies /api here on 3001)

import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

import { rooms } from './roomsStore.js';
import { validateRooms } from './validate.js';
import * as show from './showManager.js';
import * as splStore from './splStore.js';
import * as streamStore from './streamStore.js';
import * as summaries from './showSummaries.js';
import { initHealthDeclarations } from './healthBootstrap.js';
import { resolveIdentity } from './httpAuth.js';
import { isSealed, SEALED_MESSAGE } from './restoreSeal.js';
import * as deployment from './deployment.js';

import './roomStateWatcher.js'; // registers the room:*:mode topic
import './companionVariables.js'; // registers the room:*:var:*:* topics
import './roomHealth.js'; // registers the room:*:health topic
import './videoWatcher.js'; // registers the room:*:video topic
import './captionWatcher.js'; // registers the room:*:captions topic
import './lyricsWatcher.js'; // registers the room:*:lyrics topic
import './proPresenterWatcher.js'; // registers compact/rich ProPresenter console state
import './obsWatcher.js'; // registers per-room OBS Studio health
import './integrationWatcher.js'; // registers the org-level integration:* topics
import roomsRouter from './routes/rooms.js';
import showsRouter from './routes/shows.js';
import streamRouter from './routes/stream.js';
import viewsRouter from './routes/views.js';
import eventsRouter from './routes/events.js';
import calendarRouter from './routes/calendar.js';
import assistanceRouter from './routes/assistance.js';
import authRouter from './routes/auth.js';
import adminConfigRouter from './routes/adminConfig.js';
import systemRouter from './routes/system.js';
import proPresenterRouter from './routes/proPresenter.js';
import * as branding from './branding.js';
import * as settings from './settings.js';
import * as auth from './authStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PORT = process.env.PORT ?? (process.env.NODE_ENV === 'production' ? 8080 : 3001);

// Fail fast on a malformed room config instead of erroring deep in a request.
validateRooms(rooms);

// The admin PIN is the password of the built-in `admin` account (ADR 0012).
// settings.json remains where that credential is STORED — it is what an
// administrator edits on the server when the PIN is forgotten — so the
// account is refreshed from it here at boot, and again whenever it changes.
// An install that upgrades into this simply finds the account already there.
settings.onAdminPinChange((hash) => auth.projectAdminAccount(hash));
auth.projectAdminAccount(settings.adminPinHash());

const app = express();

/**
 * Reject requests whose Host header isn't an address this box actually answers
 * to. This is the DNS-rebinding guard.
 *
 * Auth here is a bearer token in a header, never a cookie, so a normal
 * cross-origin page cannot forge a request. Rebinding removes that protection:
 * an external page re-resolves its own hostname to this LAN IP, after which
 * the browser treats it as same-origin and can read responses. All it takes is
 * someone opening a link on the booth machine — no network foothold at all.
 *
 * Allowed: localhost, any literal IP (how every real client reaches it), and
 * anything in PRODMESH_ALLOWED_HOSTS for installs behind a hostname or proxy.
 */
const EXTRA_HOSTS = new Set(
  String(process.env.PRODMESH_ALLOWED_HOSTS ?? '')
    .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
);
const LITERAL_IP = /^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:.]+\])$/i;

app.use((req, res, next) => {
  const host = String(req.headers.host ?? '').toLowerCase();
  const name = host.replace(/:\d+$/, ''); // strip port
  const ok =
    !host || // some health checkers omit it; nothing sensitive is host-derived
    name === 'localhost' ||
    name.endsWith('.local') ||
    LITERAL_IP.test(name) ||
    EXTRA_HOSTS.has(name) ||
    EXTRA_HOSTS.has(host);
  if (!ok) return res.status(403).json({ error: 'host_not_allowed' });
  next();
});

app.use(express.json());

/**
 * Everything after a restore.
 *
 * The data directory under this process has been replaced; its database is
 * closed and its caches describe an installation that no longer exists. Say
 * that once, clearly, rather than letting each route fail its own way — a
 * screen full of assorted 500s reads as "the restore broke prodmesh" when what
 * it means is "the restore worked, now restart".
 */
app.use('/api', (_req, res, next) => {
  if (!isSealed()) return next();
  res.status(503).json({ error: 'restored', message: SEALED_MESSAGE, restart: deployment.restartHint() });
});

app.use(resolveIdentity);

// ── API (routers declare full /api/... paths) ─────────────────────────────────
app.use(roomsRouter);
app.use(eventsRouter);
app.use(calendarRouter);
app.use(assistanceRouter);
app.use(showsRouter);
app.use(streamRouter);
app.use(viewsRouter);
app.use(authRouter);
app.use(adminConfigRouter);
app.use(systemRouter);
app.use(proPresenterRouter);

// ── Static frontend (production) ───────────────────────────────────────────────
const distDir = join(__dirname, '..', 'dist');
if (existsSync(distDir)) {
  const indexPath = join(distDir, 'index.html');
  // Keep index.html out of the static middleware so we can put the configured
  // church favicon in the *initial* document. Safari selects its tab icon
  // before React mounts and can otherwise retain a previous /favicon.ico.
  app.use(express.static(distDir, { index: false }));
  // SPA fallback: any non-API route serves index.html so /room/:id works on reload.
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
    const logo = branding.getLogoMeta();
    if (!logo) return res.sendFile(indexPath);
    const favicon = [
      `<link id="app-favicon" rel="icon" type="image/x-icon" href="/favicon.ico?v=${logo.updatedAt}" />`,
      `<link rel="shortcut icon" type="image/x-icon" href="/favicon.ico?v=${logo.updatedAt}" />`,
    ].join('');
    const html = readFileSync(indexPath, 'utf8')
      .replace(/<link id="app-favicon"[^>]*\/>/, favicon);
    res.set('Cache-Control', 'no-store').type('html').send(html);
  });
}

/**
 * Boot the background work and start listening.
 *
 * Separate from module load because there are now two callers: this file when
 * run directly (launchd/systemd/Docker), and the desktop launcher, which runs
 * the same server inside Electron's main process. Only one copy of the server
 * exists either way — the tray app is a wrapper, not a fork.
 *
 * Resolves with the http.Server once it is actually listening, so a caller
 * that needs the port (the launcher, when asked for :0) can read it.
 */
export function start(port = PORT) {
  show.restoreShows().catch(() => {}); // resume any show that was active before restart
  show.initAutomation(); // per-room autostart watchers (PP-driven, browserless)
  summaries.syncFromTimelines(); // legacy timelines → summary rows (one-time per boot)
  splStore.startRetention(); // prune old SPL samples now + daily
  streamStore.startRetention(); // and old viewer samples
  initHealthDeclarations(); // every configured integration appears on /api/system/health
  return new Promise((resolve, reject) => {
    const server = app.listen(port);
    server.once('listening', () => {
      console.log(`Production dashboard server on http://localhost:${server.address().port}`);
      resolve(server);
    });
    server.once('error', reject);
  });
}

// Only start listening when run directly (not when imported by tests, and not
// when the desktop launcher imports the app to start it itself).
if (process.argv[1] === __filename) {
  start().catch((err) => {
    console.error(`Failed to start: ${err.message}`);
    process.exit(1);
  });
}

export { app };
