import mongoose from "../config/mongo";
import type { Document } from "mongoose";

const { Schema, model } = mongoose;

export interface ICredential extends Document {
  credentialId: string;
  subjectDid: string;
  issuerDid: string;
  type: string[];
  issuanceDate: Date;
  status: 'active' | 'revoked' | 'expired';

  onChainTxHash?: string;
  revocationTxHash?: string;

  title?: string;
  vcRaw?: any;

  network?: string;
}

const CredentialSchema = new Schema<ICredential>(
  {
    credentialId: { type: String, index: true, unique: true, required: true },
    subjectDid: { type: String, index: true, required: true },
    issuerDid: { type: String, required: true },
    title: { type: String },
    type: [String],
    issuanceDate: Date,
    status: {
      type: String,
      enum: ['active', 'revoked', 'expired'],
      default: 'active',
    },
    onChainTxHash: { type: String },
    revocationTxHash: { type: String },
    vcRaw: { type: Schema.Types.Mixed },
    network: { type: String },
  },
  { timestamps: true }
);

export default model<ICredential>('Credential', CredentialSchema);