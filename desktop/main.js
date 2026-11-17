// ─────────────────────────────────────────────────────────────────────────────
//  prodmesh desktop app.
//
//  One app, two jobs (#48):
//
//    SERVER  For the church with one booth Mac and a volunteer, the case Docker
//            does not serve. Same shape as Bitfocus Companion, which these
//            churches already run and understand: a menu-bar icon, the server
//            running behind it, and the dashboard in the app's own window.
//    CLIENT  Every other computer in the building: the same dashboard in a
//            window, pointed at the building's server, found by name over mDNS
//            (#56) rather than typed in as an address.
//
//  A computer that has never run ProdMesh asks which (start.html). One that
//  already has a data folder is a server and is never asked: see launchMode()
//  in connect.js for why. The decisions live in connect.js, free of Electron,
//  so they are tested by plain `node --test`.
//
//  THE SERVER RUNS IN THIS PROCESS. Electron's main process is Node, so the
//  Express app is imported and started, not forked. One copy of the code, one
//  process to reason about, and no orphaned server if the app is force-quit.
//  A client never imports it at all, so it never creates a database.
//
//  Two ordering constraints, both load-bearing:
//
//   1. PRODMESH_DATA_DIR must be set BEFORE the server is imported. db.js and
//      secrets.js read it at module scope, so a static import would bind the
//      wrong directory — hence the dynamic import() below.
//   2. app.getPath('userData') is only correct after the app name is set, so
//      setName() comes first. Otherwise the data lands in a folder named after
//      Electron itself and a rename silently orphans an entire church's
//      database.
//
//  THE DASHBOARD WINDOW HAS NO PRELOAD and runs sandboxed. In client mode it
//  shows pages from another computer, so it gets nothing from this one: no
//  IPC, no Node, no permissions beyond the clipboard, and it cannot navigate
//  away from its own server. Only the local windows (status.html, start.html)
//  have a preload, and each exposes a few named calls.
// ─────────────────────────────────────────────────────────────────────────────

import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, shell, nativeImage, clipboard, screen, session } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import {
  identify, launchMode, locate, normalizeAddress, opensExternally, originsOf, readPrefs, sameOrigin, writePrefs,
} from './connect.js';
import { browse } from '../server/discoveryBrowse.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The name the OS shows — menu bar, Applications folder, "Quit ProdMesh".
//
// It ALSO determines app.getPath('userData'), i.e. where a church's database
// lives. Changing it later silently orphans every existing install's data, so
// it is settled here once and must not be edited again.
app.setName('ProdMesh');

// Development only: a throwaway profile, to try a first launch or client mode
// without touching the real one. Must come after setName, which it overrides.
if (process.env.PRODMESH_DESKTOP_USERDATA) app.setPath('userData', process.env.PRODMESH_DESKTOP_USERDATA);

const PORT = Number(process.env.PORT) || 8080;
const RELEASES_URL = 'https://github.com/prodmesh/prodmesh/releases/latest';
const BG = '#0b1017'; // the app's own background, so a window never flashes white

let tray = null;
let main = null; // the dashboard window, in either mode
let statusWin = null; // server mode: where other screens point, and errors
let chooser = null; // start.html
let server = null;
let state = { mode: 'choose', status: 'starting', port: PORT, error: null };

// ── Where things live ────────────────────────────────────────────────────────
// Outside the app bundle, so an update replaces the program and never the
// database. This is the whole reason the app is safe to auto-update.
const userData = app.getPath('userData');
const dataDir = join(userData, 'data');
// Checked before anything can create it: an existing data folder is what
// makes this computer a server without asking.
const dataDirExisted = existsSync(dataDir);
let prefs = readPrefs(userData);
const savePrefs = (next) => {
  prefs = next;
  try { writePrefs(userData, prefs); } catch (err) { console.error('[desktop] could not save preferences:', err); }
};

process.env.PRODMESH_DATA_DIR = dataDir;
process.env.PRODMESH_DEPLOYMENT = 'desktop';
process.env.PRODMESH_VERSION = app.getVersion();
// Stamped into the manifest by build.mjs. Without it, deployment.js would try
// to shell out to git — which inside a packaged app finds nothing, and when
// run unpacked from the repo finds the DEVELOPER's checkout and reports that.
{
  const stamped = JSON.parse(
    readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
  ).prodmeshCommit;
  if (stamped) process.env.PRODMESH_COMMIT = stamped;
}
process.env.NODE_ENV = 'production';
process.env.PRODMESH_LOG_FILE = join(app.getPath('logs'), 'prodmesh.log');

