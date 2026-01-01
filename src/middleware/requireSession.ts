//src/middleware/requireSession.ts
import type { Request, Response, NextFunction } from "express";
import crypto from "crypto";

export type SessionPayload = {
  did?: string;
  privyUserId?: string;
  email?: string;
  wallet_address?: string;
  iat?: number;
  exp?: number;
};

function verifySession(token: string, secret: string): SessionPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [bodyB64, sigB64] = parts;
  const expectedSig = crypto
    .createHmac("sha256", secret)
    .update(bodyB64)
    .digest("base64url");

  // constant-time compare
  const a = Buffer.from(sigB64);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const payload = JSON.parse(Buffer.from(bodyB64, "base64url").toString("utf8")) as SessionPayload;

  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now) return null;

  return payload;
}

export function requireSession(req: Request, res: Response, next: NextFunction) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return res.status(500).json({ message: "Missing SESSION_SECRET" });

  const token = req.headers["x-sh-session"];
  if (!token || typeof token !== "string") {
    return res.status(401).json({ message: "Missing session" });
  }

  const payload = verifySession(token, secret);
  if (!payload?.did && !payload?.email) {
    return res.status(401).json({ message: "Invalid session" });
  }

  // attach to req for downstream use
  (req as any).session = payload;
  console.log("[API] x-sh-session?", typeof req.headers["x-sh-session"], !!req.headers["x-sh-session"]);
  console.log("[API] secret hash:", crypto.createHash("sha256").update(secret).digest("hex").slice(0, 12));
  return next();
}

export function getSession(req: Request): SessionPayload | null {
  const s = (req as any).session as SessionPayload | undefined;
  console.log("[API] session payload =", s);
  return s ?? null;
}