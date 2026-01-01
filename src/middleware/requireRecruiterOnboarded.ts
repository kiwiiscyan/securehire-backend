// src/middleware/requireRecruiterOnboarded.ts
import type { Request, Response, NextFunction } from "express";
import Recruiter from "../models/Recruiter";

export async function requireRecruiterOnboarded(req: Request, res: Response, next: NextFunction) {
  try {
    const did = req.session?.did?.trim();
    const email = req.session?.email?.trim().toLowerCase();

    let recruiter = null;
    if (did) recruiter = await Recruiter.findOne({ did });
    if (!recruiter && email) recruiter = await Recruiter.findOne({ contactEmail: email });

    if (!recruiter || !recruiter.onboarded) {
      return res.status(403).json({ error: "Forbidden", reason: "Recruiter not onboarded" });
    }

    req.recruiter = recruiter;
    return next();
  } catch (e) {
    return res.status(500).json({ error: "Failed to verify recruiter onboarding" });
  }
}