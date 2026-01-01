// src/routes/issuer.ts
import { Router, Request, Response } from "express";
import Credential from "../models/Credential";
import Seeker from "../models/Seeker";
import Issuer, { IIssuer } from "../models/Issuer";
import Recruiter, { IRecruiter } from "../models/Recruiter";
import SharedProof from "../models/Proofs";
import Application from "../models/Application";
import mongoose from "mongoose";
import { issueRecruiterBadgeOnChain, revokeRecruiterBadgeOnChain } from "../services/chain.service";
import {
  issueSimpleVc,
  CredentialType,
  VcSection,
} from "../services/vc.service";
import { ensureBbsKeyForIssuer } from "../services/bbsKey.service";
import { requireSession } from "../middleware/requireSession";
import { mustGetSession, mustGetDid } from "../auth/identity";
import { requireUser } from "../middleware/requireUser";
import { syncIssuerRoleFromIssuerDoc } from "../middleware/syncIssuerRoleFromIssuerDoc";
import { requireRoleStateIn, requireRoleActive } from "../middleware/rbac";

const router = Router();

router.use(requireSession, requireUser, syncIssuerRoleFromIssuerDoc);

/**
 * Helper type: per-section structured claims that also carries credentialType.
 */
type SectionClaims =
  | {
    section: "career";
    credentialType: "EmploymentCredential";
    title: string;
    employment: any;
  }
  | {
    section: "education";
    credentialType: "EducationCredential";
    title: string;
    education: any;
  }
  | {
    section: "certification";
    credentialType: "CertificationCredential";
    title: string;
    certification: any;
  }
  | {
    section: VcSection;
    credentialType: "GenericCredential";
    title: string;
    raw: any;
  };

/**
 * Convert a seeker profile entry to a structured claims object
 * including section + credentialType + title.
 */
function buildSectionClaims(
  section: VcSection,
  profileSection: any
): SectionClaims {
  if (section === "career") {
    return {
      section: "career",
      credentialType: "EmploymentCredential",
      title: `${profileSection.title} at ${profileSection.company}`,
      employment: {
        jobTitle: profileSection.title,
        companyName: profileSection.company,
        startMonth: profileSection.startMonth,
        startYear: profileSection.startYear,
        endMonth: profileSection.endMonth,
        endYear: profileSection.endYear,
        stillInRole: profileSection.stillInRole,
        description: profileSection.description,
      },
    };
  }

  if (section === "education") {
    return {
      section: "education",
      credentialType: "EducationCredential",
      title: `${profileSection.qualification} at ${profileSection.institution}`,
      education: {
        qualification: profileSection.qualification,
        institution: profileSection.institution,
        fieldOfStudy: profileSection.fieldOfStudy,
        startMonth: profileSection.startMonth,
        startYear: profileSection.startYear,
        endMonth: profileSection.endMonth,
        endYear: profileSection.endYear,
        stillStudying: profileSection.stillStudying,
        description: profileSection.description,
      },
    };
  }

  if (section === "certification") {
    return {
      section: "certification",
      credentialType: "CertificationCredential",
      title: `${profileSection.name} by ${profileSection.issuer}`,
      certification: {
        name: profileSection.name,
        issuer: profileSection.issuer,
        issueMonth: profileSection.issueMonth,
        issueYear: profileSection.issueYear,
        expiryMonth: profileSection.expiryMonth,
        expiryYear: profileSection.expiryYear,
        doesNotExpire: profileSection.doesNotExpire,
        description: profileSection.description,
      },
    };
  }

  return {
    section,
    credentialType: "GenericCredential",
    title: profileSection?.title || "Verified Credential",
    raw: profileSection,
  };
}

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
      revocationTxHash: (doc.badge as any)?.revocationTxHash ?? null,
      revokeReason: (doc.badge as any)?.revokeReason ?? null,
      revokedAt: (doc.badge as any)?.revokedAt
        ? (doc.badge as any).revokedAt.toISOString()
        : null,
    },
    kycDocs: {
      bizRegFilename: doc.kycDocs?.bizRegFilename ?? null,
      letterheadFilename: doc.kycDocs?.letterheadFilename ?? null,
      hrIdFilename: doc.kycDocs?.hrIdFilename ?? null,
    },
  };
}

