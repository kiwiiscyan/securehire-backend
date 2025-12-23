//src/middleware/requireInternalKey.ts
import type { Request, Response, NextFunction } from "express";

export function requireInternalKey(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.INTERNAL_API_KEY;
  if (!expected) {
    return res.status(500).json({ message: "Missing INTERNAL_API_KEY on server" });
  }

  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${expected}`) {
    return res.status(401).json({ message: "Unauthorized (BFF only)" });
  }

  next();
}