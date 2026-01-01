// src/services/seekerIdentity.ts
import type { Request } from "express";
import Seeker from "../models/Seeker";
import { getSession, type SessionPayload } from "../middleware/requireSession";

/**
 * Prefer DID, fallback email. Throw if neither exists.
 */
export function mustGetIdentity(req: Request): {
  did?: string;
  email?: string;
  wallet_address?: string;
} {
  const s = (getSession(req) || {}) as SessionPayload;

  const did = s.did?.trim();
  const email = s.email?.trim().toLowerCase();
  const wallet_address = s.wallet_address?.trim();

  if (!did && !email) {
    throw new Error("Missing session identity (did/email)");
  }

  return { did, email, wallet_address };
}

/**
 * Decide which DID we should store on the seeker record.
 * Preference:
 *  1) if session.did is did:pkh -> use it
 *  2) else if session.wallet_address exists -> construct did:pkh:eip155:80002:<addr>
 *  3) else -> use session.did (e.g. did:privy:...)
 */
export function deriveDidFromSession(session: SessionPayload): string | undefined {
  const sDid = session.did?.trim();
  const w = session.wallet_address?.trim();

  if (sDid && sDid.startsWith("did:pkh:")) return sDid;

  if (w && /^0x[a-fA-F0-9]{40}$/.test(w)) {
    return `did:pkh:eip155:80002:${w.toLowerCase()}`;
  }

  if (sDid) return sDid;
  return undefined;
}

/**
 * Resolve current seeker doc based on session identity.
 * Tries:
 *  1) exact session.did
 *  2) derived did:pkh from wallet_address
 *  3) session.email
 */
export async function findSeekerBySession(req: Request) {
  const s = mustGetIdentity(req);

  // 1) direct did match
  if (s.did) {
    const byDid = await Seeker.findOne({ did: s.did });
    if (byDid) return byDid;
  }

  // 2) derived did:pkh from wallet
  if (s.wallet_address && /^0x[a-fA-F0-9]{40}$/.test(s.wallet_address)) {
    const didPkh = `did:pkh:eip155:80002:${s.wallet_address.toLowerCase()}`;
    const byDerived = await Seeker.findOne({ did: didPkh });
    if (byDerived) return byDerived;
  }

  // 3) email fallback
  if (s.email) {
    const byEmail = await Seeker.findOne({ email: s.email });
    if (byEmail) return byEmail;
  }

  return null;
}