// src/models/Seeker.ts
import mongoose from "../config/mongo";
import type { Document } from "mongoose";

const { Schema, model } = mongoose;


export type ProfileVisibility = "public" | "standard" | "limited" | "hidden";

export interface ISeekerProfile {
  summary?: string;
  location?: string;
  visibility?: ProfileVisibility;
  careerHistory?: any[];      // you can refine these types later
  education?: any[];
  certifications?: any[];
  skills?: string[];
  languages?: string[];
  resumeInfo?: any;
}

export interface ISeeker extends Document {
  did?: string;
  email: string;
  name: string;
  phone?: string;

  // high-level flags
  onboarded: boolean;
  homeLocation?: string;
  classification?: string;
  subClass?: string;
  visibility?: ProfileVisibility; // main visibility flag
  vcOnly?: boolean;
  consentShareVC?: boolean;
  antiPhishAck?: boolean;

  // nested profile + VC metadata
  profile?: ISeekerProfile;
  vcs?: any[];
  pendingVcRequests?: any[];

  createdAt: Date;
  updatedAt: Date;
  defaultSharedVcIds?: string[];
}

const SeekerProfileSchema = new Schema<ISeekerProfile>(
  {
    summary: { type: String },
    location: { type: String },
    visibility: {
      type: String,
      enum: ["public", "standard", "limited", "hidden"],
    },
    careerHistory: { type: [Schema.Types.Mixed], default: [] },
    education: { type: [Schema.Types.Mixed], default: [] },
    certifications: { type: [Schema.Types.Mixed], default: [] },
    skills: { type: [String], default: [] },
    languages: { type: [String], default: [] },
    resumeInfo: { type: Schema.Types.Mixed },
  },
  { _id: false }
);

const SeekerSchema = new Schema<ISeeker>(
  {
    did: {
      type: String,
      index: true,
      unique: true,
      sparse: true, // allow docs without DID
    },
    email: {
      type: String,
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
    },
    phone: { type: String },
    onboarded: {
      type: Boolean,
      default: false,
    },

    homeLocation: { type: String },
    classification: { type: String },
    subClass: { type: String },

    visibility: {
      type: String,
      enum: ["public", "standard", "limited", "hidden"],
      default: "hidden",
    },

    vcOnly: { type: Boolean, default: false },
    consentShareVC: { type: Boolean, default: false },
    antiPhishAck: { type: Boolean, default: false },

    profile: { type: SeekerProfileSchema, default: {} },

    vcs: {
      type: [Schema.Types.Mixed],
      default: [],
    },

    pendingVcRequests: {
      type: [Schema.Types.Mixed],
      default: [],
    },

    defaultSharedVcIds: {
      type: [String],
      default: [],
      index: true,
    },
  },
  { timestamps: true }
);

const Seeker = model<ISeeker>("Seeker", SeekerSchema);

export default Seeker;