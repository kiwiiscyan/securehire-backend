// src/routes/jobs.ts
import { Router, type Request, type Response } from "express";
import Job, { IJob } from "../models/Jobs";
import Recruiter, { IRecruiter } from "../models/Recruiter";
import { getRecruiterTrustStatusFromChain } from "../services/chain.service";

const router = Router();

/**
 * Transform Mongo Job document -> frontend Job shape
 */
function toJobDTO(doc: IJob) {
  return {
    id: doc._id.toString(),
    title: doc.title,
    company: doc.company,
    location: doc.location,
    description: doc.description,
    tags: doc.tags,
    category: doc.category,
    didOwner: doc.didOwner,
    verified: doc.verified,
    trustStatus: doc.trustStatus ?? "None",
    postedAt: (doc.postedAt ?? doc.createdAt ?? new Date()).toISOString(),
    workType: doc.workType,
    salaryText: doc.salaryText,

    summary: doc.summary,
    purpose: doc.purpose,
    responsibilities: doc.responsibilities,
    interpersonal: doc.interpersonal,
    skills: doc.skills,
    qualifications: doc.qualifications,
    companyProfile: doc.companyProfile,
    feedback: doc.feedback,

    onChainRef: doc.onChainRef,
    vcStatusMeta: doc.vcStatusMeta,
    status: doc.status,
  };
}

type JobDTO = ReturnType<typeof toJobDTO>;

/** Helpers to match your React filter behaviour **/

function matchesKeyword(job: JobDTO, q: string): boolean {
  const n = q.toLowerCase();
  return (
    job.title.toLowerCase().includes(n) ||
    job.company.toLowerCase().includes(n) ||
    (job.description || "").toLowerCase().includes(n) ||
    (job.summary || "").toLowerCase().includes(n) ||
    (job.tags || []).some((t) => t.toLowerCase().includes(n))
  );
}

function matchesLocation(job: JobDTO, where: string): boolean {
  const n = where.toLowerCase();
  return (job.location || "").toLowerCase().includes(n);
}

type RemoteMode = "onsite" | "hybrid" | "remote";

function inferRemoteMode(job: JobDTO): RemoteMode {
  const loc = (job.location || "").toLowerCase();
  if (loc.includes("remote")) return "remote";
  if (loc.includes("hybrid")) return "hybrid";
  return "onsite";
}

function parseSalaryRange(text?: string): { min?: number; max?: number } {
  if (!text) return {};
  const normalized = text.toLowerCase().replace(/rm/gi, "").replace(/\s/g, "");
  const parts = normalized.split(/[-–]/);

  const parsePart = (part?: string) => {
    if (!part) return undefined;
    const match = part.match(/(\d+(\.\d+)?)(k)?/);
    if (!match) return undefined;
    let n = parseFloat(match[1]);
    // "6k" or small numbers like 3.5 -> treat as thousands
    if (match[3] || n <= 200) n *= 1000;
    return Math.round(n);
  };

  const min = parsePart(parts[0]);
  const max = parsePart(parts[1]);
  return { min, max };
}

async function computeTrustStatusForJob(didOwner: string) {
  // Option A: use chain directly
  if (process.env.TRUST_BADGE_REGISTRY_ADDR) {
    return await getRecruiterTrustStatusFromChain(didOwner);
  }

  // Option B: fallback to DB only
  const recruiter = await Recruiter.findOne({ did: didOwner });
  if (recruiter?.badge?.verified) return "Active";
  return "None";
}

