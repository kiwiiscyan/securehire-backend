// src/routes/recruiters.ts
/* eslint-disable no-console */
import express, { Request, Response } from "express";
import Recruiter, { IRecruiter } from "../models/Recruiter";
import SharedProof from "../models/Proofs";
import { zkService } from "../services/zk.service";

const router = express.Router();

/**
 * Small helper to map Mongoose doc -> API shape (RecruiterApi)
 */
function toRecruiterApi(doc: IRecruiter) {
  return {
    id: doc._id.toString(),
    did: doc.did,
    orgLegalName: doc.orgLegalName,
    contactEmail: doc.contactEmail,
    website: doc.website,
    onboarded: doc.onboarded,
    kycStatus: doc.kycStatus ?? "none",
    badge: {
      verified: doc.badge?.verified ?? false,
      level: doc.badge?.level,
      lastCheckedAt: doc.badge?.lastCheckedAt
        ? doc.badge.lastCheckedAt.toISOString()
        : undefined,
      txHash: doc.badge?.txHash ?? null,
      network: doc.badge?.network ?? null,
      credentialId: doc.badge?.credentialId ?? null,
    },
    kycDocs: {
      bizRegFilename: doc.kycDocs?.bizRegFilename ?? null,
      letterheadFilename: doc.kycDocs?.letterheadFilename ?? null,
      hrIdFilename: doc.kycDocs?.hrIdFilename ?? null,
    },
  };
}

/**
 * GET /recruiters/me?did=... or ?email=...
 * Used by:
 *  - RecruiterAuthCard
 *  - Onboarding page initial fetch
 */
router.get("/me", async (req: Request, res: Response) => {
  try {
    const { did, email } = req.query as { did?: string; email?: string };

    if (!did && !email) {
      return res.status(400).json({ error: "did or email query param required" });
    }

    let recruiter: IRecruiter | null = null;

    if (did) {
      recruiter = await Recruiter.findOne({ did });
    }

    if (!recruiter && email) {
      recruiter = await Recruiter.findOne({ contactEmail: email });
    }

    if (!recruiter) {
      // IMPORTANT: 404 so jfetch throws a "404 ..." error string
      return res.status(404).json({ error: "Recruiter not found" });
    }

    return res.json(toRecruiterApi(recruiter));
  } catch (err) {
    console.error("GET /recruiters/me error:", err);
    return res.status(500).json({ error: "Failed to fetch recruiter" });
  }
});

// Update recruiter basic profile (org info) without touching KYC/docs.
router.patch("/me", async (req: Request, res: Response) => {
  try {
    const { did, orgLegalName, contactEmail, website } = req.body as {
      did?: string;
      orgLegalName?: string;
      contactEmail?: string;
      website?: string | null;
    };

    if (!did) {
      return res.status(400).json({ error: "did is required" });
    }

    const recruiter = await Recruiter.findOne({ did });

    if (!recruiter) {
      return res.status(404).json({ error: "Recruiter not found" });
    }

    if (typeof orgLegalName === "string") {
      recruiter.orgLegalName = orgLegalName;
    }
    if (typeof contactEmail === "string") {
      recruiter.contactEmail = contactEmail;
    }

    // allow empty string / null to clear website
    if (typeof website === "string") {
      recruiter.website = website;
    } else if (website === null) {
      recruiter.website = undefined; // clear it instead of storing null
    }

    await recruiter.save();
    return res.json(toRecruiterApi(recruiter));
  } catch (err) {
    console.error("PATCH /recruiters/me error:", err);
    return res.status(500).json({ error: "Failed to update recruiter profile" });
  }
});

/**
 * POST /recruiters
 * Body: { did: string; email?: string }
 * Used by onboarding page when recruiter doc doesn't exist yet.
 */
