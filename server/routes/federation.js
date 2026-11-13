// Admin → Linked servers: federation configuration, pairing, and peers
// (ADR 0017), and the other servers' campuses for the dashboard (ADR 0018).
//
// On the DASHBOARD port, for administrators. The other campus never calls
// these: it talks to federation/link.js on the federation port, and these
// routes are how an admin here tells link.js what to do.

import express from 'express';

import * as auth from '../authStore.js';
import * as store from '../federation/store.js';
import * as link from '../federation/link.js';
import { remoteServers } from '../federation/directory.js';
import { getIdentity } from '../identity.js';
import { requirePermission, auditSuccess } from '../httpAuth.js';

const router = express.Router();

// Full administrators only. Pairing creates a standing trust relationship with
// another building's server, which is at least as consequential as minting a
// service token. users.manage first, so a refusal names a permission the UI
// can show, then narrowed to '*' like the token routes.
const adminOnly = [requirePermission('users.manage'), (req, res, next) => (
  auth.hasPermission(req.auth, '*') ? next() : res.status(403).json({ error: 'admin_required' })
)];

const overview = () => {
  const me = getIdentity();
  return {
    config: store.describe(),
    listener: link.listenerStatus(),
    identity: { systemId: me.systemId, name: me.name, tlsFingerprint: me.tlsFingerprint },
    peers: store.listPeers(),
    tokens: store.listJoinTokens(),
  };
};

const fail = (res, err, status = 400) => res.status(status).json({ error: String(err.message ?? err) });

// The other servers' campuses and rooms, for Home and the campus picker.
// Not admin-only: anyone who can see this dashboard sees the campuses it is
// paired with (ADR 0018) — pairing is the decision to share that. It carries
// names and a dashboard address, never a federation address or fingerprint.
router.get('/api/federation/campuses', (_req, res) => res.json(remoteServers()));

router.get('/api/federation', ...adminOnly, (_req, res) => res.json(overview()));

router.put('/api/federation', ...adminOnly, async (req, res) => {
  try {
    store.setConfig(req.body ?? {});
  } catch (err) {
    return fail(res, err);
  }
  await link.applyConfig();
  auditSuccess(req, 'federation.configure', { details: store.getConfig() });
  res.json(overview());
});

router.post('/api/federation/tokens', ...adminOnly, (req, res) => {
  // A token whose address nothing is listening on would fail at the other
  // site with "connection refused", which points at the wrong building.
  if (!link.listenerStatus().listening) {
    return res.status(409).json({ error: 'Switch federation on first, so the other server can reach this one' });
  }
  const minted = store.mintJoinToken({ createdBy: req.auth?.user?.id ?? null });
  auditSuccess(req, 'federation.pair', { resourceType: 'join-token', resourceId: minted.id, details: { stage: 'token-issued' } });
  res.status(201).json(minted);
});

router.delete('/api/federation/tokens/:tokenId', ...adminOnly, (req, res) => {
  if (!store.cancelJoinToken(req.params.tokenId)) return res.status(404).json({ error: 'No such outstanding token' });
  auditSuccess(req, 'federation.pair', { resourceType: 'join-token', resourceId: req.params.tokenId, details: { stage: 'token-cancelled' } });
  res.json(overview());
});

router.post('/api/federation/redeem', ...adminOnly, async (req, res) => {
  try {
    const peer = await link.redeem(req.body?.token);
    auditSuccess(req, 'federation.pair', { resourceType: 'peer', resourceId: peer.systemId, details: { stage: 'redeemed', name: peer.name } });
    res.status(201).json({ peer, ...overview() });
  } catch (err) {
    fail(res, err);
  }
});

router.post('/api/federation/peers/:systemId/accept', ...adminOnly, async (req, res) => {
  try {
    const peer = await link.accept(req.params.systemId, req.auth?.user?.id ?? null);
    auditSuccess(req, 'federation.pair', { resourceType: 'peer', resourceId: peer.systemId, details: { stage: 'accepted', name: peer.name } });
    res.json({ peer, ...overview() });
  } catch (err) {
    fail(res, err, 409);
  }
});

router.post('/api/federation/peers/:systemId/probe', ...adminOnly, async (req, res) => {
  const peer = await link.probe(req.params.systemId);
  if (!peer) return res.status(404).json({ error: 'Unknown server' });
  res.json({ peer, ...overview() });
});

router.put('/api/federation/peers/:systemId', ...adminOnly, (req, res) => {
  if (!store.getPeer(req.params.systemId)) return res.status(404).json({ error: 'Unknown server' });
  try {
    const peer = store.setPeerAddress(req.params.systemId, req.body?.address);
    auditSuccess(req, 'federation.configure', { resourceType: 'peer', resourceId: peer.systemId, details: { address: peer.address } });
    res.json({ peer, ...overview() });
  } catch (err) {
    fail(res, err);
  }
});

router.delete('/api/federation/peers/:systemId', ...adminOnly, async (req, res) => {
  try {
    const peer = await link.remove(req.params.systemId);
    auditSuccess(req, 'federation.unpair', { resourceType: 'peer', resourceId: peer.systemId, details: { by: 'us', name: peer.name } });
    res.json(overview());
  } catch (err) {
    fail(res, err, 404);
  }
});

export default router;
