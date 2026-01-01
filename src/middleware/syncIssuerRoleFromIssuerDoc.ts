//src/middleware/syncIssuerRoleFromIssuerDoc.ts
import type { Request, Response, NextFunction } from "express";
import Issuer from "../models/Issuer";

type RoleState = "none" | "pending" | "active" | "rejected";

function computeIssuerRoleState(issuer: any | null): RoleState {
  if (!issuer) return "none";
  if (!issuer.onboarded) return "none";
  return "active";
}

export async function syncIssuerRoleFromIssuerDoc(
  req: Request,
  _res: Response,
  next: NextFunction
) {
  try {
    const user = req.user;
    if (!user) return next();

    const did = req.session?.did?.trim();
    const email = req.session?.email?.trim().toLowerCase();

    // Find issuer by session identity
    let issuer = null;
    if (did) issuer = await Issuer.findOne({ did }).lean();
    if (!issuer && email) issuer = await Issuer.findOne({ email }).lean();

    const desired = computeIssuerRoleState(issuer);

    if (user.roles.issuer !== desired) {
      user.roles.issuer = desired;
      await user.save();
    }

    // Optional: attach issuer to request for downstream use
    if (issuer) (req as any).issuer = issuer;

    return next();
  } catch (e) {
    return next(e);
  }
}