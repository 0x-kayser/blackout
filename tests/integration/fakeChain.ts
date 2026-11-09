/**
 * A stand-in for NEAR in integration tests. It follows the contract's rules for the methods the server uses
 * (single-use ids, bucket caps, once-per-account grants, escrow, zero-sum batches, consented debits) so the server's
 * lifecycle can be tested end to end, including failures. It is a mock: it proves the server's logic, not the chain.
 * The contract itself is tested in Rust (contracts/near/src/economy_tests.rs) and live on testnet (docs/TESTNET_DEMO.md).
 */
import type { EconomyConfig } from "../../apps/api/src/economy/config.ts";
import type { ChainGateway, GatewayResult, Signer } from "../../apps/api/src/economy/gateway.ts";
import { TREASURY_PLAN } from "../../apps/api/src/economy/treasury.ts";
import { NPC_IDENTITIES } from "../../apps/api/src/economy/treasury.ts";

export function fakeEconomyConfig(): EconomyConfig {
  const npcs: EconomyConfig["npcs"] = {};
  for (const n of NPC_IDENTITIES) npcs[n.id] = { accountId: `${n.id}.game.testnet`, privateKey: n.signs ? "ed25519:fake" : null };
  return {
    enabled: true,
    network: "testnet",
    rpcUrl: "http://fake",
    rpcUrls: ["http://fake"],
    explorerTxBase: "https://testnet.nearblocks.io/txns/",
    explorerAccountBase: "https://testnet.nearblocks.io/address/",
    contractId: "econ.game.testnet",
    operator: { accountId: "operator.game.testnet", privateKey: "ed25519:fake" },
    playerParent: { accountId: "players.game.testnet", privateKey: "ed25519:fake" },
    treasuryId: "treasury.game.testnet",
    gridId: "grid.game.testnet",
    worldId: "world.game.testnet",
    npcs,
    walletSecret: Buffer.alloc(32, 7),
    walletNear: "0.02",
    npcSpending: true,
    walletsPerHour: 60,
    adminToken: "admin-secret",
    missing: [],
  };
}

export class FakeChain implements ChainGateway {
  accounts = new Set<string>();
  bal = new Map<string, number>();
  grants = new Map<string, { bucket: string; receiver: string; amount: number }>();
  grantedTo = new Set<string>();
  buckets: Map<string, { cap: number; granted: number; max: number; once: boolean }>;
  orders = new Map<string, { buyer: string; seller: string; kwh: number; price: number; escrow: number; status: string; paid: number }>();
  epochs = new Set<string>();
  plants = new Map<string, string>();
  sales = new Map<string, { seller: string; price: number }>();
  calls: { signer: string; method: string; args: Record<string, unknown> }[] = [];
  npcPaused = false;
  private n = 0;
  /** Test hooks: make the next call(s) behave differently. */
  failNext: string | null = null;
  pendingNext = false;

  constructor(readonly cfg: EconomyConfig) {
    this.buckets = new Map(TREASURY_PLAN.buckets.map((b) => [b.name, { cap: b.cap, granted: 0, max: b.maxPerGrant, once: b.oncePerAccount }]));
    this.bal.set(`credit:vesper|${cfg.treasuryId}`, TREASURY_PLAN.totalSupply);
    // the bootstrap mints the market's item custody stock to the world account
    for (const t of ["fuel:natural-gas", "fuel:diesel", "permit:carbon", "certificate:renewable", "material:steel", "part:turbine"]) this.bal.set(`${t}|${cfg.worldId}`, 1e12);
  }

  balance(acct: string, token = "credit:vesper") {
    return this.bal.get(`${token}|${acct}`) ?? 0;
  }
  supply(token = "credit:vesper") {
    let s = 0;
    for (const [k, v] of this.bal) if (k.startsWith(`${token}|`)) s += v;
    return s;
  }

  private move(token: string, from: string, to: string, amount: number) {
    if (this.balance(from, token) < amount) throw new Error(`Smart contract panicked: Insufficient credits for this epoch`);
    this.bal.set(`${token}|${from}`, this.balance(from, token) - amount);
    this.bal.set(`${token}|${to}`, this.balance(to, token) + amount);
  }

  private signerId(s: Signer): string {
    return s.kind === "operator" ? this.cfg.operator!.accountId : s.kind === "player-parent" ? this.cfg.playerParent!.accountId : s.kind === "npc" ? this.cfg.npcs[s.id].accountId : s.accountId;
  }

