# 0018 — The directory, digests, and visiting another campus

Status: proposed · 2026-11-12 · details [0014](0014-a-server-per-site.md) and
[0016](0016-federation-network-boundaries.md) · runs over the link in
[0017](0017-pairing-and-the-federation-link.md) · part of
[#46](https://github.com/prodmesh/prodmesh/issues/46)

## Context

[0017](0017-pairing-and-the-federation-link.md) shipped the link: two servers
pinned to each other's certificates, probing each other once a minute. Nothing
crosses it yet but `hello`. [0014](0014-a-server-per-site.md) named the three
things that should, and left their shapes open:

- a **directory**: which campuses and rooms another server runs;
- a **digest**: a small live summary of each of those rooms, for the All
  Campuses view;
- an **assertion**: a signed "this is Alex from North", so a person arrives
  at another server's dashboard already known there.

[0016](0016-federation-network-boundaries.md) added the constraints: a peer
may be compromised, so what it sends is untrusted input and what it asserts is
never a grant; data carries its own observation time; no local request ever
waits on a remote one; and there is no forwarder, now or later.

This ADR fixes the shapes. Two facts from the code shaped it more than
anything in the earlier ADRs did.

**Reading a dashboard is already anonymous.** `resolveIdentity` attaches a
session if there is one, and `requirePermission` guards writes and the few
privileged reads (`reports.view`, logs, backups). Room status, modes, the run
of show and widgets are readable by any browser that can reach the server —
that is the LAN-appliance posture in `CLAUDE.md`, and it is deliberate. So a
person at North who can route to South's dashboard can *look at it today*,
with no assertion at all. What an assertion adds is attribution, reports, and
whatever South's admin chooses to let North's people *do*. That is real, but
it is not what makes multi-site visible, and it is the part with the most
security surface. It is therefore built last and can ship separately (see
"Order of work").

**A session needs a user row.** `user_sessions.user_id` references `users(id)`,
`audit_log` names users by id, and `permissionsFor` resolves through group
membership. 0014's "an ordinary local session, marked as federated" therefore
means a visitor needs a local user row of some kind, or every one of those
paths learns a second shape. The former is decided below.

## Decision

### The directory: pulled when it changes, cached in its own table

`GET /federation/v1/directory` returns what the serving site runs:

```json
{
  "revision": "9f2c…",
  "dashboardUrl": "http://192.0.2.20:8080",
  "campuses": [
    { "id": "south", "name": "South Campus", "rooms": [
      { "id": "main", "name": "Main Auditorium" }
    ] }
  ]
}
```

- **Only active campuses, only names and ids.** No tiles, no device addresses,
  no integration config — nothing a peer could use to reach equipment, which is
  0016's no-device-reach rule applied to data. A disabled campus is not
  published.
- **`revision`** is a hash of the rest. `hello` gains a `directoryRevision`
  field, and the existing once-a-minute probe fetches the directory only when
  that changes. A rename at South shows at North within a minute, and an idle
  pairing costs nothing beyond the probe it already pays.
- **`dashboardUrl`** is where a *browser* reaches the serving site, which is
  not the federation address: different port, possibly a different name, and
  under 0016's tiers possibly `https`. It is a new field in Admin → Linked
  servers ("People open this server at"), prefilled from the federation host
  and the dashboard port, and validated as an absolute `http(s)` URL with no
  path. A peer that leaves it wrong gets an Open button that does not work; it
  cannot get anything worse, because the URL is only ever used as a navigation
  target, never fetched by the server.
- **Stored in `federation_directory`** (`system_id` → JSON, revision,
  `fetched_at`), validated on arrival — ids and names length-capped, counts
  capped — and **never read by the rooms pipeline**. 0014's invariant stands:
  `site_rooms` contains only rooms this instance runs.
- **Unpairing deletes the peer's directory.** An unreachable peer keeps its last
  directory, shown with a last-seen time (0014's degrade posture).

Remote rooms are addressed `<systemId>/<roomId>` everywhere they appear, so
they can never be confused with a local room id.

### Digests: one request per peer, only while someone is looking

`GET /federation/v1/digest` returns every room in the directory at once:

```json
{
  "revision": "9f2c…",
  "generatedAt": 1794326400000,
  "rooms": {
    "main": {
      "mode":    { "value": "service", "observedAt": 1794326391000 },
      "show":    { "state": "live", "title": "Sunday 9am", "startedAt": 1794325800000 },
      "next":    { "title": "Sunday 11am", "at": 1794333600000 },
      "health":  { "observedAt": 1794326398000, "integrations": [
        { "key": "proPresenter", "ok": true }, { "key": "companion", "ok": true }
      ] }
    }
  }
}
```

- **Every value carries the time it was observed** at the source, per 0016,
  taken from what the server already keeps: room health and `health.js` record
  their last success, the show manager its state changes. `generatedAt` is when
  the peer answered; it is not a substitute.
- **Fields are deliberately few.** Mode, show state, next event, and the room's
  integration dots — built by `roomHealth.publicHealth`, whose fixed field list
  already exists so that nothing new leaks when a probe grows a field — are
  enough for a status card. Lyrics, slides, timers and SPL stay on
  the owning site; looking at them is what visiting is for. The shape grows by
  adding optional fields, never by changing one, and North ignores fields it
  does not know.
- **It is a refcounted topic**, as 0014 decided: `site:<systemId>:summary` on
  the stream hub, polled every 10 seconds while it has a subscriber and not at
  all otherwise. One request per peer per tick, a 5-second timeout, at most one
  in flight, and the result published to every subscriber at once.
- **The digest's `revision`** is the directory revision it was built from. A
  mismatch triggers a directory refetch rather than rendering rooms North cannot
  name.
- **A digest is parsed defensively and rendered as data.** Unknown room ids are
  dropped; strings are length-capped; timestamps outside a sane window are
  treated as unknown. A malformed digest marks that peer's cards as
  unavailable; it never throws into the page.

Three states reach the screen, as 0016 requires, and they look different:
**unreachable** (the probe is failing; cards greyed with a last-seen time),
**stale** (the peer answers but an observation is older than two minutes; that
value is shown dimmed with its age), and **current**.

### Where remote campuses appear

- **The sidebar's campus picker** lists remote campuses under their server's
  name, after this server's own. Choosing one shows that campus's room cards
  rendered from the digest, each with an **Open** button.
- **All Campuses** on Home includes remote campuses' cards after local ones.
  It is the screen the digest exists for.
- **Open** navigates the tab to `dashboardUrl` — plain navigation in the same
  tab, so the browser's own Back returns. Before visiting is built, Open is just
  that link; after, it carries an assertion (below).
- A remote card **has no controls.** Changing South's room mode happens on
  South's dashboard, by navigation, never through North. There is no endpoint
  on the link that changes anything at the other end; adding one is a new ADR
  under 0016's enumerated-operation rule.

Who sees remote cards: anyone who can see this server's dashboard, as with
local cards. Pairing is the decision to share status between the two sites; a
site that does not want its status visible at the other should not pair.

### Visiting: the home site vouches, the visited site decides

The flow, with North as home and South as visited:

1. A signed-in person at North presses Open on a South card. North's
   `POST /api/federation/visit {systemId}` checks they have an active session
   and that South is paired, and signs an assertion.
2. North answers with `dashboardUrl + "/visit#" + assertion`, and the browser
   navigates there. The assertion is in the **fragment**, which browsers never
   send in the request line, referer or server logs.
3. South's web app, at `/visit`, posts the assertion to
   `POST /api/federation/arrive`, removes the fragment from history, and stores
   the session it gets back exactly as a local sign-in would.

An anonymous viewer at North gets plain navigation, and arrives at South
anonymous: the same as typing the address.

**The assertion** is `pmvisit1.<payload>.<signature>`, base64url, signed with
North's Ed25519 identity key (#49) and verified against the
`signing_public_key` South pinned at pairing:

```json
{ "v": 1, "iss": "<North systemId>", "aud": "<South systemId>",
  "sub": "<North user id>", "username": "alex", "name": "Alex",
  "groups": ["Tech Directors"], "iat": 1794326400000,
  "exp": 1794326460000, "nonce": "<128 random bits>" }
```

- **Sixty seconds of life, thirty seconds of skew.** It only has to survive one
  navigation. South accepts `iat` up to 30 s in the future and `exp` up to 30 s
  past, the same threshold 0017's skew warning uses, and on refusal logs one line
  that names skew when skew is the reason (0014's #41-shaped concern).
- **Single use.** South records each nonce until its `exp` and refuses a repeat.
- **Bound to South.** `aud` must be South's own system id; an assertion made for
  one site is useless at another.
- **Unpairing revokes.** South drops North's key, so nothing North signed
  verifies any longer.

On the operator path the assertion travels by whatever carries the dashboard:
plain HTTP inside a trusted path under 0016's Tier B, TLS under Tier A. A
captured assertion is a bearer credential for at most sixty seconds and one
use, for one site, carrying at most what South's policy grants North's people,
which by default is reading. That is consistent with Tier B's premise that the
path is trusted, and it is why the default stays where it is.

**A visitor is a local user row, marked foreign.** On first arrival South
creates a `users` row with `origin_system_id` set to North, `origin_user_id`
set to `sub`, username `alex@<North's slug>`, and no usable PIN, and keeps
its display name in step on later arrivals. Then:

- `authenticate` refuses any row with an origin: a visitor can only arrive,
  never log in by PIN;
- `user_sessions`, `audit_log` and Admin → Users work unchanged, and the audit
  trail names `alex@north` — attribution survives the crossing (0014);
- visitor sessions have no station and last **one hour**, not the local eight,
  and are re-established by pressing Open again;
- unpairing deactivates every row from that peer and deletes their sessions;
- Admin → Users lists visitors separately, read-only, with their home server.

**What a visitor may do is South's policy, never North's assertion.** A
visitor's permissions come from a per-peer rule list held at South, not from
group membership:

```
North:  everyone            → reports.view
        "Tech Directors"    → reports.view, shows.operate, rooms.mode.change
```

- The default for a new pairing is **`reports.view` for everyone** — reading,
  which is 0016's default, plus the one read that needs a sign-in.
- Rules match on the group *names* in the assertion. A compromised North can
  claim any group, so a rule is exactly as strong as South's trust in North's
  admins; the screen says so where rules are edited.
- **Only operational permissions can be granted to visitors**: ADR 0013's
  service-token set less its one sharp edge — `shows.operate`,
  `rooms.mode.change`, `checklists.complete` and `reports.view`. A token is
  minted by South's own admin; a visitor is vouched for by a server South does
  not control, so `rooms.mode.override_lock` stays off. Nothing else on
  the permission list is grantable to a visitor at all: not `users.manage`,
  `settings.manage`, `config.manage` or `system.*`, and not the narrower ones
  either. 0016's
  requirement that a compromised peer never gain "privileged access anywhere
  but its own site" is therefore enforced by a list, not by an admin's care.

### Order of work

Directory, then digests, then visiting. Each is useful alone, each ships behind
pairing (off by default), and each lands with its own end-to-end test between
two real servers, extending the one 0017 wrote. If time runs short before a
release, visiting is the piece to hold: without it Open is a plain link, which
is exactly what a person can do today by typing the address.

## Consequences

- **North's people see South's status without any network change** beyond the
  link 0017 already needs: digests reach the browser through North. Open needs
  the operator path 0016 describes; where that does not exist, the cards still
  work and Open fails the way any unreachable address does.
- **Every room card gains a remote variant**, with a server name, an age, and
  no controls. It is the first UI that renders another server's data, and the
  defensive-parsing rule applies to every field it shows.
- **`users` gains two columns** and `authenticate` gains a check. The rest of the
  auth stack — sessions, audit, permission checks — is unchanged, which is the
  reason for a shadow row over a second session table.
- **The visit grant list is a second place that classifies permissions.** It
  should be defined beside `TOKEN_PERMISSIONS` in `authStore.js`, as that list
  less `rooms.mode.override_lock`, so a new permission is classified once and
  stays off both until someone decides otherwise.
- **The peer protocol grows to four GETs and one POST** (`hello`, `directory`,
  `digest`, `pair`, `unpair`), all on the mTLS port, none of them a write to
  anything but the pairing itself. It is still not part of the public v1
  surface; 0014's reason holds.

## Not decided here

- **Cross-site actions** — anything one site asks another to *do*. 0016 says
  how one would have to look; none is proposed.
- **Whether visitors may be granted more than the operational set.** Possibly a
  multi-campus church wants one head of production to administer every campus;
  that is the configuration-authority question 0014 deferred, and it should be
  answered there, not by widening this list.
- **Alerting on a stale or unreachable peer** under
  [0015](0015-events-and-alerts.md). The probe already reports into
  `health.js`; turning that into an alert is 0015's work.
- **A digest for a campus run by a server that is not paired with this one**
  (A paired with B, B with C). There is no transitivity: A sees only what B
  itself runs. Relaying would make B vouch for C's data, which nothing here
  does.
