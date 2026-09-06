# Deploy

Two ways to run prodmesh today. A desktop launcher (tray icon, double-click
install) now exists and is the right answer for a church whose dashboard
lives on the booth Mac.

| | Best for | Updates by |
|---|---|---|
| **[Docker](#docker)** | A church with a server, NAS, or homelab | Pulling a new image |
| **[Service script](#auto-start-service)** (below) | A git checkout on the machine that runs it | `./deploy/update.sh` |

The app is a **LAN server**: booth screens, room Macs and phones open
`http://<host-ip>:8080`. Whichever way it runs, that machine needs to stay on
and reachable from the production network.

## Docker

```bash
curl -O https://raw.githubusercontent.com/prodmesh/prodmesh/main/docker-compose.yml
docker compose up -d
```

Then open `http://<this-host-ip>:8080` and the setup wizard takes it from there.

```bash
docker compose pull && docker compose up -d   # update to a new version
docker compose logs -f                        # server log
```

Everything that matters — PINs, credentials, the SQLite database, your uploaded
logo, show history — lives in the `prodmesh-data` volume. Back that volume up
and you have backed up the install. Nothing valuable is inside the image.

Two settings worth checking in `docker-compose.yml`:

- **`TZ`** decides when a scheduled lock window starts. A Sunday 08:00 lock is
  08:00 where the church is, not UTC. Default is `America/Los_Angeles`.
- **`PRODMESH_SEED`** is `empty`, so a new container is a clean install. Set it
  to `demo` if you want sample campuses to click around in first.

The container will not update itself — Admin → System says so instead of
offering a button. Pulling a new image is the update.

## Auto-start service

Run the dashboard as a background service that starts automatically and restarts
if it crashes. One script handles both platforms:

- **macOS** → a launchd LaunchAgent in `~/Library/LaunchAgents` (starts when the
  user logs in; the Producer Mac stays logged in). No sudo.
- **Linux** (e.g. a future Proxmox VM/LXC) → a systemd service in
  `/etc/systemd/system` (starts at boot). Uses sudo.

### Install

```bash
./deploy/install-service.sh             # build + install + start (port 8080)
PORT=9000 ./deploy/install-service.sh   # different port
./deploy/install-service.sh --no-build  # skip npm ci/build (already built)
```

The script resolves the absolute `node` path and the project directory itself,
so it works wherever the repo is checked out. Re-running it cleanly reloads the
service (safe to use as an "update" step after `git pull`).

### Manage

| | macOS (launchd) | Linux (systemd) |
|---|---|---|
| Logs | `tail -f logs/server.log` | `journalctl -u prodmesh -f` |
| Status | `launchctl print gui/$(id -u)/com.prodmesh.dashboard` | `systemctl status prodmesh` |
| Restart | re-run installer, or `launchctl kickstart -k gui/$(id -u)/com.prodmesh.dashboard` | `sudo systemctl restart prodmesh` |
| Remove | `./deploy/uninstall-service.sh` | `./deploy/uninstall-service.sh` |

### Updating

One command pulls the latest, rebuilds, and restarts the service:

```bash
./deploy/update.sh      # or:  npm run update
```

It aborts if the box has uncommitted local edits (so it never clobbers a
hand-edited `rooms.config.js`), only runs `npm ci` when dependencies actually
changed, and shows you exactly which commits landed. Room Macs pick up frontend
changes on their next browser refresh.

### If you installed before August 2026 — update your image name

The repository moved to the [prodmesh organisation](https://github.com/prodmesh),
and the Docker image moved with it:

```diff
-    image: ghcr.io/jbeale/prodmesh:latest
+    image: ghcr.io/prodmesh/prodmesh:latest
```

Edit that line in your own `docker-compose.yml`, then `docker compose pull &&
docker compose up -d`.

There is no rush — releases are published to both names for now, so an
un-edited compose file keeps working. But the old name will stop being updated
eventually, and it stops **silently**: no error, and the Update button in
Admin → System simply never finds a new version. Worth doing on a weekday
rather than discovering it on a Sunday.

Nothing else changes — same image contents, same data directory, same tags.

### Notes

- **Firewall (macOS):** the first run may prompt to allow `node` to accept
  incoming connections — allow it so other room Macs can reach the dashboard.
- **Port:** default 8080. Room Macs open `http://<this-host-ip>:<port>`.
