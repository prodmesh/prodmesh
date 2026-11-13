import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Play, Radio, Square } from 'lucide-react';
import {
  clearAutomationDefault,
  clearShowConfig,
  saveAutomationDefault,
  type AutomationDefault,
  getPpPlaylist,
  getYouTubeBroadcasts,
  saveShowConfig,
  type PlanItem,
  type PlanTime,
  type PpPlaylist,
  type ShowConfig,
  type YouTubeBroadcast,
} from '../api';
import { Widget } from './Widget';
import { SelectField } from './SelectField';

// Pre-created broadcasts usually share a title ("Sunday Service"), so the
// scheduled time is what actually tells them apart — show it always.
function broadcastLabel(b: YouTubeBroadcast) {
  const when = b.actualStart ?? b.scheduledStart;
  const stamp = when
    ? new Date(when).toLocaleString([], {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      })
    : 'no date';
  return `${b.live ? '● LIVE · ' : ''}${stamp} · ${b.title}`;
}

// Sentinels for the select only — never stored. The stored form is
// key-absent / null / id, which keeps the default state out of the record.
const AUTO = '';
const NONE = '\u0000none';
const CLOCK = 'clock:scheduled'; // stored as startAtScheduledTime; no PC item id has a colon
const INHERIT = 'inherit:default'; // the field is absent from the event's record (#58)
const ON = 'on';
const OFF = 'off';

// Nothing of its own: every field inherits the service type default.
const EMPTY: ShowConfig = { map: {}, videos: {} };

/** Does the event set its own start? Either half of the pair says so. */
const ownsStart = (c: ShowConfig) => c.startAtScheduledTime !== undefined || c.startItemId !== undefined;

const norm = (s: string | null | undefined) => String(s ?? '').trim().toLowerCase();

/** The plan item a default's title names — the server's rule (showConfig.js). */
function itemByTitle(items: PlanItem[], title: string | null | undefined) {
  if (!title) return null;
  return items.find((i) => (i.type ?? 'item') !== 'header' && norm(i.title) === norm(title)) ?? null;
}

/** An event's settings over its default, as the show will run them. */
function effective(draft: ShowConfig, def: AutomationDefault | null, items: PlanItem[]) {
  const ownStart = ownsStart(draft);
  return {
    startItemId: ownStart
      ? draft.startItemId ?? null
      : def?.startAtScheduledTime ? null : itemByTitle(items, def?.startItemTitle)?.id ?? null,
    startAtScheduledTime: ownStart ? Boolean(draft.startAtScheduledTime) : Boolean(def?.startAtScheduledTime),
    endItemId: draft.endItemId !== undefined ? draft.endItemId : itemByTitle(items, def?.endItemTitle)?.id ?? null,
    servicesLiveFromProPresenter: draft.servicesLiveFromProPresenter !== undefined
      ? draft.servicesLiveFromProPresenter
      : Boolean(def?.servicesLiveFromProPresenter),
  };
}

/** Drop the three inheritable groups so the event follows its default. */
function inheritAll(config: ShowConfig): ShowConfig {
  return { map: config.map, videos: config.videos };
}

