// Core data model for the production dashboard.
//
// The whole UI is driven by this shape. It is served by GET /api/config
// (server-owned in SQLite per ADR 0009) and edited in Admin → Campuses —
// adding a site, auditorium, or tile is an Admin action, never a code change.
//
// To add a NEW kind of tile (a future "module"): add a variant to the `Tile`
// union below, register a renderer in src/tiles/registry.tsx, and teach
// server/validate.js validateChurch about its fields. That's the modularity
// guarantee.

export type SiteStatus = 'active' | 'disabled';

export interface Church {
  name: string;
  sites: Site[];
}

export interface Site {
  timezone?: string;
  id: string;
  name: string;
  status: SiteStatus;
  auditoriums: Auditorium[];
}

export interface Auditorium {
  id: string;
  name: string;
  tiles: Tile[];
}

/** Fields shared by every tile type. */
interface TileBase {
  id: string;
  label: string;
  /** Optional small caption under the label. */
  note?: string;
  /** Optional emoji to override the tile type's default icon. */
  icon?: string;
}

/** Opens the Bitfocus Companion web UI for a machine. */
export interface CompanionTile extends TileBase {
  type: 'companion';
  /** IP or hostname of the Companion install. */
  host: string;
  /** Companion web port (defaults to 8000). */
  port?: number;
  /**
   * Which Companion page to open:
   *  - 'admin'       → the config/admin UI (default)
   *  - 'tablet'      → the touch/web-buttons view
   *  - 'emulator'    → the stream-deck emulator
   */
  view?: 'admin' | 'tablet' | 'emulator';
}

/** Opens macOS Screen Sharing.app to a specific Mac via a vnc:// link. */
export interface ScreenShareTile extends TileBase {
  type: 'screenshare';
  /** IP or hostname of the target Mac. */
  host: string;
  /** Optional login user; prefills Screen Sharing as vnc://user@host. */
  username?: string;
}

/** A generic external link (NDI tools, web apps, docs, etc.). */
export interface LinkTile extends TileBase {
  type: 'link';
  url: string;
}

/** Navigates to an internal page in this app (e.g. a room Status screen). */
export interface RouteTile extends TileBase {
  type: 'route';
  to: string;
}

/** A non-clickable placeholder for resources not configured yet. */
export interface PlaceholderTile extends TileBase {
  type: 'placeholder';
}

export type Tile =
  | CompanionTile
  | ScreenShareTile
  | LinkTile
  | RouteTile
  | PlaceholderTile;
