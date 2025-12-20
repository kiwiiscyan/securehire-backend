// src/routes/proofs.ts
/* eslint-disable no-console */
import { Router } from "express";
import { zkService } from "../services/zk.service";
import SharedProof from "../models/Proofs";

const router = Router();

/**
 * POST /proofs/verify
 *
 * Two usage modes:
 *
 * 1) Direct:
 *    Body: { derivedProof, nonce?, schemaId? }
 *
 * 2) Option B (recruiter side):
 *    Body: { applicationId, vcId }
 *    - Backend will load the stored SharedProof by (applicationId, vcId),
 *      then call zkService.verifyProof() using the saved derivedProof + nonce.
 */
router.post("/verify", async (req, res) => {
  try {
    const { applicationId, vcId, vc } = req.body as {
      applicationId?: string;
      vcId?: string;
      vc?: any; // optional direct VC verify
    };

    let vcToVerify = vc;
    let source: "direct" | "sharedProof" = "direct";

    // Recruiter common path: verify a VC already shared in an application
    if (applicationId && vcId && !vcToVerify) {
      const record = await SharedProof.findOne({ applicationId, vcId }).lean();
      if (!record) return res.status(404).json({ error: "Shared VC not found" });
      vcToVerify = record.revealedDocument;
      source = "sharedProof";
      console.log("[POST /proofs/verify] loaded from SharedProof:", {
        applicationId,
        vcId,
        hasDerivedProof: !!(record as any)?.derivedProof,
        hasRevealedDocument: !!(record as any)?.revealedDocument,
      });
    }

    if (!vcToVerify) {
      return res.status(400).json({ error: "Provide (applicationId+vcId) or vc" });
    }

    const proof0 = Array.isArray(vcToVerify?.proof) ? vcToVerify?.proof?.[0] : vcToVerify?.proof;
    console.log("[POST /proofs/verify] verifying payload:", {
      source: applicationId && vcId && !vc ? "sharedProof" : "direct",
      vcId: vcToVerify?.id,
      vcType: vcToVerify?.type,
      issuer: vcToVerify?.issuer,
      hasCredentialSubject: !!vcToVerify?.credentialSubject,
      proofType: proof0?.type,
    });

    const result = await zkService.verifyVc({ vc: vcToVerify });
    console.log("[POST /proofs/verify] verify result:", result);
    return res.json({ ok: result.valid, reason: result.reason ?? null, source });
  } catch (err: any) {
    console.error("POST /proofs/verify error:", err);
    return res.status(500).json({ error: "Failed to verify VC" });
  }
});


export default router;