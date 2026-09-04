// Frontend client for the dashboard backend (which proxies to Companion).

import type { Church } from './types';
// The row shape lives with the widget that renders it; this file mirrors the
// server's stored config, and a hand-kept second copy of a nested shape is the
// kind of duplicate that drifts silently.
import type { CompanionVariableRow } from './widgets/types';

export interface RoomMode {
  id: string;
  label: string;
  color: string;
  isStandby: boolean;
}

export interface RoomMeta {
  id: string;
  name: string;
  site: string | null;
  hasCompanion: boolean;
  analysisSource?: AnalysisSource | null;
  modes: RoomMode[];
}

export interface Protection {
  active: boolean;
  label: string | null;
  lockedModes: string[];
  enforced: boolean;
}

export interface RoomState {
  mode: string | null;
  raw: string;
  online: boolean;
  source: 'companion' | 'mock';
  protection: Protection;
  error?: string;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: requestHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export const getRoom = (id: string) =>
  getJson<RoomMeta>(`/api/rooms/${encodeURIComponent(id)}`);

export const getRooms = () => getJson<RoomMeta[]>('/api/rooms');

export const getRoomState = (id: string) =>
  getJson<RoomState>(`/api/rooms/${encodeURIComponent(id)}/state`);

export interface ProPresenterCue { index: number; number: number; thumbnailIndex?: number; text: string; note: string | null; section: string; color: string | null; }
export interface ProPresenterItem { index: number; title: string; presentationTitle?: string | null; presentationUuid: string | null; triggerable: boolean; placeholder: boolean; isPco: boolean; slides: ProPresenterCue[]; }
export interface ProPresenterState { full?: boolean; connected?: boolean; focusedPlaylist?: { name: string | null; items: ProPresenterItem[] }; runtime: { activePresentationUuid: string | null; activePlaylistIndex: number | null; activeCueIndex: number | null; activeCueNumber: number | null; totalCues: number | null; timers: Array<{ uuid: string | null; name: string; state: string; remainingSeconds: number | null }>; video: { name: string | null; seconds: number | null; duration: number } | null } | null; }

export async function proPresenterControl(roomId: string, input: { viewId?: string; widgetId?: string; action: 'previous' | 'next' | 'previous-item' | 'next-item' | 'presentation' | 'cue'; playlistIndex?: number; cueIndex?: number; presentationUuid?: string | null; isPco?: boolean }) {
  const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/propresenter/control`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...requestHeaders() }, body: JSON.stringify(input) });
  await requireOk(res);
}

/** Thrown when a mode change is locked and the override PIN was missing/wrong. */
export class OverrideRequiredError extends Error {
  constructor() {
    super('override_required');
    this.name = 'OverrideRequiredError';
  }
}

export async function setRoomMode(
  id: string,
  mode: string,
  overridePin?: string,
): Promise<RoomState> {
  const res = await fetch(`/api/rooms/${encodeURIComponent(id)}/mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...requestHeaders() },
    body: JSON.stringify({ mode, overridePin }),
  });
  if (res.status === 403) {
    const body = await res.clone().json().catch(() => ({}));
    if (body.error === 'override_required') throw new OverrideRequiredError();
  }
  await requireOk(res);
  return res.json() as Promise<RoomState>;
}

// ── Admin auth (bearer token in localStorage) ─────────────────────────────────

const TOKEN_KEY = 'pm_admin_token';
const STATION_KEY = 'pm_station_token';
export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t: string) => {
  localStorage.setItem(TOKEN_KEY, t);
  window.dispatchEvent(new Event('prodmesh:auth-changed'));
};
export const clearToken = () => {
  localStorage.removeItem(TOKEN_KEY);
  window.dispatchEvent(new Event('prodmesh:auth-changed'));
};

export const getStationToken = () => localStorage.getItem(STATION_KEY);
export const setStationToken = (token: string) => localStorage.setItem(STATION_KEY, token);
export const clearStationIdentity = () => {
  localStorage.removeItem(STATION_KEY);
  localStorage.removeItem(TOKEN_KEY);
  window.dispatchEvent(new Event('prodmesh:auth-changed'));
};

function requestHeaders(): Record<string, string> {
  const t = getToken();
  const station = getStationToken();
  return {
    ...(t ? { Authorization: `Bearer ${t}` } : {}),
    ...(station ? { 'X-Prodmesh-Station': station } : {}),
  };
}

/** Ask the shell to open the identity dialog, naming the missing authority.
 *  Also called by a page that knows up front it cannot act, so "Log in" is a
 *  button rather than something to work out. */
export function requestAuth(permission?: string, label?: string) {
  window.dispatchEvent(new CustomEvent('prodmesh:auth-required', { detail: { permission, label } }));
}

/**
 * A refusal for want of a permission, distinguishable from every other failure.
 *
 * It exists because callers must be able to say the true thing: `authenticated`
 * separates "log in to do this" (401 — nobody is logged in) from "your account
 * cannot do this" (403 — logged in, wrong permissions). Told apart only by
 * status code; a caller matching on the message cannot tell them apart at all.
 */
export class PermissionError extends Error {
  permission: string;
  label: string;
  authenticated: boolean;

  constructor(permission: string, label: string, authenticated: boolean) {
    super('permission_required');
    this.name = 'PermissionError';
    this.permission = permission;
    this.label = label;
    this.authenticated = authenticated;
  }
}

