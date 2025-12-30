//src/routes/applications.ts
import { Router } from 'express';
import Application from '../models/Application';
import SharedProof from "../models/Proofs";
import Credential from "../models/Credential";
import Job from "../models/Jobs";
import Seeker from "../models/Seeker";
import Recruiter from "../models/Recruiter";
import { requireSession, getSession } from "../middleware/requireSession";

const router = Router();

router.use(requireSession);

// ✅ FIX: Clean VC helper - removes nested @context
function cleanVcForStorage(vc: any): any {
  if (!vc || typeof vc !== "object") return vc;

  const cleaned = JSON.parse(JSON.stringify(vc));

  // 1. Flatten @context array - remove nested @context objects
  if (Array.isArray(cleaned["@context"])) {
    const flatContexts: any[] = [];
    const seenStringContexts = new Set<string>();

    for (const ctx of cleaned["@context"]) {
      if (typeof ctx === "string") {
        // Add string contexts (URLs) only once
        if (!seenStringContexts.has(ctx)) {
          flatContexts.push(ctx);
          seenStringContexts.add(ctx);
        }
      } else if (ctx && typeof ctx === "object") {
        // Handle object contexts
        if (ctx["@context"]) {
          // This is a nested @context - flatten it
          const nestedCtx = ctx["@context"];

          // Merge outer and inner contexts
          const merged: any = {
            "@version": nestedCtx["@version"] || ctx["@version"] || 1.1,
          };

          // Add all properties from outer context (except @context)
          Object.entries(ctx).forEach(([key, value]) => {
            if (key !== "@context") {
              merged[key] = value;
            }
          });

          // Add all properties from nested context (except @version)
          Object.entries(nestedCtx).forEach(([key, value]) => {
            if (key !== "@version") {
              merged[key] = value;
            }
          });

          flatContexts.push(merged);
        } else {
          // Regular object context - keep as is
          flatContexts.push(ctx);
        }
      }
    }

    cleaned["@context"] = flatContexts;
  }

  // 2. Clean verificationMethod
  if (cleaned.verificationMethod && typeof cleaned.verificationMethod === "object") {
    const vm = cleaned.verificationMethod;

    // Use single context URL instead of array
    if (Array.isArray(vm["@context"])) {
      vm["@context"] = "https://w3id.org/security/v2";
    } else if (typeof vm["@context"] === "string" && vm["@context"].includes("jws-2020")) {
      vm["@context"] = "https://w3id.org/security/v2";
    }

    // Normalize type to Bls12381G2Key2020 for BBS+
    if (vm.type === "JsonWebKey2020") {
      vm.type = "Bls12381G2Key2020";
    }
  }

  // 3. Clean proof @context
  if (cleaned.proof) {
    const proofs = Array.isArray(cleaned.proof) ? cleaned.proof : [cleaned.proof];
    for (const p of proofs) {
      if (p && typeof p === "object") {
        p["@context"] = "https://w3id.org/security/bbs/v1";
      }
    }
  }

  return cleaned;
}

function deepCloneVcRawUntouched(vcRaw: any) {
  if (vcRaw == null) return vcRaw;

  // If stored as string, parse into object.
  if (typeof vcRaw === "string") {
    try {
      return JSON.parse(vcRaw);
    } catch (e) {
      throw new Error("Credential.vcRaw is a non-JSON string; cannot store as revealedDocument");
    }
  }

  // If stored as object, deep clone without changes
  return JSON.parse(JSON.stringify(vcRaw));
}

function mustGetDid(req: any): string {
  const s = getSession(req);
  const did = String(s?.did || "").trim();
  if (!did) throw new Error("Unauthenticated");
  return did;
}

function isOwnerOfApplication(sessionDid: string, app: any) {
  const did = sessionDid.trim();
  return did === String(app.seekerDid) || did === String(app.recruiterDid);
}

