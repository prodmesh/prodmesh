// Product versions integrations have reported, for telemetry (ADR 0022 §4).
//
// A leaf module with no imports, so an integration client can record into it
// without importing the collector, and through it half the server.
//
// Only digits and dots are kept, pulled out of whatever text the device sent:
// ProPresenter's /version puts the booth Mac's own name right beside it.

// The integration names a report may carry: the part of a health.js key before
// '@'. An allowlist, not a pattern, because keys are not all `<name>@<host>`:
// a linked server is `peer:<its system id>`, and a new integration that keys
// itself by something identifying must not reach a report by default.
export const INTEGRATIONS = new Set([
  'proPresenter', 'companion', 'planningCenter', 'pcCalendar', 'slack', 'youtube',
  'restream', 'resi', 'captions', 'analysis', 'obs', 'prodcom',
]);

const versions = new Map(); // integration name → "21.1"

export function noteProductVersion(integration, text) {
  const v = /(\d+(?:\.\d+){0,3})/.exec(String(text ?? ''))?.[1];
  if (v && INTEGRATIONS.has(integration)) versions.set(integration, v);
}

export const productVersion = (integration) => versions.get(integration) ?? null;

/** Tests only. */
export const _clear = () => versions.clear();
