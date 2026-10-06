# 0014 — A server per site, federated by hand-off

Status: proposed · 2026-10-06 · planned in [PLAN-1.5.md](../PLAN-1.5.md)

## Context

**"Multi-site" today means one server with several `sites` rows.** The table is
four columns — `id`, `name`, `status`, `position` — and the campus-first sidebar
([0007](0007-campus-first-sidebar.md)) already picks between them: All Campuses,
or one. South Campus exists as a `disabled` row with no rooms wired. That model
is correct for one building and wrong for the real shape of a multi-campus
church, which is about to stop being hypothetical.

**One server does not scale to the real shape.** A church with 14 campuses of
three auditoriums each is 42 rooms, and a room is not one connection: it is a
ProPresenter client, a Companion client, an analysis socket (Smaart, ProdMesh
RTA or Open Sound Meter), optionally OBS, and a per-room autostart watcher
polling inside its arm window. Centralising that means every one of those
streams crosses a site-to-site VPN — and not every church has one.

**But bandwidth is not the deciding argument.** [VISION.md](../VISION.md) states
the constraint plainly: *on-prem, LAN-first; Sunday cannot depend on the
internet being up*. A central server means a campus whose WAN link dies at 9am
on a Sunday cannot run its own auditorium — cannot set a room mode, start a
show, or follow ProPresenter, in a building full of people, because of a fault
in a different building. That is disqualifying no matter how good the link is,
and no amount of bandwidth fixes it. The VPN cost is why centralising is
expensive; this is why it is wrong.

**A prior draft of this plan assumed cross-origin fetch, and that was the
expensive mistake.** It costed the frontend hand-off at ~44 root-relative
`/api/…` call sites gaining a base-URL concept, plus CORS that does not exist
anywhere in `server/`, plus a credentialed cross-origin `EventSource`. That
estimate was real but the premise was wrong: it conflated two different
features that have two different answers. Separating them removes nearly all of
that cost — see the third decision below.

## Decision

### A server per site. Peers, not a cluster

Each instance is authoritative for the campuses it serves. `sites` keeps its
present meaning — *the campuses this instance serves* — and gains nothing.

A new table records **peers**: another instance's system id (from the identity
work in #18), display name, base URL, public key, pinned certificate
fingerprint, pairing state, and last-seen. Peers are not members of a cluster;
there is no election, no quorum, and no shared database. Each is a complete
ProdMesh that happens to know some others exist.

Across the federation a room is addressed as `<systemId>/<roomId>`. Locally
nothing changes — `roomsStore` still keys rooms by bare id, and no existing
caller learns a new shape.

### Remote rooms never enter `site_rooms`

This is the one that would quietly cause an outage.

`roomsStore.rebuildRooms()` builds the live rooms map by selecting from
`site_rooms`, and `connectivity.applyConnectivity()` then
`show.syncAutomation()` run immediately after it to reconcile integration
config and per-room watchers. A remote campus's rooms written into that table
would therefore make this box open ProPresenter and Companion sockets into
another building and arm autostart for a service it has no business starting —
two instances racing to start the same show.

So the federated directory lives in **its own table**, is read-only, and is
explicitly a cache of what a peer last told us. Nothing in the local rooms
pipeline reads it. The invariant is worth stating as a rule rather than a
convention: *`site_rooms` contains only rooms this instance runs.*

### The browser navigates to the owning site; the server aggregates

Two features were being conflated. They need different mechanisms:

| Want | Mechanism |
|---|---|
| **Look at another campus** — its rooms, a live show, RTA spectrum, slides | **Navigate** to that site's own origin, carrying a delegated assertion so you arrive already signed in |
| **See all campuses at once** — status, mode, live, next event | **Server-to-server digest.** The local instance asks each peer for a small summary and republishes it on its own topic stream |

Neither path makes a cross-origin request from the browser. That is the whole
saving, and it is large:

- **No CORS** anywhere, so production stays one origin exactly as it is today.
- **The ~44 `/api/…` call sites are untouched**, because a remote site's UI is
  served by that remote site and uses its own relative paths.
- **No credentialed cross-origin `EventSource`** — `src/lib/stream.ts:55` stays
  as it is.
- **No mixed-content or certificate-warning problem in the browser**, which
  cross-origin fetch would have forced us to solve with either a real PKI that
  churches do not have or a click-through warning that trains people to ignore
  certificate errors.

The campus picker therefore becomes a launcher for remote sites — the pattern
the Quick Access launcher already uses for device UIs — while the All Campuses
view is rendered locally from digests.

Digests are **pulled**, not pushed, consistent with every other integration in
this codebase and for the same reason recorded for the monitoring sidecar: under
push, silence cannot be told apart from a dead peer.

### Aggregation is refcounted, so idle federation costs nothing

Naive digest polling is O(sites²): fourteen instances each polling thirteen
peers is 182 pollers for a building that may have nobody looking at a screen.

Instead the digest is a registered topic —
`streamHub.registerTopic('site:<id>:summary', { start, stop })` — using the
primitive [0010](0010-topic-stream-and-widgets.md) already relies on for
`room:*:lyrics`, `room:*:captions` and `room:*:video`: *start when the topic
gains its first subscriber, stop when it loses its last*. A peer is polled only
while somebody is actually watching the All Campuses view, and the cost is
O(sites being looked at), not O(sites). `site:<id>:*` also follows 0010's
`integration:<id>` precedent for a topic that is not room-scoped.

### Identity: the home site vouches, the remote site decides

