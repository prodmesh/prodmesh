import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ChevronLeft, ChevronRight, ListVideo, MonitorPlay } from 'lucide-react';
import { proPresenterControl, type ProPresenterState } from '../api';
import { roomTopic, useTopic } from '../lib/stream';
import { scrollWithin } from '../lib/scrollWithin';
import type { WidgetProps } from './types';

/** The server deliberately sends compact runtime frames after a rich playlist
 * snapshot. Merge them here so a slide advance cannot replace the browser's
 * focused playlist with `{ runtime }` and make the UI claim it disappeared. */
function useProPresenterState(roomId: string) {
  const frame = useTopic<ProPresenterState>(roomTopic.proPresenter(roomId));
  const full = useRef<ProPresenterState | undefined>(undefined);
  // A freshly reconnected PP stream can briefly label an empty focus response
  // as a full frame. Never let that erase the playlist already on screen.
  const hasPlaylist = Boolean(frame?.focusedPlaylist?.items?.length);
  if (frame?.full && (hasPlaylist || !full.current?.focusedPlaylist?.items?.length)) full.current = frame;
  else if (frame && full.current) full.current = { ...full.current, ...frame, runtime: frame.runtime ?? full.current.runtime };
  return full.current ?? frame;
}
const fmt = (n: number | null) => n == null ? '—' : `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;

export function ProPresenterSlides({ roomId }: WidgetProps) {
  const state = useProPresenterState(roomId); const runtime = state?.runtime;
  if (!runtime) return <p className="wgt__empty">ProPresenter offline</p>;
  const item = state?.focusedPlaylist?.items.find((x) => x.presentationUuid === runtime.activePresentationUuid);
  const cue = item?.slides[runtime.activeCueIndex ?? -1];
  return <section className="ppwidget"><h3><MonitorPlay size={15} /> {item?.title ?? 'ProPresenter'}</h3><strong>{cue ? `Slide ${cue.number}` : 'No active slide'}</strong><p>{cue?.text || 'No slide text available'}</p>{cue?.section && <small>{cue.section}</small>}{runtime.video && <small>{runtime.video.name} · {fmt(runtime.video.seconds)} / {fmt(runtime.video.duration)}</small>}</section>;
}

export function SlideNotes({ roomId }: WidgetProps) {
  const state = useProPresenterState(roomId); const rt = state?.runtime;
  const item = state?.focusedPlaylist?.items.find((x) => x.presentationUuid === rt?.activePresentationUuid);
  const note = item?.slides[rt?.activeCueIndex ?? -1]?.note;
  return note ? <section className="ppwidget"><h3>Slide notes</h3><p>{note}</p></section> : <p className="wgt__empty">No slide notes</p>;
}

export function ProPresenterTimers({ roomId }: WidgetProps) {
  const timers = useProPresenterState(roomId)?.runtime?.timers ?? [];
  return <section className="ppwidget"><h3>ProPresenter timers</h3>{timers.length ? timers.map((timer) => <p key={timer.uuid ?? timer.name}><strong>{fmt(timer.remainingSeconds)}</strong> {timer.name} · {timer.state}</p>) : <p>No timers</p>}</section>;
}

type Action = 'previous' | 'next' | 'previous-item' | 'next-item' | 'presentation' | 'cue';
function action(roomId: string, config: WidgetProps['config'], actionName: Action, playlistIndex?: number, cueIndex?: number, presentationUuid?: string | null, isPco?: boolean) {
  if (!config.slideControls) return;
  return proPresenterControl(roomId, { viewId: config.viewId, widgetId: config.widgetId, action: actionName, playlistIndex, cueIndex, presentationUuid, isPco });
}

export function ProPresenterControls({ roomId, config }: WidgetProps) {
  const state = useProPresenterState(roomId); const disabled = !config.slideControls;
  const run = (name: Action) => { void action(roomId, config, name)?.catch(() => {}); };
  return <section className="ppwidget ppwidget--controls"><h3>ProPresenter controls</h3><p>{state?.runtime?.activePresentationUuid ? 'Connected' : 'Waiting for ProPresenter'}</p><div className="ppcontrols"><button disabled={disabled} onClick={() => run('previous-item')}>Previous item</button><button disabled={disabled} onClick={() => run('next-item')}>Next item</button><button disabled={disabled} onClick={() => run('previous')}><ChevronLeft /> Previous slide</button><button disabled={disabled} onClick={() => run('next')}>Next slide <ChevronRight /></button></div></section>;
}

export function ProPresenterPlaylist({ roomId, config }: WidgetProps) {
  const state = useProPresenterState(roomId); const active = state?.runtime; const ref = useRef<HTMLDivElement>(null);
  const storageKey = `prodmesh.pp.keyboard.${config.viewId}.${config.widgetId}`;
  const [keyboard, setKeyboard] = useState(() => config.keyboardControls && localStorage.getItem(storageKey) !== 'off');
  // The stored setting grants capability. This local switch is the operator's
  // quick safety latch; turning it off never rewrites the dashboard default.
  const [controls, setControls] = useState(Boolean(config.slideControls));
  const [controlError, setControlError] = useState<string | null>(null);
  const activeKey = `${active?.activePresentationUuid}:${active?.activeCueIndex}`;
  useEffect(() => {
    if (!config.followActive || !ref.current) return;
    // Within the playlist's own scroll box, never the page (#36).
    const box = ref.current.querySelector<HTMLElement>('.ppplaylist__scroll');
    const node = ref.current.querySelector<HTMLElement>('[data-active-cue="true"]');
    if (box && node) scrollWithin(box, node, { block: 'nearest' });
  }, [activeKey, config.followActive]);
  useEffect(() => {
    if (!keyboard || !controls) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return;
      if (event.key === 'ArrowLeft') { event.preventDefault(); action(roomId, config, 'previous'); }
      if (event.key === 'ArrowRight' || event.key === ' ') { event.preventDefault(); action(roomId, config, 'next'); }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [keyboard, controls, config, roomId]);
  if (!state?.focusedPlaylist) return <p className="wgt__empty">No focused playlist</p>;
  const switchKeyboard = () => { const next = !keyboard; setKeyboard(next); localStorage.setItem(storageKey, next ? 'on' : 'off'); };
  const controlledConfig = { ...config, slideControls: controls };
  const style = { '--pp-slide-size': `${config.slideSize ?? 60}px` } as CSSProperties;
  const runControl = (...args: Parameters<typeof action>) => {
    Promise.resolve(action(...args)).then(() => setControlError(null)).catch((error: unknown) => setControlError(error instanceof Error ? error.message : 'ProPresenter did not accept that control.'));
  };
  return <section className="ppwidget ppwidget--playlist" style={style} ref={ref}><header><h3><ListVideo size={15} /> {state.focusedPlaylist.name ?? 'Focused playlist'}</h3><span className="ppwidget__toggles"><label><input type="checkbox" checked={controls} disabled={!config.slideControls} onChange={(event) => setControls(event.target.checked)} /> Slide controls</label>{config.keyboardControls && <label><input type="checkbox" checked={keyboard} disabled={!controls} onChange={switchKeyboard} /> Keyboard</label>}</span></header>{!config.slideControls && <p className="ppwidget__notice">Controls are disabled in this dashboard’s editor settings.</p>}{controlError && <p className="ppwidget__error" role="alert">{controlError}</p>}<div className="ppplaylist__scroll">{state.focusedPlaylist.items.map((item) => { let priorSection = ''; return <section className={item.presentationUuid === active?.activePresentationUuid ? 'ppitem ppitem--active' : 'ppitem'} key={`${item.index}:${item.title}`}><button className="ppitem__header" disabled={!controls || !item.triggerable} onClick={() => runControl(roomId, controlledConfig, 'presentation', item.index, undefined, item.presentationUuid, item.isPco)}><span>{item.index + 1}</span>{item.title}{item.presentationTitle && item.presentationTitle !== item.title ? ` [${item.presentationTitle}]` : ''}</button>{item.slides.length ? <div className="ppitem__slides">{item.slides.map((cue) => { const newSection = cue.section !== priorSection; priorSection = cue.section; return <button key={cue.index} data-active-cue={item.presentationUuid === active?.activePresentationUuid && cue.index === active?.activeCueIndex} className={cue.index === active?.activeCueIndex && item.presentationUuid === active?.activePresentationUuid ? 'ppcue ppcue--active' : 'ppcue'} disabled={!controls} onClick={() => runControl(roomId, controlledConfig, 'cue', item.index, cue.index, item.presentationUuid, item.isPco)}>{newSection && cue.section && <small className="ppcue__section" style={{ '--part-color': cue.color ?? '#6da8ff' } as CSSProperties}>{cue.section}</small>}<b>{cue.number}</b>{config.slideMode !== 'text' && item.presentationUuid && <img loading="lazy" alt="" src={`/api/rooms/${encodeURIComponent(roomId)}/propresenter/thumbnail/${encodeURIComponent(item.presentationUuid)}/${cue.thumbnailIndex ?? cue.index}`} onError={(event) => { event.currentTarget.hidden = true; event.currentTarget.nextElementSibling?.removeAttribute('hidden'); }} />}{config.slideMode !== 'text' && <span className="ppcue__fallback" hidden>{cue.text || `Slide ${cue.number}`}</span>}{config.slideMode === 'text' && <span>{cue.text || 'Blank'}</span>}</button>; })}</div> : <p className="ppitem__empty">No slides returned by ProPresenter</p>}</section>; })}</div></section>;
}
