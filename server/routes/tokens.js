// Service tokens (ADR 0013): credentials for apps — a Companion button, a
// stream deck, a script — rather than for people.

import express from 'express';

import * as auth from '../authStore.js';
import { requirePermission, auditSuccess } from '../httpAuth.js';

const router = express.Router();

// Full administrators only, the same bar as resetting somebody's PIN, and for
// the same reason: a token is a standing credential that never expires and
// never sits at a keyboard. Gated as users.manage first so a refusal names a
// permission the UI can show, then narrowed to '*'.
function adminOnly(req, res, next) {
  if (auth.hasPermission(req.auth, '*')) return next();
  return res.status(403).json({ error: 'admin_required' });
}

router.get('/api/tokens', requirePermission('users.manage'), adminOnly, (_req, res) => {
  res.json({
    tokens: auth.listServiceTokens(),
    // The grantable set comes from the server so the dialog cannot offer a
    // permission the server would refuse.
    grantable: auth.TOKEN_PERMISSIONS.map((id) => {
      const [, label, description] = auth.PERMISSIONS.find(([p]) => p === id);
      return { id, label, description };
    }),
  });
});

router.post('/api/tokens', requirePermission('users.manage'), adminOnly, (req, res) => {
  try {
    const { token, serviceToken } = auth.createServiceToken({
      name: req.body?.name,
      permissions: req.body?.permissions,
      createdBy: req.auth?.user?.id ?? null,
    });
    auditSuccess(req, 'tokens.manage', {
      resourceType: 'service-token',
      resourceId: serviceToken.id,
      details: { operation: 'create', name: serviceToken.name, permissions: serviceToken.permissions },
    });
    // The only response that ever carries the plaintext.
    res.status(201).json({ token, serviceToken });
  } catch (err) {
    res.status(400).json({ error: String(err.message ?? err) });
  }
});

router.delete('/api/tokens/:tokenId', requirePermission('users.manage'), adminOnly, (req, res) => {
  try {
    const serviceToken = auth.revokeServiceToken(req.params.tokenId);
    auditSuccess(req, 'tokens.manage', {
      resourceType: 'service-token',
      resourceId: serviceToken.id,
      details: { operation: 'revoke', name: serviceToken.name },
    });
    res.json({ serviceToken });
  } catch (err) {
    res.status(404).json({ error: String(err.message ?? err) });
  }
});

export default router;
