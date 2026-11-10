// ─────────────────────────────────────────────────────────────────────────────
//  /api/v1  —  the frozen public surface (ADR 0013).
//
//  An ALLOWLIST, not a mirror. A /api/v1 that forwarded everything would make
//  all ~100 endpoints promises by accident, including the Admin UI's own,
//  whose shape should follow its screens. So /api/v1 serves exactly the
//  entries below; anything else under it is 404, never a proxy.
//
//  No handler changes: the routers declare full /api/… paths, and this
//  middleware rewrites /api/v1/x to /api/x after checking the list. The same
//  handler answers both, so v1 and the unversioned alias cannot drift.
//
//  THIS ARRAY IS THE CONTRACT. docs/API.md is checked against it by
//  apiV1.test.js, so the published list cannot drift from what is enforced.
//  Adding an entry is cheap and safe. Removing one, or changing what one
//  returns incompatibly, is a breaking change: it waits for a new prefix with
//  an overlap measured in releases, not weeks (ADR 0013, "Deprecation").
//
//  Two endpoints the ADR's first draft listed are deliberately absent:
//  - GET /rooms/:id/propresenter is gated on config.manage because one call
//    fans out five-plus requests to the machine running the service. The
//    `room:<id>:propresenter` stream topic carries the same state, cheaply
//    and shared, and is the integrator's way in.
//  - POST /rooms/:id/propresenter/control needs a stored dashboard widget a
//    token can never name (ADR 0013, "ProPresenter control is not in v1").
// ─────────────────────────────────────────────────────────────────────────────

/** `permission` is null for a read anyone may make. */
export const V1 = [
  // Read — the observation surface
  { method: 'GET', path: '/rooms', permission: null, summary: 'Every room: id, name, campus, and its modes' },
  { method: 'GET', path: '/rooms/:id', permission: null, summary: 'One room' },
  { method: 'GET', path: '/rooms/:id/state', permission: null, summary: "The room's current mode, and whether a schedule lockout is active" },
  { method: 'GET', path: '/rooms/:id/show', permission: null, summary: "The room's show: whether one is running, the live item, timer and SPL" },
  { method: 'GET', path: '/rooms/:id/service', permission: null, summary: "The room's upcoming Planning Center plans" },
  { method: 'GET', path: '/services', permission: null, summary: 'Upcoming services across every room' },
  { method: 'GET', path: '/rooms/:id/plan/:planId', permission: null, summary: 'One plan: times, items, people' },
  { method: 'GET', path: '/rooms/:id/plan/:planId/report', permission: null, summary: "A show's report: planned vs actual timing and loudness" },
  { method: 'GET', path: '/history', permission: 'reports.view', summary: 'Every recorded show' },
  { method: 'GET', path: '/calendar', permission: null, summary: 'Planning Center Calendar bookings (?start=&end= ISO dates)' },
  { method: 'GET', path: '/about', permission: null, summary: 'Product name and version' },
  { method: 'GET', path: '/system/version', permission: null, summary: 'Version, commit and how this install updates' },
  { method: 'GET', path: '/system/health', permission: null, summary: "Each integration's reachability" },
  { method: 'GET', path: '/stream', permission: null, summary: 'Server-sent events for ?topics=room:<id>:show,… — see Topics' },

  // Write — the control surface
  { method: 'POST', path: '/rooms/:id/mode', permission: 'rooms.mode.change', summary: 'Change the room mode ({ mode, overridePin? })' },
  { method: 'POST', path: '/rooms/:id/show/start', permission: 'shows.operate', summary: "Start a show ({ planId?, timeId?, rehearsal? }); no planId starts the room's current service" },
  { method: 'POST', path: '/rooms/:id/show/end', permission: 'shows.operate', summary: 'End the running show' },
  { method: 'POST', path: '/rooms/:id/show/current', permission: 'shows.operate', summary: 'Jump to an item, or resume following ProPresenter ({ itemId?, follow? })' },
  { method: 'POST', path: '/rooms/:id/event/:planId/checklist/:itemId', permission: 'checklists.complete', summary: 'Tick or untick a checklist item ({ done, overridePin? })' },
];

const PREFIX = '/api/v1';

// A path parameter matches one segment. Compiled once; the list is static.
const compiled = V1.map((entry) => ({
  ...entry,
  re: new RegExp(`^${entry.path.replace(/:[A-Za-z]+/g, '[^/]+')}/?$`),
}));

/** The v1 entry for `method` + a path relative to /api/v1, or null. */
export function matchV1(method, path) {
  // HEAD is answered by the GET handler (Express does this for every route),
  // so it is allowed wherever GET is.
  const m = method === 'HEAD' ? 'GET' : method;
  return compiled.find((entry) => entry.method === m && entry.re.test(path)) ?? null;
}

export function apiV1(req, res, next) {
  const url = req.url;
  if (url !== PREFIX && !url.startsWith(`${PREFIX}/`) && !url.startsWith(`${PREFIX}?`)) return next();
  const rest = url.slice(PREFIX.length);
  const path = rest.split('?')[0] || '/';

  if (!matchV1(req.method, path)) {
    // Right path, wrong method gets a 405 that says which methods exist, so an
    // integrator who sent GET to a write learns what to send instead.
    const allowed = compiled.filter((entry) => entry.re.test(path)).map((entry) => entry.method);
    if (allowed.length) {
      res.set('Allow', [...new Set(allowed)].join(', '));
      return res.status(405).json({ error: 'method_not_allowed', allowed });
    }
    return res.status(404).json({ error: 'not_in_v1', path: `${PREFIX}${path}` });
  }

  req.apiVersion = 1;
  req.url = `/api${rest}`;
  next();
}
