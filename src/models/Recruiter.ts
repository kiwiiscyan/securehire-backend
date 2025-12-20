// src/models/Recruiter.ts
import { Schema, model, Document } from "mongoose";

export interface IRecruiter extends Document {
  did: string;
  orgLegalName?: string;
  contactEmail?: string;
  website?: string;
  onboarded?: boolean;
  kycStatus?: "none" | "pending" | "approved" | "rejected";
  kycDocs?: {
    bizRegFilename?: string | null;
    letterheadFilename?: string | null;
    hrIdFilename?: string | null;
  };
  badge: {
    verified: boolean;
    level?: number;
    lastCheckedAt?: Date;
    txHash?: string | null;
    network?: string | null;
    credentialId?: string | null;
  };
  createdAt?: Date;
  updatedAt?: Date;
}

const RecruiterSchema = new Schema<IRecruiter>(
  {
    did: { type: String, index: true, unique: true, required: true },
    orgLegalName: String,
    contactEmail: String,
    website: String,

    onboarded: { type: Boolean, default: false },

    kycStatus: {
      type: String,
      enum: ["none", "pending", "approved", "rejected"],
      default: "none",
    },

    kycDocs: {
      bizRegFilename: String,
      letterheadFilename: String,
      hrIdFilename: String,
    },

    badge: {
      verified: { type: Boolean, default: false },
      level: { type: Number },
      lastCheckedAt: Date,
      txHash: { type: String },
      network: { type: String },
      credentialId: { type: String },
    },
  },
  { timestamps: true }
);

export default model<IRecruiter>("Recruiter", RecruiterSchema);