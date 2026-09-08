// Admin configuration: settings/PINs/schedules, institution config (ADR 0009),
// and per-room connectivity.

import express from 'express';

import { rooms, rebuildRooms } from '../roomsStore.js';
import * as settings from '../settings.js';
import * as show from '../showManager.js';
import * as auth from '../authStore.js';
import * as appConfig from '../appConfig.js';
import * as connectivity from '../connectivity.js';
import * as branding from '../branding.js';
import * as secrets from '../secrets.js';
import * as setup from '../setup.js';
import * as pco from '../integrations/planningCenter.js';
import * as restream from '../integrations/restream.js';
import * as resi from '../integrations/resi.js';
import * as analysis from '../integrations/analysis.js';
import { roomStatus } from '../connectivityStatus.js';
import { listCompanionEmulators } from '../companionEmulators.js';
import { requirePermission, permissionRequired, auditSuccess } from '../httpAuth.js';

const router = express.Router();
const restreamStates = new Map();
const restreamCallback = (req) => `${req.protocol}://${req.get('host')}/api/integrations/restream/callback`;

const RESTREAM_STATE_TTL_MS = 10 * 60_000;

function beginRestreamConnection(req, res) {
  try {
    const state = crypto.randomUUID();
    // An abandoned connect attempt never reaches the callback that would
    // delete its nonce, so sweep on the way in: the callback already refuses
    // anything older than the TTL, and nothing should outlive that check.
    const cutoff = Date.now() - RESTREAM_STATE_TTL_MS;
    for (const [key, issued] of restreamStates) if (issued < cutoff) restreamStates.delete(key);
    restreamStates.set(state, Date.now());
    res.json({ url: restream.authorizeUrl(restreamCallback(req), state) });
  }
  catch (err) { res.status(400).json({ error: String(err.message ?? err) }); }
}
// This is POST rather than a normal link because admin authentication is held
// in a bearer token. The browser fetches this URL, then navigates to Restream.
router.post('/api/integrations/restream/connect', requirePermission('*'), beginRestreamConnection);
// The browser can be served through a development proxy, so return the URL
// from the same request path that starts OAuth. This guarantees the address
// shown in Settings is byte-for-byte the redirect_uri sent to Restream.
router.get('/api/integrations/restream/config', requirePermission('*'), (req, res) => {
  res.json({ redirectUrl: restreamCallback(req) });
});
router.get('/api/integrations/restream/callback', async (req, res) => {
  const state = String(req.query.state ?? ''); const issued = restreamStates.get(state); restreamStates.delete(state);
  if (!issued || Date.now() - issued > RESTREAM_STATE_TTL_MS || !req.query.code) return res.status(400).send('Invalid or expired Restream authorization. Please connect again from ProdMesh Settings.');
  try { await restream.exchangeCode(String(req.query.code), restreamCallback(req)); res.redirect('/settings?restream=connected'); }
  catch (err) { res.status(502).send(`Restream authorization failed: ${String(err.message ?? err)}`); }
});
// Also a maintenance route now — see the Resi note above.
router.get('/api/integrations/restream/status', requirePermission('config.manage'), async (_req, res) => {
  try { res.json(await restream.status()); }
  catch (err) { res.status(502).json({ connected: false, status: 'offline', error: String(err.message ?? err) }); }
});

// ── First-run setup ───────────────────────────────────────────────────────────

// Public, like /api/auth/status and /api/config: the browser has to know
// whether to render the wizard before anyone can possibly be signed in, and
// every fact here is already readable from those two endpoints.
router.get('/api/setup', (_req, res) => {
  res.json(setup.getState());
});

// Finishing is an admin action — by this point the wizard has set the PIN and
// signed in, so there is no bootstrap exception to make. '*' rather than
// config.manage: dismissing setup is a one-way door for the whole install.
router.post('/api/setup/complete', requirePermission('*'), (req, res) => {
  const state = setup.complete();
  auditSuccess(req, '*', { resourceType: 'setup', resourceId: 'wizard', details: { completedAt: state.completedAt } });
  res.json(state);
});

// ── Secrets (write-only) ──────────────────────────────────────────────────────
//
//  Nothing here ever returns a stored value. A stolen admin session can
//  overwrite the church's Planning Center token or Slack bot token — loudly,
//  and things visibly break — but cannot learn them. Reading them back means
//  opening the file on the server, which already implies owning the box.
//  Requires '*' rather than settings.manage: these are the credentials to
//  other systems, not an operational setting.