async function requireOk(res: Response) {
  if (res.status === 401 || res.status === 403) {
    const body = await res.clone().json().catch(() => ({}));
    if (body.error === 'permission_required') {
      requestAuth(body.permission, body.label);
      throw new PermissionError(body.permission, body.label ?? body.permission, res.status === 403);
    }
  }
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`);
}

/** Begin OAuth in an authenticated fetch, then hand the browser to Restream. */
export async function connectRestream() {
  const res = await fetch('/api/integrations/restream/connect', { method: 'POST', headers: requestHeaders() });
  await requireOk(res);
  const body = await res.json() as { url?: string };
  if (!body.url) throw new Error('ProdMesh did not receive a Restream authorization URL.');
  window.location.assign(body.url);
}

export const getRestreamConfig = () => getJson<{ redirectUrl: string }>('/api/integrations/restream/config');

export interface ResiStatus {
  connected: boolean;
  configured: boolean;
  live: boolean;
  health: 'healthy' | 'warning' | 'critical' | 'offline' | 'connection-lost';
  title: string;
  error?: string;
  playerUrl?: string | null;
  encoder?: { online?: boolean; name?: string };
  video?: string;
  audio?: string;
  destination?: string;
  startedAt?: string;
  viewers?: number;
  peakViewers?: number;
  totalViews?: number;
  averageWatchTime?: string;
  warnings?: string[];
  errors?: string[];
  capabilities: { player: boolean; viewers: boolean; telemetry: boolean };
}

export async function checkResiConnection() {
  const res = await fetch('/api/integrations/resi/check', { method: 'POST', headers: requestHeaders() });
  const body = await res.json().catch(() => null) as ResiStatus | null;
  if (!res.ok) throw new Error(body?.error ?? 'Resi could not be reached');
  return body!;
}

export interface ObsStatus {
  configured: boolean;
  connected: boolean;
  streaming: boolean;
  streamReconnecting?: boolean;
  recording: boolean;
  recordingPaused: boolean;
  streamDurationMs: number;
  recordDurationMs: number;
  activeFps: number | null;
  bitrateKbps: number | null;
  droppedFrames: number;
  droppedFramesPercent: number;
  droppedFramesWarning?: number;
  programScene: string | null;
  programSources: string[];
  audioDb: number | null;
  audioStatus: 'active' | 'no-signal';
  primaryAudioInput: string | null;
  sourceOptions: string[];
  cpuUsage: number | null;
  diskFreeGb: number | null;
  previewImageUrl: string | null;
  error?: string;
  disabled?: boolean;
}

export interface Station {
  id: string;
  name: string;
  campusId: string | null;
  roomId: string | null;
  /** Read-only mode (nobody logged in) browses only the assigned room. */
  roomOnly: boolean;
  /** A display this station renders full-screen. Null for an ordinary browser. */
  viewId?: string | null;
  viewSlug?: string | null;
}

export interface ManagedStation extends Station {
  createdAt: number;
  lastSeen: number;
  current: boolean;
  viewName?: string | null;
}

export interface CurrentUser {
  id: string;
  username: string;
  displayName: string;
  planningCenterPersonId: string | null;
  avatarUrl?: string | null;
}

export interface AuthStatus {
  authenticated: boolean;
  admin: boolean;
  setupNeeded: boolean;
  user: CurrentUser | null;
  permissions: string[];
  station: Station | null;
}

export const getAuthStatus = () =>
  fetch('/api/auth/status', { headers: requestHeaders() }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json() as Promise<AuthStatus>;
  });

export async function loginAdmin(pin: string): Promise<boolean> {
  const res = await fetch('/api/auth/admin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...requestHeaders() },
    body: JSON.stringify({ pin }),
  });
  if (!res.ok) return false;
  const { token } = await res.json();
  setToken(token);
  return true;
}

export async function logoutAdmin(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST', headers: requestHeaders() }).catch(() => {});
  clearToken();
}

export async function registerStation(input: { name: string; campusId?: string | null; roomId?: string | null }): Promise<Station> {
  const res = await fetch('/api/stations/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  await requireOk(res);
  const { station } = (await res.json()) as { station: Station & { token: string } };
  setStationToken(station.token);
  return station;
}

export const getStations = () => getJson<{ stations: ManagedStation[] }>('/api/stations');

export async function updateStation(
  stationId: string,
  input: {
    name: string;
    campusId: string | null;
    roomId: string | null;
    roomOnly: boolean;
    viewId?: string | null;
  },
): Promise<ManagedStation> {
  const res = await fetch(`/api/stations/${encodeURIComponent(stationId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...requestHeaders() },
    body: JSON.stringify(input),
  });
  await requireOk(res);
  const station = ((await res.json()) as { station: ManagedStation }).station;
  if (station.current) window.dispatchEvent(new Event('prodmesh:auth-changed'));
  return station;
}

export async function revokeStation(stationId: string): Promise<{ current: boolean }> {
  const res = await fetch(`/api/stations/${encodeURIComponent(stationId)}`, {
    method: 'DELETE',
    headers: requestHeaders(),
  });
  await requireOk(res);
  const result = (await res.json()) as { current: boolean };
  if (result.current) clearStationIdentity();
  return result;
}

export async function loginUser(username: string, pin: string): Promise<AuthStatus> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...requestHeaders() },
    body: JSON.stringify({ username, pin }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? 'Login failed');
  const { token } = await res.json();
  setToken(token);
  return getAuthStatus();
}

export interface PermissionGroup {
  id: string;
  name: string;
  systemKey: string | null;
  permissions: string[];
}

export interface ManagedUser extends CurrentUser {
  active: boolean;
  groups: PermissionGroup[];
  permissions: string[];
}

export interface UserDirectory {
  users: ManagedUser[];
  groups: PermissionGroup[];
  permissions: { id: string; label: string; description: string }[];
}

export const getUserDirectory = () => getJson<UserDirectory>('/api/users');

export interface PlanningCenterPerson {
  id: string;
  name: string;
  avatarUrl: string | null;
  /** Archived or inactive in Services — still linkable, but worth flagging. */
  inactive?: boolean;
}

/** Name search over Planning Center Services people. `configured: false` means
 *  no token is connected, so the person ID has to be entered by hand. */
export const searchPlanningCenterPeople = (query: string) =>
  getJson<{ configured: boolean; people: PlanningCenterPerson[] }>(
    `/api/planning-center/people?q=${encodeURIComponent(query)}`,
  );

