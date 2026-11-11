/**
 * EconomyService: the bridge between the game's economy and NEAR testnet.
 *
 * What lives where
 *   off chain  the simulation: weather, generation, fuel burn, demand, prices, every NPC decision, real-time play.
 *   on chain   money (credit:vesper, fixed supply), NEP-245 market resources and player inventory, payments between
 *              real accounts, and the power orders NPC companies sign with their own keys.
 *
 * Accounts
 *   treasury   holds the supply; pays out only through `treasury_grant` (bucket caps, one start grant per account).
 *   grid       the clearing account for everything simulated inside players' regions (homes, businesses, the
 *              regional market, builders): players are paid from it for electricity and pay into it for building.
 *   world      the outside world: importers, outside customers, aluminium buyers, the water utility.
 *   NPCs       the nine merchants and three power companies, each its own NEAR account.
 *   players    each signed-in player's own wallet, a sub-account of the player-parent account.
 *
 * Every chain operation is a row in `chain_ops` with a deterministic id, submitted once, serially, and only
 * counted when NEAR reports a final successful outcome. Game state that depends on it (an order going live, a
 * delivery being paid, a wallet opening) changes only then. A crash or a lost response is reconciled by reading the
 * contract (did this grant / order / epoch happen?), never by guessing.
 */
import type { ChainOpView, EconomyView, NpcWalletView } from "@blackout/shared";
import { region, town } from "@blackout/sim";
import { nowIso, tx, type Db } from "../db.ts";
import type { RegionHandle, RegionService } from "../region.ts";
import type { TownService } from "../town.ts";
import type { EconomyConfig } from "./config.ts";
import { TRANSIENT, type ChainGateway, type GatewayResult, type Signer } from "./gateway.ts";
import { GRID_TRANCHE_CC, NPC_IDENTITIES, STARTER_GRANT_CC, TOPUP_BELOW_BPS, WORLD_TRANCHE_CC } from "./treasury.ts";
import { newWalletKey, openKey, sealKey, walletAccountId } from "./wallets.ts";

const CREDIT = "credit:vesper";
const ITEM_TOKENS = Object.keys(region.regionConfig.TOWN_UNITS);
const RETRYABLE = /Insufficient|exhausted|timeout|TIMEOUT|broadcast|nonce|InvalidNonce|Expired|LackBalanceForState|NotEnoughBalance|allowance/i;
/** Settle the market at most this often, and players' region earnings at most this often (fewer, bigger batches). */
const TOWN_BATCH_MS = 120_000;
const REGION_BATCH_MS = 60_000;
/** A contract refusal in a release build arrives as a bare WebAssembly trap, without its message. */
const TRAP = /WasmTrap|unreachable/i;
const ALREADY = /already (paid|used|settled|closed|received|exists)|AccountAlreadyExists/i;

export interface OpRow {
  op_id: string;
  kind: ChainOpView["kind"];
  subject: string | null;
  signer: string;
  method: string;
  args_json: string;
  status: ChainOpView["status"];
  tx_hash: string | null;
  detail: string | null;
  attempts: number;
  effects_applied: number;
  created_at: string;
  updated_at: string;
}

interface WalletRow {
  player_id: string;
  account_id: string;
  public_key: string;
  enc_private_key: string;
  status: "creating" | "opening" | "active" | "leaving" | "released" | "failed";
  region_id: string | null;
  opened_interval: number | null;
  opened_town_tick: number | null;
  opening_cash_cc: number | null;
  resource_opened_interval: number | null;
  resource_opened_town_tick: number | null;
  resource_pending_interval: number | null;
  resource_pending_town_tick: number | null;
  resource_pending_op_id: string | null;
  detail: string | null;
  created_at: string;
}

const cr = (cc: number) => `₡${Math.round(cc / 100).toLocaleString("en-US")}`;

export class EconomyService {
  private balances = new Map<string, { cc: number; at: number }>();
  private treasury: EconomyView["treasury"] = null;
  private treasuryAt = 0;
  private busy = false;
  private settlementBusy = false;
  private applied = new Set<string>();
  /** The plant market's callbacks for its own operations (player-to-player sales). */
  saleHooks: { settled: (row: OpRow) => void; failed: (row: OpRow, detail: string) => void } | null = null;
  /** When each in-flight operation was first seen unconfirmed (to tell "slow" from "never arrived"). */
  private inflightSince = new Map<string, number>();

  constructor(
    private readonly db: Db,
    readonly cfg: EconomyConfig,
    readonly gateway: ChainGateway | null,
    private readonly rsvc: RegionService,
    private readonly tsvc: TownService,
    private readonly isRegistered: (userId: string) => boolean,
  ) {}

  get live(): boolean {
    return !!(this.cfg.enabled && this.gateway);
  }

  /* ================================================================ state */

  private getState<T>(key: string): T | null {
    const r = this.db.prepare("SELECT value_json FROM economy_state WHERE key = ?").get(key) as { value_json: string } | undefined;
    return r ? (JSON.parse(r.value_json) as T) : null;
  }
  private setState(key: string, v: unknown): void {
    this.db.prepare("INSERT INTO economy_state (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at").run(key, JSON.stringify(v), nowIso());
  }

  desk(userId: string): { sell: boolean; markupBps: number } {
    return this.getState<{ sell: boolean; markupBps: number }>(`desk:${userId}`) ?? { sell: true, markupBps: 1_500 };
  }
  setDesk(userId: string, d: { sell: boolean; markupBps: number }): void {
    this.setState(`desk:${userId}`, { sell: d.sell, markupBps: Math.max(0, Math.min(20_000, Math.round(d.markupBps))) });
  }

  /* ================================================================ accounts */

  private npcAccount(id: string): string | null {
    return this.cfg.npcs[id]?.accountId ?? null;
  }
  wallet(userId: string): WalletRow | null {
    return (this.db.prepare("SELECT * FROM player_wallets WHERE player_id = ?").get(userId) as WalletRow | undefined) ?? null;
  }
  /** The wallet that receives a player's money, once it has opened. */
  activeAccount(userId: string): string | null {
    const w = this.wallet(userId);
    return w && w.status === "active" ? w.account_id : null;
  }

  /**
   * Gives a signed-in player a wallet: a real NEAR account, created once, then funded once from the treasury.
   * Idempotent: a refresh, a retry or a second tab returns the same wallet and never a second grant.
   */
  ensureWallet(userId: string): { wallet: WalletRow | null; note: string | null } {
    if (!this.live) return { wallet: null, note: "This server isn't connected to NEAR testnet: your money is kept by the game server only." };
    const have = this.wallet(userId);
    if (have) return { wallet: have, note: null };
    // guests get a wallet too, once they've actually played (finished the first minute): a page load alone never
    // creates an account, so the faucet can't be drained by opening the game in a loop
    if (!this.isRegistered(userId)) {
      const h = this.rsvc.liveFor(userId);
      if (!h.state.onboarding.done) return { wallet: null, note: "Finish your first minute and your company gets its own NEAR wallet." };
    }
    const recent = (this.db.prepare("SELECT COUNT(*) AS n FROM player_wallets WHERE created_at > ?").get(new Date(Date.now() - 3_600_000).toISOString()) as { n: number }).n;
    if (recent >= this.cfg.walletsPerHour) return { wallet: null, note: "Lots of new companies this hour: your wallet will be created in a few minutes." };
    const accountId = walletAccountId(userId, this.cfg.playerParent!.accountId);
    const key = newWalletKey();
    const at = nowIso();
    this.db
      .prepare("INSERT OR IGNORE INTO player_wallets (player_id, account_id, public_key, enc_private_key, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'creating', ?, ?)")
      .run(userId, accountId, key.publicKey, sealKey(this.cfg.walletSecret!, key.privateKey), at, at);
    this.enqueue({ opId: `account:${userId}`, kind: "account", subject: `wallet:${userId}`, signer: "player-parent", method: "create_account", args: { account_id: accountId, public_key: key.publicKey } });
    return { wallet: this.wallet(userId), note: null };
  }

  /** The wallet exists on NEAR: close both ledgers' epochs at this instant, then fund it to match the game. */
  private openWallet(userId: string): void {
    const w = this.wallet(userId);
    if (!w || w.status !== "creating") return;
    const h = this.rsvc.liveFor(userId);
    const fromInterval = region.forceCloseEpoch(h.state);
    const fromTick = town.forceCloseTownEpoch(this.tsvc.state);
    this.rsvc.checkpoint(h);
    this.tsvc.persistEpochsNow();
    this.tsvc.checkpoint();
    const cash = region.rbal(h.state, "cc", "player");
    this.db.prepare("UPDATE player_wallets SET status = 'opening', region_id = ?, opened_interval = ?, opened_town_tick = ?, opening_cash_cc = ?, updated_at = ? WHERE player_id = ?").run(h.regionId, fromInterval, fromTick, cash, nowIso(), userId);
    // starting capital: once per account, from the players' bucket, never minted
    this.enqueue({ opId: `grant:start:${userId}`, kind: "grant", subject: `wallet:${userId}`, signer: "operator", method: "treasury_grant", args: { grant_id: `start:${userId}`, bucket: "players", receiver_id: w.account_id, amount: String(STARTER_GRANT_CC), memo: "starting capital for a new power company" } });
    // what the company has earned or spent since it started (as a guest, or before this server had a wallet for it)
    const diff = cash - STARTER_GRANT_CC;
    if (diff !== 0)
      this.enqueue({
        opId: `batch:open:${userId}`,
        kind: "batch",
        subject: `wallet:${userId}`,
        signer: "operator",
        method: "settle_batch",
        args: { epoch_id: `open:${userId}`, hash: region.sha256(region.canonical({ userId, cash, fromInterval, fromTick })), entries: [[CREDIT, [[w.account_id, String(diff)], [this.cfg.gridId!, String(-diff)]]]] },
      });
  }

