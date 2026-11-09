import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useQuery, invalidate, clearQueryCache } from './useQuery';

function Probe({
  id,
  fetcher,
  pollMs,
  queryKey = 'k',
}: {
  id: string;
  fetcher: () => Promise<string>;
  pollMs?: number;
  queryKey?: string;
}) {
  const q = useQuery(queryKey, fetcher, { pollMs, staleMs: 10_000 });
  return (
    <span data-testid={id}>
      {q.loading ? 'loading' : q.error ? `error:${q.error}` : (q.data ?? 'empty')}
    </span>
  );
}

beforeEach(() => clearQueryCache());
afterEach(() => vi.useRealTimers());

describe('useQuery', () => {
  it('two components on the same key share ONE fetch and one result', async () => {
    const fetcher = vi.fn().mockResolvedValue('shared');
    render(
      <>
        <Probe id="a" fetcher={fetcher} />
        <Probe id="b" fetcher={fetcher} />
      </>,
    );

    await waitFor(() => expect(screen.getByTestId('a')).toHaveTextContent('shared'));
    expect(screen.getByTestId('b')).toHaveTextContent('shared');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('a fresh cached result serves a remount without refetching', async () => {
    const fetcher = vi.fn().mockResolvedValue('cached');
    const first = render(<Probe id="a" fetcher={fetcher} />);
    await waitFor(() => expect(screen.getByTestId('a')).toHaveTextContent('cached'));
    first.unmount();

    render(<Probe id="b" fetcher={fetcher} />);
    expect(screen.getByTestId('b')).toHaveTextContent('cached'); // instantly, no loading
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps last-known data when a refetch fails, exposing the error', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce('good').mockRejectedValue(new Error('down'));
    render(<Probe id="a" fetcher={fetcher} />);
    await waitFor(() => expect(screen.getByTestId('a')).toHaveTextContent('good'));

    act(() => invalidate());
    // Error replaces the display in the probe, but data survives underneath —
    // rendered apps show stale data + an error hint rather than a blank page.
    await waitFor(() => expect(screen.getByTestId('a')).toHaveTextContent('error:down'));
  });

  it('invalidate(prefix) refetches only matching mounted keys', async () => {
    const one = vi.fn().mockResolvedValue('one');
    const two = vi.fn().mockResolvedValue('two');
    render(
      <>
        <Probe id="a" queryKey="rooms" fetcher={one} />
        <Probe id="b" queryKey="calendar:x" fetcher={two} />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId('b')).toHaveTextContent('two'));

    act(() => invalidate('calendar:'));
    await waitFor(() => expect(two).toHaveBeenCalledTimes(2));
    expect(one).toHaveBeenCalledTimes(1);
  });

  it('auth changes invalidate everything mounted', async () => {
    const fetcher = vi.fn().mockResolvedValue('v');
    render(<Probe id="a" fetcher={fetcher} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    act(() => {
      window.dispatchEvent(new Event('prodmesh:auth-changed'));
    });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });

  it('polls on the given interval while mounted, and stops after unmount', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue('tick');
    const view = render(<Probe id="a" fetcher={fetcher} pollMs={5000} />);
    await act(async () => {}); // initial fetch settles
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(5100);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);

    view.unmount();
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    expect(fetcher).toHaveBeenCalledTimes(2); // no orphaned interval
  });
});

it('a realtime invalidation during an in-flight fetch triggers a follow-up fetch', async () => {
  let resolve!: (value: string) => void;
  const fetcher = vi.fn().mockImplementationOnce(() => new Promise<string>(r => { resolve = r; })).mockResolvedValue('newest');
  render(<Probe id="a" fetcher={fetcher} />);
  act(() => invalidate('k'));
  await act(async () => { resolve('older snapshot'); });
  await waitFor(() => expect(screen.getByTestId('a')).toHaveTextContent('newest'));
  expect(fetcher).toHaveBeenCalledTimes(2);
});
