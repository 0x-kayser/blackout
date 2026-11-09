/**
 * Talks to NEAR testnet. Every transaction is signed first, its hash recorded (so a crash mid-broadcast can still be
 * reconciled), then broadcast and awaited to FINAL. "settled" comes only from a final, successful execution outcome
 * with no failed receipt; a hash on its own proves nothing.
 */
import { createHash } from "node:crypto";
import { Account, JsonRpcProvider, PublicKey, actions, baseEncode, encodeTransaction, nearToYocto, teraToGas, type KeyPairString } from "near-api-js";
import { interpretTxResult, rpc } from "../chain.ts";
import type { EconomyConfig } from "./config.ts";

export type Signer = { kind: "operator" } | { kind: "npc"; id: string } | { kind: "player-parent" } | { kind: "key"; accountId: string; privateKey: string };

export interface GatewayResult {
  status: "settled" | "failed" | "pending";
  txHash: string | null;
  signerId: string;
  detail: string;
}

export interface ChainGateway {
  readonly cfg: EconomyConfig;
  call(signer: Signer, method: string, args: Record<string, unknown>, opts?: { depositYocto?: bigint; onSigned?: (txHash: string) => void }): Promise<GatewayResult>;
  createSubAccount(newAccountId: string, publicKey: string, onSigned?: (txHash: string) => void): Promise<GatewayResult>;
  view<T>(method: string, args: Record<string, unknown>): Promise<T>;
  accountExists(accountId: string): Promise<boolean>;
  lookup(txHash: string, signerId: string): Promise<GatewayResult>;
}

export class NearGateway implements ChainGateway {
  private readonly provider: JsonRpcProvider;
  constructor(readonly cfg: EconomyConfig) {
    this.provider = new JsonRpcProvider({ url: cfg.rpcUrl });
  }

  private signer(s: Signer): { accountId: string; privateKey: string } {
    switch (s.kind) {
      case "operator":
        return this.cfg.operator!;
      case "player-parent":
        return this.cfg.playerParent!;
      case "key":
        return { accountId: s.accountId, privateKey: s.privateKey };
      case "npc": {
        const n = this.cfg.npcs[s.id];
        if (!n?.privateKey) throw new Error(`No signing key configured for NPC ${s.id}`);
        return { accountId: n.accountId, privateKey: n.privateKey };
      }
    }
  }

  private async send(s: Signer, receiverId: string, acts: ReturnType<typeof actions.functionCall>[], onSigned?: (txHash: string) => void): Promise<GatewayResult> {
    const { accountId, privateKey } = this.signer(s);
    const account = new Account(accountId, this.provider, privateKey as KeyPairString);
    const signed = await account.createSignedTransaction({ receiverId, actions: acts });
    const txHash = baseEncode(createHash("sha256").update(encodeTransaction(signed.transaction)).digest());
    onSigned?.(txHash);
    try {
      const r = await this.provider.sendTransactionUntil(signed, "FINAL");
      return this.toResult(interpretTxResult(txHash, r), accountId);
    } catch (e) {
      // a broadcast error doesn't mean it failed on chain: the reconciler looks it up later
      return { status: "pending", txHash, signerId: accountId, detail: `broadcast: ${(e as Error).message}`.slice(0, 400) };
    }
  }

  private toResult(r: ReturnType<typeof interpretTxResult>, signerId: string): GatewayResult {
    if (r.status === "confirmed") return { status: "settled", txHash: r.txHash, signerId, detail: r.detail };
    if (r.status === "failed") return { status: "failed", txHash: r.txHash, signerId, detail: r.detail };
    return { status: "pending", txHash: r.txHash, signerId, detail: r.detail };
  }

  call(signer: Signer, method: string, args: Record<string, unknown>, opts: { depositYocto?: bigint; onSigned?: (txHash: string) => void } = {}): Promise<GatewayResult> {
    return this.send(signer, this.cfg.contractId!, [actions.functionCall(method, args, teraToGas(60), opts.depositYocto ?? 0n)], opts.onSigned);
  }

  createSubAccount(newAccountId: string, publicKey: string, onSigned?: (txHash: string) => void): Promise<GatewayResult> {
    return this.send({ kind: "player-parent" }, newAccountId, [actions.createAccount(), actions.transfer(nearToYocto(this.cfg.walletNear as `${number}`)), actions.addFullAccessKey(PublicKey.fromString(publicKey))] as never, onSigned);
  }

  async view<T>(method: string, args: Record<string, unknown>): Promise<T> {
    const r = await rpc<{ result: number[] }>(this.cfg.rpcUrl, "query", { request_type: "call_function", finality: "final", account_id: this.cfg.contractId, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
    return JSON.parse(Buffer.from(r.result).toString("utf8")) as T;
  }

  async accountExists(accountId: string): Promise<boolean> {
    try {
      await rpc(this.cfg.rpcUrl, "query", { request_type: "view_account", finality: "final", account_id: accountId });
      return true;
    } catch {
      return false;
    }
  }

  async lookup(txHash: string, signerId: string): Promise<GatewayResult> {
    try {
      const r = await rpc<unknown>(this.cfg.rpcUrl, "tx", { tx_hash: txHash, sender_account_id: signerId, wait_until: "FINAL" }, 15_000);
      return this.toResult(interpretTxResult(txHash, r), signerId);
    } catch (e) {
      return { status: "pending", txHash, signerId, detail: (e as Error).message };
    }
  }
}
