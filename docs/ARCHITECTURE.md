# Architecture

A modular, web-based production dashboard for the church. This doc is the mental
model — read it first when returning to the project cold. It captures *why* the
system is shaped this way, the conventions to preserve, and the gotchas learned
the hard way. For current live/mock status and the roadmap, see [STATE.md](STATE.md).

## What it is

One always-on box (a Mac in the Auditorium booth today; possibly Linux/Proxmox
later) runs a small server that:
- serves a React SPA, and
- proxies to per-room **Bitfocus Companion** installs and to **Planning Center**.

Every other screen (room Macs, booth displays) is **just a browser** pointed at
that one server. There is exactly **one server to run and update**.

```
Browser (Home · Services · Analytics · Admin · Room pages)
      │  /api/*            request/response  → useQuery
      │  /api/stream       one SSE, N topics → useTopic
      ▼
Express server (server/)
  ├─ proxy → Bitfocus Companion (per room, :8000)   read var / press button
  ├─ integrations/ → Planning Center, ProPresenter, Smaart/RTA
  ├─ streamHub.js → topics + refcounted watchers    (ADR 0010)
  ├─ views.js     → stored dashboards & displays    (ADR 0011)
  ├─ SQLite (prodmesh.db)                           topology, config, facts
  ├─ server/data/*.json                             secrets + bootstrap only
  └─ serves the built SPA (dist/) in production
```

## Stack

- Frontend: **React 19 + TypeScript + Vite**, **React Router**. Dark, glanceable.
- Backend: **Express 5**, plain ESM JavaScript (no build step), Node 20 (`.nvmrc`).
- Tests: **`node --test`** (backend), **Vitest + Testing Library** (frontend).
  CI: GitHub Actions (build + both test layers + lint).
- **SQLite** (`better-sqlite3`) owns server-managed configuration and
  operational facts (ADR 0006, ADR 0009). Only deployment bootstrap and
  restricted secrets stay in `server/data/*.json`.

## Layers & where things live

| Concern | Location |
|---|---|
| Topology (sites, rooms, tiles) | SQLite, served by `GET /api/config`; seeded by `server/topologySeed.js` |
| Tile types & rendering | `src/types.ts`, `src/tiles/registry.tsx`, `src/components/Tile.tsx` |
| Widget types & contract | `src/widgets/registry.tsx`, `src/widgets/types.ts` |
| Shared query cache keys | `src/lib/keys.ts` |
| Pages | `src/pages/` |
| API client (request/response) | `src/api.ts` + `src/lib/useQuery.ts` |
| Live values (push) | `src/lib/stream.ts` (`useTopic`) |
| Room control config | `server/roomsStore.js` from SQLite; `server/rooms.config.js` is a fresh-install seed |
| Companion client | `server/companion.js` |
| Runtime settings (operational) | `server/settings.js` |
| Lockout engine | `server/settings.js` (`computeProtection`, `isModeLocked`) |
| Integrations | `server/integrations/*.js` |
| Live topics + watcher lifecycle | `server/streamHub.js`, `server/showManager.js`, `server/roomStateWatcher.js` |
| Secrets | `server/secrets.js` → `server/data/secrets.json` |
| HTTP surface | `server/index.js` + `server/routes/*.js` |
| Config validation | `server/validate.js` (runs at startup) |
| Deploy/update | `deploy/*.sh` |

## The patterns that keep it from sprawling

1. **Config-driven tiles + registry.** The launcher is data, served from SQLite.
   A new tile *type* = one variant in `types.ts` + one entry in `registry.tsx`;
   everything else renders it automatically. New machine/tool = a data edit made
   in Admin → Campuses, no rebuild.

2. **Widgets are addressed by string, and take only `{roomId, config}`.**
   A new widget = a type in `src/widgets/types.ts` + one entry in
   `src/widgets/registry.tsx`. The narrow props contract is what makes a
   stored dashboard layout possible at all: a layout is data, so a widget must
   need nothing but data. Widgets therefore fetch their own state — free,
   provided they use the shared cache keys in `src/lib/keys.ts`. Not every
   panel is a widget; a page's own control surface stays a page component.

3. **The database owns configuration.** Rooms, Companion hosts, button
   locations and PC service-type ids all live in SQLite and are edited in
   Admin (ADR 0009). `rooms.config.js` is now only a fresh-install seed. Getting
   this config wrong fires the wrong AV action, so the *editing* is permission-
   gated and validated — the old answer, keeping it in code, made every church
   depend on whoever could edit and redeploy.

4. **Integration pattern:** each external service is a self-contained module doing
   **auth → fetch → normalize → cache**, with a **mock-first** fallback. See
   `integrations/planningCenter.js` as the reference. The next integration
   (Calendar, ProPresenter) drops in the same way.

5. **Mock-first for data integrations.** Smaart/analysis, Planning Center and
   YouTube fall back to realistic sample data with no credentials; the app is
   demoable with zero external wiring and degrades gracefully when a service
   is down. Companion is the exception — a room's modes are the room's actual
   control surface, so a room either has a Companion or is simply unconfigured;
   there is no simulated mode state. (A `local-test` room under
   `PRODMESH_LOCAL_TEST=1` exists for demoing room controls hands-free.)

