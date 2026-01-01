//src/middleware/requireUser.ts
import type { Request, Response, NextFunction } from "express";
import User from "../models/User";

type SessionPayload = {
  privyUserId?: string;
  email?: string;
  did?: string;
  wallet_address?: string;
};

export async function requireUser(req: Request, res: Response, next: NextFunction) {
  try {
    const s = (req as any).session as SessionPayload | undefined;
    const privyUserId = s?.privyUserId;

    if (!privyUserId) {
      return res.status(401).json({ message: "Invalid session (missing privyUserId)" });
    }

    let user = await User.findOne({ privyUserId });

    if (!user) {
      user = await User.create({
        privyUserId,
        email: s?.email,
        did: s?.did,
        wallet_address: s?.wallet_address,
        roles: { seeker: "none", recruiter: "none", issuer: "none" },
      });
    } else {
      // optional identity refresh
      if (s?.email && !user.email) user.email = s.email;
      if (s?.did && !user.did) user.did = s.did;
      if (s?.wallet_address && !user.wallet_address) user.wallet_address = s.wallet_address;

      await user.save();
    }

    (req as any).user = user;
    return next();
  } catch (e) {
    console.error("requireUser error:", e);
    return res.status(500).json({ message: "Failed to load user" });
  }
}