  private result(signerId: string, fn: () => void, onSigned?: (h: string) => void): GatewayResult {
    const txHash = `FAKE${++this.n}`;
    onSigned?.(txHash);
    if (this.pendingNext) {
      this.pendingNext = false;
      try {
        fn();
      } catch {
        /* it may or may not have landed: the server must find out by reading */
      }
      return { status: "pending", txHash, signerId, detail: "broadcast: socket hang up" };
    }
    if (this.failNext) {
      const d = this.failNext;
      this.failNext = null;
      return { status: "failed", txHash, signerId, detail: d };
    }
    try {
      fn();
      return { status: "settled", txHash, signerId, detail: "final_execution_status=FINAL" };
    } catch (e) {
      return { status: "failed", txHash, signerId, detail: (e as Error).message };
    }
  }

  async createSubAccount(id: string, _pk: string, onSigned?: (h: string) => void): Promise<GatewayResult> {
    return this.result(this.cfg.playerParent!.accountId, () => {
      if (this.accounts.has(id)) throw new Error("AccountAlreadyExists");
      this.accounts.add(id);
    }, onSigned);
  }

  async call(s: Signer, method: string, a: Record<string, unknown>, opts: { onSigned?: (h: string) => void } = {}): Promise<GatewayResult> {
    const signer = this.signerId(s);
    this.calls.push({ signer, method, args: a });
    return this.result(signer, () => {
      switch (method) {
        case "treasury_grant": {
          if (signer !== this.cfg.operator!.accountId) throw new Error("Only the game operator");
          const id = String(a.grant_id);
          if (this.grants.has(id)) throw new Error("Grant already paid");
          const b = this.buckets.get(String(a.bucket))!;
          const amt = Number(a.amount);
          if (b.max && amt > b.max) throw new Error("Above this bucket's per-grant limit");
          if (b.granted + amt > b.cap) throw new Error("This treasury bucket is exhausted");
          const once = `${a.bucket}|${a.receiver_id}`;
          if (b.once && this.grantedTo.has(once)) throw new Error("This account already received its starting capital");
          this.move("credit:vesper", this.cfg.treasuryId!, String(a.receiver_id), amt);
          b.granted += amt;
          if (b.once) this.grantedTo.add(once);
          this.grants.set(id, { bucket: String(a.bucket), receiver: String(a.receiver_id), amount: amt });
          return;
        }
        case "power_order_place": {
          if (this.npcPaused) throw new Error("NPC spending is paused");
          const id = String(a.order_id);
          if (this.orders.has(id)) throw new Error("Order id already used");
          const kwh = Number(a.kwh);
          const price = Number(a.price_per_mwh);
          const escrow = Math.ceil((kwh * price) / 1000);
          this.move("credit:vesper", signer, this.cfg.contractId!, escrow);
          this.orders.set(id, { buyer: signer, seller: String(a.seller_id), kwh, price, escrow, status: "open", paid: 0 });
          return;
        }
        case "power_order_confirm": {
          if (signer !== this.cfg.operator!.accountId) throw new Error("Only the grid operator confirms delivery");
          const o = this.orders.get(String(a.order_id));
          if (!o) throw new Error("No such order");
          if (o.status !== "open") throw new Error("Order already closed");
          const d = Number(a.delivered_kwh);
          const pay = Math.min(o.escrow, Math.floor((d * o.price) / 1000));
          this.move("credit:vesper", this.cfg.contractId!, o.seller, pay);
          this.move("credit:vesper", this.cfg.contractId!, o.buyer, o.escrow - pay);
          o.status = "settled";
          o.paid = pay;
          return;
        }
        case "settle_batch": {
          if (signer !== this.cfg.operator!.accountId) throw new Error("Only the game operator");
          const id = String(a.epoch_id);
          if (this.epochs.has(id)) throw new Error("Epoch already settled");
          const entries = a.entries as [string, [string, string][]][];
          const snapshot = new Map(this.bal);
          try {
            for (const [token, legs] of entries) {
              if (legs.reduce((s, [, d]) => s + Number(d), 0) !== 0) throw new Error("Epoch deltas must sum to zero");
              for (const [acct, d] of legs) if (Number(d) < 0 && this.released.has(acct)) throw new Error("Debit from an account that didn't consent to game custody");
              for (const [acct, d] of legs) if (Number(d) < 0) this.move(token, acct, this.cfg.contractId!, -Number(d));
              for (const [acct, d] of legs) if (Number(d) > 0) this.move(token, this.cfg.contractId!, acct, Number(d));
            }
          } catch (e) {
            this.bal = snapshot; // all or nothing, like a reverted transaction
            throw e;
          }
          this.epochs.add(id);
          return;
        }
        case "plant_mint": {
          if (this.plants.has(String(a.token_id))) throw new Error("Plant already minted");
          this.plants.set(String(a.token_id), String(a.owner_id));
          return;
        }
        case "plant_list": {
          if (!this.plants.has(String(a.token_id))) throw new Error("No such plant");
          this.sales.set(String(a.token_id), { seller: this.plants.get(String(a.token_id))!, price: Number(a.price) });
          return;
        }
        case "plant_cancel_listing": {
          if (!this.sales.delete(String(a.token_id))) throw new Error("Not listed");
          return;
        }
        case "plant_buy_for": {
          const tk = String(a.token_id);
          const sale = this.sales.get(tk);
          if (!sale) throw new Error("Not for sale");
          if (sale.seller !== this.plants.get(tk)) throw new Error("Stale listing");
          this.move("credit:vesper", String(a.buyer_id), sale.seller, sale.price);
          this.plants.set(tk, String(a.buyer_id));
          this.sales.delete(tk);
          return;
        }
        case "plant_transfer_for": {
          if (this.plants.get(String(a.token_id)) !== a.owner_id) throw new Error("Only the plant's owner controls it");
          this.plants.set(String(a.token_id), String(a.receiver_id));
          return;
        }
        case "release_to_owner": {
          if (!signer.endsWith(".players.game.testnet")) throw new Error("Only a player id in the operator's namespace can be released");
          this.released.add(signer);
          return;
        }
        case "set_npc_spending_paused":
          this.npcPaused = !!a.paused;
          return;
        default:
          throw new Error(`fake chain: unknown method ${method}`);
      }
    }, opts.onSigned);
  }

