// src/middleware/syncRecruiterRoleFromRecruiterDoc.ts
import type { Request, Response, NextFunction } from "express";
import Recruiter from "../models/Recruiter";

type RoleState = "none" | "pending" | "active" | "rejected";
type BadgeStatus = "None" | "Pending" | "Active" | "Revoked" | "Rejected";

function computeRecruiterRoleState(recruiter: any | null): RoleState {
  if (!recruiter) return "none";

  // Requirement: onboarded=false => role must remain none
  if (!recruiter.onboarded) return "none";

  const status = (recruiter.badge?.status ?? "None") as BadgeStatus;

  if (status === "Active") return "active";
  if (status === "Pending") return "pending";
  if (status === "Revoked" || status === "Rejected") return "rejected";

  // Onboarded true but badge status not set properly -> keep safest state
  return "pending";
}

export async function syncRecruiterRoleFromRecruiterDoc(
  req: Request,
  _res: Response,
  next: NextFunction
) {
  try {
    const user = req.user;
    if (!user) return next();

    const did = req.session?.did?.trim();
    const email = req.session?.email?.trim().toLowerCase();

    let recruiter = null;
    if (did) recruiter = await Recruiter.findOne({ did }).lean();
    if (!recruiter && email) recruiter = await Recruiter.findOne({ contactEmail: email }).lean();

    const desired = computeRecruiterRoleState(recruiter);

    if (user.roles.recruiter !== desired) {
      user.roles.recruiter = desired;
      await user.save();
    }

    // Optional convenience: attach recruiter doc to req if it exists
    if (recruiter) req.recruiter = recruiter as any;

    return next();
  } catch (e) {
    return next(e);
  }
}