/**
 * @openapi
 * /issuer/vc/issue:
 *   post:
 *     summary: Issue a VC manually (demo / dev only, BBS+ signed)
 *     tags: [Issuer VC]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               issuerDid: { type: string }
 *               subjectDid: { type: string }
 *               section:
 *                 type: string
 *                 enum: [career, education, certification, recruiter]
 *               title: { type: string }
 *               credentialType:
 *                 type: string
 *                 enum:
 *                   [EmploymentCredential, EducationCredential, CertificationCredential, RecruiterCredential, GenericCredential]
 *               claims: { type: object }
 *     responses:
 *       201:
 *         description: VC issued (BBS+)
 *       400:
 *         description: Bad request
 */
router.post("/vc/issue",
  requireRoleActive("issuer"),
  async (req: Request, res: Response) => {
    try {
      const s = mustGetSession(req);
      const did = s.did?.trim();
      const email = s.email?.trim().toLowerCase();

      const issuer =
        (did && (await Issuer.findOne({ did }))) ||
        (email && (await Issuer.findOne({ email })));

      if (!issuer) return res.status(404).json({ error: "Issuer not found" });

      const { subjectDid, claims } = req.body;
      if (!subjectDid || !claims) {
        return res.status(400).json({ error: "subjectDid and claims are required" });
      }

      const issuerDid = issuer.did;

      const section =
        (claims.section as "career" | "education" | "certification" | "recruiter") ??
        "recruiter";

      const credentialType =
        (claims.credentialType as CredentialType) ?? "GenericCredential";

      const title =
        (claims.title as string) ??
        `Verified ${credentialType} from ${issuerDid}`;

      const { vcId, vc } = await issueSimpleVc({
        subjectDid,
        issuerDid,
        section,
        title,
        credentialType,
        claims,
      });

      const cred = await Credential.create({
        credentialId: vcId,
        subjectDid,
        issuerDid,
        title,
        type: vc.type,
        issuanceDate: new Date(vc.issuanceDate),
        status: "active",
        vcRaw: vc,
      });

      return res.status(201).json({
        ok: true,
        credential: cred,
      });
    } catch (err) {
      console.error("POST /issuer/vc/issue error:", err);
      return res.status(500).json({ error: "Failed to issue VC" });
    }
  });

/**
 * GET /issuer/vc
 * Optional query: issuerDid
 * Returns all credentials issued by this issuer.
 */
router.get("/vc", async (req, res) => {
  try {
    const s = mustGetSession(req);
    const did = s.did?.trim();
    const email = s.email?.trim().toLowerCase();

    const issuer =
      (did && (await Issuer.findOne({ did }).lean())) ||
      (email && (await Issuer.findOne({ email }).lean()));

    if (!issuer) return res.status(404).json({ error: "Issuer not found" });

    const creds = await Credential.find({ issuerDid: issuer.did }).sort({ createdAt: -1 }).lean();
    return res.json({ items: creds });
  } catch (e) {
    return res.status(401).json({ error: "Unauthenticated" });
  }
});

/**
 * @openapi
 * /issuer/vc/{credentialId}:
 *   get:
 *     summary: Get raw VC (JSON) by credentialId
 *     tags: [Issuer VC]
 *     parameters:
 *       - in: path
 *         name: credentialId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: VC JSON
 *       404:
 *         description: VC not found
 */
router.get("/vc/:credentialId",
  async (req: Request, res: Response) => {
    try {
      const { credentialId } = req.params;
      const cred = await Credential.findOne({ credentialId }).lean();

      if (!cred) {
        return res.status(404).json({ error: "Credential not found" });
      }

      if ((cred as any).vcRaw) {
        const raw = (cred as any).vcRaw;

        if (typeof raw === "object") {
          return res.json(raw);
        }

        if (typeof raw === "string") {
          try {
            const parsed = JSON.parse(raw);
            return res.json(parsed);
          } catch {
            return res.json({ vcRaw: raw });
          }
        }

        // Fallback
        return res.json({ vcRaw: raw });
      }

      return res.json({
        id: cred.credentialId,
        type: cred.type,
        issuerDid: cred.issuerDid,
        subjectDid: cred.subjectDid,
        issuanceDate: cred.issuanceDate,
        status: cred.status,
      });
    } catch (err) {
      console.error("GET /issuer/vc/:credentialId error:", err);
      return res.status(500).json({ error: "Failed to fetch VC" });
    }
  });

