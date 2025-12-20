// src/services/vc.service.ts
import crypto from "crypto";
import IssuerModel from "../models/Issuer";
import { ensureBbsKeyForIssuer } from "./bbsKey.service";

export type VcSection = "career" | "education" | "certification" | "recruiter";

export type CredentialType =
  | "EmploymentCredential"
  | "EducationCredential"
  | "CertificationCredential"
  | "RecruiterCredential"
  | "GenericCredential";

export interface IssueVcPayload {
  subjectDid: string;
  issuerDid: string;
  section: VcSection;
  title: string;
  credentialType: CredentialType;
  claims: Record<string, unknown>;
}

export interface RawVerifiableCredential {
  "@context"?: any;
  id: string;
  type: string[];
  issuer: string;
  issuanceDate: string;
  credentialSubject: {
    id: string;
    section: VcSection;
    title: string;
    credentialType: CredentialType;
    claims: Record<string, unknown>;
  };
  proof?: any;
}

export interface IssueVcResult {
  vcId: string;
  raw: string;
  vc: RawVerifiableCredential;
}

const BBS_BASE_URL = process.env.ZK_SERVICE_URL || "http://localhost:5005";

async function callBbsIssue(
  unsignedVc: Omit<RawVerifiableCredential, "proof">,
  issuerDid: string
): Promise<{ vcId: string; signedVc: RawVerifiableCredential }> {
  const issuerDoc = await IssuerModel.findOne({ did: issuerDid });
  if (!issuerDoc) {
    throw new Error(`Issuer not found for DID ${issuerDid}`);
  }

  const issuerWithKey = await ensureBbsKeyForIssuer(issuerDoc as any);

  const privateKeyJwk = JSON.parse(
    JSON.stringify((issuerWithKey as any).bbsPrivateKeyJwk)
  );
  const publicKeyJwk = JSON.parse(
    JSON.stringify((issuerWithKey as any).bbsPublicKeyJwk)
  );
  const verificationMethod = (issuerWithKey as any).bbsVerificationMethodId;

  if (!privateKeyJwk || !publicKeyJwk || !verificationMethod) {
    throw new Error("Issuer is missing BBS key material");
  }

  console.log("[callBbsIssue] Using BBS keys for issuer:", {
    issuerDid,
    verificationMethod,
    privateTopKeys: Object.keys(privateKeyJwk),
    publicTopKeys: Object.keys(publicKeyJwk),
    privateHasX: !!privateKeyJwk.x,
    privateHasD: !!privateKeyJwk.d,
    publicHasX: !!publicKeyJwk.x,
  });

  const res = await fetch(`${BBS_BASE_URL}/bbs/issue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      vc: unsignedVc,
      privateKeyJwk,
      publicKeyJwk,
      verificationMethod,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `/bbs/issue failed: ${res.status} ${res.statusText} — ${text}`
    );
  }

  const data = (await res.json()) as {
    signedVc?: RawVerifiableCredential;
  };

  const signedVc = data.signedVc ?? (data as any);
  const vcId = signedVc.id;

  if (!signedVc || !vcId) {
    throw new Error("Invalid /bbs/issue response: missing signedVc or id");
  }

  return { vcId, signedVc };
}

export async function issueSimpleVc(
  payload: IssueVcPayload
): Promise<IssueVcResult> {
  const randomId = crypto.randomBytes(16).toString("hex");
  const vcUri = `urn:securehire:vc:${randomId}`;
  const issuanceDate = new Date().toISOString();

  const type: string[] = ["VerifiableCredential"];
  if (payload.credentialType && !type.includes(payload.credentialType)) {
    type.push(payload.credentialType);
  }

  // ✅ FIX: Single flattened SecureHire context (no nested @context)
  const SECUREHIRE_CONTEXT = {
    "@version": 1.1,
    "sh": "urn:securehire:",
    "section": "sh:section",
    "title": "sh:title",
    "credentialType": "sh:credentialType",
    "claims": "sh:claims",
    // Add all your domain-specific terms here
    "employment": "sh:employment",
    "jobTitle": "sh:jobTitle",
    "companyName": "sh:companyName",
    "startMonth": "sh:startMonth",
    "startYear": "sh:startYear",
    "endMonth": "sh:endMonth",
    "endYear": "sh:endYear",
    "stillInRole": "sh:stillInRole",
    "description": "sh:description",
    "education": "sh:education",
    "qualification": "sh:qualification",
    "institution": "sh:institution",
    "fieldOfStudy": "sh:fieldOfStudy",
    "stillStudying": "sh:stillStudying",
    "certification": "sh:certification",
    "name": "sh:name",
    "issuer": "sh:issuer",
    "issueMonth": "sh:issueMonth",
    "issueYear": "sh:issueYear",
    "expiryMonth": "sh:expiryMonth",
    "expiryYear": "sh:expiryYear",
    "doesNotExpire": "sh:doesNotExpire"
  };

  const unsignedVc: Omit<RawVerifiableCredential, "proof"> = {
    "@context": [
      "https://www.w3.org/2018/credentials/v1",
      "https://w3id.org/security/bbs/v1",
      SECUREHIRE_CONTEXT,  // ✅ Single, flat context object
    ],
    id: vcUri,
    type,
    issuer: payload.issuerDid,
    issuanceDate,
    credentialSubject: {
      id: payload.subjectDid,
      section: payload.section,
      title: payload.title,
      credentialType: payload.credentialType,
      claims: payload.claims,
    },
  };

  const { vcId: finalId, signedVc } = await callBbsIssue(unsignedVc, payload.issuerDid);

  return {
    vcId: finalId,
    raw: JSON.stringify(signedVc),
    vc: signedVc,
  };
}