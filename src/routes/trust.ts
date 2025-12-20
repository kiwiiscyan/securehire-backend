import { Router } from 'express';
import Credential from '../models/Credential';
import { readOnChainStatus } from '../services/chain.service';

const router = Router();

/**
 * @openapi
 * /trust/badge:
 *   get:
 *     summary: Public trust badge for a credential
 *     tags: [Trust]
 *     parameters:
 *       - in: query
 *         name: did
 *         schema: { type: string }
 *       - in: query
 *         name: credentialId
 *         schema: { type: string }
 */
router.get('/badge', async (req, res) => {
  const did = String(req.query.did || '');
  const credentialId = String(req.query.credentialId || '');

  if (!credentialId) {
    return res.status(400).json({ error: 'credentialId query required' });
  }

  const meta = await Credential.findOne({ credentialId });
  const chain = await readOnChainStatus(did, credentialId);

  res.json({
    did: did || meta?.subjectDid || null,
    credentialId,
    onChain: chain,
    metadata: meta,
  });
});

export default router;