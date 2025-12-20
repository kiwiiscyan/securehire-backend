import { Schema, model, Document } from "mongoose";

export interface IApplication extends Document {
  jobId: string;
  seekerDid: string;
  recruiterDid: string;
  sharedVcIds: string[];
  status: "submitted" | "withdrawn" | "shortlisted" | "rejected" | "hired";

  // already used in routes/:id/status
  interview?: any;

  // used in routes/applications.ts when creating an application
  seekerProfile?: {
    name?: string;
    email?: string;
    homeLocation?: string;
    skills?: string[];
    languages?: string[];
    resumeInfo?: any;

  };
}

const ApplicationSchema = new Schema<IApplication>(
  {
    jobId: { type: String, required: true },
    seekerDid: { type: String, required: true },
    recruiterDid: { type: String, required: true },
    sharedVcIds: { type: [String], default: [] },
    status: {
      type: String,
      enum: ["submitted", "withdrawn", "shortlisted", "rejected", "hired"],
      default: "submitted",
    },
    interview: {
      type: Schema.Types.Mixed,
      default: undefined,
    },
    seekerProfile: {
      name: { type: String },
      email: { type: String },
      homeLocation: { type: String },
      skills: { type: [String], default: [] },
      languages: { type: [String], default: [] },
      resumeInfo: { type: Schema.Types.Mixed, default: undefined },
    },
  },
  { timestamps: true }
);

export default model<IApplication>("Application", ApplicationSchema);