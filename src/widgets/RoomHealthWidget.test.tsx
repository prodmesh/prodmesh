import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RoomHealthWidget } from './RoomHealthWidget';
import { emitTopic } from '../test/fakeEventSource';

const show = () => render(<RoomHealthWidget roomId="north-main" config={{}} />);
const push = (data: unknown) => emitTopic({ 'room:north-main:health': data });

const at = (integrations: { id: string; label: string; state: string }[]) => ({
  at: 1_700_000_000_000, integrations,
});
const i = (id: string, label: string, state: string) => ({ id, label, state });

const names = () =>
  [...document.querySelectorAll('.health__name')].map((e) => e.textContent);

describe('RoomHealthWidget', () => {
  it('says it is checking rather than showing an empty cell', async () => {
    // The first probe is real requests to real machines and takes a moment. An
    // empty cell in the meantime reads as "this room has no integrations".
    show();
    expect(await screen.findByText('Checking…')).toBeInTheDocument();
  });

  it('summarises the count of what is WRONG, not what is right', async () => {
    // "All good" and "2 down" are each readable in the half-second somebody
    // glances at a wall. "3/5" makes you do arithmetic first.
    show();
    await push(at([
      i('planningCenter', 'Planning Center', 'ok'),
      i('companion', 'Companion', 'ok'),
    ]));
    expect(await screen.findByText('All good')).toBeInTheDocument();

    await push(at([
      i('planningCenter', 'Planning Center', 'ok'),
      i('companion', 'Companion', 'down'),
      i('proPresenter', 'ProPresenter', 'down'),
    ]));
    expect(await screen.findByText('2 down')).toBeInTheDocument();
  });

  it('puts what is broken first, whatever order the server sent', async () => {
    // A one-column placement clips at the bottom, so the thing you need to
    // see has to be at the top rather than wherever it happened to land.
    show();
    await push(at([
      i('proPresenter', 'ProPresenter', 'down'),
      i('planningCenter', 'Planning Center', 'ok'),
      i('analysis', 'Analysis', 'unknown'),
      i('companion', 'Companion', 'unknown'),
    ]));
    await screen.findByText('1 down');
    expect(names()).toEqual(['ProPresenter', 'Analysis', 'Companion', 'Planning Center']);
  });

  it('distinguishes not-contacted-yet from broken', async () => {
    // Grey and red are different claims. "Not checked yet" is honest about a
    // room that has not been asked; calling it down would send somebody to the
    // booth for nothing.
    show();
    await push(at([i('youtube', 'YouTube', 'unknown')]));
    expect(await screen.findByText('1 not checked')).toBeInTheDocument();
    expect(screen.getByText('Not checked yet')).toBeInTheDocument();
  });

  it('says each state in words, not only in colour', async () => {
    // The words are hidden by CSS at narrow widths and stay in the
    // accessibility tree — a coloured dot alone is a decoration, and colour
    // alone is not a status to everyone.
    show();
    await push(at([
      i('companion', 'Companion', 'down'),
      i('analysis', 'Analysis', 'mock'),
      i('planningCenter', 'Planning Center', 'ok'),
    ]));
    expect(await screen.findByText('Not responding')).toBeInTheDocument();
    expect(screen.getByText('Simulated')).toBeInTheDocument();
    expect(screen.getByText('Responding')).toBeInTheDocument();
  });

  it('lists only what the room has configured', async () => {
    // An unconfigured integration is absent, not a permanent grey dot — that
    // is the noise that teaches people to stop reading the dots.
    show();
    await push(at([i('companion', 'Companion', 'ok')]));
    await screen.findByText('All good');
    expect(names()).toEqual(['Companion']);
  });
});
