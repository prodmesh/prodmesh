# Integration notes

Device and API behaviour that cost real on-site time to discover. None of it is
in any vendor's documentation, and most of it contradicts the obvious reading.
Read the relevant section before changing an integration.

Everything here was verified against real gear on the dates given. Where a fact
is version-specific, the version is stated — assume nothing carries forward.

---

## ProPresenter

**The API port is per-machine and ephemeral.** ProPresenter picks one and can
change it across restarts unless pinned in Network preferences. Observed values
include 1025 and 62201 on different machines; `62202` is only this module's
fallback default. `49310` is the legacy WebSocket and will not speak HTTP.
Never hard-code a port — it is per-room configuration.

**Every minor version behaves differently.** After any ProPresenter upgrade,
re-run the probe battery: `active`, `focused`, playlists, uuid-vs-path
addressing, `slide_index`.

### Version differences (verified live)

| Behaviour | 21.1 | 21.4 |
|---|---|---|
| `/v1/playlist/active` | answers all-null even mid-show | works |
| `/v1/playlist/{uuid}` | 404s — address by index path (`/v1/playlist/1/0`) | uuid addressing works |
| `active`'s `playlist_item` | carries `presentation_info` | lost `presentation_info` (arrangement) |
| `slide_index` payload | no `total_cues` | gained `total_cues` / `remaining_cues` |

21.1's breakage of `active` and uuid addressing appears to have been a bug —
21.4 restored both. `/v1/playlist/focused` returns a full `playlist_item`
(including `is_pco`) on both. Playlist items carry
`presentation_info.presentation_uuid`; `proPresenter.js` resolves the live item
by presentation uuid rather than index, because index addressing is exactly what
broke on 21.1.

### Chunked streaming

`?chunked=true` on `/v1/presentation/slide_index` **pushes** sub-second,
carrying `presentation_id.uuid/name` and (on 21.4) `total_cues` /
`remaining_cues`. Verified live on **both 21.1 and 21.4**.
`/v1/playlist/active?chunked=true` also pushes item changes on 21.4.

**It does not push every slide.** ProPresenter *coalesces* rapid advances: a
slide that is passed through quickly is never pushed at all. Measured
2026-08-04 against the raw endpoint with no dashboard in the path — four
`GET /v1/trigger/next` calls 200 ms apart moved PP from index 40 to 44, and
the stream pushed **40, 42, 43, 44**. Single-stepping is contiguous (37→38,
39→40), so 41 was a real index that was simply never announced. An earlier run
skipped 36 the same way. This is not a framing or parsing bug on our side —
prodmesh's own SSE reproduced PP's output exactly, index for index.

The consequence: **a coalesced slide can only be found by the watchdog poll**,
so how stale the slide bar gets is the watchdog interval, currently 5s while
the stream is trusted. This is what "the progress bar missed a slide, then
caught up" is. Nothing can do better at the source — a slide that existed for
200 ms and was never pushed cannot be observed by any polling rate a booth
machine should be running.

Note the safety net is narrower than it looks: `pollRunState` untrusts the
stream when the watchdog sees a slide the stream never pushed, but if the
operator has already moved on by the time the watchdog fires, the poll and the
stream agree on the *newer* index and no divergence is detected. So coalescing
does not reliably demote the stream — nor should it, since the stream is still
working correctly.

`pollRunState` auto-detects streaming, relaxes to a 5s watchdog while it trusts
the stream, and reverts to full-rate polling on disconnect, three failed
reconnects, or a watchdog-observed slide the stream never pushed. Only a
*subsequent* push counts as detection — every build sends an opening snapshot.

This is deliberately **not** a user setting. An operator cannot know whether
their build pushes, and a wrong choice loses tracking silently mid-service.

### Media transport (video position) — probed live 2026-08-10, PP 21.4

Two endpoints, and neither shape is what you would guess.

| | |
|---|---|
| `GET /v1/transport/{layer}/current` | a JSON **object** |
| `GET /v1/transport/{layer}/time` | a **bare JSON number** — `73.78204166666666`, not `{"time": …}` |

`layer` is `presentation`, `announcement` or `audio`. Despite the name, the
**`presentation` layer is the media transport** — a video cued from the order
of service plays there, not on some separate media layer.

Three states, observed:

