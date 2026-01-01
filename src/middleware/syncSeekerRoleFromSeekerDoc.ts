//src/middleware/syncSeekerRoleFromSeekerDoc.ts
import type { Request, Response, NextFunction } from "express";
import Seeker from "../models/Seeker";

type RoleState = "none" | "pending" | "active" | "rejected";

function computeSeekerRoleState(seeker: any | null): RoleState {
  if (!seeker) return "none";
  if (!seeker.onboarded) return "none";
  return "active";
}

export async function syncSeekerRoleFromSeekerDoc(
  req: Request,
  _res: Response,
  next: NextFunction
) {
  try {
    const user = req.user;
    if (!user) return next();

    const did = req.session?.did?.trim();
    const email = req.session?.email?.trim().toLowerCase();

    let seeker = null;
    if (did) seeker = await Seeker.findOne({ did }).lean();
    if (!seeker && email) seeker = await Seeker.findOne({ email }).lean();

    const desired = computeSeekerRoleState(seeker);

    if (user.roles.seeker !== desired) {
      user.roles.seeker = desired;
      await user.save();
    }

    if (seeker) req.seeker = seeker as any;

    return next();
  } catch (e) {
    return next(e);
  }
}