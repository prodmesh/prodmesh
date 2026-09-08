import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  Check,
  KeyRound,
  Plug,
  Plus,
  Trash2,
  Users,
  MonitorCog,
  ClipboardList,
} from 'lucide-react';
import { HelpTip } from '../components/HelpTip';
import { IntegrationBrand, type IntegrationId } from '../components/IntegrationBrand';
import { PasswordInput } from '../components/PasswordInput';
import { SETUP_COMPLETE_EVENT } from '../layout/SetupGate';
import { buildChurch } from '../lib/topology';
import {
  getSetupState,
  restoreBackup,
  type RestoreResult,
  completeSetup,
  getAuthStatus,
  getConfig,
  saveConfig,
  setPins,
  loginAdmin,
  logoSrc,
  uploadLogo,
  clearLogo,
  getSecrets,
  saveSecrets,
  setIntegrationEnabled,
  type SecretGroup,
  type SetupState,
} from '../api';
import logoUrl from '../assets/prodmesh-logo.svg';

// ─────────────────────────────────────────────────────────────────────────────
//  FIRST-RUN SETUP  —  the first thing a church sees.
//
//  A fresh install has no admin PIN and no campuses, so the app underneath is
//  an empty shell. This takes the whole window instead (it renders outside
//  AppShell, so there is no sidebar to explore and no station dialog on top)
//  and hands back an install that works: someone owns it, it carries the
//  church's name, and Home has a room on it.
//
//  Everything optional is skippable, and every step writes as it goes, so
//  closing the tab loses at most the step in progress — SetupGate brings them
//  back to where they stopped.
// ─────────────────────────────────────────────────────────────────────────────

const STEPS = [
  { id: 'pin', label: 'Admin PIN', icon: KeyRound },
  { id: 'identity', label: 'Your church', icon: Building2 },
  { id: 'campus', label: 'Campus & rooms', icon: Building2 },
  { id: 'integrations', label: 'Integrations', icon: Plug },
] as const;

const WELCOME = -1;
const DONE = STEPS.length;

/**
 * Restoring instead of setting up.
 *
 * Offered here and nowhere else, because here is the only place it is safe: a
 * box with no admin PIN yet is already trust-on-first-use, so restoring grants
 * nothing that completing setup would not. The server enforces that — this is
 * simply the one screen from which the endpoint is still reachable.
 *
 * Deliberately understated. Most people arriving here are setting up for the
 * first time and should not have to think about it; the person who needs it is
 * looking for it.
 */
function RestoreOffer() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<RestoreResult | null>(null);
  const pick = useRef<HTMLInputElement>(null);

  const onFile = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      setDone(await restoreBackup(file));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That backup could not be restored.');
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="setup__restored" role="status">
        <p className="setup__restoredtitle">Restored.</p>
        <p>
          {done.files} file{done.files === 1 ? '' : 's'} and the database
          {done.from ? <> from prodmesh {done.from}</> : null}
          {done.createdAt ? <>, backed up {new Date(done.createdAt).toLocaleDateString()}</> : null}.
          {!done.history && ' Show history was not included in this backup.'}
        </p>
        {/* The restart is not optional and not a suggestion: the database under
            this running server has just been replaced. */}
        <p className="setup__restart">{done.restart}</p>
      </div>
    );
  }

  return (
    <div className="setup__restore">
      <input
        ref={pick}
        type="file"
        accept=".pmbak"
        className="sr-only"
        onChange={(e) => onFile(e.target.files?.[0])}
      />
      <p>
        Rebuilding a machine?{' '}
        <button className="linkbtn" disabled={busy} onClick={() => pick.current?.click()}>
          {busy ? 'Restoring…' : 'Restore from a backup'}
        </button>
      </p>
      {error && <p className="setup__restoreerr" role="alert">{error}</p>}
    </div>
  );
}