  async view<T>(method: string, a: Record<string, unknown>): Promise<T> {
    if (method === "grant") return (this.grants.get(String(a.grant_id)) ?? null) as T;
    if (method === "power_order") return (this.orders.get(String(a.order_id)) ?? null) as T;
    if (method === "epoch") return (this.epochs.has(String(a.epoch_id)) ? { epoch_id: a.epoch_id } : null) as T;
    if (method === "is_released") return this.released.has(String(a.account_id)) as T;
    if (method === "plant_sale") return (this.sales.get(String(a.token_id)) ?? null) as T;
    if (method === "nft_token") return (this.plants.has(String(a.token_id)) ? { owner_id: this.plants.get(String(a.token_id)) } : null) as T;
    if (method === "mt_batch_balance_of") return (a.token_ids as string[]).map((t) => String(this.balance(String(a.account_id), t))) as T;
    if (method === "mt_balance_of") return String(this.balance(String(a.account_id), String(a.token_id))) as T;
    if (method === "economy_info")
      return { initialized: true, treasury_id: this.cfg.treasuryId, initial_supply: String(TREASURY_PLAN.totalSupply), total_supply: String(this.supply()), treasury_balance: String(this.balance(this.cfg.treasuryId!)), issued: "0", issue_cap: String(TREASURY_PLAN.issueCap), npc_spending_paused: this.npcPaused, buckets: [...this.buckets.entries()].map(([name, b]) => ({ name, cap: String(b.cap), granted: String(b.granted) })) } as T;
    throw new Error(`fake chain: unknown view ${method}`);
  }

  released = new Set<string>();
  nears = new Map<string, number>();
  async sendNear(to: string, near: string, onSigned?: (h: string) => void): Promise<GatewayResult> {
    return this.result(this.cfg.playerParent!.accountId, () => this.nears.set(to, (this.nears.get(to) ?? 0) + Number(near)), onSigned);
  }
  async nearBalance(id: string) {
    return this.nears.get(id) ?? 0;
  }

  async accountExists(id: string) {
    return this.accounts.has(id);
  }

  async lookup(txHash: string, signerId: string): Promise<GatewayResult> {
    return { status: "pending", txHash, signerId, detail: "unknown to the fake RPC" };
  }
}
