/**
 * NEAR testnet adapter. Chain mode is ON only when every required variable is
 * present; otherwise the game runs as an honest guest simulation and the API
 * reports `mode: "disabled"`. Nothing here ever invents an account id, contract
 * id or transaction hash: hashes come from the signed transaction we broadcast,
 * and "confirmed" comes only from an RPC final execution outcome.
 */
import { createHash } from "node:crypto";
import { Account, JsonRpcProvider, actions, baseEncode, encodeTransaction, teraToGas, type KeyPairString } from "near-api-js";

export interface ChainConfig {
  enabled: boolean;
  network: "testnet";
  rpcUrl: string;
  explorerTxBase: string;
  resourceContractId: string | null;
  vaultAccountId: string | null;
  vaultOperatorPrivateKey: string | null;
  rivalAccountId: string | null;
  merchants: Record<string, { accountId: string | null; privateKey: string | null }>;
  missing: string[];
}

export const TOKEN_IDS = ["DIESEL_100ML", "CARBON_PERMIT_10KG", "REPAIR_PART", "SOLAR_COMPONENT", "BATTERY_COMPONENT"];
export const MERCHANT_IDS = ["ember", "lantern", "harbor"];

export function loadChainConfig(env: NodeJS.ProcessEnv = process.env): ChainConfig {
  const merchants: ChainConfig["merchants"] = {};
  const missing: string[] = [];
  const need = (k: string) => {
    const v = env[k]?.trim();
    if (!v) missing.push(k);
    return v || null;
  };
  const contract = need("NEAR_RESOURCE_CONTRACT_ID");
  const vault = need("NEAR_VAULT_ACCOUNT_ID");
  const vaultOperatorPrivateKey = need("NEAR_VAULT_OPERATOR_PRIVATE_KEY");
  for (const m of MERCHANT_IDS) {
    const up = m.toUpperCase();
    merchants[m] = { accountId: need(`NEAR_MERCHANT_${up}_ACCOUNT_ID`), privateKey: need(`NEAR_MERCHANT_${up}_PRIVATE_KEY`) };
  }
  const enabledFlag = (env.NEAR_CHAIN_ENABLED ?? "false").toLowerCase() === "true";
  if (!enabledFlag) missing.unshift("NEAR_CHAIN_ENABLED=true");
  return {
    enabled: enabledFlag && missing.length === 0,
    network: "testnet",
    rpcUrl: env.NEAR_RPC_URL?.trim() || "https://rpc.testnet.near.org",
    explorerTxBase: env.NEAR_EXPLORER_TX_BASE?.trim() || "https://testnet.nearblocks.io/txns/",
    resourceContractId: contract,
    vaultAccountId: vault,
    vaultOperatorPrivateKey,
    rivalAccountId: env.NEAR_RIVAL_ACCOUNT_ID?.trim() || null,
    merchants,
    missing,
  };
}

/** Minimal JSON-RPC client for read paths (status, view calls, tx lookups). */
export async function rpc<T>(url: string, method: string, params: unknown, timeoutMs = 8_000): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "blackout", method, params }),
      signal: ctl.signal,
    });
    const json = (await res.json()) as { result?: T; error?: { name?: string; cause?: { name?: string }; message?: string; data?: unknown } };
    if (json.error) {
      const e = new Error(json.error.cause?.name ?? json.error.name ?? json.error.message ?? "RPC_ERROR");
      (e as Error & { rpc?: unknown }).rpc = json.error;
      throw e;
    }
    return json.result as T;
  } finally {
    clearTimeout(timer);
  }
}

export type TxLookup =
  | { status: "confirmed"; txHash: string; signerId: string; receiverId: string; detail: string }
  | { status: "failed"; txHash: string; signerId: string; receiverId: string; detail: string }
  | { status: "pending"; txHash: string; detail: string }
  | { status: "unknown"; txHash: string; detail: string };

/** Interprets an RPC `tx` response. Exported for unit tests against recorded shapes. */
export function interpretTxResult(txHash: string, r: any): TxLookup {
  const signerId = r?.transaction?.signer_id ?? "";
  const receiverId = r?.transaction?.receiver_id ?? "";
  const st = r?.status;
  if (st && typeof st === "object" && "Failure" in st) {
    return { status: "failed", txHash, signerId, receiverId, detail: JSON.stringify(st.Failure).slice(0, 400) };
  }
  // A transaction can succeed while a receipt fails; check every receipt outcome.
  const failedReceipt = (r?.receipts_outcome ?? []).find((o: any) => o?.outcome?.status && "Failure" in o.outcome.status);
  if (failedReceipt) {
    return { status: "failed", txHash, signerId, receiverId, detail: JSON.stringify(failedReceipt.outcome.status.Failure).slice(0, 400) };
  }
  if (st && typeof st === "object" && ("SuccessValue" in st || "SuccessReceiptId" in st)) {
    const fin = r?.final_execution_status;
    if (!fin || fin === "FINAL" || fin === "EXECUTED" || fin === "EXECUTED_OPTIMISTIC") {
      return { status: "confirmed", txHash, signerId, receiverId, detail: `final_execution_status=${fin ?? "n/a"}` };
    }
  }
  return { status: "pending", txHash, detail: `final_execution_status=${r?.final_execution_status ?? "unknown"}` };
}