export function Setup() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [step, setStep] = useState<number>(WELCOME);
  const [isAdmin, setIsAdmin] = useState(false);
  const [state, setState] = useState<SetupState | null>(null);
  const [finishing, setFinishing] = useState(false);

  // The draft. The institution name cannot be saved on its own — the server
  // rejects a tree with no sites — so it is held here and written together
  // with the first campus.
  const [name, setName] = useState('');
  const [campusName, setCampusName] = useState('Main Campus');
  const [roomNames, setRoomNames] = useState<string[]>(['Auditorium']);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [setupState, auth] = await Promise.all([
        getSetupState(),
        getAuthStatus().catch(() => null),
      ]);
      if (cancelled) return;
      if (!setupState.needed) return navigate('/', { replace: true });

      setState(setupState);
      setIsAdmin(Boolean(auth?.admin));

      // Resume: prefill from whatever is already saved, and open at the first
      // step that still has work.
      const church = await getConfig().catch(() => null);
      if (cancelled) return;
      const site = church?.sites[0];
      if (church && site) {
        setName(church.name);
        setCampusName(site.name);
        if (site.auditoriums.length) setRoomNames(site.auditoriums.map((a) => a.name));
      }
      if (!setupState.adminPinSet) setStep(WELCOME);
      else if (!auth?.admin) setStep(0); // PIN exists but this browser isn't signed in
      else setStep(setupState.hasCampus ? 3 : 1);
      setReady(true);
    })().catch(() => setReady(true));
    return () => { cancelled = true; };
  }, [navigate]);

  const finish = async (then = '/') => {
    setFinishing(true);
    try {
      await completeSetup();
    } catch {
      // Nothing configured is lost if the stamp fails; let them into the app
      // for this session, and the next reload returns them here to finish.
    }
    // Before navigating, so the gate is already settled when the new route
    // renders and doesn't bounce us straight back into the wizard.
    window.dispatchEvent(new Event(SETUP_COMPLETE_EVENT));
    window.dispatchEvent(new Event('prodmesh:config-changed'));
    navigate(then, { replace: true });
  };

  if (!ready && step === WELCOME && !state) {
    return <div className="setup setup--plain"><p className="settings__muted">Loading…</p></div>;
  }

  if (step === WELCOME) {
    return (
      <div className="setup setup--plain">
        <div className="setup__hero">
          <img className="setup__herologo" src={logoUrl} alt="" />
          <p className="eyebrow">Welcome to ProdMesh</p>
          <h1 className="setup__herotitle">Let's set up your church.</h1>
          <p className="setup__herolede">
            Four steps: an admin PIN, your name and logo, your first campus, and the
            services you connect to. Under five minutes.
          </p>
          <ul className="setup__herolist">
            {STEPS.map(({ id, label, icon: Icon }) => (
              <li key={id}><Icon size={15} /> {label}</li>
            ))}
          </ul>
          <button className="btn btn--primary btn--lg" onClick={() => setStep(0)} autoFocus>
            Begin <ArrowRight size={16} />
          </button>

          <RestoreOffer />
        </div>
      </div>
    );
  }

  const back = () => setStep((s) => Math.max(0, s - 1));
  const next = () => setStep((s) => s + 1);

  return (
    <div className="setup">
      <aside className="setup__rail">
        <div className="setup__railbrand">
          <img src={logoUrl} alt="" />
          <span>ProdMesh</span>
        </div>
        <ol className="setup__steps">
          {STEPS.map((s, i) => {
            const status = i < step ? 'done' : i === step ? 'now' : 'next';
            return (
              <li key={s.id} className={`setup__step setup__step--${status}`}>
                <span className="setup__stepmark">{status === 'done' ? <Check size={13} /> : i + 1}</span>
                <span className="setup__steplabel">{s.label}</span>
              </li>
            );
          })}
        </ol>
      </aside>

      <main className="setup__main">
        <div className="setup__col">
        {step < DONE && (
          <p className="setup__count">Step {step + 1} of {STEPS.length}</p>
        )}

        {step === 0 && (
          <PinStep
            mode={isAdmin ? 'done' : state?.adminPinSet ? 'unlock' : 'create'}
            onDone={() => { setIsAdmin(true); next(); }}
          />
        )}
        {step === 1 && (
          <IdentityStep name={name} setName={setName} onBack={back} onNext={next} />
        )}
        {step === 2 && (
          <CampusStep
            name={name}
            campusName={campusName}
            setCampusName={setCampusName}
            roomNames={roomNames}
            setRoomNames={setRoomNames}
            onBack={back}
            onSaved={next}
          />
        )}
        {step === 3 && <IntegrationsStep onBack={back} onNext={next} />}
        {step === DONE && (
          <DoneStep
            churchName={name}
            campusName={campusName}
            roomNames={roomNames}
            busy={finishing}
            onFinish={finish}
          />
        )}
        </div>
      </main>
    </div>
  );
}

