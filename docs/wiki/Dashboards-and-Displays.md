Custom grids of live widgets — one you arrange and use in the booth, one you point a screen at.

# Dashboards & displays

A room can have as many of these as you want, and they come in two kinds. Both
are grids of the same widgets; what differs is who is standing in front of
them.

**Dashboards** are for a person at a desk. Six columns wide, as many rows as
you fill, with a bar across the top where you pick which event and which
service time everything on the screen is talking about. Arrange one per role —
"Front of House", "Service Producer", "Camera Shading" — so each operator sees
their own things and nothing else.

**Displays** are for a screen with nobody at it. A fixed 3×3 that fills the
whole screen with no menus, no sidebar and nothing to click: a TV in the foyer,
a stage monitor, or a Raspberry Pi wired into a video switcher's multiview.

Find them at **Room Console → Dashboards**.

## Making one

**New dashboard** or **New display**, give it a name, and you land straight in
the editor. The name also decides its address — "Front of House" lives at
`/foh` — which is shown as you type, because that address is what you will
eventually point a screen at.

Adding widgets works two ways, and both do the same thing:

- **Drag** one from the Widgets list onto the grid. A green outline shows where
  it will land; red means something is already there.
- **Press +** next to it, and it drops into the first free space that fits.

To move a widget, drag it by its title strip at the top of the card — or click
that strip, press <kbd>Enter</kbd>, and use the arrow keys. The **×** removes
it.

A few widgets can be **stretched**, and those show a small grip in their
bottom-right corner. Drag it, or hold <kbd>Shift</kbd> with the arrow keys
while the card is grabbed. Run of Show goes from 3 rows to 5, and because its
order of service scrolls, the extra rows are more of the service rather than
more empty space. Integrations goes anywhere from a single cell to 3×3, in
either direction — more room is more of the room's devices on screen.

Most widgets are one fixed size on purpose. A loudness meter squeezed into a
single cell and one stretched across half a screen are two different designs,
not one design scaled, so offering a handle would only ever give you the worse
version of both.

Nothing is saved until you press **Save layout**. **Discard** puts back what
was there.

### Why a widget might be greyed out

- *Already on this view* — most widgets only make sense once per screen.
- *No room left* — nothing that size fits in what's free. Displays are a hard
  3×3, so this happens there long before it happens on a dashboard.

Widgets that let you do something — Run of Show, with its Prev/Next buttons —
can only go on a dashboard. A display is meant to be looked at, not operated.

## Which service a dashboard is showing

The bar across the top is the whole answer, and it applies to every widget at
once. Change the event there and the countdown, the order of service and the
loudness meter all follow.

The chain-link button next to the event is **Follow the room**. Lit, the
dashboard tracks whatever service the room is doing, and keeps doing so week
after week with nobody touching it — which is what you want for a screen you
set up once. Turn it off to pin the dashboard to one specific event; it stays
on whatever was already showing, so nothing jumps.

"Whatever the room is doing" means, in order: **the service that is live**, and
failing that, the one the clock is inside. So on a two-service morning a
following dashboard moves to the 11:00 by itself — the moment that show starts,
or once the 9:30's scheduled window has passed, whichever comes first. The
service time it landed on is shown next to the event, greyed out because you
are not choosing it. If a service runs long, the live show wins: it stays on
the 9:30 until the 9:30 actually ends.

**LIVE** appears on the right whenever a show is running in that room, with the
time since it started. It is the room's show, not this dashboard's — if the
9:30 goes live while you are looking at a rehearsal layout, you still find out.

## Putting a display on a screen

1. Build the display and save it.
2. Open prodmesh **on the screen itself** and register it as a station when
   asked (name it something you will recognise — "Foyer TV", "Multiview Pi").
3. From any other machine, go to **Admin → Stations**, find that station, set
   its **Room**, and pick your display from the **Display** dropdown.

From then on that browser shows the display full-screen. Point it at the site's
address and it finds its own way there, so a machine that reboots comes back to
the right screen on its own.

Edits reach it by themselves. Rearrange the display in the booth, press Save,
and the screen changes — no walking over, no reloading, no keyboard.

!!! tip "Make it readable from across the room"
    A layout that looks right on your laptop is often unreadable as one tile of
    a video wall. Use the **Scale** control in the display's editor: 200% is
    about right for a multiview tile, more for anything further away. It
    magnifies the whole layout, so the screen still shows exactly one 3×3 —
    just bigger.

If a display ever comes up **black**, that is deliberate: it means prodmesh
could not load that layout. There is no error message because nobody is
standing there to read one, and a message left on a wall for a week stops being
seen. Check that the view still exists and that the screen can reach the
server.

## The widgets