/**
 * @openapi
 * /issuer/vc/revoke:
 *   post:
 *     summary: Revoke a VC
 *     tags: [Issuer]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [credentialId]
 *             properties:
 *               credentialId: { type: string }
 *               reason: { type: string }
 */
// POST /issuer/vc/revoke (standalone-safe)
router.post("/vc/revoke",
  requireRoleActive("issuer"),
  async (req, res) => {
    const { credentialId, reason } = req.body;
    if (!credentialId) return res.status(400).json({ error: "credentialId required" });

    const issuerDid = mustGetDid(req);

    try {
      const cred = await Credential.findOne({ credentialId, issuerDid }).lean();
      if (!cred) return res.status(404).json({ error: "not found" });

      // 1) Revoke off-chain VC
      const updated = await Credential.findOneAndUpdate(
        { credentialId, issuerDid },
        {
          $set: {
            status: "revoked",
            revokedAt: new Date(),
            revokeReason: reason || "unspecified",
          },
        },
        { new: true }
      ).lean();

      // 2) If this is a recruiter trust VC, also revoke on-chain + update Recruiter.badge
      const isRecruiterVc =
        Array.isArray(cred.type) && cred.type.includes("RecruiterCredential");

      let badgeRevocation: any = null;

      if (isRecruiterVc) {
        // find recruiter by DID = subjectDid
        const recruiter = await Recruiter.findOne({ did: cred.subjectDid });

        if (recruiter) {
          // revoke on-chain
          const tx = await revokeRecruiterBadgeOnChain(recruiter.did);

          // update recruiter badge
          await Recruiter.updateOne(
            { _id: recruiter._id },
            {
              $set: {
                "badge.verified": false,
                "badge.status": "Revoked",
                "badge.lastCheckedAt": new Date(),
                "badge.revokedAt": new Date(),
                "badge.revokeReason": reason || "unspecified",
                "badge.revocationTxHash": tx.txHash,
                "badge.network": tx.network,
              },
            }
          );

          // optional: also store revocation tx on credential
          await Credential.updateOne(
            { credentialId, issuerDid },
            { $set: { revocationTxHash: tx.txHash } }
          );

          badgeRevocation = tx;
        }
      } else {
        // Non-recruiter VC cleanup (job seeker flow)
        await Seeker.updateOne(
          { did: cred.subjectDid },
          {
            $set: { "vcs.$[v].status": "revoked" },
            $pull: { defaultSharedVcIds: credentialId },
          },
          { arrayFilters: [{ "v.credentialId": credentialId }] }
        );

        await Application.updateMany(
          { sharedVcIds: credentialId },
          { $pull: { sharedVcIds: credentialId } }
        );

        await SharedProof.deleteMany({ vcId: credentialId });
      }

      return res.json({
        revoked: true,
        reason: reason || "unspecified",
        meta: updated,
        badgeRevocation, // null for normal VCs
      });
    } catch (err) {
      console.error("POST /issuer/vc/revoke error:", err);
      return res.status(500).json({ error: "Failed to revoke VC" });
    }
  });

/**
 * @openapi
 * /issuer/requests:
 *   get:
 *     summary: List pending VC requests for an issuer
 *     tags: [Issuer]
 *     parameters:
 *       - in: query
 *         name: issuerDid
 *         schema:
 *           type: string
 *         description: Filter by issuer DID (e.g., did:ethr:0xEMPLOYER_ISSUER_ABC)
 */
router.get("/requests",
  requireRoleActive("issuer"),
  async (req, res) => {
    try {
      const issuerDid = mustGetDid(req);

      const seekers = await Seeker.find({
        pendingVcRequests: { $exists: true, $ne: [] },
      }).lean();

      const allRequests: any[] = [];
      for (const seeker of seekers) {
        for (const r of seeker.pendingVcRequests || []) {
          if (r.issuerDid !== issuerDid) continue;

          allRequests.push({
            requestId: r.id,
            section: r.section,
            title: r.title,
            issuerDid: r.issuerDid,
            status: r.status ?? "pending",
            requestedAt: r.requestedAt,
            seekerId: seeker._id.toString(),
            seekerDid: seeker.did,
            seekerEmail: seeker.email,
          });
        }
      }

      return res.json({ items: allRequests });
    } catch (err) {
      console.error("GET /issuer/requests error:", err);
      return res.status(500).json({ error: "Failed to list VC requests" });
    }
  });