  private maybeActivate(userId: string): void {
    const w = this.wallet(userId);
    if (!w || w.status !== "opening") return;
    const pending = this.db.prepare("SELECT COUNT(*) AS n FROM chain_ops WHERE subject = ? AND status != 'settled'").get(`wallet:${userId}`) as { n: number };
    if (pending.n === 0) this.db.prepare("UPDATE player_wallets SET status = 'active', updated_at = ? WHERE player_id = ?").run(nowIso(), userId);
  }

  /** The decrypted key for a player's own wallet (server-side use only: e.g. self-custody calls they ask for). */
  walletKey(userId: string): string | null {
    const w = this.wallet(userId);
    return w && this.cfg.walletSecret ? openKey(this.cfg.walletSecret, w.enc_private_key) : null;
  }

  /* ================================================================ chain operations */

  enqueue(op: { opId: string; kind: OpRow["kind"]; subject: string | null; signer: string; method: string; args: Record<string, unknown> }): void {
    const at = nowIso();
    this.db
      .prepare("INSERT OR IGNORE INTO chain_ops (op_id, kind, subject, signer, method, args_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(op.opId, op.kind, op.subject, op.signer, op.method, JSON.stringify(op.args), this.live ? "created" : "local", at, at);
  }

  op(opId: string): OpRow | null {
    return (this.db.prepare("SELECT * FROM chain_ops WHERE op_id = ?").get(opId) as OpRow | undefined) ?? null;
  }

  private signerOf(s: string): Signer {
    if (s === "operator") return { kind: "operator" };
    if (s === "player-parent") return { kind: "player-parent" };
    if (s.startsWith("npc:")) return { kind: "npc", id: s.slice(4) };
    if (s.startsWith("wallet:")) {
      // a player's own wallet signing for itself (only ever to leave game custody, at their request)
      const w = this.wallet(s.slice(7));
      const key = this.walletKey(s.slice(7));
      if (!w || !key) throw new Error("No wallet key");
      return { kind: "key", accountId: w.account_id, privateKey: key };
    }
    throw new Error(`unknown signer ${s}`);
  }

  /** One pass of the worker: submit what's new, look up what's in flight, retry what can be retried. Serial. */
  async processOps(limit = 24): Promise<number> {
    if (!this.live || this.busy) return 0;
    this.busy = true;
    let n = 0;
    try {
      // each signer gets its own share of the pass, so one busy signer (the operator) never starves another
      const rows = this.db
        .prepare(
          // within a signer: wallets and grants first (a player is waiting), then confirmations (someone is owed
          // money), then orders, batches and the rest
          `SELECT * FROM (
             SELECT *, ROW_NUMBER() OVER (PARTITION BY signer ORDER BY CASE WHEN subject LIKE 'wallet:%' THEN 0 WHEN kind = 'grant' THEN 1 WHEN kind = 'confirm' THEN 2 WHEN kind = 'order' THEN 3 WHEN kind = 'batch' THEN 4 ELSE 5 END, rowid) AS k
             FROM chain_ops WHERE status = 'created'
               OR (status = 'submitted' AND updated_at < ?)
               OR (status = 'failed' AND attempts < 40 AND updated_at < ? AND detail IS NOT NULL)
           ) WHERE k <= ? ORDER BY signer, k`,
        )
        .all(new Date(Date.now() - 20_000).toISOString(), new Date(Date.now() - 60_000).toISOString(), Math.max(1, Math.ceil(limit / 3))) as unknown as OpRow[];
      // each signer has its own nonce, so different signers go in parallel; one signer's operations stay in order
      const bySigner = new Map<string, OpRow[]>();
      for (const row of rows) {
        if (row.status === "failed" && !this.retryable(row, row.detail ?? "")) {
          // retire it for good, so it never again takes a slot from work that can still go out
          this.db.prepare("UPDATE chain_ops SET attempts = 99 WHERE op_id = ?").run(row.op_id);
          continue;
        }
        bySigner.set(row.signer, [...(bySigner.get(row.signer) ?? []), row]);
      }
      await Promise.all(
        [...bySigner.values()].map(async (list) => {
          for (const row of list) {
            await this.runOp(row);
            n++;
          }
        }),
      );
    } finally {
      this.busy = false;
    }
    return n;
  }

  private async runOp(row: OpRow): Promise<void> {
    const gw = this.gateway!;
    // never send something the game has already moved past
    const stale = row.status === "created" ? this.staleReason(row) : null;
    if (stale) {
      this.db.prepare("UPDATE chain_ops SET status = 'failed', attempts = 99, detail = ?, updated_at = ? WHERE op_id = ?").run(stale, nowIso(), row.op_id);
      return;
    }
    let r: GatewayResult;
    if (row.status === "submitted" && row.tx_hash) {
      r = await gw.lookup(row.tx_hash, row.signer.startsWith("npc:") ? this.npcAccount(row.signer.slice(4))! : row.signer.startsWith("wallet:") ? this.wallet(row.signer.slice(7))!.account_id : row.signer === "operator" ? this.cfg.operator!.accountId : this.cfg.playerParent!.accountId);
      if (r.status === "pending" && (await this.reconcile(row))) r = { ...r, status: "settled", detail: "confirmed by reading the contract" };
      if (r.status === "pending") {
        const since = this.inflightSince.get(row.op_id) ?? Date.now();
        this.inflightSince.set(row.op_id, since);
        if (Date.now() - since > 120_000) {
          // two minutes unconfirmed and the contract shows no trace: it never reached the chain
          this.inflightSince.delete(row.op_id);
          if (row.kind === "order") {
            // the game has moved past that window: never send it again (if it lands after all, it gets refunded)
            r = { ...r, status: "failed", detail: "never reached the chain (lost in transit); not re-sent" };
          } else {
            // single-use ids make a resend safe: a late copy of the first one can only be refused
            this.db.prepare("UPDATE chain_ops SET status = 'created', detail = ?, updated_at = ? WHERE op_id = ?").run("re-sending: the first transaction never reached the chain", nowIso(), row.op_id);
            return;
          }
        }
      } else this.inflightSince.delete(row.op_id);
    } else {
      this.db.prepare("UPDATE chain_ops SET status = 'submitted', attempts = attempts + 1, updated_at = ? WHERE op_id = ?").run(nowIso(), row.op_id);
      const onSigned = (h: string) => this.db.prepare("UPDATE chain_ops SET tx_hash = ?, updated_at = ? WHERE op_id = ?").run(h, nowIso(), row.op_id);
      try {
        const args = JSON.parse(row.args_json) as Record<string, unknown>;
        // keys starting with "_" are the server's own bookkeeping, never sent to the contract
        const send = Object.fromEntries(Object.entries(args).filter(([k]) => !k.startsWith("_")));
        if (row.kind === "account") r = await gw.createSubAccount(String(args.account_id), String(args.public_key), onSigned);
        else if (row.kind === "fund") r = await gw.sendNear(String(args.receiver_id), String(args.near), onSigned);
        else r = await gw.call(this.signerOf(row.signer), row.method, send, { onSigned });
      } catch (e) {
        r = { status: "failed", txHash: null, signerId: row.signer, detail: (e as Error).message };
      }
    }
    // a refusal may mean "already done" (a retry, or an earlier server): the contract's state decides, not the message
    if (r.status === "failed" && (ALREADY.test(r.detail) || TRAP.test(r.detail)) && (await this.reconcile(row))) r = { ...r, status: "settled", detail: `already done on chain (${r.detail.slice(0, 120)})` };
    if (r.status === "pending") {
      this.db.prepare("UPDATE chain_ops SET detail = ?, updated_at = ? WHERE op_id = ?").run(r.detail.slice(0, 400), nowIso(), row.op_id);
      return;
    }
    this.db.prepare("UPDATE chain_ops SET status = ?, tx_hash = COALESCE(?, tx_hash), detail = ?, updated_at = ? WHERE op_id = ?").run(r.status, r.txHash, r.detail.slice(0, 400), nowIso(), row.op_id);
    if (r.status === "settled") this.onSettled(this.op(row.op_id)!);
    else this.onFailed(this.op(row.op_id)!, r.detail);
  }

  /**
   * Worth trying again? Transient network trouble (rate limits, timeouts), or a batch or expiry the contract refused
   * for now (nothing moves when one is refused: a float that needs topping up, a deadline not reached yet). An NPC's
   * order is retried only for network trouble and only while its window is still open; a refusal is final.
   */
  private retryable(row: OpRow, detail: string): boolean {
    const transient = RETRYABLE.test(detail) || TRANSIENT.test(detail);
    // settlement batches and refunds are the ledger itself: they keep trying (with a minute between tries) until they land
    const attemptsOk = row.attempts < (row.kind === "expire" || row.kind === "batch" ? 40 : 8);
    if (!attemptsOk) return false;
    if (row.kind === "order") return transient && !this.staleReason(row);
    // a purchase the contract refuses (say the buyer's wallet is short) is final: the buyer gets their money back
    // at once and can try again; only network trouble is retried
    if (row.method === "plant_buy_for" || row.method === "plant_list") return TRANSIENT.test(detail);
    return transient || ((row.kind === "batch" || row.kind === "expire") && TRAP.test(detail));
  }

  /** Why an operation should no longer be sent, if the game has moved on without it. */
  private staleReason(row: OpRow): string | null {
    if (row.kind !== "order" && row.kind !== "confirm") return null;
    const id = String((JSON.parse(row.args_json) as { order_id: string }).order_id);
    const o = this.tsvc.state.power?.orders.find((x) => x.orderId === id);
    if (row.kind === "order" && (!o || o.status !== "placing")) return "not sent: the game gave up on this order before its escrow went out";
    if (row.kind === "confirm" && (!o || o.status !== "awaiting")) return "not sent: the order was already closed in the game";
    return null;
  }

  /** Did this operation happen on chain? Answered by reading the contract, never by guessing. */
  private async reconcile(row: OpRow): Promise<boolean> {
    const gw = this.gateway!;
    const a = JSON.parse(row.args_json) as Record<string, unknown>;
    try {
      if (row.kind === "account") return await gw.accountExists(String(a.account_id));
      if (row.kind === "grant") return !!(await gw.view<unknown>("grant", { grant_id: a.grant_id }));
      if (row.kind === "order") return !!(await gw.view<unknown>("power_order", { order_id: a.order_id }));
      if (row.kind === "confirm" || row.kind === "expire") {
        // the contract deletes an order when it closes, so "gone" means confirmed or expired
        const o = await gw.view<{ status: string } | null>("power_order", { order_id: a.order_id });
        return !o || o.status !== "open";
      }
      if (row.kind === "batch") return !!(await gw.view<unknown>("epoch", { epoch_id: a.epoch_id }));
      if (row.kind === "release") return await gw.view<boolean>("is_released", { account_id: a._account_id });
      if (row.kind === "fund") return (await gw.nearBalance(String(a.receiver_id))) >= Number(a.near) * 0.5;
      if (row.kind === "plant") {
        if (row.method === "plant_list") return !!(await gw.view<unknown>("plant_sale", { token_id: a.token_id }));
        if (row.method === "plant_cancel_listing") return !(await gw.view<unknown>("plant_sale", { token_id: a.token_id }));
        const tkn = await gw.view<{ owner_id: string } | null>("nft_token", { token_id: a.token_id });
        if (row.method === "plant_buy_for") return !!tkn && tkn.owner_id === a.buyer_id;
        return !!tkn && (row.method === "plant_mint" || tkn.owner_id === a.receiver_id);
      }
    } catch {
      return false;
    }
    return false;
  }

  private onSettled(row: OpRow): void {
    if (row.effects_applied) return;
    const a = JSON.parse(row.args_json) as Record<string, unknown>;
    if (Array.isArray(a._resource_wallets)) {
      const open = this.db.prepare("UPDATE player_wallets SET resource_opened_interval = ?, resource_opened_town_tick = ?, resource_pending_interval = NULL, resource_pending_town_tick = NULL, resource_pending_op_id = NULL, updated_at = ? WHERE player_id = ? AND resource_pending_op_id = ?");
      for (const item of a._resource_wallets as { playerId: string; interval: number; townTick: number }[])
        open.run(item.interval, item.townTick, nowIso(), item.playerId, row.op_id);
    }
    this.db.prepare("UPDATE chain_ops SET effects_applied = 1 WHERE op_id = ?").run(row.op_id);
    const user = row.subject?.startsWith("wallet:") ? row.subject.slice(7) : null;
    if (row.kind === "account" && user) this.openWallet(user);
    if (user && (row.kind === "grant" || row.kind === "batch")) this.maybeActivate(user);
    if (row.kind === "batch" && Array.isArray(a._epochs)) {
      const upd = this.db.prepare("UPDATE settlement_epochs SET status = 'confirmed', tx_hash = ?, updated_at = ? WHERE epoch_id = ?");
      for (const id of a._epochs as string[]) upd.run(row.tx_hash, nowIso(), id);
    }
    const t = this.tsvc.state;
    const ctx = town.newTCtx();
    if (row.kind === "order") {
      const o = t.power?.orders.find((x) => x.orderId === String(a.order_id));
      // the escrow landed after the game had given up on the order: get the buyer's money back through the contract
      if (!o || o.status !== "placing") this.enqueueExpire(String(a.order_id));
      else town.activatePowerOrder(t, ctx, String(a.order_id));
    }
    if (row.kind === "confirm") town.settlePowerOrder(t, ctx, String(a.order_id), Number(a.delivered_kwh));
    // carry it into the seller's region now, not at the next market tick
    if (row.kind === "order" || row.kind === "confirm") this.afterTownTick();
    if (row.subject?.startsWith("sale:")) this.saleHooks?.settled(row);
    if (row.subject?.startsWith("leave:")) this.leaveStep(row.subject.slice(6), row);
  }

  private onFailed(row: OpRow, detail: string): void {
    if (row.subject?.startsWith("leave:") && row.kind === "batch" && !(this.retryable(row, detail) && row.attempts < 8)) this.leaveFailed(row.subject.slice(6), detail);
    // the release couldn't pay its fee: top the wallet up once more and try again (at most three rounds)
    if (row.subject?.startsWith("leave:") && row.kind === "release" && /balance/i.test(detail)) {
      const n = Number(row.op_id.split(":").pop()) || 1;
      const w = this.wallet(row.subject.slice(6));
      if (w && n < 3) this.enqueue({ opId: `fund:${row.subject}:${n + 1}`, kind: "fund", subject: row.subject, signer: "player-parent", method: "transfer", args: { receiver_id: w.account_id, near: "0.05" } });
    }
    if (row.subject?.startsWith("sale:") && !(this.retryable(row, detail) && row.attempts < 8)) this.saleHooks?.failed(row, detail);
    const user = row.subject?.startsWith("wallet:") ? row.subject.slice(7) : null;
    if (this.retryable(row, detail) && row.attempts < 8) return; // the worker tries again later
    const a = JSON.parse(row.args_json) as Record<string, unknown>;
    if (row.subject === "resource-bootstrap" && Array.isArray(a._resource_wallets)) {
      const clear = this.db.prepare("UPDATE player_wallets SET resource_pending_interval = NULL, resource_pending_town_tick = NULL, resource_pending_op_id = NULL, updated_at = ? WHERE player_id = ? AND resource_pending_op_id = ?");
      for (const item of a._resource_wallets as { playerId: string }[]) clear.run(nowIso(), item.playerId, row.op_id);
    }
    if (user && (row.kind === "account" || row.op_id.startsWith("grant:start:"))) this.db.prepare("UPDATE player_wallets SET status = 'failed', detail = ?, updated_at = ? WHERE player_id = ?").run(detail.slice(0, 300), nowIso(), user);
    if (row.kind === "order") town.failPowerOrder(this.tsvc.state, town.newTCtx(), String((JSON.parse(row.args_json) as { order_id: string }).order_id), `NEAR refused the escrow: ${friendly(detail)}`);
  }

  /* ================================================================ the power desk */

  /** Players' offers for the next window: spare capacity from each running region whose owner sells. */
  playerOffers(): town.PowerOffer[] {
    const out: town.PowerOffer[] = [];
    for (const h of this.rsvc.regions.values()) {
      if (h.mode !== "live" || !this.rsvc.isRunning(h) || !h.state.onboarding.done) continue;
      const d = this.desk(h.ownerId);
      if (!d.sell) continue;
      // on NEAR the buyer pays into the seller's own wallet, so only players with an open wallet can sell
      if (this.live && !this.activeAccount(h.ownerId)) continue;
      const o = region.regionPowerOffer(h.state, d.markupBps);
      if (o.kw > 0) out.push({ sellerKey: `player:${h.ownerId}`, sellerName: this.rsvc.nameOf(h.ownerId), kw: o.kw, priceCcPerMWh: o.priceCcPerMWh, why: o.why });
    }
    return out;
  }

  /** What a player's grid actually delivered against an order (measured by their region, interval by interval). */
  delivered(o: town.PowerOrderState): number {
    if (!o.sellerKey.startsWith("player:")) return o.kwh;
    const userId = o.sellerKey.slice(7);
    for (const h of this.rsvc.regions.values()) if (h.ownerId === userId && h.mode === "live") return h.state.exports?.find((x) => x.orderId === o.orderId)?.deliveredKwh ?? 0;
    return 0;
  }

  /** Called before each market tick: what the desk needs from the players' side. */
  townEnv(): town.PowerEnv {
    const next = this.tsvc.state.tick + 1;
    return { offers: next % town.firmPolicy.WINDOW_TICKS === 0 ? this.playerOffers() : [], autoSettle: !this.live, delivered: (o) => this.delivered(o) };
  }

  /**
   * Called after each market tick. Turns the desk's decisions into chain operations (live) and carries each order's
   * consequences into the seller's region: the export load while it delivers, the payment once it's settled.
   */
  afterTownTick(): void {
    const t = this.tsvc.state;
    for (const o of t.power?.orders ?? []) {
      if (this.live) {
        if (o.status === "placing") this.queueOrder(o);
        // the game expired an order whose escrow is on chain: the contract must refund the buyer too
        if ((o.status === "expired" || o.status === "failed") && this.op(`order:${o.orderId}`)?.status === "settled" && this.op(`confirm:${o.orderId}`)?.status !== "settled") this.enqueueExpire(o.orderId);
        // an order made before this server was on chain was never escrowed there: it settles in the market's books
        if ((o.status === "open" || o.status === "awaiting") && !this.op(`order:${o.orderId}`)) {
          if (o.status === "awaiting" && o.deliveredKwh !== null) town.settlePowerOrder(t, town.newTCtx(), o.orderId, o.deliveredKwh, false);
          continue;
        }
        if (o.status === "awaiting" && o.deliveredKwh !== null && this.op(`order:${o.orderId}`)?.status === "settled") this.enqueue({ opId: `confirm:${o.orderId}`, kind: "confirm", subject: `order:${o.orderId}`, signer: "operator", method: "power_order_confirm", args: { order_id: o.orderId, delivered_kwh: o.deliveredKwh } });
      }
      if (!o.sellerKey.startsWith("player:")) continue;
      const userId = o.sellerKey.slice(7);
      if ((o.status === "open" || o.status === "awaiting" || o.status === "settled") && !this.applied.has(`x:${o.orderId}`)) {
        this.applied.add(`x:${o.orderId}`);
        const intervals = o.endTick - t.tick;
        if (intervals > 0) this.regionAct(userId, { type: "POWER_EXPORT", orderId: o.orderId, buyerName: o.buyerName, kw: o.kw, intervals, priceCcPerMWh: o.priceCcPerMWh }, `pw:x:${o.orderId}`);
      }
      if (o.status === "settled" && !this.applied.has(`p:${o.orderId}`)) {
        this.applied.add(`p:${o.orderId}`);
        if (o.paidCc > 0) this.regionAct(userId, { type: "POWER_PAID", orderId: o.orderId, buyerName: o.buyerName, cc: o.paidCc }, `pw:p:${o.orderId}`);
      }
    }
  }

  /**
   * The escrow sweeper. Any order this server ever sent to NEAR that the game is no longer delivering, and that was
   * never confirmed, may hold the buyer's money in escrow (it arrived late, or its response was lost). Queue the
   * contract's expiry for each: it refunds the buyer in full once the deadline passes, and is a no-op if the order
   * never landed. Without this, slow or lost transactions would quietly lock NPCs' money.
   */
  sweepEscrows(): void {
    if (!this.live) return;
    const t = this.tsvc.state;
    const live = new Set((t.power?.orders ?? []).filter((o) => o.status === "placing" || o.status === "open" || o.status === "awaiting").map((o) => o.orderId));
    const rows = this.db
      .prepare(
        `SELECT o.args_json FROM chain_ops o
           WHERE o.kind = 'order' AND o.tx_hash IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM chain_ops c WHERE c.op_id = 'confirm:' || substr(o.op_id, 7) AND c.status = 'settled')
             AND NOT EXISTS (SELECT 1 FROM chain_ops e WHERE e.op_id = 'expire:' || substr(o.op_id, 7))`,
      )
      .all() as { args_json: string }[];
    for (const r of rows) {
      const id = String((JSON.parse(r.args_json) as { order_id: string }).order_id);
      if (!live.has(id)) this.enqueueExpire(id);
    }
  }

  /** Refunds an on-chain escrow the game no longer wants (anyone may expire it once its deadline has passed). */
  private enqueueExpire(orderId: string): void {
    // the contract lets anyone expire an order after its deadline; the player-parent account pays the gas
    this.enqueue({ opId: `expire:${orderId}`, kind: "expire", subject: `order:${orderId}`, signer: "player-parent", method: "power_order_expire", args: { order_id: orderId } });
  }

  private queueOrder(o: town.PowerOrderState): void {
    if (this.op(`order:${o.orderId}`)) return;
    const ctx = town.newTCtx();
    if (!this.cfg.npcSpending) return town.failPowerOrder(this.tsvc.state, ctx, o.orderId, "NPC spending is switched off on this server.");
    // until the market's opening balances have landed, an NPC's escrow would race them
    if (!this.townOpened()) return town.failPowerOrder(this.tsvc.state, ctx, o.orderId, "The market isn't open on NEAR yet.");
    const buyer = town.FIRM(o.buyerId).chainName;
    const seller = o.sellerKey.startsWith("player:") ? this.activeAccount(o.sellerKey.slice(7)) : this.npcAccount(town.FIRM(o.sellerKey.slice(5)).chainName);
    if (!seller || !this.cfg.npcs[buyer]?.privateKey) return town.failPowerOrder(this.tsvc.state, ctx, o.orderId, "The seller or buyer has no NEAR account.");
    this.enqueue({
      opId: `order:${o.orderId}`,
      kind: "order",
      subject: `order:${o.orderId}`,
      signer: `npc:${buyer}`,
      method: "power_order_place",
      args: { order_id: o.orderId, seller_id: seller, kwh: o.kwh, price_per_mwh: String(o.priceCcPerMWh), expires_in_minutes: 5, memo: o.why.slice(0, 280) },
    });
  }

  private regionAct(userId: string, action: Parameters<RegionService["act"]>[1], key: string): void {
    try {
      const h: RegionHandle = this.rsvc.liveFor(userId);
      this.rsvc.act(h, action, key, "system");
    } catch (e) {
      console.error("economy: region action failed", key, (e as Error).message);
    }
  }

  /* ================================================================ settlement */

  /**
   * When this server first connects to NEAR: fund the floats and each NPC's starting capital (each grant once, ever,
   * on chain), then line every NPC's on-chain balance and stock up with this server's market exactly, by reading what
   * NEAR holds for it now and settling the difference against the outside world. Reading first means it is right even
   * if another server (a demo run, a previous deployment) already moved money through these accounts.
   */
  async ensureTownOpen(): Promise<void> {
    if (!this.live) return;
    const open = this.getState<{ tick: number; id: string; phase: "grants" | "batch" }>("town_open");
    if (!open) {
      const t = this.tsvc.state;
      // the companies must exist in the market's ledger before their opening balances are taken
      town.ensureFirms(t);
      const fromTick = town.forceCloseTownEpoch(t);
      // the opening below covers everything up to now, so the next epoch starts from exactly these balances
      t.epochStart = { tick: t.tick, balances: JSON.parse(JSON.stringify(t.balances)) };
      t.direct = {};
      this.tsvc.persistEpochsNow();
      this.tsvc.checkpoint();
      this.setState("town_open", { tick: fromTick, id: `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`, phase: "grants" });
      if (!this.getState("float:grid")) this.setState("float:grid", 1);
      if (!this.getState("float:world")) this.setState("float:world", 1);
      this.enqueue({ opId: "grant:float:grid:1", kind: "grant", subject: "town-open", signer: "operator", method: "treasury_grant", args: { grant_id: "float:grid:1", bucket: "city", receiver_id: this.cfg.gridId, amount: String(GRID_TRANCHE_CC), memo: "grid clearing float: pays players for the electricity their regions buy" } });
      this.enqueue({ opId: "grant:float:world:1", kind: "grant", subject: "town-open", signer: "operator", method: "treasury_grant", args: { grant_id: "float:world:1", bucket: "world", receiver_id: this.cfg.worldId, amount: String(WORLD_TRANCHE_CC), memo: "outside-world float: importers and outside customers" } });
      for (const n of NPC_IDENTITIES) {
        const acct = this.npcAccount(n.id);
        if (acct) this.enqueue({ opId: `grant:npc:${n.id}`, kind: "grant", subject: "town-open", signer: "operator", method: "treasury_grant", args: { grant_id: `npc:${n.id}`, bucket: "npc", receiver_id: acct, amount: String(n.startCc), memo: `starting capital: ${n.name}` } });
      }
      return;
    }
    if (open.phase !== "grants") return;
    // wait until every grant has landed (a grant already paid by an earlier server counts as landed)
    const waiting = this.db.prepare("SELECT COUNT(*) AS n FROM chain_ops WHERE subject = 'town-open' AND kind = 'grant' AND status != 'settled'").get() as { n: number };
    if (waiting.n > 0) return;
    const want = townTotals(this.tsvc.state.epochStart.balances);
    const tokens = [CREDIT, ...ITEM_TOKENS];
    const entries: [string, [string, string][]][] = tokens.map((tk) => [tk, []]);
    for (const n of NPC_IDENTITIES) {
      const acct = this.npcAccount(n.id);
      if (!acct) continue;
      let have: string[];
      try {
        have = await this.gateway!.view<string[]>("mt_batch_balance_of", { account_id: acct, token_ids: tokens });
      } catch {
        return; // try again next beat
      }
      tokens.forEach((tk, k) => {
        const d = (want[tk === CREDIT ? "cc" : tk]?.[n.id] ?? 0) - Number(have[k]);
        if (d !== 0) entries[k][1].push([acct, String(d)]);
      });
    }
    const batch = entries
      .filter(([, legs]) => legs.length)
      .map(([tk, legs]) => [tk, [...legs, [this.cfg.worldId!, String(-legs.reduce((a, [, d]) => a + Number(d), 0))]]] as [string, [string, string][]]);
    this.setState("town_open", { ...open, phase: "batch" });
    const id = `open:town:${open.id}`;
    if (batch.length) this.enqueue({ opId: `batch:${id}`, kind: "batch", subject: "town-open-batch", signer: "operator", method: "settle_batch", args: { epoch_id: id, hash: region.sha256(region.canonical({ open, batch })), entries: batch } });
    else this.setState("town_open", { ...open, phase: "batch", empty: true });
  }

  private townOpened(): { tick: number } | null {
    const open = this.getState<{ tick: number; id: string; phase: string; empty?: boolean }>("town_open");
    if (!open || open.phase !== "batch") return null;
    if (open.empty) return open;
    return this.op(`batch:open:town:${open.id}`)?.status === "settled" ? open : null;
  }

  /** Queues market and regional epochs in batches, with a one-time player-resource custody boundary. */
  async queueSettlement(): Promise<void> {
    if (!this.live || this.settlementBusy || this.getState("resync")) return;
    this.settlementBusy = true;
    try {
      const open = this.townOpened();
      if (!open) return;
      const missingBaseline = this.db.prepare("SELECT COUNT(*) AS n FROM player_wallets WHERE status = 'active' AND resource_opened_interval IS NULL").get() as { n: number };
      const bootstrapInFlight = this.db.prepare("SELECT COUNT(*) AS n FROM player_wallets WHERE status = 'active' AND resource_pending_op_id IS NOT NULL").get() as { n: number };
      const resourceEpochWaiting = this.hasPendingRegionResources();
      if (bootstrapInFlight.n === 0 && resourceEpochWaiting && this.hasOpenPlayerMarketBuys()) {
        const state = this.tsvc.state;
        town.forceCloseTownEpoch(state);
        this.tsvc.persistEpochsNow();
        this.tsvc.checkpoint();
      }

      // While a baseline transfer is in flight, hold Town resource epochs. The baseline reflects the inventory at a
      // clean Town tick, and subsequent epochs must be ordered after it so no item can be credited twice.
      if (bootstrapInFlight.n === 0) this.queueTownEpochs(open, missingBaseline.n > 0 || resourceEpochWaiting);

      const unsettledTownNow = this.db.prepare("SELECT COUNT(*) AS n FROM settlement_epochs WHERE region_id = 'town' AND status IN ('pending', 'submitted')").get() as { n: number };
      const marketPurchaseStillOpen = resourceEpochWaiting && this.hasOpenPlayerMarketBuys();

      const lastRegion = this.getState<number>("region_batch_at") ?? 0;
      if (Date.now() - lastRegion >= REGION_BATCH_MS && !(resourceEpochWaiting && (unsettledTownNow.n > 0 || marketPurchaseStillOpen))) this.queueRegionEpochs();

      if (bootstrapInFlight.n > 0 || missingBaseline.n === 0) return;
      const unsettledTown = this.db.prepare("SELECT COUNT(*) AS n FROM settlement_epochs WHERE region_id = 'town' AND status IN ('pending', 'submitted')").get() as { n: number };
      if (unsettledTown.n > 0) return;

      // Close Town at a known boundary. Any row created here is first settled to world custody; the next worker beat
      // will start player bootstrap only after it has landed.
      const townState = this.tsvc.state;
      const previousTownBoundary = townState.epochStart.tick;
      const previousTownEpoch = townState.epochs.at(-1)?.epochNo ?? 0;
      town.forceCloseTownEpoch(townState);
      if (townState.tick === previousTownBoundary && (townState.epochs.at(-1)?.epochNo ?? 0) === previousTownEpoch) {
        // No tick elapsed, so forceCloseTownEpoch intentionally emitted nothing. Rebase the open market snapshot at
        // the wallet boundary so a pre-wallet trade can never be replayed after its inventory was seeded below.
        townState.epochStart = { tick: townState.tick, balances: JSON.parse(JSON.stringify(townState.balances)) };
        townState.direct = {};
      }
      this.tsvc.persistEpochsNow();
      this.tsvc.checkpoint();
      const afterClose = this.db.prepare("SELECT COUNT(*) AS n FROM settlement_epochs WHERE region_id = 'town' AND status IN ('pending', 'submitted')").get() as { n: number };
      if (afterClose.n > 0) return;

      await this.bootstrapPlayerResources();
    } finally {
      this.settlementBusy = false;
    }
  }

  /** Queues settled market epochs once the market is open on chain. */
  private queueTownEpochs(open: { tick: number }, forceFlush = false): void {
    const rows = this.db.prepare("SELECT epoch_id, from_interval, body_json, created_at FROM settlement_epochs WHERE region_id = 'town' AND status = 'pending' ORDER BY epoch_no LIMIT 12").all() as { epoch_id: string; from_interval: number; body_json: string; created_at: string }[];
    const fresh: town.TownEpoch[] = [];
    for (const r of rows) {
      if (r.from_interval < open.tick) this.db.prepare("UPDATE settlement_epochs SET status = 'local', updated_at = ? WHERE epoch_id = ?").run(nowIso(), r.epoch_id);
      else fresh.push(JSON.parse(r.body_json) as town.TownEpoch);
    }
    // several market epochs in one transaction: fewer transactions, and far less contract storage
    const oldest = rows.find((r) => r.from_interval >= open.tick)?.created_at;
    if (fresh.length && (forceFlush || fresh.length >= 6 || (oldest && Date.now() - Date.parse(oldest) >= TOWN_BATCH_MS))) {
      const merged = new Map<string, Map<string, number>>();
      for (const e of fresh) for (const [tk, legs] of this.townEntries(e)) for (const [acct, d] of legs) {
        const m = merged.get(tk) ?? new Map<string, number>();
        m.set(acct, (m.get(acct) ?? 0) + Number(d));
        merged.set(tk, m);
      }
      const entries = [...merged.entries()].map(([tk, m]) => [tk, [...m.entries()].filter(([, d]) => d !== 0).sort(([a], [b]) => a.localeCompare(b)).map(([a, d]) => [a, String(d)])] as [string, [string, string][]]).filter(([, legs]) => legs.length);
      const ids = fresh.map((e) => e.epochId);
      const id = ids.length === 1 ? ids[0] : `${ids[0]}-${ids.at(-1)!.split(":").pop()}`;
      if (entries.length) this.enqueue({ opId: `batch:${id}`, kind: "batch", subject: "town", signer: "operator", method: "settle_batch", args: { epoch_id: id, hash: region.sha256(fresh.map((e) => e.hash).join("")), entries, _epochs: ids } });
      const upd = this.db.prepare("UPDATE settlement_epochs SET status = ?, updated_at = ? WHERE epoch_id = ?");
      for (const e of ids) upd.run(entries.length ? "submitted" : "confirmed", nowIso(), e);
    }
  }

  private hasPendingRegionResources(): boolean {
    const wallets = this.db.prepare("SELECT player_id, region_id, resource_opened_interval FROM player_wallets WHERE status = 'active' AND resource_opened_interval IS NOT NULL").all() as { player_id: string; region_id: string | null; resource_opened_interval: number }[];
    for (const w of wallets) {
      if (!w.region_id) continue;
      const rows = this.db.prepare("SELECT from_interval, body_json FROM settlement_epochs WHERE region_id = ? AND status IN ('pending', 'local', 'submitted') ORDER BY epoch_no").all(w.region_id) as { from_interval: number; body_json: string }[];
      if (rows.some((r) => r.from_interval >= w.resource_opened_interval && (JSON.parse(r.body_json) as { resourceChanges?: { delta: number }[] }).resourceChanges?.some((x) => x.delta !== 0))) return true;
    }
    return false;
  }

  private hasOpenPlayerMarketBuys(): boolean {
    const state = this.tsvc.state;
    const wallets = this.db.prepare("SELECT player_id FROM player_wallets WHERE status = 'active' AND resource_opened_town_tick IS NOT NULL").all() as { player_id: string }[];
    return wallets.some((w) => {
      const acct = `ext:player:${w.player_id}`;
      return ITEM_TOKENS.some((token) => (state.balances[token]?.[acct] ?? 0) - (state.epochStart.balances[token]?.[acct] ?? 0) > 0);
    });
  }

  /**
   * Gives each active player wallet the current market-unit inventory in its Region. The operator first reads both
   * sides, then submits one zero-sum batch from world custody. The saved boundaries ensure older Town/Region epochs
   * are not replayed after this snapshot; pending metadata and the batch row are committed atomically.
   */
  private async bootstrapPlayerResources(): Promise<void> {
    const wallets = this.db
      .prepare("SELECT * FROM player_wallets WHERE status = 'active' AND resource_opened_interval IS NULL AND resource_pending_op_id IS NULL ORDER BY created_at LIMIT 6")
      .all() as unknown as WalletRow[];
    if (!wallets.length || !this.gateway || !this.cfg.worldId) return;

    const units = region.regionConfig.TOWN_UNITS;
    const townTick = this.tsvc.state.epochStart.tick;
    const plans = wallets.flatMap((w) => {
      if (!w.region_id) return [];
      const h = this.rsvc.liveFor(w.player_id);
      const interval = region.forceCloseEpoch(h.state);
      this.rsvc.checkpoint(h);
      const target = Object.fromEntries(Object.entries(units).map(([token, unit]) => [token, Math.floor(region.rbal(h.state, unit.asset, region.RACC.player) / unit.per)]));
      return [{ wallet: w, interval, target }];
    });
    if (!plans.length) return;

    let world: number[];
    try {
      const raw = await this.gateway.view<string[]>("mt_batch_balance_of", { account_id: this.cfg.worldId, token_ids: ITEM_TOKENS });
      world = raw.map(Number);
      if (world.length !== ITEM_TOKENS.length || world.some((x) => !Number.isSafeInteger(x) || x < 0)) return;
    } catch {
      return; // retry on the next worker beat; do not create a partially read reconciliation
    }

    const actual = new Map<string, number[]>();
    try {
      for (const p of plans) {
        const raw = await this.gateway.view<string[]>("mt_batch_balance_of", { account_id: p.wallet.account_id, token_ids: ITEM_TOKENS });
        const balances = raw.map(Number);
        if (balances.length !== ITEM_TOKENS.length || balances.some((x) => !Number.isSafeInteger(x) || x < 0)) return;
        actual.set(p.wallet.player_id, balances);
      }
    } catch {
      return;
    }

    const desiredByToken = new Map<string, Map<string, number>>();
    const needsByToken = new Map<string, number>();
    for (const p of plans) {
      const have = actual.get(p.wallet.player_id)!;
      ITEM_TOKENS.forEach((token, i) => {
        const delta = Number(p.target[token] ?? 0) - Number(have[i] ?? 0);
        if (!delta) return;
        const accountDeltas = desiredByToken.get(token) ?? new Map<string, number>();
        accountDeltas.set(p.wallet.account_id, delta);
        desiredByToken.set(token, accountDeltas);
        needsByToken.set(token, (needsByToken.get(token) ?? 0) + delta);
      });
    }

    // Do not submit a batch which would draw more from custody than it holds. Let market settlements land first and
    // retry from fresh on-chain balances instead of leaving a known-doomed operation in the worker queue.
    if (ITEM_TOKENS.some((token, i) => (needsByToken.get(token) ?? 0) > Number(world[i] ?? 0))) return;

    const boundaries = plans.map((p) => ({ playerId: p.wallet.player_id, interval: p.interval, townTick }));
    const entries = ITEM_TOKENS.flatMap((token) => {
      const accounts = desiredByToken.get(token);
      if (!accounts?.size) return [];
      const worldDelta = -[...accounts.values()].reduce((sum, d) => sum + d, 0);
      const legs = [...accounts.entries(), [this.cfg.worldId!, worldDelta] as [string, number]]
        .filter(([, d]) => d !== 0)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([account, delta]) => [account, String(delta)] as [string, string]);
      return legs.length ? [[token, legs] as [string, [string, string][]]] : [];
    });

    if (!entries.length) {
      const upd = this.db.prepare("UPDATE player_wallets SET resource_opened_interval = ?, resource_opened_town_tick = ?, updated_at = ? WHERE player_id = ? AND resource_opened_interval IS NULL");
      for (const p of plans) upd.run(p.interval, townTick, nowIso(), p.wallet.player_id);
      return;
    }

    const id = `resources:${plans[0].wallet.player_id}:${plans[0].interval}:${townTick}`;
    const opId = `batch:${id}`;
    const args = {
      epoch_id: id,
      hash: region.sha256(region.canonical({ boundaries, entries })),
      entries,
      _resource_wallets: boundaries,
    };
    tx(this.db, () => {
      const upd = this.db.prepare("UPDATE player_wallets SET resource_pending_interval = ?, resource_pending_town_tick = ?, resource_pending_op_id = ?, updated_at = ? WHERE player_id = ? AND resource_opened_interval IS NULL");
      for (const p of plans) upd.run(p.interval, townTick, opId, nowIso(), p.wallet.player_id);
      this.enqueue({ opId, kind: "batch", subject: "resource-bootstrap", signer: "operator", method: "settle_batch", args });
    });
  }