router.get('/api/secrets', requirePermission('*'), (_req, res) => {
  res.json({ secrets: secrets.describeSecrets() }); // set/length/env only
});

router.put('/api/secrets', requirePermission('*'), (req, res) => {
  try {
    const touched = secrets.setSecrets(req.body?.updates ?? {});
    pco.clearCache(); // new credentials must not serve cached results
    if (touched.some((path) => path.startsWith('resi.'))) resi.clearCache();
    auditSuccess(req, '*', {
      resourceType: 'secrets', resourceId: 'secrets',
      details: { paths: touched }, // WHICH keys changed, never their values
    });
    res.json({ ok: true, secrets: secrets.describeSecrets() });
  } catch (err) {
    res.status(400).json({ error: String(err.message ?? err) });
  }
});

// Do the stored credentials actually work? Saving a typo'd token otherwise
// looks like success and surfaces as a dead integration on Sunday. Returns
// booleans only — never anything derived from the secret itself.
router.get('/api/secrets/check', requirePermission('*'), async (_req, res) => {
  if (!pco.isConfigured()) return res.json({ planningCenter: null });
  try {
    pco.clearCache();
    await pco.checkCredentials();
    res.json({ planningCenter: true });
  } catch (err) {
    // This is safe to disclose: it contains only the endpoint and HTTP status,
    // never either side of the Basic-auth credential pair.
    res.json({ planningCenter: false, reason: String(err.message ?? err) });
  }
});

// Widgets read Resi over the `integration:resi` topic now, so this is a
// maintenance route. Gated for the same reason as the ProPresenter console
// read: it calls a third-party API on the church's own token, and nothing
// unauthenticated should be able to drive that.
router.get('/api/integrations/resi/status', requirePermission('config.manage'), async (_req, res) => {
  res.json(await resi.status());
});
router.post('/api/integrations/resi/check', requirePermission('*'), async (_req, res) => {
  const state = await resi.status({ force: true });
  res.status(state.connected ? 200 : 502).json(state);
});

// ── Branding (institution logo) ───────────────────────────────────────────────

// The Content-Type is the type SNIFFED at upload, never anything the uploader
// claimed, and nosniff stops the browser second-guessing it.
function sendLogo(res, logo, asIco = false) {
  const ico = asIco && logo.type === 'image/png' ? branding.pngAsIco(logo.buffer) : null;
  res.set({
    'Content-Type': ico ? 'image/x-icon' : logo.type,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    'Cache-Control': 'no-cache',
    ETag: `"${logo.updatedAt}"`,
  });
  res.end(ico ?? logo.buffer);
}

// Public read: every page renders it, including anonymous booth screens.
// 404 means "no override" and the client falls back to the bundled default.
router.get('/api/branding/logo', (_req, res) => {
  const logo = branding.readLogo();
  if (!logo) return res.status(404).end();
  sendLogo(res, logo);
});

// Safari (and some kiosk browsers) request /favicon.ico before they honour an
// HTML <link rel="icon">. Serve the church override at that canonical URL too,
// so its tab badge is the same logo on the very first page load.
router.get('/favicon.ico', (_req, res, next) => {
  const logo = branding.readLogo();
  if (!logo) return next();
  sendLogo(res, logo, true);
});
router.get('/favicon.png', (_req, res, next) => {
  const logo = branding.readLogo();
  if (!logo) return next();
  sendLogo(res, logo);
});

