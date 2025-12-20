import { ethers } from "ethers";
import DIDRegistryArtifact from "../abi/DIDRegistry.json";

const RPC = process.env.POLYGON_RPC!;
const REGISTRY_ADDRESS = process.env.DID_REGISTRY_ADDRESS!;

const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(process.env.SERVER_PK!, provider);
const registry = new ethers.Contract(
  REGISTRY_ADDRESS,
  DIDRegistryArtifact.abi,
  wallet
);

export async function registerDidOnChain(owner: string, did: string, docHash: string) {
  const tx = await registry.registerDID(did, docHash);
  const receipt = await tx.wait();
  return receipt.transactionHash;
}