export async function createUser(input: {
  username: string;
  displayName: string;
  pin: string;
  planningCenterPersonId?: string | null;
  groupIds: string[];
}): Promise<ManagedUser> {
  const res = await fetch('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...requestHeaders() },
    body: JSON.stringify(input),
  });
  await requireOk(res);
  return ((await res.json()) as { user: ManagedUser }).user;
}

export async function setUserGroups(userId: string, groupIds: string[]): Promise<ManagedUser> {
  const res = await fetch(`/api/users/${encodeURIComponent(userId)}/groups`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...requestHeaders() },
    body: JSON.stringify({ groupIds }),
  });
  await requireOk(res);
  return ((await res.json()) as { user: ManagedUser }).user;
}

export async function createGroup(name: string, permissions: string[]): Promise<PermissionGroup> {
  const res = await fetch('/api/groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...requestHeaders() },
    body: JSON.stringify({ name, permissions }),
  });
  await requireOk(res);
  return ((await res.json()) as { group: PermissionGroup }).group;
}

// ── Settings ──────────────────────────────────────────────────────────────────

export interface ScheduleWindow {
  id: string;
  label: string;
  days: number[];
  start: string;
  end: string;
  lock: string[];
}

export interface Settings {
  pins: { adminSet: boolean; overrideSet: boolean };
  schedules: Record<string, ScheduleWindow[]>;
}

export const getSettings = () =>
  fetch('/api/settings', { headers: requestHeaders() }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json() as Promise<Settings>;
  });

/** Set/clear PINs. Empty string clears; undefined leaves unchanged. Admin
 *  bootstrap (first admin PIN) works without a token. */
