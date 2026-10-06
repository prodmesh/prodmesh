# v1.5 — release plan

Status: draft, 2026-09-13 · Milestone due 2026-11-23 · Planned from the
[v1.5 milestone](https://github.com/prodmesh/prodmesh/milestone/2) and
[VISION.md](./VISION.md).

[STATE.md](./STATE.md) says where the project *is*. This says what v1.5 is
*for*, what is in and out, and why — so the scope can be argued with now rather
than discovered in November.

## Theme: the platform release

The milestone description sets the bar:

> 1.5 will be ProdMesh's first LTS release where APIs will be stable enough to
> integrate with in other apps

That is a promise about the API surface, and none of the issues originally on
the milestone delivered it. Today the claim is not backed:

- **~100 endpoints across 11 route modules** (`server/routes/`), all
  unversioned `/api/…`. No deprecation policy, no documented contract. Nothing
  stops an ordinary refactor from breaking an integrator.
- **There is no machine credential.** `httpAuth.js` reads a bearer token, but
  every session is an 8-hour login-derived *user* session (`authStore.js`,
  `SESSION_TTL`). Another app would have to store a human's PIN and re-login
  three times a day.
- **LTS is a schema promise too.** Calling a release LTS and then changing
  SQLite schema under a church is the thing LTS exists to forbid.

What makes this a coherent release rather than a grab-bag is that the two
larger features added in planning are both *consumers* of that same API:

- **multi-site** is ProdMesh talking to ProdMesh — instance-to-instance is an
  API client, and a service token is exactly the credential it needs;
- **the alert spine** is the first thing an outside app would actually want to
  subscribe to, and the `prodmesh-watch` sidecar feeds it over the same
  contract.

So v1.5 builds the substrate and then proves it three ways, with ProdMesh as
its own first API consumer. If the API is good enough for federation, it is
good enough to publish.

## In scope

### 1. API v1 + service tokens — the substrate (needs an issue and ADR 0013)

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
  in audit rows the way a station is.
- **Throttling on the token path.** Unauthenticated resource exhaustion is
  inside the threat model in `CLAUDE.md`; a token that skips the login lockout
  must not become the way around it.
- **The contract, written down**: the endpoint list, the SSE topics under the
  same promise, the deprecation policy, and a schema-compatibility statement
  (migrations forward-only, nothing destructive within 1.5.x).

Federation settles one open question from the first draft: **writes are in v1**,
because instance-to-instance config sync is a write. The remaining questions
for the ADR are which endpoints make the cut, and whether
`x-prodmesh-station` stays public contract or becomes browser-only.

### 2. Multi-site: directory and hand-off (needs an issue · [ADR 0014](./decisions/0014-a-server-per-site.md))

**A server per site, instances aware of each other.** The bandwidth argument is
real — 14 campuses × 3 auditoriums is 42 rooms of ProPresenter and RTA
streaming over a site-to-site VPN — but the deciding argument is the constraint
already in VISION.md: *Sunday cannot depend on the internet being up*. A
central server means a campus with a dead WAN link cannot run its own room.
That is disqualifying on its own, and it holds even for a church whose VPN is
excellent.

**The browser navigates to the owning site; the server aggregates.** This is
cheaper than the first draft of this plan estimated, because that draft
conflated two features. Writing ADR 0014 separated them:

- **Looking at one other campus** is a **navigation** to that site's own origin,
  carrying a short-lived signed assertion so the admin arrives already signed
  in. Not a cross-origin fetch — so **no CORS**, the ~44 root-relative
  `/api/…` call sites are **untouched**, `src/lib/stream.ts:55` stays as it is,
  and the browser never meets a self-signed certificate it would have to be
  trained to click through.
- **Seeing all campuses at once** is a **server-to-server digest**: the local
  instance pulls a small summary from each peer and republishes it on its own
  topic stream, so the browser subscribes to its own server as always.

The digest is a refcounted topic — `registerTopic('site:<id>:summary', { start,
stop })`, the same primitive ADR 0010 already uses for lyrics and captions — so
polling runs only while somebody is watching, and fourteen campuses do not
become 182 pollers.

**Identity cannot be deferred even though replication can.** Cross-site viewing
needs the home site to *vouch* for a user (Ed25519 via `node:crypto`, no new
dependency), with the receiving site deciding what a visitor may do — default
read-only. Otherwise the far site either needs an account per person per campus,
or authenticates the instance rather than the human, discarding exactly what
ADR 0012 established.

**What crosses the wire, and when.** Room *definitions* sync — small, rarely
changes. Room *state* (mode, SSE, RTA, slides) is fetched live from the owning
site, and only while somebody is looking. Sync is O(config); live traffic is
O(viewers), not O(rooms). That is the whole bandwidth answer.

**Trust between instances** builds on #18's system identity (below): explicit
pairing, where an admin at one site generates a join token and an admin at the
other redeems it. Mutual and deliberate, not discovery-implies-trust.

#### The "master" question — deferred to 1.6, but here is the argument

Worth recording now because it shapes what v1.5 must not foreclose.

*For* a central authoring instance: a 14-campus church should not create a user
fourteen times or paste the Planning Center PAT fourteen times. Planning Center
is genuinely org-global — one organisation, one PAT. "Campus Tech Director"
should mean the same thing everywhere.

*Against*: it reintroduces exactly the dependency the per-site server
eliminates. If site B cannot authenticate because the master is down, Sunday
breaks at site B — the failure mode the architecture exists to prevent. It also
creates a single point of failure with no failover story, and a church cannot
operate HA.

**The resolution is to separate authority from availability.** Global config is
*authored* in one place and **replicated** to every site; each site runs from
its local replica. Master down means no *edits* — every site still
authenticates, still runs Sunday. This is the domain-controller model, and its
failure semantics are well understood. Local config (rooms, modes, Companion
button maps, checklists, shows, SPL, timelines) is owned by the site and never
leaves it.

Two things that fall out and need deciding in the 1.6 ADR:

- **Replicating credentials multiplies blast radius.** Offline operation
  requires the PAT at every site, so fourteen boxes hold it. That is probably
  acceptable and certainly unavoidable, but it makes rotation a federated
  operation rather than a settings edit.
- **The authority should be a role, not a machine** — movable, which is the
  same primitive as #18's "move the host".

#### This breaks the threat model, and that needs saying out loud

`CLAUDE.md` is explicit: ProdMesh is a LAN appliance, the bar is "bridged onto
guest wifi", *"that is why there is no TLS and why it binds all interfaces:
deliberate, not an oversight."*

A federation link is the first traffic that legitimately leaves the building,
and the user's own framing is that not every church has a site-to-site VPN. So
the link cannot inherit the LAN's trust assumptions: it needs TLS and real
authentication on its own, independent of whatever tunnel it may sit inside.
This is the first thing in ProdMesh's life that has a real reason to hold a
certificate.

The threat-model section in `CLAUDE.md` must be amended as part of this work —
*LAN appliance, plus an authenticated federation link* — rather than left to
imply a bar that federation no longer meets.

**South Campus is not blocked on any of this.** It opens with its own box and
its own admin. What federation delivers is the single pane of glass, which is a
VISION promise, not a launch dependency.

### 3. The alert spine (needs an issue · [ADR 0015](./decisions/0015-events-and-alerts.md))

VISION §4 wants real-time monitoring and preemptive alerting. The striking
thing is how much of it already exists and is simply not connected:

| Already built | Where |
|---|---|
| Per-integration health registry with **ok→fail transition detection**, stable keys, bounded | `server/health.js` |
| On-demand reachability checks per room integration | `server/connectivityStatus.js` |
| A working **Slack client** — post, react, read reactions, `isConfigured()` | `server/integrations/slack.js` |
| A proven **raise → acknowledge → resolve** lifecycle over Slack (👀 = on my way, ✅ = closed) | `server/assistance.js` |

Every transport choke point already reports up/down transitions, and today that
goes nowhere but a log file. Connecting the transition to the Slack path that
the assistance button already proves in production lights up ProPresenter,
Companion, Smaart, OBS and Planning Center faults with **no new protocol**.

The genuinely new work is therefore small and specific:

- **Persist events.** `health.js` is in-memory, so nothing survives a restart
  and there is no history. A `device_events` table (source, device identity,
  site/room binding, severity, timestamp, dedupe key, raw payload) is the
  actual new thing — and it is what "persistently log Dante errors" needs.
- **Severity and routing rules**, with show context: the same fault matters
  differently at 10:42 on a Sunday than at 3pm on a Tuesday. ProdMesh knows
  whether a show is live; a sensor never will.
- **One spine, not two.** This is also why telemetry (#37) moves to 1.6 — it
  should reuse this event model rather than grow a parallel path.

### 4. Desktop, app-shaped — [#18](https://github.com/prodmesh/prodmesh/issues/18), split

Take the pieces federation also needs:

| Piece | Size | Notes |
|---|---|---|
| Frontend rendered in the desktop window | small | `desktop/main.js:158` loads `status.html`; the server already runs in Electron's main process, so this is mostly pointing a `BrowserWindow` at the local port |
| Stable **system identity**, distinct from the host machine | small, architectural | Not just for desktop discovery — it is the federation primitive, and what a client reconnects *to* |
| **mDNS/Bonjour discovery** + connect to an instance elsewhere | medium | The same primitive multi-site needs, per the maintainer's comment on #18 |

Restore-onto-new-hardware moves to 1.6 with the rest of the cut.

### 5. Planning Center Calendar to live (needs an issue)

Further along than STATE.md admitted — `routes/calendar.js` and
`integrations/pcCalendar.js` are built mock-first and waiting on the product
grant. Remaining work is access and verification, not code: enable Calendar for
the existing PAT, confirm the field names marked ⓘ in `pcCalendar.js` against
real data, refine room matching against real `resource_bookings` rather than
the `location` string, then auto-populate lockout windows from real bookings.

The access request should go out in week 1 — it is the one item blocked on
somebody else's timeline.

## The `prodmesh-watch` spike

SNMP traps from production devices (Evertz and friends) and Dante device
errors belong in a **separate sidecar app**, following the `prodmesh-rta`
precedent. Three reasons it should not live in the server: SNMP trap reception
wants port **162**, which is privileged and should not hand the main server
root; Dante may need licensed or reverse-engineered work whose provenance we do
not want inside an MIT core; and both are protocols the dashboard should never
link against directly.

The spike's job is the **contract**, not the protocols. The open question was
whether the watcher pushes into ProdMesh or ProdMesh reads from it. The
codebase already answers it:

- **`prodmesh-rta` is a server; ProdMesh is the client** — `rta.js:78` opens
  `ws://<host>:<port>/api/stream`. Same for ProPresenter, Companion, OBS,
  Smaart. The only push source is Open Sound Meter, and only because UDP
  multicast is its native idiom.
- **Silence is ambiguous under push.** If the watcher pushes and stops, ProdMesh
  cannot tell "nothing is wrong" from "the watcher died" without inventing a
  heartbeat. If ProdMesh connects, absence is a dead socket the existing
  `health.js` registry already notices. For a *monitoring* feature that
  distinction is the whole product — a monitor that fails silently is worse
  than none.
- **Push needs inbound auth** for an unattended writer, which is the service-token
  work again. Pull needs none.

So: **ProdMesh subscribes to the watcher**, which is the eighth entry in the
integrations table, configured host/port with a live status dot like every
other one. Subscribe rather than poll — traps are bursty and a fault at
10:42:03 should not wait for a tick.

What the spike must still settle:

1. **Sequence numbers and gap detection** — on reconnect ProdMesh asks "since
   N" and can tell whether it *missed* events rather than silently losing them.
   The watcher holds a bounded buffer; it owns the raw log, ProdMesh stores the
   events that mattered.
2. **A normalized event schema** independent of SNMP and Dante, so the contract
   outlives both.
3. **Who binds a device to a room.** A trap from `192.0.2.50` means nothing
   until it is "the Auditorium's Evertz". ProdMesh owns rooms, so ProdMesh owns
   the mapping; the watcher reports device identity only.
4. **Whether the ingest contract is public.** It should be — a church with an
   existing monitoring system should be able to feed the same pipe, which makes
   this part of the v1 surface rather than a private side channel.
5. **Whether `prodmesh-rta`'s existing contract generalises**, since a future
   timecode sidecar (#31) would be the third app in the same shape.

**The watcher is a sensor, not a brain.** It must not grow its own rule engine
or Slack config: ProdMesh owns the users, ACLs, room model and show context
that decide what an event *means* and who to tell. Two alerting brains means
two places to look on a Sunday morning.

It must also stay strictly optional — ProdMesh has to be fully functional
without it, like `prodmesh-rta` today. A second required install would undercut
#18's "download, install, open" in the same release that delivers it.

## Deferred to 1.6

- **OSC buttons** ([#30](https://github.com/prodmesh/prodmesh/issues/30)) — a
  feature rather than a foundation. When it lands it goes through
  `requirePermission` and writes an audit row, unlike the Companion emulator
  surface, because we own the send path.
- **Native MIDI** — a native module breaks all three deploy paths at once: a
  Docker container has no host MIDI ports, `npm ci` on a git-install church
  gains a compile step, and Electron needs the ABI rebuild `better-sqlite3`
  already taught us. It belongs in a sidecar.
- **Telemetry** ([#37](https://github.com/prodmesh/prodmesh/issues/37)) — so it
  reuses the alert spine's classifier: per
  [ADR 0015](./decisions/0015-events-and-alerts.md) an *outage* is the church's
  problem and a *bug* is ours, which makes telemetry the second consumer of one
  classification rather than a parallel pipeline. Still needs its own ADR when it comes:
  off by default, a screen showing exactly what a payload contains, the
  `server/`-is-published rule applied to payloads (never a Planning Center id,
  room name or person's name), and an offline queue that **drops** rather than
  grows, because a booth machine with no route to the internet is the normal
  case.
- **Timecode widget** ([#31](https://github.com/prodmesh/prodmesh/issues/31)) —
  LTC needs audio-interface access, so it is a third sidecar in the
  `prodmesh-watch` shape.
- **Global config replication** and the authority-instance model — see the
  argument above.
- **Restore onto new hardware**, and live host-to-host migration.
- Linux desktop builds; Windows code signing.

## LTS hygiene — gates the tag, not the merges

- **1.4 ships first.** [#26](https://github.com/prodmesh/prodmesh/issues/26),
  [#41](https://github.com/prodmesh/prodmesh/issues/41),
  [#42](https://github.com/prodmesh/prodmesh/issues/42) (PR
  [#44](https://github.com/prodmesh/prodmesh/pull/44)) are open and 1.4.0 is
  untagged.
- **`server/setupApi.test.js` must stop failing intermittently** (#41 item 3).
  A suite that fails 1-in-N teaches people to re-run instead of read, and an
  LTS release is the worst one to ship that on.
- ~~**Swallowed programming errors** (#41 item 1)~~ — **already done**, and this
  corrects an earlier claim in this document that the alert spine was blocked on
  it. `health.js` carries `outage()` / `unexpected()` / `survive()`, the
  choke points in `proPresenter.js` and `planningCenter.js` use them, and
  `autostartLoop` now calls `unexpected()` with a comment explaining that a bug
  there presents on a Sunday as "the show just didn't start". The two bare
  catches left in `showManager.js` are narrow and intentional. Better than
  unblocked: that outage/bug split is what [ADR 0015](./decisions/0015-events-and-alerts.md)
  uses to decide whether a fault belongs to the church or to us.
- **OBS graduates or stays Beta.** Per the existing rule a Beta integration
  never blocks a tag.

## Rough sequencing

Ten weeks, one maintainer, occasional contributions.

1. **1.4 ships.** Nothing below starts cleanly until it does.
2. **PC Calendar access request** goes out in week 1 regardless — it should be
   waiting on us, not the reverse.
3. **ADR 0013**, then service tokens, then the `/api/v1` freeze. First, because
   everything else adds surface that should be added *into* the frozen shape.
4. **System identity → mDNS discovery → desktop window** (#18 pieces).
5. **The multi-site directory + hand-off** ([ADR 0014](./decisions/0014-a-server-per-site.md)),
   which needs 3 and 4.
6. **The alert spine** — persist transitions, then rules, then the Slack sink.
   Independent of 3–5, so it is the natural thing to interleave.
7. **The `prodmesh-watch` spike** — contract only this cycle; the app itself is
   1.6.