// Per-event show automation (one config per event, shared by all its service
// times): which PC item autostarts the show, which one auto-completes it at
// its last slide, and manual PC→PP mapping overrides for when the orders
// drift apart.
export function ShowConfigWidget({
  roomId,
  planId,
  items,
  times,
  saved,
  serviceType = null,
  automationDefault = null,
}: {
  roomId: string;
  planId: string;
  items: PlanItem[];
  times: PlanTime[];
  saved: ShowConfig | null;
  /** The plan's service type, whose default this event inherits (#58). */
  serviceType?: { id: string; name: string } | null;
  automationDefault?: AutomationDefault | null;
}) {
  const [draft, setDraft] = useState<ShowConfig>(saved ?? EMPTY);
  const [def, setDef] = useState<AutomationDefault | null>(automationDefault);
  const [persisted, setPersisted] = useState<ShowConfig | null>(saved); // what the server has
  const [pp, setPp] = useState<PpPlaylist | null | undefined>(undefined); // undefined = loading
  const [mapOpen, setMapOpen] = useState(false);
  const [ytOpen, setYtOpen] = useState(false);
  const [casts, setCasts] = useState<YouTubeBroadcast[] | null | undefined>(undefined);
  const [castErr, setCastErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    getPpPlaylist(roomId, planId)
      .then((r) => setPp(r.playlist))
      .catch(() => setPp(null));
  }, [roomId, planId]);

  useEffect(() => {
    // Only when the section is opened — the listing costs ~201 YouTube quota
    // units, which is fine for a deliberate action and wasteful on every page
    // view of an event nobody is pinning.
    if (!ytOpen || casts !== undefined) return;
    getYouTubeBroadcasts(roomId)
      .then((r) => {
        setCasts(r.configured ? r.broadcasts : null);
        setCastErr(r.error ?? null);
      })
      .catch((e) => {
        setCasts([]);
        setCastErr(e instanceof Error ? e.message : String(e));
      });
  }, [ytOpen, casts, roomId]);

  const trackable = items.filter((i) => (i.type ?? 'item') !== 'header');
  const serviceTimes = times.filter((t) => t.type === 'service');
  // Both "pinned" and "not streamed" are decisions worth surfacing on the
  // collapsed header — an unexpected "not streamed" is exactly the thing
  // someone needs to notice before Sunday.
  const setCount = Object.keys(draft.videos ?? {}).length;
  const ppItems = (pp?.items ?? []).filter((i) => i.type !== 'header');
  const overrideCount = Object.values(draft.map).filter(Boolean).length;
  const eff = effective(draft, def, items);
  const armed = effective(persisted ?? EMPTY, def, items);
  const isArmed = Boolean(armed.startItemId || armed.startAtScheduledTime || armed.endItemId || armed.servicesLiveFromProPresenter);
  const typeName = serviceType?.name ?? 'this service type';
  const titleOf = (id: string | null) => (id ? items.find((i) => i.id === id)?.title ?? null : null);

  // What the default says, in the words of each control's inherit option.
  const defStart = def?.startAtScheduledTime ? 'Scheduled time' : def?.startItemTitle ?? 'Never';
  const defEnd = def?.endItemTitle ?? 'Never';
  // A default naming an item this plan does not have runs nothing for that
  // field. Say so where it is chosen — on Sunday it would just not happen.
  const startMissing = !ownsStart(draft) && !def?.startAtScheduledTime
    && def?.startItemTitle && !itemByTitle(items, def.startItemTitle);
  const endMissing = draft.endItemId === undefined && def?.endItemTitle && !itemByTitle(items, def.endItemTitle);

  const saveAsDefault = async () => {
    if (!serviceType) return;
    setMsg(null);
    try {
      const next = await saveAutomationDefault(roomId, serviceType.id, {
        startItemTitle: eff.startAtScheduledTime ? null : titleOf(eff.startItemId),
        startAtScheduledTime: eff.startAtScheduledTime,
        endItemTitle: titleOf(eff.endItemId),
        servicesLiveFromProPresenter: eff.servicesLiveFromProPresenter,
      });
      setDef(next);
      // This event now follows the default it just set, so a later change to
      // the default reaches it like every other event of the type.
      const own = inheritAll(draft);
      if (persisted) {
        const saved = await saveShowConfig(roomId, planId, own);
        setPersisted(saved);
        setDraft(saved);
      } else {
        setDraft(own);
      }
      setMsg(`Saved as the ${typeName} default. Every ${typeName} event in this room uses it unless it sets its own.`);
    } catch (err) {
      setMsg(`Couldn’t save: ${err instanceof Error ? err.message : err}`);
    }
  };

  const clearDefault = async () => {
    if (!serviceType) return;
    try {
      await clearAutomationDefault(roomId, serviceType.id);
      setDef(null);
      setMsg(`Cleared the ${typeName} default.`);
    } catch (err) {
      setMsg(`Couldn’t clear: ${err instanceof Error ? err.message : err}`);
    }
  };

  const save = async () => {
    setMsg(null);
    try {
      const next = await saveShowConfig(roomId, planId, draft);
      setDraft(next);
      setPersisted(next);
      setMsg('Saved — automation is armed for this event.');
    } catch (err) {
      setMsg(`Couldn’t save: ${err instanceof Error ? err.message : err}`);
    }
  };

  const clear = async () => {
    await clearShowConfig(roomId, planId);
    setDraft(EMPTY);
    setPersisted(null);
    setMsg(def ? `Cleared — this event uses the ${typeName} default.` : 'Cleared — this event starts and ends manually.');
  };

  const itemSelect = (
    value: string | null | undefined,
    onChange: (v: string | null | undefined) => void,
    placeholder: string,
    inheritLabel: string,
  ) => (
    <SelectField
      className="showcfg__select"
      value={value === undefined ? INHERIT : value ?? ''}
      onChange={(e) => onChange(e.target.value === INHERIT ? undefined : e.target.value || null)}
    >
      <option value={INHERIT}>{inheritLabel}</option>
      <option value="">{placeholder}</option>
      {trackable.map((i) => (
        <option key={i.id} value={i.id}>
          {i.title}
        </option>
      ))}
    </SelectField>
  );

  return (
    <Widget
      title="Show Automation"
      meta={
        isArmed ? (
          <span className="svc__badge svc__badge--live">● armed</span>
        ) : (
          <span className="svc__badge svc__badge--mock">○ manual</span>
        )
      }
    >
      {/* The show's own lifecycle first, and Services LIVE as an option on top
          of it. It used to be the other way round: autostart could only be set
          through a Services LIVE trigger, which left churches that do not use
          Services LIVE with no way to autostart at all, and two dropdowns whose
          difference nobody could see. */}
      <p className="widget__hint">
        {eff.startAtScheduledTime
          ? 'Each service time of this event starts on the clock, whatever ProPresenter is showing.'
          : 'The show follows the ProPresenter operator — pre-service slides can loop between services without tripping anything. Applies to every service time of this event.'}
      </p>

      {/* The clock and the ProPresenter items share one dropdown because they
          are one decision — how the show starts. A second control for it would
          be the two-dropdown problem again. */}
      <div className="showcfg__row">
        <span className="showcfg__label">
          <Play size={13} /> Autostart service at
        </span>
        <SelectField
          className="showcfg__select"
          value={!ownsStart(draft) ? INHERIT : draft.startAtScheduledTime ? CLOCK : (draft.startItemId ?? '')}
          onChange={(e) => {
            const v = e.target.value;
            setDraft((d) => {
              if (v === INHERIT) {
                const { startItemId: _a, startAtScheduledTime: _b, ...rest } = d;
                return rest;
              }
              return { ...d, startAtScheduledTime: v === CLOCK, startItemId: v && v !== CLOCK ? v : null };
            });
          }}
        >
          <option value={INHERIT}>{typeName} default · {defStart}</option>
          <option value="">Never (start manually)</option>
          <option value={CLOCK}>Scheduled time</option>
          {trackable.length > 0 && (
            <optgroup label="When ProPresenter reaches">
              {trackable.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.title}
                </option>
              ))}
            </optgroup>
          )}
        </SelectField>
      </div>

      <div className="showcfg__row">
        <span className="showcfg__label">
          <Square size={12} /> Complete at last slide of
        </span>
        {itemSelect(draft.endItemId, (v) => setDraft((d) => {
          if (v === undefined) {
            const { endItemId: _e, ...rest } = d;
            return rest;
          }
          return { ...d, endItemId: v };
        }), 'Never (end manually)', `${typeName} default · ${defEnd}`)}
      </div>
      {startMissing && (
        <p className="showcfg__mismatch">No item titled “{def!.startItemTitle}” in this plan, so the default can’t start it. Choose a start for this event.</p>
      )}
      {endMissing && (
        <p className="showcfg__mismatch">No item titled “{def!.endItemTitle}” in this plan, so the default can’t end it.</p>
      )}

      <div className="showcfg__row">
        <span className="showcfg__label"><Radio size={13} /> ProPresenter controls Services LIVE</span>
        <SelectField
          className="showcfg__select"
          aria-label="ProPresenter controls Services LIVE"
          value={draft.servicesLiveFromProPresenter === undefined ? INHERIT : draft.servicesLiveFromProPresenter ? ON : OFF}
          onChange={(e) => {
            const v = e.target.value;
            setDraft((d) => {
              if (v === INHERIT) {
                const { servicesLiveFromProPresenter: _s, ...rest } = d;
                return rest;
              }
              return { ...d, servicesLiveFromProPresenter: v === ON };
            });
          }}
        >
          <option value={INHERIT}>{typeName} default · {def?.servicesLiveFromProPresenter ? 'On' : 'Off'}</option>
          <option value={ON}>On</option>
          <option value={OFF}>Off</option>
        </SelectField>
      </div>
      {eff.servicesLiveFromProPresenter && (
        <p className="widget__hint">
          Planning Center Services LIVE follows this show: ProdMesh takes control when the show
          starts, moves it forward with each item, and lets go when the show ends. It never moves
          Services LIVE backward, and never takes it back from someone who took over by hand.
        </p>
      )}

      {serviceTimes.length > 0 && (
        <>
          <button className="showcfg__maptoggle" onClick={() => setYtOpen((o) => !o)}>
            {ytOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            YouTube broadcast
            {setCount > 0 && (
              <span className="showcfg__mapcount">{setCount} set</span>
            )}
          </button>

          {ytOpen && (
            casts === undefined ? (
              <p className="svc__muted">Loading broadcasts…</p>
            ) : casts === null ? (
              <p className="svc__muted">
                This room has no YouTube channel set — add one on the room’s configuration page.
              </p>
            ) : (
              <div className="showcfg__map">
                <p className="widget__hint">
                  Each service records whichever broadcast is live at the time, which is normally
                  right even when the channel pre-creates one per service. Pin a specific broadcast
                  to override that — or mark a service <em>Not streamed</em>, which stops it
                  recording a broadcast left running from an earlier service.
                </p>
                {castErr && <p className="showcfg__mismatch">Couldn’t list broadcasts: {castErr}</p>}
                {serviceTimes.map((t) => (
                  <div key={t.id} className="showcfg__row">
                    <span className="showcfg__label">
                      <Radio size={12} /> {t.name}
                      {t.startsAt && (
                        <span className="showcfg__when">
                          {new Date(t.startsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                        </span>
                      )}
                    </span>
                    <SelectField
                      className="showcfg__select"
                      value={
                        !(t.id in (draft.videos ?? {}))
                          ? AUTO
                          : draft.videos[t.id] === null
                            ? NONE
                            : (draft.videos[t.id] as string)
                      }
                      onChange={(e) => {
                        const v = e.target.value;
                        setDraft((d) => {
                          const videos = { ...(d.videos ?? {}) };
                          if (v === AUTO) delete videos[t.id];
                          else if (v === NONE) videos[t.id] = null;
                          else videos[t.id] = v;
                          return { ...d, videos };
                        });
                      }}
                    >
                      <option value={AUTO}>Auto — whatever is live</option>
                      <option value={NONE}>Not streamed — record nothing</option>
                      {casts.map((b) => (
                        <option key={b.videoId} value={b.videoId}>
                          {broadcastLabel(b)}
                        </option>
                      ))}
                      {/* A pin whose broadcast has since left the live/scheduled
                          list must stay selectable, or saving would silently
                          drop it. */}
                      {typeof draft.videos?.[t.id] === 'string'
                        && !casts.some((b) => b.videoId === draft.videos[t.id]) && (
                        <option value={draft.videos[t.id] as string}>
                          {draft.videos[t.id]} (not listed)
                        </option>
                      )}
                    </SelectField>
                  </div>
                ))}
              </div>
            )
          )}
        </>
      )}

      <button className="showcfg__maptoggle" onClick={() => setMapOpen((o) => !o)}>
        {mapOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        ProPresenter mapping
        {overrideCount > 0 && <span className="showcfg__mapcount">{overrideCount} override{overrideCount > 1 ? 's' : ''}</span>}
      </button>

      {mapOpen &&
        (pp === undefined ? (
          <p className="svc__muted">Checking ProPresenter…</p>
        ) : pp === null ? (
          <p className="svc__muted">
            ProPresenter isn’t reachable (or has no playlist open). Open this service’s playlist in
            PP, then reload to map items.
          </p>
        ) : (
          <div className="showcfg__map">
            {pp.matched ? (
              <p className="widget__hint">
                Mapping against this event’s playlist (“{pp.playlistName}”). Items map
                automatically by order — override only the ones that drifted.
              </p>
            ) : (
              <p className="showcfg__mismatch">
                Couldn’t find this event’s playlist in ProPresenter — showing the open one
                (“{pp.playlistName}”), which looks like a <em>different</em> service. Push this
                plan from Planning Center first, or map with care.
              </p>
            )}
            {trackable.map((it) => {
              const mapping = draft.map[it.id];
              const mappingValue = mapping && 'disabled' in mapping
                ? NONE
                : mapping && 'ppIndex' in mapping
                  ? mapping.ppIndex
                  : '';
              return (
              <div key={it.id} className="showcfg__maprow">
                <span className="showcfg__pcitem">{it.title}</span>
                <SelectField
                  className="showcfg__select"
                  value={mappingValue}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      map: {
                        ...d.map,
                        [it.id]: e.target.value === NONE
                          ? { disabled: true }
                          : e.target.value
                          ? {
                              ppIndex: Number(e.target.value),
                              ppName: ppItems.find((p) => p.index === Number(e.target.value))?.name ?? null,
                            }
                          : null,
                      },
                    }))
                  }
                >
                  <option value="">Auto</option>
                  <option value={NONE}>None — no ProPresenter presentation</option>
                  {ppItems.map((p) => (
                    <option key={p.index} value={p.index}>
                      {p.name}
                    </option>
                  ))}
                </SelectField>
              </div>
              );
            })}
          </div>
        ))}

      <div className="showcfg__actions">
        <button className="btn btn--primary btn--sm" onClick={save}>
          Save automation
        </button>
        {serviceType && (
          <button className="btn btn--sm" onClick={saveAsDefault}>
            Save as {typeName} default
          </button>
        )}
        {persisted && (
          <button className="btn btn--ghost btn--sm" onClick={clear}>
            Clear
          </button>
        )}
      </div>
      {serviceType && def && (
        <p className="widget__hint">
          {typeName} default: start {defStart} · complete after {defEnd} · Services LIVE {def.servicesLiveFromProPresenter ? 'on' : 'off'}.{' '}
          <button className="linkbtn" onClick={clearDefault}>Clear default</button>
        </p>
      )}
      {msg && <p className="showcfg__msg">{msg}</p>}
    </Widget>
  );
}