async function filterActiveSharedProofs(sharedProofs: any[]) {
  if (!sharedProofs?.length) return [];

  const vcIds = Array.from(new Set(sharedProofs.map((p: any) => String(p.vcId || "")).filter(Boolean)));
  if (!vcIds.length) return [];

  const activeCreds = await Credential.find({
    credentialId: { $in: vcIds },
    status: "active",
  })
    .select({ credentialId: 1 })
    .lean();

  const activeSet = new Set(activeCreds.map((c: any) => String(c.credentialId)));

  return sharedProofs.filter((p: any) => activeSet.has(String(p.vcId)));
}

/**
 * @openapi
 * /applications:
 *   post:
 *     summary: Create a job application (seeker -> recruiter)
 *     tags: [Applications]
 */
router.post('/', async (req, res) => {
  try {
    const s = getSession(req);
    if (!s?.did) return res.status(401).json({ error: "Unauthenticated" });

    const { jobId, recruiterDid, sharedVcIds } = req.body;

    // ✅ seekerDid must come from session, not body
    const seekerDid = String(s.did).trim();

    if (!jobId || !recruiterDid) {
      return res.status(400).json({ error: "jobId, recruiterDid required" });
    }

    // Prevent duplicate applications for the same seeker + job
    const existing = await Application.findOne({ jobId, seekerDid });
    if (existing) {
      return res.status(200).json({
        alreadyApplied: true,
        application: existing,
      });
    }

    const appDoc = await Application.create({
      jobId,
      seekerDid,
      recruiterDid,
      sharedVcIds: Array.isArray(sharedVcIds) ? sharedVcIds : [],
    });

    // VC-level sharing:
    // If seeker selected specific credentialIds, attach the FULL VCs (untouched)
    // into SharedProof so recruiter can verify them normally.
    const selectedIds: string[] = Array.isArray(sharedVcIds) ? sharedVcIds : [];
    if (selectedIds.length > 0) {
      // Security: ensure these credentials belong to the seeker
      const creds = await Credential.find({
        credentialId: { $in: selectedIds },
        subjectDid: seekerDid,
        status: "active",
      }).lean();

      const byId = new Map<string, any>();
      creds.forEach((c: any) => byId.set(c.credentialId, c));

      const validSelected = selectedIds.filter((id) => byId.has(id));

      if (validSelected.length > 0) {
        const bulkOps = validSelected.map((credId) => {
          const c: any = byId.get(credId);
          const vcObj = deepCloneVcRawUntouched(c?.vcRaw);

          return {
            updateOne: {
              filter: {
                applicationId: appDoc._id.toString(),
                vcId: credId,
              },
              update: {
                $set: {
                  applicationId: appDoc._id.toString(),
                  jobId,
                  vcId: credId,
                  seekerDid,
                  recruiterDid,
                  // No derived proof anymore:
                  derivedProof: null,
                  // Store full VC as "revealedDocument" for backward compatibility
                  revealedDocument: vcObj,
                  nonce: null,
                },
              },
              upsert: true,
            },
          };
        });

        await SharedProof.bulkWrite(bulkOps);

        await Application.findByIdAndUpdate(appDoc._id, {
          $set: { sharedVcIds: validSelected },
        });
      }
    }

    // Attach lightweight seeker profile snapshot for recruiter quick view
    try {
      const seeker = await Seeker.findOne({ did: seekerDid }).lean();
      if (seeker) {
        await Application.findByIdAndUpdate(appDoc._id, {
          $set: {
            seekerProfile: {
              name: seeker.name,
              email: seeker.email,
              homeLocation: seeker.homeLocation,
              skills: (seeker as any)?.profile?.skills ?? [],
              languages: (seeker as any)?.profile?.languages ?? [],
              resumeInfo: (seeker as any)?.profile?.resumeInfo ?? undefined,
            },
          },
        });
      }
    } catch (e) {
      console.warn("POST /applications failed to attach seeker snapshot", e);
    }

    res.status(201).json({
      ...appDoc.toObject(),
      sharedVcsAttached: Array.isArray(sharedVcIds) ? sharedVcIds.length : 0,
      alreadyApplied: false,
    });
  } catch (err: any) {
    console.error("POST /applications error:", err);
    return res.status(500).json({ error: "Failed to create application" });
  }
});

