import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CompanionVariablesWidget } from './CompanionVariablesWidget';
import { emitTopic } from '../test/fakeEventSource';
import type { CompanionVariableRow } from './types';

const show = (rows: CompanionVariableRow[]) =>
  render(<CompanionVariablesWidget roomId="north-main" config={{ rows }} />);

const push = (frames: Record<string, unknown>) => emitTopic(frames);
const topic = (label: string, name: string) => `room:north-main:var:${label}:${name}`;
const ok = (value: string) => ({ value, status: 'ok' });

/** The bullet by a row, as a colour-blind reader gets it: the class carries the
 *  colour, the sr-only text carries the meaning. */
const bulletOf = (label: string) =>
  screen.getByText(label).closest('li')!.querySelector('[class*="cvar__dot--"]')!.className;

describe('CompanionVariablesWidget', () => {
  it('says how to configure it rather than rendering an empty cell', () => {
    // It appears on the canvas the moment it is dropped, which is the one
    // moment somebody is looking for the settings panel.
    show([]);
    expect(screen.getByText(/add them in Widget settings/i)).toBeInTheDocument();
  });

  it('labels a row with its own label, falling back to the variable name', async () => {
    show([
      { variable: 'custom:doorsOpen', label: 'Doors' },
      { variable: 'internal:time_hms' },
    ]);
    await push({ [topic('custom', 'doorsOpen')]: ok('OPEN'), [topic('internal', 'time_hms')]: ok('10:42:15') });

    expect(screen.getByText('Doors')).toBeInTheDocument();
    expect(screen.getByText('OPEN')).toBeInTheDocument();
    expect(screen.getByText('time_hms')).toBeInTheDocument();
    expect(screen.getByText('10:42:15')).toBeInTheDocument();
  });

  it('colours a bullet only from the values the operator named', async () => {
    const row = { variable: 'custom:stream', label: 'Stream', display: 'status' as const, ok: 'LIVE, live', warn: 'STARTING', bad: 'OFF,ERROR' };
    const { rerender } = show([row]);

    await push({ [topic('custom', 'stream')]: ok('live') });
    expect(bulletOf('Stream')).toContain('cvar__dot--ok'); // case is ignored
    expect(screen.getByText('OK.')).toBeInTheDocument(); // and said in words

    await push({ [topic('custom', 'stream')]: ok('ERROR') });
    expect(bulletOf('Stream')).toContain('cvar__dot--bad');

    // A value in no list gets no colour: a grey bullet says "not a state this
    // row was told about", where inventing a colour would be a guess shown as
    // a fact. This is the case that shows up when a module is renamed.
    await push({ [topic('custom', 'stream')]: ok('RECONNECTING') });
    expect(bulletOf('Stream')).toContain('cvar__dot--none');
    expect(screen.getByText('RECONNECTING')).toBeInTheDocument();

    // Listed twice by mistake — the alarming colour wins, because the other
    // order shows a red state as green.
    rerender(<CompanionVariablesWidget roomId="north-main" config={{ rows: [{ ...row, ok: 'HOT', bad: 'HOT' }] }} />);
    await push({ [topic('custom', 'stream')]: ok('HOT') });
    expect(bulletOf('Stream')).toContain('cvar__dot--bad');
  });

  it('draws a bar from a number, and only from a number', async () => {
    show([
      { variable: 'shure-api:battery', label: 'Pack 1', display: 'bar', min: 0, max: 8 },
      { variable: 'custom:mode', label: 'Mode', display: 'bar' },
    ]);
    await push({ [topic('shure-api', 'battery')]: ok('6'), [topic('custom', 'mode')]: ok('SUNDAY') });

    const meter = screen.getByRole('meter');
    expect(meter).toHaveAttribute('aria-valuenow', '6');
    expect(meter.firstElementChild).toHaveStyle({ width: '75%' });

    // "SUNDAY" is not a position on a bar. The row stays as text rather than
    // drawing an empty track, which would read as zero percent of something.
    expect(screen.getAllByRole('meter')).toHaveLength(1);
    expect(screen.getByText('SUNDAY')).toBeInTheDocument();
  });

  it('reads a percentage as the number an operator meant', async () => {
    show([{ variable: 'obs:cpu', label: 'CPU', display: 'bar' }]);
    await push({ [topic('obs', 'cpu')]: ok('42%') });
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '42');
  });

  it('clamps a value outside the bar rather than overflowing the cell', async () => {
    show([{ variable: 'obs:cpu', label: 'CPU', display: 'bar', min: 0, max: 10 }]);
    await push({ [topic('obs', 'cpu')]: ok('40') });
    expect(screen.getByRole('meter').firstElementChild).toHaveStyle({ width: '100%' });
  });

  it('names which failure it is, because they are three different jobs', async () => {
    show([
      { variable: 'custom:typo', label: 'Typo' },
      { variable: 'custom:doors', label: 'Doors' },
      { variable: 'custom:uncfg', label: 'Unconfigured' },
      { variable: 'custom:quiet', label: 'Quiet' },
    ]);
    await push({
      [topic('custom', 'typo')]: { value: null, status: 'missing' },
      [topic('custom', 'doors')]: { value: null, status: 'offline' },
      [topic('custom', 'uncfg')]: { value: null, status: 'unconfigured' },
    });

    // Settings, machine, and "this room has no Companion" — collapsing these
    // into one dash would send somebody to the wrong place mid-service.
    expect(screen.getByText('No such variable')).toBeInTheDocument();
    expect(screen.getByText('Companion offline')).toBeInTheDocument();
    expect(screen.getByText('Not configured')).toBeInTheDocument();
    // No frame yet is the normal first second — subscribing is what starts the
    // poller — so it is not dressed up as a fault.
    expect(screen.getByText('…')).toBeInTheDocument();
  });

  it('holds a row that names no variable, rather than subscribing to nonsense', async () => {
    // A layout written by another build, or edited by hand. The hub would drop
    // the malformed topic anyway; saying so beats a row that waits forever.
    show([{ variable: 'roomState', label: 'Mode' }]);
    expect(screen.getByText('Not a variable')).toBeInTheDocument();
  });

  it('lets two rows watch the same variable different ways', async () => {
    show([
      { variable: 'obs:cpu', label: 'CPU load', display: 'bar', min: 0, max: 100 },
      { variable: 'obs:cpu', label: 'CPU state', display: 'status', bad: '95' },
    ]);
    await push({ [topic('obs', 'cpu')]: ok('95') });
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '95');
    expect(bulletOf('CPU state')).toContain('cvar__dot--bad');
  });
});
