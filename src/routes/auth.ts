// src/routes/auth.ts
import { Router } from "express";
import { requireSession } from "../middleware/requireSession";
import { requireUser } from "../middleware/requireUser";
import { syncSeekerRoleFromSeekerDoc } from "../middleware/syncSeekerRoleFromSeekerDoc";
import { syncRecruiterRoleFromRecruiterDoc } from "../middleware/syncRecruiterRoleFromRecruiterDoc";
import { syncIssuerRoleFromIssuerDoc } from "../middleware/syncIssuerRoleFromIssuerDoc"; // create similarly
import type { Role, RoleState } from "../models/User";

const router = Router();

/**
 * GET /api/v1/auth/me
 * Returns:
 * - session identity (did/email)
 * - user.roles (source of truth)
 * - derived "activeRoles" + "primaryRole" for frontend routing/UX
 */
router.get(
  "/me",
  requireSession,
  requireUser,
  // keep roles in sync so frontend sees up-to-date state
  syncSeekerRoleFromSeekerDoc,
  syncRecruiterRoleFromRecruiterDoc,
  syncIssuerRoleFromIssuerDoc,
  (req, res) => {
    const user = req.user!;
    const roles = user.roles;

    const activeRoles = (Object.keys(roles) as Role[])
      .filter((r) => roles[r] === "active");

    const pendingRoles = (Object.keys(roles) as Role[])
      .filter((r) => roles[r] === "pending");

    // Decide a primary role (simple priority; adjust if needed)
    const primaryRole: Role | null =
      activeRoles.includes("seeker") ? "seeker" :
        activeRoles.includes("recruiter") ? "recruiter" :
          activeRoles.includes("issuer") ? "issuer" :
            pendingRoles.includes("seeker") ? "seeker" :
              pendingRoles.includes("recruiter") ? "recruiter" :
                pendingRoles.includes("issuer") ? "issuer" :
                  null;

    console.log("[/auth/me] user =", {
      privyUserId: user.privyUserId,
      did: user.did,
      email: user.email,
      roles: user.roles,
    });
    console.log("[/auth/me] computed =", { activeRoles, pendingRoles, primaryRole });

    return res.json({
      identity: {
        privyUserId: user.privyUserId,
        did: user.did,
        email: user.email,
        wallet_address: user.wallet_address,
      },
      roles,                // { seeker: "active" | ... }
      activeRoles,          // ["seeker", ...]
      pendingRoles,
      primaryRole,
      // Optional: useful for frontend gating
      onboarding: {
        seekerOnboarded: Boolean(req.seeker && (req.seeker as any).onboarded),
        recruiterOnboarded: Boolean(req.recruiter && (req.recruiter as any).onboarded),
        issuerOnboarded: Boolean(req.issuer && (req.issuer as any).onboarded),
      },
    });
  }
);

router.post("/logout", (_req, res) => {
  return res.json({ ok: true });
});

export default router;