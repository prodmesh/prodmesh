import { useEffect, useRef, useState } from 'react';
import { Bell } from 'lucide-react';
import { useOpenIssues, worst } from '../lib/issues';
import { IssueRow } from './Issues';

// The sidebar's notifications space (alerts-ux.md, section 3). Named for
// notifications rather than issues on purpose: it is where anything needing a
// person's attention lands, so user-to-user paging or a finished update can
// join it later without a second bell. Issues are its first kind.
//
// Quiet when nothing is open: no count, no colour. A room's own issues also
// show on that room's pages; org-wide ones (Planning Center) live only here.
export function Notifications() {
  const issues = useOpenIssues() ?? [];
  const level = worst(issues);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const dismiss = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const label = issues.length ? `Notifications: ${issues.length} open` : 'Notifications';
  return (
    <div className="sidebar__notify" ref={ref}>
      <button
        className={`sidebar__toggle notify${level ? ` notify--${level}` : ''}`}
        aria-label={label}
        data-rail-label={label}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="sidebar__glyph" aria-hidden>
          <Bell size={17} className="sidebar__icon" />
          {issues.length > 0 && <span className="notify__count">{issues.length}</span>}
        </span>
        <span className="sidebar__label rail-hide">Notifications</span>
      </button>
      {open && (
        <div className="notifymenu" role="dialog" aria-label="Notifications">
          <p className="notifymenu__title">Notifications</p>
          {issues.length ? (
            <ul className="issuelist">
              {issues.map((i) => (
                <IssueRow
                  key={i.id}
                  issue={i}
                  withRoom
                  roomLink={i.roomIds.length === 1 ? `/room/${i.roomIds[0]}` : undefined}
                />
              ))}
            </ul>
          ) : (
            <p className="notifymenu__empty">All clear.</p>
          )}
        </div>
      )}
    </div>
  );
}
