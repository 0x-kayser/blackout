/**
 * Gasless play (§24–26): a NEP-366 meta-transaction relayer.
 *
 * A player's key (in their browser, passkey device or wallet, or the game's custodial key for namespaced players)
 * signs a DelegateAction; this relayer wraps it in a transaction it signs and pays for. It relays only:
 *   * to the BLACKOUT resource contract,
 *   * function calls on an allowlist of game methods, with ≤ 1 yoctoNEAR deposit and bounded gas,
 *   * with a valid ed25519 signature by the delegate's public key over the NEP-366-prefixed encoding,
 *   * before the delegate's max block height,
 *   * at most RELAY_PER_MINUTE requests per player (counted from the database, so restarts don't reset it),
 *   * once per (player, idempotency key): a retry returns the stored result.
 * Every request, accepted or rejected, is persisted.
 */
import { createHash, randomUUID } from "node:crypto";
import { Account, JsonRpcProvider, KeyPair, PublicKey, Signature, actions, baseDecode, baseEncode, buildDelegateAction, encodeDelegateAction, encodeTransaction, teraToGas, type KeyPairString } from "near-api-js";
import { nowIso, type Db } from "./db.ts";

export const RELAY_METHODS = ["nft_transfer", "nft_approve", "nft_revoke", "plant_withdraw", "plant_list", "plant_cancel_listing", "plant_buy", "mt_transfer", "release_to_owner"] as const;
export const RELAY_PER_MINUTE = 6;
const MAX_GAS = 100n * 10n ** 12n;

export interface DelegateRequest {
  senderId: string;
  receiverId: string;
  nonce: string;
  maxBlockHeight: string;
  publicKey: string;
  actions: { methodName: string; args: Record<string, unknown>; gas: string; deposit: string }[];
  /** base58 ed25519 signature over sha256(encodeDelegateAction(delegate)) */
  signature: string;
}

export interface RelayConfig {
  enabled: boolean;
  rpcUrl: string;
  receiverId: string | null;
  relayerAccountId: string | null;
  relayerPrivateKey: string | null;
}

export function loadRelayConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const receiverId = env.NEAR_RESOURCE_CONTRACT_ID || null;
  const relayerAccountId = env.NEAR_RELAYER_ACCOUNT_ID || null;
  const relayerPrivateKey = env.NEAR_RELAYER_PRIVATE_KEY || null;
  return { enabled: env.NEAR_CHAIN_ENABLED === "true" && !!(receiverId && relayerAccountId && relayerPrivateKey), rpcUrl: env.NEAR_RPC_URL || "https://test.rpc.fastnear.com", receiverId, relayerAccountId, relayerPrivateKey };
}

export type RelaySubmit = (cfg: RelayConfig, req: DelegateRequest) => Promise<{ txHash: string; ok: boolean; detail: string }>;
export type RelayResult = { requestId: string; status: "rejected" | "submitted" | "succeeded" | "failed"; txHash: string | null; error: string | null; replayed?: boolean };

function toDelegate(req: DelegateRequest) {
  return buildDelegateAction({
    senderId: req.senderId,
    receiverId: req.receiverId,
    nonce: BigInt(req.nonce),
    maxBlockHeight: BigInt(req.maxBlockHeight),
    publicKey: PublicKey.fromString(req.publicKey),
    actions: req.actions.map((a) => actions.functionCall(a.methodName, a.args, BigInt(a.gas), BigInt(a.deposit))),
  });
}

/** Signs a delegate action (used by the game for custodial namespaced players, by tests, and by clients). */
export function signDelegate(senderId: string, key: string, receiverId: string, calls: DelegateRequest["actions"], nonce: bigint, maxBlockHeight: bigint): DelegateRequest {
  const kp = KeyPair.fromString(key as KeyPairString)
  const base = { senderId, receiverId, nonce: String(nonce), maxBlockHeight: String(maxBlockHeight), publicKey: kp.getPublicKey().toString(), actions: calls, signature: "" };
  const digest = createHash("sha256").update(encodeDelegateAction(toDelegate(base))).digest();
  base.signature = baseEncode(kp.sign(new Uint8Array(digest)).signature);
  return base;
}

