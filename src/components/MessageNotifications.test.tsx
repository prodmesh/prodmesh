import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MessageNotifications } from './MessageNotifications';
import type { SundayThread } from '../api';
const thread: SundayThread = { id: 'thread-1', siteId: 'north', siteName: 'North Campus', timezone: 'UTC', serviceDate: '2026-10-11', status: 'active', isCurrent: true, memberCount: 2, unread: 1, canSend: true, latestMessage: { id: 1, senderId: 'other', senderName: 'Producer' } };
function Path() { const path = useLocation(); return <span data-testid="path">{path.pathname}{path.search}</span>; }
function view(threads: SundayThread[], path = '/') { return <MemoryRouter initialEntries={[path]}><MessageNotifications userId="me" threads={threads} /><Path /></MemoryRouter>; }
beforeEach(() => { document.title = 'ProdMesh'; });
afterEach(() => vi.useRealTimers());
it('does not replay historical unread messages on login', () => {
  render(view([thread]));
  expect(screen.queryByRole('status')).toBeNull();
  expect(document.title).toMatch(/^\(1\) /);
});
it('new incoming messages notify and open their exact conversation', async () => {
  const user = userEvent.setup(); const page = render(view([thread]));
  page.rerender(view([{ ...thread, unread: 2, latestMessage: { id: 2, senderId: 'other', senderName: 'Producer', preview: '<script>Wireless 4 is low</script>' } }]));
  expect(screen.getByRole('status')).toHaveTextContent('New message · North Campus');
  expect(screen.getByRole('status')).toHaveTextContent('<script>Wireless 4 is low</script>');
  expect(screen.getByRole('status').querySelector('script')).toBeNull();
  await user.click(screen.getByRole('button', { name: /Open conversation/ }));
  expect(screen.getByTestId('path')).toHaveTextContent('/messages?thread=thread-1');
  expect(screen.queryByRole('status')).toBeNull();
});
it('does not notify for own sends or while the Messages page is open', () => {
  const page = render(view([thread], '/messages'));
  page.rerender(view([{ ...thread, latestMessage: { id: 2, senderId: 'other', senderName: 'Producer' } }], '/messages'));
  expect(screen.queryByRole('status')).toBeNull(); page.unmount();
  const own = render(view([thread]));
  own.rerender(view([{ ...thread, latestMessage: { id: 3, senderId: 'me', senderName: 'Me' } }]));
  expect(screen.queryByRole('status')).toBeNull();
});
it('notifications dismiss automatically and cleared unread removes the title badge', () => {
  vi.useFakeTimers(); const page = render(view([thread]));
  page.rerender(view([{ ...thread, latestMessage: { id: 2, senderId: 'other', senderName: 'Producer' } }]));
  expect(screen.getByRole('status')).toBeVisible();
  act(() => { vi.advanceTimersByTime(8000); });
  expect(screen.queryByRole('status')).toBeNull();
  page.rerender(view([{ ...thread, unread: 0 }])); expect(document.title).not.toMatch(/^\(\d+\) /);
});
