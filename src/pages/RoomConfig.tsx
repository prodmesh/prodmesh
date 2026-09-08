import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowDown, ArrowUp, ChevronRight, RefreshCw, Trash2 } from 'lucide-react';
import { Checkbox } from '../components/Checkbox';
import { Switch } from '../components/Switch';
import { HelpTip } from '../components/HelpTip';
import { PasswordInput } from '../components/PasswordInput';
import { SelectField } from '../components/SelectField';
import { ColorInput } from '../components/form/ColorInput';
import { EditDialog, type DialogForm } from '../components/form/EditDialog';
import { Field } from '../components/form/Field';
import { FormRow } from '../components/form/FormRow';
import { useDraft } from '../components/form/useDraft';
import { IntegrationBrand, type IntegrationId } from '../components/IntegrationBrand';
import { useQuery } from '../lib/useQuery';
import { allIds, slugId } from '../lib/topology';
import {
  getEnabledIntegrations,
  getCompanionEmulators,
  getRoomConnectivity,
  getRoomConnectivityStatus,
  getRooms,
  getSettings,
  saveAnalysis,
  saveCaptions,
  saveCompanion,
  saveObs,
  savePcServiceTypes,
  saveProPresenter,
  saveSchedules,
  saveYouTube,
  testAnalysisConnection,
  type AnalysisConfig,
  type CaptionsConfig,
  type CompanionConfig,
  type ObsConfig,
  type IntegrationStatus,
  type ModeConfig,
  type PcServiceType,
  type ProPresenterConfig,
  type RoomConnectivity,
  type RoomConnectivityStatus,
  type RoomMeta,
  type ScheduleWindow,
  type YouTubeConfig,
} from '../api';
import type { Church, Tile } from '../types';
import { DAY_LABELS, TILE_ICONS, TILE_TYPE_LABELS, moveIn, useChurchDraft } from './settingsShared';

// ─────────────────────────────────────────────────────────────────────────────
//  One room's configuration page (/admin/campuses/:roomId).
//
//  Read-only by default. The page is a header (the room's name and site, the
//  only things edited in place) over a grid of summary cards — one per thing
//  the room has: its Quick Access tiles, each integration, its schedules.
//  A card shows what is set and whether it answers; clicking it opens the
//  editor in a dialog with one Save.
//
//  It used to be every editor open at once, each with its own Save, and the
//  maintainer's review of it — "super busy, misaligned, save buttons
//  everywhere" — is the whole brief. The editors themselves are unchanged
//  inside their dialogs; what changed is that the page reads as a control
//  surface and the form is the exception you open on purpose.
//
//  Schedules & Locks moved here from Admin → General (#22): a schedule is a
//  fact about a room, and it needs the room's modes to say what it locks.
// ─────────────────────────────────────────────────────────────────────────────

type Editing =
  | 'tiles' | 'companion' | 'planning-center' | 'analysis' | 'youtube' | 'captions' | 'propresenter' | 'obs' | 'schedules'
  | null;

