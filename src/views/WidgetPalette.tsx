import { ChevronDown, Plus } from 'lucide-react';
import { useState } from 'react';
import { widgetRegistry, widgetTypes } from '../widgets/registry';
import { NEW_WIDGET_SIZE, widgetAllowedOn, widgetIsUnique, type WidgetType } from '../widgets/types';
import { IntegrationBrand, integrationInfo, type IntegrationId } from '../components/IntegrationBrand';
import { findFirstFit, type Grid, type ViewKind } from '../lib/gridLayout';
import type { CaptionsConfig, ViewPlacement } from '../api';
import type { AnalysisSource } from '../api';
import { analysisIntegration, analysisWidgetTitle } from '../lib/analysisSource';
import { captionIntegration, captionWidgetTitle } from '../lib/captionSource';

// What can go on this view, and whether there is anywhere to put it.
//
// Every entry has an Add button as well as being a drag source. That is not a
// fallback — it is the fastest path with a mouse, the only path from a
// keyboard, and the reason the whole editor is testable in jsdom before a
// single pointer event exists.

export interface PaletteEntry {
  type: WidgetType;
  title: string;
  description: string;
  size: { w: number; h: number };
  integration: IntegrationId;
  /** Why it can't be added right now, or null if it can. */
  blocked: string | null;
}

export function paletteFor(kind: ViewKind, grid: Grid, placements: ViewPlacement[], analysisSource?: AnalysisSource | null, captionSource?: CaptionsConfig['source'] | null, enabled?: Record<string, boolean>): PaletteEntry[] {
  const entries = widgetTypes
    .filter((type) => widgetAllowedOn(widgetRegistry[type], kind))
    .map((type) => {
      const def = widgetRegistry[type];
      const placed = placements.some((p) => p.type === type);
      const analysisTitle = analysisWidgetTitle(type, analysisSource);
      const captionTitle = type === 'captions' ? captionWidgetTitle(captionSource) : null;
      return {
        type,
        title: analysisTitle ?? captionTitle ?? def.title,
        description: def.description,
        size: NEW_WIDGET_SIZE,
        integration: analysisTitle ? analysisIntegration(analysisSource) : captionTitle ? captionIntegration(captionSource) : def.integration ?? 'prodmesh',
        blocked:
          ['loudness', 'loudness-trend'].includes(type) && !analysisSource
            ? 'Choose an Audio Analysis source in Campus settings first'
            : widgetIsUnique(def) && placed
            ? 'Already on this view'
            : findFirstFit(grid, placements, NEW_WIDGET_SIZE)
              ? null
              : 'No room left',
      };
    });

  // Disabling an integration keeps existing layouts intact, but removes its
  // widgets from the picker until an administrator enables it again.
  return entries.filter((entry) => enabled?.[entry.integration] !== false);
}

export function WidgetPalette({
  entries,
  onAdd,
  dragHandlers,
}: {
  entries: PaletteEntry[];
  onAdd: (type: WidgetType) => void;
  dragHandlers: (type: string, size: { w: number; h: number }) => Record<string, unknown>;
}) {
  // The integration headers are genuine dropdowns. Start collapsed so a long
  // widget catalogue stays scannable and users deliberately open the source
  // they want to add from.
  const [openGroup, setOpenGroup] = useState<IntegrationId | null>(null);
  const groups = entries.reduce((all, entry) => {
    (all.get(entry.integration) ?? all.set(entry.integration, []).get(entry.integration)!).push(entry);
    return all;
  }, new Map<IntegrationId, PaletteEntry[]>());

  return (
    <aside className="palette">
      <h2 className="palette__title">Widgets</h2>
      {[...groups.entries()].map(([integration, group]) => {
        const open = openGroup === integration;
        const name = integrationInfo[integration].name;
        return (
        <section className={`palette__group${open ? ' palette__group--open' : ''}`} key={integration} aria-label={`${name} widgets`}>
          <button
            type="button"
            className="palette__group-title"
            aria-label={`${name} widgets`}
            aria-expanded={open}
            aria-controls={`palette-${integration}`}
            onClick={() => setOpenGroup((current) => current === integration ? null : integration)}
          >
            <IntegrationBrand integration={integration} label />
            <span className="palette__group-count">{group.length}</span>
            <ChevronDown className="palette__group-chevron" size={16} aria-hidden />
          </button>
          <ul className="palette__list" id={`palette-${integration}`} hidden={!open}>
            {group.map((entry) => (
              <li
                key={entry.type}
                className={`palette__item${entry.blocked ? ' palette__item--off' : ''}`}
                {...(entry.blocked ? {} : dragHandlers(entry.type, entry.size))}
              >
                <div className="palette__text">
                  <strong>{entry.title}</strong>
                  <small>{entry.blocked ?? entry.description}</small>
                </div>
                <button
                  type="button"
                  className="iconbtn"
                  disabled={Boolean(entry.blocked)}
                  aria-label={`Add ${entry.title}`}
                  title={entry.blocked ?? `Add ${entry.title}`}
                  onClick={() => onAdd(entry.type)}
                >
                  <Plus size={15} />
                </button>
              </li>
            ))}
          </ul>
        </section>
        );
      })}
    </aside>
  );
}
