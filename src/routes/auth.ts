//src/soutes/auth.ts
import { Router } from "express";
import { requireSession, getSession } from "../middleware/requireSession";
import Seeker from "../models/Seeker";

import Issuer from "../models/Issuer";
import Recruiter from "../models/Recruiter"; // adjust if your model name differs

const router = Router();

/**
 * GET /api/v1/auth/me
 * Returns the DB user matched by session DID/email and the resolved role.
 */
router.get("/me", requireSession, async (req, res) => {
  const s = getSession(req);
  if (!s) return res.status(401).json({ message: "Unauthenticated" });
  const did = (s.did || "").toLowerCase();
  const email = (s.email || "").toLowerCase();

  // Match by DID first, fallback email if needed
  const seeker = did ? await Seeker.findOne({ did }) : await Seeker.findOne({ email }).lean();
  if (seeker) return res.json({ role: "seeker", user: seeker });

  const issuer = did ? await Issuer.findOne({ did }) : await Seeker.findOne({ email }).lean();
  if (issuer) return res.json({ role: "issuer", user: issuer });

  const recruiter = did ? await Recruiter.findOne({ did }) : await Seeker.findOne({ email }).lean();
  if (recruiter) return res.json({ role: "recruiter", user: recruiter });

  return res.status(404).json({ message: "User not found in DB" });
});

export default router;