// Raw body, capped, no multipart parser: this is one file, and every parser is
// more attack surface than `PUT the bytes` deserves. express.json() is already
// mounted, so this route takes the stream itself.
router.put('/api/branding/logo', requirePermission('config.manage'), (req, res) => {
  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on('data', (chunk) => {
    if (aborted) return;
    size += chunk.length;
    // Abort mid-upload rather than buffering the whole thing and then
    // complaining about its size.
    if (size > branding.MAX_LOGO_BYTES) {
      aborted = true;
      res.status(413).json({ error: `Logo must be under ${Math.floor(branding.MAX_LOGO_BYTES / 1024)} KB` });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (aborted) return;
    try {
      const meta = branding.setLogo(Buffer.concat(chunks));
      auditSuccess(req, 'config.manage', { resourceType: 'branding', resourceId: 'logo', details: { bytes: meta.bytes } });
      res.json({ ok: true, ...meta });
    } catch (err) {
      res.status(err.code === 'too_large' ? 413 : 400).json({ error: String(err.message ?? err) });
    }
  });
});

router.delete('/api/branding/logo', requirePermission('config.manage'), (req, res) => {
  branding.clearLogo();
  auditSuccess(req, 'config.manage', { resourceType: 'branding', resourceId: 'logo', details: { operation: 'clear' } });
  res.json({ ok: true });
});

// ── Settings ───────────────────────────────────────────────────────────────────

router.get('/api/settings', requirePermission('settings.manage'), (_req, res) => {
  res.json(settings.getPublicSettings());
});

// Update PINs. Bootstrap exception: if no admin PIN exists yet, the first
// admin-PIN set is allowed without a token (first-run setup).
router.post('/api/settings/pins', (req, res) => {
  const bootstrapping = settings.isAdminSetupNeeded() && req.body?.admin;
  if (!bootstrapping) {
    // Changing the ADMIN PIN is a superuser action, not an operational one:
    // the PIN it sets mints a token that bypasses every permission check, so
    // settings.manage — labelled "Edit operational settings and schedules" —
    // was silently a path to full control. Reproduced: a settings.manage user
    // overwrote the admin PIN, logged in with it, and created users.
    // The OVERRIDE PIN stays under settings.manage; it only unlocks a room
    // mode change for someone already standing at the booth.
    const wantsAdminPin = req.body?.admin !== undefined;
    const permission = wantsAdminPin ? '*' : 'settings.manage';
    if (!auth.hasPermission(req.auth, permission)) {
      return res.status(req.auth ? 403 : 401).json(permissionRequired(permission));
    }
  }
  try {
    // During bootstrap, set ONLY the field the exception justifies. It used to
    // pass `override` through as well, so an anonymous first-run caller took
    // the room-mode override PIN along with admin in the same request.
    settings.setPins(bootstrapping
      ? { admin: req.body.admin }
      : { admin: req.body?.admin, override: req.body?.override });
  } catch (err) {
    if (err.code === 'weak_pin') return res.status(400).json({ error: String(err.message) });
    throw err;
  }
  if (bootstrapping) {
    auth.audit({ action: 'settings.bootstrap', result: 'allowed', details: { ip: req.ip ?? null } });
  }
  res.json({ ok: true, ...settings.getPublicSettings().pins });
});

router.put('/api/settings/schedules', requirePermission('settings.manage'), (req, res) => {
  try {
    settings.setSchedules(req.body?.schedules);
  } catch (err) {
    return res.status(400).json({ error: String(err.message ?? err) });
  }
  res.json({ ok: true, schedules: settings.getPublicSettings().schedules });
});

// Public read: dashboard/display renderers need this to omit widgets for an
// integration the administrator intentionally disabled. It contains no
// credentials or connection data.
router.get('/api/integrations', (_req, res) => {
  res.json({ enabled: settings.getIntegrationSettings() });
});
router.put('/api/settings/integrations/:id', requirePermission('settings.manage'), (req, res) => {
  try {
    const enabled = settings.setIntegrationEnabled(req.params.id, req.body?.enabled);
    auditSuccess(req, 'settings.manage', { resourceType: 'integration', resourceId: req.params.id, details: { enabled: enabled[req.params.id] } });
    res.json({ enabled });
  } catch (err) {
    res.status(400).json({ error: String(err.message ?? err) });
  }
});

// ── Institution config (name, sites, Quick Access tiles — ADR 0009) ───────────

// Public read: the shell needs it before anyone signs in (like /api/rooms).
router.get('/api/config', (_req, res) => {
  res.json(appConfig.getChurch());
});

// Whole-tree save from Admin → Campuses (transactional replace).
router.put('/api/config', requirePermission('config.manage'), (req, res) => {
  try {
    const stored = appConfig.replaceChurch(req.body);
    // Topology edits become real server rooms immediately: rebuild the live
    // map, re-apply stored connectivity onto the (possibly new) room objects,
    // and reconcile per-room watchers/shows with the result.
    rebuildRooms();
    connectivity.applyConnectivity();
    show.syncAutomation();
    auditSuccess(req, 'config.manage', {
      resourceType: 'topology',
      details: {
        sites: stored.sites.length,
        tiles: stored.sites.flatMap((s) => s.auditoriums).flatMap((a) => a.tiles).length,
      },
    });
    res.json(stored);
  } catch (err) {
    res.status(400).json({ error: String(err.message ?? err) });
  }
});

// ── Room connectivity (room configuration page) ───────────────────────────────

// What integrations this room has. hasServerRoom=false means the topology
// knows the room but the server integration map (rooms.config.js) doesn't.
// The Smaart password never leaves the server: reads carry hasPassword only,
// and writes without a `password` field keep the stored one.
function redactAnalysis(cfg) {
  if (!cfg) return null;
  const { password, ...rest } = cfg;
  return { ...rest, hasPassword: Boolean(password) };
}

// Same bargain for ProdCom's pre-shared key: it is the credential to a private
// comms transcript, so it goes in and never comes back out.
function redactCaptions(cfg) {
  if (!cfg) return null;
  const { key, ...rest } = cfg;
  return { ...rest, hasKey: Boolean(key) };
}
function redactObs(cfg) {
  if (!cfg) return null;
  const { password, ...rest } = cfg;
  return { ...rest, hasPassword: Boolean(password) };
}

// Behind config.manage: this is the room-configuration editor's own read, and
// it returns the production network map — ProPresenter/Companion/analysis
// host:port plus the Companion button coordinates that roomModel.js
// deliberately withholds from the public /api/rooms. Anonymous callers were
// getting a pre-built inventory of every device on the church's VLAN.
router.get('/api/config/rooms/:roomId/connectivity', requirePermission('config.manage'), (req, res) => {
  if (!rooms[req.params.roomId]) {
    return res.json({
      hasServerRoom: false, planningCenter: null, analysis: null, proPresenter: null,
      companion: null, youtube: null, obs: null,
    });
  }
  res.json({
    hasServerRoom: true,
    planningCenter: connectivity.getPlanningCenter(req.params.roomId) ?? { serviceTypes: [] },
    analysis: redactAnalysis(connectivity.getAnalysis(req.params.roomId)),
    captions: redactCaptions(connectivity.getCaptions(req.params.roomId)),
    proPresenter: connectivity.getProPresenter(req.params.roomId),
    youtube: connectivity.getYouTube(req.params.roomId),
    obs: redactObs(connectivity.getObs(req.params.roomId)),
    // A room with no stored row yet (created in Admin → Campuses) shows its
    // live defaults so the editor opens pre-filled rather than unsavable.
    companion:
      connectivity.getCompanion(req.params.roomId) ??
      connectivity.companionFromRoom(rooms[req.params.roomId]),
  });
});

// Live per-integration status (the chips next to each editor). Probes the
// room's devices on demand — behind config.manage since it generates real
// outbound requests.
router.get('/api/config/rooms/:roomId/connectivity/status', requirePermission('config.manage'), async (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: 'unknown room' });
  res.json(await roomStatus(room));
});

