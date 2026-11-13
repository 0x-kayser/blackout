/**
 * TownService: the one Vesper Market every player trades in. It runs continuously (merchants keep trading with the
 * outside world whether or not anyone is watching), persists itself, and settles every trade on both sides at once:
 * the merchant's books in the town and the player's inventory in their region (as a recorded TOWN_SETTLE action).
 * Both are in-memory and updated in the same synchronous step, after the region side has been checked, so a trade
 * either lands everywhere or nowhere.
 */
import type { FastForwardResult, InvestQuoteRequest, ItemId, RegionAction, TradeQuote, TradeQuoteRequest, TownView, WorldSnapshot } from "@blackout/shared";
import { ITEMS } from "@blackout/shared";
import { SimError, region, town } from "@blackout/sim";
import { nowIso, type Db } from "./db.ts";
import type { RegionHandle, RegionService } from "./region.ts";
import { ApiError } from "./services.ts";
import type { EconomyService } from "./economy/service.ts";

const TOWN_SEED = 20_261_109;
const CHECKPOINT_EVERY = 5;
const U = region.regionConfig.TOWN_UNITS;
const cr = (cc: number) => `₡${(cc / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

export interface Trader {
  userId: string;
  name: string;
}

export class TownService {
  state: town.TownState;
  private listeners = new Set<{ viewer: string | null; fn: (v: TownView) => void }>();
  private sinceCheckpoint = 0;
  private lastEpochNo: number;
  private ff = new Map<string, FastForwardResult>();
  /** The on-chain economy, when the server has one (set by the server after both services exist). */
  economy: EconomyService | null = null;

  constructor(
    private readonly db: Db,
    world: WorldSnapshot,
    private readonly settlementEnabled = false,
  ) {
    const row = db.prepare("SELECT state_json FROM town_state WHERE id = 1").get() as { state_json: string } | undefined;
    this.state = row ? (JSON.parse(row.state_json) as town.TownState) : town.createTown({ seed: TOWN_SEED, world });
    const migrateResources = !!row && !this.state.resourceLedger;
    town.ensureTownResources(this.state);
    if (!row || migrateResources) this.checkpoint();
    this.lastEpochNo = this.state.epochs.at(-1)?.epochNo ?? 0;
  }

  /* ---------------------------------------------------------------- views */

  view(viewer: string | null): TownView {
    // Player views contain only game balances and decisions; operator chain evidence is served separately.
    return town.toTownView(this.state, viewer);
  }

  subscribe(viewer: string | null, fn: (v: TownView) => void): () => void {
    const l = { viewer, fn };
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private broadcast(): void {
    for (const l of this.listeners) l.fn(this.view(l.viewer));
  }

  /* ---------------------------------------------------------------- clock */

  tick(): void {
    const ctx = town.newTCtx();
    town.townTick(this.state, ctx, this.economy?.townEnv() ?? {});
    this.economy?.afterTownTick();
    this.sinceCheckpoint += 1;
    this.persistEpochs();
    if (this.sinceCheckpoint >= CHECKPOINT_EVERY) this.checkpoint();
    this.broadcast();
  }

  checkpoint(): void {
    this.db.prepare("INSERT INTO town_state (id, state_json, tick, updated_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json, tick = excluded.tick, updated_at = excluded.updated_at").run(JSON.stringify(this.state), this.state.tick, nowIso());
    this.sinceCheckpoint = 0;
  }

  /** Stores any epoch closed out of turn (a wallet opening, the chain going live). */
  persistEpochsNow(): void {
    this.persistEpochs();
  }

  private persistEpochs(): void {
    const fresh = this.state.epochs.filter((e) => e.epochNo > this.lastEpochNo);
    if (!fresh.length) return;
    const at = nowIso();
    const ins = this.db.prepare("INSERT OR IGNORE INTO settlement_epochs (epoch_id, region_id, epoch_no, from_interval, to_interval, hash, body_json, status, tx_hash, attempts, created_at, updated_at) VALUES (?, 'town', ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)");
    for (const e of fresh) ins.run(e.epochId, e.epochNo, e.fromTick, e.toTick, e.hash, JSON.stringify(e), this.settlementEnabled ? "pending" : "local", at, at);
    this.lastEpochNo = fresh[fresh.length - 1].epochNo;
  }

  /** A company renamed itself: its past trades, investments and future trades carry the new name. */
  renamePlayer(userId: string, name: string): void {
    const t = this.state;
    if (t.names[userId] !== undefined) t.names[userId] = name;
    for (const tr of t.trades) if (tr.who === userId) tr.label = name;
    for (const st of Object.values(t.merchants)) for (const inv of st.investors) if (inv.playerId === userId) inv.name = name;
    this.checkpoint();
    this.broadcast();
  }

  applyWorld(snap: WorldSnapshot): void {
    town.setTownWorld(this.state, { gasUsdPerMMBtu: snap.gasUsdPerMMBtu, brentUsdPerBbl: snap.brentUsdPerBbl, carbonUsdPerT: snap.carbonUsdPerT });
  }

  setSteelSupply(bps: number): void {
    this.state.steelSupplyBps = Math.max(2_000, Math.min(12_000, Math.round(bps)));
  }

  fuelPrices() {
    return town.townFuelPrices(this.state);
  }

  /* ---------------------------------------------------------------- trading */

  private idempotent<T>(userId: string, key: string, kind: string, req: unknown, run: () => T): T & { replayed?: boolean } {
    const prior = this.db.prepare("SELECT result_json FROM town_actions WHERE user_id = ? AND idempotency_key = ?").get(userId, key) as { result_json: string } | undefined;
    if (prior) return { ...(JSON.parse(prior.result_json) as T), replayed: true };
    const out = run();
    this.db.prepare("INSERT INTO town_actions (user_id, idempotency_key, kind, request_json, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(userId, key, kind, JSON.stringify(req), JSON.stringify(out), nowIso());
    return out as T & { replayed?: boolean };
  }

  /** Units of `item` the player holds in their region, in market units. */
  held(h: RegionHandle, item: ItemId): number {
    const u = U[item];
    return Math.floor(region.rbal(h.state, u.asset, region.RACC.player) / u.per);
  }

  /** Estimates a trade from current books without reserving cash or inventory. The write route rechecks it. */
  tradeQuote(h: RegionHandle, req: TradeQuoteRequest): TradeQuote {
    const m = town.merchantConfig(req.merchantId);
    if (!m) throw new ApiError("NOT_FOUND", "No such merchant.");
    const item = m.items.find((x) => x.item === req.item);
    if (!item) throw new ApiError("VALIDATION_FAILED", `${m.person} doesn't trade ${ITEMS[req.item].name.toLowerCase()}.`);

    const account = town.MACC(req.merchantId);
    const merchantStock = town.tbal(this.state, req.item, account);
    const merchantCash = town.tbal(this.state, "cc", account);
    const held = this.held(h, req.item);
    const cashCc = region.rbal(h.state, "cc", region.RACC.player);
    const estimate = town.tradePrice(this.state, req.merchantId, req.item, req.side, req.quantity);
    const now = town.quote(this.state, req.merchantId, req.item);
    const currentUnitCc = (req.side === "buy" ? now.askCc : now.bidCc) ?? estimate.unitCc;
    const room = Math.max(0, item.target * town.townConfig.WAREHOUSE_FULL_X - merchantStock);
    const ration = town.rationLimit({ traits: m.traits, stock: merchantStock, target: item.target });

    let reason: string | null = null;
    if (!this.state.merchants[req.merchantId].open) reason = `${m.name} is closed.`;
    else if (req.side === "buy" && !item.sells) reason = `${m.person} doesn't sell ${ITEMS[req.item].name.toLowerCase()}.`;
    else if (req.side === "sell" && !item.buys) reason = `${m.person} doesn't buy ${ITEMS[req.item].name.toLowerCase()}.`;
    else if (req.side === "buy" && req.quantity > merchantStock) reason = `${m.person} has only ${merchantStock.toLocaleString("en-US")} ${ITEMS[req.item].units} in stock.`;
    else if (req.side === "buy" && ration !== null && req.quantity > ration) reason = `${m.person} is rationing and will sell at most ${ration.toLocaleString("en-US")} ${ITEMS[req.item].units} per order.`;
    else if (req.side === "buy" && estimate.totalCc > cashCc) reason = `You need ${cr(estimate.totalCc)}; your cash is ${cr(cashCc)}.`;
    else if (req.side === "sell" && req.quantity > held) reason = `You hold ${held.toLocaleString("en-US")} ${ITEMS[req.item].units}.`;
    else if (req.side === "sell" && req.quantity > room) reason = `${m.person} has room for only ${room.toLocaleString("en-US")} more ${ITEMS[req.item].units}.`;
    else if (req.side === "sell" && estimate.totalCc > merchantCash) reason = `${m.person} has ${cr(merchantCash)} available to buy this order.`;

    return {
      merchantId: req.merchantId,
      item: req.item,
      side: req.side,
      quantity: req.quantity,
      unitCc: estimate.unitCc,
      totalCc: estimate.totalCc,
      currentUnitCc,
      feeCc: 0,
      cashCc,
      cashAfterCc: req.side === "buy" ? cashCc - estimate.totalCc : cashCc + estimate.totalCc,
      held,
      heldAfter: req.side === "buy" ? held + req.quantity : held - req.quantity,
      merchantStock,
      merchantStockAfter: req.side === "buy" ? merchantStock - req.quantity : merchantStock + req.quantity,
      canTrade: reason === null,
      reason,
    };
  }

  /** Preview an investment against the current merchant ledger without moving cash. The write route rechecks it. */
  investmentQuote(h: RegionHandle, req: InvestQuoteRequest) {
    const config = town.merchantConfig(req.merchantId);
    if (!config) throw new ApiError("NOT_FOUND", "No such merchant.");
    const merchant = this.state.merchants[req.merchantId];
    const investor = merchant.investors.find((x) => x.playerId === h.ownerId);
    const invested = investor?.investedCc ?? 0;
    const investedAfter = merchant.investors.reduce((sum, x) => sum + x.investedCc, 0) + req.amountCc;
    const shareBps = Math.round(((invested + req.amountCc) * 10_000) / Math.max(1, investedAfter + config.cashCc));
    const cashCc = region.rbal(h.state, "cc", region.RACC.player);
    const minimumCc = merchant.open ? 100_000 : town.reopenCc(req.merchantId);
    const reason = req.amountCc < minimumCc
      ? `${config.name} needs at least ${cr(minimumCc)}${merchant.open ? " for an investment" : " to reopen"}.`
      : req.amountCc > cashCc
        ? `You need ${cr(req.amountCc)}; your cash is ${cr(cashCc)}.`
        : null;
    return {
      merchantId: req.merchantId,
      amountCc: req.amountCc,
      cashCc,
      cashAfterCc: cashCc - req.amountCc,
      shareBps,
      minimumCc,
      reopens: !merchant.open && req.amountCc >= minimumCc,
      canInvest: reason === null,
      reason,
    };
  }

  /** A player's trade. Checks the region side first, then moves the merchant and the player together. */
  trade(who: Trader, h: RegionHandle, rsvc: RegionService, req: { merchantId: string; item: ItemId; side: "buy" | "sell"; quantity: number }, key: string, kind: "player" | "auto" = "player") {
    return this.idempotent(who.userId, key, "trade", req, () => {
      const m = town.merchantConfig(req.merchantId);
      if (!m) throw new ApiError("NOT_FOUND", "No such merchant.");
      const est = town.tradePrice(this.state, req.merchantId, req.item, req.side, req.quantity);
      const cash = region.rbal(h.state, "cc", region.RACC.player);
      if (req.side === "buy" && cash < est.totalCc) throw new ApiError("INSUFFICIENT_CREDITS", `That costs ₡${Math.round(est.totalCc / 100).toLocaleString("en-US")}; you have ₡${Math.round(cash / 100).toLocaleString("en-US")}.`);
      if (req.side === "sell" && this.held(h, req.item) < req.quantity) throw new ApiError("REQUIREMENT_NOT_MET", `You have only ${this.held(h, req.item).toLocaleString("en-US")} ${ITEMS[req.item].units}.`);
      let tr;
      try {
        tr = town.townTrade(this.state, town.newTCtx(), { playerId: who.userId, name: who.name, merchantId: req.merchantId, item: req.item, side: req.side, quantity: req.quantity });
      } catch (e) {
        if (e instanceof SimError) throw new ApiError(e.code, e.message);
        throw e;
      }
      const sign = req.side === "buy" ? 1 : -1;
      const verb = req.side === "buy" ? "Bought" : "Sold";
      const reason = `${verb} ${req.quantity.toLocaleString("en-US")} ${ITEMS[req.item].units} ${req.side === "buy" ? "from" : "to"} ${m.person} at ₡${(tr.priceCc / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })} each`;
      const r = rsvc.act(h, { type: "TOWN_SETTLE", ref: `trade:${tr.seq}`, reason, cc: -sign * tr.totalCc, items: { [req.item]: sign * req.quantity }, income: req.side === "sell" }, `town:trade:${tr.seq}`, "system");
      if (!r.ok) throw new ApiError("INTERNAL", `The trade reached ${m.person} but not your books: ${r.error?.message}`);
      this.checkpoint();
      this.broadcast();
      return { ok: true as const, message: kind === "auto" ? reason : `${reason}.`, trade: tr };
    });
  }

  invest(who: Trader, h: RegionHandle, rsvc: RegionService, req: { merchantId: string; amountCc: number }, key: string) {
    return this.idempotent(who.userId, key, "invest", req, () => {
      const m = town.merchantConfig(req.merchantId);
      if (!m) throw new ApiError("NOT_FOUND", "No such merchant.");
      if (region.rbal(h.state, "cc", region.RACC.player) < req.amountCc) throw new ApiError("INSUFFICIENT_CREDITS", "You don't have that much cash.");
      let r;
      try {
        r = town.townInvest(this.state, town.newTCtx(), { playerId: who.userId, name: who.name, merchantId: req.merchantId, amountCc: req.amountCc });
      } catch (e) {
        if (e instanceof SimError) throw new ApiError(e.code, e.message);
        throw e;
      }
      rsvc.act(h, { type: "TOWN_SETTLE", ref: `invest:${req.merchantId}:${key}`, reason: `Invested in ${m.name}`, cc: -req.amountCc }, `town:invest:${who.userId}:${key}`, "system");
      this.checkpoint();
      this.broadcast();
      return { ok: true as const, message: r.reopened ? `${m.name} is open again. You own ${(r.shareBps / 100).toFixed(1)}% of its profits.` : `You now own ${(r.shareBps / 100).toFixed(1)}% of ${m.name}'s profits.`, reopened: r.reopened, shareBps: r.shareBps };
    });
  }

  /** Buys what an action needs (steel for builds, kits for repairs) from the best open merchant. */
  prepare(who: Trader, h: RegionHandle, rsvc: RegionService, action: RegionAction): void {
    const need = this.needs(h, action);
    if (!need) return;
    const short = need.qty - this.held(h, need.item);
    if (short <= 0) return;
    const merchantId = town.bestMerchant(this.state, need.item, "buy", short);
    if (!merchantId) throw new SimError("OUT_OF_STOCK", `Nobody in Vesper Market has ${short} ${ITEMS[need.item].units} of ${ITEMS[need.item].name.toLowerCase()} for sale right now. A closed shop reopens when someone invests in it.`);
    const est = town.tradePrice(this.state, merchantId, need.item, "buy", short);
    const cash = region.rbal(h.state, "cc", region.RACC.player);
    if (cash < est.totalCc + need.creditsCc) throw new SimError("INSUFFICIENT_CREDITS", `That needs ₡${Math.round((est.totalCc + need.creditsCc) / 100).toLocaleString("en-US")} (₡${Math.round(need.creditsCc / 100).toLocaleString("en-US")} plus ${short} ${ITEMS[need.item].units} of ${ITEMS[need.item].name.toLowerCase()} at ₡${Math.round(est.unitCc / 100).toLocaleString("en-US")}); you have ₡${Math.round(cash / 100).toLocaleString("en-US")}.`);
    try {
      this.trade(who, h, rsvc, { merchantId, item: need.item, side: "buy", quantity: short }, `auto:${need.item}:${h.state.stateVersion}:${short}`, "auto");
    } catch (e) {
      if (e instanceof ApiError) throw new SimError(e.code, e.message);
      throw e;
    }
  }

  private needs(h: RegionHandle, a: RegionAction): { item: ItemId; qty: number; creditsCc: number } | null {
    const cfg = region.regionConfig;
    if (a.type === "BUILD_PLANT") {
      const size = cfg.TECHS[a.tech].sizes[a.size];
      return size ? { item: "material:steel", qty: cfg.steelForCc(size.costCc), creditsCc: cfg.creditsForCc(size.costCc) } : null;
    }
    if (a.type === "UPGRADE_CORRIDOR") {
      const c = cfg.CORRIDORS.find((x) => x.corridorId === a.corridorId);
      return c ? { item: "material:steel", qty: cfg.steelForCc(c.upgradeCc), creditsCc: cfg.creditsForCc(c.upgradeCc) } : null;
    }
    if (a.type === "REPAIR_PLANT") {
      const p = h.state.plants.find((x) => x.plantId === a.plantId);
      return p ? { item: "part:turbine", qty: cfg.PARTS_FOR_REPAIR[p.tech], creditsCc: 0 } : null;
    }
    return null;
  }

  /** Every few intervals: dividends land, market fuel prices reach the region, auto-buy keeps fuel stocked. */
  serviceRegion(who: Trader, h: RegionHandle, rsvc: RegionService): void {
    const owed = town.takeOwed(this.state, who.userId);
    if (owed > 0) rsvc.act(h, { type: "TOWN_SETTLE", ref: `dividend:${this.state.tick}`, reason: `Dividends from Vesper Market: ₡${Math.round(owed / 100).toLocaleString("en-US")}`, cc: owed, income: true }, `town:div:${who.userId}:${this.state.tick}:${owed}`, "system");
    if (h.state.interval % 6 === 0) {
      const p = this.fuelPrices();
      const cur = h.state.townPrices;
      if (!cur || cur.gas !== p.gas || cur.diesel !== p.diesel) rsvc.act(h, { type: "TOWN_PRICES", gas: p.gas, diesel: p.diesel }, `town:prices:${h.regionId}:${h.state.interval}`, "system");
    }
    if (h.state.interval % 3 === 0) for (const fuel of ["gas", "diesel"] as const) this.autoFuel(who, h, rsvc, fuel);
  }

  private autoFuel(who: Trader, h: RegionHandle, rsvc: RegionService, fuel: "gas" | "diesel"): void {
    if (!h.state.player.autoFuel[fuel]) return;
    const cfg = region.regionConfig;
    const plants = h.state.plants.filter((p) => p.ownerId === "player" && cfg.TECHS[p.tech].fuel === fuel && (p.status === "online" || p.status === "starting"));
    if (!plants.length) return;
    const item: ItemId = fuel === "gas" ? "fuel:natural-gas" : "fuel:diesel";
    const perInterval = plants.reduce((a, p) => a + (p.capacityKw / 1000) * (cfg.TECHS[p.tech].heatRate / 12), 0);
    const target = Math.ceil(perInterval * 36);
    const have = this.held(h, item);
    if (have >= target / 2) return;
    let qty = target - have;
    const merchantId = town.bestMerchant(this.state, item, "buy", qty) ?? town.bestMerchant(this.state, item, "buy", Math.ceil(qty / 4));
    if (!merchantId) return;
    if (!town.bestMerchant(this.state, item, "buy", qty)) qty = Math.ceil(qty / 4);
    try {
      this.trade(who, h, rsvc, { merchantId, item, side: "buy", quantity: qty }, `auto:${item}:${h.regionId}:${h.state.interval}`, "auto");
    } catch {
      /* out of cash or rationed: the plant runs short and the inspector says so */
    }
  }

  fastForward(seed: number, you: town.FastForwardYou | null = null, days: 7 | 365 = 7): FastForwardResult {
    // Your offer and replay length are rounded into explicit cache keys; this never changes the live market.
    const y = you ? { ...you, kw: Math.round(you.kw / 1000) * 1000, priceCcPerMWh: Math.round(you.priceCcPerMWh / 100) * 100 } : null;
    const k = `${seed}:${days}:${y ? `${y.name}:${y.kw}:${y.priceCcPerMWh}` : "-"}`;
    if (!this.ff.has(k)) {
      if (this.ff.size > 32) this.ff.clear();
      this.ff.set(k, town.fastForwardWeek(seed, days, this.state.world, y));
    }
    return this.ff.get(k)!;
  }
}

export function startTownDriver(tsvc: TownService, ms = 1_000): () => void {
  const t = setInterval(() => {
    try {
      tsvc.tick();
    } catch (e) {
      console.error("town driver", e);
    }
  }, ms);
  return () => clearInterval(t);
}
