# 0020 — External signal sources: adapters first, one generic wire format

Status: proposed · 2026-11-16 · details [0019](0019-signals-rules-and-actions.md)
· settles [#51](https://github.com/prodmesh/prodmesh/issues/51) · builds on the
`signals` table from [#47](https://github.com/prodmesh/prodmesh/issues/47)

## Context

0019 put the signal spine in the core and kept one job for #51: the contract
for a source outside ProdMesh to feed signals in. Its settled points were:

- ProdMesh **pulls**, and subscribes rather than polls;
- the source is **a sensor, not a brain**: no rules, no Slack, no rooms;
- on reconnect ProdMesh asks "since N" and **knows when it missed something**;
- the source reports **device identity only**, and ProdMesh binds devices to
  rooms;
- a silent connection is itself a fault.

#51 named two real cases the contract must fit. Reading both changed the
shape of the answer.

**`prodmesh-rta`**, our own analyser, already pushes edge events on its
WebSocket next to the level stream:

```json
{ "type": "event", "event": "silence_start", "reason": "digital_black",
  "threshold_db": -60, "last_audio_ms": 1784957744422, "time_ms": 1784957760001 }
```

There is no sequence number and no way to ask what was missed. But every level
frame also carries the current `signal.state` (`ok`, `silent`, `black`). So a
client that reconnects learns the current state from the first frame, and
needs no replay to know whether the room is silent now. And ProdMesh already
holds this connection, in `server/integrations/rta.js`.

**NetAudio's daemon** ([chris-ritsen/network-audio-controller], Unlicense)
exposes Dante monitoring over HTTP, and its design is close to ours:

- `GET /events` is server-sent events: a coherent snapshot first, then ordered
  changes. No replay; a slow client is dropped and re-snapshots.
- `GET /event-journal` is the durable history: monotonic `sequence`,
  `timestamp`, `kind`, `severity`, `device_identity`, previous and current
  value. It pages by `before_sequence` and marks observation gaps explicitly.
- Its kinds include `clock_role_changed`, `leader_identity_changed`,
  `ptp_port_state_changed`, `device_disappeared` / `device_reappeared`,
  `subscription_failed` / `subscription_recovered`,
  `receiver_flow_latency_high` / `…_recovered`, and
  `interface_error_counter_increased`.

[chris-ritsen/network-audio-controller]: https://github.com/chris-ritsen/network-audio-controller

Neither speaks a protocol of ours, and neither should have to. Asking a
maintained third-party tool to implement a ProdMesh wire format is asking a
favour. Changing `prodmesh-rta` to add one buys nothing that the connection
ProdMesh already holds does not give.

## Decision

### Two layers: an adapter interface inside, one wire format outside

**The contract is first an interface inside ProdMesh**, which every external
source implements as a small adapter in `server/sources/`:

```js
export default {
  id: 'netaudio',              // the kind of source
  label: 'Dante (NetAudio)',
  isConfigured(cfg),
  // Runs until `signal` aborts. Calls the callbacks; never emits directly.
  async run(cfg, { cursor, onSignal, onGap, onState, signal }),
};
```

- `onSignal(s)` hands over one signal in the shape below. The adapter never
  calls `emit()`: the host stamps time, source, trust and room, applies the
  limits, then emits.
- `onGap({ reason, from?, to? })` records that signals may have been missed.
- `onState(snapshot)` reports current conditions after a (re)connect, so a gap
  never leaves an alert open for something that already cleared, or misses one
  that is active now.
- `cursor` is the last position the host saved for this source. The adapter
  returns new positions on each signal. It means whatever the source means by
  it: a sequence number, an epoch and sequence, or nothing.

Adapters are core code, reviewed like any integration. They are not plugins
loaded at runtime: a booth box runs what shipped.

**The generic wire format is one adapter among them**, `prodmesh-signals/1`,
for a church's own scripts, an existing monitoring system, or a future sidecar
of ours. Only a source with no adapter of its own needs it.

### The generic wire format

Server-sent events over HTTP, from a base URL the admin configures:

```
GET {base}/signals?after=<seq>        Accept: text/event-stream
```

SSE because it is one-way, plain HTTP, and has resumption built in: the `id:`
of each event is its sequence, and `Last-Event-ID` (or `after`) is "since N".
Any language can serve it in a page of code. WebSocket adds nothing for a
one-way feed.

The first event on every connection is `hello`:

```
event: hello
data: {"protocol":"prodmesh-signals/1","source":"booth-snmp","name":"Booth SNMP bridge",
       "epoch":"7f3a91c2","oldest":1180,"latest":1243}
```

- **`epoch`** changes whenever the source's numbering restarts, such as a
  restart without persistence. A different epoch from the one ProdMesh saved
  is a gap, from the beginning.
- **`oldest` and `latest`** describe the replay buffer. If ProdMesh asked
  `after=900` and `oldest` is 1180, signals 901–1179 are gone: a gap, with
  numbers. The source keeps a bounded buffer and never more; 1,000 is plenty.

Then the replay after the cursor, then live signals:

```
id: 1244
event: signal
data: {"kind":"dante.clock.leader_changed","device":{"id":"001dc1fffe0a1b2c","name":"Stage Rack A"},
       "severity":"warning","summary":"Clock leader is now Stage Rack A",
       "condition":null,"data":{"previous":"FOH Console"},"ts":"2026-11-15T17:12:04.211Z"}
```

| Field | |
|---|---|
| `kind` | Required. Lowercase dotted, at most 64 characters, in the source's own namespace (`dante.…`, `snmp.…`). |
| `device` | Optional `{ id, name }`. `id` is stable per device; the name is display only. ProdMesh binds by `id`. |
| `severity` | Optional: `info`, `warning`, `critical`. As in 0019, a change with no fault in it has none. |
| `summary` | Optional, at most 200 characters, shown as-is. |
| `condition` | Optional `{ id, active }`. See below. |
| `data` | Optional object, at most 4 KB serialised. Recorded, never interpreted. |
| `ts` | Optional, the source's clock. Kept in `data`; ordering uses ProdMesh's receive time (0015). |

Every 15 seconds without a signal, the source sends an SSE comment
(`: ping`). **Nothing for 45 seconds is a dead source**: ProdMesh drops the
connection, reports the source down through `health.js`, and reconnects with
backoff. That is the lesson `prodmesh-rta`'s README already teaches: a source
can't report its own death, so silence must be an alarm.

**The source never sets `trust`, `cause`, `roomId` or `source`.** Those are
ProdMesh's, from how the connection was made and how the admin bound the
device. A field the format does not define is dropped, and so is a signal
over the limits; neither error closes the connection.

### Conditions, so one rule fits every source

Most source faults come in pairs: silence starts and ends, a subscription fails
and recovers, latency goes high and comes back. `condition` names the pair:

```json
{ "kind": "dante.subscription.failed",    "condition": { "id": "sub:01:Lectern", "active": true } }
{ "kind": "dante.subscription.recovered", "condition": { "id": "sub:01:Lectern", "active": false } }
```

That lets **one built-in rule cover every external source**, in the same
shape as #47's integration rule:

- a condition active for 30 seconds opens an alert, deduplicated by source,
  device and condition id;
- inactive resolves it;
- it turns red, and goes to Slack, while a show is live in the bound room.

No per-source rule is needed for alerting. The `onState` snapshot after a
reconnect lists the conditions active now, and the host resolves any open
alert for a condition missing from it.

### Binding devices to rooms

The source says *which device*. Only ProdMesh knows *which room*.

- Every new `device.id` from a source is remembered and listed under Admin →
  Integrations → that source, marked **unbound**.
- An admin binds a device to one room, or to the whole campus (an amp rack
  feeding three rooms is org-scoped, like Planning Center).
- **An unbound device's signals are still recorded**, and its alerts appear in
  the sidebar's Notifications, never on a room page. A device nobody has
  placed is still worth hearing about once.

### Trust

Per 0019, trust comes from how the connection was made, never from what the
source claims:

- **`authenticated`**: https to a certificate whose fingerprint ProdMesh has
  pinned, as federation does (ADR 0017). Only then is the source proven to be
  the one configured.
- **`unauthenticated`**: everything else, including plain http on the LAN,
  which is normal. Such signals raise alerts, and per 0019 may not drive an
  action that changes a room unless a rule explicitly accepts them.

An optional bearer token, which ProdMesh sends, protects **the source** from
other readers. It proves nothing about the source to ProdMesh, because ProdMesh
is the one connecting, so it does not change trust.

### Limits, because the live show comes first

Applied by the host, before `emit()`, identical for every adapter:

- an SSE event over 8 KB is dropped unparsed;
- at most 20 signals a second per source, with bursts to 200; past that,
  signals are counted and dropped, and the count goes into one
  `source.dropped` signal when the storm passes (0019's `signals.dropped`,
  per source);
- `data` over 4 KB is replaced by `{ "truncated": true }`.

### Where the cursor lives

A new table, `signal_sources (id, adapter, epoch, cursor, updated_at)`, holds
each source's position. **The `signals` table does not change**:

| `signals` column | from |
|---|---|
| `source` | `external:<source id>` |
| `kind` | the source's kind, as sent |
| `subject` | `<source id>/<device id>` |
| `roomId`, `siteId` | the binding, or none |
| `severity`, `summary`, `data` | as sent, within limits; `data` also carries the source's `ts` and `condition` |
| `trust` | `authenticated` or `unauthenticated`, from the connection |
| `cause` | none: an external signal is never caused by one of our actions |

A gap is recorded as a `source.gap` signal, so the history says plainly
"signals 901 to 1179 from Booth SNMP were missed", rather than looking
complete when it is not.

### The two cases, mapped

**`prodmesh-rta` needs no protocol change.** `rta.js` becomes its adapter, or
emits directly as a core producer, which is simpler, since it is our code on a
connection we already hold:

- `{"type":"event","event":"silence_start","reason":…}` → `rta.silence.started`,
  `condition: { id: 'silence', active: true }`, severity `warning`;
- `silence_end` → `rta.silence.ended`, `active: false`;
- the `signal.state` on every level frame is the `onState` snapshot, which
  covers whatever happened while disconnected;
- the existing `analysis` health key already covers "the analyser stopped
  answering".

If `prodmesh-rta` ever wants to feed something other than ProdMesh, adding a
`prodmesh-signals/1` endpoint there is the route, and the work is a sequence
number, a 1,000-event buffer and `hello`.

**NetAudio is an adapter that reads its documented HTTP API:**

- subscribe to `GET /events?meters=0&telemetry=none` for live changes;
- on (re)connect, read `GET /event-journal` back from the newest entry to the
  saved sequence for what was missed, and record a gap if the journal no
  longer reaches that far;
- `device_identity` → `device.id`, `device_name` → `device.name`;
- kinds become `dante.<kind>` (`dante.subscription_failed`), and the pairs
  (`subscription_failed`/`_recovered`, `receiver_flow_latency_high`/
  `_recovered`, `device_disappeared`/`_reappeared`) carry a `condition`;
- `clock_role_changed` and `leader_identity_changed` are changes, not
  conditions: worth recording and, during a show, worth a warning.

This takes none of NetAudio's code. ProdMesh reads an HTTP API a church chose
to run, the way it reads Companion's. That is why it can live in the core:
0019's reason 2 is about code of uncertain origin in our tree, and there is
none.

### Not public API, yet

This is the reverse of `/api/v1` (ADR 0013): it is an API **other people
serve**, not one we serve. So it does not ride #45's surface. It is versioned
on its own, by the `protocol` string in `hello`, and the format above stays
**draft** until two independent sources implement it. Until
then it can change without a deprecation cycle, which is exactly why 0019 said
not to freeze a format in the release that invents it.

## Consequences

- **Dante monitoring becomes "run NetAudio, point ProdMesh at it".** That
  serves the church whose ProdMesh box is not on the Dante VLAN (0019's reason
  3) without a sidecar of our own: NetAudio runs on whatever machine is.
- **One alert rule covers every external source**, through `condition`. A new
  adapter usually needs no new rule.
- **Each adapter is code we maintain** against someone else's API, which can
  change under it. The adapters are small, and the alternative, a format each
  tool must adopt, mostly means nobody adopts it.
- **The generic format has no implementation on day one.** It is written down
  so a church's script or a future sidecar can target something stable-ish,
  and tested in ProdMesh against a fake source.
- **Unbound devices are visible, not lost.** An admin finds out what a source
  is reporting before deciding where it belongs.

## Not decided here

- **Whether NetAudio is the right Dante answer.** That needs a Sunday with real
  devices: run the daemon in the booth and see what its journal records for a
  pulled cable, a clock change and a failed subscription. Nothing above
  depends on the answer except the NetAudio adapter itself.
- **Audinate's view.** Using NetAudio is a church's choice about its own
  network, and ProdMesh does not bundle it. It stays opt-in, and the Admin text
  should say it is unofficial.
- **SNMP.** 0019 makes SNMP traps a core source in 1.6. Whether that is an
  adapter in this sense (a UDP listener with `onSignal`) or a producer like
  `health.js` is an implementation choice for then; this interface admits
  either.
- **Actions from external signals.** 0019's trust rule covers them. Which
  rules may accept `unauthenticated` input is a rules-UI question.
