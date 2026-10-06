# 0015 — Events are facts, alerts are state

Status: proposed · 2026-10-06 · planned in [PLAN-1.5.md](../PLAN-1.5.md)

## Context

[VISION.md](../VISION.md) §4 asks for something the production world mostly does
not have: *real-time monitoring of room systems and preemptive alerting when
something drifts out of bounds — before it becomes a Sunday-morning surprise.*

Most of the machinery for that already exists and is not wired to anything.

**`server/health.js` already detects the transitions.** Every transport choke
point calls `report(key, ok, message)`, the registry tracks
`consecutiveFailures`, and it deliberately logs *one* line when an integration
goes down and one when it recovers — "never one per retry, so a Sunday-morning
outage is a grep-able pair of lines, not a flood". That is an event stream with
hysteresis already thought about. It goes to `console`.

**`server/health.js` also already classifies the two kinds of bad news.**
`outage(err, key)` tags a failure as a device or network problem; `unexpected(where, err)`
logs anything else with its stack, throttled to once a minute per site. This
distinction was added for #41, because `.catch(() => [])` made a `TypeError` in a
Planning Center parser read exactly like "Planning Center is down".

**`server/assistance.js` already implements an alert lifecycle, for a different
trigger.** A volunteer presses the help button, the tech channel gets a Slack
message, a 👀 reaction means "on my way", and Dismiss puts a ✅ on the original
post so the channel reads as a live open/closed board. Raise → acknowledge →
resolve, in production, over `server/integrations/slack.js`.

So the gap is narrower than "build monitoring". What is missing is: somewhere to
*keep* events (`health.js` is an in-memory `Map`, so nothing survives a
restart and there is no history), a notion of an alert distinct from the fault
that caused it, and a decision about what deserves to interrupt a human.

That last one is the part that decides whether this feature is used or muted. A
monitoring system that cries wolf on its first Sunday gets silenced, and a
silenced monitor is worse than none, because now everyone believes something is
watching.

## Decision

### The outage/bug split already written decides the *audience*

This is the most useful thing `health.js` already knows, and it resolves what
would otherwise be two overlapping features:

| Classification | Who needs to know | Sink |
|---|---|---|
| **Outage** — a device, room system or API is unreachable or misbehaving | the church's tech team, **now** | an alert (this ADR) |
| **Bug** — an unexpected error, i.e. our mistake | the maintainer, **later** | telemetry (#37) |

So telemetry is not a parallel pipeline to be built alongside this one; it is the
*second consumer* of a classification that exists today. One classifier, two
audiences, two sinks. A church should never be paged because we shipped a
`TypeError`, and we should never learn about our own bug only because a volunteer
mentioned a red banner.

### Events are append-only facts; alerts are derived state

Two tables, because they answer different questions and have different
lifetimes.

**`monitor_events`** — an immutable log of things that happened: timestamp,
source (`health`, `watch`, …), kind, dedupe key, intrinsic severity, room and
site binding where known, device identity, a short summary, structured detail,
and a bounded raw payload. Append-only. This is the history that lets somebody
ask "was the Auditorium's ProPresenter flaky *before* last Sunday?".

**`alerts`** — the conditions currently believed wrong: dedupe key, first and
last seen, occurrence count, severity, state (open / acknowledged / resolved),
who acknowledged it, and the reference to its notification so the Slack post can
be updated in place.

The distinction is what stops forty events becoming forty Slack messages. A
flapping ProPresenter writes many rows to `monitor_events` and updates **one**
row in `alerts`.

**This is deliberately not `audit_log`.** That table answers *who did what, and
was it allowed* — it has `user_id`, `station_id`, `result`. A device event has no
actor, different retention, and a different audience. Acknowledging an alert, on
the other hand, *is* a human action and does write an audit row.

### An alert resolves itself; an assistance request does not

The lifecycle generalizes `assistance.js` with one change. A help request is
closed by a person, because only a person knows whether help arrived. A device
fault is closed by the *fault going away*: the `fail→ok` transition
`health.js` already detects resolves the alert and marks the Slack post
accordingly. Acknowledgement remains human and remains meaningful — it says
somebody is looking — but recovery is not something we should make anyone
confirm at 10:42 on a Sunday.

### Nothing notifies on the first failure

The failure mode to design against is noise, so:

- **Hysteresis.** `health.js` already counts `consecutiveFailures`; an alert
  raises after a threshold, not on the first failure. A ProPresenter poll that
  fails once while an operator triggers a slide must not reach anybody.
- **Flap suppression.** A key that crosses back and forth repeatedly within a
  window raises one "flapping" alert and stops re-notifying, rather than
  narrating each crossing.
- **A notification budget.** Beyond N notifications in a window, further alerts
  are recorded and summarized in a single message ("12 further alerts
  suppressed") instead of sent individually. This protects the humans first and
  Slack's rate limits second.
- **Recording is not notifying.** Everything lands in `monitor_events`. Only a
  curated set notifies, and the default set is small. It is far easier to add a
  rule after a Sunday that surprised somebody than to win back a channel people
  have learned to ignore.

### Severity is intrinsic; routing is contextual

The event carries the severity its source gives it, and nothing more — it is a
fact, and facts should not change when policy does.

**Routing** decides whether and how loudly to notify, and that is where context
enters: the same ProPresenter outage is a note on a Tuesday afternoon and an
interruption at 10:42 on a Sunday. ProdMesh knows which it is, because
`showManager` knows whether a show is live in that room. A sensor never will —
which is the architectural reason the monitoring sidecar stays a sensor and the
rules live here.

### Everything a device says is attacker-supplied

`assistance.js` already carries this reasoning, and it applies harder here. It
escapes `&`, `<`, `>` and neutralizes `@here`/`@channel` before a station name
reaches Slack, because station registration is unauthenticated and a station
named `Booth <https://evil.example|Click to approve>` would have the church's own
trusted bot phish its own tech channel.

A device event is worse: **SNMP traps are unauthenticated UDP.** Anyone who can
reach the port chooses the `sysName`, the varbind strings and the community
string. So:

- **One escaper, shared.** `assistance.js`'s `clean()` moves into the Slack
  module and every sink path uses it. A second copy would drift, and the copy
  that drifts is the one that posts the link.
- **Rate-limit per source and in total.** Forged trap storms are unauthenticated
  resource exhaustion, which `CLAUDE.md`'s threat model explicitly says is in
  scope for a LAN appliance. The notification budget above is a human-attention
  measure; this is a separate one against the ingest path.
- **Bound every stored payload.** A trap can be large and a device can lie about
  its own length.
- **There is no inbound ingest endpoint in 1.5.** Because ProdMesh *pulls* from
  the monitoring sidecar rather than being pushed to, nothing new listens for
  unauthenticated writes. The ingest surface stays inside the sidecar, where
  port 162 and its privileges also stay.

### Retention follows the SPL precedent

`splStore.prune()` deletes beyond `PRODMESH_SPL_RETENTION_DAYS` (default 90, 0
disables) and logs what it removed. `monitor_events` gets the same shape with its
own variable. Raw payloads are the bulk of the volume, and the sidecar — which
owns the complete device log, per the `prodmesh-watch` design — is the right
place for the long tail. ProdMesh keeps what mattered, not everything that was
said.

### Permissions

- **Seeing open alerts needs none.** A dashboard is readable by an unauthenticated
  station by design, and a red banner on a booth display is the whole point.
- **Acknowledging needs a permission** and writes an audit row, because it is a
  claim that somebody is handling it.
- **Editing routing rules** is `settings.manage`, alongside schedules.

## Consequences

- **Existing faults light up with no new protocol.** ProPresenter, Companion,
  Smaart, OBS, Planning Center and the analysis sources already report through
  the choke points, so the first useful version of this feature ships before
  SNMP or Dante exist.
- **Fault history outlives a restart**, which `health.js` alone cannot offer. This
  is also what "persistently log Dante device errors" needs.
- **`health.js` grows one hook, not a rewrite.** It keeps its `console` lines and
  its in-memory snapshot; the spine subscribes to the transitions it already
  computes.
- **An alert survives a restart but detection restarts with it.** Open alerts are
  rows, so they come back — but the registry is rebuilt from the first poll
  cycle after boot, so a fault that began before a restart is re-detected rather
  than remembered continuously. The recovery event may therefore arrive without
  a matching raise in the same process.
- **A device that was already down at boot is indistinguishable from one that
  just went down**, since `declare()` reports `ok: null` until first contact and
  the first failure is the first transition. Acceptable; worth knowing when
  reading a timeline.
- **Clock and ordering.** Events are stamped by the receiver, not the device.
  A sidecar's sequence numbers (per the watch spike) order its own stream;
  nothing promises a global order across sources.

## Not decided here

- **The `prodmesh-watch` contract** — the normalized event schema on the wire,
  sequence numbers and gap detection. That is the spike recorded in
  [PLAN-1.5.md](../PLAN-1.5.md); this ADR only commits to the sidecar being a
  *source* that normalizes into `monitor_events`, and to ProdMesh pulling.
- **Whose Slack gets a remote site's alert**, once sites federate
  ([0014](0014-a-server-per-site.md)). The default should be that a site alerts
  its own team and the all-campuses digest carries counts, but the cross-site
  escalation case ("the campus with no tech on site tonight") deserves its own
  argument.
- **Sinks beyond Slack.** Email and webhooks are additive behind the same
  interface; building the interface for one implementation is enough for now.
- **Whether telemetry shares this table.** It shares the *classifier*; it should
  probably not share the storage, since one of them leaves the building and
  therefore answers to a different set of rules about what a payload may contain.
- **The rules UI.** Defer until there is a real list of things churches wanted
  routed differently, rather than guessing the shape of a rule engine.

## Known limits

- **Hysteresis trades detection latency for quiet.** A threshold of three failed
  polls on an 800ms loop is fast; on a five-minute poll it is fifteen minutes.
  Thresholds want to be per-source, expressed in time rather than counts.
- **Nothing here monitors ProdMesh itself.** A spine that stops running raises
  no alert about its own silence — the same ambiguity that argued for pulling
  from the sidecar rather than being pushed to. An external check is the only
  honest answer, and it is out of scope.