  /** A market epoch in NEAR accounts: NPCs their accounts; active players their wallet after its resource boundary. */
  private townEntries(e: town.TownEpoch): [string, [string, string][]][] {
    const out: [string, [string, string][]][] = [];
    for (const tk of e.tokens) {
      const m = new Map<string, number>();
      for (const x of tk.transfers) {
        let acct: string;
        if (x.account === "world") acct = this.cfg.worldId!;
        else if (x.account.startsWith("player:")) {
          const w = this.wallet(x.account.slice(7));
          // Resource deltas move through the player's NEP-245 wallet after its inventory baseline is settled.
          if (tk.token !== CREDIT) {
            acct = w?.status === "active" && w.resource_opened_town_tick !== null && e.fromTick >= w.resource_opened_town_tick ? w.account_id : this.cfg.worldId!;
          } else acct = w?.status === "active" && e.fromTick >= (w.opened_town_tick ?? Infinity) ? w.account_id : this.cfg.gridId!;
        } else acct = this.npcAccount(x.account) ?? this.cfg.worldId!;
        m.set(acct, (m.get(acct) ?? 0) + x.delta);
      }
      const legs = [...m.entries()].filter(([, d]) => d !== 0).sort(([a], [b]) => a.localeCompare(b));
      if (legs.length) out.push([tk.token, legs.map(([a, d]) => [a, String(d)])]);
    }
    return out;
  }

