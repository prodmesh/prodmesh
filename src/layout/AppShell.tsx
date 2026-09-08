import { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  BarChart3,
  BellRing,
  BookOpen,
  Building2,
  CalendarDays,
  CalendarRange,
  CircleHelp,
  CircleUser,
  ClipboardList,
  MonitorCog,
  LockKeyhole,
  ScrollText,
  Settings2,
  Plug,
  Users,
  Home as HomeIcon,
  PanelLeftClose,
  PanelLeftOpen,
  Wrench,
} from 'lucide-react';
import { getAuthStatus, getConfig, logoSrc, logoutAdmin, type AuthStatus, type Station } from '../api';
import { HelpDrawer } from '../components/HelpDrawer';
import { AssistanceBar } from '../components/AssistanceBar';
import { AssistanceDialog } from '../components/AssistanceDialog';
import { ALL_CAMPUSES, CampusContext } from './campus';
import { ChurchContext, EMPTY_CHURCH } from './church';
import { IdentityContext } from '../lib/identity';
import type { Church } from '../types';
import { Clock } from '../components/Clock';
import { SelectField } from '../components/SelectField';
import { IdentityDialog } from '../components/IdentityDialog';
import logoUrl from '../assets/prodmesh-logo.svg';

const NAV = [
  { to: '/', label: 'Home', icon: HomeIcon, end: true },
  { to: '/services', label: 'Services', icon: CalendarDays },
  { to: '/calendar', label: 'Calendar', icon: CalendarRange },
  { to: '/analytics', label: 'Analytics', icon: BarChart3 },
  { to: '/admin/general', label: 'Admin', icon: Wrench },
];

const ADMIN_NAV = [
  { to: '/admin/general', label: 'General', icon: Settings2 },
  { to: '/admin/integrations', label: 'Integrations', icon: Plug },
  { to: '/admin/campuses', label: 'Campuses', icon: Building2 },
  { to: '/admin/users', label: 'Users & access', icon: Users },
  { to: '/admin/stations', label: 'Stations', icon: MonitorCog },
  { to: '/admin/checklists', label: 'Checklists', icon: ClipboardList },
  { to: '/admin/logs', label: 'Logs', icon: ScrollText },
];