router.get('/api/config/rooms/:roomId/connectivity/companion/emulators', requirePermission('config.manage'), async (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: 'unknown room' });
  const cfg = connectivity.getCompanion(room.id) ?? connectivity.companionFromRoom(room);
  try {
    res.json({ emulators: await listCompanionEmulators(cfg) });
  } catch (err) {
    res.status(502).json({ error: String(err.message ?? err) });
  }
});

// Tests the same data path the Loudness widgets consume. The draft is accepted
// without saving it, so an operator can verify an address/source before making
// it the room's production configuration.
router.post('/api/config/rooms/:roomId/connectivity/analysis/test', requirePermission('config.manage'), async (req, res) => {
  if (!rooms[req.params.roomId]) return res.status(404).json({ error: 'unknown room' });
  try {
    const cfg = connectivity.validateAnalysis(req.body?.analysis);
    if (!cfg) throw new Error('Choose an analysis source first');
    const result = await analysis.testConnection(cfg);
    res.json({ ok: true, detail: result.detail });
  } catch (err) {
    res.json({ ok: false, detail: String(err?.message ?? err) });
  }
});

router.put('/api/config/rooms/:roomId/connectivity/planning-center', requirePermission('config.manage'), (req, res) => {
  try {
    const stored = connectivity.setPlanningCenter(req.params.roomId, req.body?.serviceTypes);
    auditSuccess(req, 'config.manage', {
      resourceType: 'room-connectivity',
      resourceId: req.params.roomId,
      roomId: req.params.roomId,
      details: { integration: 'planningCenter', serviceTypes: stored.serviceTypes.length },
    });
    res.json({ planningCenter: stored });
  } catch (err) {
    res.status(rooms[req.params.roomId] ? 400 : 404).json({ error: String(err.message ?? err) });
  }
});