  /** Players' region epochs since their wallets opened, many players per transaction. */
  private queueRegionEpochs(): void {
    const wallets = this.db.prepare("SELECT * FROM player_wallets WHERE status = 'active'").all() as unknown as WalletRow[];
    const creditLegs: [string, number][] = [];
    const resourceLegs = new Map<string, Map<string, number>>();
    const ids: string[] = [];
    for (const w of wallets) {
      if (!w.region_id) continue;
      const rows = this.db.prepare("SELECT epoch_id, from_interval, body_json FROM settlement_epochs WHERE region_id = ? AND status IN ('pending', 'local') ORDER BY epoch_no").all(w.region_id) as { epoch_id: string; from_interval: number; body_json: string }[];
      let d = 0;
      for (const r of rows) {
        if (r.from_interval < (w.opened_interval ?? Infinity)) {
          this.db.prepare("UPDATE settlement_epochs SET status = 'local', updated_at = ? WHERE epoch_id = ?").run(nowIso(), r.epoch_id);
          continue;
        }
        // A bootstrap snapshot owns every earlier interval; keep later epochs intact until its transfer lands.
        if (w.resource_pending_interval !== null && r.from_interval >= w.resource_pending_interval) continue;
        const e = JSON.parse(r.body_json) as { transfers: { account: string; deltaCc: number }[]; resourceChanges?: { token: string; delta: number }[] };
        d += e.transfers.find((x) => x.account === "player")?.deltaCc ?? 0;
        if (w.resource_opened_interval !== null && r.from_interval >= w.resource_opened_interval) {
          for (const change of e.resourceChanges ?? []) {
            const m = resourceLegs.get(change.token) ?? new Map<string, number>();
            m.set(w.account_id, (m.get(w.account_id) ?? 0) + change.delta);
            resourceLegs.set(change.token, m);
          }
        }
        ids.push(r.epoch_id);
      }
      if (d !== 0) creditLegs.push([w.account_id, d]);
      if (creditLegs.length >= 38) break;
    }
    if (!ids.length) return;
    const upd = this.db.prepare("UPDATE settlement_epochs SET status = ?, updated_at = ? WHERE epoch_id = ?");
    const entries: [string, [string, string][]][] = [];
    if (creditLegs.length) {
      const legs = [...creditLegs, [this.cfg.gridId!, -creditLegs.reduce((a, [, d]) => a + d, 0)] as [string, number]];
      entries.push([CREDIT, legs.map(([a, d]) => [a, String(d)])]);
    }
    for (const [token, accounts] of resourceLegs) {
      const resourceDelta = [...accounts.values()].reduce((sum, d) => sum + d, 0);
      const legs = [...accounts.entries()];
      if (resourceDelta !== 0) legs.push([this.cfg.worldId!, -resourceDelta]);
      const clean = legs.filter(([, d]) => d !== 0).sort(([a], [b]) => a.localeCompare(b)).map(([a, d]) => [a, String(d)] as [string, string]);
      if (clean.length) entries.push([token, clean]);
    }
    if (!entries.length) {
      for (const id of ids) upd.run("confirmed", nowIso(), id);
      return;
    }
    const n = (this.getState<number>("region_batch") ?? 0) + 1;
    this.setState("region_batch", n);
    this.setState("region_batch_at", Date.now());
    this.enqueue({ opId: `batch:regions:${n}`, kind: "batch", subject: "regions", signer: "operator", method: "settle_batch", args: { epoch_id: `regions:${n}`, hash: region.sha256(region.canonical({ ids, entries })), entries, _epochs: ids } });
    for (const id of ids) upd.run("submitted", nowIso(), id);
  }

