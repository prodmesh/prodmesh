# Alerts UX: proposal for #47

Status: proposal · 2026-11-14 · for [#47](https://github.com/prodmesh/prodmesh/issues/47)
· builds on ADRs [0015](../decisions/0015-events-and-alerts.md) and
[0019](../decisions/0019-signals-rules-and-actions.md)

The server half of #47 is built: signals, the built-in rule, alerts, Slack.
This is the half people see. It is written before any UI exists because the
difference between "oh, I see what this is for" and "how do I use this" is
decided here, not in the CSS.

## The problem this UX has to solve

Production people and church techs are not used to monitoring. Their mental
model of a fault today is: *somebody notices on Sunday morning, and asks
around.* We are offering something closer to how an on-call engineer works,
and the risks are on both sides:

- **Too loud, and it gets muted.** A red banner over Run of Show for a YouTube
  hiccup during the sermon teaches the team to ignore red. A muted monitor is
  worse than none, because everyone believes something is watching.
- **Too quiet, or too clever, and nobody trusts it.** If a volunteer cannot
  tell at a glance *what* is wrong, *since when*, and *whether anyone knows*,
  they will walk to the booth and ask, which is what they did before.

So the design rules are:

1. **Show it where the person already is.** No new page anyone has to
   remember to open during a service.
2. **Three questions, every time: what, since when, is someone on it.** Every
   surface answers all three, in that order.
3. **Calm by default; loud only when it can hurt a service.** The server
   already decides this (warning vs critical, ADR 0015's routing), and the UI
   must not undo it with colour.
4. **Never cover a control.** Nothing modal, no toasts over Run of Show, no
   sound.
5. **Make the watching visible.** People trust a monitor they can see working:
   what is watched, when it last checked, and that Slack is wired up.

## Words

Per [UI_TEXT.md](../UI_TEXT.md), terse, and in production language, not
operations jargon:

| Server | On screen | Why |
|---|---|---|
| alert | **Issue** | "Alert" reads as an alarm going off. "Issue" is what a tech would say on comms. |
| open | **Open** | |
| acknowledged | **On it**, with the name: "Sam is on it" | Says the useful thing: who. "Acknowledged" is a ticketing word. |
| resolved | **Cleared** | It cleared itself; nobody "resolved" anything. |
| warning / critical | amber / red, never named | Nobody needs the word "critical"; they need to see it is red because a show is live. |
| flapping | **Dropping in and out** | |
| signal | not shown | Internal. The 1.6 surface is "Automations". |

An issue's title is the room and the thing: **Main Auditorium · ProPresenter
unreachable**. Never a host, a port or an error string; those stay in Admin,
behind a permission (ADR 0019, and already true of the server's public view).

## Surfaces

### 1. The issue strip: Room Console and Run of Show

A single line under the page header, only while an open issue affects this
room. Not a banner across the app; a strip on the pages for that room.

```
 ● ProPresenter unreachable · since 9:12 · Sam is on it          [Details]
```

- **Amber** when no show is live, **red** when one is. Same strip, same place;
  only the colour changes, and it changes because the server escalated.
- **"On it" is a button** when nobody has claimed it:
  `● ProPresenter unreachable · since 9:12     [I'm on it]`. Pressing it needs
  `alerts.acknowledge`; at a station without a login that means the PIN
  prompt, as for a mode change.
- **Several issues collapse**: `● 2 issues · ProPresenter, Companion  [Details]`.
- **Details** opens a sheet (not a modal over controls; it slides from the
  side and the page stays usable) with: the title, since when, how often it
  has dropped, who is on it, what it affects in words ("Run of Show cannot
  follow ProPresenter"), and when it cleared, if it has.
- **On clear**, the strip turns to `✓ ProPresenter back · down 4 min` for one
  minute, then goes. People want to see it come back, not just stop being red.

**Not** on display views (stage displays, confidence monitors, lobby screens).
A stage display showing a red strip to the worship leader mid-song is exactly
the harm rule 4 exists to stop.

### 2. Home: a badge on the room card

The room card already has a health dot. An open issue adds a small amber or
red count on the card, so a TD walking in at 8:00 sees which room needs them
before opening anything. A cleared issue leaves no trace on Home.

### 3. The app header: one indicator for everything

A quiet indicator in the shell, visible only when something is open anywhere
on this server. It opens a panel listing open issues across rooms, the same
three answers per row. It is the one place an org-level issue (Planning Center
down) lives, since that has no room strip.

### 4. Slack: one message per issue, edited in place

Built already. One post when an issue matters during a show, edited as it
moves: "Sam is on it", "Dropping in and out", then struck through with ✅
"Back at 10:46, after 4 min." Forty failures, one message.

**Proposed addition: 👀 in Slack means "on it."** The help button already
taught the team that gesture (assistance.js). A tech on their phone in the
hallway should not need to find a browser to say "mine". The server would
poll the reaction while an issue is open, exactly as assistance does.

### 5. Admin → Monitoring (new page)

Where trust is built. Three short sections, in this order:

**Sending.** Is Slack connected, which channel, and a **Send test** button.
The single most reassuring thing a monitor can do is prove, on a Tuesday, that
it will reach you on Sunday.

**Watching.** Every integration in every room with its dot and **last
checked** time. This is "make the watching visible", and it surfaces the gap
below honestly instead of hiding it.

**Rules.** The built-in rule, read-only, written as a sentence, in the shape
Automations will use in 1.6:

> **When** an integration is unreachable for 30 seconds
> **then** show an issue on the room's screens,
> **and if a show is live** send it to Slack.

Showing the rule this way does two jobs: it tells a tech exactly when they
will and will not be paged, and it teaches the WHEN / THEN shape before
Automations arrive, so that page is familiar on the day it ships.

### 6. After the service: issues in the service report

The service report (Event Detail → report) gains an **Issues** section:
everything that was open during that service in that room, with how long and
who claimed it, and how long until they did.

```
Issues during this service
  ProPresenter unreachable   10:42 – 10:46   4 min   Sam, 40 s after it opened
```

This is where the "rigor" actually lands for a church. Nobody reads a log; a
TD does read the report of the service they just ran. Over a few weeks it
answers "is the Auditorium's ProPresenter getting worse?", which today nobody
can answer at all.

Admin → Logs gains a **Signals** tab beside the audit trail: the raw stream,
filterable by room and kind, for the person debugging. Behind `system.logs`,
because it carries addresses.

## What I am deliberately leaving out of 1.5

- **Muting or snoozing.** Tempting, and the first thing a muted monitor needs.
  If the default rule is right, nobody needs it in the first release; if
  churches ask, we learn what they wanted to mute.
- **Per-person notification settings.** One channel, one team.
- **Severity words, counts and graphs in the strip.** Three answers, nothing
  else.
- **Any rule editing.** That is Automations, 1.6.

## Decisions for you

1. **Pre-service watching (a server change, and the biggest one).** Today an
   integration is only checked when something is talking to it: a live show,
   or a screen showing that room. At 8:00 on a Sunday, with no screen open, a
   dead ProPresenter is not noticed until the show starts. That is exactly the
   "Sunday-morning surprise" VISION.md §4 is about.
   **Recommend:** the server probes each room's integrations itself during
   the hour before each scheduled service (autostart's arm window already
   computes "next service in this room") and while a show is live, at the
   same 30-second cadence the health widget uses. Cost: one small request per
   device per 30 seconds, for an hour or two a week.
2. **Where the strip appears.** Recommend Room Console and Run of Show only;
   never display views.
3. **👀 in Slack as "on it".** Recommend yes; same gesture as the help button.
4. **Issues in the service report.** Recommend yes; it is the payoff for the
   whole feature.
5. **The word "Issue."** Recommend it over "Alert" on screen; the code keeps
   `alerts`.
