import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { LayoutGrid, Monitor, Pencil, Plus } from 'lucide-react';
import { createView, getRoom, getViews } from '../api';
import { useQuery, invalidate } from '../lib/useQuery';
import { roomKey, viewsKey } from '../lib/keys';
import { useCan } from '../lib/identity';

// A room's dashboards and displays.
//
// The stored object is a "view" everywhere in the code and the API; nobody
// reading this screen ever sees that word. Two kinds, two headings.
//
// Two routes show the same list: /room/:id/views, reached from the room page,
// and /dashboards, the sidebar's, which picks the room (#61). ViewsList is the
// list; each route supplies its own heading.

const KINDS = [
  {
    kind: 'dashboard' as const,
    title: 'Dashboards',
    icon: LayoutGrid,
    empty: 'No dashboards yet.',
    hint: 'A grid you arrange and read in the booth.',
  },
  {
    kind: 'display' as const,
    title: 'Displays',
    icon: Monitor,
    empty: 'No displays yet.',
    hint: 'A fixed 3×3 screen — a multiview tile or a lobby TV.',
  },
];

/** A display's home is the chrome-less full-screen route — that IS the display.
 *  A dashboard opens inside the shell. */
const rowHref = (roomId: string, view: { kind: string; slug: string }) =>
  view.kind === 'display' ? `/display/${roomId}/${view.slug}` : `/room/${roomId}/view/${view.slug}`;

/** Derive the URL key from the name, the way the topology editor does. */
const slugify = (name: string) =>
  name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

/** /room/:roomId/views — the list under its room's back link. */
export function ViewsIndex() {
  const { roomId = '' } = useParams();
  const roomQ = useQuery(roomKey(roomId), () => getRoom(roomId), { staleMs: 10 * 60_000 });
  return (
    <ViewsList
      roomId={roomId}
      head={(
        <div className="pagehead">
          <div>
            {roomQ.data && <Link className="backlink" to={`/room/${roomId}`}>← {roomQ.data.name}</Link>}
            <h1 className="pagehead__title">Dashboards &amp; displays</h1>
          </div>
        </div>
      )}
    />
  );
}

/** One room's dashboards and displays, with create and edit. */
export function ViewsList({ roomId, head }: { roomId: string; head: ReactNode }) {
  const navigate = useNavigate();
  const canEdit = useCan('views.edit');
  const [creating, setCreating] = useState<'dashboard' | 'display' | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const viewsQ = useQuery(viewsKey(roomId), () => getViews(roomId), { staleMs: 30_000 });
  const roomQ = useQuery(roomKey(roomId), () => getRoom(roomId), { staleMs: 10 * 60_000 });

  const create = async () => {
    if (!creating) return;
    setBusy(true);
    setError('');
    try {
      const { view } = await createView(roomId, { kind: creating, name, slug: slugify(name) });
      invalidate(viewsKey(roomId));
      // Straight into the editor: a view with no widgets is not somewhere to
      // leave someone standing.
      navigate(`/room/${roomId}/view/${view.slug}/edit`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (viewsQ.error || roomQ.error) {
    return (
      <div className="viewsindex">
        {head}
        <div className="pagemsg">
          <p>Room not found</p>
          <Link className="backlink" to="/">← Quick Access</Link>
        </div>
      </div>
    );
  }

  const all = viewsQ.data?.views;
  const room = roomQ.data;
  if (!all || !room) return <div className="viewsindex">{head}<div className="pagemsg">Loading…</div></div>;

  return (
    <div className="viewsindex">
      {head}

      {KINDS.map(({ kind, title, icon: Icon, empty, hint }) => {
        const list = all.filter((v) => v.kind === kind);
        return (
          <section className="panel" key={kind}>
            <h2 className="panel__title">{title}</h2>
            {list.length === 0 ? (
              <p className="viewsindex__empty">{empty} {hint}</p>
            ) : (
              <ul className="viewsindex__list">
                {list.map((view) => (
                  <li key={view.id}>
                    <Link className="viewsindex__row" to={rowHref(roomId, view)}>
                      <Icon size={16} aria-hidden />
                      <span className="viewsindex__name">{view.name}</span>
                      <span className="viewsindex__meta mono">
                        {view.columns}×{view.maxRows ?? '∞'}
                      </span>
                    </Link>
                    {canEdit && (
                      <Link
                        className="iconbtn"
                        aria-label={`Edit ${view.name}`}
                        title={`Edit ${view.name}`}
                        to={`/room/${roomId}/view/${view.slug}/edit`}
                      >
                        <Pencil size={15} />
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {canEdit && (
              <button
                className="btn btn--sm"
                onClick={() => { setCreating(kind); setName(''); setError(''); }}
              >
                <Plus size={14} /> New {kind}
              </button>
            )}
          </section>
        );
      })}

      {creating && (
        <div className="confirm" role="dialog" aria-modal="true" aria-labelledby="new-view">
          <div className="confirm__card">
            <p className="eyebrow">New {creating}</p>
            <p className="confirm__text" id="new-view">Name this {creating}</p>
            <div className="confirm__field">
              <label className="sr-only" htmlFor="new-view-name">Name</label>
              <input
                id="new-view-name"
                className="field"
                autoFocus
                value={name}
                maxLength={60}
                placeholder={creating === 'display' ? 'Multiview' : 'Front of House'}
                aria-describedby={slugify(name) ? 'new-view-slug' : undefined}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && slugify(name) && create()}
              />
              {/* Shown, not hidden: it is the address a screen gets pointed at,
                  and someone will have to type it into a kiosk one day.
                  DESCRIBES the field rather than naming it — inside the label
                  it became part of the field's accessible name, so the name
                  changed with every keystroke. */}
              {slugify(name) && (
                <p className="confirm__hint mono" id="new-view-slug">/{slugify(name)}</p>
              )}
            </div>
            {error && <p className="identity__error">{error}</p>}
            <div className="confirm__buttons">
              <button className="confirm__cancel" onClick={() => setCreating(null)}>Cancel</button>
              <button className="confirm__ok" disabled={busy || !slugify(name)} onClick={create}>
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
