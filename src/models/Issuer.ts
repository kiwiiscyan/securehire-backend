// src/models/Issuer.ts
import mongoose from "../config/mongo";
import type { Document } from "mongoose";

const { Schema, model } = mongoose;

export interface IIssuer extends Document {
  did: string;
  email?: string;
  name?: string;
  orgName?: string;
  orgType?: "company" | "university" | "certBody";
  onboarded: boolean;
  bbsPrivateKeyJwk?: any;            // full private JWK (includes "d")
  bbsPublicKeyJwk?: any;             // public JWK (no "d")
  bbsVerificationMethodId?: string;
}

const IssuerSchema = new Schema<IIssuer>(
  {
    did: { type: String, required: true, unique: true, index: true },
    email: { type: String, index: true },
    name: { type: String },
    orgName: { type: String },
    orgType: {
      type: String,
      enum: ["company", "university", "certBody"],
    },
    onboarded: {
      type: Boolean,
      default: false,
    },
    bbsPrivateKeyJwk: { type: Schema.Types.Mixed },
    bbsPublicKeyJwk: { type: Schema.Types.Mixed },
    bbsVerificationMethodId: { type: String },
  },
  { timestamps: true }
);

export default model<IIssuer>("Issuer", IssuerSchema);