# 0013 — The public API is an allowlist

Status: proposed · 2026-10-12 · planned in [PLAN-1.5.md](../PLAN-1.5.md) · implements
[#45](https://github.com/prodmesh/prodmesh/issues/45)

## Context

The v1.5 milestone promises *"ProdMesh's first LTS release where APIs will be
stable enough to integrate with in other apps"*. Three things stand in the way,
and the first is the one that shaped this decision.

**The surface is 100 endpoints, and most of them are our own admin screens.**
Counted across the eleven routers in `server/routes/` at `a38c140` — the figure
will drift, and the allowlist below is the part that matters:

| Router | Endpoints | What it mostly is |
|---|---|---|
| `adminConfig.js` | 35 | setup wizard, secrets, branding, per-room connectivity editors |
| `auth.js` | 18 | stations, users, groups, PINs |
| `events.js` | 13 | plans, show config, checklist templates |
| `system.js` | 10 | version, health, update, backup, **restore**, logs, audit |
| `views.js` | 6 | dashboard and display layouts |
| `shows.js` | 5 | show lifecycle |
| `rooms.js`, `proPresenter.js` | 4 each | room state and mode; PP read and control |
| `assistance.js` | 3 | the help button |
| `calendar.js`, `stream.js` | 1 each | bookings; the topic stream |

A third of the surface is the configuration UI talking to its own server.
Freezing that would freeze the shape of our own Admin screens — exactly the part
that should stay free to change. "Version the API" is therefore the wrong frame;
the question is *which* API, and the honest answer is a small fraction of what
exists.

**There is no machine credential.** `httpAuth.js:6` reads a bearer token, but
every session is an 8-hour, login-derived *user* session (`authStore.js`,
`SESSION_TTL`). An integrating app would have to store a human's PIN and
re-login three times a day.

**LTS is also a promise about storage**, and a release that claims it cannot
then change SQLite schema under a church. This codebase already knows how to
version a contract: `backup.js` carries `FORMAT = 1` and refuses a mismatched
envelope with a sentence a human can act on.

## Decision

### v1 is an allowlist, and everything else under it is 404

This is the mechanism that makes the freeze a promise rather than a rename. If
`/api/v1/*` simply mirrored the existing surface, all 100 endpoints would become
promises by accident, which is worse than having no version at all — it would
commit us to the admin UI's current shape for the life of 1.5.x.

So `/api/v1` serves **only** the allowlisted set. A path under `/api/v1` that is
not on the list returns 404, not a proxy to the legacy route.

Implementation is one middleware, beside the restore-seal gate that already
intercepts `/api` in `server/index.js`: match the allowlist, rewrite `req.url` to
drop the `/v1`, mark `req.apiVersion`, otherwise 404. No handler changes at all —
the routers "declare full `/api/...` paths", as the comment above them says, and
they keep doing so.

### What is in v1

The test is two questions, and an endpoint has to pass both:

1. **Would a third party reasonably depend on it?**
2. **Does its authorization model admit a non-browser caller?**

**Read — the observation surface**

- `GET /api/rooms`, `/api/rooms/:id`, `/api/rooms/:id/state`
- `GET /api/rooms/:id/show`, `/api/rooms/:id/service`
- `GET /api/services`, `/api/rooms/:id/plan/:planId`
- `GET /api/rooms/:id/plan/:planId/report`, `GET /api/history`
- `GET /api/calendar`
- `GET /api/rooms/:id/propresenter`
- `GET /api/about`, `/api/system/version`, `/api/system/health`
- `GET /api/stream?topics=…`

**Write — the control surface**

- `POST /api/rooms/:id/mode`
- `POST /api/rooms/:id/show/start`, `/end`, `/current`
- `POST /api/rooms/:id/event/:planId/checklist/:itemId`

Twenty of a hundred. The stream is the most valuable item on the list, because a
subscriber gets state changes as they happen rather than polling for them.

### Writes are in v1

Two independent reasons, and they agree.

The realistic first integrator is not a vendor — it is a church tech person who
wants a Companion button that starts the show, or the current show state on a
stream deck. A read-only API does not serve the person who asked for this.

And federation settles it anyway: instance-to-instance sync
([0014](0014-a-server-per-site.md)) is a write, and ProdMesh is its own first API
consumer.

### ProPresenter control is *not* in v1, and the reason generalises

`POST /api/rooms/:id/propresenter/control` passes the first test and fails the
second. Beyond `requirePermission('propresenter.control')` it requires a
`viewId` and `widgetId` naming a **stored dashboard widget** with
`config.slideControls` enabled, and refuses otherwise — the deliberate design
that the database decides what may be controlled, not the browser.

A service token has no dashboard widget. So the endpoint is not merely unsuited
to a token; it is uncallable by one. Putting it in v1 would mean either shipping
a promise nothing can use, or weakening a gate that exists on purpose.

This is why the second test earns its place: an endpoint whose authorization
story runs through a stored UI artifact is browser-shaped, whatever it does. If a
token should be able to drive ProPresenter, that wants a *different* endpoint
with its own authorization argument — a new decision, not a freeze.

`/api/rooms/:id/mode` and the checklist write pass both tests cleanly: a
permission, plus the lockout check (`modeLockError`), and nothing that assumes a
browser. Worth noting that the checklist write re-checks `rooms.mode.change` and
the lockout when an item carries a mode action — a checklist cannot sidestep a
protected window, and neither can a token.

### Out of v1, deliberately

- **`adminConfig.js` entirely** — setup, secrets, branding, connectivity
  editors. This is the Admin UI's private surface; its shape should follow its
  screens.
- **`views.js`** — a stored layout is data we evolve ([0010](0010-topic-stream-and-widgets.md),
  [0011](0011-views.md)). Freezing the layout format would freeze the editor.
- **User, group and station management** — same reason, plus it is the one place
  where a stable external contract is actively undesirable.
- **`system.update`, `system/backup`, `system/logs`, `system/audit`** — operational
  and sharp-edged. Backup especially: it carries the Planning Center token, every
  PIN and every credential, as its own permission description says. A frozen,
  documented contract on that endpoint is a frozen, documented contract on
  exfiltrating a church's entire install.
- **`POST /api/setup/restore`** — backup's counterpart, and the sharpest endpoint
  in the tree: a 64 MB raw body that replaces an install, gated on
  `isAdminSetupNeeded()`. Nothing about it should ever be a promise.
- **`/api/rooms/:id/propresenter/diagnostics`** — diagnostics are unstable by
  definition; that is what makes them useful.
- **`assistance.js`** — station-shaped, and the only router that hard-requires
  `req.station` (`400 Unknown station`).

Out of v1 does not mean deleted or discouraged. It means unpromised: it keeps
working at `/api/…` and may change in a minor release.

### Retire the dead endpoint rather than freeze it

`GET /api/rooms/:id/show/stream` has **no caller in `src/`**. ADR 0010's own
status line says it supersedes the per-room stream from ADR 0004; this is the
leftover that supersession never removed.

It must be removed *before* the freeze, not carried through it. Freezing it
would commit us to maintaining dead code for the life of 1.5.x — the exact
mistake a version boundary makes permanent. (Confirm no out-of-tree caller
first; a room-Mac homepage is a browser hitting the UI, not this route, but the
check is cheap.)

### A service token is a principal, not a person — and it replaces the station

This settles the open question about `x-prodmesh-station`: **the header stays
browser-only and outside the frozen surface.**

The reasoning is that a station and a token do the same job through different
doors. [ADR 0008](0008-stations-users-and-acls.md) introduced the station
because a browser in a booth is anonymous but should still be identifiable; a
service token identifies an *app* for the same reason. So a token never carries
a station, and audit rows name the token where they would otherwise name a
station.

That keeps faith with [0012](0012-one-admin-identity.md): one kind of identity,
whichever door it came through, and no second flag that every permission check
has to remember to consult. `resolveIdentity` (`server/index.js:115`) already
runs ahead of every router, so token resolution has one home.

Tokens are created in Admin, scoped by the dotted ACLs ADR 0008 already defines,
revocable, and named in the audit log.

### Reads stay open; a token carries write authority and a name

Today anonymous means read everything, and permissions gate writes — a dashboard
is readable by an unregistered browser by design. So a token with no permissions
has precisely anonymous's reach, and a "read-only token" is not a meaningful
restriction. Inventing a read-permission model is a different and larger change;
it is not needed to make the API integrable, and it is not in this ADR.

What a token adds is therefore: **write authority, attribution, revocation, and
a per-app identity to throttle.** That is also consistent with 0014, where a
visiting principal from a paired site is read-only by default — read is the
floor everywhere.

### The login lockout has to move before a second credential path exists

`FAILURE_CAP` and the `429 temporarily_locked` responses live **inside
`server/routes/auth.js`**, route-local. A token-authenticated request handled by
`rooms.js` or `shows.js` inherits none of it.

`CLAUDE.md` is explicit that unauthenticated resource exhaustion and privilege
escalation are inside the threat model for a LAN appliance. A credential path
that skips the lockout *is* the way around it. So the throttle becomes shared
before the token path ships — not after, and not as a follow-up issue.

### Deprecation, for software that updates on its own schedule

- An endpoint in v1 keeps working for **all of 1.5.x**.
- Adding a field is not breaking. Removing or renaming one is.
- Removal or an incompatible change needs a **new prefix with an overlap
  period**, never a quiet deletion.
- Overlap is measured **in releases, not weeks**, because `deploy/update.sh`
  follows the newest `vX.Y.Z` tag and a church updates when it updates. Two
  versions are always live in the wild; an overlap shorter than the slowest
  church is not an overlap.
- `/api/…` without a version stays as a working alias for the allowlisted
  routes, and carries no promise for anything else.

**The stream is part of this contract**, not an exception to it: the topic names
from ADR 0010 (`room:<id>:<name>`, `integration:<id>`, and `site:<id>:*` from
0014), the frame shape, the retained-value-for-joiners behaviour, and
`MAX_TOPICS = 64`.

### The schema promise

Migrations stay forward-only and named, as `db.js` already does them, and nothing
destructive lands within 1.5.x. Where a stored format must change, it changes the
way `backup.js` already demonstrates: an explicit version on the envelope and a
refusal that tells a human what happened.

## Consequences

- **Our own frontend keeps using `/api/…`** and is not migrated to `/api/v1`. It
  ships with the server, so it needs no stability promise, and pointing it at v1
  would quietly make every endpoint it touches public.
- **The allowlist is the document.** Whatever is generated from it — the endpoint
  list, the published contract — comes from the same array the middleware
  enforces, so the documentation cannot drift from the promise.
- **A token can do strictly less than an admin**, because reads are open anyway
  and writes are ACL-scoped. The worst case for a leaked token is bounded by its
  scopes, which is the reason to scope them narrowly at creation.
- **Audit rows gain a third kind of actor** — user, station, and now token.
  Anything reading the audit trail needs to render that.
- **One endpoint gets deleted** (`show/stream`), which is a visible change in a
  release otherwise concerned with promising not to change things. Better now
  than in 2.0.

## Not decided here

- **Which endpoints join v1 later.** The list above is deliberately the smallest
  defensible set. Adding to it is cheap and safe; removing from it is neither, so
  err toward adding in 1.6 once somebody has actually integrated.
- **A read-permission model**, and with it genuinely read-restricted tokens.
- **A control endpoint for ProPresenter that a token can call**, per the
  reasoning above.
- **Whether the peer protocol from 0014 is part of v1.** An instance is an API
  client, so it probably should be — but freezing a contract in the release that
  first implements it is how contracts get frozen wrong.
- **Pagination and rate-limit response shapes.** `GET /api/history` is the first
  endpoint that will want paging; deciding its shape before a consumer exists
  risks guessing wrong in a frozen surface.

## Known limits

- **A frozen surface is only as honest as its tests.** Nothing currently fails
  when a response shape changes, so the freeze needs contract tests over the
  allowlist, or it is a comment rather than a guarantee.
- **The allowlist is a path list, so it promises paths, not semantics.** A
  handler could keep its URL and change what it means. Only tests and review
  catch that.
- **`GET /api/system/health` exposes which integrations exist and whether they
  are reachable** — mild reconnaissance value on a bridged network. Consistent
  with the LAN-appliance bar, and worth remembering if that bar ever moves.
