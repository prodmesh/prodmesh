# 0019 — Signals, rules and actions: one spine for alerts and automations

Status: accepted · 2026-11-13 · amends [0015](0015-events-and-alerts.md) ·
reshapes [#51](https://github.com/prodmesh/prodmesh/issues/51) · constrains
[#47](https://github.com/prodmesh/prodmesh/issues/47)

## Context

[0015](0015-events-and-alerts.md) designed monitoring: device faults kept as
facts, one alert per condition, Slack told once. #47 builds it in 1.5.

The maintainer's next idea is automation, in the shape of AWS EventBridge:

- **when** Planning Center Services LIVE reaches the Message, **then** start a
  35-minute timer;
- **when** it is T−2:00 before a service time, **then** trigger the
  ProPresenter announcements;
- **when** it is T−4:00, **then** press this Companion button, or call that
  web API.

That is not a 1.5 feature. But it runs on the same machinery as monitoring.
Something happens, a rule decides whether it matters, an action follows. An
alert is one rule whose action is "tell the tech team", with some state
attached. Built narrowly, #47 would hard-wire `health.js` to Slack, and
automation would then need its own fact log, schema and dispatcher. Two
pipelines doing the same thing is the expensive refactor this ADR exists to
avoid.

It also reopens a decision from planning. The device sensors (SNMP traps,
Dante) were to be a separate app, `prodmesh-watch`, that ProdMesh pulls from.
With the alerting brain in the core and automation coming after it, that
choice needs re-arguing on its own merits.

## Decision

### Three parts: signals, rules, actions

- **A signal** is a fact about something that happened. Examples: an
  integration went down; a show item started; a room changed mode; a trap
  arrived. It is append-only and does not change when policy does.
- **A rule** matches signals, optionally with a condition, and names actions.
- **An action** does something: raise or resolve an alert, notify, and later
  press a button, set a mode, start a timer.

0015's `monitor_events` becomes **`signals`**, and the alert router becomes
the first set of rules. Its `alerts` table is unchanged: an alert is the state
one action keeps.

### Words

In the UI, "event" already means a Planning Center plan (Event Detail, "the
9am event"). A second meaning would be confusing on a Sunday, when someone
asks "which event fired?" So:

- internally, **signal**;
- for users, the feature is **Automations**;
- "event" keeps meaning a service.

### A signal is general from the first one

One shape for every source, so automation never needs a second one:

| Field | |
|---|---|
| `id` | Monotonic. Orders this server's signals, and lets a reconnecting reader ask "since N". |
| `ts` | Receiver time. Devices' clocks are not trusted to order anything (0015). |
| `kind` | Namespaced by area: `integration.down`, `integration.up`, `show.started`, `show.item.started`, `room.mode.changed`, `device.trap`, `alert.raised` … |
| `source` | What produced it: `health`, `show`, `pco`, `snmp`, `external:<id>`. |
| `roomId`, `siteId` | Optional. Many signals are about a room; some, like a Planning Center outage, are not. |
| `subject` | The device or integration it concerns, where there is one. |
| `severity` | **Optional.** A fault has one. "The Message started" does not. Requiring it would push automation's signals out of the table. |
| `trust` | `local`, `authenticated` or `unauthenticated`. See *Trust* below. |
| `summary`, `data` | Short text, and bounded structured detail. |
| `cause` | Set when an action produced this signal: which rule, and how many automated steps deep. |

Signals record changes, not continuous state. A slide advance is not a
signal: one service has hundreds of them, and the timeline already records
them. An item starting is a signal, at about thirty per service.

### Producers publish at the moment they notice

The code that sees a change emits the signal itself:

- `health.js` when an integration goes down or comes back, which 0015 already
  planned;
- `showManager` on show start and end, and on each item;
- the room-mode watcher on a mode change.

Nothing derives changes by comparing snapshots afterwards.

This is separate from the topic stream (ADR 0010), which carries current state
to browsers. Rules need changes, and a latest-value feed cannot reliably answer
"WHEN the section changes to Message". The producers simply publish to both.

`emit()` never makes its caller wait. The show manager's 800 ms poll must not
wait on Slack. A signal is written in the same step it is emitted; rules are
evaluated after that and each runs isolated, so one rule's error cannot stop
the others. A rule that throws is reported through `unexpected()` as our bug,
not raised as the church's outage.

### Rules are data, even while only code writes them

0015 deferred the rules UI, and that still stands. But the built-in alert
rules in 1.5 are written as plain data, in the shape a stored rule will have:

```js
{ id, name, match: { kind, roomId?, source? },
  condition: { for?: ms, during?: 'show-live' },   // hysteresis, context
  actions: [{ type: 'alert', severity, notify: 'slack' }] }
```

Then 1.6 can store user rules and add a UI without rewriting the evaluator.
0015's hysteresis, flap suppression and notification budget become conditions
and limits on the `alert` action, not special cases in the router.

### Actions go through the same door as a person

**This is the constraint that matters most, and the reason to decide it in
1.5.** An action that changes a room (mode, show start and stop, a Companion
press, a ProPresenter trigger) goes through the same path as a person or a
service token (ADR 0013):

- the same permission check;
- the same schedule lockouts;
- an audit row naming the rule.

An automation runs under its own identity, "Automation: <rule name>", with a
permission set declared on the rule. It **never** holds
`rooms.mode.override_lock`. A schedule lock exists to stop a mistake during a
service, and a rule written on Tuesday is exactly the mistake it should stop.

In practice, the `/api/v1` writes being frozen for 1.5 are the list of actions
automation will be able to take. They should be a good list.

### Loops are bounded

An action can cause a signal that matches a rule that causes another action.
So:

- a signal carries its `cause`;
- a rule never fires on a signal caused by its own action;
- a chain stops at depth 3, with the stop itself recorded as a signal.

### Trust follows the source

A fact from our own code (`local`) is believed. So is one from a source that
proved who it is (`authenticated`): SNMPv3 with auth, or a sidecar over a
pinned connection.

A fact from unauthenticated UDP (an SNMPv1/v2c trap, a multicast packet) is
**`unauthenticated`**: anyone on the LAN can forge one, source address
included. Such a signal may raise an alert. That is the point of monitoring,
and a forged one is a nuisance, not harm. **It may not trigger an action that
changes a room** unless the rule explicitly accepts it, and the rules UI will
say so. Otherwise a forged trap could press a button on a Sunday morning.

### Time and timers are producers too, later

T−2:00 and "35 minutes from now" are not things a device reports. They are a
clock source that emits `service.countdown` at offsets rules ask for, and a
`timer.start` action that emits `timer.expired`.

Both need durable state, because a restart must neither drop a pending timer
nor fire one twice. Autostart's arm window and its "never start twice" rule
already solve the hard part, which is "which service time is next in this
room". So this is buildable in 1.6, and nothing in 1.5 should get in its way.

### The spine is core, and so is any sensor that can be

The signals, rules, alerts and actions are ProdMesh: the server holds the
rooms, users, permissions and show context that give a signal its meaning.
That much 0015 already said. This ADR goes further: **first-party sensors live
in the core too**, unless one of three things forces them out.

A sensor belongs in a separate process only when it:

1. **needs native code or hardware access**, which breaks Docker, `npm ci`
   installs and the Electron build together (PLAN-1.5 already sends native
   MIDI and LTC timecode to sidecars for this reason, and
   [`prodmesh-rta`](https://github.com/prodmesh/prodmesh-rta) is one because
   it captures audio);
2. **carries code whose licence or origin we cannot put in an MIT core**, such
   as reverse-engineered Dante beyond what anyone can observe; or
3. **must run somewhere the server is not**, such as on a production VLAN the
   ProdMesh box cannot reach.

Re-checking the reasons PLAN-1.5 gave for `prodmesh-watch` against that test:

- **"Port 162 is privileged."** True only on Linux, and narrower than it
  sounds. A systemd unit can grant just the low-port capability
  (`AmbientCapabilities=CAP_NET_BIND_SERVICE`) without root. Docker maps host
  `162/udp` to an unprivileged port in the container. macOS and Windows have no
  privileged ports. Many devices also let the trap destination port be set.
- **"Unauthenticated UDP ingest does not belong in the server."** It already
  has it: Open Sound Meter arrives over UDP multicast. The defences are
  0015's, applied in the server instead of in a sidecar:
  - off until switched on;
  - accepted only from addresses bound to a configured device, since a trap
    nobody bound to a room means nothing anyway;
  - rate-limited per source and in total;
  - payloads bounded;
  - marked `unauthenticated`.
- **"Dante may need work of uncertain origin."** Only beyond presence. A device
  advertising itself over mDNS, and vanishing, is ordinary multicast DNS, which
  #56 brings into the core anyway. Presence is a core sensor. Anything deeper
  waits on the question #51 already asked, and if it ever ships, it ships
  outside under reason 2.
- **SNMP itself.** Receiving a trap is a UDP socket and a BER decoder.
  Pure-JavaScript implementations exist, so it hits none of the three reasons.

So **`prodmesh-watch` is not built**. SNMP traps and Dante presence become
core sources in 1.6: off by default, configured in Admin like any other
integration, with one status dot each.

What survives of #51 is the part that was always more general than SNMP: **the
contract for an external source**. That is how `prodmesh-rta`, a future
timecode sidecar, a reverse-engineered Dante probe, or a church's existing
monitoring system feeds signals in. 0015's argument for that contract still
holds: ProdMesh connects to the source, asks "since N", detects gaps, and
treats a silent socket as a fault. The source reports only device identity,
and ProdMesh binds devices to rooms.

### What 1.5 builds, and what it does not

**#47 builds:**
- the `signals` table (the shape above) and `emit()`;
- producers in `health.js`, `showManager` and the room-mode watcher;
- a rule evaluator that runs the built-in alert rules as data;
- the `alert` action, with 0015's noise controls;
- `trust` and `cause` on every signal, even though only `local` signals exist
  in 1.5.

**#51** becomes the external-source contract, written down, with
`prodmesh-rta`'s existing frames as the first case it must fit.

**Not in 1.5:**
- signals on the public `/api/v1` stream. The allowlist (ADR 0013) means
  adding them later costs nothing, and freezing a format in the release that
  invents it is how formats get frozen wrong;
- user-written rules, or any rules UI;
- any action other than `alert`;
- the clock source and timers;
- outbound web requests as an action. Those are a booth machine making calls a
  volunteer set up, which deserves its own threat argument, like federation's;
- SNMP and Dante sources.

## Consequences

- **Automation in 1.6 means new producers and new action types, not a second
  pipeline.** The signal format, the evaluator, the audit path and the loop
  guard already exist.
- **The v1 write surface becomes the list of automation actions.** Gaps in it
  (no "trigger a ProPresenter cue", say) are gaps in what automation can do, so
  it is worth checking the list before 1.5 freezes it.
- **One process to install and update.** A church gets device monitoring by
  ticking a box, not by installing a second app, which keeps #18's "download,
  install, open" true.
- **More traffic into the server's process.** A trap storm, hostile or not,
  costs the dashboard's CPU instead of a sidecar's. The rate limits are the
  defence, and the reason they are required rather than optional.
- **0015 is amended, not replaced.** Its alert lifecycle, noise controls,
  outage-versus-bug split, retention and permissions all stand. What changes:
  - the table name;
  - the requirement that severity be present;
  - the line "there is no inbound ingest endpoint", which holds for 1.5 but not
    after SNMP;
  - `prodmesh-watch`.
- **Signals are local.** They do not cross the federation link. A linked
  server's digest may carry open-alert counts (0015); a peer's signals would be
  untrusted input, and nothing here forwards them.

## Not decided here

- **The rules UI and the condition language.** Wait for the first rules
  churches actually ask for, as 0015 said.
- **Retention per kind.** Item starts and device traps probably want different
  lifetimes. One `PRODMESH_SIGNAL_RETENTION_DAYS` is enough to start.
- **Whether an action can wait on its result.** "Press the button, then check
  the mode changed" is plausibly a second rule, not a step inside one.
- **SNMP MIB handling.** Raw OIDs are useless to a volunteer. How much naming
  we ship is a question for 1.6, with real Evertz traps to look at.