/**
 * @openapi
 * /applications/by-seeker:
 *   get:
 *     summary: List applications for a given seeker DID
 *     tags: [Applications]
 */
router.get('/by-seeker', async (req, res) => {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: "Unauthenticated" });

  const seekerDid = String(s.did).trim();
  if (!seekerDid) return res.status(401).json({ error: "Missing DID in session" });

  const sessionDid = String(s.did || "").trim();
  if (sessionDid && sessionDid !== seekerDid) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const list = await Application.find({ seekerDid }).sort({ createdAt: -1 }).lean();

  const jobIds = Array.from(new Set(list.map((app: any) => app.jobId)));
  const jobs = jobIds.length
    ? await Job.find({ _id: { $in: jobIds } }).lean()
    : [];
  const jobById = new Map<string, any>();
  jobs.forEach((j: any) => jobById.set(j._id.toString(), j));

  const mapped = list.map((app: any) => {
    const job = jobById.get(app.jobId);
    return {
      ...app,
      uiStatus: toUiStatus(app.status),
      job: job
        ? {
          id: job._id.toString(),
          title: job.title,
          company: job.company,
          location: job.location,
          workType: job.workType,
          salaryText: job.salaryText,
          postedAt: job.postedAt ?? job.createdAt,
        }
        : null,
    };
  });

  res.json(mapped);
});

/**
 * GET /applications/by-recruiter?recruiterDid=...
 */
router.get("/by-recruiter", async (req, res) => {
  try {
    const s = getSession(req);
    if (!s?.did) return res.status(401).json({ error: "Unauthenticated" });

    const recruiterDid = String(s.did).trim();
    if (req.query?.recruiterDid) {
      return res.status(400).json({ error: "Do not send recruiterDid. Session-only." });
    }

    const list = await Application.find({ recruiterDid })
      .sort({ createdAt: -1 })
      .lean();

    if (!list.length) {
      return res.json([]);
    }

    const jobIds = Array.from(new Set(list.map((a: any) => a.jobId)));
    const seekerDids = Array.from(new Set(list.map((a: any) => a.seekerDid)));

    const [jobs, seekers] = await Promise.all([
      jobIds.length
        ? Job.find({ _id: { $in: jobIds } }).lean()
        : [],
      seekerDids.length
        ? Seeker.find({ did: { $in: seekerDids } }).lean()
        : [],
    ]);

    const jobById = new Map<string, any>();
    jobs.forEach((j: any) => jobById.set(j._id.toString(), j));

    const seekerByDid = new Map<string, any>();
    seekers.forEach((s: any) => {
      if (s.did) seekerByDid.set(s.did, s);
    });

    const mapped = list.map((app: any) => {
      const job = jobById.get(app.jobId);
      const seeker = seekerByDid.get(app.seekerDid);

      return {
        ...app,
        uiStatus: toUiStatus(app.status),
        jobTitle: job?.title,
        job: job
          ? {
            id: job._id.toString(),
            title: job.title,
            company: job.company,
            location: job.location,
            workType: job.workType,
            salaryText: job.salaryText,
            postedAt: job.postedAt ?? job.createdAt,
          }
          : null,
        seeker: seeker
          ? {
            name: seeker.name,
            email: seeker.email,
            homeLocation: seeker.homeLocation,
          }
          : null,
      };
    });

    return res.json(mapped);
  } catch (err) {
    console.error("GET /applications/by-recruiter error:", err);
    return res.status(500).json({ error: "Failed to load applications" });
  }
});

/**
 * GET /applications/by-job?jobId=...
 */
