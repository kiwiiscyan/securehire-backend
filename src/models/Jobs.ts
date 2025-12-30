import mongoose from "../config/mongo";
import type { Document } from "mongoose";

const { Schema, model } = mongoose;

export interface IJob extends Document {
  title: string;
  company: string;
  location: string;
  description: string;
  tags: string[];
  category: string;
  didOwner?: string;
  verified?: boolean;
  trustStatus?: "Active" | "Suspended" | "Revoked" | "Untrustworthy" | "None";
  postedAt?: Date;
  workType?: "full-time" | "part-time" | "contract" | "casual";
  salaryText?: string;

  summary?: string;
  purpose?: string;
  responsibilities?: string[];
  interpersonal?: string[];
  skills?: string[];
  qualifications?: string[];
  companyProfile?: string;
  feedback?: string;

  onChainRef?: string;
  vcStatusMeta?: {
    issuer?: string;
    network?: "Polygon PoS";
  };

  status: "draft" | "published" | "closed";
  createdAt?: Date;
  updatedAt?: Date;
}

const JobSchema = new Schema<IJob>(
  {
    title: { type: String, required: true },
    company: { type: String, required: true },
    location: { type: String, required: true },
    description: { type: String, required: true },
    tags: { type: [String], default: [] },
    category: { type: String, required: true }, // "it", "sales", "engineering", "other"
    didOwner: String,
    verified: { type: Boolean, default: false },
    trustStatus: {
      type: String,
      enum: ["Active", "Suspended", "Revoked", "Untrustworthy", "None"],
      default: "None",
    },
    postedAt: { type: Date }, // optional; if missing we’ll use createdAt

    workType: {
      type: String,
      enum: ["full-time", "part-time", "contract", "casual"],
    },
    salaryText: String,

    summary: String,
    purpose: String,
    responsibilities: { type: [String], default: [] },
    interpersonal: { type: [String], default: [] },
    skills: { type: [String], default: [] },
    qualifications: { type: [String], default: [] },
    companyProfile: String,
    feedback: String,

    onChainRef: String,
    vcStatusMeta: {
      issuer: String,
      network: { type: String, default: "Polygon PoS" },
    },

    status: {
      type: String,
      enum: ["draft", "published", "closed"],
      default: "published",
      index: true,
    },
  },
  { timestamps: true }
);

export default model<IJob>("Job", JobSchema);