router.put('/api/config/rooms/:roomId/connectivity/youtube', requirePermission('config.manage'), (req, res) => {
  try {
    const clean = connectivity.setYouTube(req.params.roomId, req.body?.youtube ?? null);
    auditSuccess(req, 'config.manage', {
      resourceType: 'room-connectivity',
      resourceId: req.params.roomId,
      roomId: req.params.roomId,
      details: { integration: 'youtube', configured: Boolean(clean) },
    });
    res.json({ youtube: clean });
  } catch (err) {
    res.status(rooms[req.params.roomId] ? 400 : 404).json({ error: String(err.message ?? err) });
  }
});

router.put('/api/config/rooms/:roomId/connectivity/captions', requirePermission('config.manage'), (req, res) => {
  try {
    let input = req.body?.captions ?? null;
    // An omitted key means "leave it alone", not "clear it" — the editor never
    // receives the stored one, so it cannot send it back.
    if (input && input.key === undefined) {
      const stored = connectivity.getCaptions(req.params.roomId);
      if (stored?.key) input = { ...input, key: stored.key };
    }
    const clean = connectivity.setCaptions(req.params.roomId, input);
    auditSuccess(req, 'config.manage', {
      resourceType: 'room-connectivity',
      resourceId: req.params.roomId,
      roomId: req.params.roomId,
      details: { integration: 'captions', source: clean?.source ?? null },
    });
    res.json({ captions: redactCaptions(clean) });
  } catch (err) {
    res.status(400).json({ error: String(err.message ?? err) });
  }
});

router.put('/api/config/rooms/:roomId/connectivity/analysis', requirePermission('config.manage'), (req, res) => {
  try {
    let input = req.body?.analysis ?? null;
    if (input && input.password === undefined) {
      const stored = connectivity.getAnalysis(req.params.roomId);
      if (stored?.password) input = { ...input, password: stored.password };
    }
    const clean = connectivity.setAnalysis(req.params.roomId, input);
    auditSuccess(req, 'config.manage', {
      resourceType: 'room-connectivity',
      resourceId: req.params.roomId,
      roomId: req.params.roomId,
      details: { integration: 'analysis', source: clean?.source ?? null },
    });
    res.json({ analysis: redactAnalysis(clean) });
  } catch (err) {
    res.status(rooms[req.params.roomId] ? 400 : 404).json({ error: String(err.message ?? err) });
  }
});

router.put('/api/config/rooms/:roomId/connectivity/obs', requirePermission('config.manage'), (req, res) => {
  try {
    let input = req.body?.obs ?? null;
    if (input && input.password === undefined) {
      const stored = connectivity.getObs(req.params.roomId);
      if (stored?.password) input = { ...input, password: stored.password };
    }
    const clean = connectivity.setObs(req.params.roomId, input);
    auditSuccess(req, 'config.manage', {
      resourceType: 'room-connectivity', resourceId: req.params.roomId, roomId: req.params.roomId,
      details: { integration: 'obs', host: clean?.host ?? null },
    });
    res.json({ obs: redactObs(clean) });
  } catch (err) {
    res.status(rooms[req.params.roomId] ? 400 : 404).json({ error: String(err.message ?? err) });
  }
});

router.put('/api/config/rooms/:roomId/connectivity/companion', requirePermission('config.manage'), (req, res) => {
  try {
    const clean = connectivity.setCompanion(req.params.roomId, req.body?.companion);
    auditSuccess(req, 'config.manage', {
      resourceType: 'room-connectivity',
      resourceId: req.params.roomId,
      roomId: req.params.roomId,
      details: { integration: 'companion', mock: clean.mock, modes: clean.modes.length },
    });
    res.json({ companion: clean });
  } catch (err) {
    res.status(rooms[req.params.roomId] ? 400 : 404).json({ error: String(err.message ?? err) });
  }
});

router.put('/api/config/rooms/:roomId/connectivity/propresenter', requirePermission('config.manage'), (req, res) => {
  try {
    const clean = connectivity.setProPresenter(req.params.roomId, req.body?.proPresenter ?? null);
    auditSuccess(req, 'config.manage', {
      resourceType: 'room-connectivity',
      resourceId: req.params.roomId,
      roomId: req.params.roomId,
      details: { integration: 'proPresenter', host: clean?.host ?? null },
    });
    res.json({ proPresenter: clean });
  } catch (err) {
    res.status(rooms[req.params.roomId] ? 400 : 404).json({ error: String(err.message ?? err) });
  }
});

export default router;