async function attachRecruiterMeta(docs: IJob[]): Promise<JobDTO[]> {
  // collect all DIDs from jobs
  const dids = Array.from(
    new Set(
      docs
        .map((d) => d.didOwner)
        .filter((d): d is string => typeof d === "string" && d.trim().length > 0)
    )
  );

  let recruitersByDid = new Map<string, IRecruiter>();
  if (dids.length) {
    const recruiters = await Recruiter.find({ did: { $in: dids } });
    recruiters.forEach((r) => recruitersByDid.set(r.did, r));
  }

  return docs.map((doc) => {
    const rec = doc.didOwner ? recruitersByDid.get(doc.didOwner) : undefined;

    if (rec) {
      const kyc = rec.kycStatus ?? "none";
      const badgeVerified = rec.badge?.verified ?? false;

      if (kyc === "approved" && badgeVerified) {
        doc.verified = true;
        doc.trustStatus = "Active";
      } else if (kyc === "pending") {
        doc.verified = false;
        doc.trustStatus = "Suspended";
      } else if (kyc === "rejected") {
        doc.verified = false;
        doc.trustStatus = "Revoked";
      } else {
        doc.verified = false;
        doc.trustStatus = "None";
      }
    }

    return toJobDTO(doc);
  });
}

/**
 * @openapi
 * /jobs:
 *   get:
 *     summary: List published jobs (with filters)
 *     tags:
 *       - Jobs
 *     parameters:
 *       - in: query
 *         name: q
 *         schema:
 *           type: string
 *         description: Keyword search (title, company, description, tags).
 *       - in: query
 *         name: where
 *         schema:
 *           type: string
 *         description: Location substring (city, country, or "remote").
 *       - in: query
 *         name: class
 *         schema:
 *           type: string
 *         description: CSV of classifications (e.g. "it,sales").
 *       - in: query
 *         name: work
 *         schema:
 *           type: string
 *         description: CSV of workTypes (fulltime,parttime,contract,casual).
 *       - in: query
 *         name: remote
 *         schema:
 *           type: string
 *         description: CSV of remote modes (onsite,hybrid,remote).
 *       - in: query
 *         name: payUnit
 *         schema:
 *           type: string
 *           enum:
 *             - annual
 *             - monthly
 *             - hourly
 *       - in: query
 *         name: payMin
 *         schema:
 *           type: number
 *       - in: query
 *         name: payMax
 *         schema:
 *           type: number
 *       - in: query
 *         name: time
 *         schema:
 *           type: string
 *           enum:
 *             - any
 *             - today
 *             - 3d
 *             - 7d
 *             - 14d
 *             - 30d
 *       - in: query
 *         name: verifiedOnly
 *         schema:
 *           type: string
 *         description: 'Set to "true" to return only verified recruiters.'
 *       - in: query
 *         name: trust
 *         schema:
 *           type: string
 *         description: CSV of trust statuses (active,suspended,revoked).
 *     responses:
 *       200:
 *         description: List of jobs
 */