/**
 * @openapi
 * /issuer/requests/{requestId}/approve:
 *   post:
 *     summary: Approve a VC request and issue VC
 *     tags: [Issuer VC Requests]
 *     parameters:
 *       - in: path
 *         name: requestId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               issuerDid: { type: string }
 *               seekerDid: { type: string }
 *               section: { type: string }
 *     responses:
 *       200:
 *         description: VC issued and request approved
 *       404:
 *         description: Request or seeker not found
 */
router.post(
  "/requests/:requestId/approve",
  requireRoleActive("issuer"),
  async (req: Request, res: Response) => {
    try {
      const { requestId } = req.params;
      /*
      const { issuerDid, seekerDid, section } = req.body as {
        issuerDid: string;
        seekerDid: string;
        section: "career" | "education" | "certification";
      };
      */
      const issuerDid = mustGetDid(req);
      const { section } = req.body;

      const seeker = await Seeker.findOne({
        "pendingVcRequests.id": requestId,
      });

      //const seeker = await Seeker.findOne({ did: seekerDid });
      if (!seeker) return res.status(404).json({ error: "Seeker not found" });

      const reqIdx = seeker.pendingVcRequests?.findIndex(
        (r: any) => r.id === requestId
      );
      if (reqIdx == null || reqIdx < 0) {
        return res.status(404).json({ error: "Request not found" });
      }

      const reqEntry = seeker.pendingVcRequests![reqIdx];

      if (reqEntry.issuerDid !== issuerDid) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const seekerDid = seeker.did;

      if (!issuerDid || !seekerDid || !section) {
        return res
          .status(400)
          .json({ error: "issuerDid, seekerDid, section required" });
      }

      // find the profile entry that matches the requested title
      let profileEntry;
      if (section === "career") {
        profileEntry = seeker.profile?.careerHistory?.find(
          (c: any) =>
            `${c.title} at ${c.company}`.trim() === reqEntry.title.trim()
        );
      } else if (section === "education") {
        profileEntry = seeker.profile?.education?.find(
          (e: any) =>
            `${e.qualification} at ${e.institution}`.trim() === reqEntry.title.trim()
        );
      } else if (section === "certification") {
        profileEntry = seeker.profile?.certifications?.find(
          (c: any) =>
            `${c.name} by ${c.issuer}`.trim() === reqEntry.title.trim()
        );
      }

      if (!profileEntry) {
        return res.status(400).json({
          error: "Profile entry not found for this request title/section",
        });
      }

      const vcClaims = buildSectionClaims(section, profileEntry);

      const { vcId, vc } = await issueSimpleVc({
        subjectDid: seekerDid,
        issuerDid,
        section,
        title: vcClaims.title,
        credentialType: vcClaims
          .credentialType as import("../services/vc.service").CredentialType,
        claims: vcClaims,
      });

      const credentialDoc = await Credential.create({
        credentialId: vcId,
        subjectDid: seekerDid,
        issuerDid,
        title: vcClaims.title,
        type: vc.type,
        issuanceDate: new Date(vc.issuanceDate),
        status: "active",
        vcRaw: vc,
      });

      // move from pendingVcRequests → vcs
      seeker.pendingVcRequests![reqIdx].status = "approved";
      seeker.pendingVcRequests = (seeker.pendingVcRequests || []).filter(
        (r: any) => r.id !== requestId
      );
      seeker.vcs = [
        ...(seeker.vcs ?? []),
        {
          id: credentialDoc._id.toString(),
          section,
          title: vcClaims.title,
          issuerDid,
          status: "active",
          issuedAt: new Date().toISOString(),
          credentialId: vcId,
          requestedAt: reqEntry.requestedAt,
        },
      ];
      await seeker.save();

      return res.json({
        ok: true,
        requestId,
        credential: credentialDoc,
      });
    } catch (err) {
      console.error(
        "POST /issuer/requests/:requestId/approve error:",
        err
      );
      return res.status(500).json({ error: "Failed to approve VC request" });
    }
  }
);

