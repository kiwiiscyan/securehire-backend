// src/services/chain.service.ts
import { ethers } from "ethers";
import TrustBadgeRegistryArtifact from "../abi/TrustBadgeRegistry.json";

export type ChainStatus =
  | { status: "verified"; lastUpdated: string }
  | { status: "revoked"; reason: string }
  | { status: "expired"; reason: string }
  | { status: "not_found" };

// ---------- TrustBadgeRegistry config ----------

// Use ABI from the Hardhat artifact
const TRUST_BADGE_ABI = TrustBadgeRegistryArtifact
  .abi as ethers.InterfaceAbi;

// RPC + contract + relayer key
const POLYGON_RPC = process.env.POLYGON_RPC;
const TRUST_BADGE_REGISTRY_ADDR = process.env.TRUST_BADGE_REGISTRY_ADDR;

// allow either new name or your previous SERVER_PK
const TRUST_BADGE_RELAYER_KEY = process.env.SERVER_PK;

function getRelayerSigner() {
  if (!POLYGON_RPC || !TRUST_BADGE_RELAYER_KEY) {
    throw new Error(
      "Trust badge relayer env vars missing (POLYGON_RPC, TRUST_BADGE_REGISTRY_ADDR, TRUST_BADGE_RELAYER_KEY/SERVER_PK)"
    );
  }
  const provider = new ethers.JsonRpcProvider(POLYGON_RPC);
  return new ethers.Wallet(TRUST_BADGE_RELAYER_KEY, provider);
}

function getTrustBadgeRegistryContract() {
  if (!TRUST_BADGE_REGISTRY_ADDR) {
    throw new Error("TRUST_BADGE_REGISTRY_ADDR not set");
  }
  const signer = getRelayerSigner();
  return new ethers.Contract(
    TRUST_BADGE_REGISTRY_ADDR,
    TRUST_BADGE_ABI,
    signer
  );
}

/**
 * Called when an issuer approves a recruiter in /issuer/recruiters/:id/approve
 * Issues an on-chain trust badge using the relayer wallet.
 */
export async function issueRecruiterBadgeOnChain(
  did: string,
  level: number
): Promise<{ txHash: string; network: string }> {
  const contract = getTrustBadgeRegistryContract();
  const tx = await contract.issueBadge(did, level);
  const receipt = await tx.wait();

  return {
    txHash: receipt.hash,
    network: "polygon-amoy",
  };
}

/**
 * Used by jobs service to tag trustStatus on each job.
 */
export async function getRecruiterTrustStatusFromChain(
  did: string
): Promise<"Active" | "Suspended" | "Revoked" | "None"> {
  try {
    const contract = getTrustBadgeRegistryContract();
    const [level, status] = await contract.getBadge(did);

    if (Number(level) === 0) return "None";

    const s = Number(status);
    if (s === 1) return "Active";
    if (s === 2) return "Suspended";
    if (s === 3) return "Revoked";

    return "None";
  } catch (err) {
    console.error("getRecruiterTrustStatusFromChain error:", err);
    return "None";
  }
}

/**
 * Stub used by your previous VC status code.
 * You can later replace this with real on-chain VC status reads.
 */
export async function readOnChainStatus(
  _didOrAddr: string,
  _credentialId: string
): Promise<ChainStatus> {
  return {
    status: "verified",
    lastUpdated: new Date().toISOString(),
  };
}