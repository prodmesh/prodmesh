import type { ReactNode } from 'react';
import { PackageOpen } from 'lucide-react';
import { widgetRegistry, isWidgetType } from '../widgets/registry';
import type { WidgetConfig, WidgetType } from '../widgets/types';
import { IntegrationBeta, IntegrationBrand } from '../components/IntegrationBrand';
import { getRoom, getRoomConnectivity, type ViewPlacement } from '../api';
import { useQuery } from '../lib/useQuery';
import { analysisIntegration, analysisWidgetTitle } from '../lib/analysisSource';
import { captionIntegration, captionWidgetTitle } from '../lib/captionSource';

// One cell of a View's grid.
//
// The cell is positioned here and the widget inside it knows nothing about
// where it is — which is the property that lets the same component render on
// Run of Show, on a dashboard and on a 3×3 display with no prop for it.

/**
 * A placement naming a widget this build doesn't have.
 *
 * It holds the slot rather than disappearing. Dropping it would REFLOW the
 * grid — every other widget shuffles up into the gap, rearranging a layout
 * somebody arranged by hand, on a screen they are probably looking at during a
 * service. A grey card is a much smaller lie. (Same reason the server returns
 * an unknown type verbatim on read while refusing to store one.)
 */
function UnknownWidget({ type }: { type: string }) {
  return (
    <div className="viewcell__unknown">
      <PackageOpen size={18} aria-hidden />
      <p>
        <strong>{type}</strong>
        <small>Not available in this version</small>
      </p>
    </div>
  );
}

export function PlacedWidget({
  roomId,
  placement,
  config,
  chrome,
  className = '',
}: {
  /** Views are room-scoped, so every placement takes the view's room. */
  roomId: string;
  placement: ViewPlacement;
  /** The view's context, merged over the placement's own. */
  config: WidgetConfig;
  /** Editor furniture — a drag handle, a remove button. Absent when live. */
  chrome?: ReactNode;
  className?: string;
}) {
  const def = isWidgetType(placement.type) ? widgetRegistry[placement.type] : null;
  const Component = def?.component;
  const room = useQuery(`room:${roomId}`, () => getRoom(roomId), { staleMs: 60_000 }).data;
  const connectivity = useQuery(`room-connectivity:${roomId}`, () => getRoomConnectivity(roomId), { staleMs: 15_000 }).data;
  const source = room?.analysisSource;
  const captionSource = connectivity?.captions?.source;
  const title = def ? analysisWidgetTitle(placement.type as WidgetType, source) ?? (placement.type === 'captions' ? captionWidgetTitle(captionSource) : null) ?? def.title : placement.type;
  const integration = def && (placement.type === 'loudness' || placement.type === 'loudness-trend')
    ? analysisIntegration(source)
    : placement.type === 'captions' ? captionIntegration(captionSource)
      : def?.integration ?? 'prodmesh';
  // Hiding the header only ever applies to a LIVE cell. In the editor the
  // chrome takes the header's place, so a headerless widget still has its grab
  // strip, its remove button and the click target that opens its settings —
  // which is what stops this option from being a way to lose a widget.
  // RTA carries its own analyzer-style source header (including the product
  // mark and live state). A generic canvas strip above it is redundant.
  const bare = (Boolean(config.hideHeader) || placement.type === 'rta') && !chrome;

  return (
    <div
      className={`viewcell${def ? '' : ' viewcell--unknown'}${chrome ? ' viewcell--editing' : ''}${bare ? ' viewcell--bare' : ''}${className ? ` ${className}` : ''}`}
      style={{
        gridColumn: `${placement.x + 1} / span ${placement.w}`,
        gridRow: `${placement.y + 1} / span ${placement.h}`,
      }}
      data-widget={placement.type}
    >
      {chrome}
      {!chrome && def && !bare && (
        <header className="viewcell__widget-head">
          <IntegrationBrand integration={integration} />
          <span>{title}</span><IntegrationBeta integration={integration} />
        </header>
      )}
      {/* A widget with nothing to say renders null — LoudnessWidget with no
          SPL, ViewersWidget off-air. In a flow grid that card simply vanishes;
          on a fixed canvas its cell stays, and a blank rectangle reads as a
          fault. `data-title` + `:empty` in CSS labels it instead, with no way
          for the widget to have to know it is on a canvas. */}
      <div
        className="viewcell__body"
        data-title={title}
      >
        {Component ? (
          <Component roomId={roomId} config={config} />
        ) : (
          <UnknownWidget type={placement.type} />
        )}
      </div>
    </div>
  );
}
