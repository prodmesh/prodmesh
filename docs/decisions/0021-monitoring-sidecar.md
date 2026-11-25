# 0021 — A monitoring sidecar: Prometheus behind ProdMesh, never beside it

Status: **proposed** · 2026-11-25 · revisits the `prodmesh-watch` outcome of
[0019](0019-signals-rules-and-actions.md) · first in-house source for
[0020](0020-external-signal-sources.md)'s generic format · builds on
[#60](https://github.com/prodmesh/prodmesh/issues/60)

## Context

The question that started this: when the ProPresenter Mac stutters, was the
computer the problem? Answering it means CPU, memory, disk and temperature for
the booth machines, **as a graph over time**, the way anyone debugging a host
looks at one.

That is a different kind of data from anything ProdMesh keeps today, and 0019
drew the line exactly here: *"Signals are change-driven, not sampled: there is
no metric polling at 10 seconds or any other rate."* Its defences for the live
show (a bounded queue that drops, rules run after every write, the storm
test) assume a quiet table with rare bursts. A steady stream of samples is a
permanent load on that spine, and on a busy Sunday it would fill the queue with
CPU readings and drop the signal that mattered.

The volume itself is not the problem. Six machines at one sample every 15
seconds is under one write a second, which SQLite in WAL mode absorbs. The
problems are elsewhere:

- **Shape.** Samples are not signals, and storing them as signals breaks 0019.
- **Lifetime.** SPL is per service and pruned at 90 days. Host metrics run
  around the clock, so the data folder, the WAL and every backup grow on a booth
  box whose disk we would be monitoring.
- **Growth.** Everything in the server scales with rooms. This would be the one
  load that scales with machines, which a church adds without thinking about
  ProdMesh.
- **Reinvention.** A time-series store with retention, downsampling and range
  queries is Prometheus. Building one inside ProdMesh would be a worse copy.

Collection cannot happen in the server anyway: another machine's CPU is only
measurable on that machine. `node_exporter` (Linux, macOS) and
`windows_exporter` (Windows) are the maintained, standard answer, and a church
with an IT person may already run them.

0019 decided that `prodmesh-watch` would not be built, because every sensor it
was meant to hold (SNMP traps, Dante presence) could live in the core. That
still holds for those sensors. What is new is a store: Prometheus is a separate
Go binary that cannot ship inside the Docker image, `npm ci` or the Electron
build without breaking all three, which is 0019's reason 1. Deep Dante work,
beyond the NetAudio adapter of 0020, is reason 2. The test is unchanged; this
is the first thing to pass it.

## Decision

### 1 · Samples never enter the ProdMesh process

No time series is written to ProdMesh's SQLite or flows through `emit()`.
ProdMesh holds **what something means** (conditions, alerts, the service they
happened in). Prometheus holds **how a number moved**. A graph is a query made
when someone opens it, not a stream ProdMesh keeps.

### 2 · A sidecar, in its own repository

Working name `prodmesh-monitor`, a sibling of `prodmesh-rta`, with its own
releases. It ships first as an **optional Docker Compose profile** next to
ProdMesh, not in the desktop app. It contains:

- **Prometheus, sized for a booth box:** `--storage.tsdb.retention.time=14d`
  and a size cap, so it cannot fill the disk it is meant to watch.
- **Scrape targets generated from ProdMesh,** never typed into a Prometheus
  file. The sidecar fetches a monitoring configuration from ProdMesh (below)
  and writes Prometheus's `file_sd` targets from it. The tech team adds a
  machine in Admin; nobody edits YAML. (*The tech team configures, never
  codes.*)
- **Grafana dashboards, provisioned** in booth terms ("ProPresenter Mac",
  "Stream PC"). Grafana is optional within the profile: a church already
  running Grafana points it at this Prometheus instead.
- **A threshold evaluator** that turns series into conditions (section 3).
- **Later, deep Dante monitoring,** if it is ever built.

### 3 · Prometheus never pages anyone

Prometheus brings Alertmanager, a second engine for deciding what is an alert.
**It is not shipped and not configured.** Two alerting systems would split the
one judgement ProdMesh exists to make: an alert matters because a show is live
in the room it affects (0015, 0019). Alertmanager cannot know that.

Instead the sidecar is **a sensor, not a brain** (0020). It evaluates
thresholds with hysteresis and serves the results as conditions over
`prodmesh-signals/1`:

```
event: signal
data: {"kind":"host.disk.low","device":{"id":"<exporter instance id>","name":"ProPresenter Mac"},
       "severity":"warning","summary":"Disk almost full: 2.1 GB free",
       "condition":{"id":"disk:/","active":true}}
```

ProdMesh pulls it like any 0020 source and applies 0020's one built-in rule:
active for 30 seconds opens an alert, red and to Slack only while a show is
live in the bound room. An exporter that stops answering is itself a condition
(`host.exporter.down`), so a booth machine that dies is reported by the sidecar
rather than by its own silence.

The thresholds are set in ProdMesh Admin and travel to the sidecar in the same
monitoring configuration as the targets. The sidecar holds no settings of its
own that an admin would need to find.

Being our own code, the sidecar does **not** count as one of the two
independent implementations 0020 asks for before the format leaves draft.

### 4 · What ProdMesh serves

- **`GET /api/monitoring/config`**: the targets (device id, display name,
  exporter address, bound room) and thresholds. Service token only (ADR
  0013's token, a new permission `monitoring.config`). It carries addresses
  and the names a church gave its machines, so it is never public.
- **`GET /metrics`**: ProdMesh's own health and its integrations' up/down and
  response times, in Prometheus text format. Designed in
  [#60](https://github.com/prodmesh/prodmesh/issues/60) and not restated here:
  off by default, `metrics.read` service token, counters updated in place so a
  scrape only formats numbers, bounded labels. The one addition this ADR makes
  is that the sidecar's Prometheus is the expected scraper, so #60 is the first
  half of this design, not a separate feature. Event loop delay
  (`perf_hooks.monitorEventLoopDelay`, the measure 0019's storm test uses) is
  the number to graph when ProdMesh itself is slow on a Sunday.

Neither is part of `/api/v1`'s promised surface yet.

### 5 · Graphs in the dashboard: a fixed menu, not PromQL

A graph widget asks the ProdMesh server, which asks the sidecar's Prometheus
for one range and returns the points. The browser never talks to Prometheus.

The widget chooses from **named series**: CPU, memory, disk, temperature, for a
bound machine. It cannot submit arbitrary PromQL. A query language reachable
from any screen in the building is an unauthenticated resource-exhaustion
vector, which is exactly the bar in our threat model (*guest wifi and a
teenager throwing requests at it*). The range and step are bounded on the
server, and each widget's queries go through the same per-room budget idea as
Companion variables.

Grafana remains the tool for anything off the menu. Alert details carry an
**Open graphs** link when the device has a Grafana URL set in Admin. A link,
not an embed: plain http on the LAN is the normal case, and
`src/lib/embed.ts` admits https only.

### 6 · What goes in 1.6, before the sidecar exists

Three small pieces that cost little alone and make the sidecar an add-on rather
than a rework:

1. `/metrics`, as #60 describes it (section 4). #60 is currently backlog
   "until a church asks"; this ADR proposes pulling it into 1.6.
2. A Grafana URL per device and the **Open graphs** link (section 5).
3. `/api/monitoring/config` (section 4), with thresholds held in settings.

Each is useful without the sidecar: the first two to a church already running
Prometheus and Grafana, the third to anyone writing their own scraper.

### 7 · The cloud uplink is not decided, but is constrained

The sidecar is where any path to a hosted service would go, and that is
deliberate: the core stays LAN-only, and *nothing leaves the building* stays
true unless a church installs the sidecar **and** turns the uplink on.
Prometheus `remote_write` is the obvious mechanism.

It needs its own ADR, which must meet federation's bar, not the LAN's:

- off by default, outbound only, the far end pinned by certificate;
- a published, field-by-field description of what is sent, and a screen that
  shows it, as #37 already requires of telemetry;
- **metrics only, never control.** Nothing outside the building can press a
  button in it. That follows from federation being *never a forwarder to
  another site's devices*, and it is a position worth holding as a difference,
  not just a limit.

## Consequences

- **ProdMesh's load still scales with rooms, not machines.** Adding the fifth
  booth computer adds a scrape target to the sidecar and nothing to the show's
  event loop.
- **Backups do not grow.** Prometheus data lives in the sidecar's volume and is
  disposable: losing it loses two weeks of graphs, never a fact.
- **A second release train.** Tags, an image, compatibility between versions.
  The sidecar names the monitoring configuration version it reads, and ProdMesh
  serves that version or says plainly that it does not. For a solo project this
  is the main cost, and the reason the sidecar waits until after 1.6.
- **Booth facts exporters do not see stay uncovered:** a display unplugged, the
  wrong resolution, an audio interface missing. Those need something on the
  machine that knows what a booth is (the desktop app in client mode is the
  candidate). Out of scope here.
- **The generic signal format gets its first real implementation,** from us.

## Not decided here

- **The name**, and **the licence**. If the sidecar might ever be sold, or
  might carry Dante code of uncertain origin, settle the licence before the
  first commit. The MIT core is unaffected either way.
- **Whether Grafana ships in the profile** or the sidecar only provisions an
  existing one.
- **macOS and Windows coverage.** `node_exporter` on macOS reports less than on
  Linux (temperature in particular). Measure on the church's own Macs before
  promising a temperature graph.
- **The desktop app.** Running Prometheus beside the Electron server is a later
  question; Compose first.
- **The cloud uplink** (section 7), beyond its constraints.
