// src/routes/seekers.ts
import { Router, Request, Response } from "express";
import Seeker, { ISeeker } from "../models/Seeker";
import Issuer from "../models/Issuer";
import mongoose from "mongoose";
import Credential from "../models/Credential";
import { registerDidOnChain } from "../services/did-registry.service";
import { requireSession } from "../middleware/requireSession";
import { requireUser } from "../middleware/requireUser";
import { requireRoleStateIn, requireRoleActive } from "../middleware/rbac";
import { syncSeekerRoleFromSeekerDoc } from "../middleware/syncSeekerRoleFromSeekerDoc";
import { requireSeekerOnboarded } from "../middleware/requireSeekerOnboarded";
import { mustGetIdentity, deriveDidFromSession, findSeekerBySession } from "../services/seekerIdentity";
import crypto from "crypto";

const router = Router();

/**
 * All seeker routes require an authenticated session.
 * Identity (did/email) is taken from the verified session, NOT client body/query.
 */
router.use(requireSession, requireUser, syncSeekerRoleFromSeekerDoc);

// Simple normaliser: lowercase + trim
const norm = (s?: string | null) =>
  (s || "").trim().toLowerCase();
/**
 * Optional: validate a client-proposed DID (e.g. did:pkh...) against session wallet.
 * This lets you keep your current frontend flow (client builds did:pkh) while NOT trusting it blindly.
 *
 * If you want to be stricter: remove clientDid entirely and always derive from session.
 */
function validateDidAgainstSessionWallet(clientDid: string, session: { wallet_address?: string; did?: string }) {
  const did = String(clientDid || "").trim();
  if (!did) return false;

  // If session already is a did:pkh, require exact match
  if (session.did && session.did.startsWith("did:pkh:")) {
    return session.did.toLowerCase() === did.toLowerCase();
  }

  // If session has wallet address, ensure did contains that address
  if (session.wallet_address) {
    const addr = session.wallet_address.toLowerCase();
    const didAddr = (did.match(/0x[a-fA-F0-9]{40}/) || [])[0]?.toLowerCase();
    return !!didAddr && didAddr === addr;
  }

  // Fallback: allow if it matches session.did (e.g. did:privy:xxx)
  if (session.did) {
    return session.did.toLowerCase() === did.toLowerCase();
  }

  return false;
}

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
router.post("/onboard",
  requireRoleStateIn("seeker", ["none", "active"]),
  async (req, res) => {
    try {
      const session = mustGetIdentity(req);

      const {
        name,
        homeLocation,
        classification,
        subClass,
        visibility,
        vcOnly,
        consentShareVC,
        antiPhishAck,
        careerSeed,
        onboarded,
        // optional legacy fields (ignored for identity)
        //did: clientDid,
      } = req.body || {};

      // Name is still required for onboarding updates
      if (!name || !String(name).trim()) {
        return res.status(400).json({ error: "name is required" });
      }

      // Find by session
      let doc = await findSeekerBySession(req);

      // Create if not exists
      if (!doc) {
        doc = new Seeker({
          email: session.email, // from session
          name: String(name).trim(),
          onboarded: !!onboarded,
        });
      }

      // Ensure email is set from session (authoritative)
      if (session.email && !doc.email) doc.email = session.email;

      // Decide DID to store:
      // - If client provides a did, we ONLY accept it if it matches session wallet/session did
      // - Otherwise we derive from session
      const derived = deriveDidFromSession(session);
      let didToStore: string | undefined = derived;

      /*
      if (clientDid && validateDidAgainstSessionWallet(String(clientDid), session)) {
        didToStore = String(clientDid).trim();
      }
        */

      // Assign DID only if empty
      if (didToStore && !doc.did) {
        doc.did = didToStore;

        // Optional: register DID on-chain (best-effort)
        try {
          const addressMatch = didToStore.match(/0x[a-fA-F0-9]{40}/);
          if (addressMatch && process.env.DID_REGISTRY_ADDRESS) {
            const walletAddress = addressMatch[0];
            const didDocHash = crypto.createHash("sha256").update(didToStore).digest("hex");
            const txHash = await registerDidOnChain(walletAddress, didToStore, `0x${didDocHash}`);
            console.log(`[seekers/onboard] DID registered on blockchain: ${didToStore}, tx: ${txHash}`);
            (doc as any).didRegistrationTxHash = txHash;
          }
        } catch (blockchainErr: any) {
          console.error(
            "[seekers/onboard] Failed to register DID on blockchain:",
            blockchainErr?.message || blockchainErr
          );
        }
      }

      // Update profile fields (non-identity)
      doc.name = String(name).trim();

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

      if (careerSeed?.title || careerSeed?.company) {
        doc.profile = { careerHistory: [careerSeed] };
      }

      await doc.save();

      if (req.user) {
        req.user.roles.seeker = doc.onboarded ? "active" : "none";
        await req.user.save();
      }

      return res.json(toSeekerDTO(doc));
    } catch (err: any) {
      console.error("POST /seekers/onboard error:", err);

      if (err?.code === 11000 && err?.keyPattern?.did) {
        return res.status(409).json({
          error: "DID already exists. Please regenerate a new DID.",
        });
      }

      // If our identity helper threw:
      if (String(err?.message || "").includes("Missing session identity")) {
        return res.status(401).json({ error: "Unauthenticated" });
      }

      return res.status(500).json({ error: "Failed to onboard seeker" });
    }
  });

