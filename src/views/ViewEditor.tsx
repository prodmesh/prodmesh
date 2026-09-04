import { useMemo, useRef, useState } from 'react';
import { GripVertical, X } from 'lucide-react';
import { ViewCanvas } from './ViewCanvas';
import { WidgetPalette, paletteFor } from './WidgetPalette';
import { useGridDrag, type Cell } from './useGridDrag';
import { findFirstFit, isFree, occupancy, rowCount, type Grid } from '../lib/gridLayout';
import { widgetRegistry, isWidgetType } from '../widgets/registry';
import { widgetMax, widgetMin, widgetResizable, type CompanionVariableRow, type WidgetSize } from '../widgets/types';
import { IntegrationBeta, IntegrationBrand } from '../components/IntegrationBrand';
import { HelpTip } from '../components/HelpTip';
import { getEnabledIntegrations, getRoom, getRoomConnectivity, type View, type ViewPlacement } from '../api';
import { useQuery } from '../lib/useQuery';
import { analysisIntegration, analysisWidgetTitle } from '../lib/analysisSource';
import { captionIntegration, captionWidgetTitle } from '../lib/captionSource';

// ─────────────────────────────────────────────────────────────────────────────
//  Arranging a view.
//
//  The canvas is the SAME ViewCanvas the live page renders, with `chrome`
//  passed per cell. One renderer means the editor's preview cannot drift from
//  what a screen in the building actually shows — which is the failure mode of
//  every layout editor that draws its own approximation.
//
//  Widgets stay LIVE while you arrange them: a ticking countdown, a real SPL
//  meter. Only the header strip is interactive, and the body is inert via CSS.
//  Solving that with a prop would have meant widening WidgetProps, and that
//  contract being narrow is the whole reason a layout can be data.
// ─────────────────────────────────────────────────────────────────────────────

const ARROWS: Record<string, Cell> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

