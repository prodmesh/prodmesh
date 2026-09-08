import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { CircleUser, X } from 'lucide-react';
import { searchPlanningCenterPeople, type PlanningCenterPerson } from '../api';
import { HelpTip } from './HelpTip';

// Picks the Planning Center person a prodmesh login belongs to. Typing a name
// beats copying a nine-digit id out of a browser URL, which is what this
// replaced — and a mistyped id links an account to a stranger's photo.
//
// The hand-typed id stays reachable either way — as the whole control when no
// token is connected, and as an extra row when one is. Creating users must
// never depend on an integration being set up, or being up.

const DEBOUNCE_MS = 250;
const MIN_QUERY = 2; // matches the server's floor — one letter is everybody

type Status = 'idle' | 'searching' | 'error';

/** A hand-typed ID was never looked up, so there is no name to show — say that
 *  rather than dressing the row up as a confirmed person. */
const identity = (person: PlanningCenterPerson) => (person.name
  ? { title: person.name, sub: `PCO ${person.id}${person.inactive ? ' · Inactive' : ''}` }
  : { title: `PCO ${person.id}`, sub: 'Name not checked' });

export function PersonPicker({ value, onChange }: { value: string; onChange: (personId: string) => void }) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState<PlanningCenterPerson[]>([]);
  const [status, setStatus] = useState<Status>('idle');
  const [active, setActive] = useState(0);
  const [picked, setPicked] = useState<PlanningCenterPerson | null>(null);
  const [focused, setFocused] = useState(false);
  const seq = useRef(0);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [anchor, setAnchor] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);

  // Whether search exists at all decides which control this is, so it can't
  // wait for the first keystroke. Any failure — no token, no permission, no
  // server — lands on hand-typed entry, which always works.
  useEffect(() => {
    let cancelled = false;
    searchPlanningCenterPeople('')
      .then((res) => { if (!cancelled) setConfigured(res.configured); })
      .catch(() => { if (!cancelled) setConfigured(false); });
    return () => { cancelled = true; };
  }, []);

  // Computed up here with the other hooks, because the anchoring effect below
  // needs it and hooks cannot sit after this component's early returns.
  const open = focused && query.trim().length >= MIN_QUERY;

  /**
   * Keep the floating list glued to the input.
   *
   * `scroll` is captured rather than bubbled: the thing that moves the input is
   * usually an ancestor scrolling — a dialog body — and scroll events do not
   * bubble to window from those. Without capture the list stays where it was
   * while the field slides away underneath it.
   *
   * The height is whatever is left below the input, so a list near the bottom
   * of a short window scrolls itself instead of running off the screen.
   */
  useLayoutEffect(() => {
    if (!open) { setAnchor(null); return; }
    const place = () => {
      const r = inputRef.current?.getBoundingClientRect();
      if (!r) return;
      setAnchor({
        top: r.bottom + 4,
        left: r.left,
        width: r.width,
        maxHeight: Math.max(96, Math.min(244, window.innerHeight - r.bottom - 16)),
      });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open]);

  // The parent clears the field after it creates a user.
  useEffect(() => { if (!value) setPicked(null); }, [value]);

  useEffect(() => {
    const q = query.trim();
    if (!configured || picked || q.length < MIN_QUERY) {
      setPeople([]);
      setStatus('idle');
      return;
    }
    const mine = ++seq.current;
    setStatus('searching');
    const timer = setTimeout(() => {
      searchPlanningCenterPeople(q)
        .then((res) => {
          if (mine !== seq.current) return; // a later keystroke owns the list now
          setPeople(res.people);
          setActive(0);
          setStatus('idle');
        })
        .catch(() => {
          if (mine !== seq.current) return;
          setPeople([]);
          setStatus('error');
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, configured, picked]);

  const choose = (person: PlanningCenterPerson) => {
    setPicked(person);
    setQuery('');
    setPeople([]);
    onChange(person.id);
  };

  const clear = () => {
    setPicked(null);
    setQuery('');
    onChange('');
  };

  // Typing the number itself still works with a token connected: it's the only
  // way through when the search is down or a name is spelled unexpectedly, and
  // an admin who already has the ID shouldn't have to search for a name to
  // reach it. Unnamed on purpose — nothing here has confirmed who it belongs to.
  const typedId = /^[0-9]{3,}$/.test(query.trim()) ? query.trim() : null;
  const options: PlanningCenterPerson[] = typedId && !people.some((p) => p.id === typedId)
    ? [...people, { id: typedId, name: '', avatarUrl: null }]
    : people;

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') return setPeople([]);
    if (!options.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((i) => (i + 1) % options.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => (i - 1 + options.length) % options.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(options[Math.min(active, options.length - 1)]);
    }
  };

  const label = (
    <span className="personpicker__label" id={`${listId}-label`}>
      Planning Center person
      <HelpTip text={configured === false
        ? 'The number at the end of a person\'s Planning Center profile URL. Connect Planning Center under Integrations to search by name instead.'
        : 'Optional. Links this login to their Planning Center profile, so their photo appears when they sign in. Typing a person ID links it directly.'} />
    </span>
  );

  if (picked) {
    return (
      <div className="personpicker">
        {label}
        <div className="personpicker__picked">
          <span className="personpicker__avatar" aria-hidden>
            {picked.avatarUrl ? <img src={picked.avatarUrl} alt="" /> : <CircleUser size={22} />}
          </span>
          <span className="personpicker__who">
            <strong>{identity(picked).title}</strong>
            <small>{identity(picked).sub}</small>
          </span>
          <button type="button" className="personpicker__clear" onClick={clear}
            aria-label={`Unlink ${identity(picked).title}`}>
            <X size={16} />
          </button>
        </div>
      </div>
    );
  }

  // No token: the id itself, as before.
  if (configured === false) {
    return (
      <div className="personpicker">
        {label}
        <input className="field" placeholder="Person ID (optional)" inputMode="numeric"
          aria-labelledby={`${listId}-label`}
          value={value} onChange={(event) => onChange(event.target.value)} />
      </div>
    );
  }



  return (
    <div className="personpicker">
      {label}
      <input
        ref={inputRef}
        className="field"
        placeholder={configured === null ? 'Loading…' : 'Search by name (optional)'}
        disabled={configured === null}
        role="combobox"
        aria-labelledby={`${listId}-label`}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && options.length ? `${listId}-${active}` : undefined}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={onKeyDown}
      />
      {open && anchor && createPortal(
        // Rendered into <body> rather than beside the input, and positioned
        // against the input's own rect. Inside a dialog the picker sits in a
        // scroll container, which clips an absolutely-positioned child at its
        // edge — the list came out cut in half. Putting it in the flow instead
        // fixed the clipping and made the dialog grow every time somebody
        // typed, which is worse. A select menu floats; so does this.
        //
        // mousedown default is what blurs the input, and blur closes this list
        // before a click can land on the row underneath.
        <ul className="personpicker__results personpicker__results--floating" id={listId} role="listbox"
          style={{ top: anchor.top, left: anchor.left, width: anchor.width, maxHeight: anchor.maxHeight }}
          onMouseDown={(event) => event.preventDefault()}>
          {status === 'searching' && <li className="personpicker__note" role="presentation">Searching…</li>}
          {status === 'error' && (
            <li className="personpicker__note personpicker__note--err" role="presentation">
              Planning Center didn’t answer. Try again, or enter the ID by hand.
            </li>
          )}
          {status === 'idle' && options.length === 0 && (
            <li className="personpicker__note" role="presentation">No matches.</li>
          )}
          {/* The li IS the option: a listbox's children have to be options,
              and focus stays on the input (aria-activedescendant). */}
          {options.map((person, index) => (
            <li key={person.id} id={`${listId}-${index}`} role="option" aria-selected={index === active}
              className={`personpicker__option${index === active ? ' is-active' : ''}`}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(person)}>
              <span className="personpicker__avatar" aria-hidden>
                {person.avatarUrl ? <img src={person.avatarUrl} alt="" /> : <CircleUser size={22} />}
              </span>
              <span className="personpicker__who">
                <strong>{identity(person).title}</strong>
                <small>{identity(person).sub}</small>
              </span>
            </li>
          ))}
        </ul>,
        document.body,
      )}
    </div>
  );
}
