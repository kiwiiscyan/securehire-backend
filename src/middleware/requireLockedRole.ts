// src/middleware/requireLockedRole.ts
import type { Request, Response, NextFunction } from "express";
import type { Role } from "../models/User";

export function requireLockedRole(target: Role) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user as { lockedRole?: Role } | undefined;
    if (!user) return res.status(500).json({ message: "User not loaded" });

    // If never locked yet, allow (first portal they complete becomes the lock)
    if (!user.lockedRole) return next();

    // If locked to another role, block
    if (user.lockedRole !== target) {
      return res.status(409).json({
        code: "ROLE_MISMATCH",
        message: `This account is registered as ${user.lockedRole}.`,
        lockedRole: user.lockedRole,
        attemptedRole: target,
      });
    }

    return next();
  };
}