// Persistent chrome: a left sidebar (collapsible to an icon rail) with the
// church brand + campus scope up top, global nav, and the user slot pinned at
// the bottom. Pages render inside <Outlet /> and own no chrome. Room-level
// pages (/room/…) still exist below this nav — Home/Services link into them.
export function AppShell() {
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem('prodmesh.sidebar') === 'rail',
  );
  const [campusId, setCampusId] = useState(
    () => localStorage.getItem('prodmesh.campus') ?? ALL_CAMPUSES,
  );
  const [church, setChurch] = useState<Church>(EMPTY_CHURCH);
  const [logoStamp, setLogoStamp] = useState<number | null>(null);
  const [identity, setIdentity] = useState<AuthStatus | null>(null);
  const [identityOpen, setIdentityOpen] = useState(false);
  // The permission a refused action was asking for, so the dialog can say what
  // is missing rather than showing a bare login form to someone already logged
  // in — which reads as "your session broke", the wrong diagnosis entirely.
  const [denied, setDenied] = useState<{ permission: string; label: string } | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [confirmLock, setConfirmLock] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [railLabelsDismissed, setRailLabelsDismissed] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false); // the documentation drawer
  const [assistOpen, setAssistOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);
  const helpRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getAuthStatus().then((s) => {
      setIdentity(s);
      if (!s.station) setIdentityOpen(true);
    }).catch(() => setIdentityOpen(true));
  }, []);

  // Server-owned topology (ADR 0009): fetch at boot, refetch when the
  // Campuses editor announces a save. The same event re-stamps the logo so a
  // fresh upload shows up without a reload.
  useEffect(() => {
    const load = () => {
      getConfig().then(setChurch).catch(() => {});
      setLogoStamp(Date.now());
    };
    load();
    window.addEventListener('prodmesh:config-changed', load);
    return () => window.removeEventListener('prodmesh:config-changed', load);
  }, []);

  // The browser tab is part of the product's visible identity too. Verify the
  // optional church logo before assigning it as the favicon, because a missing
  // override returns 404 and should keep the bundled ProdMesh mark instead.
  // `logoStamp` changes after Admin → General saves an upload, so the browser
  // sees a fresh URL rather than reusing the previous icon from its cache.
  useEffect(() => {
    let cancelled = false;
    // WebKit commonly holds on to the first favicon it sees even if that
    // link's `href` is later changed. Replace the element instead; that makes
    // Safari, Chromium, and kiosk displays all re-read the current logo.
    const setFavicon = (href: string, type: string) => {
      document.querySelectorAll('link[rel~="icon"]').forEach((link) => link.remove());
      const next = document.createElement('link');
      next.id = 'app-favicon';
      next.rel = 'icon';
      next.type = type;
      next.href = href;
      document.head.append(next);
      // Safari recognizes this older relation more reliably for dynamically
      // swapped site icons, particularly when a previous favicon.ico exists
      // in its per-host cache.
      const shortcut = document.createElement('link');
      shortcut.rel = 'shortcut icon';
      shortcut.type = type;
      shortcut.href = href;
      document.head.append(shortcut);
    };

    const setFallback = () => setFavicon('/prodmesh-icon.svg', 'image/svg+xml');

    fetch(logoSrc(logoStamp), { cache: 'no-store' })
      .then((res) => {
        if (cancelled) return;
        if (!res.ok) {
          setFallback();
          return;
        }
        // This is a real ICO response for PNG uploads, which Safari's tab
        // engine accepts more consistently than a PNG served at an .ico URL.
        setFavicon(`/favicon.ico?v=${logoStamp ?? Date.now()}`, 'image/x-icon');
      })
      .catch(() => {
        if (!cancelled) setFallback();
      });

    return () => { cancelled = true; };
  }, [logoStamp]);

  useEffect(() => {
    if (!accountOpen && !helpOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (accountOpen && !accountRef.current?.contains(event.target as Node)) setAccountOpen(false);
      if (helpOpen && !helpRef.current?.contains(event.target as Node)) setHelpOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setAccountOpen(false);
        setHelpOpen(false);
      }
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [accountOpen, helpOpen]);

  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<{ permission?: string; label?: string }>).detail;
      setDenied(
        detail?.permission
          ? { permission: detail.permission, label: detail.label ?? detail.permission }
          : null,
      );
      setIdentityOpen(true);
    };
    const refresh = () => getAuthStatus().then((status) => {
      setIdentity(status);
      if (!status.station) setIdentityOpen(true);
    }).catch(() => {});
    window.addEventListener('prodmesh:auth-required', open);
    window.addEventListener('prodmesh:auth-changed', refresh);
    return () => {
      window.removeEventListener('prodmesh:auth-required', open);
      window.removeEventListener('prodmesh:auth-changed', refresh);
    };
  }, []);

  const campus = useMemo(
    () => ({
      campusId,
      setCampusId: (id: string) => {
        setCampusId(id);
        localStorage.setItem('prodmesh.campus', id);
      },
    }),
    [campusId],
  );

  const toggle = () => {
    setCollapsed((c) => {
      localStorage.setItem('prodmesh.sidebar', c ? 'open' : 'rail');
      return !c;
    });
  };

  const stationName = identity?.station?.name ?? 'Unregistered station';
  const operatorName = identity?.user?.displayName ?? 'Read-only';

  // A station pinned to its room ("Room only when locked") browses just that
  // room while nobody is logged in — kiosk focus for lobby/booth displays,
  // not a security boundary. Logging in lifts the restriction.
  const lockedRoomId =
    identity && !identity.authenticated && identity.station?.roomOnly
      ? identity.station.roomId
      : null;
  const lockedRoomName = lockedRoomId
    ? church.sites.flatMap((s) => s.auditoriums).find((a) => a.id === lockedRoomId)?.name ?? 'Room Status'
    : null;

  // A station assigned a display goes to its display, not to the room console.
  // The display route lives outside this shell, so nothing here ever runs for
  // it — this is only for a screen that arrived somewhere else: a stale
  // bookmark, or a Pi whose kiosk config points at "/". Point it at the root
  // and it finds its own way home.
  const lockedPrefix = lockedRoomId
    ? identity?.station?.viewSlug
      ? `/display/${lockedRoomId}/${identity.station.viewSlug}`
      : `/room/${lockedRoomId}`
    : null;
  const offLimits =
    lockedPrefix != null &&
    location.pathname !== lockedPrefix &&
    !location.pathname.startsWith(`${lockedPrefix}/`);

  const lock = async () => {
    await logoutAdmin();
    setIdentity(await getAuthStatus());
    setAccountOpen(false);
    setConfirmLock(false);
  };

  const stationRegistered = async (_station: Station) => {
    const next = await getAuthStatus();
    setIdentity(next);
    setIdentityOpen(false);
  };

  return (
    <ChurchContext.Provider value={church}>
    <IdentityContext.Provider value={identity}>
    <CampusContext.Provider value={campus}>
      <div className={`shell${collapsed ? ' shell--rail' : ''}`}>
        <aside
          className="sidebar"
          data-labels-dismissed={railLabelsDismissed || undefined}
          onPointerOver={() => setRailLabelsDismissed(false)}
          onFocusCapture={() => setRailLabelsDismissed(false)}
          onKeyDown={(event) => { if (event.key === 'Escape') setRailLabelsDismissed(true); }}
        >
          <div className="sidebar__brand">
            {/* The church's own mark when they've uploaded one; the bundled
                ProdMesh logo otherwise. The endpoint 404s when unset, so a
                failed load IS the fallback signal — no extra request. */}
            <img
              className="sidebar__logo"
              src={logoSrc(logoStamp)}
              alt=""
              title={church.name}
              onError={(e) => {
                const img = e.currentTarget;
                if (img.src !== logoUrl) img.src = logoUrl;
              }}
            />
            <div className="sidebar__brandtext rail-hide">
              <span className="sidebar__church">{church.name}</span>
              <SelectField
                className="sidebar__campus"
                value={campusId}
                onChange={(e) => campus.setCampusId(e.target.value)}
                aria-label="Campus"
              >
                <option value={ALL_CAMPUSES}>All Campuses</option>
                {church.sites.map((s) => (
                  <option key={s.id} value={s.id} disabled={s.status !== 'active'}>
                    {s.name}
                    {s.status !== 'active' ? ' (disabled)' : ''}
                  </option>
                ))}
              </SelectField>
            </div>
          </div>

          <nav className="sidebar__nav">
            {lockedPrefix ? (
              <NavLink
                to={lockedPrefix}
                aria-label={lockedRoomName ?? undefined}
                data-rail-label={lockedRoomName ?? undefined}
                className={({ isActive }) => `sidebar__item${isActive ? ' sidebar__item--active' : ''}`}
              >
                <HomeIcon size={19} className="sidebar__icon" />
                <span className="sidebar__label rail-hide">{lockedRoomName}</span>
              </NavLink>
            ) : NAV.map(({ to, label, icon: Icon, end }) => {
              const adminActive = label === 'Admin' && location.pathname.startsWith('/admin');
              return (
                <div key={to} className="sidebar__navgroup">
                  <NavLink
                    to={to}
                    end={end}
                    aria-label={label}
                    data-rail-label={label}
                    className={({ isActive }) => `sidebar__item${isActive || adminActive ? ' sidebar__item--active' : ''}`}
                  >
                    <Icon size={19} className="sidebar__icon" />
                    <span className="sidebar__label rail-hide">{label}</span>
                  </NavLink>
                  {adminActive && (
                    <div className="sidebar__subnav rail-hide">
                      {ADMIN_NAV.map(({ to: subTo, label: subLabel, icon: SubIcon }) => (
                        <NavLink key={subTo} to={subTo} className={({ isActive }) => `sidebar__subitem${isActive ? ' sidebar__subitem--active' : ''}`}>
                          <SubIcon size={13} /> {subLabel}
                        </NavLink>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </nav>

          <div className="sidebar__foot">
            {/* Help lives at the bottom, above the clock. */}
            <div className="sidebar__help" ref={helpRef}>
              <button
                className="sidebar__toggle"
                aria-label="Help"
                data-rail-label="Help"
                onClick={() => setHelpOpen((open) => !open)}
                aria-expanded={helpOpen}
              >
                <CircleHelp size={17} />
                <span className="sidebar__label rail-hide">Help</span>
              </button>
              {helpOpen && (
                <div className="accountmenu helpmenu">
                  <button
                    onClick={() => { setHelpOpen(false); setGuideOpen(true); }}
                    title="The full guide, readable with no internet connection"
                  >
                    <BookOpen size={14} /> Documentation
                  </button>
                  <button
                    disabled={!identity?.station}
                    title={
                      identity?.station
                        ? 'Notify the tech team in Slack that this station needs help'
                        : 'Register this station first'
                    }
                    onClick={() => {
                      setHelpOpen(false);
                      setAssistOpen(true);
                    }}
                  >
                    <BellRing size={14} /> Request assistance
                    {!identity?.station && <small>register first</small>}
                  </button>
                </div>
              )}
            </div>
            <div className="sidebar__clock rail-hide">
              <Clock compact />
            </div>
            <div className="sidebar__account" ref={accountRef}>
              <button
                className="sidebar__user"
                aria-label={`${identity?.authenticated ? `Account: ${operatorName}` : 'Read-only: Log in'} · ${stationName}`}
                aria-expanded={identity?.authenticated ? accountOpen : undefined}
                data-rail-label={identity?.authenticated ? `Account: ${operatorName}` : 'Log in'}
                onClick={identity?.authenticated ? () => setAccountOpen((open) => !open) : () => setIdentityOpen(true)}
              >
                {identity?.user?.avatarUrl ? (
                  <img className="sidebar__avatar" src={identity.user.avatarUrl} alt="" />
                ) : (
                  <CircleUser size={19} className="sidebar__icon" />
                )}
                <div className="sidebar__label rail-hide">
                  <span className="sidebar__username">{operatorName}</span>
                  <span className="sidebar__version">{stationName}</span>
                </div>
              </button>
              {accountOpen && identity?.authenticated && (
                <div className="accountmenu">
                  <div className="accountmenu__identity">
                    {identity.user?.avatarUrl ? <img src={identity.user.avatarUrl} alt="" /> : <CircleUser size={28} />}
                    <span><strong>{operatorName}</strong><small>@{identity.user?.username} · {stationName}</small></span>
                  </div>
                  <button onClick={() => setConfirmLock(true)}><LockKeyhole size={14} /> Lock station</button>
                </div>
              )}
            </div>
            <button
              className="sidebar__toggle"
              onClick={toggle}
              data-rail-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
              <span className="sidebar__label rail-hide">Collapse</span>
            </button>
          </div>
        </aside>

        <main className="shell__main">
          <AssistanceBar enabled={Boolean(identity?.station)} />
          {offLimits ? <Navigate to={lockedPrefix!} replace /> : <Outlet />}
        </main>
        {assistOpen && <AssistanceDialog onClose={() => setAssistOpen(false)} />}
        {identityOpen && (
          <IdentityDialog
            stationRequired={!identity?.station}
            campusId={campusId}
            status={identity}
            denied={denied}
            onStation={stationRegistered}
            onLogin={(next) => { setIdentity(next); setIdentityOpen(false); setDenied(null); }}
            onClose={() => { setIdentityOpen(false); setDenied(null); }}
          />
        )}
        {confirmLock && (
          <div className="confirm" role="dialog" aria-modal="true" aria-labelledby="lock-title">
            <div className="confirm__card">
              <p className="eyebrow">Shared station</p>
              <p className="confirm__text" id="lock-title">Lock <strong>{stationName}</strong> and return to read-only mode?</p>
              <div className="confirm__buttons">
                <button className="confirm__cancel" onClick={() => setConfirmLock(false)}>Cancel</button>
                <button className="confirm__ok" onClick={lock}>Lock station</button>
              </div>
            </div>
          </div>
        )}
        <HelpDrawer open={guideOpen} onClose={() => setGuideOpen(false)} />
      </div>
    </CampusContext.Provider>
    </IdentityContext.Provider>
    </ChurchContext.Provider>
  );
}
