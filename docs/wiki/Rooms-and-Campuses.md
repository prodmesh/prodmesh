Modeling your building — sites, rooms, and what each room connects to — edited entirely in the browser.

# Rooms and Campuses

prodmesh models a church as a tree: **sites** (campuses) contain **rooms**
(auditoriums), and each room has **Quick Access tiles** and its own
integration connections. All of it — from adding a whole new campus down to
one room's ProPresenter port — is edited in **Admin → Campuses**, in the
browser, with no rebuild or redeploy. Nothing is final until you press
**Save changes**; the editor works on a local draft and replaces the whole
tree on the server transactionally when you save.

## The topology: sites, rooms, tiles

**Admin → Campuses** shows a bar of sites down the side. Selecting one shows
its rooms as rows, and a room row's **Configure** link opens that room's own
page (`/admin/campuses/:roomId`).

### Adding a campus

**+ Add site** creates a new site (defaulting to name "New Site", status
Disabled). Give it a real name and set its **Status** to Active when it's
ready to show up around the app — a Disabled site stays in the config but
doesn't appear where an operator would pick a room.

### Adding a room

Inside a site, **+ Add room** adds a room (default name "New Room", no
tiles). A newly added room only gets a **Configure** link, and only gets a
working Quick Access/connectivity page, once you've pressed **Save changes**
— an unsaved room shows *"save to configure"* instead of a link.

Rooms and sites can be reordered (up/down arrows) and removed (trash icon).
A room's **Room ID** is shown but not editable once it exists — it's the
stable identifier every server integration, watcher, and stored show is keyed
against.

## The room Configure page

Opening **Configure** on a room shows three sections: identity (name, site,
room ID), **Quick Access tiles**, and **Integrations** (connectivity).

### Quick Access tiles

Tiles are the shortcuts a room's Home screen shows for jumping straight to a
device. Each tile has a type, and the type determines what clicking it does:

| Type | Behavior |
|---|---|
| **Room Status link** | Navigates in-app to a route you set (typically `/room/<roomId>`). |
| **Companion** | Opens that Companion install's web UI, at `http://<host>:<port>/`, in a new tab. |
| **Screen Sharing (Mac)** | Opens `vnc://<host>` (with a username prefilled, if set) — macOS hands this straight to Screen Sharing.app. |
| **Web link** | Opens an arbitrary URL in a new tab — for any HTTP device UI (a video switcher, a lighting console's remote, a PTZ camera). |
| **Placeholder** | Not clickable — a slot to fill in once a device's IP is known. |

Each tile has a label, an optional note (subtitle), and an optional icon
(an emoji override; otherwise the type's default icon shows). **+ Add tile**
adds one; the up/down/trash icons on each tile reorder or remove it.

### Integrations (connectivity)

Below tiles, **Integrations** holds every live connection the room has, each
in its own editor with a status chip (Connected / Unreachable / Not checked) and
a manual refresh. This section only appears once the room exists on the
server — save the topology above first if you just added the room.

- **Companion & modes** — the room's Bitfocus Companion install (host, port,
  the Companion custom variable that reports current state) and the room's
  modes (each with its Companion button page/row/column and its colour,
  plus optionally a *match* value and a *standby* flag — see below).
  Leave the host blank and save to remove Companion from this room entirely.
  Below the host is the list of **modes** (Sunday, Mid-Week, Standby, …). Each mode has a label, an
  id, a color, the raw value that variable reports when that mode is active
  (**Match**), and — optionally — the Companion button (page/row/column) that
  puts the room into it. A mode can be flagged **Standby** — while the room is
  currently in a Standby-flagged mode, Room Status hides the other
  Standby-flagged buttons (there's no point offering to switch to the state
  you're already in); the moment the room leaves Standby, the full button
  list reappears. Every Companion installation lays out its buttons
  differently, so page/row/column has to be set to match this room's actual
  layout.

- **Planning Center service types** — which Planning Center event types this
  room hosts services for (a name plus the numeric service type ID, found in
  that service type's Planning Center Services URL). A room with none
  configured shows no service plans, no checklist, and no Run of Show.

- **Analysis source** — where the room's loudness (SPL) numbers come from:
  **Smaart** or **ProdMesh Remote RTA**, with host/port, target/limit dB
  (the goals shown on the live meter and in show reports), and an optional
  metric name override. Smaart can also have an API password and a
  **"Start/stop SPL logging with shows"** option, which turns Smaart's own SPL
  logging on when a show starts and off when it ends (only if the show was
  the one that turned it on — an engineer's own manually-started logging
  session survives a show).

- **YouTube Live** — the room's YouTube **channel ID** (not a specific video
  — a channel pre-creates a new broadcast per service, so the room owns the
  channel and each service time owns whichever broadcast turns out to be
  live). Leave it blank if the room isn't streamed. Needs a YouTube API key
  configured under Admin → General → Integrations to actually poll.

- **ProPresenter** — the room's ProPresenter API host/port and, optionally,
  which countdown timer name is the "service start" timer Run of Show's
  countdown widget should prefer. Leave the host blank if the room has no
  ProPresenter.

### Rooms without a Companion

A room with **no host set** under Companion & modes has no Companion at all.
Its mode controls stay hidden until a Companion is configured for the room —
there is no simulated state for a room's mode to live in. Add the room's
Companion host, the state variable its mode buttons change, and the modes
themselves, and the room goes live. Use a local-test room
(`PRODMESH_LOCAL_TEST=1`) when you want to exercise the UI without a real
Companion on the network.

## Room modes and schedule-based lockouts

A room's **modes** are the states Room Status can put it in (Sunday, setup,
standby, etc.), each pressing a Companion button. Any mode can be locked
during specific windows in **Admin → General → Schedules & Locks**: pick a
room, add a window (days of the week, start/end time), and check which modes
are locked during that window.

While a locked window is active, switching to one of its locked modes from
Room Status requires the room's **Override PIN**, set in **Admin → General →
Security**. Locks only take effect once an Override PIN exists — a lock with
no PIN to override it would just fail closed, so the system doesn't advertise
any lock as active until a PIN is set. Someone with the
`rooms.mode.override_lock` permission can bypass the PIN prompt entirely.

A checklist item that presses a mode button (see [Checklists](Checklists.md))
goes through the exact same lockout check — it can't be used to bypass a
protected window.

## See also

- [Run of Show](Run-of-Show.md) — what a room's ProPresenter, analysis, and
  YouTube connections drive once a service is live.
- [Checklists](Checklists.md) — the per-event-type checklists that can press a
  room's Companion button, subject to the same lockouts described above.
