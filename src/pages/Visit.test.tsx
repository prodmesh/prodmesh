import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Visit } from './Visit';

const api = vi.hoisted(() => ({
  arriveWithPass: vi.fn(),
  setToken: vi.fn(),
  markVisiting: vi.fn(),
}));
vi.mock('../api', async (importOriginal) => ({ ...await importOriginal<typeof import('../api')>(), ...api }));

function arrive(hash: string) {
  window.history.replaceState(null, '', `/visit#${hash}`);
  return render(
    <MemoryRouter initialEntries={['/visit']}>
      <Routes>
        <Route path="/visit" element={<Visit />} />
        <Route path="/room/:roomId" element={<p>Room page</p>} />
        <Route path="/" element={<p>Home page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('arriving from a linked server (ADR 0018)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('trades the pass for a session, clears it from the address bar, and lands', async () => {
    api.arriveWithPass.mockResolvedValue({ token: 'tok', user: {}, permissions: [], server: 'North', expiresAt: 0 });
    arrive(new URLSearchParams({ pass: 'pmvisit1.a.b', to: '/room/south-main' }).toString());
    expect(await screen.findByText('Room page')).toBeInTheDocument();
    expect(api.arriveWithPass).toHaveBeenCalledWith('pmvisit1.a.b');
    expect(api.setToken).toHaveBeenCalledWith('tok');
    expect(api.markVisiting).toHaveBeenCalled();
    expect(window.location.hash).toBe('');
  });

  it('without a pass, passes straight through, still marked as visiting', async () => {
    arrive(new URLSearchParams({ to: '/room/south-main' }).toString());
    expect(await screen.findByText('Room page')).toBeInTheDocument();
    expect(api.arriveWithPass).not.toHaveBeenCalled();
    expect(api.markVisiting).toHaveBeenCalled();
  });

  it('says why a pass was refused, and offers to continue anonymously', async () => {
    api.arriveWithPass.mockRejectedValue(new Error('The pass has expired, or the clocks disagree'));
    arrive(new URLSearchParams({ pass: 'pmvisit1.a.b', to: '/room/south-main' }).toString());
    expect(await screen.findByText(/clocks disagree/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Continue without signing in' })).toHaveAttribute('href', '/room/south-main');
  });

  it('will not land anywhere but a plain path here', async () => {
    arrive(new URLSearchParams({ to: '//evil.example/x' }).toString());
    await waitFor(() => expect(screen.getByText('Home page')).toBeInTheDocument());
  });
});