  /** Keeps the grid and world floats topped up from their buckets, a tranche at a time. Never mints. */
  async topUpFloats(): Promise<void> {
    if (!this.live) return;
    for (const [name, acct, tranche, bucket] of [["grid", this.cfg.gridId!, GRID_TRANCHE_CC, "city"], ["world", this.cfg.worldId!, WORLD_TRANCHE_CC, "world"]] as const) {
      const bal = await this.onChain(acct, true);
      if (bal === null || bal >= (tranche * TOPUP_BELOW_BPS) / 10_000) continue;
      const k = `float:${name}`;
      const n = (this.getState<number>(k) ?? 1) + 1;
      const prev = this.op(`grant:float:${name}:${n - 1}`);
      if (prev && prev.status !== "settled" && prev.status !== "failed") continue;
      this.setState(k, n);
      this.enqueue({ opId: `grant:float:${name}:${n}`, kind: "grant", subject: "float", signer: "operator", method: "treasury_grant", args: { grant_id: `float:${name}:${n}`, bucket, receiver_id: acct, amount: String(tranche), memo: `${name} float, tranche ${n}` } });
    }
  }

  /* ================================================================ plants as NFTs */

  /** A plant's token id: unique across every player's region, and a valid prefix for its own NEAR account. */
  plantTokenId(regionId: string, assetNo: number): string {
    return `p${region.sha256(regionId).slice(0, 8)}${String(assetNo).padStart(5, "0")}`;
  }