router.get("/by-job", async (req, res) => {
  try {
    const sessionDid = mustGetDid(req);

    const jobId = String(req.query.jobId || "");
    if (!jobId) {
      return res.status(400).json({ error: "jobId required" });
    }

    const job = await Job.findById(jobId).lean();
    if (!job) return res.status(404).json({ error: "Job not found" });

    if (String((job as any).didOwner || "") !== sessionDid) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const apps = await Application.find({ jobId })
      .sort({ createdAt: -1 })
      .lean();

    if (!apps.length) {
      return res.json([]);
    }

    const applicationIds = apps.map((a: any) => a._id.toString());
    const seekerDids = Array.from(new Set(apps.map((a: any) => a.seekerDid)));

    const [seekers, sharedProofsRaw] = await Promise.all([
      seekerDids.length
        ? Seeker.find({ did: { $in: seekerDids } }).lean()
        : [],
      applicationIds.length
        ? SharedProof.find({ applicationId: { $in: applicationIds } }).lean()
        : [],
    ]);

    const sharedProofs = await filterActiveSharedProofs(sharedProofsRaw);

    const seekerByDid = new Map<string, any>();
    seekers.forEach((s: any) => {
      if (s.did) seekerByDid.set(s.did, s);
    });

    const proofsByApp = new Map<string, any[]>();
    sharedProofs.forEach((sp: any) => {
      const key = sp.applicationId;
      const list = proofsByApp.get(key) || [];
      list.push({
        vcId: sp.vcId,
        revealedDocument: sp.revealedDocument,
        isVcShared: true
      });
      proofsByApp.set(key, list);
    });

    const mapped = apps.map((app: any) => {
      const seeker = seekerByDid.get(app.seekerDid);
      return {
        ...app,
        uiStatus: toUiStatus(app.status),
        seeker: seeker
          ? {
            name: seeker.name,
            email: seeker.email,
            homeLocation: seeker.homeLocation,
          }
          : null,
        proofs: proofsByApp.get(app._id.toString()) || [],
      };
    });

    return res.json(mapped);
  } catch (err) {
    console.error("GET /applications/by-job error:", err);
    return res
      .status(500)
      .json({ error: "Failed to load applications for this job" });
  }
});

// GET /applications/:id
router.get("/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const sessionDid = mustGetDid(req);

    const app = await Application.findById(id).lean();
    if (!app) return res.status(404).json({ error: "Application not found" });

    if (!isOwnerOfApplication(sessionDid, app)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const recruiter = await Recruiter.findOne({ did: app.recruiterDid }).lean();
    const job = await Job.findById(app.jobId).lean();
    const seeker = await Seeker.findOne({ did: app.seekerDid }).lean();

    const proofsRaw = await SharedProof.find({
      applicationId: id.toString(),
    }).lean();

    const safeProofs = await filterActiveSharedProofs(proofsRaw);

    const recruiterKyc = (recruiter as any)?.kycStatus;
    const recruiterBadgeVerified = Boolean((recruiter as any)?.badge?.verified);

    let derivedTrustStatus: "Active" | "Suspended" | "Revoked" | "None";
    let derivedVerified = false;

    if (recruiterKyc === "rejected") {
      derivedTrustStatus = "Revoked";
      derivedVerified = false;
    } else if (recruiterKyc === "pending") {
      derivedTrustStatus = "Suspended";
      derivedVerified = false;
    } else if (recruiterBadgeVerified) {
      derivedTrustStatus = "Active";
      derivedVerified = true;
    } else {
      derivedTrustStatus = (job as any)?.trustStatus ?? "None";
      derivedVerified = Boolean((job as any)?.verified);
    }

    const appWithProofs: any = {
      ...app,
      uiStatus: toUiStatus((app as any).status),
      job: job
        ? {
          id: job._id.toString(),
          title: job.title,
          company: job.company,
          location: job.location,
          workType: (job as any).workType,
          salaryText: (job as any).salaryText,
          postedAt: (job as any).postedAt ?? job.createdAt,
          didOwner: (job as any).didOwner,
          verified: derivedVerified,
          trustStatus: derivedTrustStatus,
          onChainRef: (job as any).onChainRef,
          vcStatusMeta: (job as any).vcStatusMeta
            ? {
              issuer: (job as any).vcStatusMeta.issuer,
              network: (job as any).vcStatusMeta.network,
            }
            : undefined,
        }
        : null,
      seeker: seeker
        ? {
          name: (seeker as any).name,
          email: (seeker as any).email,
          homeLocation: (seeker as any).homeLocation,
        }
        : null,
    };

    if (safeProofs.length > 0) {
      appWithProofs.proofs = safeProofs.map((p: any) => ({
        vcId: p.vcId,
        revealedDocument: p.revealedDocument,
        isVcShared: true
      }));
    }

    return res.json(appWithProofs);
  } catch (e) {
    console.error("GET /applications/:id error", e);
    return res.status(500).json({ error: "Failed to load application" });
  }
});