export async function setPins(pins: { admin?: string; override?: string }): Promise<void> {
  const res = await fetch('/api/settings/pins', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...requestHeaders() },
    body: JSON.stringify(pins),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function saveSchedules(
  schedules: Record<string, ScheduleWindow[]>,
): Promise<void> {
  const res = await fetch('/api/settings/schedules', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...requestHeaders() },
    body: JSON.stringify({ schedules }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// ── Checklist templates (per event type, edited in Admin) ────────────────────

export interface TemplateItem {
  id?: string; // omitted for new items — the server assigns a stable slug
  label: string;
  action?: { type: 'mode'; mode: string } | null;
}

export interface ChecklistTemplatesInfo {
  templates: Record<string, TemplateItem[]>; // keyed by service type id, '*' = default
  serviceTypes: { id: string; name: string }[];
  modes: { id: string; label: string }[];
}

export const getChecklistTemplates = () =>
  getJson<ChecklistTemplatesInfo>('/api/checklist-templates');

export async function saveChecklistTemplate(
  serviceTypeId: string,
  items: TemplateItem[],
): Promise<Record<string, TemplateItem[]>> {
  const res = await fetch(`/api/checklist-templates/${encodeURIComponent(serviceTypeId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...requestHeaders() },
    body: JSON.stringify({ items }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`);
  return ((await res.json()) as { templates: Record<string, TemplateItem[]> }).templates;
}

export async function deleteChecklistTemplate(
  serviceTypeId: string,
): Promise<Record<string, TemplateItem[]>> {
  const res = await fetch(`/api/checklist-templates/${encodeURIComponent(serviceTypeId)}`, {
    method: 'DELETE',
    headers: requestHeaders(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return ((await res.json()) as { templates: Record<string, TemplateItem[]> }).templates;
}

// ── System ────────────────────────────────────────────────────────────────────

export interface Version {
  /** Release version from package.json or the build stamp, e.g. "1.0.0". */
  version: string;
  commit: string;
  subject: string;
  /** Where commit/subject came from: a build stamp, git, or neither. */
  source: 'build' | 'git' | 'package';
  /** How this copy was installed — decides whether it can update itself. */
  deployment: 'git' | 'container' | 'package';
  update: {
    supported: boolean;
    strategy: 'git' | 'container' | 'manual';
    /** What to do instead, when the app can't update itself. */
    reason: string | null;
  };
}

export const getVersion = () => getJson<Version>('/api/system/version');

// Institution topology (name, sites, Quick Access tiles) — server-owned per
// ADR 0009; the Admin → Campuses editor saves the whole tree transactionally.
export const getConfig = () => getJson<Church>('/api/config');

// ── First-run setup ──────────────────────────────────────────────────────────

/** Whether the setup wizard still owns this install, and how far it got. */
export interface SetupState {
  needed: boolean;
  completedAt: number | null;
  adminPinSet: boolean;
  hasCampus: boolean;
}

export const getSetupState = () => getJson<SetupState>('/api/setup');

export async function completeSetup(): Promise<SetupState> {
  const res = await fetch('/api/setup/complete', { method: 'POST', headers: requestHeaders() });
  await requireOk(res);
  return res.json();
}

// ── Secrets (write-only) ─────────────────────────────────────────────────────

/** What is configured — deliberately never the credential itself. */
export interface SecretField {
  path: string;
  label: string;
  /** false = not a credential (a channel name), so `value` is populated. */
  secret: boolean;
  /** Stored for a feature that doesn't exist yet — excluded from `configured`. */
  optional: boolean;
  note: string | null;
  set: boolean;
  length: number;
  value: string | null;
  /** An env var is winning, so editing here would have no effect. */
  env: boolean;
}

/** One card per integration. */
export interface SecretGroup {
  id: string;
  label: string;
  hint: string;
  fields: SecretField[];
  configured: boolean;
}

export const getSecrets = () => getJson<{ secrets: SecretGroup[] }>('/api/secrets');

export async function saveSecrets(updates: Record<string, string>): Promise<{ secrets: SecretGroup[] }> {
  const res = await fetch('/api/secrets', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...requestHeaders() },
    body: JSON.stringify({ updates }),
  });
  await requireOk(res);
  return res.json();
}

/** Do the stored credentials actually work? null = not configured. */
export const checkIntegrations = () =>
  getJson<{ planningCenter: boolean | null; reason?: string }>('/api/secrets/check');

export type IntegrationEnabled = Record<string, boolean>;
export const getEnabledIntegrations = () => getJson<{ enabled: IntegrationEnabled }>('/api/integrations');
export async function setIntegrationEnabled(id: string, enabled: boolean) {
  const res = await fetch(`/api/settings/integrations/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', ...requestHeaders() }, body: JSON.stringify({ enabled }),
  });
  await requireOk(res);
  return res.json() as Promise<{ enabled: IntegrationEnabled }>;
}

// ── Branding ─────────────────────────────────────────────────────────────────

/** The institution's logo endpoint. 404s when no override is set, which is the
 *  signal to fall back to the bundled ProdMesh mark. The cache-buster makes a
 *  fresh upload appear without a reload. */
export const logoSrc = (stamp?: number | null) =>
  `/api/branding/logo${stamp ? `?v=${stamp}` : ''}`;

export interface LogoMeta {
  type: string;
  ext: string;
  bytes: number;
  updatedAt: number;
}

export async function uploadLogo(file: File): Promise<LogoMeta> {
  // Raw bytes, not multipart: the server takes the stream directly.
  const res = await fetch('/api/branding/logo', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', ...requestHeaders() },
    body: file,
  });
  await requireOk(res);
  return (await res.json()) as LogoMeta;
}

export async function clearLogo(): Promise<void> {
  const res = await fetch('/api/branding/logo', { method: 'DELETE', headers: requestHeaders() });
  await requireOk(res);
}

export async function saveConfig(church: Church): Promise<Church> {
  const res = await fetch('/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...requestHeaders() },
    body: JSON.stringify(church),
  });
  await requireOk(res);
  return res.json();
}

// Per-room integration connectivity (migrating out of rooms.config.js).
export interface PcServiceType {
  id: string;
  name: string;
}

export type AnalysisSource = 'smaart' | 'rta' | 'open-sound-meter';

// The room's SPL source. `password` is write-only (send to change, omit to
// keep); reads report hasPassword instead. `mock` marks the dev fixture.
export interface AnalysisConfig {
  source: AnalysisSource;
  host?: string;
  port?: number;
  password?: string;
  hasPassword?: boolean;
  logControl?: boolean;
  mock?: boolean;
  /** Room-level dB goals. Edited per widget, but stored on the room: the show
   *  engine stamps them onto every SPL sample whether or not a dashboard is
   *  open. Carried through this editor untouched so saving a host cannot
   *  silently blank them. */
  target?: number;
  limit?: number;
  metric?: string;
}

export interface ProPresenterConfig {
  host: string;
  port?: number;
  timer?: string;
}

export interface ModeConfig {
  id: string;
  label: string;
  color: string;
  match: string;
  press?: { page: number; row: number; column: number };
  isStandby?: boolean;
}

export interface CompanionConfig {
  mock: boolean;
  host?: string;
  port?: number;
  variable?: string;
  modes: ModeConfig[];
}

/** Where a room's livestream lives. The room owns the CHANNEL; which video a
 *  given service used is pinned per service time in the show config, because a
 *  channel pre-creates one broadcast per service. */
export interface YouTubeConfig {
  channelId: string | null;
}

/** A room's caption source. `key` is write-only — reads carry `hasKey`. */
export interface CaptionsConfig {
  source: 'prodmesh-caption' | 'prodcom';
  host: string;
  port?: number;
  key?: string;
  hasKey?: boolean;
  channels?: string[];
}
export interface ObsConfig {
  host: string;
  port?: number;
  password?: string;
  hasPassword?: boolean;
  primaryAudioInput?: string;
  droppedFramesWarning?: number;
  previewImageUrl?: string;
}

export interface RoomConnectivity {
  hasServerRoom: boolean;
  planningCenter: { serviceTypes: PcServiceType[] } | null;
  analysis: AnalysisConfig | null;
  captions: CaptionsConfig | null;
  proPresenter: ProPresenterConfig | null;
  companion: CompanionConfig | null;
  youtube: YouTubeConfig | null;
  obs: ObsConfig | null;
}

export const getRoomConnectivity = (roomId: string) =>
  getJson<RoomConnectivity>(`/api/config/rooms/${roomId}/connectivity`);

// One integration's live status from the on-demand connectivity probe.
// ok: true = probe succeeded, false = failed, null = nothing to probe
// (simulated, or not contacted yet); detail is the human-readable line.
export interface IntegrationStatus {
  ok: boolean | null;
  detail: string | null;
  at: number;
  mock?: boolean;
}

export interface RoomConnectivityStatus {
  planningCenter: IntegrationStatus | null;
  proPresenter: IntegrationStatus | null;
  companion: IntegrationStatus | null;
  analysis: IntegrationStatus | null;
  obs?: IntegrationStatus | null;
}

export const getRoomConnectivityStatus = (roomId: string) =>
  getJson<RoomConnectivityStatus>(`/api/config/rooms/${roomId}/connectivity/status`);

export async function savePcServiceTypes(
  roomId: string,
  serviceTypes: PcServiceType[],
): Promise<{ serviceTypes: PcServiceType[] }> {
  const res = await fetch(`/api/config/rooms/${roomId}/connectivity/planning-center`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...requestHeaders() },
    body: JSON.stringify({ serviceTypes }),
  });
  await requireOk(res);
  return (await res.json()).planningCenter;
}

export async function saveAnalysis(
  roomId: string,
  analysis: AnalysisConfig | null,
): Promise<AnalysisConfig | null> {
  const res = await fetch(`/api/config/rooms/${roomId}/connectivity/analysis`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...requestHeaders() },
    body: JSON.stringify({ analysis }),
  });
  await requireOk(res);
  return (await res.json()).analysis;
}

export const testAnalysisConnection = (roomId: string, analysis: AnalysisConfig) =>
  fetch(`/api/config/rooms/${roomId}/connectivity/analysis/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...requestHeaders() },
    body: JSON.stringify({ analysis }),
  }).then(async (res) => {
    await requireOk(res);
    return res.json() as Promise<{ ok: boolean; detail: string }>;
  });

/** Save a room's caption source. Omitting `key` keeps the stored one — the
 *  editor never receives it, so it cannot send it back. */
export async function saveCaptions(
  roomId: string,
  captions: CaptionsConfig | null,
): Promise<CaptionsConfig | null> {
  const res = await fetch(`/api/config/rooms/${roomId}/connectivity/captions`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...requestHeaders() },
    body: JSON.stringify({ captions }),
  });
  await requireOk(res);
  return (await res.json()).captions;
}

export async function saveYouTube(
  roomId: string,
  youtube: YouTubeConfig | null,
): Promise<YouTubeConfig | null> {
  const res = await fetch(`/api/config/rooms/${roomId}/connectivity/youtube`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...requestHeaders() },
    body: JSON.stringify({ youtube }),
  });
  await requireOk(res);
  return (await res.json()).youtube;
}