  /**
   * Keeps NEAR's record of who owns each plant in step with the game: every working plant a wallet holder owns is
   * minted to their wallet; one they sell leaves it (to the grid account, which stands for everyone inside their
   * region, VoltLine included). The game decides ownership; the chain records it where anyone can check.
   */
  syncPlants(): void {
    if (!this.live) return;
    for (const h of this.rsvc.regions.values()) {
      if (h.mode !== "live") continue;
      const w = this.wallet(h.ownerId);
      if (!w || w.status !== "active" || w.region_id !== h.regionId) continue;
      for (const p of h.state.plants) {
        if (p.status === "building") continue;
        // a plant bought from another company keeps the token it already has
        const token = p.chainTokenId ?? this.plantTokenId(h.regionId, p.assetNo);
        const minted = this.op(`plant:${token}`);
        if (p.ownerId === "player" && !minted)
          this.enqueue({ opId: `plant:${token}`, kind: "plant", subject: `plants:${h.ownerId}`, signer: "operator", method: "plant_mint", args: { token_id: token, owner_id: w.account_id, metadata: { title: p.name.slice(0, 80), tech: p.tech, node_id: p.nodeId, capacity_kw: p.capacityKw } } });
        if (p.ownerId !== "player" && minted?.status === "settled" && !this.op(`plant-out:${token}`))
          this.enqueue({ opId: `plant-out:${token}`, kind: "plant", subject: `plants:${h.ownerId}`, signer: "operator", method: "plant_transfer_for", args: { owner_id: w.account_id, receiver_id: this.cfg.gridId, token_id: token } });
      }
    }
  }

  private plantsView(userId: string): EconomyView["plants"] {
    const rows = this.db.prepare("SELECT * FROM chain_ops WHERE subject = ? AND kind = 'plant' ORDER BY rowid").all(`plants:${userId}`) as unknown as OpRow[];
    const out = new Map<string, EconomyView["plants"][number]>();
    for (const r of rows) {
      const a = JSON.parse(r.args_json) as { token_id: string; metadata?: { title: string } };
      const prev = out.get(a.token_id);
      const status = r.method === "plant_mint" ? (r.status === "settled" ? "yours" : r.status === "failed" ? "failed" : "minting") : r.status === "settled" ? "sold" : (prev?.status ?? "yours");
      out.set(a.token_id, { name: a.metadata?.title ?? prev?.name ?? a.token_id, tokenId: a.token_id, status, url: this.live ? `${this.cfg.explorerAccountBase}${a.token_id}.${this.cfg.contractId}` : null, txUrl: r.tx_hash && this.live ? `${this.cfg.explorerTxBase}${r.tx_hash}` : (prev?.txUrl ?? null) });
    }
    return [...out.values()];
  }

  /* ================================================================ reads */

  async onChain(accountId: string, fresh = false): Promise<number | null> {
    if (!this.live) return null;
    const c = this.balances.get(accountId);
    if (c && !fresh && Date.now() - c.at < 10_000) return c.cc;
    try {
      const v = await this.gateway!.view<string>("mt_balance_of", { account_id: accountId, token_id: CREDIT });
      this.balances.set(accountId, { cc: Number(v), at: Date.now() });
      return Number(v);
    } catch {
      return c?.cc ?? null;
    }
  }

