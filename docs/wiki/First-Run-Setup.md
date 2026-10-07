What happens the first time anyone opens prodmesh, and what to do right after.

# First-run setup

A fresh install has no admin PIN and no campuses configured. Rather than show
an empty dashboard, prodmesh redirects every route to a setup wizard
(`/setup`) until it's complete. This happens regardless of which URL you
open — the wizard is the whole app until it's done.

If the setup check itself can't be reached (for example, a booth screen with
a flaky connection), the app fails **open** and shows the dashboard rather
than blocking on the check — a broken setup check should never lock a room
screen out on a Sunday morning.

**Existing installs never see this.** If a box already has an admin PIN and
at least one campus configured the first time the server starts, it's
automatically marked as already set up — this is how an upgrade of an
existing install avoids being dropped back into the wizard. Once setup is
completed (or auto-marked complete), that fact is stored, not re-derived from
whether a PIN and campus currently exist — so it won't reappear later if, say,
every campus is later deleted.

## The steps

The wizard is four steps after a welcome screen, and it's resumable: every
step saves as you go, so closing the tab mid-setup loses at most the step in
progress — reopening the dashboard picks back up wherever you left off.

### Welcome

A one-screen overview naming the four steps ahead: *Admin PIN*, *Your
church*, *Campus & rooms*, *Integrations*. Not skippable — it's the entry
point.

### 1 · Admin PIN

Create a PIN of at least 6 characters. This one PIN gates everything under
Admin — campuses, users, credentials, system updates. Not optional, and not
skippable: nothing else in the wizard is reachable until it's set.

If you're resuming setup on a device where the PIN was already created but
this browser isn't signed in, this step instead asks you to enter the
existing PIN rather than create a new one.

> There's no self-service PIN reset. Recovering a forgotten admin PIN means
> editing a file on the server itself.

### 2 · Your church

Sets the church's name and, optionally, a logo (PNG, JPEG, GIF or WebP, under
256 KB) — both shown in the sidebar on every screen and on reports. A live
preview shows how the sidebar will look. The logo step is explicitly
optional and can be added later; the name is required to continue.

### 3 · Campus & rooms

Creates the first campus (a physical location, name required) and at least
one room within it (a space with its own production setup — an auditorium, a
chapel, a kids' room). One room is pre-filled ("Auditorium") and can be
renamed, removed, or added to, but at least one is required to continue.
Both the campus and its rooms can be renamed or added to later.

### 4 · Integrations

Optionally connect Planning Center (a Personal Access Token, for pulling in
service plans) and Slack (a bot token, for the booth to post alerts to a
channel). This step is the one place in the wizard with an explicit **Skip
for now** button — nothing here is required, and everything here can be set
up later from **Admin → General**.

### Done

A summary of what was configured, and a set of shortcuts to jump straight
into follow-up admin screens: **Add your team**, **Name your stations**,
**Connect each room**, and **Build a checklist**. Finishing here is what
actually stamps setup as complete and releases the redirect.

## Your first 30 minutes

The wizard hands you a working install, but not yet a usable one — rooms
still need real integrations wired up, and other people still need logins.
A realistic order:

1. **Name this machine as a station.** The moment setup finishes, the app
   itself will prompt for this — it's how prodmesh tells the booth machine
   from someone's office laptop. You can't skip past it on the machine you
   just finished setup on.
2. **Connect each room's gear**, at **Admin → Campuses → Configure**:
   Bitfocus Companion for mode control, ProPresenter for Run of Show, and
   whatever else that room uses. Every integration is optional — a room works
   before any hardware is wired up, so this can happen gradually. Companion is
   the exception to any "sample data" pattern: a room with no Companion just
   has no mode controls until its Companion is configured.
3. **Add your team**, at **Admin → Users** — individual logins so people
   aren't sharing the one admin PIN, and so you can hand out narrower
   permissions than "everything."
4. **Name the other stations** that will open prodmesh, at
   **Admin → Stations** — the booth machine, the FOH laptop, whatever else.
5. **Build a startup checklist**, at **Admin → Checklists** — what the team
   runs before a service, optionally pressing real Companion buttons as
   checklist items.
6. **Point a room screen at the box.** Each room's card on the Home screen
   links straight to its status page (`/room/<roomId>`) — open that link from
   the room's own machine and set it as that browser's homepage. This is the
   pastor-facing status screen the rest of this setup was for.