export function RoomConfigPanel() {
  const { roomId = '' } = useParams();
  const church = useChurchDraft();
  const { draft, dirty, msg, err, update, save } = church;
  const [editing, setEditing] = useState<Editing>(null);

  if (!draft) return err ? <p className="settings__error">{err}</p> : <p className="settings__muted">Loading…</p>;

  const owner = draft.sites.find((s) => s.auditoriums.some((r) => r.id === roomId));
  const room = owner?.auditoriums.find((r) => r.id === roomId);

  if (!owner || !room) {
    return (
      <section className="panel">
        <p className="settings__error">No room "{roomId}" exists.</p>
        <Link className="btn" to="/admin/campuses">← All campuses</Link>
      </section>
    );
  }

  // Locate this room inside a draft copy, wherever it currently lives.
  const findRoom = (n: Church) => {
    const s = n.sites.find((x) => x.auditoriums.some((r) => r.id === roomId))!;
    return { site: s, room: s.auditoriums.find((r) => r.id === roomId)! };
  };

  return (
    <>
      <section className="panel campuses">
        <div className="campuses__head">
          <div>
            <p className="section-label"><Link className="campuses__back" to="/admin/campuses">← All campuses</Link></p>
            <h2 className="panel__title">{room.name}</h2>
          </div>
          <button className="btn btn--primary" onClick={() => save()} disabled={!dirty}>
            {dirty ? 'Save changes' : 'Saved'}
          </button>
        </div>

        <div className="campuses__siterow">
          <label className="lfield"><span>Room name</span>
            <input className="field" value={room.name}
              onChange={(e) => update((n) => { findRoom(n).room.name = e.target.value; })} />
          </label>
          <label className="lfield"><span>Site</span>
            <SelectField value={owner.id}
              onChange={(e) => update((n) => {
                const from = findRoom(n);
                const dest = n.sites.find((x) => x.id === e.target.value)!;
                from.site.auditoriums = from.site.auditoriums.filter((r) => r.id !== roomId);
                dest.auditoriums.push(from.room);
              })}>
              {draft.sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </SelectField>
          </label>
          <label className="lfield"><span>Room ID</span>
            <input className="field" value={room.id} disabled
              title="Stable identifier — links this room to its server integrations" />
          </label>
        </div>

        {err && <p className="settings__error">{err}</p>}
        {msg && <p className="settings__ok">{msg}</p>}
      </section>

      <ConnectivityCards
        roomId={roomId}
        tiles={room.tiles}
        editing={editing}
        onEdit={setEditing}
        onClose={() => setEditing(null)}
        saveTiles={(tiles) => save((n) => { findRoom(n).room.tiles = tiles; })}
        churchBusy={church.busy}
        churchErr={err}
      />
    </>
  );
}

// ── The cards ────────────────────────────────────────────────────────────────

function ConnectivityCards({ roomId, tiles, editing, onEdit, onClose, saveTiles, churchBusy, churchErr }: {
  roomId: string;
  tiles: Tile[];
  editing: Editing;
  onEdit: (which: Editing) => void;
  onClose: () => void;
  saveTiles: (tiles: Tile[]) => Promise<boolean>;
  churchBusy: boolean;
  churchErr: string;
}) {
  const [conn, setConn] = useState<RoomConnectivity | null>(null);
  const [err, setErr] = useState('');
  const [status, setStatus] = useState<RoomConnectivityStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const enabledIntegrations = useQuery('enabled-integrations', getEnabledIntegrations, { staleMs: 60_000 }).data?.enabled;
  // The room's live modes, for the schedules card: a lock names a mode, and
  // the card should say "Standby", not "standby".
  const rooms = useQuery('rooms', getRooms, { staleMs: 60_000 }).data;
  const roomMeta = rooms?.find((r) => r.id === roomId) ?? null;
  const [schedules, setSchedules] = useState<ScheduleWindow[] | null>(null);

  useEffect(() => {
    getRoomConnectivity(roomId)
      .then(setConn)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
    getSettings()
      .then((s) => setSchedules(s.schedules?.[roomId] ?? []))
      .catch(() => setSchedules([]));
  }, [roomId]);

  // One probe on load, then on demand — the devices are on the local network,
  // no need to poll. Re-probed after any save, since a host may have changed.
  const check = useCallback(() => {
    setChecking(true);
    getRoomConnectivityStatus(roomId)
      .then(setStatus)
      .catch(() => setStatus(null))
      .finally(() => setChecking(false));
  }, [roomId]);

  const hasServerRoom = conn?.hasServerRoom;
  useEffect(() => {
    if (hasServerRoom) check();
  }, [hasServerRoom, check]);

  const enabled = (id: IntegrationId) => enabledIntegrations?.[id] !== false;
  const analysisEnabled = enabled('prodmesh-rta') || enabled('smaart') || enabled('open-sound-meter');

  /** Store what the server answered and look again, in that order: the card
   *  must not show the old host while the probe of the new one is in flight. */
  const stored = <K extends keyof RoomConnectivity>(key: K) => (value: RoomConnectivity[K]) => {
    setConn((c) => (c ? { ...c, [key]: value } : c));
    check();
  };

  const tileSummary = tiles.length === 0
    ? ['No tiles.']
    : [`${tiles.length} tile${tiles.length === 1 ? '' : 's'}`, tiles.map((t) => t.label).join(' · ')];

  return (
    <section className="panel campuses">
      <div className="campuses__head">
        <div>
          <p className="section-label">Connectivity</p>
          <h2 className="panel__title">This room</h2>
        </div>
        {conn?.hasServerRoom && (
          <button className="btn" onClick={check} disabled={checking}>
            <RefreshCw size={14} className={checking ? 'connstatus__spin' : undefined} aria-hidden />
            {checking ? 'Checking…' : 'Check now'}
          </button>
        )}
      </div>

      {err && <p className="settings__error">{err}</p>}
      {!conn && !err && <p className="settings__muted">Loading…</p>}

      {conn && !conn.hasServerRoom && (
        <p className="settings__muted">
          The server doesn't know a room <code>{roomId}</code> — save the campus
          configuration above, then reload this page.
        </p>
      )}

      <div className="cfgcards">
        <ConfigCard title="Quick Access tiles" section="Launcher" lines={tileSummary} onOpen={() => onEdit('tiles')} />

        {conn?.hasServerRoom && (
          <>
            {enabled('companion') && (
              <ConfigCard
                title="Bitfocus Companion & modes"
                integration="companion"
                status={<StatusChip status={status?.companion} />}
                lines={companionLines(conn.companion)}
                onOpen={() => onEdit('companion')}
              />
            )}
            {enabled('planning-center') && (
              <ConfigCard
                title="Planning Center service types"
                integration="planning-center"
                status={<StatusChip status={status?.planningCenter} />}
                lines={[conn.planningCenter?.serviceTypes?.length
                  ? conn.planningCenter.serviceTypes.map((t) => t.name || t.id).join(' · ')
                  : 'None — this room shows no Planning Center events.']}
                onOpen={() => onEdit('planning-center')}
              />
            )}
            {analysisEnabled && (
              <ConfigCard
                title="Analysis source"
                status={<StatusChip status={status?.analysis} />}
                lines={analysisLines(conn.analysis)}
                // A dev room's simulated meter has nothing to edit.
                onOpen={conn.analysis?.mock ? undefined : () => onEdit('analysis')}
              />
            )}
            {enabled('propresenter') && (
              <ConfigCard
                title="ProPresenter"
                integration="propresenter"
                status={<StatusChip status={status?.proPresenter} />}
                lines={conn.proPresenter?.host
                  ? [hostPort(conn.proPresenter.host, conn.proPresenter.port), conn.proPresenter.timer ? `Countdown timer: ${conn.proPresenter.timer}` : 'First countdown timer']
                  : ['Not in this room.']}
                onOpen={() => onEdit('propresenter')}
              />
            )}
            {enabled('obs') && (
              <ConfigCard
                title="OBS Studio"
                integration="obs"
                status={<StatusChip status={status?.obs} />}
                lines={conn.obs?.host ? [hostPort(conn.obs.host, conn.obs.port), conn.obs.hasPassword ? 'WebSocket password set' : 'No WebSocket password'] : ['Not in this room.']}
                onOpen={() => onEdit('obs')}
              />
            )}
            {enabled('youtube') && (
              <ConfigCard
                title="YouTube Live"
                integration="youtube"
                lines={[conn.youtube?.channelId ? `Channel ${conn.youtube.channelId}` : 'Not streamed.']}
                onOpen={() => onEdit('youtube')}
              />
            )}
            {enabled('captions') && (
              <ConfigCard
                title="Captions"
                lines={captionLines(conn.captions)}
                onOpen={() => onEdit('captions')}
              />
            )}
            <ConfigCard
              title="Schedules & Locks"
              lines={scheduleLines(schedules, roomMeta)}
              onOpen={() => onEdit('schedules')}
            />
          </>
        )}
      </div>

      {editing === 'tiles' && (
        <TilesDialog roomId={roomId} initial={tiles} busy={churchBusy} err={churchErr} onSave={saveTiles} onClose={onClose} />
      )}
      {editing === 'companion' && conn && (
        <CompanionDialog roomId={roomId} initial={conn.companion} onSaved={stored('companion')} onClose={onClose} />
      )}
      {editing === 'planning-center' && conn && (
        <PcServiceTypesDialog roomId={roomId} initial={conn.planningCenter?.serviceTypes ?? []}
          onSaved={(serviceTypes) => stored('planningCenter')({ serviceTypes })} onClose={onClose} />
      )}
      {editing === 'analysis' && conn && (
        <AnalysisDialog roomId={roomId} initial={conn.analysis} onSaved={stored('analysis')} onClose={onClose} />
      )}
      {editing === 'propresenter' && conn && (
        <ProPresenterDialog roomId={roomId} initial={conn.proPresenter} onSaved={stored('proPresenter')} onClose={onClose} />
      )}
      {editing === 'obs' && conn && (
        <ObsDialog roomId={roomId} initial={conn.obs} onSaved={stored('obs')} onClose={onClose} />
      )}
      {editing === 'youtube' && conn && (
        <YouTubeDialog roomId={roomId} initial={conn.youtube} onSaved={stored('youtube')} onClose={onClose} />
      )}
      {editing === 'captions' && conn && (
        <CaptionsDialog roomId={roomId} initial={conn.captions} onSaved={stored('captions')} onClose={onClose} />
      )}
      {editing === 'schedules' && (
        <SchedulesDialog roomId={roomId} initial={schedules ?? []} modes={roomMeta?.modes ?? []}
          onSaved={setSchedules} onClose={onClose} />
      )}
    </section>
  );
}

/**
 * One read-only summary. The whole card is the button that opens its editor,
 * because "click the panel" is the one gesture the brief asked for; a card
 * with nothing to edit (a simulated meter) renders the same without one.
 *
 * The status chip sits OUTSIDE the button rather than inside it: it used to
 * carry a refresh button of its own, and a button in a button is markup no
 * screen reader can announce. One "Check now" for the section replaces the
 * per-chip refresh.
 */
function ConfigCard({ title, section, integration, status, lines, onOpen }: {
  title: string;
  section?: string;
  integration?: IntegrationId;
  status?: ReactNode;
  lines: ReactNode[];
  onOpen?: () => void;
}) {
  const body = (
    <>
      <span className="cfgcard__head">
        {integration && <IntegrationBrand integration={integration} />}
        <span className="cfgcard__title">
          {section && <span className="cfgcard__section">{section}</span>}
          {title}
        </span>
        {onOpen && <ChevronRight className="cfgcard__chevron" size={16} aria-hidden />}
      </span>
      <span className="cfgcard__lines">
        {lines.map((line, i) => <span className="cfgcard__line" key={i}>{line}</span>)}
      </span>
    </>
  );
  return (
    <div className={`cfgcard${onOpen ? '' : ' cfgcard--static'}`}>
      {onOpen
        ? <button type="button" className="cfgcard__open" onClick={onOpen}>{body}</button>
        : <div className="cfgcard__open">{body}</div>}
      {status && <span className="cfgcard__status">{status}</span>}
    </div>
  );
}

const hostPort = (host: string, port?: number | null) => (port != null ? `${host}:${port}` : host);

function companionLines(c: CompanionConfig | null): ReactNode[] {
  if (!c || c.mock) return ['Simulated — room state kept in memory.', modeDots(c?.modes ?? [])];
  return [
    c.host ? `${hostPort(c.host, c.port)}${c.variable ? ` · $(${c.variable})` : ''}` : 'No host set.',
    modeDots(c.modes ?? []),
  ];
}

/** The room's modes as their colours, which is how every other screen shows
 *  them — a mode is recognised by its swatch long before by its name. */
function modeDots(modes: ModeConfig[]): ReactNode {
  if (!modes.length) return 'No modes.';
  return (
    <span className="cfgcard__modes">
      {modes.map((m) => (
        <span className="cfgcard__mode" key={m.id}>
          <i style={{ background: m.color }} aria-hidden /> {m.label}
        </span>
      ))}
    </span>
  );
}

const ANALYSIS_NAMES: Record<string, string> = {
  smaart: 'Smaart',
  rta: 'ProdMesh Remote RTA',
  'open-sound-meter': 'Open Sound Meter',
};

function analysisLines(a: AnalysisConfig | null): ReactNode[] {
  if (!a) return ['None.'];
  if (a.mock) return ['Simulated meter (dev room).'];
  const name = ANALYSIS_NAMES[a.source] ?? a.source;
  if (a.source === 'open-sound-meter') return [name, 'Multicast 239.255.42.42:49007'];
  return [a.host ? `${name} · ${hostPort(a.host, a.port)}` : name, a.logControl ? 'SPL logging follows shows' : null].filter(Boolean);
}

const CAPTION_NAMES: Record<string, string> = { 'prodmesh-caption': 'ProdMesh Caption', prodcom: 'ProdCom' };

function captionLines(c: CaptionsConfig | null): ReactNode[] {
  if (!c) return ['None.'];
  return [
    `${CAPTION_NAMES[c.source] ?? c.source}${c.host ? ` · ${hostPort(c.host, c.port)}` : ''}`,
    c.channels?.length ? `Channels ${c.channels.join(', ')}` : 'All channels',
  ];
}

function scheduleLines(windows: ScheduleWindow[] | null, room: RoomMeta | null): ReactNode[] {
  if (windows == null) return ['Loading…'];
  if (!windows.length) return ['No windows.'];
  const label = (id: string) => room?.modes.find((m) => m.id === id)?.label ?? id;
  return windows.map((w) =>
    `${w.label} · ${w.days.map((d) => DAY_LABELS[d]).join(' ')} ${w.start}–${w.end}`
    + (w.lock.length ? ` · locks ${w.lock.map(label).join(', ')}` : ''));
}

// The live dot beside an integration: green = the probe's real request
// succeeded, red = it failed (the reason inline), grey = simulated or not
// probed yet.
function StatusChip({ status }: { status: IntegrationStatus | null | undefined }) {
  if (!status) return null; // not configured — nothing to report
  const kind = status.mock ? 'sim' : status.ok === true ? 'ok' : status.ok === false ? 'down' : 'unknown';
  const label = status.mock ? 'Simulated' : status.ok === true ? 'Connected' : status.ok === false ? 'Unreachable' : 'Not checked';
  return (
    <span className={`connstatus connstatus--${kind}`} title={status.detail ?? undefined}>
      <span className="connstatus__dot" aria-hidden />
      {label}
      {status.detail && !status.mock && <span className="connstatus__detail">{status.detail}</span>}
    </span>
  );
}

// ── Quick Access tiles ───────────────────────────────────────────────────────

/** A local list, not the church draft itself: Discard must not also throw
 *  away a room name typed in the header behind the dialog. */
function TilesDialog({ roomId, initial, busy, err, onSave, onClose }: {
  roomId: string;
  initial: Tile[];
  busy: boolean;
  err: string;
  onSave: (tiles: Tile[]) => Promise<boolean>;
  onClose: () => void;
}) {
  const [tiles, setTiles] = useState<Tile[]>(() => structuredClone(initial));
  const dirty = JSON.stringify(tiles) !== JSON.stringify(initial);
  const form: DialogForm = { dirty, busy, err, submit: () => onSave(tiles) };
  const setTile = (i: number, tile: Tile) => setTiles((all) => all.map((t, j) => (j === i ? tile : t)));

  return (
    <EditDialog title="Quick Access tiles" help="The shortcuts this room shows on Home." form={form} onClose={onClose} wide>
      <div className="campuses__room">
        {tiles.length === 0 && <p className="settings__muted">No tiles.</p>}
        {tiles.map((tile, i) => (
          <TileEditor key={tile.id} tile={tile}
            onChange={(patch) => setTile(i, patch)}
            onMove={(dir) => setTiles((all) => { const next = [...all]; moveIn(next, i, dir); return next; })}
            onRemove={() => setTiles((all) => all.filter((t) => t.id !== tile.id))}
          />
        ))}
        <button className="btn campuses__addtile" onClick={() => setTiles((all) => [
          ...all,
          { id: slugId(`${roomId}-tile`, new Set([...allIds({ name: '', sites: [] }), ...all.map((t) => t.id)])), type: 'link', label: 'New tile', url: 'http://' },
        ])}>+ Add tile</button>
      </div>
    </EditDialog>
  );
}

function TileEditor({ tile, onChange, onMove, onRemove }: {
  tile: Tile;
  onChange: (tile: Tile) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const set = (field: string, value: string) => {
    const next = { ...tile } as Record<string, unknown>;
    if (value === '') delete next[field];
    else next[field] = value;
    onChange(next as unknown as Tile);
  };

  const retype = (type: Tile['type']) => {
    const base = { id: tile.id, label: tile.label, note: tile.note, icon: tile.icon };
    if (type === 'companion') onChange({ ...base, type, host: '' });
    else if (type === 'screenshare') onChange({ ...base, type, host: '' });
    else if (type === 'link') onChange({ ...base, type, url: 'http://' });
    else if (type === 'route') onChange({ ...base, type, to: '/' });
    else onChange({ ...base, type });
  };

  const t = tile as unknown as Record<string, string | undefined>;

  return (
    <div className="campuses__tile">
      <label className="lfield"><span>Type</span>
        <SelectField value={tile.type} onChange={(e) => retype(e.target.value as Tile['type'])}>
          {Object.entries(TILE_TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </SelectField>
      </label>
      <label className="lfield campuses__tileicon"><span>Icon</span>
        <SelectField value={tile.icon ?? ''} onChange={(e) => set('icon', e.target.value)}>
          <option value="">Default</option>
          {TILE_ICONS.map(([emoji, name]) => <option key={emoji} value={emoji}>{emoji} {name}</option>)}
        </SelectField>
      </label>
      <label className="lfield"><span>Label</span>
        <input className="field" value={tile.label}
          onChange={(e) => onChange({ ...tile, label: e.target.value })} />
      </label>
      <label className="lfield campuses__grow"><span>Note</span>
        <input className="field" placeholder="Optional" value={tile.note ?? ''}
          onChange={(e) => set('note', e.target.value)} />
      </label>

      {(tile.type === 'companion' || tile.type === 'screenshare') && (
        <label className="lfield"><span>Host</span>
          <input className="field" placeholder="IP or hostname" value={t.host ?? ''}
            onChange={(e) => set('host', e.target.value)} />
        </label>
      )}
      {tile.type === 'companion' && (
        <label className="lfield campuses__tileport"><span>Port</span>
          <input className="field" placeholder="8000" value={t.port ?? ''}
            onChange={(e) => set('port', e.target.value)} />
        </label>
      )}
      {tile.type === 'screenshare' && (
        <label className="lfield"><span>Mac username</span>
          <input className="field" placeholder="Optional" value={t.username ?? ''}
            onChange={(e) => set('username', e.target.value)} />
        </label>
      )}
      {tile.type === 'link' && (
        <label className="lfield campuses__grow"><span>URL</span>
          <input className="field" placeholder="http://…" value={t.url ?? ''}
            onChange={(e) => set('url', e.target.value)} />
        </label>
      )}
      {tile.type === 'route' && (
        <label className="lfield campuses__grow"><span>Route</span>
          <input className="field" placeholder="/room/…" value={t.to ?? ''}
            onChange={(e) => set('to', e.target.value)} />
        </label>
      )}

      <div className="campuses__rowactions">
        <button className="iconbtn" title="Move tile up" aria-label="Move tile up" onClick={() => onMove(-1)}><ArrowUp size={14} /></button>
        <button className="iconbtn" title="Move tile down" aria-label="Move tile down" onClick={() => onMove(1)}><ArrowDown size={14} /></button>
        <button className="iconbtn iconbtn--danger" title="Remove tile" aria-label="Remove tile" onClick={onRemove}><Trash2 size={14} /></button>
      </div>
    </div>
  );
}

// ── Schedules & Locks ────────────────────────────────────────────────────────

/**
 * This room's windows. The API stores every room's schedules as one map and
 * saves it whole, so the dialog reads the map on open and writes it back with
 * only this room's entry replaced — the same trade the old all-rooms form
 * made, now scoped to what the page is about.
 */
function SchedulesDialog({ roomId, initial, modes, onSaved, onClose }: {
  roomId: string;
  initial: ScheduleWindow[];
  modes: RoomMeta['modes'];
  onSaved: (windows: ScheduleWindow[]) => void;
  onClose: () => void;
}) {
  const f = useDraft(structuredClone(initial), async (windows) => {
    const all = (await getSettings()).schedules ?? {};
    await saveSchedules({ ...all, [roomId]: windows });
    onSaved(windows);
    return windows;
  });
  const { draft } = f;

  const add = () => f.setDraft((all) => [...all, {
    // Not crypto.randomUUID() — that requires a secure context (https/localhost)
    // and would throw when a room Mac opens the app over http://<ip>.
    id: `w-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    label: 'New window', days: [0], start: '08:00', end: '12:00', lock: [],
  }]);
  const edit = (i: number, patch: Partial<ScheduleWindow>) =>
    f.setDraft((all) => all.map((w, j) => (j === i ? { ...w, ...patch } : w)));
  const remove = (i: number) => f.setDraft((all) => all.filter((_, j) => j !== i));

  return (
    <EditDialog
      title="Schedules & Locks"
      help="Windows when a mode change needs the override PIN. A locked mode cannot be selected during the window without it."
      form={f}
      onClose={onClose}
      wide
    >
      {draft.length === 0 && <p className="settings__muted">No windows.</p>}
      {draft.map((w, i) => (
        <div key={w.id} className="sched-win">
          <input className="field field--sm" aria-label="Window name" value={w.label}
            onChange={(e) => edit(i, { label: e.target.value })} />
          <div className="sched-days">
            {DAY_LABELS.map((d, di) => (
              <button key={di} type="button"
                className={`daybtn${w.days.includes(di) ? ' daybtn--on' : ''}`}
                aria-pressed={w.days.includes(di)}
                onClick={() => edit(i, {
                  days: w.days.includes(di) ? w.days.filter((x) => x !== di) : [...w.days, di].sort(),
                })}>{d}</button>
            ))}
          </div>
          <input className="field field--time" type="time" aria-label="Starts" value={w.start}
            onChange={(e) => edit(i, { start: e.target.value })} />
          <span className="sched-dash">–</span>
          <input className="field field--time" type="time" aria-label="Ends" value={w.end}
            onChange={(e) => edit(i, { end: e.target.value })} />
          <div className="sched-locks">
            <span className="settings__muted">Lock:</span>
            {modes.map((m) => (
              <Checkbox key={m.id} className="lockchk" label={m.label}
                checked={w.lock.includes(m.id)}
                onChange={() => edit(i, {
                  lock: w.lock.includes(m.id) ? w.lock.filter((x) => x !== m.id) : [...w.lock, m.id],
                })} />
            ))}
          </div>
          <button className="btn btn--ghost btn--sm" onClick={() => remove(i)}>Remove</button>
        </div>
      ))}
      <button className="btn" onClick={add}>+ Window</button>
    </EditDialog>
  );
}

// ── Integrations ─────────────────────────────────────────────────────────────
//
// Each dialog owns a useDraft; its save callback stores through the API, hands
// the server's answer up to the card (so the page shows what is actually
// stored, normalised), and returns the next draft. Nothing below changed shape
// when it moved out of the page — only what wraps it.

function PcServiceTypesDialog({ roomId, initial, onSaved, onClose }: {
  roomId: string; initial: PcServiceType[]; onSaved: (types: PcServiceType[]) => void; onClose: () => void;
}) {
  const f = useDraft<PcServiceType[]>(structuredClone(initial), async (types) => {
    const stored = (await savePcServiceTypes(roomId, types)).serviceTypes;
    onSaved(stored);
    return stored;
  });
  const editType = (i: number, patch: Partial<PcServiceType>) =>
    f.setDraft((all) => all.map((x, j) => j === i ? { ...x, ...patch } : x));

  return (
    <EditDialog
      title="Planning Center service types"
      help="The event types this room hosts. The ID is in the Planning Center Services URL for that service type."
      form={f}
      onClose={onClose}
    >
      {f.draft.length === 0 && <p className="settings__muted">None — this room shows no Planning Center events.</p>}
      {f.draft.map((st, i) => (
        <FormRow key={i}>
          <Field label="Name" width="grow">
            <input className="field" placeholder="e.g. Sunday" value={st.name}
              onChange={(e) => editType(i, { name: e.target.value })} />
          </Field>
          <Field label="Service type ID">
            <input className="field" placeholder="e.g. 500001" inputMode="numeric" value={st.id}
              onChange={(e) => editType(i, { id: e.target.value })} />
          </Field>
          <div className="formrow__actions">
            <button className="iconbtn iconbtn--danger" title="Remove service type" aria-label="Remove service type"
              onClick={() => f.setDraft((all) => all.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
          </div>
        </FormRow>
      ))}
      <button className="btn" onClick={() => f.setDraft((all) => [...all, { id: '', name: '' }])}>
        + Add service type
      </button>
    </EditDialog>
  );
}

// Where the room's service is streamed. A channel id is the normal case: the
// video id changes every week, and the server finds whatever is live on the
// channel. A fixed video id is the escape hatch for a one-off broadcast.
interface YouTubeDraft {
  channelId: string;
}

const toYtDraft = (cfg: YouTubeConfig | null): YouTubeDraft => ({
  channelId: cfg?.channelId ?? '',
});

function YouTubeDialog({ roomId, initial, onSaved, onClose }: {
  roomId: string; initial: YouTubeConfig | null; onSaved: (cfg: YouTubeConfig | null) => void; onClose: () => void;
}) {
  const f = useDraft(toYtDraft(initial), async (d) => {
    const stored = await saveYouTube(
      roomId,
      d.channelId.trim() ? { channelId: d.channelId.trim() } : null,
    );
    onSaved(stored);
    return toYtDraft(stored);
  });
  const { draft } = f;

  return (
    <EditDialog
      title="YouTube Live"
      help="Records how many people watched the stream, for the show report. Needs a YouTube API key under Admin → General → Integrations. Viewer counts are only available while a broadcast is live — YouTube does not report them afterwards, so nothing is recorded for services that ran before this was set up. Find the channel ID in YouTube Studio → Settings → Channel → Advanced."
      form={f}
      onClose={onClose}
    >
      <FormRow>
        <Field label="Channel ID" width="grow">
          <input
            className="field"
            placeholder="e.g. UCxxxxxxxxxxxxxxxxxxxxxx"
            value={draft.channelId}
            onChange={(e) => f.patch({ channelId: e.target.value })}
          />
        </Field>
      </FormRow>
      <p className="settings__muted">
        Blank if this room isn’t streamed. Each service records whatever is live
        on the channel at the time — pick a specific broadcast on an event’s page
        only when that needs overriding.
      </p>
    </EditDialog>
  );
}

interface ObsDraft { host: string; port: string; password: string; hasPassword: boolean; }
const toObsDraft = (cfg: ObsConfig | null): ObsDraft => ({ host: cfg?.host ?? '', port: cfg?.port != null ? String(cfg.port) : '4455', password: '', hasPassword: Boolean(cfg?.hasPassword) });

function ObsDialog({ roomId, initial, onSaved, onClose }: {
  roomId: string; initial: ObsConfig | null; onSaved: (cfg: ObsConfig | null) => void; onClose: () => void;
}) {
  const f = useDraft(toObsDraft(initial), async (d) => {
    const stored = await saveObs(roomId, d.host.trim() ? {
      host: d.host.trim(), port: Number(d.port || 4455), ...(d.password ? { password: d.password } : {}),
    } : null);
    onSaved(stored);
    return toObsDraft(stored);
  });
  return (
    <EditDialog title="OBS Studio" help="In OBS Studio, open Tools → WebSocket Server Settings, enable the server, set a password, and use port 4455 (the default). ProdMesh monitors stream, recording, scene, audio, and frame health; it never controls OBS." form={f} onClose={onClose}>
      <FormRow>
        <Field label="Host or IP" width="grow"><input className="field" placeholder="e.g. 192.168.1.50" value={f.draft.host} onChange={(e) => f.patch({ host: e.target.value })} /></Field>
        <Field label="WebSocket port"><input className="field" inputMode="numeric" value={f.draft.port} onChange={(e) => f.patch({ port: e.target.value })} /></Field>
        <Field label={f.draft.hasPassword ? 'Password (set)' : 'Password'}><PasswordInput className="field" autoComplete="new-password" placeholder={f.draft.hasPassword ? 'unchanged' : 'OBS WebSocket password'} value={f.draft.password} onChange={(e) => f.patch({ password: e.target.value })} /></Field>
      </FormRow>
    </EditDialog>
  );
}

// Draft state as strings so the inputs stay controlled; the server normalises.
interface CaptionsDraft {
  source: 'none' | 'prodmesh-caption' | 'prodcom';
  host: string;
  port: string;
  key: string;
  hasKey: boolean;
  channels: string;
}

const toCapDraft = (c: CaptionsConfig | null): CaptionsDraft => ({
  source: c?.source ?? 'none',
  host: c?.host ?? '',
  port: c?.port != null ? String(c.port) : '',
  key: '',
  hasKey: Boolean(c?.hasKey),
  channels: (c?.channels ?? []).join(', '),
});

const CAPTION_PORTS: Record<string, string> = { 'prodmesh-caption': '8518', prodcom: '24480' };

function CaptionsDialog({ roomId, initial, onSaved, onClose }: {
  roomId: string; initial: CaptionsConfig | null; onSaved: (cfg: CaptionsConfig | null) => void; onClose: () => void;
}) {
  const f = useDraft(toCapDraft(initial), async (d) => {
    if (d.source === 'none') {
      const cleared = await saveCaptions(roomId, null);
      onSaved(cleared);
      return toCapDraft(cleared);
    }
    const channels = d.channels.split(',').map((c) => c.trim()).filter(Boolean);
    const stored = await saveCaptions(roomId, {
      source: d.source,
      host: d.host.trim(),
      ...(d.port.trim() ? { port: Number(d.port) } : {}),
      // Omitted entirely when left blank, which the server reads as "keep the
      // stored one" — this form is never sent the existing key.
      ...(d.key ? { key: d.key } : {}),
      ...(channels.length ? { channels } : {}),
    });
    onSaved(stored);
    return toCapDraft(stored);
  });
  const { draft } = f;

  return (
    <EditDialog
      title="Captions"
      help="Live transcript of the production comms channels, so the band can read what the music director and monitor engineer are saying. Shown by the Comms widget on a dashboard or display; nothing else surfaces it. prodmesh reads only — it never renames a channel or clears a transcript."
      form={f}
      onClose={onClose}
    >
      <FormRow>
        {/* "Caption app" rather than "Source": the analysis dialog has a
            Source, and two of them is ambiguous to a reader long before it is
            ambiguous to a test. */}
        <Field label="Caption app">
          <SelectField
            value={draft.source}
            onChange={(e) => {
              const source = e.target.value as CaptionsDraft['source'];
              // Swap the default port with the source, unless the port has been
              // typed over — a wrong default is worse than an empty box.
              const known = Object.values(CAPTION_PORTS);
              const port = !draft.port || known.includes(draft.port) ? (CAPTION_PORTS[source] ?? '') : draft.port;
              f.patch({ source, port });
            }}
          >
            <option value="none">None</option>
            <option value="prodmesh-caption">ProdMesh Caption</option>
            <option value="prodcom">ProdCom</option>
          </SelectField>
        </Field>
        {draft.source !== 'none' && (
          <>
            <Field label="Host" width="grow">
              <input className="field" placeholder="e.g. 192.168.1.150"
                value={draft.host} onChange={(e) => f.patch({ host: e.target.value })} />
            </Field>
            <Field label="Port">
              <input className="field" inputMode="numeric" placeholder={CAPTION_PORTS[draft.source] ?? ''}
                value={draft.port} onChange={(e) => f.patch({ port: e.target.value })} />
            </Field>
          </>
        )}
      </FormRow>

      {draft.source !== 'none' && (
        <FormRow>
          <Field label="Channels" width="grow">
            <input className="field" placeholder="blank for all — e.g. 0, 6"
              value={draft.channels} onChange={(e) => f.patch({ channels: e.target.value })} />
          </Field>
          {draft.source === 'prodcom' && (
            <Field label={draft.hasKey ? 'API key (set)' : 'API key'}>
              <PasswordInput className="field" autoComplete="new-password"
                placeholder={draft.hasKey ? 'unchanged' : 'only if PSK is enabled'}
                value={draft.key} onChange={(e) => f.patch({ key: e.target.value })} />
            </Field>
          )}
        </FormRow>
      )}

      {draft.source !== 'none' && (
        <p className="settings__muted">
          Channels are the speakers to show — a channel number for ProdMesh
          Caption, a channel name or ID for ProdCom. Leave blank for all of them.
        </p>
      )}
    </EditDialog>
  );
}

// Draft form state for the analysis source — everything as strings so the
// inputs stay controlled; the server normalizes numbers on save.
interface AnalysisDraft {
  source: 'none' | 'smaart' | 'rta' | 'open-sound-meter';
  host: string;
  port: string;
  password: string;
  logControl: boolean;
  // Not edited here — dB goals moved onto the widgets. They still ride through
  // the draft because this form PUTs a whole analysis object: omitting them
  // deleted the room's stored thresholds every time somebody saved a host.
  goals: { target?: number; limit?: number; metric?: string };
}

function toAnalysisDraft(cfg: AnalysisConfig | null): AnalysisDraft {
  return {
    source: cfg ? cfg.source : 'none',
    host: cfg?.host ?? '',
    port: cfg?.port != null ? String(cfg.port) : '',
    password: '',
    logControl: Boolean(cfg?.logControl),
    goals: {
      ...(cfg?.target != null ? { target: cfg.target } : {}),
      ...(cfg?.limit != null ? { limit: cfg.limit } : {}),
      ...(cfg?.metric ? { metric: cfg.metric } : {}),
    },
  };
}

function analysisFromDraft(d: AnalysisDraft): AnalysisConfig | null {
  if (d.source === 'none') return null;
  return {
    source: d.source,
    host: d.host || undefined,
    port: d.port === '' ? undefined : Number(d.port),
    logControl: d.source === 'smaart' && d.logControl ? true : undefined,
    ...d.goals,
    ...(d.password ? { password: d.password } : {}),
  };
}

function AnalysisDialog({ roomId, initial, onSaved, onClose }: {
  roomId: string; initial: AnalysisConfig | null; onSaved: (cfg: AnalysisConfig | null) => void; onClose: () => void;
}) {
  const [hasPassword, setHasPassword] = useState(Boolean(initial?.hasPassword));
  const [testState, setTestState] = useState<{ busy: boolean; ok?: boolean; detail?: string }>({ busy: false });
  const f = useDraft(toAnalysisDraft(initial), async (d) => {
    const stored = await saveAnalysis(roomId, analysisFromDraft(d));
    setHasPassword(Boolean(stored?.hasPassword));
    onSaved(stored);
    return toAnalysisDraft(stored);
  });
  const { draft } = f;
  const runTest = async () => {
    const analysis = analysisFromDraft(draft);
    if (!analysis) return;
    setTestState({ busy: true });
    try {
      setTestState({ busy: false, ...(await testAnalysisConnection(roomId, analysis)) });
    } catch (err) {
      setTestState({ busy: false, ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <EditDialog
      title="Analysis source"
      help="Where this room's SPL numbers come from — a Smaart rig, ProdMesh Remote RTA, or Open Sound Meter. Target and limit set the dB goals on the live meter and show reports."
      form={f}
      onClose={onClose}
    >
      <FormRow>
        <Field label="Source">
          <SelectField value={draft.source}
            onChange={(e) => f.patch({ source: e.target.value as AnalysisDraft['source'] })}>
            <option value="none">None</option>
            <option value="smaart">Smaart</option>
            <option value="rta">ProdMesh Remote RTA</option>
            <option value="open-sound-meter">Open Sound Meter</option>
          </SelectField>
        </Field>
        {draft.source !== 'none' && draft.source !== 'open-sound-meter' && (
          <>
            <Field label="Host" width="grow">
              <input className="field" placeholder="e.g. 192.168.1.120" value={draft.host}
                onChange={(e) => f.patch({ host: e.target.value })} />
            </Field>
            <Field label="Port" width="sm">
              <input className="field" inputMode="numeric"
                placeholder={draft.source === 'smaart' ? '26000' : '8517'} value={draft.port}
                onChange={(e) => f.patch({ port: e.target.value })} />
            </Field>
          </>
        )}
      </FormRow>

      {draft.source === 'smaart' && (
        <FormRow>
          <Field label="API password">
            <PasswordInput className="field" autoComplete="off"
              placeholder={hasPassword ? 'unchanged' : 'none'} value={draft.password}
              onChange={(e) => f.patch({ password: e.target.value })} />
          </Field>
        </FormRow>
      )}

      {draft.source === 'smaart' && (
        <FormRow>
          <Checkbox
            label={<>Start/stop SPL logging with shows
              <HelpTip text="Show start turns Smaart's SPL logging on; show end turns it off (only if the show turned it on). Needs a calibrated input in Smaart." />
            </>}
            checked={draft.logControl}
            onChange={(e) => f.patch({ logControl: e.target.checked })}
          />
        </FormRow>
      )}
      {draft.source === 'open-sound-meter' && (
        <p className="settings__muted">
          In Open Sound Meter, enable the Wi‑Fi icon’s <strong>Remote API Server</strong>.
          ProdMesh listens for multicast level packets at 239.255.42.42:49007; both
          computers must be on the same multicast-enabled network.
        </p>
      )}
      {draft.source !== 'none' && (
        <div className="fsection__actions">
          <button type="button" className="btn btn--secondary" onClick={runTest} disabled={testState.busy || f.busy}>
            {testState.busy ? 'Testing connection…' : 'Test connection'}
          </button>
          {testState.detail && <span className={testState.ok ? 'fsection__ok' : 'fsection__error'}>{testState.detail}</span>}
        </div>
      )}
    </EditDialog>
  );
}

// Draft form state for Companion + modes — everything stringly for controlled
// inputs; the server normalizes on save. A mode's button is optional: leaving
// page/row/col empty saves a mode with no Companion button.
interface ModeDraft {
  id: string;
  label: string;
  color: string;
  match: string;
  page: string;
  row: string;
  column: string;
  isStandby: boolean;
}

interface CompanionDraft {
  mock: boolean;
  roomMode: boolean;
  host: string;
  port: string;
  variable: string;
  emulator: string;
  modes: ModeDraft[];
}

function toModeDraft(m: ModeConfig): ModeDraft {
  return {
    id: m.id,
    label: m.label,
    color: m.color,
    match: m.match,
    page: m.press ? String(m.press.page) : '',
    row: m.press ? String(m.press.row) : '',
    column: m.press ? String(m.press.column) : '',
    isStandby: Boolean(m.isStandby),
  };
}

function toCompanionDraft(cfg: CompanionConfig | null): CompanionDraft {
  return {
    mock: cfg ? cfg.mock : true,
    roomMode: cfg?.roomMode !== false,
    host: cfg?.host ?? '',
    port: cfg?.port != null ? String(cfg.port) : '',
    variable: cfg?.variable ?? '',
    emulator: cfg?.emulator ?? '',
    modes: (cfg?.modes ?? []).map(toModeDraft),
  };
}

function CompanionDialog({ roomId, initial, onSaved, onClose }: {
  roomId: string; initial: CompanionConfig | null; onSaved: (cfg: CompanionConfig) => void; onClose: () => void;
}) {
  const f = useDraft(toCompanionDraft(initial), async (d) => {
    const stored = await saveCompanion(roomId, {
      mock: d.mock,
      ...(d.roomMode ? {} : { roomMode: false }),
      host: d.host || undefined,
      port: d.port === '' ? undefined : Number(d.port),
      variable: d.variable || undefined,
      ...(d.emulator ? { emulator: d.emulator } : {}),
      modes: d.modes.map((m) => ({
        id: m.id,
        label: m.label,
        color: m.color,
        match: m.match,
        ...(m.page === '' && m.row === '' && m.column === ''
          ? {}
          : { press: { page: Number(m.page), row: Number(m.row), column: Number(m.column) } }),
        ...(m.isStandby ? { isStandby: true } : {}),
      })),
    });
    onSaved(stored);
    return toCompanionDraft(stored);
  });
  const { draft } = f;
  const emulatorQuery = useQuery(
    draft.host && !draft.mock ? `companion-emulators:${roomId}:${draft.host}:${draft.port}` : null,
    () => getCompanionEmulators(roomId),
    { staleMs: 30_000 },
  );
  const emulators = emulatorQuery.data?.emulators ?? [];
  const setMode = (i: number, patch: Partial<ModeDraft>) =>
    f.setDraft((d) => ({ ...d, modes: d.modes.map((m, j) => (j === i ? { ...m, ...patch } : m)) }));
  const moveMode = (i: number, dir: -1 | 1) =>
    f.setDraft((d) => {
      const j = i + dir;
      if (j < 0 || j >= d.modes.length) return d;
      const modes = [...d.modes];
      [modes[i], modes[j]] = [modes[j], modes[i]];
      return { ...d, modes };
    });

  return (
    <EditDialog
      title="Bitfocus Companion & modes"
      form={f}
      onClose={onClose}
      wide
    >
      <FormRow>
        <Switch
          label="Enable Room Mode"
          checked={draft.roomMode}
          onChange={(e) => f.patch({ roomMode: e.target.checked })}
        />
      </FormRow>
      <FormRow>
        <Field label="Host" width="grow">
          <input className="field" placeholder="e.g. 192.168.1.100" value={draft.host}
            onChange={(e) => f.patch({ host: e.target.value })} />
        </Field>
        <Field label="Port" width="sm">
          <input className="field" inputMode="numeric" placeholder="8000"
            value={draft.port} onChange={(e) => f.patch({ port: e.target.value })} />
        </Field>
        <Field label="State variable">
          <input className="field" placeholder="roomState" value={draft.variable}
            onChange={(e) => f.patch({ variable: e.target.value })} />
        </Field>
      </FormRow>
      <FormRow>
        <Field label="Companion emulator">
          <select className="field" value={draft.emulator} disabled={!draft.host || draft.mock || emulatorQuery.loading}
            onChange={(e) => f.patch({ emulator: e.target.value })}>
            <option value="">{emulatorQuery.loading ? 'Loading emulators…' : 'Choose an emulator'}</option>
            {draft.emulator && !emulators.some((emulator) => emulator.id === draft.emulator) &&
              <option value={draft.emulator}>{draft.emulator} (currently selected)</option>}
            {emulators.map((emulator) => <option key={emulator.id} value={emulator.id}>{emulator.name}</option>)}
          </select>
        </Field>
        {emulatorQuery.error && <span className="settings__error">Couldn’t load Companion emulators. Check the host and Companion version.</span>}
      </FormRow>

      {draft.roomMode && <>
      <p className="settings__muted">Room Mode buttons — add only the controls this room needs. There is no fixed six-button layout.</p>
      {draft.modes.map((m, i) => (
        <FormRow card key={i}>
          <Field label="Color" width="xs">
            <ColorInput value={m.color} onChange={(e) => setMode(i, { color: e.target.value })} />
          </Field>
          <Field label="Label">
            <input className="field" value={m.label}
              onChange={(e) => setMode(i, { label: e.target.value })} />
          </Field>
          <Field label="ID">
            <input className="field" placeholder="e.g. sunday" value={m.id}
              onChange={(e) => setMode(i, { id: e.target.value })} />
          </Field>
          <Field label="Match">
            <input className="field" placeholder="e.g. SUNDAY" value={m.match}
              onChange={(e) => setMode(i, { match: e.target.value })} />
          </Field>
          <Field label="Page" width="sm">
            <input className="field" inputMode="numeric" value={m.page}
              onChange={(e) => setMode(i, { page: e.target.value })} />
          </Field>
          <Field label="Row" width="sm">
            <input className="field" inputMode="numeric" value={m.row}
              onChange={(e) => setMode(i, { row: e.target.value })} />
          </Field>
          <Field label="Col" width="sm">
            <input className="field" inputMode="numeric" value={m.column}
              onChange={(e) => setMode(i, { column: e.target.value })} />
          </Field>
          <Checkbox label="Standby" checked={m.isStandby}
            onChange={(e) => setMode(i, { isStandby: e.target.checked })} />
          <div className="formrow__actions">
            <button className="iconbtn" title="Move mode up" aria-label="Move mode up"
              onClick={() => moveMode(i, -1)}><ArrowUp size={14} /></button>
            <button className="iconbtn" title="Move mode down" aria-label="Move mode down"
              onClick={() => moveMode(i, 1)}><ArrowDown size={14} /></button>
            <button className="iconbtn iconbtn--danger" title="Remove mode" aria-label="Remove mode"
              onClick={() => f.setDraft((d) => ({ ...d, modes: d.modes.filter((_, j) => j !== i) }))}>
              <Trash2 size={14} /></button>
          </div>
        </FormRow>
      ))}

      <button className="btn" onClick={() => f.setDraft((d) => ({
        ...d,
        modes: [...d.modes, {
          id: '', label: '', color: '#5b8def', match: '',
          page: '', row: '', column: '', isStandby: false,
        }],
      }))}>+ Add mode</button>
      </>}
    </EditDialog>
  );
}

// Draft form state for ProPresenter — an empty host means "not in this room"
// and saves as a clear.
interface PpDraft {
  host: string;
  port: string;
  timer: string;
}

function toPpDraft(cfg: ProPresenterConfig | null): PpDraft {
  return {
    host: cfg?.host ?? '',
    port: cfg?.port != null ? String(cfg.port) : '',
    timer: cfg?.timer ?? '',
  };
}

function ProPresenterDialog({ roomId, initial, onSaved, onClose }: {
  roomId: string; initial: ProPresenterConfig | null; onSaved: (cfg: ProPresenterConfig | null) => void; onClose: () => void;
}) {
  const f = useDraft(toPpDraft(initial), async (d) => {
    const stored = await saveProPresenter(
      roomId,
      d.host.trim()
        ? {
            host: d.host,
            port: d.port === '' ? undefined : Number(d.port),
            timer: d.timer || undefined,
          }
        : null,
    );
    onSaved(stored);
    return toPpDraft(stored);
  });
  const { draft } = f;

  return (
    <EditDialog
      title="ProPresenter"
      help="The room's ProPresenter API (official, 7.9+) — drives Run of Show tracking and the service countdown. Leave the host empty if the room has no ProPresenter."
      form={f}
      onClose={onClose}
    >
      <FormRow>
        <Field label="Host" width="grow">
          <input className="field" placeholder="e.g. 192.168.1.110" value={draft.host}
            onChange={(e) => f.patch({ host: e.target.value })} />
        </Field>
        <Field label="Port" width="sm">
          <input className="field" inputMode="numeric" placeholder="62202"
            value={draft.port} onChange={(e) => f.patch({ port: e.target.value })} />
        </Field>
        <Field label="Countdown timer" width="grow">
          <input className="field" placeholder="First countdown timer" value={draft.timer}
            onChange={(e) => f.patch({ timer: e.target.value })} />
        </Field>
      </FormRow>
    </EditDialog>
  );
}
