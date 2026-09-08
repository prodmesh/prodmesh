import { useEffect, useId, type ReactNode } from 'react';
import { HelpTip } from '../HelpTip';

// ─────────────────────────────────────────────────────────────────────────────
//  A modal for editing one thing.
//
//  The room configuration page used to be every editor open at once, each with
//  its own Save button — "save buttons everywhere", in the maintainer's words.
//  Now the page is read-only summaries and this is where editing happens: one
//  form, one Save, and the page behind it cannot be half-edited.
//
//  It takes the same `form` contract EditorSection does (useDraft, or anything
//  shaped like it), so the editors moved in here without their bodies
//  changing. Save resolves the form's submit and closes only if it stuck —
//  an error stays on screen with the fields that caused it.
// ─────────────────────────────────────────────────────────────────────────────

export interface DialogForm {
  dirty: boolean;
  busy: boolean;
  err: string;
  submit: () => Promise<boolean>;
}

export function EditDialog({ title, help, form, onClose, saveLabel = 'Save', wide = false, children }: {
  title: ReactNode;
  help?: string;
  form: DialogForm;
  onClose: () => void;
  /** "Create" reads better than "Save" on a dialog that is making something. */
  saveLabel?: string;
  /** Rows of many fields (Companion's modes) need the room. */
  wide?: boolean;
  children: ReactNode;
}) {
  const titleId = useId();

  // Escape closes a CLEAN dialog only. With edits in it, the button is right
  // there and says what it does; losing ten minutes of mode buttons to a
  // reflex keypress is the failure mode worth a small inconsistency.
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !form.dirty && !form.busy) onClose();
    };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [form.dirty, form.busy, onClose]);

  const save = async () => {
    if (await form.submit()) onClose();
  };

  return (
    <div className="confirm" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className={`confirm__card editdlg${wide ? ' editdlg--wide' : ''}`}>
        <h3 id={titleId} className="editdlg__title">
          {title}
          {help && <HelpTip text={help} place="below" />}
        </h3>

        <div className="editdlg__body">{children}</div>

        {form.err && <p className="fsection__error">{form.err}</p>}

        <div className="editdlg__footer">
          {/* Named for what it does to the edits, which is the one thing a
              person deciding between the two buttons needs to know. */}
          <button type="button" className="btn" onClick={onClose} disabled={form.busy}>
            {form.dirty ? 'Discard changes' : 'Close'}
          </button>
          <button type="button" className="btn btn--primary" onClick={save} disabled={!form.dirty || form.busy}>
            {form.busy ? 'Saving…' : saveLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
