// Widget registry — the single place that knows what each widget type is.
//
// Same shape as src/tiles/registry.tsx, which is the pattern that already
// works here: a new widget is one entry plus one component, and everything
// that places widgets picks it up automatically. The point of the indirection
// is that a stored dashboard layout can name a widget by STRING — so a layout
// is data, and placing one is not a code change.
//
// Adding a widget = a type in ./types.ts and one entry here.

import { CaptionsWidget } from './CaptionsWidget';
import { ClockWidget } from './ClockWidget';
import { CompanionVariablesWidget } from './CompanionVariablesWidget';
import { CountdownWidget } from './CountdownWidget';
import { NowNextWidget } from './NowNextWidget';
import { RoomHealthWidget } from './RoomHealthWidget';
import { RoomModeWidget } from './RoomModeWidget';
import { RunOfShowWidget } from './RunOfShowWidget';
import { LyricsWidget } from './LyricsWidget';
import { SlidesLeftWidget } from './SlidesLeftWidget';
import { LoudnessWidget } from './LoudnessWidget';
import { LoudnessTrendWidget } from './LoudnessTrendWidget';
import { RtaWidget } from './RtaWidget';
import { ViewersWidget } from './ViewersWidget';
import { RestreamWidget } from './RestreamWidget';
import { ResiBroadcastWidget, ResiHealthWidget, ResiStreamWidget, ResiViewersWidget } from './ResiWidgets';
import { ObsHealthWidget } from './ObsHealthWidget';
import { ProPresenterControls, ProPresenterPlaylist, ProPresenterSlides, ProPresenterTimers, SlideNotes } from './ProPresenterWidgets';
import { PlanningCenterSchedule, PlanningCenterService, PlanningCenterTeams, PlanningCenterTimers } from './PlanningCenterWidgets';
import type { WidgetDef, WidgetType } from './types';

