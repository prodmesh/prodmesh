import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useTopic, roomTopic } from './stream';
import { FakeEventSource, emitTopic, liveSource } from '../test/fakeEventSource';

function Private() {
  const revision = useTopic<{ revision: string }>('sunday:user-1');
  return <span data-testid="revision">{revision?.revision ?? 'none'}</span>;
}

// The property this module exists for: one connection per tab, however many
// widgets are on screen. See server/streamHub.js — browsers cap concurrent
// HTTP/1.1 connections at six, so a stream per widget (or per room) is a
// ceiling a dashboard grid would hit.

function Meter({ roomId }: { roomId: string }) {
  const spl = useTopic<{ current: number }>(roomTopic.spl(roomId));
  return <span data-testid={`spl-${roomId}`}>{spl ? spl.current : '—'}</span>;
}

function Mode({ roomId }: { roomId: string }) {
  const state = useTopic<{ mode: string }>(roomTopic.mode(roomId));
  return <span data-testid={`mode-${roomId}`}>{state?.mode ?? '—'}</span>;
}

const query = (es: FakeEventSource) =>
  decodeURIComponent(new URL(es.url, 'http://x').searchParams.get('topics') ?? '');

describe('useTopic', () => {
  it('opens ONE connection for many widgets across many rooms', async () => {
    render(
      <>
        <Meter roomId="north-main" />
        <Meter roomId="north-youth" />
        <Mode roomId="north-main" />
        <Mode roomId="north-chapel" />
      </>,
    );

    const es = await liveSource();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(query(es).split(',').sort()).toEqual([
      'room:north-chapel:mode',
      'room:north-main:mode',
      'room:north-main:spl',
      'room:north-youth:spl',
    ]);
  });

  it('two widgets on the SAME topic subscribe once and both render the value', async () => {
    render(
      <>
        <Meter roomId="north-main" />
        <Meter roomId="north-main" />
      </>,
    );

    const es = await liveSource();
    expect(query(es)).toBe('room:north-main:spl'); // asked for once, not twice

    await emitTopic({ 'room:north-main:spl': { current: 88.4 } });
    const meters = screen.getAllByTestId('spl-north-main');
    expect(meters).toHaveLength(2);
    for (const m of meters) expect(m).toHaveTextContent('88.4');
  });

  it('routes each topic to its own subscriber only', async () => {
    render(
      <>
        <Meter roomId="north-main" />
        <Meter roomId="north-youth" />
      </>,
    );
    await liveSource();

    await emitTopic({ 'room:north-main:spl': { current: 91 } });

    expect(screen.getByTestId('spl-north-main')).toHaveTextContent('91');
    expect(screen.getByTestId('spl-north-youth')).toHaveTextContent('—');
  });

  it('reconnects once when the set of mounted widgets changes', async () => {
    const view = render(<Meter roomId="north-main" />);
    await liveSource();
    expect(FakeEventSource.instances).toHaveLength(1);

    // Two more widgets appearing together is ONE reconnect, not two.
    view.rerender(
      <>
        <Meter roomId="north-main" />
        <Meter roomId="north-youth" />
        <Mode roomId="north-youth" />
      </>,
    );

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(FakeEventSource.instances[0].closed).toBe(true);
    expect(query(FakeEventSource.instances[1]).split(',').sort()).toEqual([
      'room:north-main:spl',
      'room:north-youth:mode',
      'room:north-youth:spl',
    ]);
  });

  it('a null topic subscribes to nothing', async () => {
    function Maybe() {
      const v = useTopic<number>(null);
      return <span data-testid="maybe">{v ?? 'none'}</span>;
    }
    render(<Maybe />);
    expect(screen.getByTestId('maybe')).toHaveTextContent('none');
    // Nothing was wanted, so nothing connected.
    await new Promise((r) => setTimeout(r, 60));
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('survives a malformed frame', async () => {
    render(<Meter roomId="north-main" />);
    const es = await liveSource();

    es.emit('msg', undefined); // JSON.parse of "undefined" throws
    await emitTopic({ 'room:north-main:spl': { current: 77 } });

    expect(screen.getByTestId('spl-north-main')).toHaveTextContent('77');
    expect(es.closed).toBe(false);
  });
});

it('private messaging shares the public connection and carries only an opaque ticket', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ticket: 'opaque-ticket' }), { headers: { 'Content-Type': 'application/json' } }));
  render(<><Meter roomId="north-main" /><Private /></>);
  const es = await liveSource();
  expect(query(es).split(',')).toEqual(['room:north-main:spl', 'sunday:user-1']);
  expect(new URL(es.url, 'http://x').searchParams.get('ticket')).toBe('opaque-ticket');
  expect(fetcher).toHaveBeenCalledTimes(1);
  await emitTopic({ 'sunday:user-1': { revision: 'new' } });
  expect(screen.getByTestId('revision')).toHaveTextContent('new');
});
it('identity changes erase private cache and reconnect with a fresh ticket', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ ticket: 'opaque-ticket' }), { headers: { 'Content-Type': 'application/json' } }));
  render(<Private />);
  const es = await liveSource();
  await emitTopic({ 'sunday:user-1': { revision: 'secret-cache' } });
  act(() => { window.dispatchEvent(new Event('prodmesh:auth-changed')); });
  expect(screen.getByTestId('revision')).toHaveTextContent('none');
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
  expect(es.closed).toBe(true);
});

it('a private-ticket failure leaves public operational topics connected', async () => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ticket unavailable'));
  render(<><Meter roomId="north-main" /><Private /></>);
  const es = await liveSource();
  expect(query(es)).toBe('room:north-main:spl');
  await emitTopic({ 'room:north-main:spl': { current: 90 } });
  expect(screen.getByTestId('spl-north-main')).toHaveTextContent('90');
});