```jsonc
// playing (a 1m57s .mov)
{"is_playing":true,  "uuid":"FA0CF82E-…","name":"260712 splits_2.mov","artist":"","audio_only":false,"duration":116.86675262451172}
// STOPPED — everything except is_playing is unchanged; time freezes near duration
{"is_playing":false, "uuid":"FA0CF82E-…","name":"260712 splits_2.mov","artist":"","audio_only":false,"duration":116.86675262451172}
// a layer nothing has ever played on
{"is_playing":false, "uuid":"",          "name":"",                  "artist":"","audio_only":true, "duration":0}
```

And a fourth, on reaching the end naturally: `is_playing: false` with
**`time` back at `0`** — not frozen near `duration` the way a manual stop
leaves it. So the position after playback is not a reliable indicator of
anything, including whether the clip finished.

**The trap: a stopped video is indistinguishable from a loaded one.** PP keeps
the uuid, the name and the duration after playback stops, freezes `time` at
wherever it landed, and `/v1/status/layers` still reports `media: true`. So the
obvious "is a video up?" test — a non-empty `uuid`, or a `duration > 0`, or the
media layer flag — stays true forever and pins a dead counter on the wall.
`is_playing` is the **only** field that means "moving right now", which is why
`videoWatcher.js` publishes nothing at all unless it is true.

That also means **paused and stopped and ended look identical** from this
payload: `is_playing: false` with a frozen time. Showing "paused at 1:23" would
require guessing which one it is, and guessing wrong leaves a stale number
under somebody's Now/Next. If that becomes worth having, the thing to observe
is whether advancing past the media cue clears the transport or leaves it —
that was not tested.

Other findings:

- `duration` and `time` are seconds as floats. Time advanced 2.002 s over a 2 s
  wall-clock gap, so it is a real playback clock, not a cue counter.
- **`?chunked=true` works on `/v1/transport/{layer}/time`**, pushing about once
  a second. Not used: a position one second stale is still a correct position,
  and polling only while somebody is watching is cheaper than holding a socket
  open per room.
- `audio_only: true` in the empty sample is the **audio layer's** nature, not an
  idle marker. Do not read it as one.
- `/v1/status/slide` reports the **media's** uuid in `current.uuid` with empty
  `text` while a video is up, so it cannot distinguish a video from a slide.

### The presentation body — probed live 2026-08-13, PP 21.4

`GET /v1/presentation/active` returns the WHOLE song in one response, which is
what makes a lyric view cheap: one request per song rather than per slide.

```
presentation.groups[] → name    "Verse 1" | "Chorus 1" | "Bridge 1" | "Tag 1"
                        color   {red, green, blue, alpha} as 0..1 FLOATS
                        slides[] → text   the lyric, with \n where the operator broke it
                                   notes  the operator's cue: "push in", "piano"
presentation.arrangements[] → id.name, groups[] (group uuids, WITH REPEATS), total_cues
```

**`groups` is the song's material, not its running order.** A section appears
there exactly once however many times it is played; the arrangement is the flat
list of group uuids with repeats. On the probed song `groups` summed to 14 cues
and the arrangement actually being run was 27. Anything that indexes by slide
position must expand the arrangement first, or from the first repeat onward it
is addressing the wrong half of the song. `arrangeSlides()` in
`integrations/proPresenter.js` is the one place that does this; `slideTotal()`
is its length, deliberately, so the Now & Next slide bar and the lyric scroll
cannot disagree about how long a song is.

Three traps, all of them measured rather than reasoned about:

- **`presentation.total_cues` is the RAW group sum**, not the arranged one — 14
  where the arrangement is 27. Each `arrangements[].total_cues` is that
  arrangement's real length, and matches what `slide_index` reports.
- **`current_arrangement` came back as an empty string** while a song was
  live. So on 21.4 the only signal for which arrangement is playing is the cue
  count: match `slide_index`'s `total_cues` against each arrangement's length.
  21.1 still carries the arrangement on the playlist item
  (`presentation_info`), which is better and is preferred when present.
- **Utility groups arrive as pure black.** "Blank" and "Clear Background" both
  came back `rgba(0, 0, 0, 1)` — ProPresenter's unset colour, not a choice. Pass
  it through and you paint a black dot and a black highlight bar onto a dark
  dashboard, which renders as nothing while looking like a bug. `hexColor()`
  reports pure black and pure white as `null`.