  private async treasuryInfo(): Promise<EconomyView["treasury"]> {
    if (!this.live) return null;
    if (this.treasury && Date.now() - this.treasuryAt < 30_000) return this.treasury;
    try {
      const e = await this.gateway!.view<{ initialized: boolean; treasury_id: string; initial_supply: string; total_supply: string; treasury_balance: string; issued: string; issue_cap: string; npc_spending_paused: boolean; buckets: { name: string; cap: string; granted: string }[] }>("economy_info", {});
      if (!e.initialized) return null;
      this.treasury = { treasuryId: e.treasury_id, initialSupplyCc: Number(e.initial_supply), totalSupplyCc: Number(e.total_supply), treasuryBalanceCc: Number(e.treasury_balance), issuedCc: Number(e.issued), issueCapCc: Number(e.issue_cap), buckets: e.buckets.map((b) => ({ name: b.name, capCc: Number(b.cap), grantedCc: Number(b.granted) })), npcSpendingPaused: e.npc_spending_paused };
      this.treasuryAt = Date.now();
    } catch {
      /* keep the last read */
    }
    return this.treasury;
  }

  opView(r: OpRow): ChainOpView {
    return { opId: r.op_id, kind: r.kind, label: labelOf(r, this), status: r.status, signer: r.signer, txHash: r.tx_hash, txUrl: r.tx_hash && this.live ? `${this.cfg.explorerTxBase}${r.tx_hash}` : null, detail: r.status === "failed" ? friendly(r.detail ?? "") : null, at: r.updated_at };
  }