export function ViewEditor({
  view,
  grid,
  onChange,
}: {
  view: View;
  grid: Grid;
  onChange: (widgets: ViewPlacement[]) => void;
}) {
  const canvas = useRef<HTMLDivElement>(null);
  // Which card is in keyboard "grab" mode, and what the last move announced.
  const [grabbed, setGrabbed] = useState<string | null>(null);
  const [announcement, setAnnounce] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  const placements = view.widgets;
  const room = useQuery(`room:${view.roomId}`, () => getRoom(view.roomId), { staleMs: 60_000 }).data;
  const connectivity = useQuery(`room-connectivity:${view.roomId}`, () => getRoomConnectivity(view.roomId), { staleMs: 15_000 }).data;
  const enabledIntegrations = useQuery('enabled-integrations', getEnabledIntegrations, { staleMs: 60_000 }).data?.enabled;
  const analysisSource = room?.analysisSource;
  const captionSource = connectivity?.captions?.source;

  // ONE row count for the canvas and the pointer maths. A dashboard normally
  // sizes to its content, which would leave the editor dividing by rows the
  // browser never drew — the drop then lands wherever that arithmetic says,
  // which is not where the cursor is. A row of headroom past the deepest
  // widget is what lets a dashboard be extended by dropping below it.
  const rows =
    grid.maxRows ?? Math.max(rowCount(grid, placements) + 1, grid.defaultRows ?? 1);
  const palette = useMemo(() => paletteFor(view.kind, grid, placements, analysisSource, captionSource, enabledIntegrations), [view.kind, grid, placements, analysisSource, captionSource, enabledIntegrations]);

  const place = (type: string, at: Cell) => {
    const def = isWidgetType(type) ? widgetRegistry[type] : null;
    if (!def) return;
    onChange([
      ...placements,
      { id: `new-${type}-${placements.length}`, type, ...at, ...def.size, config: {} },
    ]);
  };

  const moveTo = (id: string, at: Cell) =>
    onChange(placements.map((p) => (p.id === id ? { ...p, ...at } : p)));

  const remove = (id: string) => {
    onChange(placements.filter((p) => p.id !== id));
    if (grabbed === id) setGrabbed(null);
  };

  const resizeTo = (id: string, size: WidgetSize) =>
    onChange(placements.map((p) => (p.id === id ? { ...p, ...size } : p)));

  const setConfig = (id: string, patch: Record<string, unknown>) =>
    onChange(placements.map((p) => (p.id === id ? { ...p, config: { ...p.config, ...patch } } : p)));

  /** How far a widget may be stretched — the server enforces the same bounds. */
  const boundsFor = (type: string) => {
    const def = isWidgetType(type) ? widgetRegistry[type] : null;
    return def
      ? { min: widgetMin(def), max: widgetMax(def) }
      : { min: { w: 1, h: 1 }, max: { w: 1, h: 1 } };
  };

  const { drag, addHandlers, moveHandlers, resizeHandlers } = useGridDrag({
    canvas,
    grid,
    placements,
    onAdd: place,
    onMove: moveTo,
    onResize: resizeTo,
  });

  const addFromPalette = (type: string) => {
    const def = isWidgetType(type) ? widgetRegistry[type] : null;
    const at = def && findFirstFit(grid, placements, def.size);
    if (!at || !def) return;
    place(type, at);
    setAnnounce(`${def.title} added at column ${at.x + 1}, row ${at.y + 1}.`);
  };

  const titleOf = (type: string) =>
    isWidgetType(type) ? analysisWidgetTitle(type, analysisSource) ?? (type === 'captions' ? captionWidgetTitle(captionSource) : null) ?? widgetRegistry[type].title : type;

  const integrationOf = (type: string) =>
    isWidgetType(type) && analysisWidgetTitle(type, analysisSource)
      ? analysisIntegration(analysisSource)
    : type === 'captions' ? captionIntegration(captionSource)
      : isWidgetType(type) ? widgetRegistry[type].integration ?? 'prodmesh' : 'prodmesh';

  /** Arrow-key movement for the grabbed card. Refuses rather than shoves. */
  const nudge = (placement: ViewPlacement, delta: Cell) => {
    const next = { x: placement.x + delta.x, y: placement.y + delta.y };
    const title = titleOf(placement.type);
    const cells = occupancy(placements, placement.id);
    if (!isFree(grid, cells, { ...next, w: placement.w, h: placement.h })) {
      setAnnounce(`${title} cannot move there.`);
      return;
    }
    moveTo(placement.id, next);
    setAnnounce(`${title} at column ${next.x + 1}, row ${next.y + 1}.`);
  };

  /** Shift+arrow stretches it, within what the widget declares. */
  const stretch = (placement: ViewPlacement, delta: Cell) => {
    const title = titleOf(placement.type);
    const { min, max } = boundsFor(placement.type);
    const size = {
      w: Math.max(min.w, Math.min(placement.w + delta.x, max.w)),
      h: Math.max(min.h, Math.min(placement.h + delta.y, max.h)),
    };
    if (size.w === placement.w && size.h === placement.h) {
      setAnnounce(`${title} cannot be resized further.`);
      return;
    }
    if (!isFree(grid, occupancy(placements, placement.id), { x: placement.x, y: placement.y, ...size })) {
      setAnnounce(`${title} cannot grow there.`);
      return;
    }
    resizeTo(placement.id, size);
    setAnnounce(`${title} is now ${size.w} by ${size.h}.`);
  };

  const chromeFor = (placement: ViewPlacement) => {
    const title = titleOf(placement.type);
    const held = grabbed === placement.id;
    const def = isWidgetType(placement.type) ? widgetRegistry[placement.type] : null;
    const resizable = def ? widgetResizable(def) : false;
    return (
      <div className="viewcell__chrome">
        <button
          type="button"
          className="viewcell__grip"
          aria-pressed={held}
          aria-label={
            `Move ${title}, column ${placement.x + 1}, row ${placement.y + 1}` +
            (resizable ? `, ${placement.w} by ${placement.h}` : '')
          }
          title={
            resizable
              ? 'Drag to move. Enter then arrows to move, shift+arrows to resize'
              : 'Drag to move, or press Enter and use the arrow keys'
          }
          {...moveHandlers(placement)}
          onClick={() => setSelected(placement.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setGrabbed(held ? null : placement.id);
              setAnnounce(held ? `${title} placed.` : `${title} grabbed. Use the arrow keys.`);
            } else if (e.key === 'Escape' && held) {
              setGrabbed(null);
              setAnnounce(`${title} placed.`);
            } else if (held && ARROWS[e.key]) {
              e.preventDefault();
              if (e.shiftKey) stretch(placement, ARROWS[e.key]);
              else nudge(placement, ARROWS[e.key]);
            }
          }}
        >
          <GripVertical size={14} aria-hidden />
          {def && <IntegrationBrand integration={integrationOf(placement.type)} />}
          <span className="viewcell__name">{title}</span>{def && <IntegrationBeta integration={integrationOf(placement.type)} />}
        </button>
        <button
          type="button"
          className="viewcell__remove"
          aria-label={`Remove ${title}`}
          onClick={() => remove(placement.id)}
        >
          <X size={14} />
        </button>

        {/* Every widget can grow in both directions within the shared layout
            range; the server applies the exact same bounds on save. */}
        {resizable && (
          <span
            className="viewcell__resize"
            title={`Drag to resize (${widgetMin(def!).w}–${widgetMax(def!).w} columns, ${widgetMin(def!).h}–${widgetMax(def!).h} rows)`}
            aria-hidden
            {...resizeHandlers(placement, boundsFor(placement.type))}
          />
        )}
      </div>
    );
  };

  // The drop shadow. Drawn inside the grid so it lands on real cells rather
  // than on a pixel guess about where they are.
  const ghost = drag.kind !== 'none' && drag.at && (
    <div
      className={`viewghost viewghost--${drag.kind}${drag.ok ? '' : ' viewghost--blocked'}`}
      style={{
        gridColumn: `${drag.at.x + 1} / span ${drag.size.w}`,
        gridRow: `${drag.at.y + 1} / span ${drag.size.h}`,
      }}
      aria-hidden
    />
  );

  return (
    <div className="vieweditor">
      <WidgetPalette entries={palette} onAdd={addFromPalette} dragHandlers={addHandlers} />

      <div className="vieweditor__canvas">
        {view.kind === 'display' ? (
          <div className="viewframe">
            <ViewCanvas
              view={{ ...view, widgets: placements }}
              grid={grid}
              config={{}}
              rows={rows}
              canvasRef={canvas}
              className="viewgrid--editing"
              chromeFor={chromeFor}
              overlay={ghost}
            />
          </div>
        ) : (
          <ViewCanvas
            view={{ ...view, widgets: placements }}
            grid={grid}
            config={{}}
            rows={rows}
            canvasRef={canvas}
            className="viewgrid--editing"
            chromeFor={chromeFor}
            overlay={ghost}
          />
        )}
        {placements.length === 0 && (
          <p className="vieweditor__hint">Add a widget from the list, or drag one onto the grid.</p>
        )}
      </div>

      <WidgetInspector placement={placements.find((p) => p.id === selected) ?? null} onChange={setConfig} />

      {/* Every keyboard move says where it landed, or that it refused. */}
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
    </div>
  );
}

