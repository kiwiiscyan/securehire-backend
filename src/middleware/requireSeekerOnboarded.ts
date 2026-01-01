// src/middleware/requireSeekerOnboarded.ts
import type { Request, Response, NextFunction } from "express";
import { findSeekerBySession } from "../services/seekerIdentity";

export async function requireSeekerOnboarded(req: Request, res: Response, next: NextFunction) {
  const seeker = await findSeekerBySession(req);

  if (!seeker || !seeker.onboarded) {
    return res.status(403).json({ error: "Forbidden", reason: "Seeker not onboarded" });
  }

  req.seeker = seeker;
  return next();
}