export async function saveProPresenter(
  roomId: string,
  proPresenter: ProPresenterConfig | null,
): Promise<ProPresenterConfig | null> {
  const res = await fetch(`/api/config/rooms/${roomId}/connectivity/propresenter`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...requestHeaders() },
    body: JSON.stringify({ proPresenter }),
  });
  await requireOk(res);
  return (await res.json()).proPresenter;
}

export async function saveCompanion(
  roomId: string,
  companion: CompanionConfig,
): Promise<CompanionConfig> {
  const res = await fetch(`/api/config/rooms/${roomId}/connectivity/companion`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...requestHeaders() },
    body: JSON.stringify({ companion }),
  });
  await requireOk(res);
  return (await res.json()).companion;
}

export async function saveObs(roomId: string, obs: ObsConfig | null): Promise<ObsConfig | null> {
  const res = await fetch(`/api/config/rooms/${roomId}/connectivity/obs`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', ...requestHeaders() }, body: JSON.stringify({ obs }),
  });
  await requireOk(res);
  return (await res.json()).obs;
}

export interface ServerLogTail {
  exists: boolean;
  file: string;
  /** Where to look instead, when there's no file — differs per deployment. */
  hint?: string;
  size?: number;
  mtime?: number;
  truncated?: boolean;
  lines: string[];
}

export const getServerLog = (lines = 500) =>
  getJson<ServerLogTail>(`/api/system/logs?lines=${lines}`);

export interface AuditEntry {
  id: number;
  ts: number;
  action: string;
  result: string;
  resourceType: string | null;
  resourceId: string | null;
  roomId: string | null;
  planId: string | null;
  userName: string | null;
  username: string | null;
  stationName: string | null;
  details: Record<string, unknown> | null;
}

export const getAuditLog = (limit = 200) =>
  getJson<{ entries: AuditEntry[] }>(`/api/system/audit?limit=${limit}`);

// ── Planning Center Services ──────────────────────────────────────────────────

export interface PlanTime {
  id: string;
  name: string | null;
  startsAt: string | null;
  endsAt: string | null;
  type: string | null;
}

export interface PlanItem {
  id: string;
  sequence: number | null;
  title: string;
  type: string | null;
  length: number | null;
  key: string | null; // song key, e.g. "D"
  leader: string | null; // from the item's "Leader" note
  description: string | null;
}

export interface PlanTeamMember { id: string; name: string; position: string; teamId: string | null; teamName: string; status: string | null; photoUrl: string | null; }

export interface ServicePlan {
  id: string;
  serviceTypeId: string;
  serviceTypeName: string;
  title: string;
  seriesTitle: string | null;
  dates: string | null;
  sortDate: string | null;
  times: PlanTime[];
  items: PlanItem[];
  teamMembers?: PlanTeamMember[];
  _mock?: boolean;
}

export interface RoomService {
  configured: boolean;
  live: boolean;
  plans: ServicePlan[];
  error?: string;
}

export interface ServicesOverview {
  live: boolean;
  services: {
    roomId: string;
    roomName: string;
    serviceType: string;
    next: ServicePlan | null;
    error?: string;
  }[];
}

export const getRoomService = (id: string) =>
  getJson<RoomService>(`/api/rooms/${encodeURIComponent(id)}/service`);

export const getRoomPlan = (id: string, planId: string) =>
  getJson<{ live: boolean; plan: ServicePlan }>(
    `/api/rooms/${encodeURIComponent(id)}/plan/${encodeURIComponent(planId)}`,
  );

// ── Event Detail (times + notes + startup checklist for one event) ────────────

export interface PlanNote {
  category: string | null;
  content: string;
}

export interface ChecklistItem {
  id: string;
  label: string;
  action: { type: 'mode'; mode: string } | null;
  done: boolean;
  doneAt: number | null;
}

export interface ShowConfig {
  startItemId: string | null; // PP lands on this PC item → show autostarts
  endItemId: string | null; // last slide of this PC item → show auto-completes
  map: Record<string, { ppIndex: number; ppName: string | null } | { disabled: true } | null>;
  /** YouTube broadcast per SERVICE TIME, tri-state. Key ABSENT = auto (record
   *  whatever is live); `null` = not streamed (record nothing, don't look);
   *  a string = pinned to that broadcast. A channel pre-creates one broadcast
   *  per service, so 8:00 and 9:30 are different videos on one plan. */
  videos: Record<string, string | null>;
  servicesLiveFromProPresenter?: boolean;
  /** The condition that gives this event's Services LIVE bridge permission to run. */
  servicesLiveStartMode?: 'item' | 'service-time';
  servicesLiveStartItemId?: string | null;
  servicesLiveStartTimeId?: string | null;
}