Replicating users is deferred (below). **Vouching for them cannot be** — without
it, cross-site viewing either needs an account per person per campus, or it
authenticates the *instance* rather than the person, which would throw away
precisely what [0012](0012-one-admin-identity.md) was written to establish: that
the audit log names a human.

So:

1. The browser asks its home instance for an **assertion** naming a target peer.
   The home instance checks the user's own permissions and signs a short-lived
   statement: user id, display name, home system id, group membership, target
   system id as audience, expiry, and a nonce.
2. The browser presents it to the target, which verifies the signature against
   the public key pinned at pairing and mints **an ordinary local session** — a
   row in `user_sessions`, like every other door since 0012 — marked as
   federated and carrying the visiting principal's identity.
3. The target's audit rows name `user@home-site`. Attribution survives the
   crossing, which is the point.

**Ed25519 via `node:crypto`** — `generateKeyPairSync('ed25519')` with
`crypto.sign`/`verify` — so this adds no dependency, which matters for a project
whose deploy paths include a git-install church running `npm ci` and an Electron
bundle with a native-ABI rebuild already in it.

**The receiving site decides what a visitor may do, and the default is
read-only.** The assertion is a statement about *who*, never a grant of
authority. Each paired peer carries a local policy mapping its groups to local
permissions, defaulting to read. Two reasons: viewing another campus should not
imply changing its room modes, and a peer that is compromised or simply
misconfigured must not be able to mint administrative rights in your building.
Trust is scoped by whoever is extending it.

### Trust is pinned at pairing, not delegated to a PKI

There is no certificate authority that will vouch for `192.0.2.14`, and a church
will not run an internal CA. So each instance generates a self-signed
certificate and keypair, and **pairing pins the fingerprint**: an admin on one
site generates a short-lived join token, an admin on the other redeems it, and
each records the other's key and fingerprint. Explicit, mutual, and out-of-band
— discovery never implies trust. mDNS (#18) may *find* an instance; only a human
pairs one.

### This changes the threat model, and `CLAUDE.md` must say so

The threat model is currently explicit that ProdMesh is a LAN appliance, that
the bar is *"this got bridged onto guest wifi and a teenager is throwing
requests at it"*, and that **"that is why there is no TLS and why it binds all
interfaces: deliberate, not an oversight."**

Federation is the first ProdMesh traffic with a legitimate reason to leave the
building, and the premise of this ADR is that not every church has a VPN to put
it in. The federation link therefore cannot inherit the LAN's assumptions: it is
TLS with a pinned peer, authenticated on its own merits, whatever tunnel it may
also sit inside.

Amending that section is part of this work, not a follow-up. An unamended threat
model would still read as *passive sniffing does not matter*, which stops being
true the moment a signed assertion about an administrator crosses a WAN.

## Consequences

- **Attribution survives the crossing.** A remote site's audit trail names the
  visiting human and their home site.
- **The all-campuses view degrades gracefully.** An unreachable peer shows its
  cached directory with a last-seen time rather than vanishing — the existing
  mock/degrade posture, applied to a site instead of an integration.
- **The summary view works from anywhere; the deep view needs a route.** A
  digest reaches the browser via its own server, so All Campuses works even for
  a viewer who cannot reach the other site. Navigating *into* a campus requires
  the viewer to route there. This is a feature of the split, and the reason the
  status overview is the thing worth having off-site.
- **Clock skew becomes a real failure mode.** Short-lived assertions on on-prem
  boxes that may have no reliable NTP will fail, and the symptom — "I can't view
  the other campus" — does not point at its cause. The verifier needs a
  tolerance window, one clear log line naming skew as the reason, and the peer
  status card should surface it. This is exactly the class of swallowed cause
  that issue #41 is about.
- **Unpairing is revocation.** Dropping a peer drops its key, so its assertions
  stop verifying; short expiry bounds the window where an already-issued one
  still works.
- **No CORS, no base-URL refactor, no cross-origin SSE.** The cheapest part of
  the design is the part that was going to be most expensive.
- **What we give up:** no single screen showing two campuses' *live* streams
  side by side. Summaries aggregate; streams stay local. If the "live command
  center" in VISION eventually needs more than a digest, that is a later and
  separate argument — and it can be made on top of the pairing, directory and
  assertion machinery this ADR establishes, which is where the difficulty
  actually lives.

## Not decided here

- **Global configuration replication** — users, groups, ACLs, integration
  credentials, branding — and whether one instance is the authoring authority.
  The argument is recorded in [PLAN-1.5.md](../PLAN-1.5.md) and resolves toward
  separating *authority* from *availability*: config authored in one place,
  replicated everywhere, every site running from its local replica so that a
  down authority blocks edits and never a Sunday. It needs its own ADR, because
  it also decides how a credential is rotated across fourteen boxes that each
  must hold it to work offline.
- **What is in a digest.** Enough for a status card — mode, live, next event,
  integration health roll-up — but the exact shape should follow the first
  screen that consumes it rather than be guessed here.
- **Whether the peer protocol is part of the public v1 surface** (ADR 0013). It
  probably should be, since an instance is just an API client, but freezing it
  in the same release that first implements it is how contracts get frozen
  wrong.

## Known limits

- **Two paired sites can disagree about a room's definition** while a directory
  sync is stale. Harmless for a status card, misleading for anything that acts
  on it, which is one more reason a visitor is read-only by default.
- **Pairing is pairwise.** Fourteen campuses mutually paired is 91 pairings, and
  nothing here reduces that. An authority instance (above) is the obvious place
  to distribute the peer set from, which is a second reason that ADR will want
  writing before a church of that size arrives.
