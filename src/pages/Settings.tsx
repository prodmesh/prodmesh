import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowUp, CircleUser, MonitorCog, Trash2, X } from 'lucide-react';
import { Checkbox } from '../components/Checkbox';
import { HelpTip } from '../components/HelpTip';
import { EditDialog } from '../components/form/EditDialog';
import { Field } from '../components/form/Field';
import { FormRow } from '../components/form/FormRow';
import { useDraft } from '../components/form/useDraft';
import { useCan } from '../lib/identity';
import { PersonPicker } from '../components/PersonPicker';
import { PasswordInput } from '../components/PasswordInput';
import { SelectField } from '../components/SelectField';
import { IntegrationBrand, integrationInfo, type IntegrationId } from '../components/IntegrationBrand';
import { useChurch } from '../layout/church';
import { useQuery } from '../lib/useQuery';
import { viewsKey } from '../lib/keys';
import { allIds, slugId } from '../lib/topology';
import { Msg, fail, moveIn, ok, useChurchDraft, type Feedback } from './settingsShared';
import {
  getAuthStatus,
  loginAdmin,
  setPins,
  getSettings,
  getRooms,
  getViews,
  getVersion,
  triggerUpdate,
  getChecklistTemplates,
  saveChecklistTemplate,
  deleteChecklistTemplate,
  getUserDirectory,
  createUser,
  createGroup,
  updateGroup,
  setUserGroups,
  setUserActive,
  resetUserPin,
  getStations,
  updateStation,
  revokeStation,
  getServerLog,
  getAuditLog,
  getConfig,
  saveConfig,
  downloadBackup,
  PermissionError,
  type ServerLogTail,
  type AuditEntry,
  type RoomMeta,
  type ChecklistTemplatesInfo,
  type TemplateItem,
  type UserDirectory,
  type ManagedUser,
  type PermissionGroup,
  type ManagedStation,
  logoSrc,
  uploadLogo,
  clearLogo,
  getSecrets,
  saveSecrets,
  checkIntegrations,
  connectRestream,
  getRestreamConfig,
  checkResiConnection,
  getEnabledIntegrations,
  setIntegrationEnabled,
  type SecretGroup,
  type Version,
} from '../api';
import type { Church, Site } from '../types';
import logoUrl from '../assets/prodmesh-logo.svg';
type Phase = 'loading' | 'setup' | 'login' | 'admin';
type AdminSection = 'general' | 'integrations' | 'campuses' | 'room' | 'users' | 'stations' | 'checklists' | 'logs';

export function Settings({ section = 'general' }: { section?: AdminSection }) {
  const [phase, setPhase] = useState<Phase>('loading');

  const refreshStatus = useCallback(async () => {
    const s = await getAuthStatus();
    setPhase(s.admin ? 'admin' : s.setupNeeded ? 'setup' : 'login');
  }, []);

  useEffect(() => {
    refreshStatus();
    window.addEventListener('prodmesh:auth-changed', refreshStatus);
    return () => window.removeEventListener('prodmesh:auth-changed', refreshStatus);
  }, [refreshStatus]);

  const titles = {
    general: 'General',
    integrations: 'Integrations',
    users: 'Users & access',
    stations: 'Stations',
    campuses: 'Campuses',
    room: 'Room configuration',
    checklists: 'Checklists',
    logs: 'Logs',
  } as const;

  return (
    <div className="settings">
      <div className="pagehead">
        <div>
          <p className="eyebrow">Administration</p>
          <h1 className="pagehead__title">{titles[section]}</h1>
        </div>
      </div>

      {phase === 'loading' && <p className="settings__muted">Loading…</p>}
      {phase === 'setup' && <SetupForm onDone={refreshStatus} />}
      {phase === 'login' && <LoginForm onDone={refreshStatus} />}
      {phase === 'admin' && <AdminPanels section={section} />}
    </div>
  );
}

// ── First-run: create the Admin PIN ───────────────────────────────────────────
function SetupForm({ onDone }: { onDone: () => void }) {
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    // First-run sets the ADMIN PIN. It is the built-in `admin` account's PIN
    // (ADR 0012), so this is creating an administrator, not a second kind of
    // authority — hence the floor: six characters, checked again server-side.
    if (pin.length < 6) return setErr('Use at least 6 characters.');
    if (pin !== confirm) return setErr('PINs do not match.');
    await setPins({ admin: pin });
    await loginAdmin(pin);
    onDone();
  };

  return (
    <section className="panel">
      <h2 className="panel__title">Create Admin PIN</h2>
      <p className="settings__muted">This protects Settings and system updates.</p>
      <PasswordInput className="field" inputMode="numeric" placeholder="New admin PIN"
        value={pin} onChange={(e) => setPin(e.target.value)} />
      <PasswordInput className="field" inputMode="numeric" placeholder="Confirm PIN"
        value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      {err && <p className="settings__error">{err}</p>}
      <button className="btn btn--primary" onClick={submit}>Create PIN</button>
    </section>
  );
}

// ── Login with Admin PIN ───────────────────────────────────────────────────────
function LoginForm({ onDone }: { onDone: () => void }) {
  const [pin, setPin] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setErr(null);
    if (await loginAdmin(pin)) onDone();
    else setErr('Incorrect PIN.');
  };

  return (
    <section className="panel">
      <h2 className="panel__title">Enter Admin PIN</h2>
      <PasswordInput className="field" inputMode="numeric" placeholder="Admin PIN"
        value={pin} onChange={(e) => setPin(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()} autoFocus />
      {err && <p className="settings__error">{err}</p>}
      <button className="btn btn--primary" onClick={submit}>Unlock</button>
    </section>
  );
}

// ── Admin panels ───────────────────────────────────────────────────────────────
function AdminPanels({ section }: { section: AdminSection }) {
  return (
    <>
      {section === 'general' && <><BrandingPanel /><SecurityPanel /><SystemPanel /></>}
      {section === 'integrations' && <><IntegrationEnablePanel /><SecretsPanel /></>}
      {section === 'campuses' && <CampusesPanel />}
      {section === 'room' && <RoomConfigPanel />}
      {section === 'users' && <UserManagementPanel />}
      {section === 'stations' && <StationsPanel />}
      {section === 'checklists' && <ChecklistsPanel />}
      {section === 'logs' && <LogsPanel />}
    </>
  );
}

// ── Save/action feedback ─────────────────────────────────────────────────────
//  Success is green, errors are red — a panel must never announce a failure in
//  the success color, so panels carry the kind alongside the text.
const toggle = (values: string[], value: string) =>
  values.includes(value) ? values.filter((x) => x !== value) : [...values, value];

/** The users screen refuses in ways that need explaining rather than echoing:
 *  each is a deliberate guard, and a bare "403" tells nobody what to do next. */
function guardError(err: unknown, who: string): Feedback {
  const code = String((err as Error)?.message ?? err);
  if (code.includes('cannot_change_own_groups')) {
    return { kind: 'err', text: 'You cannot change your own groups. Ask another administrator.' };
  }
  if (code.includes('cannot_grant_unheld_permissions')) {
    return { kind: 'err', text: `You can only grant permissions you hold yourself, so ${who}'s access was not changed.` };
  }
  if (code.includes('cannot_manage_higher_privilege')) {
    return { kind: 'err', text: `${who} holds permissions you do not, so only a full administrator can change their access.` };
  }
  if (code.includes('cannot_deactivate_yourself')) {
    return { kind: 'err', text: 'You cannot revoke your own access — nobody could undo it but you.' };
  }
  return fail(err);
}