/** Settings live beside the canvas, never inside a small widget cell. */
function WidgetInspector({ placement, onChange }: { placement: ViewPlacement | null; onChange: (id: string, patch: Record<string, unknown>) => void }) {
  const pp = placement && (placement.type === 'propresenter-playlist' || placement.type === 'propresenter-controls');
  const loudness = placement && (placement.type === 'loudness' || placement.type === 'loudness-trend');
  const rta = placement?.type === 'rta';
  const resiPlayer = placement && (placement.type === 'resi-stream' || placement.type === 'resi-broadcast');
  const restream = placement?.type === 'restream';
  const obs = placement?.type === 'obs-health';
  const companion = placement?.type === 'companion-variables';
  const title = placement?.type === 'propresenter-playlist' ? 'ProPresenter Playlist' : placement?.type === 'propresenter-controls' ? 'ProPresenter Controls' : 'Decibel Meter';
  if (!placement) {
    return <aside className="widgetinspector"><h2>Widget settings</h2><p>Select a widget to configure it.</p></aside>;
  }
  // Split in two because the questions are: what this KIND of widget shows
  // (below, per type), and how any widget SITS on the canvas (the appearance
  // block). The second half is why the panel no longer has a "this widget has
  // no settings" state — every widget has at least its header.
  const specific = obs ? <ObsHealthInspector placement={placement} onChange={onChange} /> : companion ? <CompanionRows rows={placement.config.rows ?? []} onChange={(rows) => onChange(placement.id, { rows })} /> : rta ? <><p className="widgetinspector__name">ProdMesh RTA</p><label>Source room<input placeholder="This room" value={placement.config.sourceRoomId ?? ''} onChange={(e) => onChange(placement.id, { sourceRoomId: e.target.value || undefined })} /></label><small>Leave blank to use this room’s ProdMesh RTA. Enter another room ID to monitor its analyzer independently.</small></> : loudness ? <><p className="widgetinspector__name">{title}</p><label>Target dB<input type="number" min="40" max="130" placeholder="Optional" value={placement.config.target ?? ''} onChange={(e) => onChange(placement.id, { target: e.target.value === '' ? undefined : Number(e.target.value) })} /></label><label>Limit dB<input type="number" min="40" max="130" placeholder="Optional" value={placement.config.limit ?? ''} onChange={(e) => onChange(placement.id, { limit: e.target.value === '' ? undefined : Number(e.target.value) })} /></label><label>Weighting<select value={placement.config.weighting ?? 'A'} onChange={(e) => onChange(placement.id, { weighting: e.target.value })}><option value="A">A-weighted</option><option value="B">B-weighted</option><option value="C">C-weighted</option><option value="Z">Z-weighted</option></select></label><label>Response<select value={placement.config.response ?? 'Slow'} onChange={(e) => onChange(placement.id, { response: e.target.value })}><option value="Fast">Fast</option><option value="Slow">Slow</option></select></label></> : restream ? <><p className="widgetinspector__name">Restream</p><label className="widgetinspector__check"><input type="checkbox" checked={Boolean(placement.config.videoPreview)} onChange={(e) => onChange(placement.id, { videoPreview: e.target.checked })} /> Show YouTube video preview</label><small>Shows the active YouTube destination inside this widget.</small><label className="widgetinspector__check"><input type="checkbox" checked={Boolean(placement.config.destinationLinks)} onChange={(e) => onChange(placement.id, { destinationLinks: e.target.checked })} /> Show destination links</label><small>Opens each active destination in a new tab.</small></> : resiPlayer ? <><p className="widgetinspector__name">{placement.type === 'resi-stream' ? 'Resi Stream' : 'Resi Broadcast Monitor'}</p><label>Player aspect ratio<select value={placement.config.aspectRatio ?? '16:9'} onChange={(e) => onChange(placement.id, { aspectRatio: e.target.value })}><option value="16:9">16:9 widescreen</option><option value="4:3">4:3 standard</option><option value="1:1">Square</option></select></label><label className="widgetinspector__check"><input type="checkbox" checked={Boolean(placement.config.autoplay)} onChange={(e) => onChange(placement.id, { autoplay: e.target.checked })} /> Autoplay when allowed</label><label className="widgetinspector__check"><input type="checkbox" checked={placement.config.muted ?? true} onChange={(e) => onChange(placement.id, { muted: e.target.checked })} /> Muted by default</label><label className="widgetinspector__check"><input type="checkbox" checked={placement.config.playerControls ?? true} onChange={(e) => onChange(placement.id, { playerControls: e.target.checked })} /> Show player controls</label></> : !pp ? <p className="widgetinspector__name">{isWidgetType(placement.type) ? widgetRegistry[placement.type].title : placement.type}</p> : <><p className="widgetinspector__name">{title}</p><label className="widgetinspector__check"><input type="checkbox" checked={Boolean(placement.config.slideControls)} onChange={(event) => onChange(placement.id, { slideControls: event.target.checked })} /> Enable slide controls</label>{placement.type === 'propresenter-playlist' && <><label className="widgetinspector__check"><input type="checkbox" checked={Boolean(placement.config.keyboardControls)} onChange={(event) => onChange(placement.id, { keyboardControls: event.target.checked })} /> Enable arrow keys and spacebar</label><label className="widgetinspector__check"><input type="checkbox" checked={Boolean(placement.config.followActive)} onChange={(event) => onChange(placement.id, { followActive: event.target.checked })} /> Follow active cue</label><label>Slide display<select value={placement.config.slideMode ?? 'image'} onChange={(event) => onChange(placement.id, { slideMode: event.target.value })}><option value="image">Rendered previews</option><option value="text">Slide text</option></select></label><label>Slide width (px)<input type="number" min="0" max="200" step="1" value={placement.config.slideSize ?? 60} onChange={(event) => onChange(placement.id, { slideSize: Number(event.target.value) })} /><small>0–200 px. Lower values fit more cues across; 0 uses a safe 32 px rendering floor.</small></label></>}</>;

  return (
    <aside className="widgetinspector">
      <h2>Widget settings</h2>
      {specific}
      <label className="widgetinspector__check">
        <input
          type="checkbox"
          checked={Boolean(placement.config.hideHeader)}
          onChange={(e) => onChange(placement.id, { hideHeader: e.target.checked })}
        /> Hide widget title
        {/* Optional reading, per docs/UI_TEXT.md: the label says what the
            switch does, and the tip answers the question it raises — where
            the widget goes once its title strip is gone. Nothing must-know
            is in here; the editor keeps its handle either way. */}
        <HelpTip text="Removes the title strip on the live view only. In this editor the widget keeps its handle, so you can still move it and open its settings." />
      </label>
    </aside>
  );
}