export const widgetRegistry: Record<WidgetType, WidgetDef> = {
  countdown: {
    title: 'Countdown',
    description: 'Time until the service starts, following the room’s ProPresenter timer.',
    integration: 'propresenter',
    component: CountdownWidget,
    size: { w: 2, h: 1 },
    defaultSpan: 'third',
  },

  loudness: {
    title: 'Loudness',
    description: 'Live SPL against the room’s target and limit, with C-A when available.',
    integration: 'analysis',
    component: LoudnessWidget,
    size: { w: 2, h: 1 },
    defaultSpan: 'third',
    unique: false,
  },

  'loudness-trend': {
    title: 'Loudness trend',
    description: 'The shape of the last quarter hour, for a mix that creeps up.',
    integration: 'analysis',
    component: LoudnessTrendWidget,
    size: { w: 2, h: 1 },
    defaultSpan: 'third',
  },

  rta: {
    title: 'RTA spectrum',
    description: 'Live frequency spectrum from the selected ProdMesh RTA room.',
    integration: 'analysis',
    component: RtaWidget,
    size: { w: 3, h: 2 },
    unique: false,
    defaultSpan: 'two-thirds',
  },

  viewers: {
    title: 'YouTube Live Viewers',
    description: 'Concurrent YouTube viewers while the room is streaming.',
    integration: 'youtube',
    component: ViewersWidget,
    // One number and a label — the only one of the three narrow enough for a
    // single cell. Countdown carries three lines of text and loudness a meter
    // with a stats line, and both look squeezed at half this.
    size: { w: 1, h: 1 },
    defaultSpan: 'third',
  },
  restream: { title: 'Restream', description: 'Restream broadcast state and connected destinations.', integration: 'restream', component: RestreamWidget, size: { w: 2, h: 2 }, defaultSpan: 'third' },
  'obs-health': { title: 'OBS Studio Health', description: 'Read-only stream, record, audio, frame, and program-scene health from OBS Studio.', integration: 'obs', component: ObsHealthWidget, size: { w: 3, h: 3 }, defaultSpan: 'third' },
  'resi-stream': { title: 'Resi Stream', description: 'Official Resi player with live and offline state.', integration: 'resi', component: ResiStreamWidget, size: { w: 3, h: 2 }, defaultSpan: 'third' },
  'resi-health': { title: 'Resi Stream Health', description: 'Normalized Resi encoder, stream, and destination health.', integration: 'resi', component: ResiHealthWidget, size: { w: 2, h: 2 }, defaultSpan: 'third' },
  'resi-viewers': { title: 'Resi Viewers', description: 'Live audience count and available Resi analytics.', integration: 'resi', component: ResiViewersWidget, size: { w: 1, h: 1 }, defaultSpan: 'third' },
  'resi-broadcast': { title: 'Resi Broadcast Monitor', description: 'Livestream preview, health, and audience in one card.', integration: 'resi', component: ResiBroadcastWidget, size: { w: 3, h: 3 }, defaultSpan: 'third' },

  'run-of-show': {
    title: 'Run of Show',
    description: 'The order of service, what is live now, and the controls to move it.',
    integration: 'planning-center',
    component: RunOfShowWidget,
    size: { w: 2, h: 3 },
    // The only widget with a range, and the reason the range exists: its list
    // scrolls, so the extra rows are more of the service rather than padding.
    minSize: { w: 2, h: 3 },
    maxSize: { w: 2, h: 5 },
    // It takes actions, and a display is DEFINED as non-interactive. The
    // server enforces this too; the palette just never offers it.
    kinds: ['dashboard'],
    defaultSpan: 'third',
  },

  'now-next': {
    title: 'Now & Next',
    description: 'The current item and the one after it, large enough to read across a room.',
    integration: 'planning-center',
    component: NowNextWidget,
    size: { w: 3, h: 1 },
    defaultSpan: 'two-thirds',
  },

  'room-mode': {
    title: 'Room mode',
    description: 'What mode the room is in, in its own colour. Read-only.',
    integration: 'companion',
    component: RoomModeWidget,
    // Two columns because this one shows WORDS. "Sunday Service" in a single
    // cell is either three characters wide or clipped.
    size: { w: 2, h: 1 },
    defaultSpan: 'third',
  },

  'companion-variables': {
    title: 'Companion variables',
    description: 'Values from the room’s Companion, as text, a status bullet or a bar.',
    integration: 'companion',
    component: CompanionVariablesWidget,
    // Two columns for a label AND its value on one line, two rows because a
    // rack of one variable is a rack of nothing — the point is several at once.
    size: { w: 2, h: 2 },
    minSize: { w: 1, h: 1 },
    maxSize: { w: 3, h: 4 },
    // The first genuinely multi-instance widget, and the one the `unique` flag
    // was written for: two of these are two different racks of variables, and
    // their rows are the identity that tells them apart.
    unique: false,
    defaultSpan: 'third',
  },

  'room-health': {
    title: 'Integrations',
    description: 'A dot per integration this room has configured, and whether it answers.',
    integration: 'prodmesh',
    component: RoomHealthWidget,
    size: { w: 1, h: 1 },
    // The first range that is genuinely 2D, and the reason is that BOTH axes
    // buy the same thing: more of the room's devices on screen at once. A
    // single cell shows about four. Wider adds columns, taller adds rows, and
    // which one you want is a question about the space left on your dashboard
    // rather than about this widget — so it does not get to choose for you.
    //
    // Same test Run of Show's extra rows pass: the list is real content that
    // continues past the edge, not whitespace with a handle on it.
    minSize: { w: 1, h: 1 },
    maxSize: { w: 3, h: 3 },
    defaultSpan: 'third',
  },

  captions: {
    title: 'Captions',
    description: 'Live transcript of the production comms channels, colour-coded by speaker.',
    // ProdMesh Caption is supplied by ProdMesh itself, and belongs alongside
    // Clock and Integrations in the editor's one ProdMesh dropdown.
    integration: 'prodmesh',
    component: CaptionsWidget,
    size: { w: 2, h: 1 },
    // Two columns is the narrowest that fits a speaker name and a line of
    // speech; three earns the speaker rail. Height is simply more of the
    // conversation, which is real content continuing past the edge.
    minSize: { w: 2, h: 1 },
    maxSize: { w: 3, h: 3 },
    defaultSpan: 'two-thirds',
  },

  'slides-left': {
    title: 'Slides left',
    description: 'How many slides — or how much video — until the current item ends.',
    integration: 'propresenter',
    component: SlidesLeftWidget,
    // One number and a label, so it fits where nothing else does. That is the
    // point: a control room wall has room for this next to a multiview, and
    // making it any bigger would only add whitespace around a countdown.
    size: { w: 1, h: 1 },
    defaultSpan: 'third',
  },

  lyrics: {
    title: 'Lyrics',
    description: 'The song ProPresenter has open, scrolled to the line that is up.',
    integration: 'propresenter',
    component: LyricsWidget,
    // Two rows is the floor because the whole idea is seeing PAST the current
    // line: at one row this is Now & Next with extra steps. Width buys line
    // length, which is what stops a lyric wrapping mid-phrase.
    size: { w: 2, h: 2 },
    minSize: { w: 2, h: 2 },
    maxSize: { w: 3, h: 3 },
    defaultSpan: 'third',
  },

  clock: {
    title: 'Clock',
    description: 'The time of day, with seconds.',
    integration: 'prodmesh',
    component: ClockWidget,
    // Also two: "10:42:07" at the size that makes a clock worth putting on a
    // wall does not fit one column, and dropping the seconds to make it fit
    // would remove the reason a booth wants a clock.
    size: { w: 2, h: 1 },
    defaultSpan: 'third',
  },
  'propresenter-slides': { title: 'ProPresenter Slides', description: 'Current ProPresenter cue, notes and foreground video status.', integration: 'propresenter', component: ProPresenterSlides, size: { w: 2, h: 2 }, minSize: { w: 2, h: 2 }, maxSize: { w: 3, h: 3 }, defaultSpan: 'third' },
  'propresenter-playlist': { title: 'ProPresenter Playlist', description: 'Focused playlist with every available cue and optional slide controls.', integration: 'propresenter', component: ProPresenterPlaylist, size: { w: 4, h: 4 }, minSize: { w: 2, h: 2 }, maxSize: { w: 4, h: 5 }, kinds: ['dashboard'], defaultSpan: 'two-thirds' },
  'propresenter-controls': { title: 'ProPresenter Controls', description: 'Large previous and next slide controls.', integration: 'propresenter', component: ProPresenterControls, size: { w: 2, h: 1 }, kinds: ['dashboard'], defaultSpan: 'third' },
  'slide-notes': { title: 'Slide Notes', description: 'Operator notes for the active ProPresenter cue.', integration: 'propresenter', component: SlideNotes, size: { w: 2, h: 1 }, defaultSpan: 'third' },
  'propresenter-timers': { title: 'ProPresenter Timers', description: 'All configured ProPresenter timers, read-only.', integration: 'propresenter', component: ProPresenterTimers, size: { w: 2, h: 2 }, minSize: { w: 2, h: 1 }, maxSize: { w: 3, h: 3 }, defaultSpan: 'third' },
  'planning-center-service': { title: 'Planning Center Service', description: 'The service title, date, and selected service time.', integration: 'planning-center', component: PlanningCenterService, size: { w: 2, h: 1 }, defaultSpan: 'third' },
  'planning-center-timers': { title: 'Planning Center Timers', description: 'Scheduled item start times and lengths from the service plan.', integration: 'planning-center', component: PlanningCenterTimers, size: { w: 2, h: 2 }, minSize: { w: 2, h: 2 }, maxSize: { w: 3, h: 4 }, defaultSpan: 'third' },
  'planning-center-schedule': { title: 'Planning Center Schedule', description: 'How far ahead or behind the active service is.', integration: 'planning-center', component: PlanningCenterSchedule, size: { w: 2, h: 1 }, defaultSpan: 'third' },
  'planning-center-teams': { title: 'Planning Center Teams', description: 'Scheduled people grouped by their Planning Center team.', integration: 'planning-center', component: PlanningCenterTeams, size: { w: 2, h: 2 }, minSize: { w: 2, h: 2 }, maxSize: { w: 3, h: 4 }, defaultSpan: 'third' },
};

export const widgetTypes = Object.keys(widgetRegistry) as WidgetType[];

export const isWidgetType = (v: string): v is WidgetType => v in widgetRegistry;
