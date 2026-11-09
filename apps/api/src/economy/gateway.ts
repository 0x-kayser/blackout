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

/** Free RPC endpoints rate-limit; these errors mean "try again, maybe elsewhere", never "it failed on chain". */
export const TRANSIENT = /429|Rate limit|rate limits|TIMEOUT|timed out|aborted|AbortError|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|503|502/i;

/**
 * Paces every RPC call: at most `max` in flight and at least `gapMs` between starts, so the game never floods a free
 * endpoint (FastNear's free tier answers floods with 429s).
 */
class Pacer {
  private active = 0;
  private last = 0;
  private queue: (() => void)[] = [];
  constructor(private readonly max = 3, private readonly gapMs = 120) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await new Promise<void>((go) => {
      const tryGo = () => {
        if (this.active < this.max) {
          this.active++;
          const wait = Math.max(0, this.last + this.gapMs - Date.now());
          this.last = Date.now() + wait;
          setTimeout(go, wait);
        } else this.queue.push(tryGo);
      };
      tryGo();
    });
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

export class NearGateway implements ChainGateway {
  private readonly providers: JsonRpcProvider[];
  private readonly pacer = new Pacer();
  /** Index of the endpoint that last worked; we start there. */
  private at = 0;
  constructor(readonly cfg: EconomyConfig) {
    this.providers = (cfg.rpcUrls?.length ? cfg.rpcUrls : [cfg.rpcUrl]).map((url) => new JsonRpcProvider({ url }));
  }
  private get provider(): JsonRpcProvider {
    return this.providers[this.at];
  }
  private get urls(): string[] {
    return this.cfg.rpcUrls?.length ? this.cfg.rpcUrls : [this.cfg.rpcUrl];
  }

  /** Runs `fn` against each endpoint in turn while they rate-limit or time out. */
  private async failover<T>(fn: (i: number) => Promise<T>): Promise<T> {
    let err: unknown;
    for (let k = 0; k < this.providers.length; k++) {
      const i = (this.at + k) % this.providers.length;
      try {
        const r = await this.pacer.run(() => fn(i));
        this.at = i;
        return r;
      } catch (e) {
        err = e;
        if (!TRANSIENT.test(String((e as Error)?.message ?? e))) throw e;
      }
    }
    throw err;
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
    // signing reads the nonce and a recent block hash, so it goes through the same pacing and failover
    const signed = await this.failover((i) => new Account(accountId, this.providers[i], privateKey as KeyPairString).createSignedTransaction({ receiverId, actions: acts }));
    const txHash = baseEncode(createHash("sha256").update(encodeTransaction(signed.transaction)).digest());
    onSigned?.(txHash);
    try {
      // the same signed transaction can be sent to any endpoint: it lands at most once
      const r = await this.failover((i) => this.providers[i].sendTransactionUntil(signed, "FINAL"));
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
    const r = await this.failover((i) => rpc<{ result: number[] }>(this.urls[i], "query", { request_type: "call_function", finality: "final", account_id: this.cfg.contractId, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") }));
    return JSON.parse(Buffer.from(r.result).toString("utf8")) as T;
  }

  async accountExists(accountId: string): Promise<boolean> {
    try {
      await this.failover((i) => rpc(this.urls[i], "query", { request_type: "view_account", finality: "final", account_id: accountId }));
      return true;
    } catch {
      return false;
    }
  }

  async lookup(txHash: string, signerId: string): Promise<GatewayResult> {
    try {
      // ask for the status as it is now: waiting for finality on a transaction the network never received just hangs
      const r = await this.failover((i) => rpc<unknown>(this.urls[i], "tx", { tx_hash: txHash, sender_account_id: signerId, wait_until: "NONE" }, 8_000));
      return this.toResult(interpretTxResult(txHash, r), signerId);
    } catch (e) {
      return { status: "pending", txHash, signerId, detail: (e as Error).message };
    }
  }
}
