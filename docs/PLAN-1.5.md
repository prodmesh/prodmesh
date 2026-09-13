# v1.5 — release plan

Status: draft, 2026-09-13 · Milestone due 2026-11-23 · Planned from the
[v1.5 milestone](https://github.com/prodmesh/prodmesh/milestone/2) and
[VISION.md](./VISION.md).

[STATE.md](./STATE.md) says where the project *is*. This says what 1.5 is
*for*, what is in and out, and why — so the scope can be argued with now rather
than discovered in November.

## Theme: the first release something else can build against

The milestone description sets the bar:

> 1.5 will be ProdMesh's first LTS release where APIs will be stable enough to
> integrate with in other apps

That is a promise about the API surface, and none of the four issues already on
the milestone delivers it. Today the claim is not backed:

- **~100 endpoints across 11 route modules** (`server/routes/`), all
  unversioned `/api/…`. No deprecation policy, no documented contract. Nothing
  stops an ordinary refactor from breaking an integrator.
- **There is no machine credential.** `httpAuth.js` reads a bearer token, but
  every session is an 8-hour login-derived *user* session (`authStore.js`,
  `SESSION_TTL`). Another app would have to store a human's PIN and re-login
  three times a day.
- **LTS is a schema promise too.** Calling a release LTS and then changing
  SQLite schema under a church is the thing LTS exists to forbid.

The real-time half is the part already worth integrating against:
`/api/stream?topics=` and the topic model from
[ADR 0010](./decisions/0010-topic-stream-and-widgets.md).

So the headline of 1.5 is not a widget. It is making that sentence true.

## In scope

### 1. API v1 + service tokens — the headline (needs an issue and an ADR)

- **Freeze a surface under `/api/v1`.** Not all ~100 endpoints: v1 is the set
  we are willing to keep working for the life of 1.5.x. Everything else stays
  unversioned and explicitly unpromised.
- **Keep `/api/…` working as an alias** through a deprecation window. This
  matters more here than in a cloud product: `deploy/update.sh` follows tags
  and a church updates when it updates, so two versions are live in the wild at
  any moment.
- **Service tokens** — a credential not tied to a human session, created in
  Admin, scoped by the dotted ACLs from
  [ADR 0008](./decisions/0008-stations-users-and-acls.md), revocable, and named
  in audit rows the way a station is. The ACL model is already the right shape
  for this; what is missing is a principal that is not a person.
- **Throttling on the token path.** Unauthenticated resource exhaustion is
  inside the threat model in `CLAUDE.md`; a token that skips the login lockout
  must not become the way around it.
- **The contract, written down**: the endpoint list, the SSE topics under the
  same promise, the deprecation policy, and a schema-compatibility statement
  (migrations forward-only, nothing destructive within 1.5.x).
- **ADR 0013 — versioned public API and service tokens.**

Open questions to settle in the ADR: which endpoints make v1 (read paths are
obvious; writes need a case each), whether write access is in v1 at all, and
whether the `x-prodmesh-station` header stays part of the public contract or
becomes browser-only.

### 2. Desktop, app-shaped — [#18](https://github.com/prodmesh/prodmesh/issues/18), split

#18 is four features in one issue and as written is larger than the whole
window. Split it; take the first three plus the cheap half of the fourth:

| Piece | Size | Notes |
|---|---|---|
| Frontend rendered in the desktop window | small | `desktop/main.js` loads `status.html` today; the server already runs in Electron's main process, so this is mostly pointing a `BrowserWindow` at the local port. Delivers most of the issue's felt value |
| Stable ProdMesh **system identity**, distinct from the host machine | small, architectural | Must land before discovery — it is what a client reconnects *to* |
| **mDNS/Bonjour discovery** + connect to an instance running elsewhere | medium | The same primitive multi-campus needs, per the maintainer's comment on #18 |
| **Restore onto new hardware** from a backup | small | `server/backup.js` + `restoreSeal.js` already exist per [ADR 0009](./decisions/0009-server-owned-configuration-and-portable-backups.md); this is largely a UX wrapper on what is there |

Deferred (see below): live host-to-host handoff with clients following.

### 3. OSC buttons — [#30](https://github.com/prodmesh/prodmesh/issues/30), split

OSC ships; MIDI does not. OSC is UDP from the server — pure JS, no new
dependency risk on any deploy path. Native MIDI needs a native module, which
collides with all three: a Docker container has no host MIDI ports, `npm ci` on
a git-install church gains a compile step, and Electron needs the ABI rebuild
that `better-sqlite3` already taught us.

The OSC button is a **control** widget, so unlike the Companion emulator
surface it goes through `requirePermission` and writes an audit row. The
emulator's missing audit trail is a known and accepted gap because the browser
talks straight to Companion; here we own the send path and have no excuse.
Destinations are configured per room, following the `room_connectivity`
pattern.

MIDI moves to a sidecar issue in 1.6 — which merges it with #31 (below), since
they need the same sidecar.

### 4. Optional telemetry — [#37](https://github.com/prodmesh/prodmesh/issues/37)

Small code, large trust surface. It runs straight at "no runtime CDN or
internet dependencies" and the LAN-appliance threat model, so it needs an ADR
before it needs a branch:

- off by default, opt-in, and switchable off without an uninstall;
- a screen that shows exactly what a payload contains, populated from the real
  payload rather than a hand-written list that drifts;
- the `server/`-is-published rule applied to payload contents — never a
  Planning Center id, a room name, or a person's name;
- an offline queue that **drops** rather than blocks or grows, because a booth
  machine with no route to the internet is the normal case, not the error case.

**Prerequisite:** [#41](https://github.com/prodmesh/prodmesh/issues/41) item 1.
You cannot report errors that `.catch(() => [])` has already swallowed, and
`autostartLoop`'s bare catch is exactly the failure telemetry exists to catch.

### 5. Planning Center Calendar to live (needs an issue)

Further along than STATE.md admits — its integration table still says "Not
started", but `server/routes/calendar.js` and `integrations/pcCalendar.js` are
built mock-first and waiting on the product grant. Remaining work is mostly
access and verification, not code:

1. get Calendar enabled for the existing PAT;
2. confirm the field names marked ⓘ in `pcCalendar.js` against real data, and
   refine room matching against real `resource_bookings` rather than the
   `location` string;
3. auto-populate lockout windows from real bookings, retiring manual schedules;
4. revisit the Auditorium "Special Events" mapping held in STATE.md's
   *Decisions on hold*.

Roadmap item 3 and the highest user value on this list.

## LTS hygiene — gates the tag, not the merges

- **1.4 ships first.** [#26](https://github.com/prodmesh/prodmesh/issues/26),
  [#41](https://github.com/prodmesh/prodmesh/issues/41),
  [#42](https://github.com/prodmesh/prodmesh/issues/42) (PR
  [#44](https://github.com/prodmesh/prodmesh/pull/44)) are open and 1.4.0 is
  untagged. 1.5 planning assumes that is done.
- **`server/setupApi.test.js` must stop failing intermittently** (#41 item 3).
  A suite that fails 1-in-N teaches people to re-run instead of read, and an
  LTS release is the worst one to ship that on.
- **Swallowed programming errors** (#41 item 1) — also the telemetry
  prerequisite above.
- **OBS graduates or stays Beta.** Either somebody runs it against a real OBS
  and records it in INTEGRATION-NOTES, or it keeps the label. Per the existing
  rule a Beta integration never blocks a tag.

## Deferred to 1.6

- **Native MIDI** — sidecar, not a native module in the server.
- **Timecode widget** ([#31](https://github.com/prodmesh/prodmesh/issues/31)) —
  already marked nice-to-have; LTC needs audio-interface access, so it is the
  same sidecar as MIDI. The precedent is good (`prodmesh-rta`, and Open Sound
  Meter over UDP multicast), but it is a second repo's worth of work.
- **Live host-to-host migration** with clients following the move. Restore onto
  new hardware covers the hardware-failure case; the seamless version is a
  bigger design and wants the multi-campus question answered first.
- Linux desktop builds; Windows code signing.

## Rough sequencing

Ten weeks, one maintainer, occasional contributions.

1. **1.4 ships.** Nothing below starts cleanly until it does.
2. **ADR 0013**, then service tokens, then the `/api/v1` freeze. First because
   everything else that adds surface should be added *into* the frozen shape
   rather than migrated in afterwards.
3. **PC Calendar access request** goes out in week 1 regardless — it is the one
   item blocked on somebody else's timeline, so it should be waiting on us, not
   the reverse.
4. **Desktop pieces** in order: window → system identity → discovery → restore.
5. **OSC buttons** — self-contained, good filler between the larger pieces.
6. **Telemetry** last, after #41 item 1, so it has real errors to report.

## Documentation debt this plan assumes

- STATE.md's integration table calls PC Calendar "Not started". It is built
  mock-first. Fix that whether or not item 5 proceeds.
