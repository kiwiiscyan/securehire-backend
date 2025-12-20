// src/services/zk.service.ts
/**
 * Thin client for your BBS+ microservice (Securehire-bbs-service).
 * Uses global fetch (Node 18+).
 */

export interface ZkVerifyVcInput {
  vc: any;
}

export interface ZkVerifyVcOutput {
  valid: boolean;
  reason?: string;
}

const ZK_BASE_URL = process.env.ZK_SERVICE_URL;

if (!ZK_BASE_URL && process.env.NODE_ENV === "production") {
  throw new Error("ZK_SERVICE_URL is required in production (Railway).");
}

const ZK_URL = ZK_BASE_URL || "http://127.0.0.1:5005";

/**
 * Internal helper: POST JSON to the BBS+ microservice.
 */
async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${ZK_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `zkService POST ${path} failed: ${res.status} ${res.statusText} – ${text}`
    );
  }

  return (await res.json()) as T;
}

/**
 * Public zkService used by /proofs and future selective-disclosure endpoints.
 */
export const zkService = {
  async verifyVc(input: ZkVerifyVcInput): Promise<ZkVerifyVcOutput> {
    return postJson<ZkVerifyVcOutput>("/bbs/verify-vc", input);
  },
};