// ── Step frame ───────────────────────────────────────────────────────────────
function Step({
  title,
  help,
  children,
  footer,
}: {
  title: string;
  help?: string;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  return (
    <section className="setup__card">
      <h1 className="setup__title">
        {title}
        {/* Below: a step title sits near the top of the window, where a
            bubble above it would be cut off. */}
        {help && <HelpTip text={help} place="below" />}
      </h1>
      <div className="setup__body">{children}</div>
      <div className="setup__foot">{footer}</div>
    </section>
  );
}

function Err({ text }: { text: string | null }) {
  return text ? <p className="settings__error setup__err">{text}</p> : null;
}

// ── 1 · Admin PIN ────────────────────────────────────────────────────────────
function PinStep({ mode, onDone }: { mode: 'create' | 'unlock' | 'done'; onDone: () => void }) {
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (pin.length < 6) return setErr('Use at least 6 characters.');
    if (pin !== confirm) return setErr('Those PINs do not match.');
    setBusy(true);
    setErr(null);
    try {
      await setPins({ admin: pin });
      if (!(await loginAdmin(pin))) throw new Error('PIN saved, but signing in failed. Try entering it again.');
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const unlock = async () => {
    setBusy(true);
    setErr(null);
    if (await loginAdmin(pin)) return onDone();
    setErr('Incorrect PIN.');
    setBusy(false);
  };

  if (mode === 'done') {
    return (
      <Step
        title="Admin PIN"
        help="Everything behind Admin — campuses, users, credentials, system updates — is gated by this PIN."
        footer={<button className="btn btn--primary" onClick={onDone} autoFocus>Continue <ArrowRight size={16} /></button>}
      >
        <p className="setup__settled"><Check size={16} /> Admin PIN set, and you're signed in.</p>
      </Step>
    );
  }

  if (mode === 'unlock') {
    return (
      <Step
        title="Enter your admin PIN"
        footer={
          <button className="btn btn--primary" disabled={busy || !pin} onClick={unlock}>
            {busy ? 'Checking…' : 'Unlock'}
          </button>
        }
      >
        <p className="setup__lede">This install already has an admin PIN. Enter it to pick up where setup left off.</p>
        <label className="lfield">
          <span>Admin PIN</span>
          <PasswordInput className="field" autoFocus value={pin}
            onChange={(e) => setPin(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && pin) unlock(); }} />
        </label>
        <Err text={err} />
      </Step>
    );
  }

  return (
    <Step
      title="Create an admin PIN"
      help="Everything behind Admin — campuses, users, credentials, system updates — is gated by this PIN. Your team gets their own logins later; this one is the church's master key."
      footer={
        <button className="btn btn--primary" disabled={busy || !pin || !confirm} onClick={create}>
          {busy ? 'Saving…' : 'Create PIN'} <ArrowRight size={16} />
        </button>
      }
    >
      <p className="setup__lede">One PIN protects this install's settings. Pick something your tech leads can share.</p>
      <label className="lfield">
        <span>Admin PIN</span>
        <PasswordInput className="field" autoComplete="new-password" autoFocus value={pin}
          onChange={(e) => setPin(e.target.value)} />
      </label>
      <label className="lfield">
        <span>Confirm PIN</span>
        <PasswordInput className="field" autoComplete="new-password" value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && pin && confirm) create(); }} />
      </label>
      <p className="setup__note">
        At least 6 characters. Store it somewhere your team can find it — resetting a
        forgotten admin PIN means editing a file on the server itself.
      </p>
      <Err text={err} />
    </Step>
  );
}