router.get("/", async (req, res) => {
  try {
    const {
      q,
      where,
      class: classParam,
      work,
      time,
      remote,
      payUnit,
      payMin,
      payMax,
      verifiedOnly,
      trust,
      didOwner,
      status,
    } = req.query as {
      q?: string;
      where?: string;
      class?: string;
      work?: string;
      time?: string;
      remote?: string;
      payUnit?: string;
      payMin?: string;
      payMax?: string;
      verifiedOnly?: string;
      trust?: string;
      didOwner?: string;
      status?: string;
    };

    const filter: any = {};
    // default: seekers see only published jobs
    if (!status || status === "published") {
      filter.status = "published";
    } else if (status === "draft" || status === "closed") {
      filter.status = status;
    } else if (status === "any" || status === "all") {
      // no status filter – recruiter dashboard can see all
    }

    // --- DB-level filters (cheap to push into Mongo) ---

    // classification -> category
    if (classParam) {
      const categories = classParam
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      if (categories.length) {
        filter.category = { $in: categories };
      }
    }

    // work type
    if (work) {
      const workTypes = work
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      if (workTypes.length) {
        filter.workType = { $in: workTypes };
      }
    }

    // listing time
    if (time && time !== "any") {
      const now = Date.now();
      const days =
        time === "today"
          ? 1
          : time === "3d"
            ? 3
            : time === "7d"
              ? 7
              : time === "14d"
                ? 14
                : 30;
      const sinceDate = new Date(now - days * 86400000);
      filter.createdAt = { $gte: sinceDate };
    }

    // verified-only
    if (verifiedOnly === "true") {
      filter.verified = true;
    }

    // trust status
    if (trust) {
      const raw = trust
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (raw.length) {
        const normalized = raw.map(
          (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
        );
        filter.trustStatus = { $in: normalized };
      }
    }

    if (didOwner && didOwner.trim()) {
      filter.didOwner = didOwner.trim();
    }

    // Query DB once with basic filters
    const docs = await Job.find(filter).sort({ createdAt: -1 });
    let jobs: JobDTO[] = await attachRecruiterMeta(docs);

    // --- In-memory filters (to match React behaviour exactly) ---

    // keyword search
    if (q && q.trim()) {
      const needle = q.trim().toLowerCase();
      jobs = jobs.filter((j) => matchesKeyword(j, needle));
    }

    // location / where
    if (where && where.trim()) {
      const needle = where.trim().toLowerCase();
      jobs = jobs.filter((j) => matchesLocation(j, needle));
    }

    // remote modes (onsite / hybrid / remote)
    if (remote) {
      const modes = remote
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean) as RemoteMode[];
      if (modes.length) {
        const allowed = new Set<RemoteMode>(modes);
        jobs = jobs.filter((j) => allowed.has(inferRemoteMode(j)));
      }
    }

    // pay range (approximate from salaryText)
    const min = payMin ? Number(payMin) : undefined;
    const max = payMax ? Number(payMax) : undefined;
    const hasPayFilter =
      (min != null && !Number.isNaN(min)) ||
      (max != null && !Number.isNaN(max));

    if (hasPayFilter) {
      jobs = jobs.filter((j) => {
        const { min: jMin, max: jMax } = parseSalaryRange(j.salaryText);
        // if we can't parse salary, keep the job (same as frontend)
        if (jMin == null && jMax == null) return true;

        const fMin = min;
        const fMax = max && max > 0 ? max : undefined;

        if (fMin != null && jMax != null && jMax < fMin) return false;
        if (fMax != null && jMin != null && jMin > fMax) return false;
        return true;
      });
    }

    res.json(jobs);
  } catch (err: any) {
    console.error("GET /jobs error", err);
    res.status(500).json({ error: "Failed to list jobs" });
  }
});

/**
 * @openapi
 * /jobs:
 *   post:
 *     summary: Create a new job (dev seeding endpoint)
 *     tags:
 *       - Jobs
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               title:
 *                 type: string
 *               company:
 *                 type: string
 *               location:
 *                 type: string
 *               description:
 *                 type: string
 *               tags:
 *                 type: array
 *                 items:
 *                   type: string
 *               category:
 *                 type: string
 *               didOwner:
 *                 type: string
 *               verified:
 *                 type: boolean
 *               trustStatus:
 *                 type: string
 *               postedAt:
 *                 type: string
 *                 format: date-time
 *               workType:
 *                 type: string
 *               salaryText:
 *                 type: string
 *     responses:
 *       201:
 *         description: Job created
 */
