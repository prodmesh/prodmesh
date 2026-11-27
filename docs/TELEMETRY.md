# What crash reporting sends

ProdMesh can send anonymous reports to its developers, so that a release that
breaks something is noticed before anyone has to report it. It is **off until
an admin turns it on** in Admin → General → Crash reporting, and that panel's
*What is sent* shows the exact report this server would send next.

This page lists every field a report may contain. Nothing else is sent: the
list is enforced by [`server/telemetry/schema.js`](../server/telemetry/schema.js),
which rejects any report with a field not described here, and a test fails if a
field is added there without being added here. The design and its reasons are
[ADR 0022](decisions/0022-cloud-and-telemetry.md).

> **Status:** reports are built and can be previewed. They are not sent yet.

## What is never sent

No name of the church, a campus, a room, a person or this server. No device
address, hostname, Planning Center id, credential or setting. No file path that
could hold a username. No IP address is kept by the receiving end either.

Where a value could identify a church, it is **bucketed**: counts are sent as
`0`, `1`, `2-5`, `6-20` or `21+`, never exactly.

## How error text is cleaned

Error messages are the one field we did not write, so each passes two filters
before it is kept, even in memory:

1. Anything **shaped** like an identifier is replaced: URLs (`<url>`), email
   addresses (`<email>`), IP addresses (`<ip>`), ids (`<uuid>`), absolute file
   paths (`<path>`), LAN hostnames such as `booth-mac.local` (`<host>`), long
   numbers (`<n>`), and the contents of anything in quotes (`'…'`). The
   exception is the property name in JavaScript's own messages, as in
   `Cannot read properties of undefined (reading 'items')`, which is our code's
   vocabulary.
2. Anything this server knows **is a name** is replaced with `<name>`: the
   church's, the server's, each campus's and room's (id and name), and each
   local user's username and display name.

Stack traces keep only the parts that are ProdMesh's own code, its open-source
dependencies, or Node.js, with paths relative to where ProdMesh is installed.
Anything else becomes `<external>`.

No filter is perfect. That is why *What is sent* exists: it is built by the
same code that will send the report.

## Fields

### Envelope

| Field | What it is |
|---|---|
| `schema` | Always `prodmesh-telemetry/1`. |
| `telemetryId` | A random id made for telemetry alone. Not the server's system id, which other servers and the local network can see. Not carried in backups, so a restored server gets a new one. |
| `sentAt` | When the report was built, in milliseconds since 1970. |
| `seq` | This install's report counter, to notice reports that never arrived. |
| `window` | The period the report covers: `window.from` and `window.to`. |

### `build`: which ProdMesh

| Field | What it is |
|---|---|
| `build.version` | The ProdMesh version, such as `1.6.0`. |
| `build.commit` | The source commit it was built from, when known. |
| `build.deployment` | How it was installed: `git`, `container`, `desktop` or `package`. |
| `build.node` | The Node.js version. |
| `build.electron` | The Electron version, for the desktop app; otherwise empty. |

### `host`: what it runs on

| Field | What it is |
|---|---|
| `host.platform` | `darwin` (macOS), `linux`, `win32` (Windows), or `other`. |
| `host.release` | The operating system's release number, such as `23.4.0`. |
| `host.arch` | The processor architecture, such as `arm64` or `x64`. |
| `host.cpuModel` | The processor model, such as `Apple M2`. |
| `host.cpuCount` | How many processor cores. |
| `host.memoryGb` | Installed memory, bucketed: `<4`, `4-8`, `8-16`, `16-32`, `32+` GB. |

Not the computer's name, time zone or language: each narrows down where it is.

### `resources`: ProdMesh's own load

About the ProdMesh process, not the computer's other software. Sampled once a
minute over the window.

| Field | What it is |
|---|---|
| `resources.rssMb` | Memory ProdMesh holds, in MB: `resources.rssMb.median` and `resources.rssMb.peak`. |
| `resources.heapMb` | JavaScript memory in use, in MB: `resources.heapMb.median` and `resources.heapMb.peak`. |
| `resources.eventLoopDelayMs` | How long work waited to run, in ms: `resources.eventLoopDelayMs.p50` (typical) and `resources.eventLoopDelayMs.p99` (worst 1%). The best single measure of "the server felt slow". |
| `resources.cpuPercent` | Processor use over the window, as a percentage of one core. |
| `resources.uptimeHours` | Hours since ProdMesh last started. |
| `resources.diskFreeGb` | Free space where ProdMesh keeps its data, bucketed: `<1`, `1-5`, `5-20`, `20-100`, `100+` GB. |
| `resources.databaseMb` | The database's size, bucketed: `<10`, `10-100`, `100-1000`, `1000+` MB. |
| `resources.streamClientsPeak` | The most screens connected at once, bucketed. |

### `shape`: how much of ProdMesh is in use

| Field | What it is |
|---|---|
| `shape.rooms` | Rooms, bucketed. |
| `shape.campuses` | Campuses, bucketed. |
| `shape.linkedServers` | Linked servers, bucketed. |
| `shape.users` | Local user accounts, bucketed. |
| `shape.integrations` | Which integrations are set up, by type (`proPresenter`, `companion`, `planningCenter`, …), from a fixed list. Never their addresses. |
| `shape.integrations.*.version` | The product version an integration reported, digits only, such as `21.1` for ProPresenter. A device can behave differently from one version to the next, so this is often what explains a bug. |

### `errors`: bugs

Unexpected errors in ProdMesh's own code: our mistakes, not a device being
unreachable. Outages are never sent; they are the church's business, shown in
Admin and alerts. Up to 50 kinds per report.

| Field | What it is |
|---|---|
| `errors[].where` | Which part of ProdMesh, such as `autostart` or `show`. One word, from our code. |
| `errors[].name` | The kind of error, such as `TypeError`. |
| `errors[].message` | The error's message, cleaned as described above. |
| `errors[].frames` | Where in the code it happened, cleaned as described above. Up to 20 lines. |
| `errors[].fingerprint` | A short code that is the same for the same bug on every server, so reports can be grouped. |
| `errors[].count` | How many times it happened in the window. |
| `errors[].firstSeen` | When it first happened in the window, to the minute. |
| `errors[].lastSeen` | When it last happened in the window, to the minute. |
| `errorsDropped` | How many more errors there were, past the first 50 kinds. |

### `lifecycle`: crashes

| Field | What it is |
|---|---|
| `lifecycle.boots` | Starts of ProdMesh in the window. |
| `lifecycle.uncleanExits` | Of those, how many followed a crash, power cut or forced quit rather than a normal shutdown. |
| `lifecycle.previous` | How the run before this one ended, if worth reporting. |
| `lifecycle.previous.endedCleanly` | `false` for a crash, power cut or forced quit; `true` when it hit an error but carried on and shut down normally. |
| `lifecycle.previous.version` | The version that was running. |
| `lifecycle.previous.uptimeMs` | How long it had been running, to within a minute. |
| `lifecycle.previous.error` | The error that ended it, if one was recorded. |
| `lifecycle.previous.error.origin` | `uncaughtException`, `unhandledRejection`, or `start` (it failed to start). |
| `lifecycle.previous.error.name` | As in `errors[].name`. |
| `lifecycle.previous.error.message` | As in `errors[].message`. |
| `lifecycle.previous.error.frames` | As in `errors[].frames`. |
| `lifecycle.previous.error.fingerprint` | As in `errors[].fingerprint`. |

## Turning it off for good

Set `PRODMESH_TELEMETRY=off` in the server's environment. Admin's switch then
shows as off and cannot be turned on. The environment can only turn reporting
off, never on.