Empty `text` is common and meaningful: an Intro, a "Blank", a held chord. It is
a beat in the song, not a slide to skip — dropping those cues makes a lyric
scroll look like ProPresenter has hung at exactly the moment the band is
playing.

### Quirks that have bitten us live

- **Re-triggering an item** makes `slide_index` briefly report the item's
  *stored* slide position — where it was left last time — before the slide
  actually triggered. Any logic reading slide position at item-trigger time must
  debounce or edge-trigger.
- `playlist_item` reads **null right after an item trigger** until the next
  slide action. Keep the last mapped item as a baseline.
- **Zero-slide "shell" presentations** (a placeholder like "Message") cannot be
  activated at all.
- **Slide thumbnails are zero-based**, the same `index` as `slide_index` and
  the trigger routes: `GET /v1/presentation/{uuid}/thumbnail/{index}`. A `+1`
  shipped on 2026-08-13 on the belief that the endpoint was one-based, and
  every slide in the production console drew the NEXT slide's image (#42: an
  intro slide showing verse 1's text, an image-only presentation losing its
  first image). The giveaway was a retry that only ever fired for the last
  slide. Probed live on 21.4 (2026-09-10): a 14-slide song answers thumbnails
  0–13 and 404s at 14, and thumbnail 0 is its blank intro while 1 is verse 1.
  Agrees with the 7.9 OpenAPI spec and two independent clients that draw the
  live slide. Not yet probed on 21.1.

Trigger endpoints: `GET /v1/playlist/focused/{index}/trigger`,
`GET /v1/trigger/next`, `GET /v1/presentation/active/{i}/trigger`.

### Production-console assumptions — not yet live-verified

The production-console branch uses the existing focused playlist route for
browser data and does not let a focused selection alter the active-item mapping.
It reads presentation details through `/v1/presentation/{uuid}` and requests a
rendered cue from `/v1/presentation/{uuid}/{index}/thumbnail`; both are guarded
as optional because those paths have not yet been probed on the building's PP
21.1/21.4 installs. It always activates the playlist item before triggering a
cue — particularly important for Planning Center-linked items, whose exposed
presentation UUID can be valid for reads yet be rejected for direct activation.
Probe and update this section before marking any production-console control or
thumbnail feature verified.

---

## Captions (ProdMesh Caption / ProdCom)

Two apps transcribe production comms so the band can READ what the music
director says. prodmesh reads both through `integrations/captions.js` and
never writes to either — ProdCom's API can create channels and clear
transcripts, and the caption app's own docs give the reason not to:
"a caption encoder must not be able to disrupt a service."

### ProdMesh Caption — measured live 2026-08-11

`ws://host:8518/api/stream`, and the API doc is accurate except for one thing
that matters a great deal:

**Sending an `events` filter silences `tick` — permanently, and there is no way
to ask for it back.** Measured against a running instance:

| subscribe | ticks in ~12 s |
|---|---|
| none at all (defaults) | 2–4, every 5 s |
| `{channels:'all'}` | 2, every 5 s |
| `{channels:[0]}` | 3 — a CHANNEL filter is fine |
| `{channels:'all', events:['partial','final']}` | **0** |
| `{channels:'all', events:['partial','final','tick']}` | **0** |

The doc says heartbeat messages "reach every subscriber regardless of channel
filter", which is true and easy to misread as covering the events filter too.
It does not. And `tick` is, in that doc's own words, half the health check —
without it a crashed app is indistinguishable from a quiet room, which is
exactly the failure the check exists to catch. So `prodmeshCaption.js` sends a
subscribe with **no `events` key**. The default set is already
`partial`+`final`+`state`, which is what we wanted anyway.

Also observed and not in the doc: a `subscribed` frame acknowledges the
subscribe. Harmless — the parser ignores anything it does not recognise — but
it means the documented type list is not exhaustive.

Rates, from a real capture: ~75 partials and 3 finals in 14 s of continuous
speech on one channel, folding to 4 utterances. Partials are the majority of
traffic by an order of magnitude, so anything that republishes per partial
wants the hub's conflation doing real work.

### ProdCom — FROM THE SPEC, NOT VERIFIED

`ws://host:24480/api/v1/ws`. Nothing below has been seen on a live instance.

