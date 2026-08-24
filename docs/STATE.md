# Project state & roadmap

A living snapshot of what's live vs mock and what's next. Update this as things
change — it's the fastest way for a cold context to know where the project stands.
The long-term destination lives in [VISION.md](./VISION.md).
Last updated: 2026-08-23 (v1.3.0 released).

## v1.3.0 at a glance

The integrations release, and the first with outside contributors — most of it
came from [@WorshipWarehouse](https://github.com/WorshipWarehouse) as pull
requests (#7, #8, #11), reviewed and merged here.

| | |
|---|---|
| **ProPresenter console** | Slides, Playlist, Controls, Slide Notes and Timers widgets. Focused playlist (what an operator browses) stays distinct from the active item (what is live); arrangements expand; rendered cue thumbnails proxy through us, never the device. Control needs `propresenter.control` **and** a stored dashboard widget with controls enabled — the database decides, not the browser. |
| **Planning Center** | service, timer, schedule, team and service-report widgets |
| **Restream** | OAuth connect, broadcast state, per-destination viewers and labels. Scopes are `channels.read` + `stream.read` only — exactly what the code calls |
| **Resi** | stream, health, viewers and broadcast widgets — **Beta, see below** |
| **Open Sound Meter** | a third analysis source beside Smaart and ProdMesh RTA, over UDP multicast (239.255.42.42:49007) rather than HTTP |
| **Admin → Integrations** | enable/disable per integration; a disabled one is hidden *and* stops being polled |
| **Setup wizard** | choose the integrations you use, and only be asked for those credentials |
| **Widgets** | grouped by integration in the palette, every widget resizable, per-widget loudness meters |
| **Org-level topics** | `integration:<id>` — the first stream topic that is not `room:*:<name>` (ADR 0010) |

### Verified how

Per the rule that green tests certify logic and nothing else:

- **ProPresenter console** — run in the building during a service on 2026-08-16.
- **Restream** — verified against a live account by the contributor who wrote
  it, who then built further work on top of it.
- **Resi — NOT verified against a real account by anyone.** Neither the
  maintainer nor the contributor has a Resi subscription, so every Resi widget
  is exercised only against its unconfigured and error paths. It ships labelled
  **Beta** in the UI for exactly this reason.
- **Open Sound Meter** — the multicast listener and its socket lifecycle are
  tested; the +140 dB SPL reference is taken from OSM's own display and has not
  been checked against a calibrated meter.

**Beta means: not yet verified against real hardware or a real account by
anyone here.** A Beta integration is named in the release notes and never
blocks a tag — otherwise one unprovable integration holds every other fix
hostage. It graduates when someone runs it in a building and records what they
saw in [INTEGRATION-NOTES.md](./INTEGRATION-NOTES.md).

### Known gaps

- The Resi player and the optional Restream YouTube preview are `<iframe>`
  embeds without a `sandbox` attribute, and both need a route to the internet —
  a booth machine without one gets a blank frame rather than a clear message.
- Integration logo assets are ~800 KB of PNG for icons rendered small.

## v1.2.0 at a glance

The dashboards release. A room now owns as many **Views** as it wants — a
6-column `dashboard` you arrange and read in the booth, or a chrome-less 3×3
`display` you point a screen at (ADR 0011). Nine widgets, a drag/keyboard
editor, and the whole thing survived a Sunday.

| | |
|---|---|
| **Views** | dashboards + displays, drag or keyboard editor, per-view scale, station assignment |
| **Widgets** | clock, countdown, integrations, live viewers, loudness, loudness trend, now & next, room mode, run of show — plus comms and lyrics since (1.3.0-dev) |
| **ProPresenter** | slide progress and live **video playback position** on a new refcounted `room:*:video` topic |
| **Licensing** | MIT — the repo had been public since 2026-08-02 with no licence, i.e. all rights reserved |

Fixed after the 2026-08-09 field run, all found in a real building rather than
by CI:

- **Following the room** followed the room's next *plan* and that plan's
  *first* service time — a fixed answer that never moved, so a two-service
  morning sat on the 9:30 all day. It now follows the live show, then the
  clock (`src/lib/following.ts`), and fetches that plan's items even when it
  is not the soonest one.
- **A show whose plan left Planning Center could not be ended at all** — not
  from the UI, and not by hand either: `splStore` spread 164k samples into
  `Math.max(...)`, which throws past ~100k arguments, inside the aggregation
  the end path runs.
- Companion faults never surfaced on the room-mode widget, because
  `readRoomState` reports a *failed* live room as `source: 'mock'`.

## Sites & rooms

**North Campus** (active). **South Campus** — status `coming-soon`, shown as DISABLED,
not yet open, no rooms wired yet.

| Room | Companion | Modes | Planning Center |
|---|---|---|---|
| Auditorium (`north-main`) | **live** — 192.0.2.10, var `roomState`, buttons pg3 | Sunday/Second/Midweek/Evening/Event/Standby (real) | **live** — Sunday, Second Service, Midweek, Evening |
| Youth Room (`north-youth`) | mock — 192.0.2.22 (config ready) | standard set (Sunday/Mid-Week/Event/Standby) — **real modes unknown** | **live** — Youth Service |
| Chapel (`north-chapel`) | mock — 192.0.2.18 (config ready) | standard set — **real modes unknown** | **live** — Chapel Service |
| Local Test (`local-test`) | live — 127.0.0.1 (dev fixture; **opt-in via `PRODMESH_LOCAL_TEST=1`**, set by the npm dev scripts — hidden in production) | standard set | live — Sunday (demo) |

Notes:
- Companion "live" means `mock: false`; it only actually reaches Companion when the
  server runs on/with network access to that host.
- Youth Room/Chapel use placeholder button locations (pg1/row3/1-4) and the standard mode set
  until their real modes + button locations are provided (Auditorium's are real).

## Integrations

| Integration | Status |
|---|---|
| Bitfocus Companion (per room) | Live for Auditorium; Youth Room/Chapel mock pending real setup |
| Planning Center **Services** | **Live** — plan display + order of service, PAT in `server/data/secrets.json` |
| Planning Center **Calendar** | **Not started** — awaiting read-only access. High value (see below) |
| **Comms captions** | **Live for ProdMesh Caption** (verified 2026-08-11 against a running instance: roster, partial/final folding, refcounting, heartbeat). **ProdCom is written from its published spec and NOT verified** — its OpenAPI schemas TranscriptEntry but never the frame wrapping it, so `prodcom.js` identifies an entry by shape and accepts it bare or wrapped. Two sources behind `integrations/captions.js`, the same arrangement analysis.js uses. Read-only by design on both. Refcounted `room:*:captions` topic; the Comms widget is the only surface. See INTEGRATION-NOTES for the tick/events trap. |
| **Song lyrics** | **Live** — `GET /v1/presentation/active` gives the whole song in one response (group names, ProPresenter's own section colours, slide text, operator notes) and the arrangement it is played in. Verified 2026-08-13 against PP 21.4: a 27-cue arrangement expanded correctly, including a bridge played four times back to back. `arrangeSlides()` is the single expansion, and `slideTotal()` is now its length so the Now & Next slide bar cannot disagree with it. Refcounted `room:*:lyrics` topic — chunked `slide_index` stream plus a 1s watchdog for position, and one presentation fetch per song. The Lyrics widget is the only surface. **Position tracking inherits the coalescing limit** documented in INTEGRATION-NOTES: ProPresenter does not push every slide, so a fast pass through several cues can arrive as a jump. **Arrangement resolution is unverified on PP 21.1** — the church's build — where the route is the playlist item rather than the cue count. |
| **Smaart SPL** | **Transport implemented; v8 compat added 2026-07-14** — full pipeline (capture → SQLite → live meter + report) + real WebSocket transport (auth → `activeCalibratedInputs` → SPL metric stream). FOH Mac probe (2026-07-14) found **Smaart v8 (8.5.2.2)**: its `/api/v4/` socket accepts connections but never answers RPCs; the same dialect lives at `/api/v3/`. Transport now negotiates v4 → v3 and caches the answering path (`smaart.apiPath` pins it). Since 2026-07-18 Smaart is one of two interchangeable **analysis sources** (see `integrations/analysis.js`); ProdMesh Remote RTA is the free alternative. **Live at FOH 2026-07-21**: starting SPL logging in Smaart lit the dashboard meter — metering alone isn't enough, inputs must be calibrated + logging; shows can now drive logging on/off via `analysis.logControl`. Remaining: enumerate `get commands` on the FOH v8 to confirm it exposes "Toggle SPL Logging" (verified on v9) |

## What's live right now

- **Campus-first sidebar shell** (ADR 0007, supersedes 0005's top bar):
  collapsible left sidebar with campus picker (All Campuses / per site),
  nav = Home · Services · Analytics · Admin, User slot pinned at bottom
  (placeholder until auth). Widget-grid pages (`Widget`/`WidgetGrid`), CSS
  tokens + per-feature files.
  - **Home**: campus rooms as live status cards (mode, LIVE, next event)
    + the Quick Access launcher (Companion / Screen Share / device UIs).
  - **Services**: campus-wide upcoming events → Event Detail pages.
  - **Analytics**: show history (timelines + SPL from SQLite) → full reports.
    Timelines are labeled at show start so history outlives PC's "upcoming".
  - Room pages keep their `/room/:id…` URLs (room-Mac homepages unaffected);
    `/settings` → `/admin`.
- Room Status mode control with confirm + schedule-based **lockouts** (Override PIN).
- Settings UI: Admin/Override PINs, schedule editor, system self-update.
- **User-management foundation** (ADR 0008, feature branch): one-time named
  station registration per browser, anonymous read-only operation, contextual
  named-user login/lock, SQLite users + permission groups + extensible dotted
  ACLs, built-in Administrators wildcard, optional Planning Center person ID,
  login throttling, and user+station audit records. Admin → Users & permissions
  creates groups/users and assigns memberships. Legacy Admin PIN remains the
  bootstrap credential. Representative writes now enforced server-side: room
  modes, checklist completion, show operation/config, templates, settings, and
  updates.
- PC Services plan display on Quick Access + Room Status (real data).
- Run of Show: **server-coordinated show sessions** (one active per room, Start/End
  buttons, browsers are views — see ADR 0004) with live ProPresenter follow, slide
  progress, and a **timing report** (planned vs actual per item) for debriefs.
  Ended shows stay marked **✓ Complete** (reopenable). The countdown widget follows
  the room's **PP service-start timer** when it's running (Message-driven, works
  between services); falls back to PC clock math otherwise.
- **Show automation** (per event, Event Detail → Show Automation widget): pick the
  PC item that **autostarts** the show when ProPresenter lands on it (edge-triggered,
  so "Pre-Service Slides" can loop between services harmlessly) and the item whose
  **last slide auto-completes** it. Autostart picks the right service time by clock,
  skipping already-completed ones; a per-room watcher polls PP only inside the arm
  window (2h before first service → 1h after last), zero browsers required. Manual
  **PC→PP mapping overrides** per event handle drifted orders (stored in SQLite
  `show_config`; live shows pick up edits). PP quirk (verified): `playlist_item`
  reads null right after an item trigger until the next slide action — baseline
  keeps last mapped item.
- **Event Detail page + startup checklists** (live-tested 2026-07-06): clicking the
  event title opens `/room/:id/event/:planId` — service/rehearsal times, PC series
  artwork, plan notes, and a **startup checklist**. Templates are per PC **event
  type** (service type id, `'*'` default) in `server/data/checklists.json`,
  **editable in Admin → Checklists** (add/remove/reorder items, mark one as an
  automated mode-set; admin-PIN gated). One template covers the event type in
  every room it runs in — the room supplies execution context. Run state is
  per-event in SQLite (shared across browsers). Automated items press the real
  Companion button via the shared mode path, so schedule lockouts still apply.
- **Admin → Logs** (2026-07-14): server process log tail (the file
  `install-service.sh` writes; filter box, line-count picker, 5s auto-refresh)
  and the **audit trail** (who did what, from which station, allowed/denied)
  side by side. Guarded by the `system.logs` permission; `PRODMESH_LOG_FILE`
  overrides the log path for tests/unusual deployments.
- Deploy/update scripts (launchd/systemd), tests, CI. The automated suite now
  combines **335 server tests** with **265 frontend interaction/configuration tests**
  (Vitest + Testing Library); CI runs build, both test layers, and lint. See
  `docs/TESTING.md` for the required pattern as configuration moves into Admin,
  and `docs/UI_TEXT.md` for UI copy principles (terse labels, HelpTip for
  supplementary info, no intro paragraphs).
- **Station identity + named users** (feature branch): each browser registers a
  station name once, then remains a read-only dashboard until an operator signs
  in. Users inherit extensible permissions from groups; the Administrators system
  group grants all actions. Admin is split into General, Users & access, and
  Checklists subpages. The account menu requires confirmation before returning a
  station to read-only mode. When a user has a Planning Center Services Person ID,
  their Services profile thumbnail is shown as their avatar.
- **Views — dashboards & displays** (2026-08-04, ADR 0011): a room owns 0..many
  Views. A `dashboard` is an interactive 6-column grid with a header row that
  picks the Event and Service time every widget on it inherits; a `display` is
  a read-only, chrome-less 3×3 assigned to a station — a Raspberry Pi into an
  ATEM multiview input, or a foyer TV — with a per-view `scale` because type
  sized for a desk vanishes on a video wall. Both render through ONE canvas, so
  the editor's preview cannot drift from what a screen shows. Layouts are
  arranged by drag OR by an Add button and the keyboard, which is what makes
  the editor testable in jsdom (no layout there, so a simulated drag certifies
  nothing) — the gesture itself is hand-verified. Editing needs `views.edit`;
  reads are public because a screen with no keyboard has to fetch its own
  layout before anyone could log in. Widgets: `countdown`, `loudness`,
  `loudness-trend`, `viewers`, `now-next` (3×1), `room-mode`, `clock`,
  `room-health`, and `run-of-show` (2×3, the one dashboard-only widget,
  because it acts).
  `room-health` is a dot per configured integration, on a new `room:*:health`
  topic (`server/roomHealth.js`) that runs the SAME probe as the config
  page's chips. Two things let it be unauthenticated where the route needs
  `config.manage`: it is refcounted, so a building of displays costs one probe
  per room per 30s; and `publicHealth()` builds its payload from a fixed field
  list, so no host, port, version banner or error string reaches the wire —
  `roomHealth.test.js` asserts that against realistic probe text and fails if
  a field is passed through. YouTube is read from the health registry rather
  than probed, because every YouTube request is metered quota.
  `room-mode` is read-only on purpose: changing mode is a confirm dialog, a
  schedule-override PIN and a permission, which is a control surface rather
  than a tile, and it already has one on the room page. `loudness-trend` and
  `viewers` draw curves the BROWSER recorded — neither source keeps a live
  history to ask for, so a reload starts them over, and the service's real
  record stays the Show Report's.
  The client registry and `server/validate.js`'s copy of it are hand-kept
  duplicates (JS backend, TS frontend, no build step between), and
  `registry.test.tsx` imports the server table and fails if they disagree —
  otherwise a widget added on one side alone is offered by the editor and
  refused by the save.
  A widget may declare a size RANGE and be stretched within it. Two do:
  `run-of-show` (2×3 to 2×5) and `room-health` (1×1 to 3×3, the only 2D one —
  width adds columns, height adds rows, and both buy the same thing). The test
  either passes is that the extra space holds real content that continues past
  the edge — a scrolling order of service, a list of devices — rather than
  whitespace with a handle on it. Everything else is one authored size on
  purpose, and the bounds are enforced server-side, not just by the editor.
  **Following the room** (`src/lib/following.ts`, fixed 2026-08-10 after a
  field run) resolves to the LIVE show's plan and service time, and failing
  that to the service whose clock window contains now — where a window is
  `[startsAt, endsAt)`, falling back to the next service's start when Planning
  Center carries no end time. It used to mean "the first service time in the
  room's next plan", which is a fixed answer: a two-service Sunday left every
  following dashboard on the 9:30 through the 11:00 and past the end of the
  day. `usePlan` and `ViewBar` share the function, so the header cannot
  disagree with the cards under it. A PINNED plan still means its first service
  — that is what its dropdown says, and it is a choice someone made.
  **Awaiting a Sunday** — `run-of-show` driving real ProPresenter, and the Pi
  on the actual ATEM input, are the halves CI cannot certify. The **video
  position** shipped in 1.2.0 is verified against PP **21.4 on a laptop only**;
  the church runs **21.1**, where `/v1/transport` has never been probed. It
  fails to `null`, so the worst case is a bar that never appears — but treat it
  as unverified there until someone checks, and record what 21.1 answers in
  INTEGRATION-NOTES like every other version difference.
  **Video playback** (2026-08-10, probed against real PP 21.4): Now & Next
  shows a playing video's position on a new refcounted `room:*:video` topic
  (`server/videoWatcher.js`), which polls ProPresenter's media transport only
  while a screen is watching and works OUTSIDE a show — the pre-service loop is
  the most-watched video of the morning and has no show behind it. A playing
  video replaces the slide bar rather than sitting beside it, since PP reports
  a slide index during media playback too. The load-bearing detail: PP keeps a
  stopped video's uuid, name and duration indefinitely and `status/layers`
  still says `media: true`, so `is_playing` is the ONLY field meaning "moving
  now" — everything else pins a dead counter on a wall. Paused is
  indistinguishable from stopped, so both publish null. Shapes and all four
  observed states are in INTEGRATION-NOTES.
- **Backup & restore** (2026-08-11): Admin → General → System downloads one
  file carrying the whole installation — campuses, rooms, integrations, users,
  permissions, dashboards, checklists, branding, and every credential. Show
  history is opt-in because it is 99% of the bytes and almost none of the
  value (measured: 164,496 of ~170,000 rows were SPL samples, 16 MB vs 14 KB).
  Behind a new `system.backup` permission and audited.
  **Restore lives on the welcome screen and only works while no admin PIN
  exists** (`POST /api/setup/restore`). That endpoint has no permission check
  and cannot have a useful one — it runs before any credential exists — so
  what makes it safe is that it stops working the moment there is something to
  protect. A fresh install is already trust-on-first-use; a configured one
  would be a single-request takeover. Verified by deleting the gate and
  watching the test fail.
  Two traps handled: `VACUUM INTO` rather than copying `prodmesh.db` (WAL keeps
  recent commits in `-wal`, so a plain copy silently loses them), and a
  `PRAGMA user_version` stamp so a backup from a NEWER build is refused rather
  than half-applied. Restore does not hot-reload — module state was built from
  the replaced database — so it returns a restart instruction worded for the
  deployment kind.
- **Permission gating in the UI** (2026-08-04): `src/lib/identity.ts` publishes
  the auth status AppShell already fetches, so a page can hide a control it
  would only be refused for. Run of Show uses it for every `shows.operate`
  action; a read-only station gets a "Log in to operate" button, an operator
  without the permission gets a sentence instead of a dead button. A refusal
  that still reaches the server carries the permission's human label, so the
  identity dialog can name what is missing rather than showing a bare login
  form to someone already logged in. The server remains the boundary — this is
  guidance, and a failed action now says why inline instead of being swallowed.
- **Station management** (feature branch): Admin → Stations lists registered
  browsers with current-station and last-seen status. Administrators can rename
  stations, assign campus/room context, or revoke them. Revocation invalidates
  sessions created at that station; revoking the current browser returns it to
  first-run registration. Guarded by the extensible `stations.manage` permission.
- **Room configuration page** (2026-07-15): Admin → Campuses is a site/room
  overview (institution name, site chips, room rows with tile counts); each
  room's **Configure** opens `/admin/campuses/<roomId>` with Identity (name,
  site, stable room id), the Quick Access tile editor, and a Connectivity
  section that will absorb `rooms.config.js` one integration at a time.
  Rooms added in an unsaved draft show "save to configure" until saved.
  **Connectivity, first migration (2026-07-15): Planning Center service
  types** live in SQLite (`room_connectivity`, seeded from rooms.config.js
  on first boot) and are edited on the room page; saves apply to the live
  rooms map immediately (events, checklists, automation follow without a
  restart). Companion/PP wiring still in rooms.config.js.
- **Analysis source per room** (2026-07-18): the SPL provider is now a room
  connectivity setting (`analysis`, second `room_connectivity` migration) with
  interchangeable sources: **Smaart** (existing transport) or **ProdMesh
  Remote RTA** (`github.com/prodmesh/prodmesh-rta`, the free companion analyzer
  — plain WebSocket at `ws://host:8517/api/stream`, `server/integrations/rta.js`).
  `server/integrations/analysis.js` dispatches by `source`; both emit the same
  `{ ts, spl }` samples so reports/meters/analytics are source-agnostic. Edited
  on the room page (source, host/port, target/limit dB, metric, Smaart API
  password — password is write-only, redacted to `hasPassword` on reads).
  Seeding now writes a per-integration `connectivity_seeded:*` marker in
  `app_config`, after which the database is authoritative (a cleared config
  stays cleared even though rooms.config.js still declares a seed).
  **C-A ratio** (2026-07-18): RTA samples carry `ca` (C-weighted minus
  A-weighted, the bass-pressure indicator behind "too much bass" complaints)
  plus the app's configured target band (`targets.ca` in its API). Persisted
  as a nullable `ca` column on `spl_samples`; live meter shows a band gauge
  (dot on a 0–20 dB track, amber above the band), Show Report adds C-A
  avg/max (plain mean — C-A is already a difference, so no energy math).
  Smaart samples simply lack `ca` and every surface hides it.
  **Show-driven Smaart log control** (2026-07-21): Smaart only serves SPL for
  inputs that are calibrated **and actively logging** — real-time metering
  alone reads as `activeCalibratedInputs: []` (diagnosed live at FOH; starting
  logging lit the meter instantly). There is no logging RPC, but the keypress
  command handler exposes "Toggle SPL Logging" (verified on Suite 9.6.4);
  `smaart.setLogging(cfg, on)` looks the keypress up by description, checks
  real state first (the command is a toggle), fires only on mismatch, then
  polls to confirm. With `analysis.logControl` set (room-page checkbox,
  Smaart-only), show start ensures logging on and show end turns it off —
  only if the dashboard started it (flag persisted in the show file, so it
  survives a mid-show server restart). Fire-and-forget: a show never fails
  because Smaart is unreachable.
- **Code-review Tier 1 fixes** (2026-07-23, from the full architecture/tests/UI
  review): (1) connectivity saves now fire `onConnectivityChange`, and the show
  manager restarts the affected live watchers (SPL, PP timer, an active show's
  poller) — previously they held the config object captured at start, so edits
  didn't reach a running watcher until reconnect/show end; a save can also
  *start* a watcher the room couldn't run before (and begins recording SPL
  stats mid-show if analysis appears). (2) Settings panels report save results
  through one `Feedback` helper — errors are always red (several panels showed
  failures in green/muted), Schedules saves surface errors, connectivity save
  buttons disable while in flight. (3) UI polish: `.field` hover/disabled/
  placeholder + time-picker styling, keyboard focus ring on all buttons,
  `--accent-hover` token, themed color-swatch input, Analysis source uses
  SelectField. (4) `server/apiSecurity.test.js`: admin-PIN bootstrap boundary,
  login lockout (429), `shows.operate` gates, checklist mode-action permission
  matrix (nested `rooms.mode.change` + lockout override).
- **Server-owned topology** (2026-07-15, ADR 0009 milestone): the institution
  name, sites, rooms, and Quick Access tiles now live in SQLite (`sites`,
  `site_rooms`, `tiles`) and are served by `GET /api/config`; the frontend's
  static `src/config/dashboard.config.ts` is deleted (seeded verbatim into the
  database on first boot via `server/topologySeed.js`). **Admin → Campuses**
  edits the whole tree (draft + transactional whole-tree save, `config.manage`
  permission) — adding a site, room, or device tile is a browser action, no
  rebuild. The frontend is now purely an API client: every screen's topology
  comes from the server, refreshed live after a save. Since 2026-07-23 the
  server's own rooms map is built from these same tables (`server/
  roomsStore.js`), so a room created here is immediately a full server room.
- **First-run setup** (2026-07-27): a fresh install has no admin PIN and no
  campuses, so `SetupGate` sends every route to `/setup` — a four-step wizard
  outside the app shell (admin PIN → name + logo → first campus and its rooms →
  Planning Center/Slack, all skippable) that ends by stamping
  `settings.setupCompletedAt`. Each new room is given a Room Status tile so its
  Home card opens onto something. **Existing installs never see it:**
  `server/setup.js` stamps any box that already has a PIN and campuses complete
  once, at boot, so an `update.sh` restart can't drop a running church into
  first-run setup. Setup state is deliberately stored, not inferred from "is
  there a PIN?" — the PIN is step one, so inferring would end setup while the
  church is still on step two. `GET /api/setup` is public (both facts already
  are); `POST /api/setup/complete` needs `*`.
- **Bundled logo** (2026-07-27): the default mark is `src/assets/prodmesh-logo.svg`
  (the prodmesh icon). It used to be `logo.png` — the maintainer's church mark, present
  since the initial commit — so every church installing prodmesh saw another
  church's logo until they uploaded their own. The sidebar's
  `filter: brightness(0) invert(1)` went with it: it suited that one
  dark-on-transparent mark but flattened every uploaded colour logo into a white
  silhouette, while the Branding preview (no filter) showed the admin the logo
  they expected. **The original production install now shows the prodmesh mark until
  they upload their logo** via Admin → General → Branding; the file is in git
  history (`git show 9fe09e1:src/assets/logo.png > chills-logo.png`).
- **Planning Center person search** (2026-07-29): Admin → Users & access links a
  new login to its Planning Center person by name instead of a hand-copied
  nine-digit id (`PersonPicker`, `GET /api/planning-center/people`, gated on
  `users.manage`). It searches **Services** people — the team that serves —
  never the People product, which holds the whole congregation; results carry
  id, name and photo only, never email or phone. **Services /people ignores
  query filters** (verified live against a 139-person roster: `where[…]`, `?q=`
  and `?search=` all returned an identical `total_count`, unfiltered, with no
  error) — so the server caches the whole roster and matches locally, and no
  part of what an admin types is ever sent to Planning Center. Asking PC to
  search instead looked like it worked: it found whoever happened to fall in
  the first page and silently missed everyone after them. Currently-serving
  people sort first; archived ones stay findable but are marked `Inactive`.
  Unlike plans, it **never mocks**: with no token connected the control is the
  id field it replaced, because a fabricated id gets written into a user record
  and would later wear the identity of whoever really owns that number. A typed
  id still links directly when a token *is* connected — the way through when
  search is down — and shows as "Name not checked", since nothing looked it up.
- **Packaging** (2026-07-29): `server/deployment.js` answers how a copy was
  installed — `git` (a checkout with the deploy scripts), `container`, or
  `package` — and that decides three things that used to be assumed: the
  version (build stamp first, git second, `package.json` last), whether
  Admin → System offers an Update button at all, and what the Logs empty state
  tells you to do. `POST /api/system/update` refuses with 409 where self-update
  can't work, rather than spawning a bash script that isn't there. This also
  removed the only two Windows-hostile lines in the server (`spawn('bash')` and
  `execFileSync('git')`), which is what makes a desktop launcher possible later.
- **Docker** (2026-07-29): `Dockerfile` (two-stage, so the toolchain
  better-sqlite3 may need never ships), `docker-compose.yml` with everything
  mutable in one named volume at `/data`, and `.github/workflows/docker.yml`
  which builds on every PR, boots the container and checks what it says about
  itself, then publishes multi-arch to GHCR from main and version tags. Serves
  churches with a server or homelab. It does **not** serve the booth-Mac
  church, which is what the planned tray launcher is for — Docker is not an
  answer to "how do we install this" for a volunteer with one machine.
- **One topic stream per browser** (2026-08-03, ADR 0010 — first piece of 1.1):
  live data moved from one SSE per room carrying a fixed envelope to one SSE
  per browser carrying named topics. `server/streamHub.js` owns the topic
  registry and the refcounted producer lifecycle (`registerTopic(pattern,
  { valid, start, stop, snapshot })`); `GET /api/stream?topics=…` emits
  `{topic, data}`; `src/lib/stream.ts` holds the single connection and
  `useTopic()` is the push-side companion to `useQuery`. The room is now four
  topics — `show`, `timer`, `spl` and the new **`mode`**.
  - **Why**: a Dashboard view spanning six rooms would have opened six
    `EventSource`s, and browsers cap HTTP/1.1 at **six connections per origin**
    — with no TLS (deliberate, see the threat model) there is no HTTP/2 to
    escape into, so the sixth stream silently never opens.
  - **`room:<id>:mode` replaces per-browser polling.** `readRoomState()` hits
    Companion uncached and every RoomCard ran its own interval firing three
    requests — Home with six rooms in three browsers was 54 Companion reads a
    minute. Now: one poller per room however many are watching, published on
    change, and `bump()` after a mode press pushes immediately, so every screen
    in the building moves together instead of up to 30s apart.
  - `/api/rooms/:id/show/stream` **still works** — reimplemented as an adapter
    over the same three topics, so room-Mac homepages and bookmarks are
    unaffected and the two surfaces cannot drift.
  - Client migrations: RunOfShow, RoomCard and RoomStatus onto `useTopic`;
    ServicePanel, Services and ServiceReport off bespoke `setInterval` onto
    `useQuery` (RoomCard and ServicePanel now share one cache key, so a room's
    card and its panel make one Planning Center request between them).
  - **Backpressure conflates, never queues**: `res.write()` returning false was
    ignored, and Node buffers past that point without bound — an
    unauthenticated memory-exhaustion vector on a no-auth endpoint, and a real
    cost whenever a booth Mac sleeps. Now at most one pending frame per topic
    per connection, newest wins, flushed on `drain`. Correct *because every
    topic is a state snapshot*; would be wrong for an event-shaped topic, and
    the comment in `streamHub.js` says so. Frames are also serialized once per
    publish rather than once per subscriber.
  - Tests: `streamHub.test.js` (isolated — it resets the registry, so it must
    not import `index.js`) and `streamApi.test.js` (the endpoint, real app) are
    deliberately separate files. jsdom has no `EventSource`, so one is stubbed
    globally in `src/test/setup.ts`.
  - **Known limits if devices ever publish metrics into this** (ADR 0010's
    closing section): `MAX_TOPICS` is 64 per connection, and subscription is by
    exact topic with no wildcards. Neither is a redesign. Ingest and metric
    storage are separate questions, deliberately untouched.
- **Storage direction:** ADR 0009 supersedes the earlier JSON-for-config split.
  Server-managed configuration and operational facts live in SQLite; only
  deployment bootstrap and restricted secrets remain outside it. Portability is
  provided by versioned JSON import/export and consistent full-database backups.

## Roadmap / open threads (roughly prioritized)

1. **Run of Show — Phase 2 (ProPresenter live tracking) — WORKING (verified live).**
   Per-room ProPresenter client (`integrations/proPresenter.js`) + SSE endpoint
   (`/api/rooms/:id/run/:planId/stream`) stream the active playlist item; the view
   auto-advances in "follow" mode with manual override. Official API on port
   **62202** (not 49310 = legacy WS). Mapping is by playlist index (PC push
   preserves order) with tolerant name fallback. See ADR 0003.
   - Verified: triggering slides moves the highlight (~1s). Note: PP's
     `/v1/presentation/slide_index?chunked=true` pushes on every slide change —
     verified live on BOTH 21.4 and the church's 21.1 (2026-07-26).
     `pollRunState` still auto-detects and falls back to polling for builds that
     don't, so no version regresses — see ARCHITECTURE.md.
   - Remaining: set each room's real PP API port on-site (PP picks an ephemeral
     port per machine); wire the Youth Room (PP host TBD).
2. ~~Connectivity migration into the room page~~ **Complete 2026-07-21** (page
   built 2026-07-15; PC service types 2026-07-15, analysis source 2026-07-18,
   ProPresenter + Companion 2026-07-21). Pattern in `server/connectivity.js`:
   seed from rooms.config.js once (marker in `app_config`), SQLite owns it,
   applyConnectivity() assigns onto the live rooms map so consumers never
   change. ProPresenter (host/port, optional countdown-timer name; blank host
   = room has none) also made autostart eligibility per-cycle instead of
   per-boot, so connectivity edits enable/disable autostart without a restart.
   Companion is the special one: stored as one blob (host/port, state
   variable, mock, and the room's MODES — every Companion lays its buttons out
   differently, so each mode's page/row/column is per-room) and decomposed
   onto the four legacy room keys (`companion`/`state`/`mock`/`modes`).
   It can never be cleared — a room always keeps modes; "no Companion" is
   the Simulated (mock) checkbox. **Rooms-from-SQLite (2026-07-23)** finished
   the migration: the live rooms map is built from `site_rooms` +
   `room_connectivity` (`server/roomsStore.js`, rebuilt in place on every
   topology save; `show.syncAutomation()` reconciles watchers, deleted rooms
   lose their streams/shows). rooms.config.js is now *entirely* a
   fresh-install seed (plus the PRODMESH_LOCAL_TEST dev fixture) — creating a
   room in Admin → Campuses yields a real server room with simulated standard
   modes, ready to configure on its room page. New rooms with no stored
   Companion row show their live defaults in the editor (`companionFromRoom`).
3. **PC Calendar integration** — authoritative event→room→time. Unlocks:
   auto-populating lockout windows from real bookings (retire manual schedules),
   and confidently mapping "Special Events" to the right room.
4. **Youth Room/Chapel go live** — get their real modes + Companion button locations,
   enter them on the room page and untick Simulated. All in the browser now.
   (Auditorium is the template.)
5. **Room-Mac browser homepages** — set each room Mac to `http://<box>:8080/room/<id>`.
6. ~~Confirm production deployment on the Producer Mac~~ **Done 2026-07-14**:
   `install-service.sh` run on the producer Mac (launchd label `com.prodmesh.dashboard`,
   port 8080, logs in `~/prodmesh/logs/server.log`, RunAtLoad + KeepAlive). The
   Producer bridges the production LAN and the audio network, so it reaches
   Smaart directly.
7. ~~**1.1**~~ **SHIPPED 2026-08-04 (v1.1.0).** Three features, sequenced
   scaffolding → YouTube → launcher:
   - ~~Streaming/widget scaffolding for custom Dashboard views~~ **done**
     (ADR 0010): transport 2026-08-03, widget registry 2026-08-04. Widgets take
     `{roomId, config}` and **nothing else** — a stored layout is data, so a
     widget can only be placed from data if it needs nothing but data. They
     therefore fetch their own state, which costs nothing extra because pages
     and widgets share cache keys (`src/lib/keys.ts`). `countdown` and
     `loudness` are registered; Run of Show renders through the registry so the
     contract is exercised by a real page. Its Start/End/Prev/Next stays a page
     component — no dashboard would place it. Spans are now arbitrary 1–12
     columns, with `half`/`third`/`two-thirds` as aliases. The Dashboard
     *feature* — stored, editable layouts — is 1.5; 1.1 laid the track.
   - ~~**YouTube Live viewership**~~ **built 2026-08-04, awaiting a real
     channel.** `concurrentViewers` vanishes when a stream ends and is absent
     if the broadcaster hides the counter, so the curve can only be our own
     recording: `stream_samples` mirrors `spl_samples` (same instanceId key),
     aggregated into `show_summaries` so the KPIs outlive sample pruning —
     which matters here because YouTube cannot re-supply them. Retention is a
     year, not 90 days, for the same reason. API key only (`youtube.apiKey`
     secret); `videos.list` costs 1 quota unit against 10k/day and
     `search.list` costs 100, so the video id is resolved on a 15-min TTL and
     viewers polled every 30s. Fifth `room_connectivity` integration, edited
     on the room page. New `room:<id>:youtube` topic + `viewers` widget; Show
     Report gains peak/avg/duration and an inline-SVG sparkline (no chart
     library — the no-CDN rule makes every dependency a bundle decision).
     **The room owns the CHANNEL; a service time owns the video** — a channel
     pre-creates one broadcast per service, so 8:00 and 9:30 on one plan are
     different videos and a room-level pin would double-report one of them.
     Pins live in `show_config.videos` keyed by timeId, picked on Event Detail
     from the channel's live + scheduled broadcasts (labelled with the
     scheduled time, since they all share a title). Tri-state: absent = auto,
     `null` = **not streamed**, id = pinned. "Not streamed" is not the same as
     "nothing pinned" — a plan with five service times may broadcast two, and
     on auto the rest would record a stream left running from an earlier
     service. Usually nothing needs setting: the watcher finds whatever is
     live, which is already right per service.
     **A hidden counter reads as `null`, never `0`** — a fabricated attendance
     figure is worse than a blank one, which is also why there is no automatic
     mock (`youtube: { mock: true }` is a dev fixture, like `analysis.mock`).
     **Not verified against a real broadcast** — mock mode and unit tests
     certify storage, aggregation and rendering only.
   - **Desktop launcher** (Electron, matching Companion) — **built
     2026-08-04, unsigned so far.** Menu-bar app for the booth-Mac church that
     can't run Docker: tray icon, status window showing the LAN addresses other
     screens should point at, and the Express server running **in Electron's
     main process** (imported, not forked — one copy of the code, no orphaned
     server on a force-quit). `deployment.kind()` gains `desktop`, which makes
     Admin → System refuse the Update button and point at the tray instead.
     Data lives in `app.getPath('userData')/data`, outside the bundle, so an
     update replaces the program and never a church's database.
     - **Its own package**, not a workspace: `deploy/update.sh` runs `npm ci`
       at the root on the production box, and a root Electron devDependency
       would push ~200MB onto every git-install church for something they will
       never run. `desktop/build.mjs` stages a tree that mirrors the repo, so
       `../server/index.js` resolves the same in dev and packaged.
     - **better-sqlite3 must be built for Electron's ABI, not Node's.** The
       staged install uses `--ignore-scripts` deliberately: the default fetches
       a Node-ABI binary this tree never uses, and when no prebuild matches it
       compiles with node-gyp, which needs Python's `distutils` — removed in
       3.12, so it fails building something we'd discard. `electron-rebuild`
       does the real one.
     - CI (`desktop.yml`) builds macOS + Windows on every branch, publishes
       installers only from a `v*` tag, and smoke-tests the packaged app
       **under Electron** (`PRODMESH_SMOKE=1`) — plain `node` cannot load the
       tree at all, and an ABI mismatch is the likeliest way this ships broken.
     - **Signed, notarized and stapled.** Verified on the CI artifact itself:
       `spctl` reports `accepted, source=Notarized Developer ID`, and a clean
       Mac opened it with no Gatekeeper prompt. (`spctl` on the *.dmg* says
       "no usable signature" — expected; electron-builder staples the app and
       wraps it in an unsigned DMG, and Gatekeeper judges the app.) Windows
       builds unsigned: SmartScreen shows an "unrecognized app" prompt that a
       user can click through, and removing it needs a separate certificate.
     - **Documentation** (`docs/wiki/`): nine user-facing pages — Home,
       Installation, First-Run-Setup, Run-of-Show, Checklists,
       Rooms-and-Campuses, User-Management, Integrations and
       Integration-Caveats. Written for volunteers, verified against source
       rather than paraphrased from comments. `Integration-Caveats` is the
       one that saves time on a Sunday: Smaart needing inputs calibrated AND
       logging, ProPresenter coalescing rapid slide advances, and YouTube
       viewer counts existing only while a broadcast is live.
     - Writing those docs found three drifts between code and its own
       comments: Admin → System pointed at a tray item that did not exist,
       the launcher's first-run window only opened on an error despite a
       comment claiming otherwise, and the README's Node version disagreed
       with `.nvmrc`. All fixed before the tag.
     - Four bugs came from real CI runs rather than being reasoned away:
       Windows `.cmd` resolution (`ENOENT`, then `EINVAL` — Node refuses to
       execFile a `.cmd` without `shell:true` since the CVE-2024-27980 fix); a
       smoke test pointed at the shared staging tree, which after a multi-arch
       build holds only the last architecture; and a sandboxed preload with no
       `shell`, which made the one button in the UI silently do nothing.
8. **Later widgets on Run of Show:** SMAART loudness, on-air.
9. **Safe change — preview / diff / rollback for room programming.** (Idea, not
   yet designed.) A control surface gets programmed once and then frozen: a
   volunteer who is unsure what a mode edit will actually *do* will simply not
   touch it, because Sunday is coming and a wrong guess is visible to the whole
   room. So configuration rots in place and the one person who understands it
   becomes a dependency. This is the general failure mode of every custom
   control system — large venues hit the same wall and cope by only reprogramming
   during a shutdown, which is a luxury a church that meets weekly does not have.
   The fix is not faster editing; it is making a change **reversible** so trying
   one stops being a gamble:
   - show what a mode would do before pressing it (which Companion buttons, on
     which page/row/column, against which state variable)
   - diff a pending room config against what is live
   - one-tap revert to the previous known-good config
   Open questions before this is a design: what is the unit of change (a mode? a
   room? the whole topology?), and what "preview" can honestly mean given
   Companion presses are fire-and-forget with no dry-run. `room_connectivity`
   already being SQLite-owned and rebuilt in place (item 2) is the natural place
   to hang config history.

## Deferred tech debt (known, low-risk)

- Full browser end-to-end tests against a running server (critical component
  interactions are now covered in jsdom; live integration flows remain manual).
- PIN brute-force throttling on legacy `/api/auth/admin` (named-user login is throttled).
- Backend TypeScript (currently plain JS).
- Legacy Admin-PIN sessions reset on server restart; named-user sessions persist
  in SQLite and expire after eight hours.

## Decisions on hold pending info

- **Auditorium "Special Events"** mapping omitted until Calendar can confirm room.
- **South Campus** rooms/config — once that campus opens.
