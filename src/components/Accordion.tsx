import { useEffect, useId, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * A collapsible panel for the room console. Pages stack these so a production
 * computer can sit on the room page all day: whatever is relevant right now is
 * open, everything else is one click away rather than gone.
 *
 * `summary` renders in the header and is the whole point of collapsing — a
 * closed panel must still answer its own question (which mode is the room in?)
 * without being opened.
 *
 * `defaultOpen` is re-applied whenever it CHANGES, so a panel can follow room
 * state (Room Mode opens itself when the room drops to Standby) while still
 * honouring a manual toggle in between.
 */
export function Accordion({
  title,
  summary,
  defaultOpen = false,
  className,
  children,
}: {
  title: ReactNode;
  summary?: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();

  // Follow the derived default when it flips, without fighting manual toggles
  // in between (this effect only runs when defaultOpen itself changes).
  useEffect(() => {
    setOpen(defaultOpen);
  }, [defaultOpen]);

  const cls = ['acc', open && 'acc--open', className].filter(Boolean).join(' ');
  return (
    <section className={cls}>
      <button
        type="button"
        className="acc__head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={bodyId}
      >
        <ChevronDown className="acc__chev" size={18} aria-hidden />
        <span className="acc__title">{title}</span>
        {summary != null && <span className="acc__summary">{summary}</span>}
      </button>
      {open && (
        <div className="acc__body" id={bodyId}>
          {children}
        </div>
      )}
    </section>
  );
}
