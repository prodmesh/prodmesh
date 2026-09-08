# Testing strategy

Prodmesh uses two complementary test layers. Every feature should add coverage
at the lowest layer that can catch its likely regressions.

## Server tests

`npm run test:server` runs Node's built-in test runner against the API,
integrations, authorization rules, persistence, and coordination logic. Use
throwaway data directories and local fake servers; never depend on production
credentials or live church equipment.

**Every test server binds loopback, never the wildcard.** Start one with
`listenOnLoopback()` from `server/testServer.js` (or, for a `ws` fixture,
`{ host: '127.0.0.1', port: 0 }` plus an awaited `'listening'`) — never
`app.listen(0)`. `listen(0)` binds `::` and draws from the IPv6 ephemeral
space, which does not collide with the *specific* address `127.0.0.1:P`, so it
happily returns a port some unrelated daemon on the developer's machine is
already serving on IPv4 loopback — Dropbox, an Adobe helper, a stray `workerd`.
The test's own `fetch('http://127.0.0.1:P')` then lands in that process. This
was a real intermittent failure, and it is invisible in CI, where nothing else
is listening. `server/testServer.js` has the demonstration.

## Frontend tests

`npm run test:ui` runs Vitest + Testing Library in jsdom. These tests exercise
behavior visible to an operator: forms, permission states, navigation, dialogs,
and configuration-driven rendering. Mock the API boundary, not internal React
components. Prefer role- and label-based queries so tests also enforce basic
accessibility.

The initial regression suite protects:

- station registration and named-user login;
- account menu dismissal and lock confirmation;
- Planning Center avatars;
- Admin subnavigation;
- stable, unique dashboard configuration IDs and valid launcher targets.

## Commands and CI

- `npm test` runs both suites exactly as CI does.
- `npm run test:ui:watch` reruns frontend tests while developing.
- `npm run build` remains the TypeScript and production-bundle check.
- `npm run lint` runs static analysis.

New configurable settings should include: validation tests for accepted and
rejected values, a persistence/API test, and a frontend interaction test for the
admin control that edits them.