/**
 * @openapi
 * /issuer/requests/{requestId}/reject:
 *   post:
 *     summary: Reject a VC request
 *     tags: [Issuer]
 *     parameters:
 *       - in: path
 *         name: requestId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason: { type: string }
 */
router.post("/requests/:requestId/reject",
  requireRoleActive("issuer"),
  async (req, res) => {
    try {
      const { requestId } = req.params;
      const { reason } = req.body || {};
      const issuerDid = mustGetDid(req);

      const seeker = await Seeker.findOne({
        "pendingVcRequests.id": requestId,
      });

      if (!seeker) {
        return res.status(404).json({ error: "Request not found" });
      }

      const pendingList = seeker.pendingVcRequests || [];
      const requestEntry = pendingList.find((r: any) => r.id === requestId);
      if (!requestEntry) {
        return res.status(404).json({ error: "Request not found" });
      }

      if (requestEntry.issuerDid !== issuerDid) {
        return res.status(403).json({ error: "Forbidden" });
      }

      requestEntry.status = "rejected";
      requestEntry.rejectedAt = new Date().toISOString();
      requestEntry.rejectReason = reason || "unspecified";

      seeker.pendingVcRequests = pendingList.filter(
        (r: any) => r.id !== requestId
      );

      seeker.vcs = [
        ...(seeker.vcs ?? []),
        {
          id: requestEntry.id,
          section: requestEntry.section,
          title: requestEntry.title,
          issuerDid: requestEntry.issuerDid,
          status: "rejected",
          issuedAt: requestEntry.rejectedAt,
          credentialId: undefined,             // no actual VC JSON
        },
      ];

      await seeker.save();

      return res.json({ ok: true, request: requestEntry });
    } catch (err) {
      console.error("POST /issuer/requests/:requestId/reject error:", err);
      return res.status(500).json({ error: "Failed to reject VC request" });
    }
  });

/**
 * GET /issuer/recruiters/pending
 *
 * List recruiters whose KYC is pending.
 * Later you can filter by issuer orgName if needed.
 */
router.get("/recruiters/pending",
  requireRoleActive("issuer"),
  async (req: Request, res: Response) => {
    try {
      // const { issuerDid } = req.query as { issuerDid?: string };

      let orgNameFilter: string | undefined;

      const issuerDid = mustGetDid(req);
      const issuer = await Issuer.findOne({ did: issuerDid });
      if (issuer?.orgName) {
        // normalize: lowercase + remove spaces 
        orgNameFilter = issuer.orgName.toLowerCase().replace(/\s+/g, "");
      }

      /*
      if (issuerDid) {
        const issuer = await Issuer.findOne({ did: issuerDid });
        if (issuer?.orgName) {
          // normalize: lowercase + remove spaces
          orgNameFilter = issuer.orgName.toLowerCase().replace(/\s+/g, "");
        }
      }
        */

      const recruitersRaw = await Recruiter.find({ kycStatus: "pending" });
      const filtered = recruitersRaw.filter(r => {
        if (!orgNameFilter) return true;

        const legal = (r.orgLegalName ?? "").toLowerCase().replace(/\s+/g, "");
        return legal === orgNameFilter;
      });

      return res.json({ items: filtered.map(toRecruiterApi) });
    } catch (err) {
      console.error("GET /issuer/recruiters/pending error:", err);
      res.status(500).json({ error: "Failed to list pending recruiters" });
    }
  });

/**
 * GET /issuer/recruiters/badges
 *
 * List recruiters whose identity / trust badge is in-scope for issuer:
 * - kycStatus "pending" (awaiting decision)
 * - or "approved" with an active badge
 */
