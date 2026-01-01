//src/middleware/rbac.ts
import type { Request, Response, NextFunction } from "express";

export type Role = "seeker" | "recruiter" | "issuer";
export type RoleState = "none" | "active" | "pending" | "rejected";

export function requireRoleStateIn(role: Role, allowed: RoleState[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user as { roles?: Record<Role, RoleState> } | undefined;
    const current = user?.roles?.[role] ?? "none";

    if (!allowed.includes(current)) {
      return res.status(403).json({
        error: "Forbidden",
        reason: `Role state not allowed: ${role} (${current}). Allowed: ${allowed.join(",")}`,
      });
    }

    return next();
  };
}

// Keep a convenience wrapper
export function requireRoleActive(role: Role) {
  return requireRoleStateIn(role, ["active"]);
}