# ProdMesh API v1

The stable HTTP API for integrating other apps with ProdMesh: a Companion
button, a stream deck, a script, a monitoring system. Every endpoint below
keeps working, with the same meaning, for all of 1.5.x. The design is in
[ADR 0013](decisions/0013-public-api-is-an-allowlist.md).

Everything else the server answers, including every `/api/…` path not listed
here, is the web app's private surface. It can change in any release.

## Basics

- **Base URL:** `http://<prodmesh-host>:8080/api/v1`
- **Bodies** are JSON (`Content-Type: application/json`). A write that needs no
  fields can send no body.
- **Reads are open.** Anything a dashboard can show, anyone on the network can
  read, with one exception (`/history`). ProdMesh is a LAN appliance; see the
  security note in the README.
- **Writes need a service token.** Create one in **Admin → API tokens**. Tick
  only what the app needs. The token is shown once. Send it as a header:

  ```
  Authorization: Bearer pmt_…
  ```

- **Room ids** are in each room's Admin URL (`/admin/campuses/<room-id>`) and
  in `GET /rooms`.

### Errors

| Status | Body | Meaning |
|---|---|---|
| 400 | `{ error }` | The request is malformed |
| 401 | `{ error: 'invalid_token' }` | The token is unknown or revoked |
| 401 / 403 | `{ error: 'permission_required', permission, label }` | No token, or the token lacks this permission |
| 403 | `{ error: 'override_required', mode }` | A schedule lockout protects this mode. Send `overridePin`, or use a token with *Override protected modes* |
| 404 | `{ error: 'not_in_v1' }` | Not part of v1 |
| 405 | `{ error: 'method_not_allowed', allowed }` | Right path, wrong method |
| 409 | `{ error }` | The room's state refuses it: a show is already running, there is no show to end, or there is no current service to start |
| 429 | `{ error: 'temporarily_locked', retryAfter }` | Too many bad tokens or PINs from this address. `retryAfter` is in milliseconds |
| 502 | `{ ok: false, error }` | A device (usually Companion) did not respond |

## Endpoints

This table is checked against the server's allowlist by the test suite
(`server/apiV1.test.js`), so it lists exactly what v1 serves.

| Method | Path | Permission | What it does |
|---|---|---|---|
| GET | /api/v1/rooms | — | Every room: id, name, campus, and its modes |
| GET | /api/v1/rooms/:id | — | One room |
| GET | /api/v1/rooms/:id/state | — | The room's current mode, and whether a schedule lockout is active |
| GET | /api/v1/rooms/:id/show | — | The room's show: whether one is running, the live item, timer and SPL |
| GET | /api/v1/rooms/:id/service | — | The room's upcoming Planning Center plans |
| GET | /api/v1/services | — | Upcoming services across every room |
| GET | /api/v1/rooms/:id/plan/:planId | — | One plan: times, items, people |
| GET | /api/v1/rooms/:id/plan/:planId/report | — | A show's report: planned vs actual timing and loudness |
| GET | /api/v1/history | reports.view | Every recorded show |
| GET | /api/v1/calendar | — | Planning Center Calendar bookings (`?start=&end=` ISO dates) |
| GET | /api/v1/about | — | Product name and version |
| GET | /api/v1/system/version | — | Version, commit and how this install updates |
| GET | /api/v1/system/health | — | Each integration's reachability |
| GET | /api/v1/stream | — | Server-sent events for `?topics=…` — see [Topics](#topics) |
| POST | /api/v1/rooms/:id/mode | rooms.mode.change | Change the room mode: `{ mode, overridePin? }` |
| POST | /api/v1/rooms/:id/show/start | shows.operate | Start a show: `{ planId?, timeId?, rehearsal? }`. No `planId` starts the room's current service |
| POST | /api/v1/rooms/:id/show/end | shows.operate | End the running show |
| POST | /api/v1/rooms/:id/show/current | shows.operate | Jump to an item, or resume following ProPresenter: `{ itemId?, follow? }` |
| POST | /api/v1/rooms/:id/event/:planId/checklist/:itemId | checklists.complete | Tick or untick a checklist item: `{ done, overridePin? }` |

### Starting "the current service"

`POST /rooms/:id/show/start` with no `planId` starts the service the room is
in now, the same one autostart would choose:

- the plan whose service times fall within **two hours before** its first
  service and **one hour after** its last;
- of that plan's service times, the **nearest** one whose show has not
  already been completed.

With nothing in that window the answer is `409 no_current_service`, rather than
a guess. Send a `planId` to start something else.

## Topics

`GET /stream?topics=a,b,c` holds an [SSE](https://html.spec.whatwg.org/multipage/server-sent-events.html)
connection open. Every frame looks like this:

```
event: msg
data: {"topic":"room:north-main:show","data":{…}}
```

- On connecting, each topic sends its **current value** right away, so there
  is no need to read it separately first.
- After that, a frame arrives **when the value changes**, not on a timer.
- `: ping` comment lines are heartbeats; ignore them.
- Unknown topics are ignored, not fatal. At most 64 topics per connection.
- To change topics, reconnect with a new list.

Topics promised in v1:

| Topic | Carries |
|---|---|
| `room:<id>:show` | The same state as `GET /rooms/:id/show` |
| `room:<id>:mode` | The same state as `GET /rooms/:id/state` |
| `room:<id>:timer` | The show's countdown / ProPresenter timer |
| `room:<id>:spl` | Live loudness |
| `room:<id>:propresenter` | ProPresenter console state: the live item and slide |
| `room:<id>:health` | The room's integrations, reachable or not |
| `integration:<id>` | One integration's health |

Other topics exist and the dashboards use them, but they are not promised.

## Recipes

### A Companion button that ends the service

Use Companion's **Generic HTTP** connection.

- **Action:** POST
- **URL:** `http://<prodmesh-host>:8080/api/v1/rooms/<room-id>/show/end`
- **Header:** `Authorization: Bearer pmt_…`
  (Companion's header field takes JSON: `{"Authorization":"Bearer pmt_…"}`)
- **Body:** leave empty

Use a token with *Operate shows*.

### …and one that starts it

Same as above with `/show/start`. With no body, it starts the service that is
on now.

### From a terminal

```bash
curl -X POST -H "Authorization: Bearer pmt_…" \
  http://prodmesh.local:8080/api/v1/rooms/north-main/show/end
```

## Compatibility promise

- Every endpoint and topic above keeps working for **all of 1.5.x**.
- **Adding** a response field is not a breaking change. Ignore fields you do
  not recognise.
- **Removing or renaming** a field, or changing what an endpoint does, is a
  breaking change. That only happens under a new prefix (`/api/v2`), and the
  old one stays alongside it for a number of **releases**, not weeks. A church
  updates when it updates.
- The unversioned `/api/…` paths for these same endpoints work too, but
  `/api/v1` is the one that is promised.