/** A live or scheduled broadcast on the room's channel, for the pin picker. */
export interface YouTubeBroadcast {
  videoId: string;
  title: string;
  scheduledStart: string | null;
  actualStart: string | null;
  live: boolean;
}

export const getYouTubeBroadcasts = (roomId: string) =>
  getJson<{ configured: boolean; broadcasts: YouTubeBroadcast[]; error?: string }>(
    `/api/rooms/${encodeURIComponent(roomId)}/youtube/broadcasts`,
  );

export interface PpPlaylist {
  playlistName: string | null;
  matched: boolean; // true = this is the plan's own playlist, not just PP's active one
  items: { index: number; name: string; type: string }[];
}

export interface EventDetail {
  live: boolean;
  plan: ServicePlan;
  detail: { artwork: string | null; notes: PlanNote[] };
  checklist: ChecklistItem[];
  showConfig: ShowConfig | null;
}

export const getEventDetail = (id: string, planId: string) =>
  getJson<EventDetail>(
    `/api/rooms/${encodeURIComponent(id)}/event/${encodeURIComponent(planId)}`,
  );

export async function saveShowConfig(
  id: string,
  planId: string,
  config: ShowConfig,
): Promise<ShowConfig> {
  const res = await fetch(
    `/api/rooms/${encodeURIComponent(id)}/event/${encodeURIComponent(planId)}/show-config`,
    { method: 'PUT', headers: { 'Content-Type': 'application/json', ...requestHeaders() }, body: JSON.stringify(config) },
  );
  await requireOk(res);
  return ((await res.json()) as { showConfig: ShowConfig }).showConfig;
}

export async function clearShowConfig(id: string, planId: string): Promise<void> {
  const res = await fetch(
    `/api/rooms/${encodeURIComponent(id)}/event/${encodeURIComponent(planId)}/show-config`,
    { method: 'DELETE', headers: requestHeaders() },
  );
  await requireOk(res);
}

export const getPpPlaylist = (id: string, planId: string) =>
  getJson<{ playlist: PpPlaylist | null }>(
    `/api/rooms/${encodeURIComponent(id)}/event/${encodeURIComponent(planId)}/pp-playlist`,
  );

export const setChecklistItem = (id: string, planId: string, itemId: string, done: boolean) =>
  postJson<{ checklist: ChecklistItem[] }>(
    `/api/rooms/${encodeURIComponent(id)}/event/${encodeURIComponent(planId)}/checklist/${encodeURIComponent(itemId)}`,
    { done },
  );

export interface ReportItem {
  itemName: string;
  plannedLength: number | null;
  actualSeconds: number;
  delta: number | null;
  ongoing: boolean;
  /** Loudness during this individual Planning Center item. */
  spl?: SplReport | null;
}

export interface SplReport {
  count: number;
  leq: number | null; // energy-averaged dB over the captured window
  peak: number | null;
  from: number;
  to: number;
  target: number | null; // room's dB goal (e.g. 90)
  limit: number | null; // do-not-exceed (e.g. 95)
  ca?: { avg: number | null; max: number | null } | null; // when captured
}

export interface TimingReport {
  items: ReportItem[];
  totals: { planned: number; actual: number; delta: number };
  startedAt?: number | null;
  completedAt?: number | null;
  spl?: SplReport | null;
  stream?: StreamReport | null;
  /** Server withheld the analysis: reports.view required. Timestamps still
   *  come through so Run of Show can show a finished service. */
  restricted?: boolean;
}

/** YouTube Live viewership for one service. `series` is the thinned curve —
 *  present only while the raw samples survive retention; the KPIs outlive it. */
export interface StreamReport {
  count: number;
  peak: number;
  avg: number;
  from: number;
  to: number;
  series?: { ts: number; viewers: number }[];
}

export const getReport = (id: string, planId: string, timeId?: string | null) =>
  getJson<TimingReport>(
    `/api/rooms/${encodeURIComponent(id)}/plan/${encodeURIComponent(planId)}/report` +
      (timeId ? `?time=${encodeURIComponent(timeId)}` : ''),
  );

// ── Show session (server-coordinated Run of Show) ─────────────────────────────

export interface ShowCurrent {
  itemId: string | null;
  itemIndex: number | null;
  itemName: string | null;
  startedAt?: number | null;
  slideIndex: number | null;
  slideCount: number | null;
}

export interface PpTimer {
  uuid: string | null;
  name: string;
  state: string; // 'running' | 'stopped' | …
  remainingSeconds: number | null;
  targetSecondsOfDay: number | null; // seconds since midnight, or null
  countsDownToTime: boolean;
}

// C-A ratio (C-weighted minus A-weighted level, dB): how much low-frequency
// energy rides under the mix. lo/hi = the target band configured in the
// analyzer app. Only present when the analysis source provides it (RTA).
export interface CaState {
  current: number;
  avg: number | null; // running mean — only while a show is live
  max: number | null; // show max — only while a show is live
  lo: number | null;
  hi: number | null;
}

export interface SplState {
  current: number; // latest sample, dB
  avg: number | null; // running Leq — only while a show is live
  peak: number | null; // show peak — only while a show is live
  target: number | null;
  limit: number | null;
  readings?: Record<string, number> | null;
  ca?: CaState | null;
}

/** Live normalized spectrum from an analysis provider. This is intentionally
 * transient: RTA history belongs to the analyzer, not the show report. */
export interface RtaState {
  provider: 'prodmesh-rta' | 'smaart' | 'open-sound-meter';
  source: string;
  connected: boolean;
  points: Array<{ hz: number; db: number; peak?: number }>;
  metrics: { fast: number | null; slow: number | null; leq: number | null; weighting: string | null; calibration: number | null } | null;
  updatedAt: number;
}

/** Live YouTube viewers. `current` is null when nothing is broadcasting or the
 *  broadcaster hid the counter — never 0, which would be a number people read. */
export interface StreamState {
  current: number | null;
  peak: number | null; // show peak — only while a show is live
  avg: number | null;  // show average — only while a show is live
  live: boolean;
  title?: string | null;
}

