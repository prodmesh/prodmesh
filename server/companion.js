// Thin client for the Bitfocus Companion HTTP API (v4.x).
//
//   Read a custom variable:  GET  /api/custom-variable/<name>/value
//   Press a button:          POST /api/location/<page>/<row>/<column>/press
//
// Companion sends no CORS headers, which is exactly why this runs server-side.

import { report } from './health.js';

const TIMEOUT_MS = 2500;

function baseUrl(companion) {
  return `http://${companion.host}:${companion.port ?? 8000}`;
}

// Health is keyed by the machine we actually talked to (mock rooms never
// reach this module, so they never report).
export const healthKey = (companion) => `companion@${companion.host}:${companion.port ?? 8000}`;

/** Read a Companion custom variable; returns the raw string value. */
export async function readCustomVariable(companion, name) {
  const url = `${baseUrl(companion)}/api/custom-variable/${encodeURIComponent(name)}/value`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    // A missing variable is a 404 "Not found": the machine answered, so it is
    // NOT evidence Companion is down (INTEGRATION-NOTES). A church that uses
    // Companion for widgets and buttons but never made $(roomState) saw
    // "Companion offline" while every other feature worked (PR #53). Health
    // stays green; the caller learns the variable is missing, by code.
    if (res.status === 404) {
      report(healthKey(companion), true);
      throw Object.assign(new Error(`Companion has no custom variable $(${name})`), { code: 'variable_missing' });
    }
    if (!res.ok) throw new Error(`Companion GET ${name} → HTTP ${res.status}`);
    const value = (await res.text()).trim();
    report(healthKey(companion), true);
    return value;
  } catch (err) {
    if (err.code !== 'variable_missing') report(healthKey(companion), false, String(err.message ?? err));
    throw err;
  }
}

/**
 * Probe: read the configured state variable (the request the dashboard
 * actually depends on), else just reach the web UI. Returns a human detail
 * line; throws with the failure reason.
 */
export async function ping(companion) {
  if (companion.variable) {
    let value;
    try {
      value = await readCustomVariable(companion, companion.variable);
    } catch (err) {
      // Reachable, just without the room-mode variable: the probe passes and
      // says what is missing, rather than failing a working Companion.
      if (err.code === 'variable_missing') return `reachable, but $(${companion.variable}) is not defined`;
      throw err;
    }
    // Report the SHAPE of the answer, not the bytes. This string is surfaced
    // to the operator through the connectivity status chip, so echoing the
    // response verbatim turned a mistyped (or malicious) host into a readable
    // fetch of whatever it pointed at. Host validation blocks the URL games
    // now; not echoing bodies means it stays closed if that ever regresses.
    const summary = value === ''
      ? 'empty'
      : `${JSON.stringify(value.slice(0, 24))}${value.length > 24 ? '…' : ''}`;
    return `$(${companion.variable}) = ${summary}`;
  }
  try {
    const res = await fetch(baseUrl(companion), { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Companion → HTTP ${res.status}`);
    report(healthKey(companion), true);
    return 'reachable (no state variable configured)';
  } catch (err) {
    report(healthKey(companion), false, String(err.message ?? err));
    throw err;
  }
}

/** Press a Companion button at a page/row/column location. */
export async function pressButton(companion, location) {
  const { page, row, column } = location;
  const url = `${baseUrl(companion)}/api/location/${page}/${row}/${column}/press`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Companion press ${page}/${row}/${column} → HTTP ${res.status}`);
    report(healthKey(companion), true);
  } catch (err) {
    report(healthKey(companion), false, String(err.message ?? err));
    throw err;
  }
}

/**
 * Read any Companion variable, module or custom, as `$(label:name)` names it.
 *
 * Companion answers both from one path — `/api/variable/<label>/<name>/value`
 * serves `custom` as well, verified live 2026-09-01 — but custom variables
 * keep the dedicated endpoint above, because that is the path the room-mode
 * read has always used and is therefore the one proven against every
 * Companion in the buildings. One verified path per question, not one clever
 * path for both.
 *
 * Throws on failure with `err.status` set to the HTTP status when there was
 * one. That distinction is the whole point for a caller rendering the value:
 * a 404 is a variable that does not exist (a typo in a widget's config, and
 * Companion is fine), while a network failure is Companion being unreachable
 * (the variable is probably fine, and the wall display should say so).
 */
export async function readVariable(companion, label, name) {
  const url = label === 'custom'
    ? `${baseUrl(companion)}/api/custom-variable/${encodeURIComponent(name)}/value`
    : `${baseUrl(companion)}/api/variable/${encodeURIComponent(label)}/${encodeURIComponent(name)}/value`;
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    report(healthKey(companion), false, String(err.message ?? err));
    throw err;
  }
  // An HTTP answer of ANY status means the box is up and talking, so health is
  // green even on a 404. Reporting a missing variable as "Companion down"
  // would put a red dot on the room for a mistyped widget config.
  report(healthKey(companion), true);
  if (!res.ok) {
    const err = new Error(`Companion GET ${label}:${name} → HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return (await res.text()).trim();
}
