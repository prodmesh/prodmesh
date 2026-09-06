Connecting Planning Center, Companion, ProPresenter, Smaart or ProdMesh Remote RTA, YouTube Live, and Slack — what each gives you and how to set it up.

# Integrations

prodmesh works with none of these configured — service data shows sample
plans, room modes are held in memory, and there's no loudness meter or
viewer count. Add each integration when you're ready for it; nothing else
depends on any one of them being set up.

Two places hold integration settings:

- **Admin → General → Integrations** — credentials shared across the whole
  install: Planning Center, Slack, YouTube's API key. Write-only: once saved,
  a field shows only whether it's set, never the value.
- **Admin → Campuses → *(a room)*** — per-room connection details: which
  Companion, ProPresenter, and analysis source *this* room talks to, and
  which YouTube channel it streams to. Every room configures these
  independently.

## Planning Center Services

**Gives you:** service plans, times, and order-of-service items on the
Services and Calendar pages, plus the search used to link a user to their
Planning Center person (see [User Management](User-Management.md)).

**Required?** Optional. Without it, service pages show sample plans instead
of real ones.

**Setup:**

1. In Planning Center, go to **planningcenteronline.com → Developer →
   Personal Access Tokens** and create one.
2. Under **Admin → General → Integrations → Planning Center**, enter the
   Application ID and Secret it gives you.
3. Under **Admin → Campuses → *(a room)* → Planning Center service types**,
   add the service type(s) this room hosts. The ID is in that service type's
   Planning Center Services URL. A room can host more than one.

Planning Center doesn't reliably know which physical room a service happens
in — that's exactly why room-to-service-type mapping is configured here
rather than read from Planning Center. See
[Integration Caveats](Integration-Caveats.md).

## Bitfocus Companion

**Gives you:** room mode control. prodmesh shows a room's mode as active by
reading a Companion state variable, and changes it by pressing a Companion
button.

**Required?** Optional. Without it, room mode is tracked in memory on the
server — every screen still agrees on the current mode, prodmesh just isn't
driving real hardware.

**Setup**, under **Admin → Campuses → *(a room)* → Companion & modes**:

- **Host** and **port** — where this room's Companion install listens.
- **State variable** — the Companion variable prodmesh reads to know which
  mode is currently active.
- Per mode: a **label**, a **color**, the variable **value** it matches, and
  the **page / row / column** of the Companion button that activates it.
  Optionally mark one mode **Standby**.

Every church lays out its Companion buttons differently, so page/row/column
is set per mode, per room — there's no shared default. Tick **Simulated** to
keep a room working with an in-memory mode while its Companion install isn't
ready yet.

## ProPresenter

**Gives you:** live Run of Show tracking against the actual presentation —
which item and slide is showing — plus driving the service countdown timer.

**Required?** Optional. Without a host set, a room simply has no ProPresenter
connection.

**Setup**, under **Admin → Campuses → *(a room)* → ProPresenter**:

- **Host** — the ProPresenter machine's address.
- **Port** — ProPresenter's own API port. This is per-machine and can change
  across restarts unless it's pinned in ProPresenter's own Network
  preferences — see [Integration Caveats](Integration-Caveats.md) before
  assuming a stored port is stale.
- **Countdown timer** — the name of the ProPresenter timer prodmesh should
  read for the pre-service countdown.

This uses ProPresenter's official API (7.9+), not a private or reverse
engineered protocol.

## Loudness (SPL): Smaart or ProdMesh Remote RTA

**Gives you:** a live SPL meter and a per-show loudness curve on the report,
measured against a target and a not-to-exceed limit you set per room.

**Required?** Optional, and the two sources are interchangeable — pick
whichever the room actually runs. Neither is more "correct"; they report the
same shape of data.

Configure under **Admin → Campuses → *(a room)* → Analysis source**:

| | Smaart | ProdMesh Remote RTA |
|---|---|---|
| What it is | Rational Acoustics Smaart (v9-era Suite/RT/LE/SPL; v8 also works) | The free companion app, [prodmesh-rta](https://github.com/prodmesh/prodmesh-rta) |
| Enable its API | Smaart: **Options → API** | The app: **Settings → API & Streaming** |
| Default port | 26000 | 8517 |
| Needs a password? | Optional, if Smaart requires authentication | No |

Both need **Host**, **Port**, a **Target dB**, a **Limit dB**, and a
**Metric** (which meter reading to record — e.g. Smaart's "SPL A Slow").
Smaart additionally has a checkbox to **start/stop SPL logging with shows**,
so a show starting turns Smaart's logging on and a show ending turns it back
off (only if the show turned it on) — this needs a calibrated input in
Smaart to have any effect. See
[Integration Caveats](Integration-Caveats.md) for the single biggest gotcha
here: a connected, metering Smaart still reports nothing until logging is
actually running.

## YouTube Live

**Gives you:** a recorded viewer-count curve for the show report — how many
people were watching, over the course of the service.

**Required?** Optional. Nothing else in prodmesh depends on it.

**Setup:**

1. In Google Cloud Console, create a project, enable the **YouTube Data API
   v3**, and create an API key. Restrict the key to that API.
2. Under **Admin → General → Integrations → YouTube**, enter the API key.
3. Under **Admin → Campuses → *(a room)* → YouTube Live**, enter the room's
   **Channel ID** (YouTube Studio → Settings → Channel → Advanced). Leave it
   blank if the room isn't streamed.

Normally nothing else needs pinning: prodmesh watches the channel for
whatever broadcast is live during a service and records that one. A specific
broadcast can be pinned instead from an event's page, for the rare case where
the automatic match needs overriding — see
[Integration Caveats](Integration-Caveats.md) for why viewer counts can't be
recovered after the fact.

## Slack

**Gives you:** assistance requests from a room posted to a Slack channel, so
the tech team can see and acknowledge them without watching every room
screen.

**Required?** Optional.

**Setup**, under **Admin → General → Integrations → Slack**:

1. Create a Slack app with a bot token (starts `xoxb-`), scoped to post
   messages and add reactions to them. Grant it permission to look up user
   profiles too if you want assistance requests to show a real display name
   — without that, prodmesh falls back to a generic label automatically.
2. Enter the **Bot token** and the **Channel** the app should post to.

prodmesh calls four Slack methods, so grant the scopes behind them:
`chat:write` to post the request, `reactions:read` and `reactions:write` so a
request can be marked as picked up, and `users:read` to show who responded.

The **Signing secret** and **App-level token** fields are for actions
*triggered from* Slack — not used by anything yet, and left optional so a
church that only wants notifications still reads as fully configured without
them.