Specified: the path; `{"type":"subscribe","events":["transcript"]}`; a
`welcome` frame on connect; **`heartbeat` frames that must be echoed back or
the connection is dropped**; PSK auth via `Authorization: Bearer <key>` or
`?key=`; and the `TranscriptEntry` schema (`id`, `channelId`, `channelName`,
`text`, `source`, `inProgress`, `hasBeenSeen`, `date`, `completeDate`,
`translatedText`).

**Not specified: the envelope around a transcript event.** The prose says only
"Each event is a JSON object representing a new, updated, or completed
transcript entry" — it never shows one. Guessing the wrapper wrong would give a
transcript that is silently always empty, with no error anywhere, so
`prodcom.js` identifies an entry by SHAPE (`text` + `channelId` +
`inProgress`) and accepts it bare or under `data` / `entry` / `transcript` /
`payload`. Replace that with the real shape once someone has run it.

Note ProdCom has no separate partial/final message — `inProgress` distinguishes
them on one entry whose `id` persists across the transition, which is what lets
a settled line replace its live one in place.

---

## YouTube Live

### The constraint everything else follows from

`concurrentViewers` exists **only while a broadcast is live**. It is gone the
moment the stream ends, and YouTube will not serve it retroactively without
OAuth-gated Analytics. So a Show Report's viewer curve can only ever be *our
own recording* — `stream_samples` is the primary record, not a cache of
something recoverable. A service that ran before this was configured has no
curve and never will.

It is also **absent while live** if the broadcaster hid the counter. That is a
real configuration, not an error: it reads as `null`, never `0`. A zero would
be a fabricated attendance figure in a report someone may show their elders.

### Quota

Default 10,000 units/day, and the two calls differ by 100x:

| Call | Cost | Use |
|---|---|---|
| `videos.list?part=liveStreamingDetails` | **1** | the viewer count |
| `search.list?eventType=live` | **100** | finding today's video id |

`search.list` also carries a **second, separate limit: a soft cap of ~100
queries a day**, which no amount of unit budget buys out and which is the one a
church actually hits. Raising it means a Google quota request that has to be
justified — not practical for a LAN appliance.

The live video is resolved rarely (15-min TTL) and viewers are polled every
30s, so a 90-minute service is ~180 units plus a handful of searches.

**Idle backoff (issue #10).** That TTL only ever applied to a video id we
already had. With nothing live there is no id, the TTL was skipped, and every
idle cycle spent a fresh search at the flat 2-minute retry: **720 searches a
day per room** from a dashboard left open — the whole unit allowance in 3.3
hours, and the search cap in the same 3.3 hours. Nothing live is the ordinary
state; most of a week is Tuesday. So consecutive idle cycles now climb a ladder
— 2, 5, 15, 30, 60 minutes — which anything live resets to the bottom, and
which a room with a running show never climbs at all (a broadcast starting late
must be picked up in minutes, and those are the minutes the Show Report exists
to record). Measured: 720 searches a day becomes 28.

**The broadcast starts before the service, so the ladder alone gets Sunday
wrong.** Churches go live on a timer — the maintainer's SOP has Companion
starting each stream 10 minutes ahead, so the 8:00 service streams from 7:50
and the 9:30 from 9:20. A show does not start until ProPresenter moves at 8:00,
so nothing resets the ladder in that gap, and a dashboard open since Tuesday
would sit on the 60-minute rung and not notice the broadcast until as late as
8:50 — most of the way through the service it was meant to record. So the gap
is capped at **5 minutes when a service is due** (30 minutes before the
earliest service time to 1 hour after the latest, from Planning Center plan
times, behind its 10-minute cache and consulted only when the wait would
otherwise have been long).

Both bounds are measured from a service **start**, which is what makes an hour
enough on the tail: the question is not how long a service runs but how late
after the last scheduled start a broadcast could still begin. While a service
is actually running the window is irrelevant — a running show pins the gap
tighter than the window ever would. On an 8:00 + 9:30 plan the window is
7:30 → 10:30. Five and not two: the cap is paid across the whole
window, and at two minutes a Sunday morning alone would spend most of the daily
search allowance. A room with no service types, or an unreachable Planning
Center, climbs the ladder as normal.

Ends do not need the same treatment: the 8:00 broadcast ending resets the
ladder to its bottom rung, so the 9:20 start is picked up within a couple of
minutes on the existing behaviour.

This is comfortable for one streaming room and **not** unlimited: at ~28 a day
idle, about three rooms with channels and permanently-open dashboards would
reach the 100-query cap again. The durable fix is to stop resolving with
`search.list` at all — see below.

Quota exhaustion returns **403 with `reason: quotaExceeded`** — worth naming
explicitly, because a bare 403 sends someone hunting for a permissions problem
that isn't there. The watcher backs off 30 minutes on it; retrying cannot help
until the daily UTC reset.

### Resolving the live video without `search.list` — unverified

The obvious replacement costs 3 units instead of 100 and never touches the
search cap: `channels.list` → the channel's uploads playlist id (stable, cache
it), `playlistItems.list` → recent video ids, `videos.list?part=liveStreamingDetails`
→ which of them is live.