router.post("/", async (req, res) => {
  try {
    const {
      title,
      company,
      location,
      description,
      tags,
      category,
      verified,
      postedAt,
      workType,
      salaryText,
      summary,
      purpose,
      responsibilities,
      interpersonal,
      skills,
      qualifications,
      companyProfile,
      feedback,
      onChainRef,
      vcStatusMeta,
      status,
    } = req.body;

    if (!title || !company || !location || !description || !category) {
      return res.status(400).json({
        error: "title, company, location, description, category are required",
      });
    }

    const didOwner = req.body.didOwner as string; // for now – later infer from recruiter auth
    if (!didOwner) {
      return res.status(400).json({ error: "didOwner (recruiter DID) required" });
    }

    const trustStatus = await computeTrustStatusForJob(didOwner);

    const doc = await Job.create({
      title,
      company,
      location,
      description,
      tags: tags ?? [],
      category,
      didOwner,
      verified,
      trustStatus,
      postedAt: postedAt ? new Date(postedAt) : undefined,
      workType,
      salaryText,
      summary,
      purpose,
      responsibilities,
      interpersonal,
      skills,
      qualifications,
      companyProfile,
      feedback,
      onChainRef,
      vcStatusMeta,
      status: status ?? "published",
    });

    res.status(201).json(toJobDTO(doc));
  } catch (err: any) {
    console.error("POST /jobs error", err);
    res.status(500).json({ error: "Failed to create job" });
  }
});

// GET /jobs/:id - optional helper (nice for debugging / future detail pages)
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const job = await Job.findById(id);
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }
    return res.json(toJobDTO(job));
  } catch (err) {
    console.error("GET /jobs/:id error:", err);
    return res.status(500).json({ error: "Failed to fetch job" });
  }
});

/**
 * PUT /jobs/:id
 * Full update of a job document.
 * Used by recruiter Job Management page when editing a job.
 */
router.put("/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const {
      title,
      company,
      location,
      description,
      tags,
      category,
      didOwner,
      verified,
      trustStatus,
      postedAt,
      workType,
      salaryText,
      summary,
      purpose,
      responsibilities,
      interpersonal,
      skills,
      qualifications,
      companyProfile,
      feedback,
      onChainRef,
      vcStatusMeta,
      status,
    } = req.body;

    // same basic validation as POST
    if (!title || !company || !location || !description || !category) {
      return res.status(400).json({
        error: "Missing required fields (title, company, location, description, category)",
      });
    }

    const job = await Job.findById(id);
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    job.title = title;
    job.company = company;
    job.location = location;
    job.description = description;
    job.tags = tags ?? [];
    job.category = category;

    // In a real system you'd infer didOwner from auth; for now we allow body override.
    if (typeof didOwner === "string") {
      job.didOwner = didOwner;
    }

    if (typeof verified === "boolean") {
      job.verified = verified;
    }
    if (trustStatus) {
      job.trustStatus = trustStatus;
    }

    job.postedAt = postedAt ? new Date(postedAt) : job.postedAt;

    job.workType = workType;
    job.salaryText = salaryText;
    job.summary = summary;
    job.purpose = purpose;
    job.responsibilities = Array.isArray(responsibilities)
      ? responsibilities
      : job.responsibilities;
    job.interpersonal = Array.isArray(interpersonal)
      ? interpersonal
      : job.interpersonal;
    job.skills = Array.isArray(skills) ? skills : job.skills;
    job.qualifications = Array.isArray(qualifications)
      ? qualifications
      : job.qualifications;
    job.companyProfile = companyProfile ?? job.companyProfile;
    job.feedback = feedback ?? job.feedback;
    job.onChainRef = onChainRef ?? job.onChainRef;
    job.vcStatusMeta = vcStatusMeta ?? job.vcStatusMeta;

    if (status) {
      job.status = status;
    }

    await job.save();
    return res.json(toJobDTO(job));
  } catch (err) {
    console.error("PUT /jobs/:id error:", err);
    return res.status(500).json({ error: "Failed to update job" });
  }
});

/**
 * PATCH /jobs/:id
 * Lightweight partial update (used mainly for closing a job).
 */
router.patch("/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status } = req.body as { status?: string };

    const job = await Job.findById(id);
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    if (status) {
      job.status = status as any;
    }

    await job.save();
    return res.json(toJobDTO(job));
  } catch (err) {
    console.error("PATCH /jobs/:id error:", err);
    return res.status(500).json({ error: "Failed to patch job" });
  }
});


export default router;