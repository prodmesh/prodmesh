// ─────────────────────────────────────────────────────────────────────────────
//  ROOM SEEDS  (fresh-install defaults only — nothing here is live config)
//
//  The live rooms map is built by roomsStore.js from SQLite: identity comes
//  from the site_rooms topology table (Admin → Campuses) and integration
//  config from room_connectivity (the room configuration page). Entries here
//  are consulted exactly twice:
//    • first boot: connectivity.js seeds room_connectivity from the entry
//      whose id matches a topology room, so upgrades keep behaving identically
//    • the PRODMESH_LOCAL_TEST dev fixture (devFixture: true), which is a
//      real room on dev machines without living in the DB topology
//
//  Each room maps to a Companion install and a set of MODES. Selecting a mode
//  presses a Companion button (page/row/column). The room's current mode is read
//  from a Companion CUSTOM VARIABLE and matched (case-insensitively) against each
//  mode's `match` value.
//
//  A room has Companion configured when it has a host; without one it has no
//  rooms to show any Companion data, and the UI says exactly that. Modes are
//  the operator's mapping of the building's own Companion buttons — nothing
//  here is invented for the screens' sake.
// ─────────────────────────────────────────────────────────────────────────────

// Standard mode set. `match` = the roomState value that means this mode is active
// (compared case-insensitively). `press` = the Companion button location.
// Also the default mode set for rooms created in Admin → Campuses (roomsStore).
export function standardModes({ page = 1, row = 3 } = {}) {
  return [
    { id: 'sunday', label: 'Sunday', color: '#34c759', match: 'SUNDAY', press: { page, row, column: 1 } },
    { id: 'midweek', label: 'Mid-Week', color: '#5b8def', match: 'MIDWEEK', press: { page, row, column: 2 } },
    { id: 'special', label: 'Special Event', color: '#af7bf0', match: 'EVENT', press: { page, row, column: 3 } },
    { id: 'standby', label: 'Standby', color: '#8b97a8', match: 'STANDBY', press: { page, row, column: 4 }, isStandby: true },
  ];
}

// Build a single mode. `match` = the roomState value (case-insensitive) that
// means this mode is active; `loc` = [page, row, column] of the Companion button.
function mode(id, label, color, match, [page, row, column], extra = {}) {
  return { id, label, color, match, press: { page, row, column }, ...extra };
}

// The dev fixture room. Opt-in via PRODMESH_LOCAL_TEST=1 (the npm dev scripts
// set it) so production deployments never show it.
const localTest = {
  // ── Local test against the Companion running on THIS machine ────────────────
  'local-test': {
    id: 'local-test',
    name: 'Local Test (this Mac)',
    site: 'north',
    devFixture: true, // exists as a room without a site_rooms topology row
    companion: { host: '127.0.0.1', port: 8000 },
    state: { variable: 'roomState' },
    // Planning Center service type(s) whose plans feed this room. A room can
    // host several (the soonest upcoming plan across them is shown).
    planningCenter: { serviceTypes: [{ id: '500001', name: 'Sunday' }] }, // live demo
    // ProPresenter API (official 7.9+). Port is per-machine (PP picks it).
    // Optional `timer: '<name>'` picks the service-start countdown timer;
    // without it, the first count-down-to-time timer is used.
    // Fresh-install seed only — after first boot this lives in SQLite
    // (room_connectivity) and is edited on the room configuration page.
    proPresenter: { host: '127.0.0.1', port: 62202 },
    // Analysis source (SPL) — mock meter for dev (no analyzer on this machine).
    // target/limit in dB: our Sundays target 90, not to exceed 95.
    analysis: { mock: true, target: 90, limit: 95 },
    // YouTube Live viewers — mock for dev, for the same reason as the meter
    // above: no broadcast on this machine. Deliberately the ONLY way to get
    // simulated viewer numbers, since they are persisted into show reports
    // and a fabricated attendance figure is worse than a blank one.
    youtube: { mock: true },
    modes: standardModes(),
  },
};

export const rooms = {
  ...(process.env.PRODMESH_LOCAL_TEST === '1' ? localTest : {}),

  'north-main': {
    id: 'north-main',
    name: 'North Campus · Main Auditorium',
    site: 'north',
    companion: { host: '192.0.2.10', port: 8000 }, // the producer machine
    state: { variable: 'roomState' },
    planningCenter: {
      serviceTypes: [
        { id: '500001', name: 'Sunday' },
        { id: '500002', name: 'Second Service' },
        { id: '500003', name: 'Midweek' },
        { id: '500004', name: 'Evening' },
        // "Special Events" (265639) intentionally omitted: its plans aren't
        // reliably in this room. Add once Calendar can confirm room (see ADR 0001).
      ],
    },
    // Fresh-install seed only — after first boot the database owns this.
    // The room's ProPresenter Mac. Port is a guess by nature: PP picks an ephemeral API
    // port per machine and can change it across restarts unless pinned in its
    // Network preferences. Observed 1025 on-site 2026-07-24; the DB value is
    // what actually runs, so fix it there (Admin → Campuses), not here.
    proPresenter: { host: '192.0.2.15', port: 1025 },
    // Analysis source (SPL) — Smaart on the FOH Mac ("FOH-Soundgrid"), Smaart
    // v8 8.5.2.2, API v3 (the transport negotiates the path automatically;
    // verified live 2026-07-14). `source: 'rta'` points at a ProdMesh Remote
    // RTA instead. Optional (Smaart): password, device/channel, metric,
    // apiPath. Optional (RTA): metric (a metric id like 'leqS').
    analysis: { source: 'smaart', host: '192.0.2.40', port: 26000, target: 90, limit: 95 },
    // Auditorium-specific modes. Button locations [page, row, column].
    modes: [
      mode('sunday', 'Sunday', '#34c759', 'SUNDAY', [3, 0, 1]),
      mode('second', 'Second Service', '#ff9f0a', 'SECOND', [3, 0, 2]),
      mode('midweek', 'Midweek', '#ff6fae', 'MIDWEEK', [3, 0, 3]),
      mode('evening', 'Evening', '#32ade6', 'EVENING', [3, 0, 4]),
      mode('event', 'Event', '#af7bf0', 'EVENT', [3, 0, 5]),
      mode('standby', 'Standby', '#8b97a8', 'STANDBY', [3, 3, 1], { isStandby: true }),
    ],
  },

  'north-youth': {
    id: 'north-youth',
    name: 'North Campus · Youth Room',
    site: 'north',
    // Companion exists on the lighting machine, but its real buttons are
    // unknown — no modes until the room's Companion has them. Fresh-install
    // seed only; after first boot this lives in SQLite.
    companion: { host: '192.0.2.22', port: 8000 }, // Lighting machine
    planningCenter: { serviceTypes: [{ id: '500005', name: 'Youth Service' }] },
    modes: [],
  },

  'north-chapel': {
    id: 'north-chapel',
    name: 'North Campus · Chapel',
    site: 'north',
    companion: { host: '192.0.2.18', port: 8000 }, // the chapel's ProPresenter machine
    planningCenter: { serviceTypes: [{ id: '500006', name: 'Chapel Service' }] },
    modes: [],
  },
};