**It has not been shown to work here, and there is evidence against it.**
Probed against a real church channel (2026-08-25, nothing live at the
time): the uploads playlist returned 10 recent videos and **not one of them had
`liveStreamingDetails` at all** — no `actualStartTime`, including on that
week's service videos. On this channel the uploads playlist appears to hold
uploaded VODs rather than stream archives, which would mean a live broadcast
never shows up there for us to find.

What that probe could NOT settle is the case that matters: whether a currently-
live broadcast appears in uploads while it is live. Both methods agreed on
"nothing live", which is agreement about nothing. **Before building on this,
run the probe during an actual service** and compare its answer with
`search.list`. If uploads stays empty of the live broadcast, the remaining
options are pinning the video per service (already supported, zero searches),
or OAuth + `liveBroadcasts.list`, which needs the verification review this
integration deliberately avoided.

### Which broadcast belongs to which service

The room owns the **channel**; a **service time** owns the video. A church's
channel pre-creates one broadcast per service, so an 8:00 and a 9:30 on the
same Sunday plan are *different videos in the same room* — a room-level video
pin would attribute both to one broadcast and report identical numbers twice.
(That was the first shape of this and it was wrong; caught in field feedback
before it shipped.)

Normally **nothing needs pinning**. The watcher searches the channel for
whatever is live, and since the 8:00 broadcast is what's live at 8:00, each
service already records the right one.

`show_config.videos` is therefore **tri-state per service time**, and the first
two are not the same thing:

| Stored | Meaning |
|---|---|
| key absent | auto — record whatever is live |
| `null` | **not streamed** — record nothing, don't even look |
| `'<videoId>'` | pinned to that broadcast |

"Not streamed" matters because a plan often has five service times of which two
are broadcast. On auto, the other three would happily record a stream left
running from an earlier service and attribute those viewers to a service nobody
watched online. It also means the watcher never starts for that service, so no
quota is spent looking for a broadcast that was never going to exist.

The picker there lists live + scheduled broadcasts, and **shows the scheduled
time, not just the title**: pre-created broadcasts are all called "Sunday
Service" and the clock is the only thing that tells them apart. It costs
100 + 100 (two `search.list`) + **1** (`videos.list` batches up to 50 ids), so
it is loaded only when that section is expanded, never on page view.

### Gotchas

- `concurrentViewers` is a **string** in the JSON, not a number.
- `actualEndTime` present = the broadcast is over, whatever else the payload
  says. Don't infer "live" from `actualStartTime` alone.
- An API key reads public data only. Unlisted/private broadcasts and historic
  analytics need OAuth plus a Google verification review for the
  `youtube.readonly` scope — deliberately not done.
- **No automatic mock.** Every other integration falls back to sample data
  without credentials; this one does not, because these numbers are persisted
  and shown as attendance. `youtube: { mock: true }` is a dev fixture only
  `rooms.config.js` declares, exactly like `analysis.mock`.

---

## Planning Center

**Services v2 `/people` silently ignores every query filter.** Verified live
against a 139-person roster: `where[search_name_or_email]`, `where[search_name]`,
`where[full_name]`, `where[first_name]`, `where[last_name]`, `?q=` and `?search=`
each returned the full unfiltered `total_count` — HTTP 200, no error, no
warning.

This is worse than an outright failure. Code that asks Services to search people
*appears* to work, because the first page is full of real names, while silently
missing everyone past it. The fix is to hold the roster locally and match
against it. There is no correct filter parameter to find.

Roster shape (same verification): 110 active / 29 archived of 139; every person
had `photo_thumbnail_url`; attributes include `status` and `archived_at`. Two
pages at `per_page=100` took about 1.1s.

**Calendar is different** — its `where[…]` comparison params and pagination
links were verified live and do work. Do not generalize from one Planning
Center product to another.

