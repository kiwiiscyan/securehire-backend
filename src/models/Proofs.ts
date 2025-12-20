// src/models/Proofs.ts
import mongoose from "../config/mongo";
import type { Document } from "mongoose";

const { Schema, model } = mongoose;

/**
 * One stored shared VC per (applicationId, vcId).
 * - applicationId: _id of Application document
 * - jobId, seekerDid, recruiterDid: convenience for querying / debugging
 * - vcId: credentialId (from Credential.credentialId)
 * - revealedDocument: the FULL VC JSON that the seeker shared (untouched)
 * - derivedProof/nonce: legacy fields (field-disclosure mode). Optional now.
 */
export interface ISharedProof extends Document {
  applicationId: string;           // Application._id as string
  jobId?: string;
  seekerDid: string;
  recruiterDid: string;
  vcId: string;

  derivedProof?: any;
  nonce?: string;
  revealedDocument?: any;

  createdAt?: Date;
  updatedAt?: Date;
}

const SharedProofSchema = new Schema<ISharedProof>(
  {
    applicationId: { type: String, required: true, index: true },
    jobId: { type: String, index: true },
    seekerDid: { type: String, required: true, index: true },
    recruiterDid: { type: String, required: true, index: true },
    vcId: { type: String, required: true, index: true },

    derivedProof: { type: Schema.Types.Mixed, required: false },
    nonce: { type: String },
    revealedDocument: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

// helpful compound index: there should be at most one proof per (applicationId, vcId)
SharedProofSchema.index({ applicationId: 1, vcId: 1 }, { unique: true });

export default model<ISharedProof>("SharedProof", SharedProofSchema);