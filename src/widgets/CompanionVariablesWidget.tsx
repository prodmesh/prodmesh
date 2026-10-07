import { useTopic, roomTopic } from '../lib/stream';
import type { CompanionVariableRow, WidgetProps } from './types';

// ─────────────────────────────────────────────────────────────────────────────
//  Companion variables — a rack of labelled values from the room's Companion.
//
//  Every other widget answers one fixed question. This one answers whatever
//  the building has already taught Companion to know: which lights are up, is
//  the ATEM on the programme bus, how many wireless packs are low. That is why
//  its config is a LIST and why it is the first widget that is not unique —
//  two of these are two different racks, and their rows say which.
//
//  Three ways to show a value, because a value means three different kinds of
//  thing. A word ("Doors: OPEN") is text. A word whose colour is the actual
//  news ("Stream: LIVE") wants a bullet. A number against a range (battery,
//  percentage) wants a bar. Nothing here parses meaning out of the value: the
//  operator says which values are good, because only they know.
//
//  Rows subscribe individually rather than the widget subscribing once, so
//  eight rows across three dashboards still cost the server ONE poll loop —
//  the refcounting is in useTopic and the hub, and it only works if each
//  variable is its own topic. See server/companionVariables.js.
// ─────────────────────────────────────────────────────────────────────────────

/** What the server publishes per variable. `status` is why there is no value,
 *  and the three failures are different jobs for whoever has to fix them. */
interface VariableState {
  value: string | null;
  status: 'ok' | 'missing' | 'offline' | 'unconfigured';
}

const NO_VALUE: Record<Exclude<VariableState['status'], 'ok'>, string> = {
  missing: 'No such variable',
  offline: 'Companion offline',
  unconfigured: 'Not configured',
};

type Zone = 'ok' | 'warn' | 'bad' | 'none';

/** A comma-separated match list as typed in the inspector. */
const matches = (list: string | undefined, value: string) =>
  (list ?? '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean)
    .includes(value.trim().toLowerCase());

/**
 * Which colour a value earns.
 *
 * Worst match wins, so a value listed in two boxes by mistake shows the
 * alarming one — the failure mode of the other order is a red state displayed
 * as green, which is the only outcome here that could matter on a Sunday.
 *
 * A value in no list is `none`, deliberately: a grey bullet says "not one of
 * the states this row was told about", and picking a colour for it would be a
 * guess shown as a fact.
 */
function zoneOf(row: CompanionVariableRow, value: string | null): Zone {
  if (value == null) return 'none';
  if (matches(row.bad, value)) return 'bad';
  if (matches(row.warn, value)) return 'warn';
  if (matches(row.ok, value)) return 'ok';
  return 'none';
}

const ZONE_TEXT: Record<Zone, string> = {
  ok: 'OK',
  warn: 'Warning',
  bad: 'Alert',
  none: 'No state configured',
};

/** Companion hands back strings. A bar needs a number, and "68%" is a number
 *  an operator will absolutely type — anything else is left as text rather
 *  than drawn as a bar at some invented position. */
function asNumber(value: string | null): number | null {
  if (value == null) return null;
  const trimmed = value.trim().replace(/%$/, '');
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
  return Number(trimmed);
}

export function CompanionVariablesWidget({ roomId, config }: WidgetProps) {
  const rows = config.rows ?? [];

  // An unconfigured widget says how to configure it. It renders on the canvas
  // the moment it is dropped, and that is the one moment somebody is looking
  // for the settings panel.
  if (!rows.length) {
    return (
      <div className="wgt wgt--cvars">
        <p className="wgt__detail">No variables yet — add them in Widget settings.</p>
      </div>
    );
  }

  return (
    <div className="wgt wgt--cvars">
      {/* A list, not a table: a screen reader should read "Doors, OPEN, OK",
          which is the entire content of a coloured dot beside a word and is
          otherwise unavailable to anyone who cannot see the colour. */}
      <ul className="cvar">
        {rows.map((row, i) => (
          // Index in the key because two rows may legitimately watch the same
          // variable — one as a bullet, one as a bar.
          <VariableRow key={`${row.variable}:${i}`} roomId={roomId} row={row} />
        ))}
      </ul>
    </div>
  );
}

function VariableRow({ roomId, row }: { roomId: string; row: CompanionVariableRow }) {
  const [label, name] = row.variable.split(':');
  // A row saved by a newer build, or hand-edited, might not name a variable at
  // all. Subscribing to a malformed topic would just be dropped by the hub, so
  // ask for nothing and say what is wrong instead.
  const state = useTopic<VariableState>(label && name ? roomTopic.companionVar(roomId, label, name) : null);

  const display = row.display ?? 'text';
  const heading = row.label || name || row.variable;
  const value = state?.status === 'ok' ? state.value : null;
  const zone = display === 'status' ? zoneOf(row, value) : 'none';
  const number = display === 'bar' ? asNumber(value) : null;

  // Undefined means the first read has not landed — the subscription starts
  // the poller, so this is the normal first second, not a fault.
  const text = !label || !name
    ? 'Not a variable'
    : state == null
      ? '…'
      : state.status === 'ok'
        ? (state.value || '—')
        : NO_VALUE[state.status];

  const faded = state == null || state.status !== 'ok';

  return (
    <li className={`cvar__row cvar__row--${display}${faded ? ' cvar__row--quiet' : ''}`}>
      <span className="cvar__line">
        {display === 'status' && (
          <>
            <span className={`cvar__dot cvar__dot--${zone}`} aria-hidden />
            <span className="sr-only">{ZONE_TEXT[zone]}. </span>
          </>
        )}
        <span className="cvar__name" title={row.variable}>{heading}</span>
        <span className="cvar__value">{text}</span>
      </span>

      {display === 'bar' && (
        <Bar value={number} min={row.min ?? 0} max={row.max ?? 100} />
      )}
    </li>
  );
}

/**
 * The bar itself. Absent rather than empty when the value is not a number:
 * an empty track next to "OPEN" would read as zero percent of something,
 * which is a worse answer than the text alone.
 */
function Bar({ value, min, max }: { value: number | null; min: number; max: number }) {
  if (value == null) return null;
  const span = max - min;
  // A saved row cannot have max ≤ min (the server refuses it), but a view
  // written by another build can — treat it as no range rather than dividing
  // by zero and rendering NaN% into the style attribute.
  const fraction = span > 0 ? (value - min) / span : 0;
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  return (
    <span
      className="cvar__bar"
      role="meter"
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
    >
      <span className="cvar__fill" style={{ width: `${pct}%` }} />
    </span>
  );
}