router.post("/", async (req: Request, res: Response) => {
  try {
    const { did, email } = req.body as { did?: string; email?: string };

    if (!did) {
      return res.status(400).json({ error: "did is required" });
    }

    let recruiter = await Recruiter.findOne({ did });
    if (recruiter) {
      return res.json(toRecruiterApi(recruiter));
    }

    recruiter = new Recruiter({
      did,
      contactEmail: email,
      onboarded: false,
      kycStatus: "none",
      badge: { verified: false },
    });

    await recruiter.save();

    return res.status(201).json(toRecruiterApi(recruiter));
  } catch (err) {
    console.error("POST /recruiters error:", err);
    return res.status(500).json({ error: "Failed to create recruiter" });
  }
});

/**
 * POST /recruiters/onboarding
 * Body: {
 *   did: string;
 *   orgLegalName: string;
 *   website?: string;
 *   contactEmail: string;
 *   kycDocs?: { bizRegFilename?: string | null; letterheadFilename?: string | null; hrIdFilename?: string | null }
 * }
 *
 * Called by onboarding page Step 3 "Submit for Verification".
 * Sets kycStatus="pending" and onboarded=true.
 */
router.post("/onboarding", async (req: Request, res: Response) => {
  try {
    const {
      did,
      orgLegalName,
      website,
      contactEmail,
      kycDocs,
    }: {
      did?: string;
      orgLegalName?: string;
      website?: string;
      contactEmail?: string;
      kycDocs?: {
        bizRegFilename?: string | null;
        letterheadFilename?: string | null;
        hrIdFilename?: string | null;
      };
    } = req.body;

    if (!did) {
      return res.status(400).json({ error: "did is required" });
    }

    if (!orgLegalName || !contactEmail) {
      return res.status(400).json({
        error: "orgLegalName and contactEmail are required for onboarding",
      });
    }

    const recruiter = await Recruiter.findOne({ did });
    if (!recruiter) {
      return res.status(404).json({ error: "Recruiter not found" });
    }

    recruiter.orgLegalName = orgLegalName;
    recruiter.website = website;
    recruiter.contactEmail = contactEmail;

    recruiter.kycStatus = "pending";
    recruiter.onboarded = true;

    recruiter.kycDocs = {
      bizRegFilename: kycDocs?.bizRegFilename ?? null,
      letterheadFilename: kycDocs?.letterheadFilename ?? null,
      hrIdFilename: kycDocs?.hrIdFilename ?? null,
    };

    await recruiter.save();

    return res.json(toRecruiterApi(recruiter));
  } catch (err) {
    console.error("POST /recruiters/onboarding error:", err);
    return res.status(500).json({ error: "Failed to submit recruiter onboarding" });
  }
});

router.post("/verify-vc", async (req, res) => {
  try {
    const { applicationId, vcId } = req.body as { applicationId?: string; vcId?: string };
    if (!applicationId || !vcId) return res.status(400).json({ error: "applicationId and vcId required" });

    const record = await SharedProof.findOne({ applicationId, vcId }).lean();
    if (!record?.revealedDocument) return res.status(404).json({ error: "Shared VC not found" });

    const vc: any = record.revealedDocument;
    const proof0 = Array.isArray(vc?.proof) ? vc?.proof?.[0] : vc?.proof;
    console.log("[POST /recruiters/verify-vc] verifying shared VC:", {
      applicationId,
      vcId,
      storedHasDerivedProof: !!(record as any)?.derivedProof,
      storedHasRevealedDocument: !!(record as any)?.revealedDocument,
      revealedVcId: vc?.id,
      revealedType: vc?.type,
      revealedIssuer: vc?.issuer,
      revealedHasCredentialSubject: !!vc?.credentialSubject,
      revealedProofType: proof0?.type,
      revealedVmId: vc?.verificationMethod?.id,
      revealedVmType: vc?.verificationMethod?.type,
    });

    const out = await zkService.verifyVc({ vc: record.revealedDocument });
    console.log("[POST /recruiters/verify-vc] verify result:", out);
    return res.json(out);
  } catch (e: any) {
    console.error("[POST /recruiters/verify-vc] error:", e?.message ?? String(e));
    return res.status(500).json({ error: "Failed to verify shared VC", details: e?.message ?? String(e) });
  }
});

export default router;