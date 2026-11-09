/**
 * Player wallet keys. Each player's wallet is a real NEAR account whose key the server generates and keeps, encrypted
 * at rest with AES-256-GCM under WALLET_KEY_SECRET. The key is used only server-side, only for that player, and is
 * never sent to the browser. (Custody model: see docs/WALLET_AND_TREASURY.md.)
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { KeyPairEd25519 } from "near-api-js";

export function newWalletKey(): { publicKey: string; privateKey: string } {
  const kp = KeyPairEd25519.fromRandom();
  return { publicKey: kp.getPublicKey().toString(), privateKey: kp.toString() };
}

export function sealKey(secret: Buffer, privateKey: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", secret, iv);
  const body = Buffer.concat([c.update(privateKey, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), body.toString("base64")].join(".");
}

export function openKey(secret: Buffer, sealed: string): string {
  const [v, iv, tag, body] = sealed.split(".");
  if (v !== "v1") throw new Error("Unknown wallet key format");
  const d = createDecipheriv("aes-256-gcm", secret, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(body, "base64")), d.final()]).toString("utf8");
}

/** A player's wallet account: deterministic from their game id, so the same player always maps to the same wallet. */
export function walletAccountId(playerId: string, parent: string): string {
  return `p${createHash("sha256").update(playerId).digest("hex").slice(0, 20)}.${parent}`;
}
