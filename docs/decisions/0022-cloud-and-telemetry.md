# 0022 — The cloud, starting with telemetry

Status: **accepted** · 2026-11-27 (proposed 2026-11-25) · implements
[#37](https://github.com/prodmesh/prodmesh/issues/37) · second consumer of
[0015](0015-events-and-alerts.md)'s outage/bug split · revisits
[0021](0021-monitoring-sidecar.md) §7 for telemetry only · leaves room for
tenant accounts and a mobile app without building them

## Context

Every ProdMesh today is an island, deliberately: a LAN appliance whose only
traffic leaving the building is federation, which is off unless switched on
(0014, 0016, 0017). That is right for the product and leaves the maintainer
blind. A release ships, `deploy/update.sh` moves churches onto it, and the
first sign of a bug is a volunteer mentioning a red banner. #37 asks for the
opposite: learn that a release is hurting people before anyone says so.

The cloud is wanted for more than that, later: collaboration features
(asset tracking, sermon archival), metrics a church opts to keep off-site,
tenant accounts, and an "access anywhere" mobile app. None of those are built
here. Telemetry is the thin slice, and this ADR has two jobs: make the slice
small, and make sure it does not take a shape the later work has to undo.

What is already decided elsewhere and binds this:

- **The classifier exists.** `health.js`'s `unexpected()` is where a bug is
  told apart from an outage (0015). Telemetry consumes that; it does not grow
  its own error capture.
- **PLAN-1.5's terms for #37:** off by default; a screen that shows exactly
  what a payload contains; the `server/`-is-published rule applied to payloads
  (never a Planning Center id, room name, or person's name); and an offline
  queue that **drops** rather than grows, because a booth with no route to the
  internet is the normal case.
- **0021 §7:** anything leaving the building is *metrics only, never control*,
  and meets federation's bar.

## Decision

### 1 · Two channels, which never merge

Everything the cloud will ever do falls on one of two channels, and they are
built as separate things, with separate switches, separate identifiers and
separate code:

| | **Telemetry** (this ADR, built now) | **Cloud link** (designed for, not built) |
|---|---|---|
| Purpose | the maintainer learns about bugs and releases | a church uses cloud features and the mobile app |
| Who it identifies | nobody: a random install id | a tenant (a church) and its users |
| Direction | one-way POST, response ignored | outbound persistent connection, two-way |
| Switch | Admin → System → *Telemetry* | Admin → *Cloud*, by claiming the install into an account |
| Identifier | `telemetryId`, random, resettable | the install's existing system identity (#49) |
| Authority | none, either way | whatever this server's own rules grant (§7) |

The rule that matters: **linking an account must never de-anonymise
telemetry.** So the telemetry id is not the system id, is not derived from it,
and is never sent on the cloud link; and the cloud never joins the two. A
church that links an account and keeps telemetry on is, as far as telemetry
knows, still an anonymous install.

The system id is also the wrong thing to send for a second reason: the first
six characters are broadcast over mDNS (#56) and the whole id is shared with
every paired peer, so it is not anonymous on any network the box sits on.

### 2 · AWS, serverless, with no fixed-cost services

Considered: AWS, Azure, Vercel. At telemetry's volume every option is nearly
free; what separates them is what the *later* channel costs, and which
services carry a monthly floor whether or not anything uses them.

Rough list prices, from memory, not checked today; check before committing:

| | AWS | Azure | Vercel |
|---|---|---|---|
| Telemetry ingest (≈200 installs) | API Gateway HTTP API + Lambda + DynamoDB + S3: **≈ $1/month**, mostly the Route 53 zone | Functions (consumption) + Table Storage: **≈ $1/month** | Functions + an external DB: free tier is non-commercial, so Pro at **$20/seat/month** |
| Device connectivity for the cloud link | **IoT Core**: per message and per connected minute, **no floor** (cents per install per month) | IoT Hub: free tier is tiny; first paid tier has a **≈ $25/month floor** | no long-lived device connections; would need a third service |
| User accounts | Cognito: free tier covers thousands of monthly users; passkeys | Entra External ID: similar free tier | bring your own (Clerk, Auth0) |
| Familiarity | the maintainer's | — | — |

**AWS.** Azure is not cheaper on the shape that matters: the cloud link's
always-connected booth boxes, where IoT Core has no floor and IoT Hub does.
Vercel is the best host for a web front end, and can still be that later, but
it is the wrong home for ingest or device connections, and it starts at $20 a
month.

The cost discipline is the decision as much as the vendor. A hobby-scale bill
is ruined by services that charge by the hour whether used or not, so this
stack **does not use**: a NAT gateway, a load balancer, RDS/Aurora with a
floor, VPC interface endpoints, WAF, or Secrets Manager (SSM Parameter Store
standard tier is free). Lambdas run outside a VPC. Any of these can come back
when a feature needs it and pays for it.

Account layout: AWS Organizations with a billing-only management account and
two workload accounts, `prod` and `dev`; IAM Identity Center for sign-in;
deploys from GitHub Actions through OIDC, so no long-lived keys exist. A
Budgets alarm at a low figure (say $10) and Lambda reserved concurrency (say
5) cap what a flood can cost.

### 3 · Where the code lives

- **Client: this repo**, `server/telemetry/`. It runs inside every church's
  install, so it is MIT, reviewable, and published like everything else under
  `server/`.
- **The payload schema: this repo**, as `server/telemetry/schema.js` and
  `docs/TELEMETRY.md`, field by field. The promise "this is all we send" has
  to be readable by the church receiving the software, and checkable by a
  test against what the collector actually builds.
- **Cloud: a private repository**,
  [`prodmesh/cloud`](https://github.com/prodmesh/cloud), AWS CDK in
  TypeScript, not open source. It vendors the schema at a named version.
  Separate because it deploys separately and on a different cadence, and
  private because the open core does not need the cloud's code to be open,
  and a hosted product does not want it to be.

  The boundary runs one way. The cloud repo may read anything here; this
  repo carries only the **contract**: the payload schema, the endpoint's
  path and status codes (§6), and, later, the cloud link's protocol. No
  cloud source, infrastructure detail, account id or internal hostname is
  ever copied into this repo, which is public and ships in every image.

### 4 · What is sent

A report is JSON, schema `prodmesh-telemetry/1`, at most 64 KB. Every field
is in the allowlist below; anything else is a bug in the collector and a
rejection at ingest. Counts are **bucketed** (`0`, `1`, `2-5`, `6-20`, `21+`)
so that a configuration's exact shape cannot fingerprint a church.

**Envelope** — `schema`, `telemetryId`, `sentAt`, `seq` (per-install
counter, to see drops).

**Build** — ProdMesh version and commit, deployment kind (`git`,
`container`, `desktop`, `package`, from `deployment.js`), Node version,
Electron version if any.

**Host** — OS platform and release, architecture, CPU model and count, total
memory bucketed. Not the hostname, not the timezone, not the locale: each
narrows down where the box is.

**Resources** — over the reporting window: process RSS and heap (peak and
median), event-loop delay p50/p99 (`perf_hooks.monitorEventLoopDelay`),
process CPU share, uptime, free disk on the data volume and database size,
both bucketed. Peak SSE clients, bucketed. This is ProdMesh's own health,
not the booth machines': those are the sidecar's (0021) and stay in the
building.

**Shape** — rooms, campuses, linked servers and users, bucketed; which
integration *types* are configured (ProPresenter, Companion, Planning
Center, Smaart, OBS, …) as booleans; the **product version each integration
reports** (ProPresenter 21.4, Companion 4.x). That last one is the field
most likely to explain a bug: *a ProPresenter minor version can change API
behaviour underneath passing tests*, and this is how we find out which.

**Errors** — one entry per error group seen in the window, from
`unexpected()`: the `where` label (a constant from our own code), the error
name, a scrubbed message, scrubbed stack frames, a fingerprint, a count, and
first/last seen. Outages are never sent: they are the church's business
(0015), and their messages are full of the church's addresses.

**Crashes** — the previous process's unclean exit, if there was one (§5).

Scrubbing, applied to every message and stack before anything is queued:
stack frames are kept only inside ProdMesh's own code, with paths made
relative to the install root (an absolute path holds the OS username);
messages have quoted strings, URLs, IP addresses, email addresses, UUIDs and
long numbers replaced by placeholders, and are cut at 200 characters. A
message like `Unexpected token in JSON at position 41: {"name":"…"}` keeps
its shape and loses its contents.

A second layer, added in implementation, catches names written as plain words,
which no pattern can: the collector knows this server's own configuration, so
the church's, the server's, every campus's and room's (id and name), and every
local user's username and display name are replaced with `<name>` before an
error is kept. `where` labels are cut to their first word, because several
carry a room id (`autostart ${roomId}`). Integration names come from a fixed
allowlist, not from health keys, because a linked server's key is
`peer:<its system id>`.

The fingerprint is a hash of `where`, the error name and the top scrubbed
frames, so the same bug groups together across installs and versions, and a
new fingerprint on a new version is the signal that a release introduced
something.

### 5 · Crashes are recorded on the way down and sent on the way up

A process that is crashing cannot be trusted to make a network request. So:

- on boot, write `telemetry/running` to the data directory; remove it on a
  clean shutdown (the SIGINT/SIGTERM path that already exists);
- an `uncaughtException` / `unhandledRejection` handler writes the scrubbed
  error to `telemetry/fatal.json` **synchronously**, then exits as Node would
  have;
- on the next boot, a leftover `running` marker means the last run ended
  uncleanly; it goes in the next report, with `fatal.json` if it exists and
  the uptime it reached.

Unclean exits over boots, per version, is the crash rate a release is judged
on. Power cuts and `kill -9` count too; the rate is a comparison between
versions, not an absolute.

This needs the handlers whether or not telemetry is on, and logging a fatal
error with its stack is worth having for Admin → Logs alone.

### 6 · How it is sent

- **Cadence.** One report a day, at a time jittered per install so all
  churches do not arrive on the hour. A new error group brings the next report
  forward, at most once an hour. Nothing is sent **while any show is live**;
  it waits. The payload is small, but "it never does anything during a
  service" is a property worth being able to state flatly.
- **Queue.** Reports aggregate in memory and in
  `telemetry/pending.json`: errors merge by fingerprint, resources keep the
  window's summary, so the queue's size is bounded by the number of distinct
  error groups (capped at 50, then counted as `dropped`), not by time offline.
  A box offline for a month sends one report when it comes back. The file is
  capped at 256 KB and **excluded from backups**, so a restore does not replay
  another box's history.
- **The telemetry id is also not in backups.** A restore, or a new box, is a
  new install as far as telemetry knows. Admin can reset it at any time.
- **Endpoint.** `POST https://<telemetry host>/v1/reports`, gzipped JSON.
  The client reads only the status: `2xx` done; `429` back off per
  `Retry-After`; `400` log once and drop that report (retrying a malformed
  report forever helps no one); `410` stop sending for this version, so a
  retired schema can be switched off without an update. Nothing in a response
  body is ever acted on.
- **Signing.** Each install makes an Ed25519 telemetry key beside its id.
  The first report registers the public key for that id; later reports must
  carry a signature over the body. This does not stop anyone inventing new
  installs, but it stops anyone writing into an existing install's history,
  and it lets an install delete its own data later
  (`DELETE /v1/installs/{id}`, signed) without an account.
- **TLS: ordinary WebPKI validation, not pinning.** This is a deliberate
  departure from 0021 §7's "pinned by certificate", for this channel only.
  Pinning protects what a channel carries, and this one carries a payload
  designed to be publishable and grants nothing in either direction. The
  cost of pinning is concrete: AWS rotates its certificates, and a church
  behind a TLS-inspecting firewall would lose telemetry silently, which is
  exactly the failure we cannot see. The cloud link (§7) does pin, because it
  carries authority.
- **No IP addresses kept.** The connection's source address is not written
  to access logs, Lambda logs or storage. It is the one identifying thing
  that cannot be kept off the wire, so it is kept out of everything else.

### 7 · The cloud link is a federation peer, and grants what visitors get

Not built here. Its shape is fixed now because it is the reason telemetry is
kept apart from it, and because the mobile app collides with 0021's *never
control*.

- **Claiming.** Admin → Cloud shows a one-time claim code, the way pairing
  shows a `pmjoin1` token (0017); a church admin enters it in the cloud's web
  app. The install's **existing** P-256 certificate (#49) is registered with
  AWS IoT Core, which accepts self-signed device certificates without a CA,
  and the install connects outbound over MQTT on a WebSocket: no port forward,
  behind any NAT. The install pins a ProdMesh-run key for the cloud, not
  AWS's leaf certificate, so rotation on AWS's side breaks nothing.
- **Authority stays here.** To the install, the cloud is one more linked
  server: a user arriving through it is a visitor, `name@cloud`, governed by
  the per-peer Visitors rules ADR 0018 already built: View reports by
  default, at most the operational set, never administrative and never a
  schedule-lock override. A compromised cloud can do at most what the
  church's own visitor rules allow, and the church can turn that to nothing.
- **What that means for *never control*.** Read-only access anywhere (a
  room's mode, the live show, the next event, open alerts: the digest of
  0018) fits 0021 §7 as written. Pressing a button from a phone does not.
  **The first mobile release is read-only.** Control from the cloud, if it
  ever comes, arrives as a revision of 0021 §7 that a church opts into per
  permission through the visitor rules, not as a side effect of the app
  existing.
- **Tenants.** A tenant is a church. Users are Cognito users belonging to
  tenants; an install belongs to at most one tenant. The tenant store is not
  chosen here: DynamoDB is enough for the slice, and whether accounts,
  invitations and billing want a relational database (and its floor) is a
  question for when they exist.

### 8 · The maintainer's side

The point is reacting to releases, so the useful output is not a dashboard
to remember to open:

- **Ingest.** API Gateway (HTTP API, stage throttling) → one Lambda that
  validates against the schema, rejecting unknown fields, checks the
  signature, and writes to:
  - **S3 via Firehose**, raw reports partitioned by day, kept 13 months,
    queried ad hoc with Athena;
  - **DynamoDB**: `installs` (id → key, first/last seen, version, deployment
    kind, platform) and `error_groups` (fingerprint + version → count,
    installs affected, first/last seen, one sample). Installs silent for 90
    days are deleted.
- **A daily digest.** An EventBridge schedule runs a Lambda that sends the
  maintainer one message (email via SES, or the Slack webhook already used
  for alerts): installs reporting, by version and deployment kind; crash rate
  per version; **new** error groups since the last digest, with the version
  they first appeared in.
- **A release alarm.** In the first 72 hours after a tag, a new error group
  seen on more than one install, or a crash rate above the previous
  version's, is sent at once rather than waiting for the digest.

A web dashboard can come later, on Vercel or S3 + CloudFront, and costs the
slice nothing to defer.

### 9 · On screen

Admin → System → **Telemetry**, following UI_TEXT:

- a switch, off by default;
- **What is sent**: the exact next report, pretty-printed, built by the same
  function that sends it, not a description of it;
- last sent, and its result;
- **Reset ID**;
- a HelpTip linking `docs/TELEMETRY.md`.

First-run setup asks once, unticked. An admin signing in for the first time
after updating to the release that adds this sees one dismissible prompt,
also unticked. `PRODMESH_TELEMETRY=off` forces it off and the switch says so,
for an organisation that wants that decided by policy rather than by
whoever has the admin PIN.

## The slice, in order

Client, in this repo:

1. Unclean-exit marker and the fatal handlers (§5). Useful with telemetry
   off; ships first. **Done** (`server/lifecycle.js`), with the consent
   switch from step 5 brought forward: Admin → General → *Crash reporting*
   holds the switch and this server's own count of unexpected stops. The
   first-run question and post-update prompt are still to come.
2. `server/telemetry/`: collector, scrubber, schema, bounded queue. Tests:
   the collector's output validates against the schema; a fixture full of
   addresses, names and absolute paths comes out of the scrubber clean; the
   queue stays bounded after a simulated month offline; nothing sends while a
   show is live. **Collector, scrubber and schema done**, with the leak test
   using the live demo configuration as its oracle; the queue and the
   live-show rule belong with the sender (step 4).
3. `unexpected()` and the fatal handler feed the collector. **Done.**
4. Sender, signing, backoff, the `410` stop. **Done** (`server/telemetry/sender.js`),
   with the queue and the live-show rule, but **no endpoint**: `DEFAULT_ENDPOINT`
   is null until the domain is chosen, so nothing is sent. Two changes found
   in the building: a fingerprint counts only ProdMesh's own frames (Node's
   below them differ by how the code was reached, which split one bug into
   several groups), and a report sheds frames, then its rarest errors, to
   stay under 64 KB rather than be refused.
5. Admin → System → Telemetry, first-run question, the post-update prompt.
6. `docs/TELEMETRY.md`, field by field, checked by a test against the schema.
   **Done**, along with *What is sent* and *Reset ID* from step 5.

Cloud, in `prodmesh/cloud`:

7. Organizations, Identity Center, OIDC deploy role, budget alarm.
8. CDK stack: API Gateway, ingest Lambda, Firehose → S3, DynamoDB, a dev
   stage the client points at with `PRODMESH_TELEMETRY_URL` (dev only).
9. Digest and release alarm.

Then a release with telemetry on the maintainer's own box first, for a
Sunday, before it is offered to anyone else.

## Consequences

- **The maintainer sees releases land:** which versions are running where,
  and what broke, within a day, without anyone reporting it.
- **Only churches that say yes are seen.** Opt-in telemetry from a small
  install base will be a few installs. That is the price of the bar in
  PLAN-1.5, and the reason the question is asked at setup rather than
  buried in Admin.
- **A second thing to run.** An AWS account, a CDK stack, a domain. Small,
  and built to cost nothing when idle, but no longer zero.
- **Crash handling improves for everyone,** telemetry or not (§5).
- **The cloud link has a shape that does not need telemetry to change,** and
  telemetry has nothing the cloud link could later make identifying.

## Considered and not chosen

- **Sentry (or PostHog) instead of our own ingest.** Free at this scale, and
  much better at grouping errors. Not chosen because its SDKs capture
  context automatically (breadcrumbs, request data, local variables), which
  makes "the screen shows exactly what is sent" a promise about someone
  else's code; because it puts a third-party processor between churches and
  us; and because it builds nothing toward the cloud link. Revisit if our
  own grouping turns out poor: the scrubbed payload could be forwarded to
  one, server-side, without changing what leaves the building.
- **OpenTelemetry as the wire format.** For the reasons in 0019; the schema
  is small enough to map later if a reason appears.
- **Reusing the system id.** §1.
- **Routing telemetry through the monitoring sidecar,** as 0021 §7 placed
  "any path to a hosted service". The sidecar is for the church's metrics
  about its booth machines; telemetry is the maintainer's data about
  ProdMesh, has to work on installs that never run the sidecar, and is
  smaller than the sidecar's own release train.

## Not decided here

- **The domain** and the region.
- **Control from the cloud**, beyond a read-only first release (§7).
- **The tenant store,** and anything about accounts, billing or pricing.
- **Retention beyond the slice:** 13 months raw and 90 days of install
  silence are starting points.
- **Whether the desktop app in client mode reports anything.** It has no
  server, and so no `unexpected()`; its Electron shell could report its own
  crashes the same way, later.