export function UserManagementPanel() {
  const [directory, setDirectory] = useState<UserDirectory | null>(null);
  const [resetting, setResetting] = useState<ManagedUser | null>(null);
  const [editingGroup, setEditingGroup] = useState<PermissionGroup | null>(null);
  // Only a full administrator may reset somebody else's PIN — see the route.
  // Guidance, not enforcement: an identity that has not loaded yet answers yes
  // (see lib/identity), so this hides the button from someone known to lack
  // '*' and leaves the server to refuse everyone else.
  const isFullAdmin = useCan('*');
  const [user, setUser] = useState({ displayName: '', username: '', pin: '', planningCenterPersonId: '' });
  const [userGroups, setUserGroupsDraft] = useState<string[]>([]);
  const [groupName, setGroupName] = useState('');
  const [groupPermissions, setGroupPermissions] = useState<string[]>([]);
  const [msg, setMsg] = useState<Feedback>(null);

  const refresh = () => getUserDirectory().then(setDirectory).catch((err) => setMsg(fail(err)));
  useEffect(() => { refresh(); }, []);

  if (!directory) return null;

  const addUser = async () => {
    setMsg(null);
    try {
      await createUser({
        ...user,
        planningCenterPersonId: user.planningCenterPersonId || null,
        groupIds: userGroups,
      });
      setUser({ displayName: '', username: '', pin: '', planningCenterPersonId: '' });
      setUserGroupsDraft([]);
      setMsg(ok('User created.'));
      refresh();
    } catch (err) { setMsg(fail(err)); }
  };

  const addGroup = async () => {
    setMsg(null);
    try {
      await createGroup(groupName, groupPermissions);
      setGroupName(''); setGroupPermissions([]); setMsg(ok('Permission group created.'));
      refresh();
    } catch (err) { setMsg(fail(err)); }
  };

  return (
    <section className="panel users">
      <div>
        <p className="section-label">Access control</p>
        <h2 className="panel__title">Users &amp; permissions
          <HelpTip text="Access is the union of a user's groups. Administrators always have every permission." />
        </h2>
      </div>

      <div className="users__grid">
        <div className="users__editor">
          <h3>Create user</h3>
          <input className="field" placeholder="Display name" value={user.displayName} onChange={(e) => setUser({ ...user, displayName: e.target.value })} />
          <input className="field" placeholder="Username" autoCapitalize="none" value={user.username} onChange={(e) => setUser({ ...user, username: e.target.value })} />
          <PasswordInput className="field" placeholder="PIN" inputMode="numeric" value={user.pin} onChange={(e) => setUser({ ...user, pin: e.target.value })} />
          <PersonPicker value={user.planningCenterPersonId} onChange={(personId) => setUser({ ...user, planningCenterPersonId: personId })} />
          <div className="users__checks">
            {directory.groups.map((group) => (
              <Checkbox key={group.id} label={group.name} checked={userGroups.includes(group.id)} onChange={() => setUserGroupsDraft(toggle(userGroups, group.id))} />
            ))}
          </div>
          <button className="btn btn--primary" disabled={!user.displayName || !user.username || user.pin.length < 4} onClick={addUser}>Create user</button>
        </div>

        <div className="users__editor">
          <h3>Create permission group</h3>
          <input className="field" placeholder="Group name" value={groupName} onChange={(e) => setGroupName(e.target.value)} />
          <div className="users__checks users__checks--permissions">
            {directory.permissions.map((permission) => (
              <Checkbox key={permission.id} label={<><strong>{permission.label}</strong><small>{permission.id}</small></>} checked={groupPermissions.includes(permission.id)} onChange={() => setGroupPermissions(toggle(groupPermissions, permission.id))} />
            ))}
          </div>
          <button className="btn btn--primary" disabled={groupName.trim().length < 2} onClick={addGroup}>Create group</button>
        </div>
      </div>

      {/* Groups were create-only, so a permission set was fixed the moment it
          was made and the way to change one was to make another. A summary row
          that opens a dialog, following the room cards (#23): seventeen
          checkboxes per group inline turned this list into a wall of them, and
          the answer a reader wants from a row is "what does this group do",
          not "which of seventeen boxes are ticked".

          Administrators is not here — its every-permission is computed from
          system_key rather than stored, so there is nothing to edit. */}
      <div className="users__list">
        <h3>Permission groups</h3>
        {directory.groups.filter((group) => group.permissions?.[0] !== '*').map((group) => (
          <div className="users__row users__row--group" key={group.id}>
            <div className="users__identity">
              <span><strong>{group.name}</strong><small>
                {group.permissions.length
                  ? `${group.permissions.length} permission${group.permissions.length === 1 ? '' : 's'}`
                  : 'No permissions — members get read-only access'}
              </small></span>
            </div>
            {/* The labels, not the ids: this line is the answer to "what does
                this group let someone do". */}
            <p className="users__summary">
              {group.permissions.length
                ? directory.permissions
                  .filter((permission) => group.permissions.includes(permission.id))
                  .map((permission) => permission.label)
                  .join(' · ')
                : '—'}
            </p>
            <div className="users__actions">
              <button className="btn btn--sm" onClick={() => setEditingGroup(group)}>Edit</button>
            </div>
          </div>
        ))}
      </div>

      <div className="users__list">
        <h3>Current users</h3>
        {/* @admin is always here now (ADR 0012), so an empty list is no longer
            possible — "nobody yet" means nobody BUT the built-in account. */}
        {directory.users.every((entry) => entry.username === 'admin') && (
          <p className="settings__muted">No named users yet — only the built-in @admin. Add people so the audit log records who did what.</p>
        )}
        {directory.users.map((entry) => (
          <div className={`users__row${entry.active ? '' : ' users__row--revoked'}`} key={entry.id}>
            <div className="users__identity">
              <span className="users__avatar" role="img" aria-label={`${entry.displayName} avatar`}>
                {entry.avatarUrl
                  ? <img src={entry.avatarUrl} alt="" />
                  : <CircleUser size={28} />}
              </span>
              <span><strong>{entry.displayName}</strong><small>@{entry.username}{entry.planningCenterPersonId ? ` · PCO ${entry.planningCenterPersonId}` : ''}{entry.active ? '' : ' · access revoked'}</small></span>
            </div>
            <div className="users__groups">
              {directory.groups.map((group) => {
                const checked = entry.groups.some((g) => g.id === group.id);
                return <Checkbox key={group.id} label={group.name} checked={checked} disabled={!entry.active} onChange={async () => {
                  const next = toggle(entry.groups.map((g) => g.id), group.id);
                  // The server refuses self-promotion and granting authority
                  // you do not hold. Those refusals are the screen's job to
                  // explain — an unhandled throw here just made the checkbox
                  // silently spring back.
                  try {
                    await setUserGroups(entry.id, next);
                    setMsg(ok(`Updated ${entry.displayName}'s groups.`));
                  } catch (err) {
                    setMsg(guardError(err, entry.displayName));
                  }
                  refresh();
                }} />;
              })}
            </div>
            <div className="users__actions">
              {/* @admin's PIN lives in Admin → General and its access cannot be
                  revoked — it is the way back into a box in a building. */}
              {entry.username !== 'admin' && (
                <>
                  {isFullAdmin && (
                    <button className="btn btn--sm" onClick={() => setResetting(entry)}>Reset PIN</button>
                  )}
                  <button
                    className={`btn btn--sm${entry.active ? ' btn--danger' : ''}`}
                    onClick={async () => {
                      try {
                        await setUserActive(entry.id, !entry.active);
                        setMsg(ok(entry.active
                          ? `${entry.displayName} can no longer sign in.`
                          : `${entry.displayName} can sign in again.`));
                      } catch (err) {
                        setMsg(guardError(err, entry.displayName));
                      }
                      refresh();
                    }}
                  >
                    {entry.active ? 'Revoke access' : 'Restore access'}
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
      <Msg msg={msg} />
      {editingGroup && (
        <GroupDialog
          group={editingGroup}
          permissions={directory.permissions}
          onClose={() => setEditingGroup(null)}
          onSaved={(name) => { setEditingGroup(null); setMsg(ok(`Updated ${name}.`)); refresh(); }}
        />
      )}
      {resetting && (
        <ResetPinDialog
          user={resetting}
          onClose={() => setResetting(null)}
          onDone={(text) => { setResetting(null); setMsg(ok(text)); refresh(); }}
        />
      )}
    </section>
  );
}

/** Edit one group's permissions behind a single Save.
 *
 *  Deliberately not save-per-checkbox like the user rows above. Those toggle
 *  one membership; this is a permission SET, where the intermediate states on
 *  the way to what somebody meant are real grants — each one written, audited,
 *  and live for whoever is signed in at the time. One Save keeps the
 *  half-finished thought out of the database.
 */
function GroupDialog({ group, permissions, onClose, onSaved }: {
  group: PermissionGroup;
  permissions: { id: string; label: string; description: string }[];
  onClose: () => void;
  onSaved: (name: string) => void;
}) {
  const f = useDraft({ name: group.name, permissions: group.permissions }, async (draft) => {
    const stored = await updateGroup(group.id, { name: draft.name, permissions: draft.permissions });
    onSaved(stored.name);
    return { name: stored.name, permissions: stored.permissions };
  });
  const { draft } = f;

  return (
    <EditDialog
      title={`Edit ${group.name}`}
      help="A member's access is the union of every group they are in. Removing a permission here removes it from everyone in this group."
      form={f}
      onClose={onClose}
      wide
    >
      <FormRow>
        <Field label="Group name" width="grow">
          <input className="field" value={draft.name} onChange={(e) => f.patch({ name: e.target.value })} />
        </Field>
      </FormRow>
      <div className="users__checks users__checks--permissions">
        {permissions.map((permission) => (
          <Checkbox
            key={permission.id}
            label={<><strong>{permission.label}</strong><small>{permission.description}</small></>}
            checked={draft.permissions.includes(permission.id)}
            onChange={() => f.patch({ permissions: toggle(draft.permissions, permission.id) })}
          />
        ))}
      </div>
    </EditDialog>
  );
}

/** Give somebody a new PIN when they have forgotten theirs. Their sessions end
 *  with the old credential, so this is a reset and not a peek: nobody, this
 *  screen included, can read what the PIN used to be. */
function ResetPinDialog({ user, onClose, onDone }: {
  user: ManagedUser; onClose: () => void; onDone: (text: string) => void;
}) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Escape closes it. A dialog that declares aria-modal and then offers only a
  // close button leaves keyboard users hunting for the one way out.
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [onClose]);

  return (
    <div className="identity" role="dialog" aria-modal="true" aria-labelledby="resetpin-title">
      <div className="identity__card">
        <button className="identity__close" onClick={onClose} aria-label="Close"><X size={17} /></button>
        <p className="eyebrow">@{user.username}</p>
        <h2 id="resetpin-title">Set a new PIN for {user.displayName}</h2>
        <p className="identity__hint">
          They are signed out everywhere as soon as it changes. Tell them the new
          PIN yourself — it cannot be read back afterwards.
        </p>
        <label className="identity__field">
          <span>New PIN</span>
          <PasswordInput className="field mono" inputMode="numeric" autoComplete="new-password"
            value={pin} onChange={(e) => setPin(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && pin.length >= 4 && submit()} />
        </label>
        <button className="btn btn--primary identity__submit" disabled={busy || pin.length < 4} onClick={submit}>
          Set PIN
        </button>
        {error && <p className="identity__error">{error}</p>}
      </div>
    </div>
  );

  async function submit() {
    setBusy(true); setError('');
    try {
      await resetUserPin(user.id, pin);
      onDone(`${user.displayName}'s PIN is set. They are signed out everywhere.`);
    } catch (err) {
      setError(String((err as Error).message ?? err));
      setBusy(false);
    }
  }
}

// ── Registered browser stations ─────────────────────────────────────────────
function relativeTime(timestamp: number) {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'Just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return new Date(timestamp).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

export function StationsPanel() {
  const [stations, setStations] = useState<ManagedStation[]>([]);
  const [rooms, setRooms] = useState<RoomMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<Feedback>(null);
  const [revokeTarget, setRevokeTarget] = useState<ManagedStation | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [stationResult, roomResult] = await Promise.all([getStations(), getRooms()]);
      setStations(stationResult.stations);
      setRooms(roomResult);
    } catch (err) {
      setMessage(fail(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const remove = async () => {
    if (!revokeTarget) return;
    setMessage(null);
    try {
      const result = await revokeStation(revokeTarget.id);
      setRevokeTarget(null);
      if (!result.current) {
        setMessage(ok('Station revoked. Its browser will be asked to register again.'));
        refresh();
      }
    } catch (err) {
      setMessage(fail(err));
    }
  };

  if (loading) return <p className="settings__muted">Loading stations…</p>;

  return (
    <section className="panel stations">
      <div>
        <p className="section-label">Browser identity</p>
        <h2 className="panel__title">Registered stations
          <HelpTip text="A station identifies which browser an action came from. Revoking one signs out its sessions and returns that browser to first-run registration." />
        </h2>
      </div>

      <div className="stations__list">
        {stations.length === 0 && <p className="settings__muted">No registered stations.</p>}
        {stations.map((station) => (
          <StationEditor
            key={station.id}
            station={station}
            rooms={rooms}
            onSaved={(updated) => {
              setStations((all) => all.map((entry) => entry.id === updated.id ? { ...updated, current: station.current } : entry));
              setMessage(ok('Station updated.'));
            }}
            onRevoke={() => setRevokeTarget(station)}
          />
        ))}
      </div>
      <Msg msg={message} />

      {revokeTarget && (
        <div className="confirm" role="dialog" aria-modal="true" aria-labelledby="revoke-station-title">
          <div className="confirm__card">
            <p className="eyebrow">Revoke station</p>
            <p className="confirm__text" id="revoke-station-title">
              Unregister <strong>{revokeTarget.name}</strong>? Its browser will return to station registration.
            </p>
            <div className="confirm__buttons">
              <button className="confirm__cancel" onClick={() => setRevokeTarget(null)}>Cancel</button>
              <button className="confirm__ok" onClick={remove}>Revoke station</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function StationEditor({
  station,
  rooms,
  onSaved,
  onRevoke,
}: {
  station: ManagedStation;
  rooms: RoomMeta[];
  onSaved: (station: ManagedStation) => void;
  onRevoke: () => void;
}) {
  const church = useChurch();
  const [name, setName] = useState(station.name);
  const [campusId, setCampusId] = useState(station.campusId ?? '');
  const [roomId, setRoomId] = useState(station.roomId ?? '');
  const [roomOnly, setRoomOnly] = useState(station.roomOnly ?? false);
  const [viewId, setViewId] = useState(station.viewId ?? '');
  const [busy, setBusy] = useState(false);

  // A display belongs to the room the station stands in — the server refuses
  // any other pairing, so offer only what it would accept.
  const displays = useQuery(
    roomId ? viewsKey(roomId) : null,
    () => getViews(roomId),
    { staleMs: 30_000 },
  ).data?.views.filter((view) => view.kind === 'display') ?? [];

  const campusRooms = rooms.filter((room) => !campusId || room.site === campusId);
  const dirty =
    name !== station.name ||
    campusId !== (station.campusId ?? '') ||
    roomId !== (station.roomId ?? '') ||
    viewId !== (station.viewId ?? '') ||
    (roomId !== '' && roomOnly !== (station.roomOnly ?? false));

  const save = async () => {
    setBusy(true);
    try {
      onSaved(await updateStation(station.id, {
        name,
        campusId: campusId || null,
        roomId: roomId || null,
        roomOnly: Boolean(roomId) && roomOnly,
        viewId: (roomId && viewId) || null,
      }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stations__row">
      <div className="stations__identity">
        <span className="stations__icon"><MonitorCog size={19} /></span>
        <span>
          <strong>{station.name}</strong>
          <small>{station.current ? 'CURRENT STATION · ' : ''}Last seen {relativeTime(station.lastSeen)}</small>
        </span>
      </div>
      <div className="stations__fields">
        <label><span>Name</span><input className="field" value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>
          <span>Campus</span>
          <SelectField value={campusId} onChange={(event) => {
            setCampusId(event.target.value);
            if (roomId && rooms.find((room) => room.id === roomId)?.site !== event.target.value) setRoomId('');
          }}>
            <option value="">Unassigned</option>
            {church.sites.filter((site) => site.status === 'active').map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
          </SelectField>
        </label>
        <label>
          <span>Room</span>
          <SelectField value={roomId} onChange={(event) => {
            const nextRoom = rooms.find((room) => room.id === event.target.value);
            setRoomId(event.target.value);
            if (nextRoom) setCampusId(nextRoom.site ?? '');
            // The display belonged to the old room; keeping it would be a
            // save the server refuses.
            setViewId('');
          }}>
            <option value="">No room</option>
            {campusRooms.map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}
          </SelectField>
        </label>
        <label>
          <span>Display <HelpTip text="This browser shows that display full-screen with no navigation — a Raspberry Pi on a multiview input, or a TV in the foyer. It still works as an ordinary browser until you open it." /></span>
          <SelectField
            value={viewId}
            disabled={!roomId || displays.length === 0}
            title={roomId ? undefined : 'Assign a room first'}
            onChange={(event) => setViewId(event.target.value)}
          >
            <option value="">{displays.length ? 'Not a display' : 'No displays in this room'}</option>
            {displays.map((view) => <option key={view.id} value={view.id}>{view.name}</option>)}
          </SelectField>
        </label>
        <Checkbox
          label="Room only when locked"
          title={roomId
            ? 'In read-only mode (nobody logged in), this station only browses its assigned room. Logging in unlocks everything.'
            : 'Assign a room first'}
          checked={Boolean(roomId) && roomOnly}
          disabled={!roomId}
          onChange={(event) => setRoomOnly(event.target.checked)}
        />
      </div>
      <div className="stations__actions">
        <button className="btn btn--primary btn--sm" disabled={!dirty || busy || name.trim().length < 2} onClick={save}>Save</button>
        <button className="btn btn--ghost btn--sm stations__revoke" onClick={onRevoke}><Trash2 size={13} /> Revoke</button>
      </div>
    </div>
  );
}

// ── Checklist templates (per event type) ──────────────────────────────────────
const DEFAULT_KEY = '*';

function ChecklistsPanel() {
  const [info, setInfo] = useState<ChecklistTemplatesInfo | null>(null);
  const [selected, setSelected] = useState(DEFAULT_KEY);
  const [draft, setDraft] = useState<TemplateItem[] | null>(null);
  const [msg, setMsg] = useState<Feedback>(null);

  useEffect(() => {
    getChecklistTemplates()
      .then((i) => {
        setInfo(i);
        setDraft(i.templates[DEFAULT_KEY] ?? null);
      })
      .catch(() => {});
  }, []);

  if (!info) return null;

  const typeName = (id: string) =>
    id === DEFAULT_KEY
      ? 'Default (any other event)'
      : info.serviceTypes.find((s) => s.id === id)?.name ?? `Type ${id}`;

  // Event types worth listing: the default, everything mapped on a room, plus
  // any template saved for a type we no longer map (so it stays editable).
  const typeIds = [
    DEFAULT_KEY,
    ...info.serviceTypes.map((s) => s.id),
    ...Object.keys(info.templates).filter(
      (id) => id !== DEFAULT_KEY && !info.serviceTypes.some((s) => s.id === id),
    ),
  ];

  const pick = (id: string) => {
    setSelected(id);
    setDraft(info.templates[id] ?? null);
    setMsg(null);
  };

  const edit = (i: number, patch: Partial<TemplateItem>) =>
    setDraft((d) => d!.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  const move = (i: number, delta: number) =>
    setDraft((d) => {
      const next = [...d!];
      const j = i + delta;
      if (j < 0 || j >= next.length) return d!;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const save = async () => {
    setMsg(null);
    try {
      const templates = await saveChecklistTemplate(selected, draft ?? []);
      setInfo((x) => x && { ...x, templates });
      setDraft(templates[selected] ?? []);
      setMsg(ok('Template saved.'));
    } catch (err) {
      setMsg(fail(err));
    }
  };

  const removeTemplate = async () => {
    setMsg(null);
    try {
      const templates = await deleteChecklistTemplate(selected);
      setInfo((x) => x && { ...x, templates });
      setDraft(templates[selected] ?? null);
      setMsg(ok(selected === DEFAULT_KEY ? 'Default template removed.' : 'Now using the Default template.'));
    } catch (err) {
      setMsg(fail(err));
    }
  };

  const hasOwn = Boolean(info.templates[selected]);

  return (
    <section className="panel">
      <h2 className="panel__title">Checklists</h2>

      <div className="tpl-types">
        {typeIds.map((id) => (
          <button
            key={id}
            className={`typebtn${selected === id ? ' typebtn--on' : ''}`}
            onClick={() => pick(id)}
          >
            {typeName(id)}
            {id !== DEFAULT_KEY && !info.templates[id] && (
              <span className="typebtn__uses">default</span>
            )}
          </button>
        ))}
      </div>

      {draft === null ? (
        <div className="tpl-fallback">
          <p className="settings__muted">
            <strong>{typeName(selected)}</strong> uses the Default template
            {(info.templates[DEFAULT_KEY] ?? []).length
              ? ` (${info.templates[DEFAULT_KEY]!.length} items)`
              : ' (currently empty)'}
            .
          </p>
          <button
            className="btn btn--sm"
            onClick={() => setDraft(structuredClone(info.templates[DEFAULT_KEY] ?? []))}
          >
            Customize for this event type
          </button>
        </div>
      ) : (
        <>
          {draft.length === 0 && <p className="settings__muted">No items yet.</p>}
          {draft.map((it, i) => (
            <div key={it.id ?? `new-${i}`} className="tpl-item">
              <div className="tpl-item__order">
                <button className="orderbtn" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">
                  <ArrowUp size={13} />
                </button>
                <button className="orderbtn" disabled={i === draft.length - 1} onClick={() => move(i, 1)} aria-label="Move down">
                  <ArrowDown size={13} />
                </button>
              </div>
              <input
                className="field tpl-item__label"
                value={it.label}
                placeholder="What needs to happen?"
                onChange={(e) => edit(i, { label: e.target.value })}
              />
              <SelectField
                className="tpl-item__action"
                value={it.action?.mode ?? ''}
                onChange={(e) =>
                  edit(i, { action: e.target.value ? { type: 'mode', mode: e.target.value } : null })
                }
              >
                <option value="">Manual check</option>
                {info.modes.map((m) => (
                  <option key={m.id} value={m.id}>
                    ⚡ Set room to {m.label}
                  </option>
                ))}
              </SelectField>
              <button
                className="btn btn--ghost btn--sm"
                onClick={() => setDraft((d) => d!.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            </div>
          ))}
          <div className="settings__toolbar">
            <button className="btn btn--sm" onClick={() => setDraft((d) => [...(d ?? []), { label: '' }])}>
              + Item
            </button>
            <button className="btn btn--primary" onClick={save}>
              Save template
            </button>
            {hasOwn && selected !== DEFAULT_KEY && (
              <button className="btn btn--ghost" onClick={removeTemplate}>
                Remove (use Default)
              </button>
            )}
            <Msg msg={msg} inline />
          </div>
        </>
      )}
    </section>
  );
}

function SecurityPanel() {
  const [overrideSet, setOverrideSet] = useState(false);
  const [adminPin, setAdminPin] = useState('');
  const [overridePin, setOverridePin] = useState('');
  const [msg, setMsg] = useState<Feedback>(null);

  useEffect(() => {
    getSettings().then((s) => setOverrideSet(s.pins.overrideSet)).catch(() => {});
  }, []);

  const saveAdmin = async () => {
    // Longer than the override PIN on purpose: this one unlocks a token that
    // bypasses every permission check, while the override only clears a room
    // mode change for someone already standing at the booth. Server enforces
    // the same floor — this is just a faster, kinder error.
    if (adminPin.length < 6) return setMsg(fail('Admin PIN must be at least 6 characters.'));
    try {
      await setPins({ admin: adminPin });
      setAdminPin(''); setMsg(ok('Admin PIN updated. Sign in again with the new PIN.'));
    } catch (err) { setMsg(fail(err)); }
  };
  const saveOverride = async () => {
    if (overridePin.length < 4) return setMsg(fail('Override PIN must be ≥ 4 digits.'));
    try {
      await setPins({ override: overridePin });
      setOverridePin(''); setOverrideSet(true); setMsg(ok('Override PIN updated.'));
    } catch (err) { setMsg(fail(err)); }
  };
  const clearOverride = async () => {
    try {
      await setPins({ override: '' });
      setOverrideSet(false); setMsg(ok('Override PIN cleared — mode locks are now inactive.'));
    } catch (err) { setMsg(fail(err)); }
  };

  return (
    <section className="panel">
      <h2 className="panel__title">Security</h2>
      <div className="panel__row">
        <div>
          <div className="panel__label">Admin PIN</div>
          {/* Two must-know facts, so neither hides in a tooltip: whose PIN this
              is (it logs in as @admin from the ordinary login box too), and
              that changing it ends every session that account has open —
              which is also how you sign it out of a station you have walked
              away from. */}
          <div className="settings__muted">The @admin account’s PIN. Protects Settings + system updates. Changing it signs @admin out everywhere.</div>
        </div>
        <div className="panel__controls">
          <PasswordInput className="field field--sm" inputMode="numeric" placeholder="New admin PIN"
            value={adminPin} onChange={(e) => setAdminPin(e.target.value)} />
          <button className="btn" onClick={saveAdmin}>Update</button>
        </div>
      </div>
      <div className="panel__row">
        <div>
          <div className="panel__label">Override PIN {overrideSet
            ? <span className="pill pill--on">set</span>
            : <span className="pill pill--off">not set</span>}</div>
          <div className="settings__muted">Unlocks locked mode changes during protected windows.</div>
        </div>
        <div className="panel__controls">
          <PasswordInput className="field field--sm" inputMode="numeric" placeholder="New override PIN"
            value={overridePin} onChange={(e) => setOverridePin(e.target.value)} />
          <button className="btn" onClick={saveOverride}>Update</button>
          {overrideSet && <button className="btn btn--ghost" onClick={clearOverride}>Clear</button>}
        </div>
      </div>
      <Msg msg={msg} />
    </section>
  );
}

const secretGroupIntegration = (id: string): IntegrationId => ({
  planningCenter: 'planning-center', slack: 'slack', youtube: 'youtube', restream: 'restream', resi: 'resi',
}[id] as IntegrationId | undefined) ?? 'prodmesh';

const INTEGRATION_GROUPS: Array<{ title: string; description: string; integrations: IntegrationId[] }> = [
  {
    title: 'Planning & Scheduling',
    description: 'Build services, schedules, teams, and run-of-show information.',
    integrations: ['planning-center'],
  },
  {
    title: 'Presentation & Show Control',
    description: 'Control presentations and connect room automation.',
    integrations: ['propresenter', 'companion'],
  },
  {
    title: 'Audio',
    description: 'Measure live SPL and monitor loudness over time.',
    integrations: ['open-sound-meter', 'smaart', 'prodmesh-rta'],
  },
  {
    title: 'Video & Streaming',
    description: 'Monitor broadcasts, destinations, and audience activity.',
    integrations: ['youtube', 'restream', 'resi'],
  },
  {
    title: 'Communication',
    description: 'Keep the booth and team connected with captions and messaging.',
    integrations: ['slack', 'captions', 'prodcom'],
  },
];

function IntegrationEnablePanel() {
  const [enabled, setEnabled] = useState<Record<string, boolean> | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [msg, setMsg] = useState<Feedback>(null);
  const refresh = useCallback(() => { getEnabledIntegrations().then((state) => setEnabled(state.enabled)).catch((err) => setMsg(fail(err))); }, []);
  useEffect(refresh, [refresh]);

  const toggle = async (id: IntegrationId) => {
    if (!enabled) return;
    const next = !(enabled[id] ?? true);
    setSaving(id); setMsg(null);
    try {
      const state = await setIntegrationEnabled(id, next);
      setEnabled(state.enabled);
      // The credential-management cards live in a sibling panel. Tell them
      // about the saved state so they appear or disappear immediately.
      window.dispatchEvent(new CustomEvent('prodmesh:integrations-changed', { detail: state.enabled }));
    } catch (err) { setMsg(fail(err)); }
    finally { setSaving(null); }
  };

  return <section className="panel">
    <p className="section-label">Availability</p>
    <h2 className="panel__title">Enabled integrations</h2>
    <p className="settings__muted">Turn off integrations your organization does not use. Their stored credentials remain intact, but their widgets are unavailable on new dashboards until re-enabled.</p>
    <div className="integration-groups">
      {INTEGRATION_GROUPS.map((group) => <section className="integration-group" key={group.title}>
        <div className="integration-group__head">
          <h3>{group.title}</h3>
          <p>{group.description}</p>
        </div>
        <div className="integration-switches">
          {group.integrations.map((id) => <div className="integration-switch" key={id}>
            <IntegrationBrand integration={id} label />
            <label className="integration-switch__toggle">
              <input type="checkbox" checked={enabled?.[id] ?? true} disabled={!enabled || saving === id} onChange={() => toggle(id)} />
              <span>{enabled?.[id] === false ? 'Disabled' : saving === id ? 'Saving…' : 'Enabled'}</span>
            </label>
          </div>)}
        </div>
      </section>)}
    </div>
    <Msg msg={msg} />
  </section>;
}

// Credentials for Planning Center and Slack. WRITE-ONLY on purpose: the server
// never returns a stored credential, so this shows WHETHER one is set (as a
// row of dots) and never what it is. Editing opens a modal per integration, so
// the common case — looking at this page to check something is configured —
// stays a glance rather than a form.
function SecretsPanel() {
  const [groups, setGroups] = useState<SecretGroup[] | null>(null);
  const [enabled, setEnabled] = useState<Record<string, boolean> | null>(null);
  const [editing, setEditing] = useState<SecretGroup | null>(null);

  const load = useCallback(() => {
    getSecrets().then((r) => setGroups(r.secrets)).catch(() => setGroups([]));
    getEnabledIntegrations().then((r) => setEnabled(r.enabled)).catch(() => setEnabled(null));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    const update = (event: Event) => setEnabled((event as CustomEvent<Record<string, boolean>>).detail);
    window.addEventListener('prodmesh:integrations-changed', update);
    return () => window.removeEventListener('prodmesh:integrations-changed', update);
  }, []);

  if (!groups) return null;

  return (
    <section className="panel">
      <p className="section-label">Credentials</p>
      <h2 className="panel__title">
        Integrations
        <HelpTip text="Write-only: ProdMesh never shows a saved credential back, so a stolen admin session can't read them. To check a value, open server/data/secrets.json on the server." />
      </h2>

      <div className="integrations">
        {groups.filter((group) => enabled?.[secretGroupIntegration(group.id)] !== false).map((group) => (
          <div key={group.id} className="integration">
            <div className="integration__head">
              <span className="integration__name"><IntegrationBrand integration={secretGroupIntegration(group.id)} />{group.label}{integrationInfo[secretGroupIntegration(group.id)].beta && <span className="integration-brand__beta">Beta</span>}</span>
              <span className={`integration__state integration__state--${group.configured ? 'on' : 'off'}`}>
                {group.configured ? 'Configured' : 'Not configured'}
              </span>
            </div>
            <div className="integration__actions">
              <button className="btn btn--sm" onClick={() => setEditing(group)}>Manage integration</button>
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <SecretsDialog
          group={editing}
          onClose={() => setEditing(null)}
          onSaved={(next) => { setGroups(next); setEditing(null); }}
        />
      )}
    </section>
  );
}

function SecretsDialog({
  group,
  onClose,
  onSaved,
}: {
  group: SecretGroup;
  onClose: () => void;
  onSaved: (groups: SecretGroup[]) => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Feedback>(null);
  const [restreamRedirectUrl, setRestreamRedirectUrl] = useState('');
  const [copiedRestreamUrl, setCopiedRestreamUrl] = useState(false);
  const [connectingRestream, setConnectingRestream] = useState(false);
  const [checkingResi, setCheckingResi] = useState(false);
  const [checkingPlanningCenter, setCheckingPlanningCenter] = useState(false);
  const [connectionMessage, setConnectionMessage] = useState<Feedback>(null);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);

  useEffect(() => {
    if (group.id === 'restream') getRestreamConfig().then((r) => setRestreamRedirectUrl(r.redirectUrl)).catch(() => {});
  }, [group.id]);

  const dirty = Object.values(draft).some((v) => v.trim() !== '');

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await saveSecrets(draft);
      // Credentials are only really saved if they work — finding out here
      // beats finding out mid-service on Sunday.
      if (group.id === 'planningCenter') {
        const check = await checkIntegrations().catch(() => null);
        if (check?.planningCenter === false) {
          setMsg(fail(`Saved, but Planning Center could not verify these credentials${check.reason ? ` (${check.reason})` : ''}.`));
          setBusy(false);
          return;
        }
      }
      onSaved(res.secrets);
    } catch (err) {
      setMsg(fail(err));
      setBusy(false);
    }
  };

  return (
    <div className="confirm" role="dialog" aria-modal="true" aria-labelledby="secret-title">
      <div className="confirm__card secretdlg">
        <p className="eyebrow">Credentials</p>
        <h3 id="secret-title" className="secretdlg__title">{group.label}</h3>
        <p className="settings__muted">{group.hint}</p>

        {group.fields.map((f) => (
          <label key={f.path} className="lfield">
            <span>
              {f.label}
              {f.set && <span className="secretdlg__kept">leave blank to keep</span>}
            </span>
            {f.secret ? <PasswordInput
              className="field"
              autoComplete="new-password"
              placeholder={f.set ? (f.secret ? '••••••••' : f.value ?? '') : 'not set'}
              value={draft[f.path] ?? ''}
              disabled={f.env || busy}
              onChange={(e) => setDraft((d) => ({ ...d, [f.path]: e.target.value }))}
            /> : <input
              className="field"
              type="text"
              autoComplete="new-password"
              placeholder={f.set ? f.value ?? '' : 'not set'}
              value={draft[f.path] ?? ''}
              disabled={f.env || busy}
              onChange={(e) => setDraft((d) => ({ ...d, [f.path]: e.target.value }))}
            />}
            {f.note && <small className="settings__muted">{f.note}</small>}
            {f.env && <small className="settings__muted">Set by an environment variable — edit it there.</small>}
          </label>
        ))}

        {group.id === 'restream' && (
          <>
            <p className="settings__muted integration__redirect">
              Redirect URL: <code>{restreamRedirectUrl || `${window.location.origin}/api/integrations/restream/callback`}</code>
              <button className="btn btn--sm" type="button" onClick={() => {
                const url = restreamRedirectUrl || `${window.location.origin}/api/integrations/restream/callback`;
                navigator.clipboard.writeText(url).then(() => { setCopiedRestreamUrl(true); window.setTimeout(() => setCopiedRestreamUrl(false), 1800); }).catch(() => setConnectionMessage(fail('Could not copy the Redirect URL. Please select and copy it manually.')));
              }}>{copiedRestreamUrl ? 'Copied' : 'Copy'}</button>
            </p>
            <p className="settings__muted">Save credentials, register this exact URL in Restream, then connect the account that owns your broadcasts.</p>
          </>
        )}

        {group.id === 'resi' && <p className="settings__muted">ProdMesh keeps the Resi token on this server. The optional player URL is embedded directly; dashboard clients receive only normalized broadcast data.</p>}

        {msg && <p className={`settings__msg settings__msg--${msg.kind}`}>{msg.text}</p>}
        {connectionMessage && <p className={`settings__msg settings__msg--${connectionMessage.kind}`}>{connectionMessage.text}</p>}

        <div className="confirm__buttons">
          <button className="confirm__cancel" onClick={onClose} disabled={busy}>Cancel</button>
          {group.id === 'restream' && <button className="btn" disabled={!group.configured || connectingRestream} onClick={() => {
            setConnectionMessage(null); setConnectingRestream(true);
            connectRestream().catch((err) => setConnectionMessage(fail(err))).finally(() => setConnectingRestream(false));
          }}>{connectingRestream ? 'Connecting…' : 'Connect account'}</button>}
          {group.id === 'planningCenter' && <button className="btn" disabled={!group.configured || checkingPlanningCenter} onClick={() => {
            setConnectionMessage(null); setCheckingPlanningCenter(true);
            checkIntegrations().then((result) => setConnectionMessage(
              result.planningCenter ? ok('Connected — Planning Center credentials are valid.') : fail(result.reason ?? 'Planning Center could not verify the saved credentials.'),
            )).catch((err) => setConnectionMessage(fail(err))).finally(() => setCheckingPlanningCenter(false));
          }}>{checkingPlanningCenter ? 'Testing…' : 'Test connection'}</button>}
          {group.id === 'resi' && <button className="btn" disabled={!group.configured || checkingResi} onClick={() => {
            setConnectionMessage(null); setCheckingResi(true);
            checkResiConnection().then((state) => setConnectionMessage(ok(state.live ? 'Connected — Resi reports a live broadcast.' : 'Connected — Resi reports no active broadcast.'))).catch((err) => setConnectionMessage(fail(err))).finally(() => setCheckingResi(false));
          }}>{checkingResi ? 'Testing…' : 'Test connection'}</button>}
          <button className="confirm__ok" onClick={save} disabled={!dirty || busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function SystemPanel() {
  const [version, setVersion] = useState<Version | null>(null);
  const [status, setStatus] = useState<Feedback>(null);

  const load = useCallback(() => getVersion().then(setVersion).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);

  const update = async () => {
    setStatus(ok('Starting update…'));
    const before = version?.commit;
    try {
      await triggerUpdate();
    } catch {
      return setStatus(fail('Could not start update.'));
    }
    setStatus(ok('Updating & restarting… (this page may briefly disconnect)'));
    let tries = 0;
    const iv = setInterval(async () => {
      tries += 1;
      try {
        const v = await getVersion();
        if (v.commit !== before && v.commit !== 'unknown') {
          setVersion(v); setStatus(ok(`Updated to ${v.commit}.`)); clearInterval(iv);
        }
      } catch { /* server restarting */ }
      if (tries > 40) { setStatus(fail('Update taking longer than expected — check the box.')); clearInterval(iv); }
    }, 3000);
  };

  return (
    <section className="panel">
      <h2 className="panel__title">System</h2>
      <div className="panel__row">
        <div>
          <div className="panel__label">Version</div>
          <div className="settings__muted">
            {version
              ? <>{version.version}{version.commit !== 'unknown' && <> · <code>{version.commit}</code></>}
                {version.subject && <> — {version.subject}</>}</>
              : '…'}
          </div>
          {/* Sits with the version, not adrift below the row: it describes
              this install, and a loose paragraph reads as an error. */}
          {version && !version.update.supported && (
            <div className="settings__muted">{version.update.reason}</div>
          )}
        </div>
        {/* A button that cannot work is worse than no button: someone presses
            it mid-service and reads the silence as a broken install. The slot
            goes with it — an empty controls div leaves a gap where a control
            visibly used to be. */}
        {version?.update.supported && (
          <div className="panel__controls">
            <button className="btn btn--primary" onClick={update}>Update now</button>
          </div>
        )}
      </div>
      <Msg msg={status} />

      <BackupRow />
    </section>
  );
}

/**
 * Download an installation.
 *
 * The warning is not boilerplate and is not a tooltip: this file contains the
 * Planning Center token, every PIN and every credential, and the person most
 * likely to press this is the one least likely to guess that. UI_TEXT keeps
 * supplementary detail in a HelpTip, but a must-know consequence stays inline
 * — the same rule the admin PIN reset already follows.
 */
function BackupRow() {
  const [history, setHistory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Feedback>(null);

  const download = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await downloadBackup(history);
      setMsg(ok('Backup downloaded.'));
    } catch (err) {
      setMsg(fail(err instanceof PermissionError ? err.message : 'Could not build the backup.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel__row">
      <div>
        <div className="panel__label">Backup</div>
        <div className="settings__muted">
          Everything needed to rebuild this install on another machine: campuses,
          rooms, integrations, users, dashboards and checklists.
        </div>
        <div className="settings__warn">
          Keep it somewhere safe. It contains your Planning Center token, your
          PINs and every other credential — anyone with this file has what the
          server has.
        </div>
        <label className="settings__check">
          <input type="checkbox" checked={history} onChange={(e) => setHistory(e.target.checked)} />
          Include show history (much larger — every recorded service and its
          loudness readings)
        </label>
        <div className="settings__muted">
          To restore, install prodmesh on the new machine and use the backup on
          its welcome screen. Restoring is only possible before an admin PIN is
          set, so it can never overwrite a working install.
        </div>
        <Msg msg={msg} />
      </div>
      <div className="panel__controls">
        <button className="btn" onClick={download} disabled={busy}>
          {busy ? 'Preparing…' : 'Download backup'}
        </button>
      </div>
    </div>
  );
}

// ── Logs: server process log + audit trail ─────────────────────────────────────
export function LogsPanel() {
  const [tab, setTab] = useState<'server' | 'audit'>('server');
  return (
    <>
      <div className="logtabs">
        <button className={`typebtn${tab === 'server' ? ' typebtn--on' : ''}`} onClick={() => setTab('server')}>
          Server log
        </button>
        <button className={`typebtn${tab === 'audit' ? ' typebtn--on' : ''}`} onClick={() => setTab('audit')}>
          Audit trail
        </button>
      </div>
      {tab === 'server' ? <ServerLogViewer /> : <AuditTrail />}
    </>
  );
}

function ServerLogViewer() {
  const [log, setLog] = useState<ServerLogTail | null>(null);
  const [lines, setLines] = useState(500);
  const [follow, setFollow] = useState(true);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');
  const preRef = useRef<HTMLPreElement>(null);

  const refresh = useCallback(async () => {
    try {
      setLog(await getServerLog(lines));
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [lines]);

  useEffect(() => {
    refresh();
    if (!follow) return;
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh, follow]);

  const shown = (log?.lines ?? []).filter(
    (line) => !filter || line.toLowerCase().includes(filter.toLowerCase()),
  );

  // Keep the newest lines in view as the log grows (unless filtering around).
  useEffect(() => {
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown.length, log?.size]);

  return (
    <section className="panel logview">
      <div>
        <p className="section-label">Diagnostics</p>
        <h2 className="panel__title">Server log</h2>
      </div>

      <div className="logview__controls">
        <input
          className="field logview__filter"
          placeholder="Filter lines… (e.g. smaart, autostart)"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <SelectField value={lines} onChange={(e) => setLines(Number(e.target.value))} aria-label="Lines to show">
          <option value={200}>Last 200</option>
          <option value={500}>Last 500</option>
          <option value={1000}>Last 1,000</option>
          <option value={2000}>Last 2,000</option>
        </SelectField>
        <Checkbox label="Auto-refresh" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
      </div>

      {log && !log.exists && (
        <p className="settings__muted">
          No log file at <code>{log.file}</code>. {log.hint}
        </p>
      )}
      {log?.exists && (
        <>
          <pre ref={preRef} className="logview__pre" data-testid="server-log">
            {shown.join('\n') || (filter ? 'No lines match the filter.' : 'Log is empty.')}
          </pre>
          <p className="settings__muted logview__meta">
            {shown.length === log.lines.length
              ? `${log.lines.length} lines`
              : `${shown.length} of ${log.lines.length} lines`}
            {log.size != null && <> · {Math.max(1, Math.round(log.size / 1024))} KB</>}
            {log.mtime != null && <> · updated {relativeTime(log.mtime)}</>}
          </p>
        </>
      )}
      {error && <p className="settings__error">{error}</p>}
    </section>
  );
}

function AuditTrail() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      setEntries((await getAuditLog(200)).entries);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <section className="panel audittrail">
      <div className="audittrail__head">
        <div>
          <p className="section-label">Accountability</p>
          <h2 className="panel__title">Audit trail
            <HelpTip text="Every consequential action, who did it, and from which station. The most recent 200 entries." />
          </h2>
        </div>
        <button className="btn" onClick={refresh}>Refresh</button>
      </div>


      {error && <p className="settings__error">{error}</p>}
      {entries && entries.length === 0 && <p className="settings__muted">Nothing recorded yet.</p>}
      {entries && entries.length > 0 && (
        <div className="audittrail__scroll">
          <table className="audittrail__table">
            <thead>
              <tr><th>When</th><th>User</th><th>Station</th><th>Action</th><th>Result</th></tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td className="audittrail__when" title={new Date(entry.ts).toLocaleString()}>
                    {relativeTime(entry.ts)}
                  </td>
                  <td>{entry.userName ?? <span className="settings__muted">anonymous</span>}</td>
                  <td>{entry.stationName ?? <span className="settings__muted">—</span>}</td>
                  <td className="audittrail__action">
                    {entry.action}
                    {(entry.roomId || entry.resourceId) && (
                      <span className="settings__muted"> · {entry.roomId ?? `${entry.resourceType}:${entry.resourceId}`}</span>
                    )}
                  </td>
                  <td>
                    <span className={`audittrail__result audittrail__result--${entry.result === 'allowed' ? 'ok' : 'denied'}`}>
                      {entry.result}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ── Campuses: institution name, sites, rooms, Quick Access tiles ──────────────
// Edits a local draft of the whole tree; Save replaces it transactionally on
// the server (PUT /api/config). Nothing is destructive until Save.

// The overview: institution name, sites, and each site's rooms as rows that
// link into their own configuration page.
// Institution identity — name and logo. These are the two things every
// installing church changes first, so they get a section of their own in
// General rather than living inside the topology editor.
function BrandingPanel() {
  const [church, setChurch] = useState<Church | null>(null);
  const [name, setName] = useState('');
  const [stamp, setStamp] = useState(() => Date.now());
  const [hasLogo, setHasLogo] = useState(true); // assume; the 404 corrects us
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Feedback>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getConfig().then((c) => { setChurch(c); setName(c.name); }).catch(() => {});
  }, []);

  const announce = () => {
    setStamp(Date.now());
    window.dispatchEvent(new Event('prodmesh:config-changed'));
  };

  const saveName = async () => {
    if (!church) return;
    setBusy(true);
    setMsg(null);
    try {
      // Re-read before writing: this endpoint takes the whole tree, and the
      // Campuses editor may have changed rooms since we loaded.
      const latest = await getConfig();
      const saved = await saveConfig({ ...latest, name: name.trim() });
      setChurch(saved);
      announce();
      setMsg(ok('Name updated.'));
    } catch (err) {
      setMsg(fail(err));
    } finally {
      setBusy(false);
    }
  };

  const pickLogo = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setMsg(null);
    try {
      await uploadLogo(file);
      setHasLogo(true);
      announce();
      setMsg(ok('Logo updated.'));
    } catch (err) {
      setMsg(fail(err));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const resetLogo = async () => {
    setBusy(true);
    try {
      await clearLogo();
      setHasLogo(false);
      announce();
      setMsg(ok('Reverted to the default logo.'));
    } catch (err) {
      setMsg(fail(err));
    } finally {
      setBusy(false);
    }
  };

  if (!church) return null;
  const dirty = name.trim() !== church.name && name.trim().length > 0;

  return (
    <section className="panel">
      <p className="section-label">Identity</p>
      <h2 className="panel__title">
        Branding
        <HelpTip text="Shown on every screen — the sidebar mark and the name above it." />
      </h2>

      <div className="branding">
        <div className="branding__logo">
          {/* Two previews: the logo at the size it actually renders in the
              sidebar, and larger. A mark that reads fine big can turn to mush
              at 32px, which is the size that matters. */}
          <div className="branding__previews">
            <img
              className="branding__big"
              src={logoSrc(stamp)}
              alt=""
              onError={(e) => { e.currentTarget.src = logoUrl; setHasLogo(false); }}
            />
            <div className="branding__actual">
              <img src={logoSrc(stamp)} alt="" onError={(e) => { e.currentTarget.src = logoUrl; }} />
              <span>actual size</span>
            </div>
          </div>
          <div className="branding__logoactions">
            <button className="btn btn--sm" disabled={busy} onClick={() => fileRef.current?.click()}>
              Upload logo
            </button>
            {hasLogo && (
              <button className="btn btn--ghost btn--sm" disabled={busy} onClick={resetLogo}>
                Use default
              </button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              hidden
              onChange={(e) => pickLogo(e.target.files?.[0])}
            />
            <p className="branding__hint">
              PNG, JPEG, GIF or WebP · under 256 KB. The sidebar is dark, so a
              light or full-colour mark reads best.
            </p>
          </div>
        </div>

        <div className="branding__name">
          <label className="lfield">
            <span>Institution name</span>
            <input
              className="field"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && dirty) saveName(); }}
            />
          </label>
          <button className="btn btn--primary btn--sm" disabled={!dirty || busy} onClick={saveName}>
            {dirty ? 'Save name' : 'Saved'}
          </button>
        </div>
      </div>

      {msg && <p className={`settings__msg settings__msg--${msg.kind}`}>{msg.text}</p>}
    </section>
  );
}

export function CampusesPanel() {
  const { draft, baseline, dirty, msg, err, update, save } = useChurchDraft();
  const [selectedSite, setSelectedSite] = useState('');

  if (!draft) return err ? <p className="settings__error">{err}</p> : <p className="settings__muted">Loading…</p>;

  const site = draft.sites.find((s) => s.id === selectedSite) ?? draft.sites[0];
  // Rooms that exist on the server (vs. added to this unsaved draft) — a new
  // room's page can only load after the draft is saved.
  const savedRoomIds = new Set(
    (JSON.parse(baseline || '{"sites":[]}') as Church).sites.flatMap((s) => s.auditoriums).map((r) => r.id),
  );

  return (
    <section className="panel campuses">
      <div className="campuses__head">
        <div>
          <p className="section-label">Topology</p>
          <h2 className="panel__title">Campuses
            <HelpTip text="Changes apply everywhere when you save — nothing is final until then." />
          </h2>
        </div>
        <button className="btn btn--primary" onClick={() => save()} disabled={!dirty}>
          {dirty ? 'Save changes' : 'Saved'}
        </button>
      </div>



      <div className="campuses__sitebar">
        {draft.sites.map((s) => (
          <button key={s.id}
            className={`typebtn${s.id === site?.id ? ' typebtn--on' : ''}`}
            onClick={() => setSelectedSite(s.id)}>
            {s.name || s.id}
            {s.status !== 'active' && <span className="typebtn__uses">off</span>}
          </button>
        ))}
        <button className="btn" onClick={() => update((n) => {
          const id = slugId('new-site', allIds(n));
          n.sites.push({ id, name: 'New Site', status: 'disabled', auditoriums: [] });
          setSelectedSite(id);
        })}>+ Add site</button>
      </div>

      {site && (
        <div className="campuses__site" key={site.id}>
          <div className="campuses__siterow">
            <label className="lfield"><span>Site name</span>
              <input className="field" value={site.name}
                onChange={(e) => update((n) => { n.sites.find((s) => s.id === site.id)!.name = e.target.value; })} />
            </label>
            <label className="lfield"><span>Status</span>
              <SelectField value={site.status}
                onChange={(e) => update((n) => { n.sites.find((s) => s.id === site.id)!.status = e.target.value as Site['status']; })}>
                <option value="active">Active</option>
                <option value="disabled">Disabled</option>
              </SelectField>
            </label>
            <div className="campuses__rowactions">
              <button className="iconbtn" title="Move site left" aria-label="Move site left"
                onClick={() => update((n) => moveIn(n.sites, n.sites.findIndex((s) => s.id === site.id), -1))}><ArrowUp size={14} /></button>
              <button className="iconbtn" title="Move site right" aria-label="Move site right"
                onClick={() => update((n) => moveIn(n.sites, n.sites.findIndex((s) => s.id === site.id), 1))}><ArrowDown size={14} /></button>
              <button className="iconbtn iconbtn--danger" title="Remove site" aria-label="Remove site"
                onClick={() => update((n) => {
                  n.sites = n.sites.filter((s) => s.id !== site.id);
                  setSelectedSite(n.sites[0]?.id ?? '');
                })}><Trash2 size={14} /></button>
            </div>
          </div>

          <div className="campuses__roomlist">
            {site.auditoriums.length === 0 && <p className="settings__muted">No rooms yet.</p>}
            {site.auditoriums.map((room, roomIdx) => (
              <div className="campuses__roomrow" key={room.id}>
                <div className="campuses__roominfo">
                  <strong>{room.name}</strong>
                  <small>{room.tiles.length} tile{room.tiles.length === 1 ? '' : 's'}</small>
                </div>
                {savedRoomIds.has(room.id)
                  ? <Link className="btn" to={`/admin/campuses/${room.id}`}>Configure</Link>
                  : <span className="settings__muted campuses__unsaved">save to configure</span>}
                <div className="campuses__rowactions">
                  <button className="iconbtn" title="Move room up" aria-label="Move room up"
                    onClick={() => update((n) => moveIn(n.sites.find((s) => s.id === site.id)!.auditoriums, roomIdx, -1))}><ArrowUp size={14} /></button>
                  <button className="iconbtn" title="Move room down" aria-label="Move room down"
                    onClick={() => update((n) => moveIn(n.sites.find((s) => s.id === site.id)!.auditoriums, roomIdx, 1))}><ArrowDown size={14} /></button>
                  <button className="iconbtn iconbtn--danger" title="Remove room" aria-label="Remove room"
                    onClick={() => update((n) => {
                      const s = n.sites.find((x) => x.id === site.id)!;
                      s.auditoriums = s.auditoriums.filter((r) => r.id !== room.id);
                    })}><Trash2 size={14} /></button>
                </div>
              </div>
            ))}
          </div>

          <button className="btn" onClick={() => update((n) => {
            const id = slugId(`${site.id}-room`, allIds(n));
            n.sites.find((s) => s.id === site.id)!.auditoriums.push({ id, name: 'New Room', tiles: [] });
          })}>+ Add room</button>
        </div>
      )}

      {err && <p className="settings__error">{err}</p>}
      {msg && <p className="settings__ok">{msg}</p>}
    </section>
  );
}

// The room configuration page lives in ./RoomConfig.tsx; re-exported so the
// route and the tests keep one import for every Admin panel.
import { RoomConfigPanel } from './RoomConfig';
export { RoomConfigPanel };
