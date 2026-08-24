How to get the prodmesh server running, on three different kinds of machine.

# Installation

prodmesh is one server that every other screen in the building talks to over
the browser. You install it once, on one always-on machine; everything else —
room Macs, booth displays, tablets — just opens a URL.

There are three ways to install it. Pick one.

## Which should I choose?

| | Best for | Requires | Updates by |
|---|---|---|---|
| **[Desktop app](#desktop-app)** | One booth Mac (or Windows PC), no server | Nothing — download and run | Downloading a new installer |
| **[Docker](#docker)** | A church with a server, NAS, or homelab | Docker | `docker compose pull` |
| **[Manual / git install](#manual-git-install)** | Comfortable with a terminal; running from a git checkout | Node.js, git | `deploy/update.sh` |

Whichever you pick, the dashboard serves on **port 8080** by default, and every
other screen in the building reaches it the same way: point a browser at
`http://<box-ip>:8080`.

---

## Desktop app

The easiest route, and the right one if the whole setup is a single Mac (or
Windows PC) in the booth with no dedicated server. It behaves like Bitfocus
Companion, which these churches typically already run: an icon in the menu
bar, a small status window showing the address other screens should use, and
a button to open the dashboard.

The server runs inside this app — closing the status window does not stop it,
only quitting the app from the menu bar does.

**Install:**

1. Download the installer for your platform from the project's
   [GitHub Releases](https://github.com/prodmesh/prodmesh/releases) page.
2. **macOS:** open the `.dmg` and drag ProdMesh to Applications. The build is
   signed and notarized, so it opens with no security warning.
3. **Windows:** run the `.exe` installer. The build is not code-signed, so
   Windows SmartScreen will show an "unrecognized app" prompt — click **More
   info → Run anyway** to continue.
4. Launch ProdMesh. It appears as a menu-bar (macOS) or system-tray (Windows)
   icon. Open the status window to see the LAN addresses other screens
   should point at — click the tray icon on Windows, or choose **Status…**
   from the menu on macOS.

The exact wording changes between Windows versions, but the shape is always
the same: a blue dialog about an unrecognised app, with **Run anyway** hidden
behind **More info**. It is a warning, not a block.

**Where the data lives:** outside the app itself, in the OS's per-app data
folder (the menu → **Show data folder** opens it directly). An update replaces
only the program, never that folder, so upgrading the app never touches your
church's database.

**Updating:** download the newer installer from GitHub Releases and run it the
same way — macOS over the existing app in Applications, Windows over the
existing install. Your data is untouched because it lives outside the app
bundle.

**Logs:** the tray menu's **Show logs** item opens the log folder directly, if
something needs debugging.

---

## Docker

The right choice for a church with an existing server, NAS, or homelab box —
somewhere already running other always-on services.

```bash
curl -O https://raw.githubusercontent.com/prodmesh/prodmesh/main/docker-compose.yml
docker compose up -d
```

Then open `http://<this-host-ip>:8080` — the setup wizard takes it from there.

Everything mutable — the SQLite database, PINs, credentials, uploaded logo,
show history — lives in one named Docker volume (`prodmesh-data`, mounted at
`/data` inside the container). Back up that volume and you have backed up the
whole install; the image itself holds nothing that matters.

Two settings worth checking in `docker-compose.yml` before your first `up`:

- **`TZ`** — decides when a scheduled room lock window starts. A Sunday 08:00
  lock needs to be 08:00 local time, not UTC. Defaults to `America/Los_Angeles`.
- **`PRODMESH_SEED`** — `empty` by default, so a fresh container opens the
  setup wizard with nothing configured. Set it to `demo` instead if you want
  to explore with sample campuses first.

**Image tags:** `:latest` follows tagged releases only — the version a church
should run. `:main` tracks the tip of the main branch (edge, for testing, not
for a room on a Sunday).

**Updating:**

```bash
docker compose pull && docker compose up -d
docker compose logs -f   # the server log
```

The container does not update itself from inside the app — Admin → System
reports that this deployment updates by pulling a new image, rather than
offering an in-app update button.

---

## Manual / git install

For someone comfortable with git and a terminal who wants to run from source
and track updates directly from the repository — typically the person who
also maintains the install long-term.

Requires Node.js 20+ and git. Clone the repository, then install it as an
auto-starting background service:

```bash
./deploy/install-service.sh              # build + install + start, port 8080
PORT=9000 ./deploy/install-service.sh    # a different port
./deploy/install-service.sh --no-build   # skip npm ci / build (already built)
```

This installs a real OS service, not just a foreground process:

- **macOS** → a `launchd` LaunchAgent under `~/Library/LaunchAgents`, started
  when the user logs in. No `sudo` needed.
- **Linux** → a `systemd` service under `/etc/systemd/system`, started at
  boot. Needs `sudo`.

Either way, the service restarts automatically if it crashes.

| | macOS (launchd) | Linux (systemd) |
|---|---|---|
| Logs | `tail -f logs/server.log` | `journalctl -u prodmesh -f` |
| Status | `launchctl print gui/$(id -u)/com.prodmesh.dashboard` | `systemctl status prodmesh` |
| Remove | `./deploy/uninstall-service.sh` | `./deploy/uninstall-service.sh` |

**Updating:**

```bash
./deploy/update.sh          # tracks the newest vX.Y.Z release tag
./deploy/update.sh --edge   # tracks the tip of main instead
```

By default this checks out the **newest release tag**, not whatever is newest
on `main` — a release tag is the maintainer's signal that a version is safe to
run in a room on a Sunday, and this is deliberately conservative about that.
It refuses to run over uncommitted local changes, only reinstalls dependencies
when `package.json`/`package-lock.json` actually changed, and restarts the
service for you afterward. `--edge` is for a maintainer who deliberately wants
main's tip rather than the latest tagged release.

**Firewall note (macOS):** the first run may prompt to allow incoming
connections for `node` — allow it, or other room screens will not be able to
reach the dashboard.
