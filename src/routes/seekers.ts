// src/routes/seekers.ts
import { Router, Request, Response } from "express";
import Seeker, { ISeeker } from "../models/Seeker";
import Issuer from "../models/Issuer";
import mongoose from "mongoose";
import Credential from "../models/Credential";
import { registerDidOnChain } from "../services/did-registry.service";
import crypto from "crypto";

const router = Router();

// Simple normaliser: lowercase + trim
const norm = (s?: string | null) =>
  (s || "").trim().toLowerCase();

/**
 * Try to resolve an issuerDid from an organisation name & issuer type.
 * orgType:
 *  - "career" -> company
 *  - "education" -> university
 *  - "certification" -> certBody
 */
async function resolveIssuerDidFromOrg(
  orgNameRaw: string,
  section: "career" | "education" | "certification"
): Promise<string | null> {
  const orgName = norm(orgNameRaw);
  if (!orgName) return null;

  let orgType: "company" | "university" | "certBody" | undefined;
  if (section === "career") orgType = "company";
  if (section === "education") orgType = "university";
  if (section === "certification") orgType = "certBody";

  const filter: any = {};
  if (orgType) filter.orgType = orgType;

  // Basic match by orgName (normalised)
  filter.orgName = new RegExp(`^${orgName}$`, "i");

  const issuer = await Issuer.findOne(filter).lean();
  return issuer?.did || null;
}