6. **Server-side enforcement.** Anything that must not be bypassable (admin auth,
   mode lockouts) is checked on the server. The browser is never trusted.

## Key flows

- **Live values:** one SSE connection per browser at `/api/stream?topics=…`
  (ADR 0010). A widget names a topic (`room:<id>:mode`, `:show`, `:timer`,
  `:spl`); the hub refcounts subscribers and starts/stops the producing watcher
  accordingly, so no room is polled for nobody's benefit. `useTopic` on the
  client holds the single connection and reconnects, debounced, as the topic
  set changes.
- **Room state:** the server polls Companion once per room while anyone is
  watching `room:<id>:mode`, and publishes on change. It mirrors Companion's
  truth regardless of who changed it (our page, a Stream Deck, a trigger) —
  Companion has no push API, so *someone* must poll; the point is that it is
  one poller, not one per browser. `GET /api/rooms/:id/state` remains for
  one-off reads and first paint.
- **Mode change:** `POST /api/rooms/:id/mode` presses the mapped Companion button.
  If the mode is locked in a protected window, the server requires the Override
  PIN (`403 override_required` otherwise).
- **Auth:** bootstrap Admin PIN on first run → `POST /api/auth/admin` returns a
  bearer token (in-memory session) → admin endpoints check it.
- **Planning Center:** per room, upcoming plans are merged across the room's
  service types (soonest first); the next plan is hydrated with **service** times
  and its order of service.

## Invariants — do not break these

- Never trust the client for auth/lockout; enforce on the server.
- Never commit `server/data/` (PINs, secrets, per-box settings). It is git-ignored.
- Structural config (button locations!) lives in SQLite and is validated —
  at startup by `validate.js` and on every save by `connectivity.js`. It used
  to live in code; what must not change is that it is *validated*, since a
  wrong button location fires the wrong AV action in front of a room.
- Integrations stay mock-first and cached; never let a slow/broken external API
  block or blank the dashboards.
- One server owns production; room Macs are browsers. Update = update that box.

## Gotchas learned (would re-bite a fresh context)

- **Companion has no CORS headers** → the browser can't read its API directly.
  Hence the proxy (ADR 0002).
- **`vnc://` screen sharing** only opens Screen Sharing.app on a **Mac** client.
- **`crypto.randomUUID()` needs a secure context** (https/localhost) — it throws
  on `http://<lan-ip>`. Use a manual id generator in the browser.
- **Planning Center plan_times mix in rehearsals/auditions/soundchecks** — we show
  `service` + `rehearsal` (rehearsals in purple), and drop the rest. Fetch times
  per-plan, not via `include` (the included array is ambiguous across plans). The
  Quick Access overview shows service times only; Room Status shows both.
- **A room hosts multiple PC service types** (the Auditorium = Sunday/Second Service/
  Midweek/Evening). Map rooms to an array and merge.
- **Song key** is `item.key_name`; **item "Leader"** is not a field — it's an
  *item note* in the "Leader" category (fetch items with `include=item_notes`).
- **ProPresenter API is on its own port**, and it is **per-machine and
  ephemeral** — ProPresenter picks one and it can change across restarts unless
  pinned in its Network preferences (one production Mac has answered on
  1025, a dev laptop on 62201; 62202 is only this module's fallback default).
  49310 is the legacy WS and won't speak HTTP. The active item's fields nest under `playlist_item.id`. And
  `?chunked=true` support is **version-dependent**: on 21.4 both
  `/v1/presentation/slide_index` and `/v1/playlist/active` hold the connection
  open and push on change (verified live 2026-07-26), while older builds answer
  the initial snapshot and close. So `pollRunState` runs both sources — it
  streams `slide_index` and, because every build sends an opening snapshot,
  treats only a SUBSEQUENT push as proof of streaming. Until proven (and again
  if the stream drops or is caught missing a change) it polls at the full rate,
  exactly as before streaming existed. Browsers get the result via SSE either
  way. For slide totals, the active arrangement comes from the
  playlist item's `presentation_info.arrangement_name/uuid` — the presentation's
  own `current_arrangement` is unreliable (often empty), and arrangements have
  different slide counts (songs repeat groups).
- **PC Calendar, not Services, is the authoritative event→room→time source.**
  Services doesn't reliably know the physical room. See ADR 0001.
- **launchd/systemd don't inherit your PATH** — the service installer bakes in the
  absolute `node` path.
- **Browsers allow six concurrent connections per origin on HTTP/1.1**, and
  this box has no TLS and so no HTTP/2. That is why live data is one
  multiplexed stream rather than one per room: past six, the seventh
  `EventSource` never opens and nothing reports an error. See ADR 0010.

## Testing & CI

`npm test` runs both layers: `node --test` over `server/*.test.js` (pure
helpers, config validation, the settings/lock engine, the PC integration, the
stream hub, and full API auth + lockout flows against mock-mode rooms — no
Companion/PC needed) and Vitest + Testing Library over `src/**/*.test.tsx`. CI
runs build + both + lint on push. See [TESTING.md](TESTING.md), and the section
in CLAUDE.md on what green can and cannot certify.

## Decisions

Architecture decisions are recorded in [`docs/decisions/`](decisions/). Start there
for the reasoning behind load-bearing choices.
