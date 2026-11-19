import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { getAuthStatus, getView, type AuthStatus, type View } from '../api';
import { ViewCanvas } from '../views/ViewCanvas';
import { useQuery, invalidate } from '../lib/useQuery';
import { useTopic } from '../lib/stream';
import { viewKey } from '../lib/keys';
import { gridFor } from '../lib/gridLayout';

// ─────────────────────────────────────────────────────────────────────────────
//  A display: one view, full screen, nothing else.
//
//  Deliberately OUTSIDE AppShell — no sidebar, no nav, no account menu. This
//  is not a page someone browses; it is what a Raspberry Pi wired into an ATEM
//  input shows for months at a time. /setup is the same shape and the only
//  other route that lives out here.
//
//  It is also read-only by construction rather than by promise: the widget
//  registry refuses to put an interactive widget on a display (see
//  server/validate.js), so there is nothing here to press even if someone
//  plugged in a mouse.
// ─────────────────────────────────────────────────────────────────────────────

export function DisplayView() {
  // `key` is a slug OR an id. A station stores the id, a human types the slug,
  // and renaming a view must not blank a screen nobody can reach.
  const { roomId = '', key = '' } = useParams();

  const viewQ = useQuery(viewKey(roomId, key), () => getView(roomId, key), { staleMs: 60_000 });
  const view: View | null = viewQ.data?.view ?? null;

  // Pushed, not polled. A layout edited in the booth has to reach a screen
  // with no keyboard and nobody standing at it — and the alternative, a poll
  // fast enough to feel immediate, would be a request every few seconds from
  // every screen in the building, forever.
  const pushed = useTopic<unknown>(roomId ? `room:${roomId}:views` : null);
  useEffect(() => {
    if (pushed) invalidate(viewKey(roomId, key));
  }, [pushed, roomId, key]);

  // ── Following its station (#63) ────────────────────────────────────────────
  //  A display station goes where Admin → Stations sends it, without anyone at
  //  the screen. The station topic says only "you were changed"; who this
  //  station is and what it shows is re-read over its own cookie. A views push
  //  re-reads it too, since deleting a display unassigns it.
  const navigate = useNavigate();
  const [identity, setIdentity] = useState<AuthStatus | null>(null);
  const stationId = identity?.station?.id ?? null;
  const stationPush = useTopic<unknown>(stationId ? `station:${stationId}` : null);
  useEffect(() => {
    let live = true;
    getAuthStatus().then((s) => { if (live) setIdentity(s); }).catch(() => {});
    return () => { live = false; };
  }, [stationPush, pushed]);

  // Only a screen that has BEEN a display station is ever moved. Someone who
  // opens a display's address on their laptop to check it is left alone.
  const wasDisplay = useRef(false);
  useEffect(() => {
    // Logged in is a person at the screen, and they go where they choose.
    if (!identity || identity.authenticated) return;
    const station = identity.station;
    const assigned = station?.roomId && station.viewSlug ? station : null;
    if (assigned) {
      wasDisplay.current = true;
      // Already showing it — by slug, or by id where a station's own link
      // outlived a rename.
      const here = assigned.roomId === roomId &&
        (key === assigned.viewSlug || key === assigned.viewId || (view != null && view.id === assigned.viewId));
      if (!here) navigate(`/display/${assigned.roomId}/${assigned.viewSlug}`, { replace: true });
    } else if (wasDisplay.current) {
      // Unassigned or revoked: the shell decides what this browser is now —
      // its room, or the registration prompt.
      navigate('/', { replace: true });
    }
  }, [identity, roomId, key, view, navigate]);

  const grid = view ? gridFor(view.kind) : null;

  // No spinner and no error card. A screen on a wall showing "Loading…" or a
  // stack trace is worse than a screen showing nothing — nobody is there to
  // read it, and it will still be there next Sunday. Black is a fault someone
  // notices; a message is one they stop seeing.
  if (!view || !grid) return <div className="display display--blank" />;

  // `zoom`, not transform: it scales the LAYOUT, so the grid still fills the
  // screen exactly and simply has fewer CSS pixels to fill it with. A
  // transform would render at the old size and then overflow the viewport.
  return (
    <div className="display" style={{ zoom: view.scale > 1 ? view.scale : undefined }}>
      <ViewCanvas view={view} grid={grid} config={{}} />
    </div>
  );
}