Other Services facts:
- Service times are **per-plan**, not via `include` (the included array is
  ambiguous across plans).
- Song key is `item.key_name`.
- Item "Leader" is not a field — it is an *item note* in the "Leader" category.
  Fetch items with `include=item_notes`.
- A room can host multiple service types; map rooms to an array and merge.

### Services LIVE — probed against a real account 2026-09-10

`/service_types/:st/plans/:plan/live` answers a `Live` resource whose actions
are exactly `go_to_next_item`, `go_to_previous_item` and `toggle_control`, plus
read links. **There is no way to end a Services LIVE session.** "Stop" can only
mean releasing control.

**`toggle_control` is a toggle.** From a token that does not hold control it
TAKES control; from one that does, it releases. So releasing blindly is a bug
waiting for the Sunday a volunteer takes Services LIVE over by hand — the
release would snatch it straight back. Check first: the `controller`
relationship is a `Person`, and `GET /services/v2/me` answers the token's own
`Person`, so "we hold it" is `controller.id === me.id`.

`syncServicesLive` POSTs to `/live` when a GET comes back empty. The next
Sunday plan probed already answered a `Live` resource, with no controller.

ProdMesh drives Services LIVE only while a show is running. The first mapped
item takes control, each forward item advances it (never backward — an
accidental ProPresenter click must not rewind it mid-service), and `endShow`
releases it — after any in-flight sync settles, because a sync that reads
"nobody controls this" just after the release would take control right back.

---

## Bitfocus Companion

The HTTP API is `http://host:8000`. Three paths matter, all probed against a
real Companion on 2026-09-01:

| Path | Answer |
|---|---|
| `GET /api/custom-variable/<name>/value` | the value as `text/html`, no JSON |
| `GET /api/variable/<label>/<name>/value` | the same, for `$(label:name)` |
| `GET /api/location/<page>/<row>/<column>/press` (POST) | presses a button |

**`/api/variable/` serves custom variables too** — `custom` is a real label
there (`/api/variable/custom/roomState/value` answers), so one path could serve
both. `companion.js` still sends custom variables to their own endpoint,
because that is the path the room-mode read has always used and therefore the
one proven against every Companion in the buildings; the unified path is
verified on one machine only.

**A missing variable is a 404 with the body `Not found`.** Which means the
machine answered, so it is NOT evidence that Companion is down — the variable
widget shows those as two different states, and `readVariable` reports health
green on any HTTP status.

**There is no bulk read.** `/api/variables` is a 404: n variables is n
requests, which is why `companionVariables.js` polls one loop per room rather
than one per variable, and caps how many a room may watch.

`GET /api/connections` lists the connection labels (`[{id, label, moduleId,
enabled, status}]`) — not used yet, but it is what a variable picker would
be built on instead of asking an operator to type a label.

Every response carries `Access-Control-Allow-Origin: *` and no auth of any
kind. Anything that can reach the port can press any button, which is the
reason these reads happen server-side and the reason a Companion belongs on a
production VLAN.

### Emulator surfaces — probed live on Companion 4, 2026-09-08

The HTTP API cannot list surfaces. Companion's own UI gets them from a **tRPC
WebSocket at `ws://host:8000/trpc`**, and `surfaces.emulatorList` is the path:

```json
→ {"id":1,"method":"subscription","params":{"path":"surfaces.emulatorList","input":{"json":null}}}
← {"id":1,"result":{"type":"started"}}
← {"id":1,"result":{"type":"data","data":[{"id":"LeqG7hIEDm1rJffJW6hhU","name":"Booth emulator"}]}}
```

**The list is in the SECOND frame.** A client that reads one reply and closes
gets nothing. It is a subscription, so it then streams changes forever —
`companionEmulators.js` takes the first array and hangs up.

**The payload is a bare array**, not the `{json: …}` superjson envelope tRPC
uses on other paths. Both are accepted, because the unwrapped shape is the one
observed and the wrapped one is what the protocol would normally imply.

**An id is a nanoid, not a name** (`LeqG7hIEDm1rJffJW6hhU`), so it must be
picked rather than typed. A fresh Companion answers `[]` — an empty picker
means "no emulator exists yet", not a failure.

`/emulator` and `/emulator/<id>` both serve the surface, and **any unknown id
also returns 200** (SPA fallback), so a deleted emulator shows a broken surface
rather than an error. The pages send no `X-Frame-Options` and no CSP
`frame-ancestors`, which is what makes embedding them possible at all.