export async function lookupTx(cfg: ChainConfig, txHash: string, senderId: string): Promise<TxLookup> {
  try {
    const r = await rpc<any>(cfg.rpcUrl, "tx", { tx_hash: txHash, sender_account_id: senderId, wait_until: "FINAL" }, 15_000);
    return interpretTxResult(txHash, r);
  } catch (e) {
    const name = (e as Error).message;
    if (name === "UNKNOWN_TRANSACTION") return { status: "unknown", txHash, detail: "RPC does not know this transaction (yet)" };
    if (name === "TIMEOUT_ERROR" || (e as Error).name === "AbortError") return { status: "pending", txHash, detail: "RPC timeout" };
    return { status: "unknown", txHash, detail: name };
  }
}

export async function viewCall<T>(cfg: ChainConfig, accountId: string, method: string, args: object): Promise<T> {
  const r = await rpc<{ result: number[] }>(cfg.rpcUrl, "query", {
    request_type: "call_function",
    finality: "final",
    account_id: accountId,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  return JSON.parse(Buffer.from(r.result).toString("utf8")) as T;
}

export interface ChainStatus {
  rpcReachable: boolean | null;
  contractDeployed: boolean | null;
  issues: string[];
}

export async function chainStatus(cfg: ChainConfig): Promise<ChainStatus> {
  if (!cfg.enabled) return { rpcReachable: null, contractDeployed: null, issues: [`Chain mode disabled; missing: ${cfg.missing.join(", ")}`] };
  const issues: string[] = [];
  let rpcReachable = false;
  let deployed: boolean | null = null;
  try {
    const st = await rpc<{ chain_id: string }>(cfg.rpcUrl, "status", [], 5_000);
    rpcReachable = true;
    if (st.chain_id !== "testnet") issues.push(`RPC chain_id is ${st.chain_id}, expected testnet`);
  } catch (e) {
    issues.push(`RPC unreachable: ${(e as Error).message}`);
  }
  if (rpcReachable && cfg.resourceContractId) {
    try {
      const acct = await rpc<{ code_hash: string }>(cfg.rpcUrl, "query", { request_type: "view_account", finality: "final", account_id: cfg.resourceContractId });
      deployed = acct.code_hash !== "11111111111111111111111111111111";
      if (!deployed) issues.push(`${cfg.resourceContractId} exists but has no contract code`);
    } catch (e) {
      deployed = false;
      issues.push(`Contract account lookup failed: ${(e as Error).message}`);
    }
  }
  return { rpcReachable, contractDeployed: deployed, issues };
}

export interface SubmitResult {
  txHash: string;
  signerId: string;
  outcome: TxLookup;
}

/**
 * Merchant NPC sells diesel to the custodial game vault via the resource
 * contract's `npc_transfer` method. Signed with the merchant's FUNCTION-CALL key
 * (scoped to the resource contract, zero deposit). `trade_key` makes the contract
 * call idempotent: a retry of the same trade is rejected on-chain.
 */
export async function submitMerchantSale(
  cfg: ChainConfig,
  merchantId: string,
  tradeKey: string,
  tokenId: string,
  amount: string,
  onSigned: (txHash: string, signerId: string) => void = () => {},
): Promise<SubmitResult> {
  const m = cfg.merchants[merchantId];
  if (!cfg.enabled || !m?.accountId || !m.privateKey || !cfg.resourceContractId || !cfg.vaultAccountId) throw new Error("CHAIN_UNAVAILABLE");
  const provider = new JsonRpcProvider({ url: cfg.rpcUrl });
  const account = new Account(m.accountId, provider, m.privateKey as KeyPairString);
  const signed = await account.createSignedTransaction({
    receiverId: cfg.resourceContractId,
    actions: [
      actions.functionCall(
        "npc_transfer",
        { receiver_id: cfg.vaultAccountId, token_id: tokenId, amount, memo: `blackout:${tradeKey}`, trade_id: tradeKey },
        teraToGas(30),
        0n,
      ),
    ],
  });
  // The hash is derived from the signed bytes BEFORE broadcast, so a dropped
  // response can still be reconciled by hash (or by the contract's trade_status view).
  const txHash = baseEncode(createHash("sha256").update(encodeTransaction(signed.transaction)).digest());
  onSigned(txHash, m.accountId); // persisted by the caller before the bytes leave this process
  try {
    const r = await provider.sendTransactionUntil(signed, "FINAL");
    return { txHash, signerId: m.accountId, outcome: interpretTxResult(txHash, r) };
  } catch (e) {
    return { txHash, signerId: m.accountId, outcome: { status: "pending", txHash, detail: `broadcast error: ${(e as Error).message}` } };
  }
}

async function submitFunctionCall(
  cfg: ChainConfig,
  signerId: string,
  privateKey: string,
  methodName: string,
  args: Record<string, unknown>,
  onSigned: (txHash: string, signerId: string) => void = () => {},
): Promise<SubmitResult> {
  if (!cfg.enabled || !cfg.resourceContractId) throw new Error("CHAIN_UNAVAILABLE");
  const provider = new JsonRpcProvider({ url: cfg.rpcUrl });
  const account = new Account(signerId, provider, privateKey as KeyPairString);
  const signed = await account.createSignedTransaction({
    receiverId: cfg.resourceContractId,
    actions: [actions.functionCall(methodName, args, teraToGas(30), 0n)],
  });
  const txHash = baseEncode(createHash("sha256").update(encodeTransaction(signed.transaction)).digest());
  onSigned(txHash, signerId);
  try {
    const r = await provider.sendTransactionUntil(signed, "FINAL");
    return { txHash, signerId, outcome: interpretTxResult(txHash, r) };
  } catch (e) {
    return { txHash, signerId, outcome: { status: "pending", txHash, detail: `broadcast error: ${(e as Error).message}` } };
  }
}

/** Escrow a player's game-allocated resource through the restricted vault operator key. */
export async function submitCustodialListing(cfg: ChainConfig, sellerId: string, listingId: string, tokenId: string, amount: string, unitPriceCc: string, onSigned: (txHash: string, signerId: string) => void = () => {}): Promise<SubmitResult> {
  if (!cfg.vaultAccountId || !cfg.vaultOperatorPrivateKey) throw new Error("CHAIN_UNAVAILABLE");
  return submitFunctionCall(cfg, cfg.vaultAccountId, cfg.vaultOperatorPrivateKey, "custodial_list", { seller_id: sellerId, listing_id: listingId, token_id: tokenId, amount, unit_price_cc: unitPriceCc }, onSigned);
}

/** Return an active player's escrow to the custodial vault. */
export async function submitCancelListing(cfg: ChainConfig, listingId: string, onSigned: (txHash: string, signerId: string) => void = () => {}): Promise<SubmitResult> {
  if (!cfg.vaultAccountId || !cfg.vaultOperatorPrivateKey) throw new Error("CHAIN_UNAVAILABLE");
  return submitFunctionCall(cfg, cfg.vaultAccountId, cfg.vaultOperatorPrivateKey, "custodial_cancel_listing", { listing_id: listingId }, onSigned);
}

/** The restricted game operator settles an approved NPC purchase from existing escrow. */
export async function submitNpcListingPurchase(cfg: ChainConfig, listingId: string, buyerAccountId: string, onSigned: (txHash: string, signerId: string) => void = () => {}): Promise<SubmitResult> {
  if (!cfg.vaultAccountId || !cfg.vaultOperatorPrivateKey) throw new Error("CHAIN_UNAVAILABLE");
  return submitFunctionCall(cfg, cfg.vaultAccountId, cfg.vaultOperatorPrivateKey, "custodial_fill_listing", { listing_id: listingId, buyer_id: buyerAccountId }, onSigned);
}

/** Contract listing view used to reconcile transactions whose RPC receipt is delayed. */
export async function contractListing(cfg: ChainConfig, listingId: string): Promise<{ status: string; sellerId: string; buyerId: string | null; detail: string } | null> {
  if (!cfg.resourceContractId) return null;
  const r = await viewCall<{ status: string; seller_id: string; buyer_id: string | null; listing_id: string } | null>(cfg, cfg.resourceContractId, "listing", { listing_id: listingId });
  return r ? { status: r.status, sellerId: r.seller_id, buyerId: r.buyer_id, detail: `contract listing ${r.listing_id} is ${r.status}` } : null;
}

/** Reconciliation path that does not need the tx hash: ask the contract. */
export async function contractTradeStatus(cfg: ChainConfig, tradeKey: string): Promise<{ settled: boolean; detail: string }> {
  if (!cfg.resourceContractId) return { settled: false, detail: "no contract" };
  const r = await viewCall<{ seller_id: string; amount: string } | null>(cfg, cfg.resourceContractId, "trade_status", { trade_id: tradeKey });
  return r ? { settled: true, detail: `contract recorded trade by ${r.seller_id} amount ${r.amount}` } : { settled: false, detail: "contract has no record of this trade" };
}
