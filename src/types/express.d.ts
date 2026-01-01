// src/types/express.d.ts
import type { SessionPayload } from "../middleware/requireSession";
import type { IUser } from "../models/User";
import type { ISeeker } from "../models/Seeker";
import { IRecruiter } from "../models/Recruiter";
import { IIssuer } from "../models/Issuer";

declare global {
  namespace Express {
    interface Request {
      session?: SessionPayload;
      user?: IUser;
      seeker?: ISeeker;
      recruiter?: IRecruiter;
      issuer?: IIssuer;
      id?: string; // your requestIdMiddleware uses this
    }
  }
}

export { };