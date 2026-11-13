import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { arriveWithPass, markVisiting, setToken } from '../api';

// Arriving from a linked server (ADR 0018).
//
// The other server's Open sends the browser to /visit#pass=…&to=/room/x. The
// pass is in the fragment so it is never in a request line, a log or a
// Referer; this page reads it, removes it from the address bar and history
// at once, and trades it for a session here. An anonymous Open arrives with
// no pass and is simply passed through, still marked as visiting so the
// shell does not ask this browser to register as one of our stations.

/** Only a plain path on this server: never another origin. */
function landing(to: string | null) {
  return to && /^\/(?!\/)[A-Za-z0-9/_.~-]{0,200}$/.test(to) ? to : '/';
}

export function Visit() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [to, setTo] = useState('/');
  const once = useRef(false);

  useEffect(() => {
    if (once.current) return; // StrictMode runs effects twice; a pass works once
    once.current = true;
    const params = new URLSearchParams(window.location.hash.slice(1));
    const pass = params.get('pass');
    const dest = landing(params.get('to'));
    setTo(dest);
    window.history.replaceState(null, '', '/visit');
    markVisiting();
    if (!pass) {
      navigate(dest, { replace: true });
      return;
    }
    arriveWithPass(pass)
      .then(({ token }) => {
        setToken(token);
        navigate(dest, { replace: true });
      })
      .catch((err: Error) => setError(err.message));
  }, [navigate]);

  return (
    <div className="visit">
      <div className="visit__card">
        {error ? (
          <>
            <p className="eyebrow">Couldn’t sign you in</p>
            <p className="visit__text">{error}</p>
            <Link className="btn btn--primary" to={to} replace>Continue without signing in</Link>
          </>
        ) : (
          <p className="visit__text">Signing you in…</p>
        )}
      </div>
    </div>
  );
}
