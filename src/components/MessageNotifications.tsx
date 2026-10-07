import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { MessageSquare, X } from 'lucide-react';
import type { SundayThread } from '../api';

// Only alert on new incoming messages after the initial inbox snapshot. A
// reconnect, login, or unread history must not replay old notifications.
export function MessageNotifications({ userId, threads }: { userId?: string; threads?: SundayThread[] }) {
  const location = useLocation();
  const navigate = useNavigate();
  const known = useRef<Map<string, number> | null>(null);
  const [notice, setNotice] = useState<SundayThread | null>(null);
  useEffect(() => {
    if (!userId || !threads) return;
    const next = new Map(threads.map(t => [t.id, t.latestMessage?.id ?? 0]));
    const incoming = known.current ? threads.filter(t => t.latestMessage && t.latestMessage.id > (known.current!.get(t.id) ?? t.latestMessage.id) && t.latestMessage.senderId !== userId && t.unread > 0) : [];
    known.current = next;
    if (incoming.length && location.pathname !== '/messages' && location.pathname !== '/sunday-team') {
      setNotice(incoming.sort((a,b) => (b.latestMessage?.id ?? 0) - (a.latestMessage?.id ?? 0))[0]);
    }
    if (notice && (!threads.some(t => t.id === notice.id && t.unread > 0) || location.pathname === '/messages')) setNotice(null);
  }, [userId, threads, location.pathname, notice]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const title = document.title.replace(/^\(\d+\) /, '');
    const count = userId ? (threads ?? []).reduce((n,t) => n + t.unread, 0) : 0;
    document.title = count ? `(${count}) ${title}` : title;
    return () => { document.title = title; };
  }, [userId, threads]);
  if (!notice) return null;
  return <aside className="message-notification" role="status" aria-live="polite">
    <MessageSquare size={22} aria-hidden />
    <button className="message-notification__open" onClick={() => { setNotice(null); navigate(`/messages?thread=${encodeURIComponent(notice.id)}`); }}>
      <strong>New message · {notice.siteName}</strong>
      <span className="message-notification__sender">{notice.latestMessage?.senderName ?? 'A team member'}</span>
      <span className="message-notification__preview">{notice.latestMessage?.preview ?? 'Sent a message to your Sunday team.'}</span>
      <small>Open conversation</small>
    </button>
    <button className="iconbtn" aria-label="Dismiss message notification" onClick={() => setNotice(null)}><X size={18} /></button>
  </aside>;
}
