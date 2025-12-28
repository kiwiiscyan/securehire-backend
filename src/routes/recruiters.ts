// src/routes/recruiters.ts
/* eslint-disable no-console */
import express, { Request, Response } from "express";
import Recruiter, { IRecruiter } from "../models/Recruiter";
import Application from "../models/Application";
import SharedProof from "../models/Proofs";
import { zkService } from "../services/zk.service";
import { requireSession } from "../middleware/requireSession";
import { mustGetSession, mustGetDid } from "../auth/identity";

const router = express.Router();

router.use(requireSession);

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
 * GET /recruiters/me  (session-only)
 * Used by:
 *  - RecruiterAuthCard
 *  - Onboarding page initial fetch
 */
router.get("/me", async (req, res) => {
  try {
    const s = mustGetSession(req);
    const did = s.did?.trim();
    const email = s.email?.trim().toLowerCase();

    if (req.query?.did || req.query?.email) {
      return res.status(400).json({ error: "Do not send did/email in query. Session-only." });
    }

    let recruiter = null;
    if (did) recruiter = await Recruiter.findOne({ did });
    if (!recruiter && email) recruiter = await Recruiter.findOne({ contactEmail: email });

    if (!recruiter) return res.status(404).json({ error: "Recruiter not found" });
    return res.json(toRecruiterApi(recruiter));
  } catch (e) {
    return res.status(401).json({ error: "Unauthenticated" });
  }
});

// Update recruiter basic profile (org info) without touching KYC/docs.
router.patch("/me", async (req, res) => {
  try {
    const s = mustGetSession(req);
    if (!s.did) return res.status(401).json({ error: "Missing DID in session" });

    const recruiter = await Recruiter.findOne({ did: s.did });
    if (!recruiter) return res.status(404).json({ error: "Recruiter not found" });

    const { orgLegalName, contactEmail, website } = req.body || {};

    if (typeof orgLegalName === "string") recruiter.orgLegalName = orgLegalName;
    if (typeof contactEmail === "string") recruiter.contactEmail = contactEmail;

    if (typeof website === "string") recruiter.website = website;
    else if (website === null) recruiter.website = undefined;

    await recruiter.save();
    return res.json(toRecruiterApi(recruiter));
  } catch (e) {
    return res.status(401).json({ error: "Unauthenticated" });
  }
});

// GET /recruiters/public/:id
router.get("/public/:id", async (req, res) => {
  const id = String(req.params.id || "").trim();

  // decide whether :id is MongoId or DID
  const isMongoId = /^[a-f0-9]{24}$/i.test(id);

  const recruiter = isMongoId
    ? await Recruiter.findById(id)
    : await Recruiter.findOne({ did: id });

  if (!recruiter) return res.status(404).json({ error: "Recruiter not found" });

  return res.json({
    id: recruiter._id.toString(),
    did: recruiter.did,
    kycStatus: recruiter.kycStatus ?? "none",
    badge: {
      verified: recruiter.badge?.verified ?? false,
      txHash: recruiter.badge?.txHash ?? null,
      credentialId: recruiter.badge?.credentialId ?? null,
      network: recruiter.badge?.network ?? null,
      lastCheckedAt: recruiter.badge?.lastCheckedAt
        ? recruiter.badge.lastCheckedAt.toISOString()
        : undefined,
    },
  });
});

/**
 * POST /recruiters
 * Body: { did: string; email?: string }
 * Used by onboarding page when recruiter doc doesn't exist yet.
 */
router.post("/", async (req, res) => {
  try {
    const s = mustGetSession(req);
    if (!s.did) return res.status(401).json({ error: "Missing DID in session" });

    let recruiter = await Recruiter.findOne({ did: s.did });
    if (recruiter) return res.json(toRecruiterApi(recruiter));

    recruiter = new Recruiter({
      did: s.did,
      contactEmail: s.email, // if present
      onboarded: false,
      kycStatus: "none",
      badge: { verified: false },
    });

    await recruiter.save();
    return res.status(201).json(toRecruiterApi(recruiter));
  } catch (e) {
    return res.status(401).json({ error: "Unauthenticated" });
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
router.post("/onboarding", async (req, res) => {
  try {
    const s = mustGetSession(req);
    if (!s.did) return res.status(401).json({ error: "Missing DID in session" });

    const { orgLegalName, website, contactEmail, kycDocs } = req.body || {};
    if (!orgLegalName || !contactEmail) {
      return res.status(400).json({ error: "orgLegalName and contactEmail are required" });
    }

    const recruiter = await Recruiter.findOne({ did: s.did });
    if (!recruiter) return res.status(404).json({ error: "Recruiter not found" });

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
  } catch (e) {
    return res.status(401).json({ error: "Unauthenticated" });
  }
});

router.post("/verify-vc", async (req, res) => {
  try {
    const recruiterDid = mustGetDid(req);

    const { applicationId, vcId } = req.body as { applicationId?: string; vcId?: string };
    if (!applicationId || !vcId) return res.status(400).json({ error: "applicationId and vcId required" });

    const app = await Application.findById(applicationId).lean();
    if (!app) return res.status(404).json({ error: "Application not found" });
    if (String((app as any).recruiterDid) !== recruiterDid) return res.status(403).json({ error: "Forbidden" });

    const record = await SharedProof.findOne({ applicationId, vcId }).lean();
    if (!record?.revealedDocument) return res.status(404).json({ error: "Shared VC not found" });

    const out = await zkService.verifyVc({ vc: record.revealedDocument });
    return res.json(out);
  } catch (e: any) {
    return res.status(500).json({ error: "Failed to verify shared VC", details: e?.message ?? String(e) });
  }
});

export default router;