router.get("/recruiters/badges",
  requireRoleActive("issuer"),
  async (req: Request, res: Response) => {
    try {
      //const { issuerDid } = req.query as { issuerDid?: string };

      let orgNameFilter: string | undefined;

      const issuerDid = mustGetDid(req);
      const issuer = await Issuer.findOne({ did: issuerDid });
      if (issuer?.orgName) {
        orgNameFilter = issuer.orgName.toLowerCase().replace(/\s+/g, "");
      }

      /*
      if (issuerDid) {
        const issuer = await Issuer.findOne({ did: issuerDid });
        if (issuer?.orgName) {
          orgNameFilter = issuer.orgName.toLowerCase().replace(/\s+/g, "");
        }
      }
      */

      const recruitersRaw = await Recruiter.find({
        kycStatus: { $in: ["rejected", "approved"] }
      }).sort({ updatedAt: -1 });

      const filtered = recruitersRaw.filter(r => {
        if (!orgNameFilter) return true;

        const legal = (r.orgLegalName ?? "").toLowerCase().replace(/\s+/g, "");
        return legal === orgNameFilter;
      });

      return res.json({ items: filtered.map(toRecruiterApi) });
    } catch (err) {
      console.error("GET /issuer/recruiters/badges error:", err);
      return res
        .status(500)
        .json({ error: "Failed to list recruiter trust badges" });
    }
  });

/**
 * POST /issuer/recruiters/:id/approve
 * Body: { level?: number }
 */
// PATCH: /issuer/recruiters/:id/approve

router.post("/recruiters/:id/approve",
  requireRoleActive("issuer"),
  async (req: Request, res: Response) => {
    try {
      const recruiterId = req.params.id;

      // Whoever hits this endpoint is the issuer → get DID from DB
      //const issuer = await Issuer.findOne({ did: req.body.issuerDid });
      const issuerDid = mustGetDid(req);
      const issuer = await Issuer.findOne({ did: issuerDid });
      if (!issuer) {
        return res.status(400).json({ error: "Issuer not found" });
      }

      const recruiter = await Recruiter.findById(recruiterId);

      if (!recruiter) {
        return res.status(404).json({ error: "Recruiter not found" });
      }

      const subjectDid = recruiter.did;             // ✔ recruiter DID

      // 1) Issue the on-chain trust badge
      const badge = await issueRecruiterBadgeOnChain(subjectDid, 1);

      // 2) Issue a real Verifiable Credential
      const { vcId, vc } = await issueSimpleVc({
        subjectDid,
        issuerDid,
        section: "recruiter",
        credentialType: "RecruiterCredential",
        title: `Recruiter Verification for ${recruiter.orgLegalName ?? "Unknown Org"}`,
        claims: {
          section: "recruiter",
          orgName: recruiter.orgLegalName,
          contactEmail: recruiter.contactEmail,
          website: recruiter.website
        }
      });

      // 3) Create Credential document
      await Credential.create({
        credentialId: vcId,
        subjectDid,
        issuerDid,
        title: `Recruiter Verification for ${recruiter.orgLegalName}`,
        type: vc.type,
        issuanceDate: new Date(vc.issuanceDate),
        status: "active",
        vcRaw: vc,
        onChainTxHash: badge.txHash,
        network: badge.network,
      });

      // 4) Update recruiter badge meta
      recruiter.kycStatus = "approved";
      recruiter.badge = {
        verified: true,
        status: "Active",
        level: 1,
        lastCheckedAt: new Date(),
        txHash: badge.txHash,
        network: badge.network,
        credentialId: vcId,       // ⭐ NEW FIELD you MUST add in recruiter schema
      };

      await recruiter.save();

      res.json({
        ok: true,
        message: "Recruiter approved, trust badge issued, VC created",
        credentialId: vcId,
        txHash: badge.txHash
      });

    } catch (err) {
      console.error("approve recruiter error:", err);
      res.status(500).json({ error: "Failed to approve recruiter" });
    }
  });


/**
 * POST /issuer/recruiters/:id/reject
 * Body: { reason?: string }
 */
router.post("/recruiters/:id/reject",
  requireRoleActive("issuer"),
  async (req: Request, res: Response) => {
    try {
      const recruiter = await Recruiter.findById(req.params.id);
      if (!recruiter) {
        return res.status(404).json({ error: "Recruiter not found" });
      }

      recruiter.kycStatus = "rejected";
      recruiter.badge = {
        ...(recruiter.badge || {}),
        verified: false,
        status: "Rejected",
        lastCheckedAt: new Date(),
      };
      await recruiter.save();

      return res.json(toRecruiterApi(recruiter));
    } catch (err) {
      console.error("reject recruiter error", err);
      return res.status(500).json({ error: "Failed to reject recruiter" });
    }
  });

