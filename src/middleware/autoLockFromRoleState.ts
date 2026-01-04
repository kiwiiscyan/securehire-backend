//src/middleware/autoLockFromRoleState.ts
import type { Request, Response, NextFunction } from "express";
import type { Role } from "../models/User";

export function autoLockFromRoleState(target: Role) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const user = req.user as any;
      if (!user) return next();

      // already locked -> do nothing
      if (user.lockedRole) return next();

      // if this portal already has a lifecycle state, lock it now
      const state = user.roles?.[target];
      if (state && state !== "none") {
        user.lockedRole = target;
        await user.save();
      }

      return next();
    } catch (e) {
      return next(e);
    }
  };
}