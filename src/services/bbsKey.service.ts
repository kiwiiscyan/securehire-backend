// src/services/bbsKey.service.ts
import type { Document } from "mongoose";
import { Bls12381G2KeyPair } from "@mattrglobal/bls12381-key-pair";
import { IIssuer } from "../models/Issuer";

interface BbsKeyMaterial {
  privateJwk: any;
  publicJwk: any;
}

async function generateBbsKeyPair(): Promise<BbsKeyMaterial> {
  const generated: any = await Bls12381G2KeyPair.generate();

  // Newer MATTR style: export({ type: "JsonWebKey2020" })
  if (generated && typeof generated.export === "function") {
    const privateExport = await generated.export({
      type: "JsonWebKey2020",
      privateKey: true,
    });

    const publicExport = await generated.export({
      type: "JsonWebKey2020",
      privateKey: false,
    });

    // Normalise to the actual JsonWebKey objects
    const privateJwk =
      (privateExport as any).privateKeyJwk ??
      (privateExport as any).publicKeyJwk ??
      privateExport;

    const publicJwk =
      (publicExport as any).publicKeyJwk ?? publicExport;

    return { privateJwk, publicJwk };
  }

  // Older style fallback (generate() already returns JWKs directly)
  if (generated && (generated.privateKeyJwk || generated.publicKeyJwk)) {
    return {
      privateJwk: generated.privateKeyJwk ?? generated.publicKeyJwk,
      publicJwk: generated.publicKeyJwk ?? generated.privateKeyJwk,
    };
  }

  throw new Error(
    "Unexpected return type from Bls12381G2KeyPair.generate() – cannot derive BBS key material",
  );
}

export async function ensureBbsKeyForIssuer<
  T extends IIssuer & Document
>(issuer: T): Promise<T> {
  /*
  if (
    issuer.bbsPrivateKeyJwk &&
    issuer.bbsPublicKeyJwk &&
    issuer.bbsVerificationMethodId
  ) {
    return issuer;
  }
  */

  if (issuer.bbsPrivateKeyJwk && issuer.bbsPublicKeyJwk && issuer.bbsVerificationMethodId) {
    // Normalize legacy curve labels to MATTR expected value
    const fix = (jwk: any) => {
      if (!jwk || typeof jwk !== "object") return jwk;
      const out = { ...jwk };

      // Accept legacy spellings and normalize
      if (out.crv === "Bls12381G2" || out.crv === "bls12381g2" || out.crv === "BLS12381G2") {
        out.crv = "BLS12381_G2";
      }
      // Also normalize key type (harmless)
      if (out.kty !== "EC") out.kty = "EC";

      return out;
    };

    const beforePriv = issuer.bbsPrivateKeyJwk?.crv;
    const beforePub = issuer.bbsPublicKeyJwk?.crv;

    issuer.bbsPrivateKeyJwk = fix(issuer.bbsPrivateKeyJwk);
    issuer.bbsPublicKeyJwk = fix(issuer.bbsPublicKeyJwk);

    const changed =
      beforePriv !== issuer.bbsPrivateKeyJwk?.crv || beforePub !== issuer.bbsPublicKeyJwk?.crv;

    if (changed) {
      await issuer.save();
    }

    return issuer;
  }

  if (!issuer.did) {
    throw new Error(
      "Issuer.did is missing – please onboard issuer with a DID before generating BBS keys",
    );
  }

  const { privateJwk, publicJwk } = await generateBbsKeyPair();

  const vmId = `${issuer.did}#bbs-key-1`;

  issuer.bbsPrivateKeyJwk = privateJwk;
  issuer.bbsPublicKeyJwk = publicJwk;
  issuer.bbsVerificationMethodId = vmId;

  await issuer.save();
  return issuer;
}