/**
 * @openapi
 * /seekers/me:
 *   get:
 *     summary: Get seeker (session-only)
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
    const doc = await findSeekerBySession(req);
    if (!doc) return res.status(404).json({ error: "Seeker not found" });
    return res.json(toSeekerDTO(doc));
  } catch (err) {
    console.error("GET /seekers/me error:", err);
    return res.status(500).json({ error: "Failed to fetch seeker" });
  }
});

router.use(requireSeekerOnboarded);
router.use(requireRoleActive("seeker"));

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
    const { profile } = req.body || {};

    const doc = await findSeekerBySession(req);
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
    const { section, mode, value, requestVc } = req.body as {
      section: "career" | "education" | "certs";
      mode?: "add" | "edit";
      value: any;
      requestVc?: boolean;
    };

    if (!section || !value) {
      return res.status(400).json({ error: "section and value are required" });
    }

    const seeker = await findSeekerBySession(req);
    if (!seeker) return res.status(404).json({ error: "Seeker not found" });

    // --- 1) Update profile array for the section ---
    const profile = seeker.profile || {};

    if (section === "career") {
      const arr = Array.isArray(profile.careerHistory) ? profile.careerHistory : [];
      if (mode === "edit" && typeof value._index === "number") arr[value._index] = value;
      else arr.push(value);
      profile.careerHistory = arr;
    }

    if (section === "education") {
      const arr = Array.isArray(profile.education) ? profile.education : [];
      if (mode === "edit" && typeof value._index === "number") arr[value._index] = value;
      else arr.push(value);
      profile.education = arr;
    }

    if (section === "certs") {
      const arr = Array.isArray(profile.certifications) ? profile.certifications : [];
      if (mode === "edit" && typeof value._index === "number") arr[value._index] = value;
      else arr.push(value);
      profile.certifications = arr;
    }

    seeker.profile = profile;

    // --- 2) Optionally create pending VC request ---
    let createdRequest: any | null = null;

    if (requestVc) {
      let orgName: string | undefined;

      if (section === "career") orgName = value.company;
      else if (section === "education") orgName = value.institution;
      else if (section === "certs") orgName = value.organisation || value.issuingOrg || value.name;

      const issuerDid = orgName
        ? await resolveIssuerDidFromOrg(orgName, section === "certs" ? "certification" : section)
        : null;

      if (!issuerDid) {
        console.warn("No issuer found for org:", orgName);
      } else {
        const requestId = new mongoose.Types.ObjectId().toString();

        const title =
          section === "career"
            ? `${value.title || "Role"} at ${orgName}`
            : section === "education"
              ? `${value.qualification || "Study"} at ${orgName}`
              : `${value.name || "Certification"} (${orgName})`;

        const pendingList = Array.isArray(seeker.pendingVcRequests) ? seeker.pendingVcRequests : [];

        const requestEntry = {
          id: requestId,
          section: section === "certs" ? "certification" : section,
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
    const { value } = req.body || {};
    const section = req.params.section;

    if (!value) return res.status(400).json({ error: "value required" });

    const doc = await findSeekerBySession(req);
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

      case "visibility": {
        profile.visibility = value.visibility;
        doc.visibility = value.visibility;
        break;
      }

      default:
        return res.status(400).json({ error: `Unknown section: ${section}` });
    }

    doc.profile = profile;
    await doc.save();

    return res.json(toSeekerDTO(doc));
  } catch (err) {
    console.error("PATCH /seekers/profile/section error:", err);
    return res.status(500).json({ error: "Failed to update profile" });
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
    const { section, title, issuerDid } = req.body as {
      section: "career" | "education" | "certification";
      title: string;
      issuerDid: string;
    };

    if (!section || !title || !issuerDid) {
      return res.status(400).json({ error: "section, title, issuerDid required" });
    }

    const doc = await findSeekerBySession(req);
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

// GET /seekers/vcs/share-default  (session-only)
router.get("/vcs/share-default", async (req, res) => {
  try {
    const doc = await findSeekerBySession(req);
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
    const { defaultSharedVcIds } = req.body as {
      defaultSharedVcIds?: string[];
    };

    if (!Array.isArray(defaultSharedVcIds)) {
      return res.status(400).json({ error: "defaultSharedVcIds must be an array" });
    }

    const doc = await findSeekerBySession(req);
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

// GET /seekers/vcs/:credentialId
// Return the stored vcRaw so the seeker can generate a selective-disclosure proof
router.get("/vcs/:credentialId", async (req, res) => {
  try {
    const { credentialId } = req.params;

    if (!credentialId) {
      return res.status(400).json({ error: "credentialId is required" });
    }

    const seeker = await findSeekerBySession(req);
    if (!seeker) return res.status(404).json({ error: "Seeker not found" });

    // Ownership check: credentialId must be in seeker's issued VCs list
    const issued = Array.isArray((seeker as any).vcs) ? (seeker as any).vcs : [];
    const owns = issued.some((v: any) => String(v.credentialId || v.id || "") === String(credentialId));
    if (!owns) {
      return res.status(403).json({ error: "Forbidden: VC does not belong to this seeker" });
    }

    const cred = await Credential.findOne({ credentialId }).lean();
    if (!cred) return res.status(404).json({ error: "Credential not found" });

    const raw: any = (cred as any).vcRaw;
    if (!raw) return res.status(404).json({ error: "vcRaw not found for this credential" });

    // Normalise to object
    let vc: any = raw;
    if (typeof raw === "string") {
      try {
        vc = JSON.parse(raw);
      } catch {
        // keep as string if parsing fails
      }
    }

    return res.json({ vcRaw: vc, credentialId: (cred as any).credentialId });
  } catch (err) {
    console.error("GET /seekers/vcs/:credentialId error:", err);
    return res.status(500).json({ error: "Failed to load stored VC for this credential" });
  }
});

export default router;