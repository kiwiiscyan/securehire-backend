//src/auth/identity.ts
import type { Request } from "express";
import { getSession } from "../middleware/requireSession";

export type SessionIdentity = {
  did?: string;
  email?: string;
  wallet_address?: string;
  privyUserId?: string;
};

export function mustGetSession(req: Request): SessionIdentity {
  const s = (getSession(req) || {}) as SessionIdentity;
  const did = (s.did || "").trim();
  const email = (s.email || "").trim().toLowerCase();
  const wallet_address = (s.wallet_address || "").trim();

  if (!did && !email) throw new Error("Unauthenticated");
  return { ...s, did: did || undefined, email: email || undefined, wallet_address: wallet_address || undefined };
}

export function mustGetDid(req: Request): string {
  const s = mustGetSession(req);
  if (!s.did) throw new Error("Missing DID in session");
  return s.did;
}

export function mustGetEmail(req: Request): string {
  const s = mustGetSession(req);
  if (!s.email) throw new Error("Missing email in session");
  return s.email;
}