// src/middleware/guardRecruiterBootstrap.ts
import type { Request, Response, NextFunction } from "express";

/**
 * Allows only bootstrap endpoints when user.roles.recruiter === "none".
 * This enforces: "none = no recruiter portal access except bootstrap endpoints".
 */
export function guardRecruiterBootstrap(allowedPaths: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const u = req.user;
    const state = u?.roles?.recruiter ?? "none";

    if (state !== "none") return next();

    const path = req.path; // path relative to router mount
    const ok = allowedPaths.some((p) => p === path);

    if (!ok) {
      return res.status(403).json({
        error: "Forbidden",
        reason: "Recruiter role is none (not onboarded). Only bootstrap endpoints allowed.",
      });
    }

    return next();
  };
}