// ── 2 · Name and logo ────────────────────────────────────────────────────────
function IdentityStep({
  name,
  setName,
  onBack,
  onNext,
}: {
  name: string;
  setName: (v: string) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const [stamp, setStamp] = useState<number | null>(null);
  const [hasLogo, setHasLogo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setErr(null);
    try {
      await uploadLogo(file);
      setHasLogo(true);
      setStamp(Date.now());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const reset = async () => {
    setBusy(true);
    try {
      await clearLogo();
      setHasLogo(false);
      setStamp(Date.now());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const trimmed = name.trim();

  return (
    <Step
      title="Your church"
      help="The name and mark shown in the sidebar on every screen, and on the reports you hand to a pastor."
      footer={
        <>
          <button className="btn btn--ghost" onClick={onBack}><ArrowLeft size={16} /> Back</button>
          <button className="btn btn--primary" disabled={!trimmed || busy} onClick={onNext}>
            Continue <ArrowRight size={16} />
          </button>
        </>
      }
    >
      <label className="lfield">
        <span>Church name</span>
        <input className="field" value={name} maxLength={80} autoFocus placeholder="Grace Community Church"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && trimmed) onNext(); }} />
      </label>

      <div className="setup__logorow">
        <div className="setup__preview">
          <p className="section-label">Sidebar preview</p>
          <div className="setup__previewbar">
            <img
              src={hasLogo ? logoSrc(stamp) : logoUrl}
              alt=""
              onError={(e) => { e.currentTarget.src = logoUrl; }}
            />
            <div>
              <strong>{trimmed || 'Your church'}</strong>
              <small>All Campuses</small>
            </div>
          </div>
        </div>
        <div className="setup__logoactions">
          <button className="btn btn--sm" disabled={busy} onClick={() => fileRef.current?.click()}>
            Upload logo
          </button>
          {hasLogo && (
            <button className="btn btn--ghost btn--sm" disabled={busy} onClick={reset}>Use default</button>
          )}
          <input ref={fileRef} type="file" hidden accept="image/png,image/jpeg,image/gif,image/webp"
            onChange={(e) => pick(e.target.files?.[0])} />
          <p className="setup__note">
            PNG, JPEG, GIF or WebP · under 256 KB. The sidebar is dark, so a light
            or full-colour mark reads best. Optional — you can add it later.
          </p>
        </div>
      </div>
      <Err text={err} />
    </Step>
  );
}

// ── 3 · First campus and its rooms ───────────────────────────────────────────
function CampusStep({
  name,
  campusName,
  setCampusName,
  roomNames,
  setRoomNames,
  onBack,
  onSaved,
}: {
  name: string;
  campusName: string;
  setCampusName: (v: string) => void;
  roomNames: string[];
  setRoomNames: (v: string[]) => void;
  onBack: () => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const clean = roomNames.map((r) => r.trim()).filter(Boolean);
  const valid = campusName.trim().length > 0 && clean.length > 0;

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      // Re-read first: this endpoint replaces the whole tree, and a resumed
      // wizard may be looking at a campus that already exists.
      const existing = await getConfig();
      await saveConfig(buildChurch(existing, name, campusName, clean));
      window.dispatchEvent(new Event('prodmesh:config-changed'));
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const setRoom = (i: number, value: string) =>
    setRoomNames(roomNames.map((r, n) => (n === i ? value : r)));

  return (
    <Step
      title="Your first campus"
      help="A campus is a physical location. A room is a space with its own production setup — an auditorium, a chapel, a kids room. Both can be added and renamed later."
      footer={
        <>
          <button className="btn btn--ghost" onClick={onBack} disabled={busy}><ArrowLeft size={16} /> Back</button>
          <button className="btn btn--primary" disabled={!valid || busy} onClick={save}>
            {busy ? 'Saving…' : 'Save and continue'} <ArrowRight size={16} />
          </button>
        </>
      }
    >
      <label className="lfield">
        <span>Campus name</span>
        <input className="field" value={campusName} maxLength={60} autoFocus
          onChange={(e) => setCampusName(e.target.value)} />
      </label>

      <div className="setup__rooms">
        <p className="section-label">
          Rooms
          <HelpTip text="Each room gets its own status page, run of show, and checklist. Connecting a room to ProPresenter, Companion or Planning Center happens in Admin → Campuses once setup is done." />
        </p>
        {roomNames.map((room, i) => (
          <div key={i} className="setup__roomrow">
            <input className="field" value={room} maxLength={60} placeholder="Room name"
              onChange={(e) => setRoom(i, e.target.value)} />
            <button
              className="iconbtn"
              aria-label={`Remove ${room || 'room'}`}
              title="Remove room"
              disabled={roomNames.length === 1}
              onClick={() => setRoomNames(roomNames.filter((_, n) => n !== i))}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        <button className="btn btn--sm" onClick={() => setRoomNames([...roomNames, ''])}>
          <Plus size={14} /> Add room
        </button>
      </div>
      <Err text={err} />
    </Step>
  );
}

// ── 4 · Integrations (optional) ──────────────────────────────────────────────
const GROUP_HELP: Record<string, string> = {
  planningCenter:
    'Create a Personal Access Token at planningcenteronline.com → Developer → Personal Access Tokens. It reads service plans; ProdMesh never writes to Planning Center.',
  slack: 'Create an app at api.slack.com, give it chat:write, install it to your workspace, then invite the bot to the channel you name here.',
};

const SETUP_INTEGRATION_GROUPS: Array<{ label: string; integrations: IntegrationId[] }> = [
  { label: 'Planning & scheduling', integrations: ['planning-center'] },
  { label: 'Presentation & show control', integrations: ['propresenter', 'companion'] },
  { label: 'Audio', integrations: ['open-sound-meter', 'smaart', 'prodmesh-rta'] },
  { label: 'Video & streaming', integrations: ['youtube', 'restream', 'resi', 'obs'] },
  { label: 'Communication', integrations: ['slack', 'captions', 'prodcom'] },
];

const SECRET_GROUP_INTEGRATION: Record<string, IntegrationId> = {
  planningCenter: 'planning-center',
  slack: 'slack',
  youtube: 'youtube',
  restream: 'restream',
  resi: 'resi',
};

const SETUP_INTEGRATION_IDS = SETUP_INTEGRATION_GROUPS.flatMap((group) => group.integrations);

function IntegrationsStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const [groups, setGroups] = useState<SecretGroup[] | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(SETUP_INTEGRATION_IDS.map((id) => [id, false])),
  );
  const [choosing, setChoosing] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    getSecrets().then((r) => setGroups(r.secrets)).catch(() => setGroups([]));
    setLoaded(true);
  }, []);

  const filled = Object.values(draft).some((v) => v.trim() !== '');
  const selectedCredentialGroups = groups?.filter((group) => selected[SECRET_GROUP_INTEGRATION[group.id]]) ?? [];
  const selectedCount = Object.values(selected).filter(Boolean).length;

  const saveSelection = async (continueToCredentials: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      await Promise.all(SETUP_INTEGRATION_IDS.map((id) => setIntegrationEnabled(id, selected[id] === true)));
      if (continueToCredentials) setChoosing(false);
      else onNext();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!filled) return onNext();
    setBusy(true);
    setErr(null);
    try {
      await saveSecrets(draft);
      onNext();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Step
      title={choosing ? 'Choose your integrations' : 'Add credentials'}
      help={choosing
        ? 'Start with only the services your team uses. You can skip this now, enable more later, or change any choice in Admin → Integrations.'
        : 'Only credentials for the services you selected are shown below. You can skip any of these and finish configuring them later in Admin → Integrations.'}
      footer={
        choosing ? <>
          <button className="btn btn--ghost" onClick={onBack} disabled={busy}><ArrowLeft size={16} /> Back</button>
          <button className="btn btn--ghost" onClick={() => saveSelection(false)} disabled={busy || !loaded}>Skip for now</button>
          <button className="btn btn--primary" disabled={busy || !loaded} onClick={() => saveSelection(true)}>
            {busy ? 'Saving…' : selectedCount ? 'Continue to credentials' : 'Continue without integrations'} <ArrowRight size={16} />
          </button>
        </> : <>
          <button className="btn btn--ghost" onClick={() => setChoosing(true)} disabled={busy}><ArrowLeft size={16} /> Back</button>
          <button className="btn btn--ghost" onClick={onNext} disabled={busy}>Finish later</button>
          <button className="btn btn--primary" disabled={busy} onClick={save}>
            {busy ? 'Saving…' : filled ? 'Save and continue' : 'Continue'} <ArrowRight size={16} />
          </button>
        </>
      }
    >
      {choosing ? <>
        <p className="setup__lede">Select the tools your church uses today. Your selection controls which widgets and configuration options are available.</p>
        {!loaded && <p className="settings__muted">Loading integrations…</p>}
        <div className="setup__integration-groups">
          {SETUP_INTEGRATION_GROUPS.map((group) => (
            <section key={group.label} className="setup__integration-group">
              <h2>{group.label}</h2>
              <div className="setup__integration-choices">
                {group.integrations.map((integration) => (
                  <label className="setup__integration-choice" key={integration}>
                    <IntegrationBrand integration={integration} label />
                    <input
                      type="checkbox"
                      checked={selected[integration] === true}
                      disabled={!loaded || busy}
                      onChange={(event) => setSelected((current) => ({ ...current, [integration]: event.target.checked }))}
                    />
                  </label>
                ))}
              </div>
            </section>
          ))}
        </div>
      </> : <>
      {groups === null && <p className="settings__muted">Loading credentials…</p>}
      {selected.obs && <p className="setup__lede">OBS Studio is configured per room after setup: enable its WebSocket server in OBS, then add that room’s host, port, and password in Admin → Campuses → Connectivity.</p>}
      {selectedCredentialGroups.length === 0 && groups !== null && (
        <p className="setup__lede">None of your selected integrations need credentials during setup. Continue when you are ready; campus-specific services can be configured from Admin later.</p>
      )}
      {selectedCredentialGroups.map((group) => (
        <div key={group.id} className="setup__integration">
          <h2 className="setup__intname">
            {group.label}
            {GROUP_HELP[group.id] && <HelpTip text={GROUP_HELP[group.id]} />}
          </h2>
          <p className="setup__note">{group.hint}</p>
          {group.fields.filter((f) => !f.optional).map((f) => (
            <label key={f.path} className="lfield">
              <span>{f.label}</span>
              {f.secret ? <PasswordInput
                className="field"
                autoComplete="new-password"
                placeholder={f.set ? '••••••••' : ''}
                disabled={f.env || busy}
                value={draft[f.path] ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, [f.path]: e.target.value }))}
              /> : <input
                className="field"
                type="text"
                autoComplete="new-password"
                placeholder={f.set ? '••••••••' : ''}
                disabled={f.env || busy}
                value={draft[f.path] ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, [f.path]: e.target.value }))}
              />}
              {f.env && <small className="settings__muted">Set by an environment variable — edit it there.</small>}
            </label>
          ))}
        </div>
      ))}
      </>}
      <Err text={err} />
    </Step>
  );
}

