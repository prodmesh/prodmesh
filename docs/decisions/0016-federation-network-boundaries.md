# 0016 — Federation network boundaries and failure isolation

Status: proposed · 2026-10-18 · extends [0014](0014-a-server-per-site.md) ·
part of [#46](https://github.com/prodmesh/prodmesh/issues/46)

## Context

[0014](0014-a-server-per-site.md) decided the shape of federation: a server per
site, peers rather than a cluster, the browser navigating to the owning site and
the server aggregating digests. It was then reviewed by the networking and IT
designer working on the church's inter-campus network, against a
blast-radius-reduction tenet: by default the campuses do not talk to each other,
and anything that crosses between them is a deliberate, narrow exception.

That review agreed with the architecture and found four things 0014 either got
wrong or left to be assumed. This ADR settles them. It is deliberately a
separate record rather than an edit, because these are decisions about the
*network and failure* boundary rather than about the federation model itself,
and because the people who need them — whoever configures the firewalls — are
not the people who need 0014.

The one outright error is corrected in 0014 itself: it claimed navigation avoids
the certificate problem. It does not. See below.

## Decision

### Two paths across the boundary, and they are not one firewall rule

Federation needs two distinct kinds of reachability, and conflating them
produces either a rule that is too broad or a feature that silently does not
work:

| Path | Who talks | Volume | What it carries |
|---|---|---|---|
| **Federation link** | ProdMesh server → paired ProdMesh server | low, steady | pairing, directory sync, digests, liveness |
| **Operator access** | an authorized workstation's browser → a remote ProdMesh server | on demand | the remote site's own UI |

The review's point stands: an engineering Mac at one campus needs HTTPS reach to
*another campus's* ProdMesh, not only to its own. That is a second policy, for
different sources, and it should be scoped to workstations rather than opened
to a whole campus network.

**Neither path widens access to device networks.** A site's ProPresenter,
Companion, analysis hosts and SNMP sources remain reachable only from their own
ProdMesh. Federation exposes ProdMesh to ProdMesh, never ProdMesh to another
campus's equipment. This is the network-level statement of the same rule 0014
makes at the data level when it keeps remote rooms out of `site_rooms`.

### Certificates: three tiers, and the product must not require the best one

For the **federation link**, 0014's answer is unchanged and remains right: a
self-signed certificate per instance with its fingerprint pinned at pairing. We
control both ends, so no CA is involved and none is needed.

For the **operator path** the pin is worthless, because a browser trusts a
certificate authority and has never heard of our pin file. Three honest tiers:

- **Tier A — a browser-trusted certificate per site**, behind an internal DNS
  name: either an internal CA whose root is distributed to the workstations, or
  a publicly-trusted certificate obtained by DNS-01 validation, which works for
  a host that resolves to a private address because validation never touches the
  host. **Recommended wherever somebody owns the network** — which is this
  church's case.
- **Tier B — plain HTTP inside a trusted path** (dark fibre, site-to-site VPN,
  or one routed network). No certificate, no warning, and exactly the posture
  ProdMesh already ships with on a LAN. Honest, and the right default.
- **Tier C — a self-signed certificate and a click-through interstitial.**
  It works and the acceptance is once per browser, but it teaches a volunteer to
  dismiss certificate errors on the machine that runs a service. Documented so
  that nobody arrives at it by accident; not recommended.

**Tier A must never become a requirement.** The church that cannot run Docker —
the reason the Electron launcher in #18 exists at all — will not stand up an
internal CA or an ACME client, and a feature that demands one is a feature they
do not get. PKI is a deployment option for sites that have the means, not a
dependency of the software.

### Federation is never a generic tunnel

This is the rule most worth writing down now, because it costs nothing today and
will be expensive to reinstate later.

The tempting future feature is "from the Bothell dashboard, fire a macro on
South Everett's ATEM", and the tempting implementation is a forwarder: let the
local ProdMesh relay an arbitrary API call to a peer. **There must be no such
endpoint, now or later.**

Instead, every cross-site operation is:

1. **enumerated** — a named operation, not a path and a body to be passed along;
2. **authorized at the receiving site**, against that site's own per-peer policy;
3. **validated and executed by the receiving site**, against its own equipment.

The initiating site never reaches another campus's devices; it asks another
ProdMesh to do something, and that ProdMesh decides. A general forwarder would
collapse the distinction and turn the federation link into a site-to-site
control channel — which is precisely the thing the whole architecture is
arranged to avoid.

### A peer asserts identity; it never confers authority

0014 says the receiving site decides what a visitor may do and defaults to
read-only. The review asked for the threat stated outright, and it is worth
stating:

**Assume a paired instance is fully compromised.** The attacker can then mint
assertions naming arbitrary users with arbitrary group membership, because
signing is exactly the capability a compromised peer has. It must follow that:

- group membership in an assertion is an **input to the receiving site's
  policy**, never a grant. "Administrators at Bothell" means whatever South
  Everett has decided it means locally, which by default is read.
- a compromised peer must not be able to change a remote site's configuration,
  run a remote production operation, or obtain privileged access anywhere but
  its own site.
- when cross-site writes arrive, they are enabled **per peer and per operation**,
  deliberately, never as a consequence of pairing. High-impact operations —
  changing a room mode while a service is live, starting or ending a show,
  triggering an update — need more than a peer's say-so.
- unpairing drops the key and so revokes the capability; short assertion
  lifetimes bound anything already issued.

### Freshness is a property of the data, not of the response

A digest must say when the underlying state was **observed**, per item, not
merely when the peer answered. A perfectly healthy server can serve a room mode
its ProPresenter connection stopped confirming ten minutes ago, and a dashboard
that shows that as current is worse than one that shows nothing.

This is cheap because the data exists: `health.js` already records `lastSuccess`
per integration key, so the observation time is already known at the source.

The All Campuses view must therefore distinguish three states that 0014 ran
together: *this peer is unreachable*, *this peer is fine but its data is stale*,
and *this is current*. A digest whose observations have aged past a threshold is
an alertable condition under [0015](0015-events-and-alerts.md).

### Liveness probing is always on, and is not the digest

0014 made digest polling refcounted so that idle federation costs nothing. That
was about the *digest*, and the review is right that it leaves a gap: a peer
that dies at 3am would not be noticed until somebody opened the All Campuses
view, which defeats the point of having an alert spine.

So two cadences, deliberately different:

- **a liveness probe per paired peer, always on**, on the order of once a
  minute, independent of subscribers. It reports into `health.js` like any other
  integration, which means [0015](0015-events-and-alerts.md) can raise a
  peer-down alert without anybody watching.
- **the digest subscription, refcounted** as 0014 decided, running only while
  the view is open.

The correction to 0014's wording: idle federation costs a heartbeat, not a
stream. Thirteen peers at one probe a minute is nothing; thirteen peers
streaming is the thing worth avoiding.

### The minimum failure behaviour

The isolation contract, stated so it can be tested rather than hoped for:

- **WAN down:** every site runs its own Sunday unchanged. No local feature
  degrades, because no local operation depends on a remote answer.
- **A peer down:** the All Campuses view shows it as unreachable with a
  last-seen time; nothing local blocks, warns repeatedly, or retries in a way a
  user can feel.
- **A peer answering badly** — wrong shape, truncated, absurd timestamps — must
  not break the page that renders it. Remote data is parsed defensively and
  treated as untrusted input, because by the threat model above it is.
- **No local request ever waits on a remote one.** This is the invariant that
  keeps a WAN fault from presenting as a local hang, and it is the one most
  easily lost by accident in a convenient refactor.

## Consequences

- **The firewall rules are a deliverable, and they do not live in this
  repository.** This repo is public and MIT, and `CLAUDE.md` forbids real device
  IPs, hostnames and usernames anywhere in `server/`; the same judgement applies
  to a document naming a church's internal DNS names and inter-site policy. The
  network implementation belongs in the church's own documentation, handed to
  whoever runs the network. Anything in-repo uses TEST-NET-1 (`192.0.2.x`) as
  the rest of the project does.
- **Liveness probing gives the alert spine its first non-local source**, before
  `prodmesh-watch` exists. A peer is an integration like any other as far as
  `health.js` is concerned.
- **Digests gain a per-item observation timestamp**, which the sending side can
  populate from data it already has.
- **The no-forwarding rule constrains future features**, which is its purpose.
  Any cross-site action costs an explicit operation and a policy entry at the
  receiving end. That friction is the feature.

## Not decided here

- **Which cross-site operations, if any, ever exist.** This ADR says how one
  would have to work, not that one should.
- **The per-peer policy's shape** — how a receiving site expresses "Bothell's
  administrators may read everything and acknowledge alerts". It should reuse the
  dotted ACLs of [0008](0008-stations-users-and-acls.md) rather than invent a
  second vocabulary.
- **Probe interval and staleness thresholds.** They want to come from a real
  two-site deployment, not a guess.
- **Certificate lifecycle for Tier A** — issuance, renewal and what happens when
  one expires on a Saturday night. Worth answering before recommending Tier A to
  anybody without an IT vendor.

## Known limits

- **Pairwise pairing does not shrink.** Fourteen campuses mutually paired is 91
  pairings and 91 trust relationships to rotate; an authoring authority is the
  obvious place to distribute a peer set from, and remains deferred.
- **An always-on probe is a small permanent noise floor** on the inter-site
  link, and the first thing anyone will ask about when reading a firewall log.
  Worth documenting for whoever reads those logs.
- **Nothing here defends against a peer that is merely wrong.** The threat model
  covers a compromised peer and an unreachable one; a peer that is up,
  trusted and reporting nonsense is caught only by the freshness contract and
  defensive parsing, both of which are shallow checks.