function ObsHealthInspector({ placement, onChange }: { placement: ViewPlacement; onChange: (id: string, patch: Record<string, unknown>) => void }) {
  return <>
    <p className="widgetinspector__name">OBS Studio Health</p>
    <label className="widgetinspector__check"><input type="checkbox" checked={placement.config.obsPreview ?? true} onChange={(event) => onChange(placement.id, { obsPreview: event.target.checked })} /> Show program preview</label>
    <small>Uses the optional preview image URL configured for this room in Campus setup.</small>
    <label className="widgetinspector__check"><input type="checkbox" checked={Boolean(placement.config.obsDetails)} onChange={(event) => onChange(placement.id, { obsDetails: event.target.checked })} /> Show system details</label>
  </>;
}

/**
 * The Companion widget's rows.
 *
 * Written out rather than folded into the ternary above because it is the
 * only setting that is a LIST — rows are added, removed and reordered — and a
 * list editor inline in an expression is where that panel would stop being
 * readable.
 *
 * Fields appear per display style, since the questions genuinely differ: a
 * bullet needs to know which values are good, a bar needs to know the ends,
 * and plain text needs neither. Showing all of them always would ask every
 * operator to ignore four boxes to fill in one.
 */
function CompanionRows({ rows, onChange }: { rows: CompanionVariableRow[]; onChange: (rows: CompanionVariableRow[]) => void }) {
  const patch = (i: number, fields: Partial<CompanionVariableRow>) =>
    onChange(rows.map((row, n) => (n === i ? { ...row, ...fields } : row)));

  return (
    <>
      <p className="widgetinspector__name">Companion variables</p>

      {rows.map((row, i) => (
        <fieldset className="cvarsettings" key={i}>
          <legend>
            Variable {i + 1}
            <button type="button" onClick={() => onChange(rows.filter((_, n) => n !== i))}>
              Remove
            </button>
          </legend>

          <label>
            Variable
            <input
              value={row.variable}
              placeholder="custom:roomState"
              onChange={(e) => patch(i, { variable: e.target.value.trim() })}
            />
            {/* Companion's own syntax, minus the $() an operator would have to
                remember to strip. `custom` is its reserved label for custom
                variables; anything else is a connection label. */}
            <small>As Companion writes it: <code>custom:name</code>, or <code>connection:name</code> for a module variable.</small>
          </label>

          <label>
            Label
            <input
              value={row.label ?? ''}
              placeholder="Optional — defaults to the variable name"
              onChange={(e) => patch(i, { label: e.target.value })}
            />
          </label>

          <label>
            Display
            <select value={row.display ?? 'text'} onChange={(e) => patch(i, { display: e.target.value as CompanionVariableRow['display'] })}>
              <option value="text">Text</option>
              <option value="status">Text with a status bullet</option>
              <option value="bar">Progress bar</option>
            </select>
          </label>

          {row.display === 'status' && (
            <>
              <label>
                Green when
                <input value={row.ok ?? ''} placeholder="LIVE, OPEN" onChange={(e) => patch(i, { ok: e.target.value })} />
              </label>
              <label>
                Amber when
                <input value={row.warn ?? ''} placeholder="STARTING" onChange={(e) => patch(i, { warn: e.target.value })} />
              </label>
              <label>
                Red when
                <input value={row.bad ?? ''} placeholder="OFF, ERROR" onChange={(e) => patch(i, { bad: e.target.value })} />
                <small>Comma-separated values, matched exactly (case is ignored). A value in no list shows a grey bullet.</small>
              </label>
            </>
          )}

          {row.display === 'bar' && (
            <>
              <label>
                Bar minimum
                <input type="number" value={row.min ?? ''} placeholder="0" onChange={(e) => patch(i, { min: e.target.value === '' ? undefined : Number(e.target.value) })} />
              </label>
              <label>
                Bar maximum
                <input type="number" value={row.max ?? ''} placeholder="100" onChange={(e) => patch(i, { max: e.target.value === '' ? undefined : Number(e.target.value) })} />
                <small>The bar is drawn only when the value is a number; anything else stays as text.</small>
              </label>
            </>
          )}
        </fieldset>
      ))}

      {/* Eight is the server's cap, and about what a tall cell shows before the
          type is too small to read from across a room. */}
      {rows.length < 8 ? (
        <button type="button" className="cvarsettings__add" onClick={() => onChange([...rows, { variable: '', display: 'text' }])}>
          Add a variable
        </button>
      ) : (
        <small>Eight variables per widget. Add a second Companion widget for more.</small>
      )}
    </>
  );
}