| Widget | Size | Shows |
|---|---|---|
| Clock | 2×1 | The time of day, with seconds, and today's date |
| Comms | 2×1 – 3×3 | Live transcript of the production comms channels, colour-coded by speaker |
| Countdown | 2×1 | Time until the service starts, following the room's ProPresenter timer when one is running |
| Integrations | 1×1 – 3×3 | A dot per integration this room has configured, and whether it answers |
| Live viewers | 1×1 | Concurrent YouTube viewers while the room is streaming |
| Loudness | 2×1 | Live SPL against the room's target and limit |
| Loudness trend | 2×1 | The shape of the last quarter hour, coloured against the room's target and limit |
| Now & Next | 3×1 | The current item and the one after it, with slide or video progress |
| Room mode | 2×1 | What mode the room is in, in its own colour. Read-only |
| Run of Show | 2×3 | The order of service, what is live now, and Prev/Next/End. **Dashboards only** |

A widget with nothing to say shows just its name in grey — the loudness meter
before SMAART is logging, viewers when the room is not streaming. That is not a
fault; it means there is genuinely nothing to report yet. See
[Integration caveats](Integration-Caveats.md) for why loudness in particular
often stays quiet.

Room mode is the exception: a room always has one, so that widget says
"Connecting…" while it waits rather than going quiet. It only ever *shows* the
mode — changing it stays on the room's own page, where the confirmation and the
schedule-override PIN live.

Now & Next shows a progress bar for whatever ProPresenter is doing: slides
through the current item, or — while a video is playing — that video's position.
It shows one or the other, never both. The video bar is blue and carries a play
glyph so a glance tells you which you are looking at, and it works with no
service running at all, which is what a lobby screen showing the pre-service
loop wants.

It disappears the instant playback stops. ProPresenter cannot tell a paused
video from a stopped or finished one, so rather than guess, prodmesh shows a
position only while the clip is genuinely moving. A frozen counter left on a
wall would be worse than no counter.

Loudness trend draws what **that screen** has watched since it was opened, and
a reload starts it over. Nothing keeps a live loudness history to ask for, so
the curve can only be what has been seen. The service's real, permanent record
is the Show Report.

Its curve turns amber above the room's target and red above its limit, with a
dashed line at each — the same two numbers the meter marks on its bar. The
vertical scale is fixed at 70–100 dB rather than fitted to the data, which
means a quiet service sits low in the box instead of filling it. That is on
purpose: a curve scaled to its own data makes a half-decibel wobble look like a
climb, and the one thing this widget must not do is manufacture a trend.

### Comms captions

What the music director and monitor engineer are saying, as text. The point is
the band: with in-ears in and a loud stage, reading it is the only way the
message arrives — so this is the one widget most likely to end up on a display
pointed at the drum riser.

Configure the source per room under **Admin → Campuses → a room → Comms
captions**. Two apps are supported, ProdMesh Caption and ProdCom; give it a
host, and a port only if it is not the standard one. Leave **Channels** blank
for every speaker, or list the ones this room cares about.

At two columns wide it is a bare transcript. At three it also shows a speaker
rail down the side, and a speaker's dot **glows in their own colour while they
are talking**. Taller is simply more of the conversation. Newest is at the
bottom; scroll up to reread.

A speaker is named once per run rather than on every line — one person talking
for a minute would otherwise print their name twenty times. The coloured bar
down the left keeps their identity through the run.

prodmesh only ever **reads**. It cannot rename a channel, clear a transcript or
stop capture, and that is deliberate: a dashboard must not be able to disrupt
the comms it is reporting on.

### Reading the Integrations dots

One row per integration the room has configured — an integration you have not
set up is absent rather than permanently grey. The colours are:

| | |
|---|---|
| **Green** | Answered the last check |
| **Red** | Did not answer |
| **Blue** | Simulated — a dev-fixture integration (analysis/YouTube), working exactly as configured |
| **Grey** | Configured but not contacted yet |

Rows are sorted worst-first, so at 1×1 — which fits about four — anything
broken is on screen and it is the healthy tail that is cut off. Stretch it if
the room has more than that: wider adds columns, taller adds rows, and both buy
the same thing. Which one to use is a question about the space left on your
dashboard.

It says *whether* something answers, never *why* it didn't. The error text, the
address and the version live on the room's configuration page and in
Admin → Logs, both of which need a login — a screen on a wall should not be
able to tell a stranger where every machine in the building is.

The room is checked once every thirty seconds however many screens are showing
this, so putting it on every display in the building costs what one costs.
YouTube is the exception: it is never actively checked, because every request
to YouTube spends metered quota. Its dot reflects the last real request, which
happens while the room is streaming — when the answer matters.

## Who can change them

Arranging dashboards and displays needs the **Edit dashboards & displays**
permission. Anyone can *look* at one — including a screen with nobody logged in
at all, which is what makes an unattended display work.

The widgets that take actions keep their own rules on top of that: a Run of
Show widget will only start or advance a show for someone with **Operate
shows**, and says so plainly to anyone else rather than doing nothing when
pressed. See [Users & access](User-Management.md).