/* DTO helper */
function toSeekerDTO(doc: ISeeker | any) {
  const pending = (doc.pendingVcRequests ?? []).map((r: any) => ({
    id: r.id,
    section: r.section,
    title: r.title,
    issuerDid: r.issuerDid,
    status: r.status ?? "pending",
    issuedAt: r.issuedAt ?? undefined,
  }));

  const issued = (doc.vcs ?? []).map((v: any) => ({
    id: v.id || v.credentialId,
    section: v.section,
    title: v.title,
    issuerDid: v.issuerDid,
    status: v.status ?? "active",
    issuedAt: v.issuedAt ?? undefined,
    credentialId: v.credentialId,
  }));

  const verifiedCredentials = [...pending, ...issued];

  return {
    id: doc._id.toString(),
    email: doc.email,
    name: doc.name,
    phone: doc.phone,
    did: doc.did,
    onboarded: doc.onboarded,
    homeLocation: doc.homeLocation,
    classification: doc.classification,
    subClass: doc.subClass,
    visibility: doc.visibility ?? "hidden",
    vcOnly: doc.vcOnly,
    consentShareVC: doc.consentShareVC,
    antiPhishAck: doc.antiPhishAck,
    profile: doc.profile ?? {},
    verifiedCredentials,
    defaultSharedVcIds: doc.defaultSharedVcIds ?? [],
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * @openapi
 * tags:
 *   - name: Seekers
 *     description: Job seeker identity, DID, and profile
 */

/**
 * @openapi
 * /seekers/onboard:
 *   post:
 *     summary: Create or update a seeker once onboarding completes
 *     tags: [Seekers]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, name]
 *             properties:
 *               email: { type: string }
 *               name: { type: string }
 *               did: { type: string }
 *               homeLocation: { type: string }
 *               classification: { type: string }
 *               subClass: { type: string }
 *               visibility:
 *                 type: string
 *                 enum: [public, standard, limited, hidden]
 *               vcOnly: { type: boolean }
 *               consentShareVC: { type: boolean }
 *               antiPhishAck: { type: boolean }
 *               careerSeed:
 *                 type: object
 *                 properties:
 *                   title: { type: string }
 *                   company: { type: string }
 *                   startMonth: { type: string }
 *                   startYear: { type: string }
 *                   endMonth: { type: string }
 *                   endYear: { type: string }
 *                   stillInRole: { type: boolean }
 *     responses:
 *       200:
 *         description: Upserted seeker
 */
router.post("/onboard", async (req, res) => {
  try {
    const {
      email,
      name,
      did,
      homeLocation,
      classification,
      subClass,
      visibility,
      vcOnly,
      consentShareVC,
      antiPhishAck,
      careerSeed,
      onboarded,
    } = req.body;

    if (!email || !name) {
      return res.status(400).json({ error: "email and name are required" });
    }

    // STEP 1 — Find seeker by DID (preferred) or email
    let doc: ISeeker | null = null;

    const criteria: any[] = [];
    if (did) criteria.push({ did });
    if (email) criteria.push({ email });

    if (criteria.length === 0) {
      return res.status(400).json({ error: "email or did required" });
    }

    if (criteria.length === 1) {
      doc = await Seeker.findOne(criteria[0]);
    } else {
      doc = await Seeker.findOne({ $or: criteria });
    }

    // STEP 2 — If seeker does not exist → create one
    if (!doc) {
      doc = new Seeker({
        email,
        name,
        // allow caller to decide onboarding state, default false
        onboarded: !!onboarded,
      });
    }

    // STEP 3 — Only assign DID if:
    // - DID provided AND
    // - seeker does NOT already have a DID
    if (did && !doc.did) {
      doc.did = did;

      // Register DID on blockchain for decentralization
      try {
        // Extract wallet address from did:pkh format (e.g., did:pkh:eip155:80002:0x...)
        const addressMatch = did.match(/0x[a-fA-F0-9]{40}/);
        if (addressMatch && process.env.DID_REGISTRY_ADDRESS) {
          const walletAddress = addressMatch[0];
          // Create a hash of the DID document for on-chain storage
          const didDocHash = crypto.createHash('sha256').update(did).digest('hex');
          const txHash = await registerDidOnChain(walletAddress, did, `0x${didDocHash}`);
          console.log(`[seekers/onboard] DID registered on blockchain: ${did}, tx: ${txHash}`);
          // Store transaction hash for verification
          (doc as any).didRegistrationTxHash = txHash;
        }
      } catch (blockchainErr: any) {
        // Log but don't fail onboarding if blockchain registration fails
        console.error("[seekers/onboard] Failed to register DID on blockchain:", blockchainErr.message);
      }
    }

    // STEP 4 — Update other non-unique fields
    doc.name = name;

    // "once true, always true" – a false from client won't downgrade it
    if (typeof onboarded === "boolean") {
      doc.onboarded = doc.onboarded || onboarded;
    }
    doc.homeLocation = homeLocation;
    doc.classification = classification;
    doc.subClass = subClass;
    doc.visibility = visibility;
    doc.vcOnly = vcOnly;
    doc.consentShareVC = consentShareVC;
    doc.antiPhishAck = antiPhishAck;

    // STEP 5 — If new career seed provided
    if (careerSeed?.title || careerSeed?.company) {
      doc.profile = { careerHistory: [careerSeed] };
    }

    await doc.save();
    return res.json(toSeekerDTO(doc));
  } catch (err: any) {
    console.error("POST /seekers/onboard error:", err);

    // Handle duplicate DID cleanly
    if (err.code === 11000 && err.keyPattern?.did) {
      return res.status(409).json({
        error: "DID already exists. Please regenerate a new DID.",
      });
    }

    return res.status(500).json({ error: "Failed to onboard seeker" });
  }
});

/**
 * @openapi
 * /seekers/profile:
 *   patch:
 *     summary: Patch the seeker's full profile object
 *     tags: [Seekers]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               did: { type: string }
 *               email: { type: string }
 *               profile: { type: object }
 *     responses:
 *       200:
 *         description: Updated seeker profile
 *       404:
 *         description: Seeker not found
 */
router.patch("/profile", async (req, res) => {
  try {
    const { did, email, profile } = req.body;
    if (!did && !email)
      return res.status(400).json({ error: "did or email required" });

    const criteria = did ? { did } : { email };

    const doc = await Seeker.findOne(criteria);
    if (!doc) return res.status(404).json({ error: "Seeker not found" });

    doc.profile = {
      ...(doc.profile ?? {}),
      ...(profile ?? {}),
    };

    if (profile?.visibility) doc.visibility = profile.visibility;
    if (profile?.location) doc.homeLocation = profile.location;

    await doc.save();
    return res.json(toSeekerDTO(doc));
  } catch (err) {
    console.error("PATCH /seekers/profile error:", err);
    return res.status(500).json({ error: "Failed to update profile" });
  }
});

/**
 * @openapi
 * /seekers/profile/section:
 *   post:
 *     summary: Upsert a profile section and optionally create a pending VC request
 *     tags: [Seeker]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [section, value]
 *             properties:
 *               did:
 *                 type: string
 *                 description: Seeker DID (preferred)
 *               email:
 *                 type: string
 *                 description: Seeker email (fallback)
 *               section:
 *                 type: string
 *                 enum: [career, education, certs]
 *               mode:
 *                 type: string
 *                 enum: [add, edit]
 *                 description: how the section is being edited
 *               value:
 *                 type: object
 *                 description: raw section payload from ProfileEditModal
 *               requestVc:
 *                 type: boolean
 *                 description: if true, create a pendingVcRequests entry
 */
router.post("/profile/section", async (req, res) => {
  try {
    const {
      did,
      email,
      section,
      mode,
      value,
      requestVc,
    } = req.body as {
      did?: string;
      email?: string;
      section: "career" | "education" | "certs";
      mode?: "add" | "edit";
      value: any;
      requestVc?: boolean;
    };

    if (!section || !value) {
      return res.status(400).json({ error: "section and value are required" });
    }

    if (!did && !email) {
      return res.status(400).json({ error: "did or email is required" });
    }

    const seeker = await Seeker.findOne(
      did ? { did } : { email: String(email).toLowerCase() }
    );

    if (!seeker) {
      return res.status(404).json({ error: "Seeker not found" });
    }

    // --- 1) Update profile array for the section ---
    const profile = seeker.profile || {};

    if (section === "career") {
      const arr = Array.isArray(profile.careerHistory)
        ? profile.careerHistory
        : [];
      if (mode === "edit" && typeof value._index === "number") {
        arr[value._index] = value;
      } else {
        arr.push(value);
      }
      profile.careerHistory = arr;
    }

    if (section === "education") {
      const arr = Array.isArray(profile.education) ? profile.education : [];
      if (mode === "edit" && typeof value._index === "number") {
        arr[value._index] = value;
      } else {
        arr.push(value);
      }
      profile.education = arr;
    }

    if (section === "certs") {
      const arr = Array.isArray(profile.certifications)
        ? profile.certifications
        : [];
      if (mode === "edit" && typeof value._index === "number") {
        arr[value._index] = value;
      } else {
        arr.push(value);
      }
      profile.certifications = arr;
    }

    seeker.profile = profile;

    // --- 2) Optionally create pending VC request ---
    let createdRequest: any | null = null;

    if (requestVc) {
      let orgName: string | undefined;

      if (section === "career") {
        orgName = value.company;
      } else if (section === "education") {
        orgName = value.institution;
      } else if (section === "certs") {
        orgName = value.organisation || value.issuingOrg || value.name;
      }

      const issuerDid = orgName
        ? await resolveIssuerDidFromOrg(orgName, section === "certs" ? "certification" : section)
        : null;

      if (!issuerDid) {
        // You may still want to let seeker save the record,
        // but inform them that VC cannot be requested yet
        // (no matching issuer)
        // Here we'll just skip creating a request.
        console.warn("No issuer found for org:", orgName);
      } else {
        const requestId = new mongoose.Types.ObjectId().toString();

        const title =
          section === "career"
            ? `${value.title || "Role"} at ${orgName}`
            : section === "education"
              ? `${value.qualification || "Study"} at ${orgName}`
              : `${value.name || "Certification"} (${orgName})`;

        const pendingList = Array.isArray(seeker.pendingVcRequests)
          ? seeker.pendingVcRequests
          : [];

        const requestEntry = {
          id: requestId,
          section:
            section === "certs" ? "certification" : section, // normalise to match issuer routes
          title,
          issuerDid,
          status: "pending",
          requestedAt: new Date().toISOString(),
          sectionPayload: value,
        };

        pendingList.push(requestEntry);
        seeker.pendingVcRequests = pendingList;
        createdRequest = requestEntry;
      }
    }

    await seeker.save();

    return res.json({
      ok: true,
      seekerId: seeker._id.toString(),
      updatedProfile: seeker.profile,
      createdRequest,
    });
  } catch (err) {
    console.error("POST /seekers/profile/section error:", err);
    return res.status(500).json({ error: "Failed to update profile section" });
  }
});

/**
 * @openapi
 * /seekers/profile/section/{section}:
 *   patch:
 *     summary: Patch a single profile section
 *     tags: [Seekers]
 *     parameters:
 *       - in: path
 *         name: section
 *         required: true
 *         schema:
 *           type: string
 *           enum: [personal, summary, career, education, certs, skills, languages, resume, visibility]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               did: { type: string }
 *               email: { type: string }
 *               value: { type: object }
 *     responses:
 *       200:
 *         description: Updated section
 *       404:
 *         description: Seeker not found
 */
router.patch("/profile/section/:section", async (req, res) => {
  try {
    const { did, email, value } = req.body;
    const section = req.params.section;

    if (!did && !email)
      return res.status(400).json({ error: "did or email required" });
    if (!value) return res.status(400).json({ error: "value required" });

    const criteria = did ? { did } : { email };

    const doc = await Seeker.findOne(criteria);
    if (!doc) return res.status(404).json({ error: "Seeker not found" });

    const profile = doc.profile ?? {};

    switch (section) {
      case "personal":
        if (value.name) doc.name = value.name;
        if (value.homeLocation) {
          doc.homeLocation = value.homeLocation;
          profile.location = value.homeLocation;
        }
        if (value.phone !== undefined) doc.phone = value.phone;
        break;

      case "summary":
        profile.summary = value.summary ?? "";
        break;

      case "career":
        profile.careerHistory = [...(profile.careerHistory ?? []), value];
        break;

      case "education":
        profile.education = [...(profile.education ?? []), value];
        break;

      case "certs":
        profile.certifications = [...(profile.certifications ?? []), value];
        break;

      case "skills":
        profile.skills = value.skills ?? [];
        break;

      case "languages":
        profile.languages = [...(profile.languages ?? []), value.language];
        break;

      case "resume":
        profile.resumeInfo = value.resumeInfo ?? "";
        break;

      case "visibility":
        profile.visibility = value.visibility;
        doc.visibility = value.visibility;
        break;

      default:
        return res.status(400).json({ error: `Unknown section: ${section}` });
    }

    doc.profile = profile;
    await doc.save();

    return res.json(toSeekerDTO(doc));
  } catch (err) {
    console.error("PATCH /seekers/profile/section error:", err);
    return res.status(500).json({ error: "Failed to update profile section" });
  }
});

/**
 * @openapi
 * /seekers/vcs/request:
 *   post:
 *     summary: Store a pending VC request
 *     tags: [Seekers]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [section, title, issuerDid]
 *             properties:
 *               did: { type: string }
 *               email: { type: string }
 *               section:
 *                 type: string
 *                 enum: [career, education, certification]
 *               title: { type: string }
 *               issuerDid: { type: string }
 *     responses:
 *       200:
 *         description: Stored pending VC request
 *       404:
 *         description: Seeker not found
 */
router.post("/vcs/request", async (req, res) => {
  try {
    const { did, email, section, title, issuerDid } = req.body;

    if (!did && !email)
      return res.status(400).json({ error: "did or email required" });
    if (!section || !title || !issuerDid)
      return res.status(400).json({
        error: "section, title, issuerDid required",
      });

    const criteria = did ? { did } : { email };

    const doc = await Seeker.findOne(criteria);
    if (!doc) return res.status(404).json({ error: "Seeker not found" });

    const newReq = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      section,
      title,
      issuerDid,
      status: "pending",
      requestedAt: new Date().toISOString(),
    };

    doc.pendingVcRequests = [...(doc.pendingVcRequests ?? []), newReq];
    await doc.save();

    return res.json({ ok: true, request: newReq });
  } catch (err) {
    console.error("POST /seekers/vcs/request error:", err);
    return res.status(500).json({ error: "Failed to store VC request" });
  }
});

// GET /seekers/vcs/share-default?did=... or ?email=...
router.get("/vcs/share-default", async (req, res) => {
  try {
    let { did, email } = req.query as { did?: string; email?: string };

    if (!did && !email) return res.status(400).json({ error: "did or email required" });

    const filter: any = {};
    if (did) filter.did = String(did).trim();
    if (email) filter.email = String(email).trim().toLowerCase();

    const doc = await Seeker.findOne(filter).lean();
    if (!doc) return res.status(404).json({ error: "Seeker not found" });

    return res.json({ defaultSharedVcIds: (doc as any).defaultSharedVcIds ?? [] });
  } catch (err) {
    console.error("GET /seekers/vcs/share-default error:", err);
    return res.status(500).json({ error: "Failed to load default VC sharing selection" });
  }
});

// PATCH /seekers/vcs/share-default
// body: { did?: string, email?: string, defaultSharedVcIds: string[] }
router.patch("/vcs/share-default", async (req, res) => {
  try {
    const { did, email, defaultSharedVcIds } = req.body as {
      did?: string;
      email?: string;
      defaultSharedVcIds?: string[];
    };

    if (!did && !email) return res.status(400).json({ error: "did or email required" });
    if (!Array.isArray(defaultSharedVcIds))
      return res.status(400).json({ error: "defaultSharedVcIds must be an array" });

    const criteria = did ? { did } : { email: String(email).toLowerCase() };

    const doc = await Seeker.findOne(criteria);
    if (!doc) return res.status(404).json({ error: "Seeker not found" });

    // Collect allowed credentialIds from issued VCs only
    const issued = Array.isArray((doc as any).vcs) ? (doc as any).vcs : [];
    const allowed = new Set(
      issued
        .map((v: any) => v.credentialId || v.id || v.credentialId)
        .filter(Boolean)
    );

    // Keep only IDs that belong to this seeker
    const canonical = defaultSharedVcIds.filter((id) => allowed.has(id));

    (doc as any).defaultSharedVcIds = canonical;
    await doc.save();

    return res.json({ ok: true, defaultSharedVcIds: canonical });
  } catch (err) {
    console.error("PATCH /seekers/vcs/share-default error:", err);
    return res.status(500).json({ error: "Failed to update default VC sharing selection" });
  }
});

/**
 * @openapi
 * /seekers/me:
 *   get:
 *     summary: Get seeker by DID or email
 *     tags: [Seekers]
 *     parameters:
 *       - in: query
 *         name: did
 *         schema: { type: string }
 *       - in: query
 *         name: email
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Seeker found
 *       404:
 *         description: Seeker not found
 */
router.get("/me", async (req: Request, res: Response) => {
  try {
    let { did, email } = req.query as {
      did?: string | string[];
      email?: string | string[];
    };

    if (Array.isArray(did)) did = did[0];
    if (Array.isArray(email)) email = email[0];

    const filter: any = {};
    if (did && did.trim()) filter.did = did.trim();
    if (email && email.trim()) filter.email = email.trim().toLowerCase();

    if (!filter.did && !filter.email) {
      return res.status(400).json({ error: "did or email required" });
    }

    const doc = await Seeker.findOne(filter).lean();
    if (!doc) return res.status(404).json({ error: "Seeker not found" });

    return res.json(toSeekerDTO(doc));
  } catch (err) {
    console.error("GET /seekers/me error:", err);
    return res.status(500).json({ error: "Failed to fetch seeker" });
  }
});

// GET /seekers/vcs/:credentialId
// Return the stored vcRaw so the seeker can generate a selective-disclosure proof
router.get("/vcs/:credentialId", async (req, res) => {
  try {
    const { credentialId } = req.params;

    if (!credentialId) {
      return res.status(400).json({ error: "credentialId is required" });
    }

    const cred = await Credential.findOne({ credentialId }).lean();

    if (!cred) {
      return res.status(404).json({ error: "Credential not found" });
    }

    const raw: any = (cred as any).vcRaw;
    if (!raw) {
      return res
        .status(404)
        .json({ error: "vcRaw not found for this credential" });
    }

    // Normalise to object
    let vc: any = raw;
    if (typeof raw === "string") {
      try {
        vc = JSON.parse(raw);
      } catch {
        // keep as string if parsing fails
      }
    }

    // 🔹 Shape expected by the frontend: { vcRaw: <full VC JSON> }
    return res.json({ vcRaw: vc, credentialId: cred.credentialId });
  } catch (err) {
    console.error("GET /seekers/vcs/:credentialId error:", err);
    return res
      .status(500)
      .json({ error: "Failed to load stored VC for this credential" });
  }
});

export default router;