/**
 * One integration's dot on the room-health topic.
 *
 * Deliberately thin. The server probes the same way the config chips do, but
 * publishes only which integration and whether it works — no host, port,
 * version banner or error text, because this topic is readable by an
 * unauthenticated screen and those turn "ProPresenter is down" into a map of
 * the building. The detail stays on the config page and in Admin → Logs.
 */
export interface IntegrationHealth {
  id: 'planningCenter' | 'proPresenter' | 'companion' | 'analysis' | 'youtube';
  label: string;
  /** `mock` = simulated on purpose. `unknown` = configured, not contacted yet. */
  state: 'ok' | 'down' | 'mock' | 'unknown';
}

/** Only the integrations this room has configured — an unconfigured one is
 *  absent, not a permanent grey dot. */
export interface RoomHealth {
  at: number;
  integrations: IntegrationHealth[];
}

/**
 * A video playing on ProPresenter's media transport, or null.
 *
 * Only ever present while it is actually MOVING. ProPresenter keeps a stopped
 * video's name and duration indefinitely and freezes its position, so "there
 * is a video loaded" is a state that never ends — see INTEGRATION-NOTES.
 * Paused is indistinguishable from stopped, so both arrive here as null.
 */
export interface VideoState {
  name: string | null;
  /** Seconds, floats. Clamped to duration. */
  seconds: number | null;
  duration: number;
  audioOnly: boolean;
}

/**
 * One line of transcript, normalised across caption sources — an integer
 * channel on one, a UUID on the other, both arriving here as strings.
 */
export interface CaptionLine {
  /** Stable for one utterance, so a settled line replaces its live one. */
  id: string;
  ch: string;
  /** Only some sources denormalise it onto the line; prefer the roster. */
  name?: string | null;
  text: string;
  /** Still being spoken. Also what makes a speaker "talking" — the engine
   *  finalises on silence, so this clears itself. */
  live: boolean;
  at: number;
}

/**
 * One cue of the song ProPresenter has open, in the order it is PLAYED —
 * a section repeated four times is four entries here, because the whole point
 * is knowing which of the four you are in.
 */
export interface LyricSlide {
  /** May be empty: a "Blank" or "Clear Background" cue is an instrumental
   *  beat, and dropping it would make the scroll look stuck. */
  text: string;
  /** The ProPresenter group name — "Verse 1", "Chorus 1", "Tag 1". */
  section: string;
  /** That group's colour, assigned by the operator in ProPresenter. Ours would
   *  disagree with the presentation everyone else in the room is looking at. */
  color: string | null;
  /** The operator's slide note, when there is one — "push in", "piano". */
  note: string | null;
  /** Position within a run of back-to-back plays of the same section, e.g.
   *  {at: 2, of: 4}. Null when the section is played once here. */
  rep: { at: number; of: number } | null;
}

export interface RoomLyrics {
  /** Presentation name. Null when ProPresenter has nothing open. */
  name: string | null;
  slides: LyricSlide[];
  /** Index into `slides`, or null when the position is unknown. */
  index: number | null;
}

export interface RoomCaptions {
  /** The caption app is connected. False also covers "not configured". */
  up: boolean;
  channels: { ch: string; name: string; color: string | null }[];
  /** Bounded rolling window, oldest first. */
  lines: CaptionLine[];
}

export interface ShowState {
  active: boolean;
  roomId?: string;
  planId?: string;
  timeId?: string;
  startedAt?: number;
  follow?: boolean;
  ppConnected?: boolean | null;
  servicesLive?: { state: string; itemId?: string | null; error?: string | null } | null;
  current?: ShowCurrent;
  timer?: PpTimer | null;
  spl?: SplState | null;
  stream?: StreamState | null;
}

export const getShow = (roomId: string) =>
  getJson<ShowState>(`/api/rooms/${encodeURIComponent(roomId)}/show`);

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...requestHeaders() },
    body: JSON.stringify(body),
  });
  await requireOk(res);
  return res.json() as Promise<T>;
}

export const startShow = (
  roomId: string,
  planId: string,
  timeId: string,
  opts?: { rehearsal?: boolean },
) =>
  postJson<ShowState>(`/api/rooms/${encodeURIComponent(roomId)}/show/start`, {
    planId,
    timeId,
    ...(opts?.rehearsal ? { rehearsal: true } : {}),
  });

export const endShow = (roomId: string) =>
  postJson<ShowState>(`/api/rooms/${encodeURIComponent(roomId)}/show/end`, {});

export const setShowCurrent = (roomId: string, body: { itemId?: string; follow?: boolean }) =>
  postJson<ShowState>(`/api/rooms/${encodeURIComponent(roomId)}/show/current`, body);

/**
 * Download a backup. Deliberately goes through fetch + a blob rather than a
 * plain <a href>: the request needs the auth header, and an anchor cannot
 * carry one — a bare link would 401 and look like a broken button.
 */
