import { useState } from 'react';
import { changeOwnPin } from '../api';
import { PasswordInput } from './PasswordInput';

/**
 * Self-service PIN change, reachable by anyone signed in — it needs no
 * authority beyond being the account.
 *
 * The current PIN is asked for even though the session already proves someone
 * is signed in, because on a booth machine those are different claims: the
 * browser being logged in is the normal state of that machine all Sunday, and
 * whoever walks up to it is not necessarily the account holder.
 *
 * Succeeding signs everybody out, this browser included — the credential moved,
 * so its sessions go with it. That is stated up front rather than sprung
 * afterwards, when it would read as the change having gone wrong.
 */
export function ChangePinDialog({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const mismatch = confirmPin.length > 0 && newPin !== confirmPin;
  const ready = currentPin.length >= 4 && newPin.length >= 4 && newPin === confirmPin;

  const submit = async () => {
    setBusy(true); setError('');
    try {
      await changeOwnPin(currentPin, newPin);
      onChanged();
    } catch (err) {
      // The server distinguishes a wrong current PIN from a rejected new one,
      // and so must this: "try again" is useless if you cannot tell which end
      // was wrong.
      const message = String((err as Error).message ?? err);
      setError(
        message.includes('current_pin_incorrect') ? 'That is not your current PIN.'
          : message.includes('temporarily_locked') ? 'Too many attempts. Try again in a few minutes.'
            : message,
      );
      setBusy(false);
    }
  };

  return (
    <div className="identity__scrim" role="presentation" onClick={onClose}>
      <div className="identity" role="dialog" aria-modal="true" aria-labelledby="changepin-title" onClick={(e) => e.stopPropagation()}>
        <p className="eyebrow">Your account</p>
        <h2 id="changepin-title">Change your PIN</h2>
        <p className="identity__hint">
          You will be signed out everywhere once it changes, including here.
        </p>
        <label className="identity__field">
          <span>Current PIN</span>
          <PasswordInput className="field mono" inputMode="numeric" autoComplete="current-password"
            value={currentPin} onChange={(e) => setCurrentPin(e.target.value)} />
        </label>
        <label className="identity__field">
          <span>New PIN</span>
          <PasswordInput className="field mono" inputMode="numeric" autoComplete="new-password"
            value={newPin} onChange={(e) => setNewPin(e.target.value)} />
        </label>
        <label className="identity__field">
          <span>Confirm new PIN</span>
          <PasswordInput className="field mono" inputMode="numeric" autoComplete="new-password"
            value={confirmPin} onChange={(e) => setConfirmPin(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && ready && submit()} />
        </label>
        {mismatch && <p className="identity__error">The two new PINs do not match.</p>}
        <button className="btn btn--primary identity__submit" disabled={busy || !ready} onClick={submit}>
          Change PIN
        </button>
        {error && <p className="identity__error">{error}</p>}
      </div>
    </div>
  );
}