// ── Done ─────────────────────────────────────────────────────────────────────
const NEXT_STOPS = [
  { to: '/admin/users', icon: Users, label: 'Add your team', note: 'Logins and what each person may change' },
  { to: '/admin/stations', icon: MonitorCog, label: 'Name your stations', note: 'Each booth machine that opens ProdMesh' },
  { to: '/admin/campuses', icon: Building2, label: 'Connect each room', note: 'ProPresenter, Companion, Planning Center' },
  { to: '/admin/checklists', icon: ClipboardList, label: 'Build a checklist', note: 'What the team runs before a service' },
];

function DoneStep({
  churchName,
  campusName,
  roomNames,
  busy,
  onFinish,
}: {
  churchName: string;
  campusName: string;
  roomNames: string[];
  busy: boolean;
  onFinish: (then?: string) => void;
}) {
  const rooms = roomNames.map((r) => r.trim()).filter(Boolean);
  return (
    <section className="setup__card">
      <p className="eyebrow">Setup complete</p>
      <h1 className="setup__title">{churchName.trim() || 'Your church'} is ready.</h1>

      <ul className="setup__summary">
        <li><Check size={15} /> Admin PIN set</li>
        <li><Check size={15} /> {campusName.trim()} · {rooms.length} {rooms.length === 1 ? 'room' : 'rooms'}</li>
      </ul>

      <p className="setup__note">
        The first thing you'll see is a prompt to name this machine as a station —
        that's how ProdMesh tells the booth from the office.
      </p>

      <div className="setup__body">
        <p className="section-label">Where to go next</p>
        <div className="setup__next">
          {NEXT_STOPS.map(({ to, icon: Icon, label, note }) => (
            <button key={to} className="setup__nextcard" disabled={busy} onClick={() => onFinish(to)}>
              <Icon size={16} />
              <span><strong>{label}</strong><small>{note}</small></span>
            </button>
          ))}
        </div>
      </div>

      <div className="setup__foot">
        <button className="btn btn--primary btn--lg" disabled={busy} onClick={() => onFinish('/')} autoFocus>
          {busy ? 'Finishing…' : 'Go to the dashboard'} <ArrowRight size={16} />
        </button>
      </div>
    </section>
  );
}