export async function downloadBackup(history: boolean): Promise<void> {
  const res = await fetch(`/api/system/backup${history ? '?history=1' : ''}`, {
    headers: requestHeaders(),
  });
  await requireOk(res);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `prodmesh-backup-${new Date().toISOString().slice(0, 10)}.pmbak`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export interface RestoreResult {
  files: number;
  history: boolean;
  from: string | null;
  createdAt: number | null;
  restart: string;
}

/** Restore, which the server allows only while no admin PIN exists. */
export async function restoreBackup(file: File): Promise<RestoreResult> {
  const res = await fetch('/api/setup/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  if (!res.ok) {
    // Read the body ONCE — a second res.json() throws on a consumed stream and
    // would replace the server's actual explanation with a parse error.
    const body = await res.json().catch(() => null);
    throw new Error(body?.message ?? body?.error ?? 'That backup could not be restored.');
  }
  return res.json();
}

export const getServicesOverview = () => getJson<ServicesOverview>('/api/services');

// ── Views (dashboards & displays) ────────────────────────────────────────────

export interface ViewPlacement {
  id: string;
  /** A plain string, NOT WidgetType: a view written by a newer build may name
   *  a widget this one has never heard of, and the renderer holds the slot
   *  rather than dropping it and reflowing the grid. */
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  config: WidgetConfigJson;
}

/** Mirrors the server's per-placement config — the same shape as WidgetConfig. */
export interface WidgetConfigJson {
  hideHeader?: boolean;
  rows?: CompanionVariableRow[];
  planId?: string;
  timeId?: string;
  slideControls?: boolean;
  keyboardControls?: boolean;
  followActive?: boolean;
  slideMode?: 'image' | 'text';
  slideSize?: number;
  slides?: 'current' | 'next' | 'both';
  target?: number;
  limit?: number;
  metric?: string;
  weighting?: 'A' | 'B' | 'C' | 'Z';
  response?: 'Fast' | 'Slow';
  sourceRoomId?: string;
  autoplay?: boolean;
  muted?: boolean;
  playerControls?: boolean;
  destinationLinks?: boolean;
  videoPreview?: boolean;
  obsPreview?: boolean;
  obsDetails?: boolean;
  aspectRatio?: '16:9' | '4:3' | '1:1';
}

export interface ViewSummary {
  id: string;
  roomId: string;
  kind: 'dashboard' | 'display';
  name: string;
  slug: string;
  columns: number;
  maxRows: number | null;
  /** Magnification for a display seen from across a room. 1 = actual size. */
  scale: number;
  position: number;
  createdAt: number;
  updatedAt: number;
}

/** A view with its layout. The index endpoint omits `widgets`. */
export interface View extends ViewSummary {
  widgets: ViewPlacement[];
}

export const getViews = (roomId: string) =>
  getJson<{ views: ViewSummary[] }>(`/api/rooms/${encodeURIComponent(roomId)}/views`);

/** Resolves a slug OR an id, so renaming a view cannot orphan a screen. */
export const getView = (roomId: string, key: string) =>
  getJson<{ view: View }>(
    `/api/rooms/${encodeURIComponent(roomId)}/views/${encodeURIComponent(key)}`,
  );

export const createView = (
  roomId: string,
  input: { kind: 'dashboard' | 'display'; name: string; slug: string },
) => postJson<{ view: View }>(`/api/rooms/${encodeURIComponent(roomId)}/views`, input);

export async function saveView(
  viewId: string,
  input: { name: string; slug: string; scale?: number; widgets: Omit<ViewPlacement, 'id'>[] },
): Promise<View> {
  const res = await fetch(`/api/views/${encodeURIComponent(viewId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...requestHeaders() },
    body: JSON.stringify(input),
  });
  await requireOk(res);
  return ((await res.json()) as { view: View }).view;
}

export async function deleteView(viewId: string): Promise<void> {
  const res = await fetch(`/api/views/${encodeURIComponent(viewId)}`, {
    method: 'DELETE',
    headers: requestHeaders(),
  });
  await requireOk(res);
}

// ── History (Analytics) ──────────────────────────────────────────────────────

export interface HistoryShow {
  instanceId: string;
  roomId: string | null;
  roomName: string | null;
  site: string | null;
  planId: string | null;
  timeId: string | null;
  planTitle: string | null;
  serviceTypeName: string | null;
  dates: string | null;
  timeName: string | null;
  timeStartsAt: string | null;
  startedAt: number | null;
  completedAt: number | null;
  itemCount: number;
  totals: { planned: number; actual: number; delta: number };
  spl: SplReport | null;
  /** True for practice runs (timeId `rehearsal-*`) — excluded from real-service metrics. */
  rehearsal: boolean;
}

export const getHistory = () => getJson<{ shows: HistoryShow[] }>('/api/history');

/** Erase a recorded run (timing + loudness). Irreversible; requires history.delete. */
export async function deleteHistoryShow(instanceId: string): Promise<void> {
  const res = await fetch(`/api/history/${encodeURIComponent(instanceId)}`, {
    method: 'DELETE',
    headers: requestHeaders(),
  });
  await requireOk(res);
}

// ── Planning Center Calendar (room bookings) ─────────────────────────────────

export interface CalendarEvent {
  id: string;
  eventId: string | null;
  name: string;
  startsAt: string;
  endsAt: string | null;
  allDay: boolean;
  location: string | null;
  approval: string | null; // 'A' approved · 'P' pending · 'R' rejected
  roomIds: string[]; // matched against the live rooms map; [] = unmapped
}

export interface CalendarRange {
  live: boolean;
  /** Why we're not live: 'no-token' | 'not-granted' (Calendar not enabled for the PAT). */
  reason?: string;
  start: string;
  end: string;
  events: CalendarEvent[];
}

export const getCalendar = (start: string, end: string) =>
  getJson<CalendarRange>(
    `/api/calendar?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
  );

export const getAbout = () => getJson<{ name: string; version: string }>('/api/about');

// ── Assistance requests (the Lowe's aisle button) ────────────────────────────

export interface AssistanceState {
  active: boolean;
  requestedAt?: number;
  userName?: string | null;
  /** The reported problem, relayed to Slack so the right person responds. */
  message?: string | null;
  /** Set when a tech 👀-reacted the Slack message: they've seen it and are coming. */
  ack?: { name: string | null; at: number } | null;
}

export const getAssistance = () => getJson<AssistanceState>('/api/assistance');

export const requestAssistance = (message?: string) =>
  postJson<AssistanceState>('/api/assistance', message ? { message } : {});

export async function dismissAssistance(): Promise<void> {
  const res = await fetch('/api/assistance', { method: 'DELETE', headers: requestHeaders() });
  await requireOk(res);
}

export const triggerUpdate = () =>
  fetch('/api/system/update', { method: 'POST', headers: requestHeaders() }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