/**
 * GET /issuer/me
 *
 * Login / bootstrap endpoint.
 * - Frontend should primarily call with ?email=...
 * - Backend is responsible for canonical issuer.did (did:key from DIDKit).
 * - We normalise / migrate by calling ensureBbsKeyForIssuer if needed.
 */
router.get("/me",
  requireRoleStateIn("issuer", ["none", "active"]),
  async (req, res) => {
    try {
      const s = mustGetSession(req);
      const did = s.did?.trim();
      const email = s.email?.trim().toLowerCase();

      const issuerDoc0 =
        (did && (await Issuer.findOne({ did }))) ||
        (email && (await Issuer.findOne({ email })));

      if (!issuerDoc0) return res.status(404).json({ error: "Issuer not found" });

      const issuerDoc = await ensureBbsKeyForIssuer(issuerDoc0);

      return res.json({
        id: issuerDoc._id.toString(),
        did: issuerDoc.did,
        email: issuerDoc.email,
        name: issuerDoc.name,
        orgName: issuerDoc.orgName,
        orgType: issuerDoc.orgType,
        onboarded: issuerDoc.onboarded ?? false,
        hasBbsKey: Boolean(issuerDoc.bbsVerificationMethodId),
      });
    } catch (e) {
      return res.status(401).json({ error: "Unauthenticated" });
    }
  });

/**
 * POST /issuer/onboard
 *
 * Create or update an issuer's organisation profile.
 * - Frontend sends: { email, name, orgName, orgType, onboarded, did? }
 * - We identify issuers by email (login identifier).
 * - Backend stores a canonical issuer DID:
 *     - use provided `did` if present (e.g. did:pkh from Privy)
 *     - otherwise generate a stable fallback DID from the email
 * - BBS keys are managed via ensureBbsKeyForIssuer().
 */
router.post("/onboard",
  requireRoleStateIn("issuer", ["none", "active"]),
  async (req, res) => {
    try {
      const s = mustGetSession(req);
      const email = s.email;
      const did = s.did;
      const { name, orgName, orgType, onboarded } = req.body;

      if (!email) {
        return res
          .status(400)
          .json({ error: "email is required to onboard issuer" });
      }

      const normalizedEmail = String(email).toLowerCase();

      // Find by email only – this is our stable login identifier.
      let issuerDoc = await Issuer.findOne({ email: normalizedEmail });

      if (!issuerDoc) {
        // New issuer – we either use the provided DID or generate one.
        const baseDid =
          (did && did.trim()) ||
          `did:web:securehire:${normalizedEmail.replace(/[^a-z0-9]/gi, "-")}`;

        issuerDoc = new Issuer({
          email: normalizedEmail,
          did: baseDid,
        } as Partial<IIssuer>);
      } else {
        // Existing issuer: if DID is missing and frontend supplies one, set it once.
        if (!issuerDoc.did && did && did.trim()) {
          issuerDoc.did = did.trim();
        }
      }

      // Update basic profile fields
      if (typeof name === "string" && name.trim()) {
        issuerDoc.name = name.trim();
      }
      if (typeof orgName === "string" && orgName.trim()) {
        issuerDoc.orgName = orgName.trim();
      }
      if (orgType === "company" || orgType === "university" || orgType === "certBody") {
        issuerDoc.orgType = orgType;
      }
      if (typeof onboarded === "boolean") {
        issuerDoc.onboarded = onboarded;
      }

      // 🔐 Ensure this issuer has a BBS+ keypair (BLS12-381 G2) for VC signing.
      const issuerWithKey = await ensureBbsKeyForIssuer(issuerDoc as any);

      await issuerWithKey.save();

      if (req.user) {
        req.user.roles.issuer = issuerWithKey.onboarded ? "active" : "none";
        await req.user.save();
      }

      return res.status(201).json({
        id: issuerWithKey._id.toString(),
        did: issuerWithKey.did,
        email: issuerWithKey.email,
        name: issuerWithKey.name,
        orgName: issuerWithKey.orgName,
        orgType: issuerWithKey.orgType,
        onboarded: issuerWithKey.onboarded ?? false,
        hasBbsKey: Boolean(issuerWithKey.bbsVerificationMethodId),
      });

    } catch (err) {
      console.error("POST /issuer/onboard error:", err);
      return res.status(500).json({ error: "Failed to onboard issuer" });
    }
  });

export default router;