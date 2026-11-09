/**
 * EconomyService: the bridge between the game's economy and NEAR testnet.
 *
 * What lives where
 *   off chain  the simulation: weather, generation, fuel burn, demand, prices, every NPC decision, real-time play.
 *   on chain   money (credit:vesper, fixed supply), who holds it, every payment between real accounts, Vesper
 *              Market's item custody, and the power orders NPC companies sign with their own keys.
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
import { nowIso, type Db } from "../db.ts";
import type { RegionHandle, RegionService } from "../region.ts";
import type { TownService } from "../town.ts";
import type { EconomyConfig } from "./config.ts";
import type { ChainGateway, GatewayResult, Signer } from "./gateway.ts";
import { GRID_TRANCHE_CC, NPC_IDENTITIES, STARTER_GRANT_CC, TOPUP_BELOW_BPS, WORLD_TRANCHE_CC } from "./treasury.ts";
import { newWalletKey, openKey, sealKey, walletAccountId } from "./wallets.ts";

const CREDIT = "credit:vesper";
const ITEM_TOKENS = ["fuel:natural-gas", "fuel:diesel", "permit:carbon", "certificate:renewable", "material:steel", "part:turbine"];
const RETRYABLE = /Insufficient|exhausted|timeout|TIMEOUT|broadcast|nonce|InvalidNonce|Expired/i;
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
  status: "creating" | "opening" | "active" | "failed";
  region_id: string | null;
  opened_interval: number | null;
  opened_town_tick: number | null;
  opening_cash_cc: number | null;
  detail: string | null;
  created_at: string;
}

const cr = (cc: number) => `₡${Math.round(cc / 100).toLocaleString("en-US")}`;

export class EconomyService {
  private balances = new Map<string, { cc: number; at: number }>();
  private treasury: EconomyView["treasury"] = null;
  private treasuryAt = 0;
  private busy = false;
  private applied = new Set<string>();

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
    if (!this.isRegistered(userId)) return { wallet: null, note: "Guests play with game money only. Sign in and your company gets its own NEAR wallet, with the same balance." };
    const have = this.wallet(userId);
    if (have) return { wallet: have, note: null };
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
    throw new Error(`unknown signer ${s}`);
  }

  /** One pass of the worker: submit what's new, look up what's in flight, retry what can be retried. Serial. */
  async processOps(limit = 24): Promise<number> {
    if (!this.live || this.busy) return 0;
    this.busy = true;
    let n = 0;
    try {
      const rows = this.db
        .prepare(
          `SELECT * FROM chain_ops WHERE status = 'created'
             OR (status = 'submitted' AND updated_at < ?)
             OR (status = 'failed' AND attempts < 8 AND updated_at < ? AND detail IS NOT NULL)
           ORDER BY rowid LIMIT ?`,
        )
        .all(new Date(Date.now() - 20_000).toISOString(), new Date(Date.now() - 60_000).toISOString(), limit) as unknown as OpRow[];
      // each signer has its own nonce, so different signers go in parallel; one signer's operations stay in order
      const bySigner = new Map<string, OpRow[]>();
      for (const row of rows) {
        if (row.status === "failed" && !this.retryable(row, row.detail ?? "")) continue;
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
    let r: GatewayResult;
    if (row.status === "submitted" && row.tx_hash) {
      r = await gw.lookup(row.tx_hash, row.signer.startsWith("npc:") ? this.npcAccount(row.signer.slice(4))! : row.signer === "operator" ? this.cfg.operator!.accountId : this.cfg.playerParent!.accountId);
      if (r.status === "pending" && (await this.reconcile(row))) r = { ...r, status: "settled", detail: "confirmed by reading the contract" };
    } else {
      this.db.prepare("UPDATE chain_ops SET status = 'submitted', attempts = attempts + 1, updated_at = ? WHERE op_id = ?").run(nowIso(), row.op_id);
      const onSigned = (h: string) => this.db.prepare("UPDATE chain_ops SET tx_hash = ?, updated_at = ? WHERE op_id = ?").run(h, nowIso(), row.op_id);
      try {
        const args = JSON.parse(row.args_json) as Record<string, unknown>;
        // keys starting with "_" are the server's own bookkeeping, never sent to the contract
        const send = Object.fromEntries(Object.entries(args).filter(([k]) => !k.startsWith("_")));
        if (row.kind === "account") r = await gw.createSubAccount(String(args.account_id), String(args.public_key), onSigned);
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
   * Worth trying again? Transient network trouble, or a batch the contract refused (nothing moves when one is refused:
   * usually a float that needs topping up). Never an NPC's order: a refused escrow is final for that window.
   */
  private retryable(row: OpRow, detail: string): boolean {
    if (row.kind === "order") return false;
    return RETRYABLE.test(detail) || (row.kind === "batch" && TRAP.test(detail));
  }

  /** Did this operation happen on chain? Answered by reading the contract, never by guessing. */
  private async reconcile(row: OpRow): Promise<boolean> {
    const gw = this.gateway!;
    const a = JSON.parse(row.args_json) as Record<string, unknown>;
    try {
      if (row.kind === "account") return await gw.accountExists(String(a.account_id));
      if (row.kind === "grant") return !!(await gw.view<unknown>("grant", { grant_id: a.grant_id }));
      if (row.kind === "order") return !!(await gw.view<unknown>("power_order", { order_id: a.order_id }));
      if (row.kind === "confirm") {
        const o = await gw.view<{ status: string } | null>("power_order", { order_id: a.order_id });
        return !!o && o.status === "settled";
      }
      if (row.kind === "batch") return !!(await gw.view<unknown>("epoch", { epoch_id: a.epoch_id }));
      if (row.kind === "plant") {
        const tkn = await gw.view<{ owner_id: string } | null>("nft_token", { token_id: a.token_id });
        return !!tkn && (row.method === "plant_mint" || tkn.owner_id === a.receiver_id);
      }
    } catch {
      return false;
    }
    return false;
  }

  private onSettled(row: OpRow): void {
    if (row.effects_applied) return;
    this.db.prepare("UPDATE chain_ops SET effects_applied = 1 WHERE op_id = ?").run(row.op_id);
    const a = JSON.parse(row.args_json) as Record<string, unknown>;
    const user = row.subject?.startsWith("wallet:") ? row.subject.slice(7) : null;
    if (row.kind === "account" && user) this.openWallet(user);
    if (user && (row.kind === "grant" || row.kind === "batch")) this.maybeActivate(user);
    if (row.kind === "batch" && Array.isArray(a._epochs)) {
      const upd = this.db.prepare("UPDATE settlement_epochs SET status = 'confirmed', tx_hash = ?, updated_at = ? WHERE epoch_id = ?");
      for (const id of a._epochs as string[]) upd.run(row.tx_hash, nowIso(), id);
    }
    const t = this.tsvc.state;
    const ctx = town.newTCtx();
    if (row.kind === "order") town.activatePowerOrder(t, ctx, String(a.order_id));
    if (row.kind === "confirm") town.settlePowerOrder(t, ctx, String(a.order_id), Number(a.delivered_kwh));
    // carry it into the seller's region now, not at the next market tick
    if (row.kind === "order" || row.kind === "confirm") this.afterTownTick();
  }

  private onFailed(row: OpRow, detail: string): void {
    const user = row.subject?.startsWith("wallet:") ? row.subject.slice(7) : null;
    if (this.retryable(row, detail) && row.attempts < 8) return; // the worker tries again later
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

  private queueOrder(o: town.PowerOrderState): void {
    if (this.op(`order:${o.orderId}`)) return;
    const ctx = town.newTCtx();
    if (!this.cfg.npcSpending) return town.failPowerOrder(this.tsvc.state, ctx, o.orderId, "NPC spending is switched off on this server.");
    const buyer = town.FIRM(o.buyerId).chainName;
    const seller = o.sellerKey.startsWith("player:") ? this.activeAccount(o.sellerKey.slice(7)) : this.npcAccount(town.FIRM(o.sellerKey.slice(5)).chainName);
    if (!seller || !this.cfg.npcs[buyer]?.privateKey) return town.failPowerOrder(this.tsvc.state, ctx, o.orderId, "The seller or buyer has no NEAR account.");
    this.enqueue({
      opId: `order:${o.orderId}`,
      kind: "order",
      subject: `order:${o.orderId}`,
      signer: `npc:${buyer}`,
      method: "power_order_place",
      args: { order_id: o.orderId, seller_id: seller, kwh: o.kwh, price_per_mwh: String(o.priceCcPerMWh), expires_in_minutes: 20, memo: o.why.slice(0, 280) },
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

  /** Queues settled market epochs (once the market is open on chain) and players' region epochs, batched. */
  queueSettlement(): void {
    if (!this.live) return;
    const open = this.townOpened();
    if (!open) return;
    const rows = this.db.prepare("SELECT epoch_id, from_interval, body_json FROM settlement_epochs WHERE region_id = 'town' AND status = 'pending' ORDER BY epoch_no LIMIT 6").all() as { epoch_id: string; from_interval: number; body_json: string }[];
    for (const r of rows) {
      if (r.from_interval < open.tick) {
        this.db.prepare("UPDATE settlement_epochs SET status = 'local', updated_at = ? WHERE epoch_id = ?").run(nowIso(), r.epoch_id);
        continue;
      }
      const e = JSON.parse(r.body_json) as town.TownEpoch;
      const entries = this.townEntries(e);
      if (entries.length) this.enqueue({ opId: `batch:${e.epochId}`, kind: "batch", subject: "town", signer: "operator", method: "settle_batch", args: { epoch_id: e.epochId, hash: e.hash, entries, _epochs: [e.epochId] } });
      this.db.prepare("UPDATE settlement_epochs SET status = ?, updated_at = ? WHERE epoch_id = ?").run(entries.length ? "submitted" : "confirmed", nowIso(), r.epoch_id);
    }
    this.queueRegionEpochs();
  }

  /** A market epoch in NEAR accounts: merchants and companies their own, players their wallet (else grid), the rest the world. */
  private townEntries(e: town.TownEpoch): [string, [string, string][]][] {
    const out: [string, [string, string][]][] = [];
    for (const tk of e.tokens) {
      const m = new Map<string, number>();
      for (const x of tk.transfers) {
        let acct: string;
        if (x.account === "world") acct = this.cfg.worldId!;
        else if (x.account.startsWith("player:")) {
          const w = this.wallet(x.account.slice(7));
          // a player's money moves in their own wallet; the fuel they buy goes straight into their plants (grid custody)
          acct = tk.token === CREDIT && w?.status === "active" && e.fromTick >= (w.opened_town_tick ?? Infinity) ? w.account_id : this.cfg.gridId!;
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
    const legs: [string, number][] = [];
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
        const e = JSON.parse(r.body_json) as { transfers: { account: string; deltaCc: number }[] };
        d += e.transfers.find((x) => x.account === "player")?.deltaCc ?? 0;
        ids.push(r.epoch_id);
      }
      if (d !== 0) legs.push([w.account_id, d]);
      if (legs.length >= 38) break;
    }
    if (!ids.length) return;
    const upd = this.db.prepare("UPDATE settlement_epochs SET status = ?, updated_at = ? WHERE epoch_id = ?");
    if (!legs.length) {
      for (const id of ids) upd.run("confirmed", nowIso(), id);
      return;
    }
    const n = (this.getState<number>("region_batch") ?? 0) + 1;
    this.setState("region_batch", n);
    legs.push([this.cfg.gridId!, -legs.reduce((a, [, d]) => a + d, 0)]);
    const entries = [[CREDIT, legs.map(([a, d]) => [a, String(d)])]];
    this.enqueue({ opId: `batch:regions:${n}`, kind: "batch", subject: "regions", signer: "operator", method: "settle_batch", args: { epoch_id: `regions:${n}`, hash: region.sha256(region.canonical({ ids, legs })), entries, _epochs: ids } });
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
        const token = this.plantTokenId(h.regionId, p.assetNo);
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
    case "plant":
      return r.method === "plant_mint" ? `${(a.metadata as { title: string }).title} minted to ${String(a.owner_id)}` : `Plant ${String(a.token_id)} sold: leaves ${String(a.owner_id)}`;
    default:
      return r.method;
  }
}
