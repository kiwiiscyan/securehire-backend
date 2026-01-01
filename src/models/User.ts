// src/models/User.ts
import mongoose from "../config/mongo";
import type { Document } from "mongoose";

const { Schema, model } = mongoose;

export type Role = "seeker" | "recruiter" | "issuer";
export type RoleState = "none" | "active" | "pending" | "rejected";

export interface IUser extends Document {
  privyUserId: string;              // PRIMARY ID (payload.sub)
  email?: string;                   // optional
  did?: string;                     // did:pkh... or did:privy...
  wallet_address?: string;

  roles: {
    seeker: RoleState;
    recruiter: RoleState;
    issuer: RoleState;
  };

  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<IUser>(
  {
    privyUserId: { type: String, required: true, unique: true, index: true },
    email: { type: String, index: true },
    did: { type: String, index: true },
    wallet_address: { type: String, index: true },

    roles: {
      seeker: { type: String, enum: ["none", "active", "pending", "rejected"], default: "none" },
      recruiter: { type: String, enum: ["none", "active", "pending", "rejected"], default: "none" },
      issuer: { type: String, enum: ["none", "active", "pending", "rejected"], default: "none" },
    },
  },
  { timestamps: true }
);

export default model<IUser>("User", UserSchema);