Because Companion has no auth, an embedded surface presses buttons with none of
the permission, schedule-lockout or audit machinery a prodmesh mode change goes
through. That is why it is a per-room opt-in, off by default — see
`validateCompanion`.

---

## ProdMesh RTA — read from the analyzer's source 2026-09-07

WebSocket at `ws://host:PORT/api/stream`, plus `GET /api/rta` for one snapshot.
A `levels` frame carries 31 third-octave bands (20 Hz–20 kHz) in `bands_db`
with their centres in `centers_hz`.

**`cal_db` is the SPL at 0 dBFS, so it doubles as the top of the plot.** The
app adds `cal` to every band before publishing (`main.cpp`, `b += cal`), so
`bands_db` is already calibrated dB SPL — verified live: the 31 bands sum to
50.1 dB against a reported LAF of 50.3. The analyzer's own web UI plots
`cal_db - 80 … cal_db`, and the widget matches it.

**Switch on `mode` before interpreting anything.** The app's API header says so
outright. `acoustic` is dB SPL against the calibration offset; `program` is
broadcast loudness in LUFS/dBFS against digital full scale, and there the app
sets `cal` to **0** (`main.cpp`: `const double cal = program ? 0.0 : …`) and
leaves the bands negative. That is why the same `cal_db … cal_db - 80`
expression lands on a correct −80…0 dBFS window without a second branch — and
why the ceiling must be read with `??` and never `||`: 0 is a real ceiling.
Only the unit label needs the branch.

**`peaks_db` is `null` unless peak hold is switched on** in the app, so the
per-band peak overlay is usually absent rather than empty. Treat a non-array
as "no peak data", not as a malformed frame.

**Sampling is 20 Hz.** That is a live-display rate, not a recording rate — see
the `spl-samples-peak` migration for what persisting every frame would cost and
why a row carries a Leq and a peak separately.

---

## Smaart

API v4 is a WebSocket at `ws://host:26000/api/v4/`. Smaart v8 (8.5.2.2) accepts
connections on `/api/v4/` but never answers RPCs; the same dialect lives at
`/api/v3/`. The transport negotiates v4 → v3 and caches whichever answers
(`smaart.apiPath` pins it).

**Reachable is not the same as reporting.** A health check can show Smaart
connected and still yield "no matching calibrated input" — inputs must be
calibrated *and* SPL logging must be running. Metering alone produces nothing.
Shows can drive logging on and off via `analysis.logControl`.

---

## ProPresenter Network Link ("ProLink") — evaluated and rejected

Fully reverse-engineered against 21.4; a custom client reached
green/Connected and received live operations. Recording it here so nobody spends
that week again.

It is plain JSON over HTTP on the normal API port, plus protobuf multicast for
presence. Four pieces are required, each failing differently if missing:

1. `GET /group/status` → `{"group_definition": <group|null>, "member_name": str}`.
   `null` means unaffiliated — empty-string fields are not recognised.
2. **Announce on multicast always**, ~1/s to `224.0.0.90:18514`, even before
   joining. ProPresenter will not dial a device it has never heard announce; a
   silent peer produces a ~15s "Unable to connect" with zero HTTP requests made.
3. `POST /group/add_member` — the body wraps the group in **PascalCase**
   `GroupDefinition`, while the GET returns snake_case `group_definition`. The
   reply is a Rust enum: the bare JSON string `"Accept"`, or
   `{"Decline":"AlreadyInGroup"}`. Returning `{}` reads as a failed request.
4. `GET /heartbeat?port=N` (not `/group/heartbeat`), ~2/s. Omit it and you stay
   "Not Connected".

`224.0.0.90` is link-local (TTL 1), so presence requires the same L2 VLAN even
though HTTP itself routes across subnets.

**Do not use this for prodmesh.** Two disqualifying reasons:

- Members sit inside a **synchronous commit** — ProPresenter blocks on each
  member's `PrerollComplete` before firing. A slow or wedged member delays the
  operator's actual slide change. Nothing prodmesh does is worth that risk.
- Everything is addressed by **index path**, the exact fragility that broke
  tracking on 21.1.

The shipped answer is `slide_index?chunked=true` streaming: documented,
read-only, gives presentation UUID and cue counts, and cannot affect output.
