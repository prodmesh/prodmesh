// ─────────────────────────────────────────────────────────────────────────────
//  prodmesh desktop launcher.
//
//  For the church with one booth Mac and a volunteer — the case Docker does not
//  serve. Same shape as Bitfocus Companion, which is the thing these churches
//  already run and already understand: a menu-bar icon, a small status window
//  saying where the dashboard is, and a button to open it.
//
//  THE SERVER RUNS IN THIS PROCESS. Electron's main process is Node, so the
//  Express app is imported and started, not forked. One copy of the code, one
//  process to reason about, and no orphaned server if the app is force-quit.
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
// ─────────────────────────────────────────────────────────────────────────────

import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, shell, nativeImage, clipboard } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeSync } from 'node:fs';
import { networkInterfaces } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The name the OS shows — menu bar, Applications folder, "Quit ProdMesh".
//
// It ALSO determines app.getPath('userData'), i.e. where a church's database
// lives. Changing it later silently orphans every existing install's data, so
// it is settled here once and must not be edited again.
app.setName('ProdMesh');

const PORT = Number(process.env.PORT) || 8080;
const RELEASES_URL = 'https://github.com/prodmesh/prodmesh/releases/latest';

let tray = null;
let win = null;
let server = null;
let state = { status: 'starting', port: PORT, error: null };

// ── Where the church's data lives ────────────────────────────────────────────
// Outside the app bundle, so an update replaces the program and never the
// database. This is the whole reason the launcher is safe to auto-update.
const dataDir = join(app.getPath('userData'), 'data');
// Whether this is the very first launch, checked BEFORE the directory is
// created — it decides whether the status window opens by itself below.
const firstRun = !existsSync(dataDir);
mkdirSync(dataDir, { recursive: true });
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
 * The point of the whole product is that OTHER screens point at this box, so
 * "localhost" is the least useful thing the window could show. A room Mac
 * needs the LAN address, and the volunteer setting it up needs to be able to
 * read it off this window.
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

const dashboardUrl = () => `http://localhost:${state.port}`;

function pushState() {
  win?.webContents.send('prodmesh:state', {
    ...state,
    version: app.getVersion(),
    dataDir,
    urls: lanUrls(state.port),
    url: dashboardUrl(),
  });
}

async function startServer() {
  try {
    // Dynamic: the env above must be set first (see the header).
    const server_ = await import('../server/index.js');
    server = await server_.start(PORT);
    state = { status: 'running', port: server.address().port, error: null };
  } catch (err) {
    // The common one by far is "port already in use" — another copy running,
    // or a git install still under launchd. Say which, because "EADDRINUSE"
    // means nothing to the person who will read it.
    const busy = err?.code === 'EADDRINUSE';
    state = {
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

// Opening the dashboard is the one action the window offers, and it happens
// HERE rather than in the preload: preloads are sandboxed, so `shell` is
// undefined there and the call fails silently. The renderer sends no URL —
// the main process opens what it is actually serving, so the window has no
// say in the destination.
ipcMain.on('prodmesh:open', () => {
  if (state.status === 'running') shell.openExternal(dashboardUrl());
});

// ── Status window ────────────────────────────────────────────────────────────

function showWindow() {
  if (win) {
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 460,
    height: 420,
    resizable: false,
    title: 'ProdMesh',
    show: false,
    // Windows and Linux take the window icon from here; macOS uses the bundle.
    icon: join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      // The window renders local status only and must never be a way into the
      // rest of the machine.
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(join(__dirname, 'status.html'));
  win.once('ready-to-show', () => {
    win.show();
    pushState();
  });
  // Closing the window leaves the server running — that is the point of a tray
  // app, and the tray menu says so.
  win.on('closed', () => { win = null; });
}

// ── Tray ─────────────────────────────────────────────────────────────────────

function trayIcon() {
  const icon = nativeImage.createFromPath(join(__dirname, 'assets', 'trayTemplate.png'));
  // A macOS "template" image is recoloured by the OS for light/dark menu bars.
  icon.setTemplateImage(true);
  return icon;
}

function updateTray() {
  if (!tray) return;
  const running = state.status === 'running';
  tray.setToolTip(running ? `ProdMesh — ${dashboardUrl()}` : 'ProdMesh — not running');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: running ? `Running on port ${state.port}` : `Not running${state.error ? ' — see status' : ''}`, enabled: false },
    { type: 'separator' },
    { label: 'Open dashboard', enabled: running, click: () => shell.openExternal(dashboardUrl()) },
    { label: 'Copy LAN address', enabled: running, click: () => clipboard.writeText(lanUrls(state.port)[0] ?? dashboardUrl()) },
    { label: 'Status…', click: showWindow },
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

/**
 * Quitting stops the server, which stops every room screen in the building.
 * That is a bigger deal than closing a normal app window, so it asks — a
 * volunteer reaching for the menu bar mid-service should not be one click from
 * a dark auditorium.
 */
async function quit() {
  if (state.status === 'running') {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Cancel', 'Quit prodmesh'],
      defaultId: 0,
      cancelId: 0,
      message: 'Quit ProdMesh?',
      detail: 'Every screen pointed at this machine will stop working until it is started again.',
    });
    if (response !== 1) return;
  }
  app.isQuitting = true;
  server?.close();
  app.quit();
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

// One instance only. A second launch surfaces the running one instead of
// fighting it for the port — which is the actual behaviour a volunteer who
// double-clicked twice expects.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

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

    tray = new Tray(trayIcon());
    updateTray();
    tray.on('click', showWindow); // Windows: left-click opens status
    await startServer();
    // On a first launch the window IS the onboarding: nothing is configured,
    // and a lone menu-bar icon tells a volunteer nothing. It also opens on a
    // failure, which is the other time somebody needs to be told something.
    // Every later launch stays quietly in the tray.
    if (firstRun || state.status !== 'running') showWindow();
  });

  // The server is the product; the window is a viewer. Closing every window
  // must not quit on any platform, not just macOS.
  app.on('window-all-closed', () => {});
}

app.on('before-quit', () => { server?.close(); });