// PATCH /applications/:id/status
router.patch("/:id/status", async (req, res) => {
  try {
    const sessionDid = mustGetDid(req);

    const { id } = req.params;
    const { status, interview } = req.body as {
      status?: "submitted" | "withdrawn" | "shortlisted" | "rejected" | "hired";
      interview?: any;
    };

    if (!status) return res.status(400).json({ error: "status required" });

    const app = await Application.findById(id);
    if (!app) return res.status(404).json({ error: "Application not found" });

    if (String(app.recruiterDid) !== sessionDid) {
      return res.status(403).json({ error: "Forbidden" });
    }

    app.status = status;
    if (interview) {
      app.interview = interview;
    }

    await app.save();
    return res.json({ ok: true, application: { ...app.toObject(), uiStatus: toUiStatus(status) } });
  } catch (err) {
    console.error("PATCH /applications/:id/status error:", err);
    return res.status(500).json({ error: "Failed to update application status" });
  }
});

// PATCH /applications/:id/shared-vcs
router.patch("/:id/shared-vcs", async (req, res) => {
  try {
    const sessionDid = mustGetDid(req);

    const { id } = req.params;
    const { sharedVcIds } = req.body as { sharedVcIds?: string[] };

    const app = await Application.findById(id);
    if (!app) return res.status(404).json({ error: "Application not found" });

    if (String(app.seekerDid) !== sessionDid) {
      return res.status(403).json({ error: "Forbidden" });
    }

    // Optional: only allow while submitted
    if (app.status !== "submitted") {
      return res.status(409).json({ error: "Cannot edit shared VCs after review begins" });
    }

    const requested: string[] = Array.isArray(sharedVcIds) ? sharedVcIds : [];

    // 1) Filter to only VCs that belong to seeker + are active
    const creds = await Credential.find({
      credentialId: { $in: requested },
      subjectDid: app.seekerDid,
      status: "active",
    }).lean();

    const byId = new Map<string, any>();
    creds.forEach((c: any) => byId.set(c.credentialId, c));
    const validSelected = requested.filter((vcId) => byId.has(vcId));

    // 2) Delete proofs that are no longer selected
    await SharedProof.deleteMany({
      applicationId: app._id.toString(),
      vcId: { $nin: validSelected },
    });

    // 3) Upsert proofs for newly selected ids
    if (validSelected.length > 0) {
      const bulkOps = validSelected.map((credId) => {
        const c: any = byId.get(credId);
        const vcObj = deepCloneVcRawUntouched(c?.vcRaw);

        return {
          updateOne: {
            filter: { applicationId: app._id.toString(), vcId: credId },
            update: {
              $set: {
                applicationId: app._id.toString(),
                jobId: app.jobId,
                vcId: credId,
                seekerDid: app.seekerDid,
                recruiterDid: app.recruiterDid,
                derivedProof: null,
                nonce: null,
                revealedDocument: vcObj,
              },
            },
            upsert: true,
          },
        };
      });

      await SharedProof.bulkWrite(bulkOps);
    }

    // 4) Save canonical ids
    app.sharedVcIds = validSelected;
    await app.save();

    return res.json({ ok: true, sharedVcIds: validSelected });
  } catch (err) {
    console.error("PATCH /applications/:id/shared-vcs error:", err);
    return res.status(500).json({ error: "Failed to update shared VCs" });
  }
});

export default router;

function toUiStatus(status: string) {
  if (status === "rejected") return "rejected";
  if (status === "shortlisted" || status === "hired") return "accepted";
  return "waiting";
}