import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { MessageSquare, Send, Users } from 'lucide-react';
import { getSundayConversation, getSundayDirectory, manageSunday, readSunday, requestAuth, sendSundayMessage, syncSunday,
  type SundayConversation, type SundayMessage, type SundayThread } from '../api';
import { useIdentity } from '../lib/identity';
import { useSundayInbox } from '../lib/sunday';
import { invalidate } from '../lib/useQuery';
import { useCampus } from '../layout/campus';

const dateLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' });
function merge(messages: SundayMessage[], incoming: SundayMessage[]) {
  return [...new Map([...messages, ...incoming].map(m => [m.id, m])).values()].sort((a,b) => a.id-b.id);
}
export function SundayTeam() {
  const identity = useIdentity();
  const page = useRef<HTMLElement>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    const main = page.current?.parentElement;
    const resize = () => main?.style.setProperty('--sunday-viewport', `${viewport?.height ?? window.innerHeight}px`);
    resize(); viewport?.addEventListener('resize', resize); window.addEventListener('resize', resize);
    return () => { viewport?.removeEventListener('resize', resize); window.removeEventListener('resize', resize); main?.style.removeProperty('--sunday-viewport'); };
  }, [identity?.authenticated]);
  const inbox = useSundayInbox(identity);
  const { campusId } = useCampus();
  const threads = (inbox.data?.threads ?? []).filter(t => campusId === 'all' || campusId === t.siteId);
  const [params] = useSearchParams();
  const [selected, setSelected] = useState<string | null>(() => params.get('thread'));
  const requestedThread = params.get('thread');
  useEffect(() => { if (requestedThread) setSelected(requestedThread); }, [requestedThread]);
  const chosen = threads.find(t => t.id === selected) ?? threads.find(t => t.isCurrent) ?? threads[0];
  if (!identity?.authenticated) return <section className="sunday-empty"><MessageSquare size={32} /><h1>Messages</h1><p>Sign in to coordinate with this Sunday’s serving team.</p><button className="btn" onClick={() => requestAuth()}>Log in</button></section>;
  return <section className="sunday" ref={page}>
    <header className="sunday-heading"><div><p className="eyebrow">Serving together</p><h1>Messages</h1></div><MessageSquare size={28} /></header>
    {inbox.error && <p role="alert" className="sunday-notice">{inbox.error} <button className="btn" onClick={inbox.refetch}>Retry</button></p>}
    <label className="sunday-picker">Conversation<select className="field" value={chosen?.id ?? ''} onChange={e => setSelected(e.target.value)}>
      {!threads.length && <option value="">No team conversations</option>}
      {threads.map(t => <option key={t.id} value={t.id}>{t.isCurrent ? 'Current · ' : ''}{dateLabel(t.serviceDate)} · {t.siteName}</option>)}
    </select></label>
    <div className="sunday-layout">
      <aside className="sunday-history" aria-label="Sunday conversations">
        <h2>Current Sunday</h2>
        {threads.filter(t => t.isCurrent).map(t => <ThreadButton key={t.id} thread={t} selected={chosen?.id === t.id} onSelect={setSelected} />)}
        <details><summary>Previous Sundays</summary>{threads.filter(t => !t.isCurrent).map(t => <ThreadButton key={t.id} thread={t} selected={chosen?.id === t.id} onSelect={setSelected} />)}</details>
      </aside>
      {chosen ? <Conversation key={`${identity.user?.id}:${chosen.id}`} thread={chosen} manage={inbox.data?.manage ?? false} revision={inbox.revision?.revision} /> :
        <div className="sunday-empty"><Users size={32} /><h2>{inbox.loading ? 'Finding your Sunday team…' : 'You aren’t currently on this Sunday’s team'}</h2><p>Your team administrator can add you. Scheduled assignments use your linked Planning Center account.</p></div>}
    </div>
  </section>;
}
function ThreadButton({ thread: t, selected, onSelect }: { thread: SundayThread; selected: boolean; onSelect: (id: string) => void }) {
  return <button className={`sunday-thread${selected ? ' sunday-thread--selected' : ''}`} aria-pressed={selected} onClick={() => onSelect(t.id)}>
    <strong>{dateLabel(t.serviceDate)}</strong><span>{t.siteName}{t.unread > 0 && <b className="sunday-badge">{t.unread}</b>}</span>
  </button>;
}
function Conversation({ thread, manage, revision }: { thread: SundayThread; manage: boolean; revision?: string }) {
  const [data, setData] = useState<SundayConversation | null>(null);
  const [messages, setMessages] = useState<SundayMessage[]>([]);
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [restricted, setRestricted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [olderBusy, setOlderBusy] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);
  const [directory, setDirectory] = useState<Array<{ id: string; displayName: string }>>([]);
  const [memberId, setMemberId] = useState('');
  const bottom = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const currentMessages = useRef<SundayMessage[]>([]);
  const lastRead = useRef(0);
  const nearBottom = useRef(true);
  const request = useRef(0);
  const reload = useCallback(async () => {
    const seq = ++request.current;
    try {
      const next = await getSundayConversation(thread.id);
      const last = currentMessages.current.at(-1)?.id;
      const incoming = [...next.messages];
      // A revision can conflate many sends: page forward from the last known
      // message to recover every persisted message, even after a long outage.
      if (last && next.messages[0]?.id > last) {
        let cursor = last;
        for (;;) {
          const page = await getSundayConversation(thread.id, { after: cursor });
          incoming.push(...page.messages);
          if (!page.hasMore || !page.messages.length) break;
          cursor = page.messages.at(-1)!.id;
        }
      }
      if (seq !== request.current) return;
      setRestricted(false);
      setData(next);
      setMessages(prev => merge(prev, incoming));
      setError(null);
    } catch (err) {
      if (seq !== request.current) return;
      setError((err as Error).message);
      // Fail closed: revoked membership must erase already-rendered content.
      if ([401, 403, 404].includes((err as Error & { status?: number }).status ?? 0)) { setRestricted(true); setData(null); setMessages([]); }
    }
  }, [thread.id]);
  useEffect(() => { void reload(); return () => { request.current += 1; }; }, [reload, revision]);
  useEffect(() => { currentMessages.current = messages; if (nearBottom.current) bottom.current?.scrollIntoView({ block: 'nearest' }); }, [messages]);
  const markRead = useCallback(() => {
    const last = currentMessages.current.at(-1)?.id;
    if (document.visibilityState === 'visible' && nearBottom.current && last && last > lastRead.current) {
      lastRead.current = last;
      readSunday(thread.id, last).then(() => invalidate('sunday-inbox:')).catch(() => { lastRead.current = 0; });
    }
  }, [thread.id]);
  useEffect(() => { markRead(); document.addEventListener('visibilitychange', markRead); return () => document.removeEventListener('visibilitychange', markRead); }, [messages, markRead]);
  useEffect(() => { if (teamOpen && manage) getSundayDirectory(thread.id).then(d => setDirectory(d.users)).catch(e => setError(e.message)); }, [teamOpen, manage, thread.id]);
  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); await reload(); invalidate('sunday-inbox:'); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const send = () => {
    if (busy || !body.trim() || !data?.thread.canSend || restricted) return;
    const draft = body;
    void action(async () => { await sendSundayMessage(thread.id, draft); setBody(''); nearBottom.current = true; });
  };
  const older = async () => {
    if (!messages.length || olderBusy) return;
    setOlderBusy(true);
    const height = list.current?.scrollHeight ?? 0;
    try {
      const page = await getSundayConversation(thread.id, { before: messages[0].id });
      setMessages(prev => merge(page.messages, prev));
      setData(prev => prev ? { ...prev, hasMore: page.hasMore } : prev);
      requestAnimationFrame(() => { if (list.current) list.current.scrollTop += list.current.scrollHeight - height; });
    } catch (err) { setError((err as Error).message); } finally { setOlderBusy(false); }
  };
  const t = data?.thread ?? thread;
  return <div className="sunday-conversation">
    <header className="sunday-conversation-head"><div><h2>{dateLabel(t.serviceDate)}</h2><p title={`Times shown in ${t.timezone}`}>{t.siteName} · {t.memberCount} serving</p></div><button className="btn" aria-expanded={teamOpen} onClick={() => setTeamOpen(v => !v)}><Users size={16} /> Team</button></header>
    {t.status !== 'active' && <p className="sunday-notice">{t.status === 'archived' ? 'Archived Sunday' : 'Conversation locked'} · This conversation is read-only.</p>}
    {error && <p className="sunday-notice" role="alert">{error} <button className="btn" onClick={() => void reload()}>Retry</button></p>}
    {teamOpen && data && <section className="sunday-team" aria-label="Team members">
      {data.members.length ? data.members.map(m => <div key={m.id}><span>{m.displayName} <small>{m.source}</small></span>{manage && <button className="btn" disabled={busy} onClick={() => void action(() => manageSunday(t.id, `members/${m.id}`, { remove: true }))}>Remove</button>}</div>) : <p>No one is currently assigned to this Sunday.</p>}
      {manage && <>
        <label>Add team member<select className="field" value={memberId} onChange={e => setMemberId(e.target.value)}><option value="">Choose a ProdMesh user</option>{directory.filter(u => !data.members.some(m => m.id === u.id)).map(u => <option key={u.id} value={u.id}>{u.displayName}</option>)}</select></label>
        <button className="btn" disabled={busy || !memberId} onClick={() => void action(() => manageSunday(t.id, `members/${memberId}`, { remove: false }))}>Add member</button>
        <p>{t.syncStatus === 'unavailable' ? 'Planning Center is unavailable. Existing membership is preserved; Messages are still available.' : t.syncStatus === 'manual' ? 'Planning Center is not connected or no service types are mapped. Add your team manually.' : 'Membership is matched using linked Planning Center person IDs.'}</p>
        {!!t.unmatched?.length && <div><strong>Scheduled people without ProdMesh accounts</strong><ul>{t.unmatched.map((p,i) => <li key={`${p.personId}:${i}`}>{p.name}</li>)}</ul></div>}
        <div className="sunday-admin"><button className="btn" disabled={busy || t.status !== 'active'} onClick={() => void action(() => syncSunday(t.id))}>Refresh schedule</button>{t.isCurrent && <><button className="btn" disabled={busy} onClick={() => void action(() => manageSunday(t.id, 'status', { status: t.status === 'active' ? 'locked' : 'active' }))}>{t.status === 'active' ? 'Lock conversation' : 'Unlock conversation'}</button><button className="btn" disabled={busy || t.status === 'archived'} onClick={() => void action(() => manageSunday(t.id, 'status', { status: 'archived' }))}>Archive</button></>}</div>
      </>}
    </section>}
    <div className="sunday-message-list" ref={list} role="log" aria-label="Sunday Team messages" aria-live="polite" onScroll={() => { const el = list.current!; nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; markRead(); }}>
      {data?.hasMore && <button className="btn sunday-older" disabled={olderBusy} onClick={() => void older()}>{olderBusy ? 'Loading…' : 'Load older messages'}</button>}
      {!messages.length && <div className="sunday-empty"><MessageSquare size={28} /><h3>{data ? 'Ready for Sunday' : 'Loading conversation…'}</h3><p>{t.memberCount ? 'Coordinate the little things that keep the service moving.' : 'No one is currently assigned. Administrators can add team members.'}</p></div>}
      {messages.map((m,i) => {
        const grouped = i > 0 && messages[i-1].senderId === m.senderId && m.createdAt - messages[i-1].createdAt < 300000;
        return <article className={`sunday-message${grouped ? ' sunday-message--grouped' : ''}`} key={m.id}>
          {!grouped && <><span className="sunday-avatar" aria-hidden>{(m.senderName ?? '?').slice(0,1)}</span><div className="sunday-message-meta"><strong>{m.senderName ?? 'Former team member'}</strong><time dateTime={new Date(m.createdAt).toISOString()}>{new Date(m.createdAt).toLocaleTimeString(undefined, { timeZone: t.timezone, hour: 'numeric', minute: '2-digit' })}</time></div></>}
          <p className={m.deletedAt ? 'sunday-deleted' : ''}>{m.deletedAt ? 'Message deleted' : m.body}</p>
        </article>;
      })}<div ref={bottom} />
    </div>
    <form className="sunday-composer" onSubmit={e => { e.preventDefault(); send(); }}>
      <label className="sr-only" htmlFor="sunday-body">Message Sunday Team</label>
      <textarea id="sunday-body" value={body} maxLength={4000} rows={2} disabled={!t.canSend || restricted || busy} placeholder={t.canSend ? 'Message your Sunday team…' : t.status !== 'active' ? 'This conversation is read-only' : 'You aren’t currently on this Sunday’s team'} onChange={e => setBody(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
      <button className="btn btn--primary" type="submit" aria-label="Send message" disabled={busy || restricted || !t.canSend || !body.trim()}><Send size={18} /><span>{busy ? 'Sending…' : 'Send'}</span></button>
      <small>{body.length}/4000 · Shift+Enter for a new line</small>
    </form>
  </div>;
}