/**
 * Every LAN address this machine answers on.
 *
 * The point of the server is that OTHER screens point at this box, so
 * "localhost" is the least useful thing the status window could show. A room
 * Mac needs the LAN address, and the volunteer setting it up needs to be able
 * to read it off this window.
 */
function lanUrls(port) {
  const out = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${port}`);
    }
  }
  return out;
}

const localUrl = () => `http://localhost:${state.port}`;

// ── The server ───────────────────────────────────────────────────────────────

function pushState() {
  statusWin?.webContents.send('prodmesh:state', {
    ...state,
    version: app.getVersion(),
    dataDir,
    urls: lanUrls(state.port),
    url: localUrl(),
  });
}

async function startServer() {
  mkdirSync(dataDir, { recursive: true });
  try {
    // Dynamic: the env above must be set first (see the header).
    const server_ = await import('../server/index.js');
    server = await server_.start(PORT);
    state = { ...state, status: 'running', port: server.address().port, error: null };
  } catch (err) {
    // The common one by far is "port already in use" — another copy running,
    // or a git install still under launchd. Say which, because "EADDRINUSE"
    // means nothing to the person who will read it.
    const busy = err?.code === 'EADDRINUSE';
    state = {
      ...state,
      status: 'error',
      port: PORT,
      error: busy
        ? `Port ${PORT} is already in use — another copy of prodmesh is probably already running.`
        : String(err?.message ?? err),
    };
    console.error('[desktop] server failed to start:', err);
  }
  pushState();
  updateTray();
}

async function enterServerMode() {
  state.mode = 'server';
  setAppMenu();
  if (!tray) {
    tray = new Tray(trayIcon());
    tray.on('click', showStatus); // Windows: left-click opens status
  }
  updateTray();
  await startServer();
  // The window is the dashboard now (#48). If the server failed, the status
  // window says why instead, since a dashboard that can't load says nothing.
  if (state.status === 'running') openDashboard(localUrl());
  else showStatus();
}

// ── The dashboard window ─────────────────────────────────────────────────────

let origin = null; // the one server this window may show

/** Last session's position, if it is still on a screen that exists. */
function savedPlace() {
  const b = prefs.bounds ?? {};
  const size = { width: b.width ?? 1440, height: b.height ?? 900 };
  if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) return size;
  // A booth Mac loses its second monitor between Sundays: never reopen there.
  const visible = screen.getAllDisplays().some(({ workArea: a }) =>
    b.x + 80 > a.x && b.x + 80 < a.x + a.width && b.y + 20 > a.y && b.y + 20 < a.y + a.height);
  return visible ? { ...size, x: b.x, y: b.y } : size;
}

