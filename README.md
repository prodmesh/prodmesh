# prodmesh

A production dashboard for churches, running on your own LAN. One screen the
whole team opens: room status and mode control, the service order live from
Planning Center, startup checklists, run of show that follows ProPresenter, and
SPL history after the fact.

It is a **local server**, not a cloud service. Booth screens, room Macs and
phones all open `http://<host-ip>:8080`. Nothing leaves the building except the
calls you configure to Planning Center.

## Install

```bash
curl -O https://raw.githubusercontent.com/prodmesh/prodmesh/main/docker-compose.yml
docker compose up -d
```

Open `http://<this-host-ip>:8080` and a setup wizard takes it from there — it
asks who you are, creates the first admin, and starts with an empty building for
you to describe. Images are published for amd64 and arm64.

Prefer a git checkout with auto-start via launchd or systemd? See
[`deploy/README.md`](deploy/README.md), which covers both paths, updates and
backups.

## What it does

- **Home** — every room in the campus as a live status card: current mode,
  whether it is on air, what is on next. Plus a launcher for the tools that live
  on each machine (Companion, screen sharing, device web UIs).
- **Room Status** (`/room/<id>`) — the pastor-facing screen, meant to be the
  browser homepage on a room's main Mac. Current mode read live from a Companion
  variable, and one-tap buttons to change it. Schedule-based lockouts stop a
  mode change during a service unless someone enters the override PIN.
- **Services** — upcoming events from Planning Center, each opening to service
  and rehearsal times, plan notes, series artwork, and a **startup checklist**
  whose items can press real Companion buttons.
- **Run of show** — a server-coordinated show session per room. It follows
  ProPresenter live, tracks slide progress, can start and complete itself from
  the items you nominate, and produces a planned-versus-actual timing report for
  the debrief.
- **Analytics** — show history and SPL measurement from Smaart or the free
  ProdMesh Remote RTA, kept in SQLite so it outlives Planning Center's
  "upcoming" window.
- **Admin** — campuses and rooms, connectivity, users and permissions, stations,
  checklists, branding, logs and the audit trail.

Every integration is optional and mock-first: rooms work in memory before any
hardware is wired, so you can set the whole thing up on a laptop and connect
real gear later.

## Requirements

A machine that stays on and reachable from the production network — a NAS, a
homelab box, a spare Mac mini. The desktop app, Docker, or Node 20+ for a
checkout (see `.nvmrc`). Planning
Center, Companion, ProPresenter and Smaart are each optional.

## How it's put together

```
Browser  ──/api/*──▶  Express (server/)  ──HTTP──▶  Bitfocus Companion (per room)
                            │                       ProPresenter, Smaart
                            ├── SQLite (better-sqlite3) — the source of truth
                            └── serves the built frontend (dist/) in production
```

The proxy exists because Companion's HTTP API sends no CORS headers, so a
browser cannot read room state directly. The server talks to devices and exposes
a clean `/api`.

**Configuration lives in the database, not in files.** `server/rooms.config.js`
and `server/topologySeed.js` are fresh-install *seeds* only — once the server has
booted, SQLite owns campuses, rooms, connectivity and modes, and everything is
edited in Admin. Adding a room in the UI produces a real server room with
simulated modes, ready to point at a Companion.

Secrets (Planning Center tokens and the like) live in a git-ignored
`server/data/secrets.json` beside the database, or come from `PRODMESH_SECRET_*`
environment variables. They are write-only in the UI and never read back out.

## Development

```bash
npm install
npm run dev      # Vite (5173) + API (3001), with /api proxied
npm test         # 247 server tests (node --test) + 100 UI tests (vitest)
npm run build    # → dist/
npm start        # built app + API on one port (default 8080)
```

Server tests run against mock-mode rooms, so no hardware is needed. CI runs
build, both test layers and lint on every branch.

## Documentation

| | |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | Conventions, constraints and workflow — start here if you are contributing |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | How to send a pull request, and what it needs to carry |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Mental model, patterns, invariants, gotchas |
| [`docs/STATE.md`](docs/STATE.md) | What is live vs mock, and the roadmap |
| [`docs/INTEGRATION-NOTES.md`](docs/INTEGRATION-NOTES.md) | Hard-won device and API behaviour |
| [`docs/decisions/`](docs/decisions/) | Architecture decision records |
| [`docs/VISION.md`](docs/VISION.md) | Where this is going |

## A note on scope

prodmesh is designed as a **LAN appliance**, in the same spirit as Bitfocus
Companion. It has no TLS and binds all interfaces on purpose. Do not port-forward
it. If you need it from outside the building, put it behind a VPN.

## License

[MIT](LICENSE).

The bundled IBM Plex typefaces are licensed separately under the
[SIL Open Font License 1.1](https://openfontlicense.org), which the MIT grant
above does not cover and does not need to.