/** Why a delegate request may not be relayed, or null. */
export function checkDelegate(cfg: RelayConfig, req: DelegateRequest, currentHeight: bigint | null = null): string | null {
  if (!cfg.receiverId || req.receiverId !== cfg.receiverId) return "Only calls to the BLACKOUT contract are relayed.";
  if (!req.actions.length || req.actions.length > 3) return "One to three actions per request.";
  for (const a of req.actions) {
    if (!(RELAY_METHODS as readonly string[]).includes(a.methodName)) return `Method ${a.methodName} is not relayed.`;
    if (BigInt(a.deposit) > 1n) return "Relayed calls may attach at most 1 yoctoNEAR.";
    if (BigInt(a.gas) > MAX_GAS || BigInt(a.gas) <= 0n) return "Gas out of bounds.";
  }
  if (currentHeight !== null && BigInt(req.maxBlockHeight) <= currentHeight) return "This request has expired.";
  try {
    const digest = createHash("sha256").update(encodeDelegateAction(toDelegate(req))).digest();
    const pk = PublicKey.fromString(req.publicKey);
    if (!pk.verify(new Uint8Array(digest), baseDecode(req.signature))) return "Signature does not match.";
  } catch (e) {
    return `Malformed request: ${(e as Error).message}`;
  }
  return null;
}

export const defaultSubmit: RelaySubmit = async (cfg, req) => {
  const provider = new JsonRpcProvider({ url: cfg.rpcUrl });
  const relayer = new Account(cfg.relayerAccountId!, provider, cfg.relayerPrivateKey as KeyPairString);
  const delegate = toDelegate(req);
  const signed = await relayer.createSignedTransaction({
    receiverId: req.senderId,
    actions: [actions.signedDelegate({ delegateAction: delegate, signature: new Signature({ keyType: PublicKey.fromString(req.publicKey).keyType, data: baseDecode(req.signature) }) })],
  });
  const txHash = baseEncode(createHash("sha256").update(encodeTransaction(signed.transaction)).digest());
  try {
    await provider.sendTransactionUntil(signed, "FINAL");
    return { txHash, ok: true, detail: "final" };
  } catch (e) {
    return { txHash, ok: false, detail: (e as Error).message };
  }
};
void teraToGas;

export class Relayer {
  constructor(
    private readonly db: Db,
    readonly cfg: RelayConfig,
    private readonly submit: RelaySubmit = defaultSubmit,
    private readonly now: () => number = Date.now,
  ) {}

  async relay(userId: string, idempotencyKey: string, req: DelegateRequest): Promise<RelayResult> {
    const prior = this.db.prepare("SELECT request_id, status, tx_hash, error FROM relay_requests WHERE user_id = ? AND idempotency_key = ?").get(userId, idempotencyKey) as { request_id: string; status: RelayResult["status"]; tx_hash: string | null; error: string | null } | undefined;
    if (prior) return { requestId: prior.request_id, status: prior.status, txHash: prior.tx_hash, error: prior.error, replayed: true };
    const recent = (this.db.prepare("SELECT COUNT(*) AS n FROM relay_requests WHERE user_id = ? AND created_ms > ? AND status != 'rejected'").get(userId, this.now() - 60_000) as { n: number }).n;
    let why = recent >= RELAY_PER_MINUTE ? "Too many requests: try again in a minute." : !this.cfg.enabled ? "Gasless transactions aren't configured on this server." : checkDelegate(this.cfg, req);
    const requestId = randomUUID();
    const payloadHash = createHash("sha256").update(JSON.stringify(req)).digest("hex");
    const at = nowIso();
    this.db
      .prepare("INSERT INTO relay_requests (request_id, user_id, idempotency_key, sender_id, receiver_id, methods, payload_hash, status, tx_hash, error, created_at, created_ms, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)")
      .run(requestId, userId, idempotencyKey, req.senderId, req.receiverId, req.actions.map((a) => a.methodName).join(","), payloadHash, why ? "rejected" : "submitted", why, at, this.now(), at);
    if (why) return { requestId, status: "rejected", txHash: null, error: why };
    try {
      const r = await this.submit(this.cfg, req);
      const status = r.ok ? "succeeded" : "failed";
      this.db.prepare("UPDATE relay_requests SET status = ?, tx_hash = ?, error = ?, updated_at = ? WHERE request_id = ?").run(status, r.txHash, r.ok ? null : r.detail, nowIso(), requestId);
      return { requestId, status, txHash: r.txHash, error: r.ok ? null : r.detail };
    } catch (e) {
      why = (e as Error).message;
      this.db.prepare("UPDATE relay_requests SET status = 'failed', error = ?, updated_at = ? WHERE request_id = ?").run(why, nowIso(), requestId);
      return { requestId, status: "failed", txHash: null, error: why };
    }
  }
}