function createMain() {
  main = new BrowserWindow({
    ...savedPlace(),
    minWidth: 900,
    minHeight: 560,
    title: 'ProdMesh',
    backgroundColor: BG,
    show: false,
    // Windows and Linux take the window icon from here; macOS uses the bundle.
    icon: join(__dirname, 'assets', 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  main.once('ready-to-show', () => main?.show());
  const wc = main.webContents;

  // A pop-out of our own page is a window like this one; anything else (a
  // Planning Center plan, a Restream channel) opens in the browser.
  wc.setWindowOpenHandler(({ url }) => {
    if (origin && sameOrigin(url, origin)) {
      return { action: 'allow', overrideBrowserWindowOptions: { backgroundColor: BG, autoHideMenuBar: true } };
    }
    if (opensExternally(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // The page can't take the window somewhere else. loadURL and loadFile from
  // here don't pass through this; only navigations the page starts do.
  wc.on('will-navigate', (e, url) => {
    if (origin && sameOrigin(url, origin)) return;
    e.preventDefault();
    if (opensExternally(url)) shell.openExternal(url);
  });
  wc.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
    // -3 is "aborted": a navigation replaced by another, not a failure.
    if (!isMainFrame || code === -3 || url.startsWith('file:')) return;
    if (state.mode === 'client') connectClient();
    else setTimeout(() => main?.loadURL(localUrl()), 2000); // our own server, restarting
  });

  main.on('close', () => {
    if (!main) return;
    const { x, y, width, height } = main.getNormalBounds();
    savePrefs({ ...prefs, bounds: { x, y, width, height } });
  });
  main.on('closed', () => { main = null; });
}

function openDashboard(url) {
  origin = new URL(url).origin;
  if (!main) createMain();
  main.loadURL(url);
  if (main.isVisible()) main.focus();
}

/** Bring the app's main window back: whatever this mode shows. */
function showMain() {
  if (state.mode === 'choose') return showChooser();
  if (main) {
    if (main.isMinimized()) main.restore();
    main.show();
    main.focus();
    return;
  }
  if (state.mode === 'server') {
    if (state.status === 'running') openDashboard(localUrl());
    else showStatus();
  } else {
    connectClient();
  }
}

// ── Client mode ──────────────────────────────────────────────────────────────

let attempts = 0;
let retry = null;
let connecting = false;

function showConnecting() {
  if (!main) createMain();
  main.loadFile(join(__dirname, 'connecting.html'), {
    query: { name: prefs.server?.name ?? 'the server', tries: String(attempts) },
  });
}

/**
 * Show the saved server, finding it again by id if its address has changed.
 * Keeps trying every few seconds while it can't, with a page that says so.
 */
async function connectClient() {
  if (connecting || state.mode !== 'client') return;
  connecting = true;
  clearTimeout(retry);
  try {
    if (!main || attempts > 0) showConnecting();
    const at = await locate(prefs.server, { browse: () => browse({ timeoutMs: 2500 }) });
    if (state.mode !== 'client') return;
    if (at) {
      attempts = 0;
      if (at.url !== prefs.server.url || at.name !== prefs.server.name) {
        savePrefs({ ...prefs, server: { ...prefs.server, url: at.url, name: at.name } });
      }
      openDashboard(at.url);
    } else {
      attempts += 1;
      showConnecting();
      retry = setTimeout(() => connectClient(), 5000);
    }
  } finally {
    connecting = false;
  }
}

function enterClientMode() {
  state.mode = 'client';
  attempts = 0;
  setAppMenu();
  connectClient();
}

// ── The chooser ──────────────────────────────────────────────────────────────

let found = []; // the last browse, kept here so the window only ever sends an id
let ownId = null; // in server mode, so the list can mark this computer

function showChooser() {
  if (chooser) {
    chooser.show();
    chooser.focus();
    return;
  }
  chooser = new BrowserWindow({
    width: 520,
    height: 520,
    resizable: false,
    title: 'ProdMesh',
    backgroundColor: BG,
    show: false,
    icon: join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: join(__dirname, 'preload-start.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  chooser.setMenuBarVisibility(false);
  chooser.loadFile(join(__dirname, 'start.html'));
  chooser.once('ready-to-show', () => chooser?.show());
  chooser.on('closed', () => {
    chooser = null;
    // Closed without choosing, on a first launch: nothing to keep running.
    if (state.mode === 'choose' && process.platform !== 'darwin') app.quit();
  });
}

ipcMain.handle('start:info', () => ({
  version: app.getVersion(),
  mode: state.mode,
  server: state.mode === 'client' ? prefs.server?.name ?? null : null,
}));

ipcMain.handle('start:discover', async () => {
  found = await browse({ timeoutMs: 2500 });
  if (state.mode === 'server' && !ownId && state.status === 'running') {
    try { ownId = (await identify(localUrl())).systemId; } catch { /* next round */ }
  }
  return found.map((i) => ({
    systemId: i.systemId,
    name: i.name,
    host: i.host ? i.host.replace(/\.local\.?$/i, '') : null,
    version: i.version,
    duplicate: i.duplicate,
    current: state.mode === 'server' ? i.systemId === ownId : state.mode === 'client' && i.systemId === prefs.server?.systemId,
  }));
});

/** A question over the chooser when it is open. */
const ask = (opts) => (chooser ? dialog.showMessageBox(chooser, opts) : dialog.showMessageBox(opts));

/** Ask before stopping the server here: every room pointed at it goes dark. */
async function confirmStopServer(detail) {
  const { response } = await ask({
    type: 'warning',
    buttons: ['Cancel', 'Stop the server here'],
    defaultId: 0,
    cancelId: 0,
    message: 'Stop running the server on this computer?',
    detail,
  });
  return response === 1;
}

ipcMain.handle('start:connect', async (_e, { systemId, address } = {}) => {
  let target;
  try {
    if (address !== undefined) {
      const url = normalizeAddress(address);
      const who = await identify(url);
      target = { systemId: who.systemId, name: who.name, url };
    } else {
      const inst = found.find((i) => i.systemId === systemId);
      if (!inst) return { error: 'That server stopped answering. Try again in a moment.' };
      for (const url of originsOf(inst)) {
        try {
          const who = await identify(url);
          if (who.systemId === systemId) { target = { systemId, name: who.name, url }; break; }
        } catch { /* the next address */ }
      }
      if (!target) return { error: `${inst.name} was found but isn’t answering. It may be on another network.` };
    }
  } catch (err) {
    return { error: err.message };
  }

  if (state.mode === 'server') {
    if (target.systemId === ownId) return { error: 'That’s the server on this computer.' };
    const ok = await confirmStopServer(
      `Every screen pointed at this computer stops working. ProdMesh will reopen connected to ${target.name}. Its data stays on this computer, and running the server here again brings it back.`,
    );
    if (!ok) return { cancelled: true };
    savePrefs({ ...prefs, mode: 'client', server: target });
    // A relaunch, not a teardown in place: the server has timers, watchers and
    // sockets all over this process, and a fresh start is the clean way out.
    app.relaunch();
    quitNow();
    return { ok: true };
  }

  savePrefs({ ...prefs, mode: 'client', server: target });
  chooser?.close();
  enterClientMode();
  return { ok: true };
});

ipcMain.handle('start:server', async () => {
  if (state.mode === 'server') return { ok: true };
  const others = found.filter((i) => !i.duplicate);
  if (others.length) {
    const { response } = await ask({
      type: 'question',
      buttons: ['Cancel', 'Run a second server'],
      defaultId: 0,
      cancelId: 0,
      message: 'There’s already a ProdMesh server on this network.',
      detail:
        `${others.map((i) => i.name).join(', ')}. A second server starts empty, with its own rooms and users. ` +
        'Most computers in a building should connect to the one that exists.',
    });
    if (response !== 1) return { cancelled: true };
  }
  savePrefs({ ...prefs, mode: 'server' });
  // From a client, the window still points at the other server: close it, and
  // start ours. Nothing of the server was ever imported, so this is in place.
  main?.close();
  chooser?.close();
  await enterServerMode();
  return { ok: true };
});

// ── Status window (server mode) ──────────────────────────────────────────────

// The status window's "Open dashboard" button. It sends no URL: the main
// process shows what it is actually serving, so the window has no say.
ipcMain.on('prodmesh:open', () => {
  if (state.status === 'running') showMain();
});

function showStatus() {
  if (statusWin) {
    statusWin.show();
    statusWin.focus();
    return;
  }
  statusWin = new BrowserWindow({
    width: 460,
    height: 420,
    resizable: false,
    title: 'ProdMesh status',
    backgroundColor: BG,
    show: false,
    icon: join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      // The window renders local status only and must never be a way into the
      // rest of the machine.
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  statusWin.setMenuBarVisibility(false);
  statusWin.loadFile(join(__dirname, 'status.html'));
  statusWin.once('ready-to-show', () => {
    statusWin.show();
    pushState();
  });
  statusWin.on('closed', () => { statusWin = null; });
}

// ── Tray (server mode) ───────────────────────────────────────────────────────

function trayIcon() {
  const icon = nativeImage.createFromPath(join(__dirname, 'assets', 'trayTemplate.png'));
  // A macOS "template" image is recoloured by the OS for light/dark menu bars.
  icon.setTemplateImage(true);
  return icon;
}

function updateTray() {
  if (!tray) return;
  const running = state.status === 'running';
  tray.setToolTip(running ? `ProdMesh — ${localUrl()}` : 'ProdMesh — not running');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: running ? `Running on port ${state.port}` : `Not running${state.error ? ' — see status' : ''}`, enabled: false },
    { type: 'separator' },
    { label: 'Show dashboard', enabled: running, click: showMain },
    { label: 'Open in browser', enabled: running, click: () => shell.openExternal(localUrl()) },
    { label: 'Copy LAN address', enabled: running, click: () => clipboard.writeText(lanUrls(state.port)[0] ?? localUrl()) },
    { label: 'Status…', click: showStatus },
    { type: 'separator' },
    // server/deployment.js tells desktop installs to update from here, so this
    // item has to exist — Admin → System points at it by name.
    { label: 'Check for updates…', click: () => shell.openExternal(RELEASES_URL) },
    { type: 'separator' },
    { label: 'Show data folder', click: () => shell.openPath(dataDir) },
    { label: 'Show logs', click: () => shell.openPath(app.getPath('logs')) },
    { type: 'separator' },
    { label: `Version ${app.getVersion()}`, enabled: false },
    { label: 'Quit ProdMesh', click: () => quit() },
  ]));
}

// ── App menu ─────────────────────────────────────────────────────────────────
// A real one, now that the window is the dashboard: without an Edit menu,
// copy and paste don't work in the dashboard's fields on macOS.

function setAppMenu() {
  const serving = state.mode === 'server';
  const mine = [
    ...(state.mode === 'client' && prefs.server ? [{ label: `Connected to ${prefs.server.name}`, enabled: false }] : []),
    { label: 'Change server…', click: showChooser },
    ...(serving
      ? [
        { type: 'separator' },
        { label: 'Server status…', click: showStatus },
        { label: 'Copy LAN address', click: () => clipboard.writeText(lanUrls(state.port)[0] ?? localUrl()) },
        { label: 'Open in browser', click: () => shell.openExternal(localUrl()) },
      ]
      : []),
    { type: 'separator' },
    { label: 'Check for updates…', click: () => shell.openExternal(RELEASES_URL) },
  ];
  const quitItem = { label: 'Quit ProdMesh', accelerator: 'CmdOrCtrl+Q', click: () => quit() };
  const view = {
    label: 'View',
    submenu: [
      { role: 'reload' },
      { role: 'forceReload' },
      ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }]),
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  };
  const template = process.platform === 'darwin'
    ? [
      { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, ...mine, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, quitItem] },
      { role: 'editMenu' },
      view,
      { role: 'windowMenu' },
    ]
    : [
      { label: 'ProdMesh', submenu: [...mine, { type: 'separator' }, quitItem] },
      { role: 'editMenu' },
      view,
      { role: 'windowMenu' },
    ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Quitting ─────────────────────────────────────────────────────────────────

function quitNow() {
  app.isQuitting = true;
  server?.close();
  app.quit();
}

/**
 * Quitting a server stops every room screen in the building. That is a bigger
 * deal than closing a normal app window, so it asks — a volunteer reaching for
 * the menu bar mid-service should not be one click from a dark auditorium.
 * A client is a window like any other and just quits.
 */
async function quit() {
  if (state.mode === 'server' && state.status === 'running') {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Cancel', 'Quit ProdMesh'],
      defaultId: 0,
      cancelId: 0,
      message: 'Quit ProdMesh?',
      detail: 'Every screen pointed at this machine will stop working until it is started again.',
    });
    if (response !== 1) return;
  }
  quitNow();
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

// One instance only. A second launch surfaces the running one instead of
// fighting it for the port — which is the actual behaviour a volunteer who
// double-clicked twice expects.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMain);
  app.on('activate', showMain); // macOS: clicking the dock icon

  app.whenReady().then(async () => {
    // An UNPACKED run (npm start) shows Electron's own dock icon, because the
    // icon otherwise comes from the .app bundle that does not exist yet.
    // Packaged builds already have it, so this is dev-only.
    if (process.platform === 'darwin' && !app.isPackaged) {
      app.dock?.setIcon(join(__dirname, 'assets', 'icon.png'));
    }

    // CI: start the server, report, exit. This is the only check that the
    // native module rebuilt against ELECTRON's ABI actually loads — plain
    // `node` cannot run this tree at all, because better-sqlite3 here is
    // built for Electron and would fail with NODE_MODULE_VERSION. No tray or
    // window, so it needs nothing from the window server beyond app-ready.
    if (process.env.PRODMESH_SMOKE === '1') {
      await startServer();
      // writeSync, not console.log: app.exit() terminates immediately without
      // flushing stdout, so a buffered write is simply lost and CI sees a
      // silent pass. Found the hard way.
      writeSync(1, `${JSON.stringify({ status: state.status, port: state.port, error: state.error })}\n`);
      server?.close();
      app.exit(state.status === 'running' ? 0 : 1);
      return;
    }

    // Whatever the window shows, it gets the clipboard (copying a pairing
    // token) and full screen. Nothing else: no camera, microphone, location
    // or notifications for pages that, in client mode, come from elsewhere.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, done) => {
      done(permission === 'clipboard-sanitized-write' || permission === 'fullscreen');
    });

    const mode = launchMode({ prefs, dataDirExists: dataDirExisted });
    if (mode === 'server') {
      // An existing install with no preferences file yet: write down what it
      // is, so a later launch never has to infer it again.
      if (prefs.mode !== 'server') savePrefs({ ...prefs, mode: 'server' });
      await enterServerMode();
    } else if (mode === 'client') {
      enterClientMode();
    } else {
      setAppMenu();
      showChooser();
    }
  });

  // A server is the product and the window is a viewer: closing every window
  // must not stop it, on any platform. A client is an ordinary app, except
  // on macOS, where apps stay open in the dock.
  app.on('window-all-closed', () => {
    if (state.mode !== 'server' && process.platform !== 'darwin' && !app.isQuitting) app.quit();
  });
}

app.on('before-quit', () => { app.isQuitting = true; server?.close(); });