  /** Sanitized operator evidence: transaction outcomes and fee-account balances, never keys or raw call arguments. */
  async auditEvidence(limit = 100, offset = 0) {
    const take = Math.max(1, Math.min(200, Math.trunc(limit)));
    const skip = Number.isFinite(offset) ? Math.max(0, Math.min(2_147_483_647, Math.trunc(offset))) : 0;
    const operations = this.db.prepare(
      "SELECT op_id, kind, signer, method, status, tx_hash, detail, created_at, updated_at FROM chain_ops ORDER BY rowid DESC LIMIT ? OFFSET ?",
    ).all(take, skip) as { op_id: string; kind: string; signer: string; method: string; status: string; tx_hash: string | null; detail: string | null; created_at: string; updated_at: string }[];
    const epochs = this.db.prepare(
      "SELECT epoch_id, status, tx_hash, attempts, created_at, updated_at FROM settlement_epochs ORDER BY rowid DESC LIMIT ? OFFSET ?",
    ).all(take, skip) as { epoch_id: string; status: string; tx_hash: string | null; attempts: number; created_at: string; updated_at: string }[];
    const signers = [
      ...(this.cfg.operator ? [{ role: "operator", accountId: this.cfg.operator.accountId }] : []),
      ...(this.cfg.playerParent ? [{ role: "player account provisioner", accountId: this.cfg.playerParent.accountId }] : []),
      ...Object.entries(this.cfg.npcs).filter(([, n]) => n.privateKey).map(([id, n]) => ({ role: `NPC ${id}`, accountId: n.accountId })),
    ];
    const accounts = await Promise.all(signers.map(async ({ role, accountId }) => {
      let nearBalance: number | null = null;
      if (this.live && this.gateway) {
        try { nearBalance = await this.gateway.nearBalance(accountId); } catch { /* show unavailable rather than a guessed balance */ }
      }
      return { role, accountId, nearBalance };
    }));
    return {
      generatedAt: nowIso(),
      network: "testnet",
      mode: this.live ? "connected" : "disabled",
      contractId: this.live ? this.cfg.contractId : null,
      pagination: {
        operations: { offset: skip, limit: take, total: Number((this.db.prepare("SELECT COUNT(*) AS total FROM chain_ops").get() as { total: number }).total) },
        settlements: { offset: skip, limit: take, total: Number((this.db.prepare("SELECT COUNT(*) AS total FROM settlement_epochs").get() as { total: number }).total) },
      },
      accounts,
      operationCounts: this.db.prepare("SELECT status, COUNT(*) AS count FROM chain_ops GROUP BY status").all() as { status: string; count: number }[],
      operations: operations.map((r) => ({
        operationId: r.op_id,
        kind: r.kind,
        signer: r.signer,
        method: r.method,
        status: r.status,
        txHash: r.tx_hash,
        explorerUrl: r.tx_hash && this.live ? `${this.cfg.explorerTxBase}${r.tx_hash}` : null,
        detail: r.status === "failed" && r.detail ? friendly(r.detail) : null,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
      settlements: epochs.map((r) => ({
        epochId: r.epoch_id,
        status: r.status,
        attempts: r.attempts,
        txHash: r.tx_hash,
        explorerUrl: r.tx_hash && this.live ? `${this.cfg.explorerTxBase}${r.tx_hash}` : null,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    };
  }

  /** Transaction hashes for an order (the buyer's escrow, the operator's confirmation), for the desk view. */
  orderTx(orderId: string): { txHash: string | null; confirmTxHash: string | null } {
    return { txHash: this.op(`order:${orderId}`)?.tx_hash ?? null, confirmTxHash: this.op(`confirm:${orderId}`)?.tx_hash ?? null };
  }

  async view(userId: string): Promise<EconomyView> {
    const { wallet, note } = this.ensureWallet(userId);
    const h = this.rsvc.liveFor(userId);
    const gameCash = region.rbal(h.state, "cc", "player");
    const t = this.tsvc.state;
    const npcs: NpcWalletView[] = [];
    for (const n of NPC_IDENTITIES) {
      const acct = this.npcAccount(n.id);
      if (!acct) continue;
      const ledger = n.kind === "merchant" ? `merchant:${town.townConfig.MERCHANTS.find((m) => m.chainName === n.id)!.merchantId}` : town.FACC(town.FIRMS.find((f) => f.chainName === n.id)!.firmId);
      npcs.push({ id: n.id, name: n.name, kind: n.kind, accountId: acct, explorerUrl: `${this.cfg.explorerAccountBase}${acct}`, onChainCc: await this.onChain(acct), gameCashCc: t.balances.cc?.[ledger] ?? 0 });
    }
    const onChain = wallet ? await this.onChain(wallet.account_id) : null;
    const mine = wallet ? [`wallet:${userId}`, `plants:${userId}`] : [];
    const ops = (this.db.prepare(`SELECT * FROM chain_ops WHERE subject IN (${["'town-open'", "'town'", "'regions'", ...mine.map(() => "?")].join(",")}) OR kind IN ('order', 'confirm') ORDER BY rowid DESC LIMIT 40`).all(...mine) as unknown as OpRow[]).map((r) => this.opView(r));
    const acct = (id: string | null) => (id ? { accountId: id, explorerUrl: `${this.cfg.explorerAccountBase}${id}`, onChainCc: null as number | null } : null);
    const grid = acct(this.cfg.gridId);
    const world = acct(this.cfg.worldId);
    if (grid) grid.onChainCc = await this.onChain(grid.accountId);
    if (world) world.onChainCc = await this.onChain(world.accountId);
    return {
      mode: this.live ? "near" : "local",
      network: "testnet",
      contractId: this.live ? this.cfg.contractId : null,
      contractUrl: this.live ? `${this.cfg.explorerAccountBase}${this.cfg.contractId}` : null,
      treasury: await this.treasuryInfo(),
      grid: this.live ? grid : null,
      world: this.live ? world : null,
      wallet: wallet
        ? { accountId: wallet.account_id, explorerUrl: this.live ? `${this.cfg.explorerAccountBase}${wallet.account_id}` : null, status: wallet.status, onChainCc: onChain, gameCashCc: gameCash, unsettledCc: wallet.status === "active" && onChain !== null ? gameCash - onChain : null, startingGrantCc: STARTER_GRANT_CC, detail: wallet.detail }
        : null,
      walletNote: note,
      npcs,
      ops,
      desk: this.desk(userId),
      plants: this.plantsView(userId),
      missing: this.cfg.missing,
    };
  }

  /**
   * Re-lines every NPC and player account on NEAR up with the game, after an incident left them apart (an outage,
   * operations abandoned under old rules). Two phases, so nothing is in flight while it runs:
   *   1. NPC spending is paused on the server, and the call returns "waiting" until no order is open in the game and
   *      no credits sit in the contract's escrow.
   *   2. Every unsettled batch is withdrawn (it never landed, so nothing moved), then the market is reopened on chain
   *      (each NPC: read its balance on NEAR, settle the exact difference against the world account) and each open
   *      wallet is re-synced (read its balance, settle the difference against the grid account). Spending resumes.
   * Every correction is a zero-sum transfer between real accounts; nothing is minted.
   */
  async resync(): Promise<{ status: "waiting" | "done"; detail: string }> {
    if (!this.live) return { status: "done", detail: "No chain connected." };
    this.cfg.npcSpending = false;
    const t = this.tsvc.state;
    const busy = (t.power?.orders ?? []).filter((o) => o.status === "placing" || o.status === "open" || o.status === "awaiting").length;
    const pool = await this.onChain(this.cfg.contractId!, true);
    const inflight = (this.db.prepare("SELECT COUNT(*) AS n FROM chain_ops WHERE kind IN ('order', 'confirm', 'expire') AND status IN ('created', 'submitted')").get() as { n: number }).n;
    if (busy > 0 || inflight > 0 || (pool ?? 1) > 0) return { status: "waiting", detail: `NPC spending paused; waiting for ${busy} open orders, ${inflight} order operations in flight and ₡${Math.round((pool ?? 0) / 100).toLocaleString("en-US")} in escrow to clear` };
    const at = nowIso();
    this.setState("resync", { at, phase: "preparing" });
    const withdrawn = this.db.prepare("UPDATE chain_ops SET status = 'failed', attempts = 99, detail = 'withdrawn by resync (never landed)', updated_at = ? WHERE kind = 'batch' AND status != 'settled'").run(at).changes;
    this.db.prepare("UPDATE settlement_epochs SET status = 'local', updated_at = ? WHERE status IN ('pending', 'submitted')").run(at);
    this.db.prepare("UPDATE player_wallets SET resource_opened_interval = NULL, resource_opened_town_tick = NULL, resource_pending_interval = NULL, resource_pending_town_tick = NULL, resource_pending_op_id = NULL, updated_at = ? WHERE status = 'active'").run(at);
    // the market: reopen with a fresh id (ensureTownOpen reads every NPC's balance on chain and settles the difference)
    this.db.prepare("DELETE FROM economy_state WHERE key = 'town_open'").run();
    await this.ensureTownOpen();
    await this.ensureTownOpen();
    // each open wallet: read it, settle the difference, and start its epochs from now
    const tick = this.tsvc.state.epochStart.tick;
    let wallets = 0;
    for (const w of this.db.prepare("SELECT * FROM player_wallets WHERE status = 'active'").all() as unknown as WalletRow[]) {
      const h = this.rsvc.liveFor(w.player_id);
      const fromInterval = region.forceCloseEpoch(h.state);
      this.rsvc.checkpoint(h);
      const cash = region.rbal(h.state, "cc", "player");
      const have = await this.onChain(w.account_id, true);
      if (have === null) continue;
      this.db.prepare("UPDATE player_wallets SET opened_interval = ?, opened_town_tick = ?, updated_at = ? WHERE player_id = ?").run(fromInterval, tick, at, w.player_id);
      if (cash !== have) {
        const id = `resync:${w.player_id}:${Date.now().toString(36)}`;
        this.enqueue({ opId: `batch:${id}`, kind: "batch", subject: `resync:${w.player_id}`, signer: "operator", method: "settle_batch", args: { epoch_id: id, hash: region.sha256(region.canonical({ w: w.account_id, cash, have })), entries: [[CREDIT, [[w.account_id, String(cash - have)], [this.cfg.gridId!, String(have - cash)]].sort(([a], [b]) => a.localeCompare(b))]] } });
      }
      wallets++;
    }
    // NPCs stay paused until these corrections have landed: an NPC spending meanwhile would invalidate them
    this.setState("resync", { at, phase: "settling" });
    return { status: "done", detail: `withdrew ${withdrawn} unsettled batches, reopened the market, re-synced ${wallets} wallets; NPCs resume once the corrections land` };
  }

  /** Ends a resync once its corrections have landed: NPC spending resumes. Called by the worker. */
  finishResync(): void {
    if (!this.getState("resync")) return;
    const open = this.townOpened();
    const left = (this.db.prepare("SELECT COUNT(*) AS n FROM chain_ops WHERE subject LIKE 'resync:%' AND status != 'settled'").get() as { n: number }).n;
    if (!open || left > 0) {
      this.cfg.npcSpending = false;
      return;
    }
    this.db.prepare("DELETE FROM economy_state WHERE key = 'resync'").run();
    this.cfg.npcSpending = true;
  }

  /* ================================================================ leaving game custody */

  /**
   * "Take my money and leave": the company's cash goes to the player's own wallet, and the wallet calls the
   * contract's `release_to_owner` itself, after which the game can never move that account's tokens again.
   *   1. the cash is set aside in the game at once (it can't be spent twice);
   *   2. waits until no queued settlement still involves the wallet;
   *   3. one batch settles the wallet to exactly that cash (against the grid);
   *   4. the player-parent sends the wallet a little NEAR for its own transaction fee;
   *   5. the wallet signs `release_to_owner`. Done: status "released".
   * If step 3 is refused, the cash goes back to the company and nothing has left custody.
   */
  async leaveCustody(userId: string): Promise<{ status: "leaving" | "waiting" | "released"; detail: string }> {
    if (!this.live) throw new Error("This server isn't connected to NEAR.");
    const w = this.wallet(userId);
    if (!w) throw new Error("You don't have a wallet yet.");
    if (w.status === "released") return { status: "released", detail: "This wallet is already yours alone." };
    if (w.status === "leaving") return { status: "leaving", detail: "Already on its way to you." };
    if (w.status !== "active") throw new Error("Your wallet isn't open yet.");
    const busy = (this.db.prepare("SELECT COUNT(*) AS n FROM chain_ops WHERE status IN ('created', 'submitted') AND args_json LIKE ?").get(`%${w.account_id}%`) as { n: number }).n;
    if (busy > 0) return { status: "waiting", detail: `${busy} settlement${busy > 1 ? "s" : ""} for your wallet still on the way. Try again in a minute.` };
    const h = this.rsvc.liveFor(userId);
    const cash = Math.max(0, region.rbal(h.state, "cc", "player"));
    const have = await this.onChain(w.account_id, true);
    if (have === null) throw new Error("Couldn't read your wallet on NEAR. Try again.");
    this.setState(`leave:${userId}`, { cash });
    this.db.prepare("UPDATE player_wallets SET status = 'leaving', detail = NULL, updated_at = ? WHERE player_id = ?").run(nowIso(), userId);
    if (cash > 0) this.rsvc.act(h, { type: "CASH_OUT", ref: `leave:${userId}`, cc: cash, out: true }, `leave-out:${userId}`, "system");
    const id = `leave:${userId}`;
    if (cash !== have)
      this.enqueue({ opId: `batch:${id}`, kind: "batch", subject: id, signer: "operator", method: "settle_batch", args: { epoch_id: id, hash: region.sha256(region.canonical({ w: w.account_id, cash, have })), entries: [[CREDIT, [[w.account_id, String(cash - have)], [this.cfg.gridId!, String(have - cash)]].sort(([a], [b]) => a.localeCompare(b))]] } });
    else this.leaveStep(userId, null);
    return { status: "leaving", detail: `₡${Math.round(cash / 100).toLocaleString("en-US")} is on its way to your wallet.` };
  }

  private leaveStep(userId: string, row: OpRow | null): void {
    const w = this.wallet(userId);
    if (!w || w.status !== "leaving") return;
    const id = `leave:${userId}`;
    // the wallet pays its own fee for the release; whatever it doesn't use stays in the wallet, the player's NEAR
    if (!row || row.kind === "batch") this.enqueue({ opId: `fund:${id}:1`, kind: "fund", subject: id, signer: "player-parent", method: "transfer", args: { receiver_id: w.account_id, near: "0.05" } });
    else if (row.kind === "fund") this.enqueue({ opId: `release:${id}:${row.op_id.split(":").pop()}`, kind: "release", subject: id, signer: `wallet:${userId}`, method: "release_to_owner", args: { _account_id: w.account_id } });
    else if (row.kind === "release") this.db.prepare("UPDATE player_wallets SET status = 'released', detail = NULL, updated_at = ? WHERE player_id = ?").run(nowIso(), userId);
  }

  private leaveFailed(userId: string, detail: string): void {
    const w = this.wallet(userId);
    if (!w || w.status !== "leaving") return;
    const cash = this.getState<{ cash: number }>(`leave:${userId}`)?.cash ?? 0;
    // nothing left custody: the cash goes back to the company
    if (cash > 0) this.rsvc.act(this.rsvc.liveFor(userId), { type: "CASH_OUT", ref: `leave:${userId}`, cc: cash, out: false }, `leave-back:${userId}:${Date.now()}`, "system");
    this.db.prepare("UPDATE player_wallets SET status = 'active', detail = ?, updated_at = ? WHERE player_id = ?").run(`Withdrawal refused (${friendly(detail)}); your cash is back in the company.`, nowIso(), userId);
  }

  /** Emergency stop: the contract stops every NPC's spending, and the server stops placing NPC orders. */
  pauseNpcSpending(paused: boolean): void {
    this.cfg.npcSpending = !paused;
    this.enqueue({ opId: `admin:npc-spending:${Date.now()}`, kind: "admin", subject: "admin", signer: "operator", method: "set_npc_spending_paused", args: { paused } });
  }
}

function townTotals(b: Record<string, Record<string, number>>): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [asset, book] of Object.entries(b)) {
    const o = (out[asset] = {} as Record<string, number>);
    for (const [acct, v] of Object.entries(book)) {
      const id = town.townIdentity(acct);
      o[id] = (o[id] ?? 0) + v;
    }
  }
  return out;
}

function friendly(detail: string): string {
  if (/per-payment limit/.test(detail)) return "above the company's per-payment limit";
  if (/daily spending limit/.test(detail)) return "the company hit its daily spending limit";
  if (/spending is paused|NPC spending is paused/.test(detail)) return "NPC spending is paused";
  if (/Insufficient/.test(detail)) return "not enough credits in the paying account";
  if (/exhausted/.test(detail)) return "that treasury bucket is empty";
  return detail.replace(/\{.*\}/, "").slice(0, 160) || "refused";
}

function labelOf(r: OpRow, svc: EconomyService): string {
  const a = JSON.parse(r.args_json) as Record<string, unknown>;
  switch (r.kind) {
    case "account":
      return `New wallet ${String(a.account_id)}`;
    case "grant":
      return `${String(a.memo ?? "Grant")}: ${cr(Number(a.amount))} from the treasury`;
    case "order": {
      const o = a as { kwh: number; price_per_mwh: string; seller_id: string };
      void svc;
      return `${r.signer.slice(4)} escrows ${cr(Math.ceil((o.kwh * Number(o.price_per_mwh)) / 1000))} for ${Math.round(o.kwh / 1000)} MWh from ${o.seller_id}`;
    }
    case "confirm":
      return `Grid confirms ${Math.round(Number(a.delivered_kwh) / 1000)} MWh delivered (order ${String(a.order_id)})`;
    case "batch":
      return String(a.epoch_id).startsWith("open:") ? `Opening balances (${String(a.epoch_id)})` : `Settlement ${String(a.epoch_id)}`;
    case "expire":
      return `Escrow refunded to the buyer (order ${String(a.order_id)}): the game didn't use it`;
    case "plant":
      return r.method === "plant_mint" ? `${(a.metadata as { title: string }).title} minted to ${String(a.owner_id)}` : `Plant ${String(a.token_id)} sold: leaves ${String(a.owner_id)}`;
    default:
      return r.method;
  }
}
