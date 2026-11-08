/**
 * Morning market: merchant stock/pricing, quotes, trades with reservation and
 * compensation, regulator permits, and merchant restocking from the importer.
 */
import { CO2_MG_PER_ML, PERMIT_MG, type MarketItem } from "@blackout/shared";
import { BASE_REFERENCE_CC_PER_L, TIMING } from "./config.ts";
import { ACC, bal, transfer, transferUpTo } from "./ledger.ts";
import { MERCHANT_POLICIES, computeMerchantPrice, importCostCcPerL, trendOf } from "./policies/merchantPricing.ts";
import { L, SimError, cr, emit, newId, type Ctx, type MerchantState, type QuoteState, type SimState, type TradeState } from "./state.ts";
import { worldModifiers } from "./world-events/engine.ts";

export const merchantStock = (s: SimState, m: MerchantState) => bal(s, "fuel_ml", ACC.merchant(m.merchantId));
export const merchantCash = (s: SimState, m: MerchantState) => bal(s, "credits_cc", ACC.merchant(m.merchantId));
export const merchantAvailable = (s: SimState, m: MerchantState) => Math.max(0, merchantStock(s, m) - m.reserveFloorMl);
export const oilTrend = (s: SimState) => trendOf(s.world.oilIndexCenti, s.world.prevOilIndexCenti);

/** Recomputes a merchant's quote from the one pricing policy; emits MERCHANT_REPRICED if it changed. */
export function repriceMerchant(s: SimState, ctx: Ctx, m: MerchantState, cause: string): void {
  const mods = worldModifiers(s);
  const reasons = computeMerchantPrice({
    logisticsCostBps: mods.logisticsCostBps + (s.world.exchangePremiumBps ?? 0),
    cautionBps: mods.cautionBps,
    policy: MERCHANT_POLICIES[m.policyId],
    oilIndexCenti: s.world.oilIndexCenti,
    referenceIndexCenti: s.world.referenceIndexCenti,
    baseReferenceCcPerL: BASE_REFERENCE_CC_PER_L,
    stockMl: merchantStock(s, m),
    reserveFloorMl: m.reserveFloorMl,
    targetStockMl: m.targetStockMl,
    lastDaySalesMl: m.lastDaySalesMl,
    baselineSalesMl: m.baselineSalesMl,
    trend: oilTrend(s),
  });
  const old = m.quoteCcPerL;
  m.reasons = reasons;
  m.quoteCcPerL = reasons.finalPriceCcPerL;
  if (old !== m.quoteCcPerL || m.priceHistory.length === 0) {
    m.priceHistory.push({ day: s.day, tick: s.tick, priceCcPerL: m.quoteCcPerL, cause });
    if (m.priceHistory.length > 60) m.priceHistory.shift();
    s.marketVersion += 1;
    emit(
      s,
      ctx,
      "MERCHANT_REPRICED",
      [ACC.merchant(m.merchantId)],
      `${m.name} ${old ? `${old < m.quoteCcPerL ? "raised" : "cut"} diesel from ${cr(old)} to` : "opened at"} ${cr(m.quoteCcPerL)} credits/L (${cause}). ${reasons.explanation}`,
      { merchantId: m.merchantId, oldPriceCcPerL: old, newPriceCcPerL: m.quoteCcPerL, cause, reasons },
    );
  }
}

function sellerMerchant(s: SimState, sellerId: string): MerchantState {
  const mid = sellerId.startsWith("merchant:") ? sellerId.slice("merchant:".length) : sellerId;
  const m = s.merchants[mid];
  if (!m) throw new SimError("NOT_FOUND", `unknown seller ${sellerId}`);
  return m;
}

export function requireMarketOpen(s: SimState): void {
  if (s.phase === "finished") throw new SimError("RUN_FINISHED", "This simulation has ended.");
}

/** Server-generated, time-limited quote bound to seller, item, quantity limit, price and market version. */
export function createQuote(s: SimState, ctx: Ctx, buyerId: string, sellerId: string, item: MarketItem, quantity: number): QuoteState {
  requireMarketOpen(s);
  let unitPrice: number;
  let maxQty: number;
  let reasons = null;
  if (item === "diesel") {
    const m = sellerMerchant(s, sellerId);
    if (m.status !== "open") throw new SimError("MERCHANT_CLOSED", `${m.name} is closed: no stock and no cash to restock.`);
    const avail = merchantAvailable(s, m);
    if (avail <= 0) throw new SimError("OUT_OF_STOCK", `${m.name} has no sellable diesel.`, { merchantId: m.merchantId });
    const ration = m.reasons.rationLimitMl;
    maxQty = Math.min(quantity, avail, ration ?? Number.MAX_SAFE_INTEGER);
    if (ration !== null && ration <= 0) throw new SimError("RATION_LIMIT", `${m.name} is rationing and will not sell today.`);
    unitPrice = m.quoteCcPerL;
    reasons = m.reasons;
    sellerId = ACC.merchant(m.merchantId);
  } else {
    if (sellerId !== "regulator") throw new SimError("VALIDATION_FAILED", "Permits are sold by the regulator.");
    const left = Math.floor(bal(s, "permit_mg", ACC.regulator) / PERMIT_MG);
    if (left <= 0) throw new SimError("OUT_OF_STOCK", "The regulator has no permits left today.");
    maxQty = Math.min(quantity, left);
    unitPrice = s.regulator.permitPriceCc;
  }
  const q: QuoteState = {
    quoteId: newId(s, "quote"),
    sellerId,
    buyerId,
    item,
    unitPriceCc: unitPrice,
    maxQuantity: maxQty,
    createdTick: s.tick,
    expiresTick: s.tick + TIMING.QUOTE_TTL_TICKS,
    marketVersion: s.marketVersion,
    status: "open",
    reasons,
  };
  s.quotes[q.quoteId] = q;
  emit(s, ctx, "QUOTE_CREATED", [buyerId, sellerId], `Quote ${q.quoteId}: up to ${item === "diesel" ? `${L(maxQty)} L` : `${maxQty} permits`} at ${cr(unitPrice)} credits${item === "diesel" ? "/L" : "/permit"}, valid ${TIMING.QUOTE_TTL_TICKS} s.`, {
    quoteId: q.quoteId,
    item,
    unitPriceCc: unitPrice,
    maxQuantity: maxQty,
    expiresTick: q.expiresTick,
  });
  return q;
}

export const tradeTotalCc = (item: MarketItem, qty: number, unitPriceCc: number) =>
  item === "diesel" ? Math.ceil((qty * unitPriceCc) / 1000) : qty * unitPriceCc;

export interface BuyOpts {
  /** When true the chain leg must confirm before the trade settles. */
  chainLeg: boolean;
  tokenId?: string;
}

/**
 * Validates and reserves a trade inside one atomic state transition.
 * Credits and stock move into escrow; settlement happens immediately for
 * simulation-only trades or when the chain worker reports a final outcome.
 */
export function buy(s: SimState, ctx: Ctx, buyerAcct: string, quoteId: string, quantity: number, idempotencyKey: string, opts: BuyOpts): TradeState {
  requireMarketOpen(s);
  const q = s.quotes[quoteId];
  if (!q) throw new SimError("NOT_FOUND", `Unknown quote ${quoteId}`);
  if (q.buyerId !== buyerAcct) throw new SimError("FORBIDDEN", "Quote belongs to another buyer.");
  if (q.status === "used") throw new SimError("ALREADY_PROCESSED", "Quote already used.");
  if (q.status === "expired" || s.tick >= q.expiresTick) {
    q.status = "expired";
    throw new SimError("QUOTE_EXPIRED", "Quote expired; request a fresh one.", { expiresTick: q.expiresTick, tick: s.tick });
  }
  if (quantity > q.maxQuantity) throw new SimError("QUOTE_MISMATCH", `Quantity ${quantity} exceeds quoted maximum ${q.maxQuantity}.`);
  const total = tradeTotalCc(q.item, quantity, q.unitPriceCc);
  if (bal(s, "credits_cc", buyerAcct) < total) {
    throw new SimError("INSUFFICIENT_CREDITS", `Needs ${cr(total)} credits, has ${cr(bal(s, "credits_cc", buyerAcct))}.`);
  }
  const tradeId = newId(s, "trade");
  const trade: TradeState = {
    tradeId,
    quoteId,
    idempotencyKey,
    buyerId: buyerAcct,
    sellerId: q.sellerId,
    item: q.item,
    quantity,
    unitPriceCc: q.unitPriceCc,
    totalCc: total,
    status: "reserved",
    chainStatus: opts.chainLeg ? "pending" : "simulation_only",
    tokenId: opts.chainLeg ? (opts.tokenId ?? null) : null,
    tokenAmount: opts.chainLeg && q.item === "diesel" ? String(quantity / 100) : null, // DIESEL_100ML units
    txHash: null,
    explorerUrl: null,
    error: null,
    createdTick: s.tick,
    settledTick: null,
    day: s.day,
  };

  if (q.item === "diesel") {
    const m = sellerMerchant(s, q.sellerId);
    if (m.status !== "open") throw new SimError("MERCHANT_CLOSED", `${m.name} is closed.`);
    if (merchantAvailable(s, m) < quantity) throw new SimError("OUT_OF_STOCK", `${m.name} only has ${L(merchantAvailable(s, m))} L sellable now.`);
    if (m.reasons.rationLimitMl !== null && quantity > m.reasons.rationLimitMl) {
      throw new SimError("RATION_LIMIT", `${m.name} is rationing: max ${L(m.reasons.rationLimitMl)} L per trade.`);
    }
    if (quantity % 100 !== 0) throw new SimError("VALIDATION_FAILED", "Diesel is sold in 100 mL units.");
    if (buyerAcct === ACC.player) {
      const pending = pendingFuelFor(s, buyerAcct);
      if (bal(s, "fuel_ml", ACC.player) + pending + quantity > s.player.tankCapacityMl) {
        throw new SimError("TANK_FULL", `Tank holds ${L(s.player.tankCapacityMl)} L; you have ${L(bal(s, "fuel_ml", ACC.player) + pending)} L incl. pending.`);
      }
    }
    transfer(s, ctx, "credits_cc", buyerAcct, ACC.escrowTrades, total, "trade_reserve_credits", tradeId);
    transfer(s, ctx, "fuel_ml", ACC.merchant(m.merchantId), ACC.escrowTrades, quantity, "trade_reserve_stock", tradeId);
    m.salesTodayMl += quantity;
    q.status = "used";
    s.trades[tradeId] = trade;
    emit(s, ctx, "TRADE_RESERVED", [buyerAcct, ACC.merchant(m.merchantId)], `${L(quantity)} L reserved from ${m.name} at ${cr(q.unitPriceCc)}/L (total ${cr(total)} credits). ${opts.chainLeg ? "Delivery is being confirmed; the city keeps running." : "Fuel is ready to use."}`, {
      tradeId,
      merchantId: m.merchantId,
      quantityMl: quantity,
      totalCc: total,
      chainStatus: trade.chainStatus,
    });
    repriceMerchant(s, ctx, m, `sold ${L(quantity)} L`);
  } else {
    if (bal(s, "permit_mg", ACC.regulator) < quantity * PERMIT_MG) throw new SimError("OUT_OF_STOCK", "Not enough permits left today.");
    transfer(s, ctx, "credits_cc", buyerAcct, ACC.escrowTrades, total, "trade_reserve_credits", tradeId);
    transfer(s, ctx, "permit_mg", ACC.regulator, ACC.escrowTrades, quantity * PERMIT_MG, "trade_reserve_permits", tradeId);
    q.status = "used";
    trade.chainStatus = "simulation_only";
    trade.tokenAmount = null;
    trade.tokenId = null;
    s.trades[tradeId] = trade;
    emit(s, ctx, "TRADE_RESERVED", [buyerAcct, ACC.regulator], `${quantity} permits (${quantity * 10} kg CO2) reserved at ${cr(q.unitPriceCc)} each.`, { tradeId, quantity, totalCc: total, chainStatus: trade.chainStatus });
  }
  if (trade.chainStatus === "simulation_only") settleTrade(s, ctx, tradeId, "confirmed", null, null);
  return s.trades[tradeId];
}

export function pendingFuelFor(s: SimState, acct: string): number {
  let p = 0;
  for (const t of Object.values(s.trades)) if (t.buyerId === acct && t.item === "diesel" && t.status === "reserved") p += t.quantity;
  return p;
}

/** Applies a final outcome exactly once. Re-settling a settled/compensated trade is ALREADY_PROCESSED. */
export function settleTrade(s: SimState, ctx: Ctx, tradeId: string, outcome: "confirmed" | "failed", txHash: string | null, error: string | null): TradeState {
  const t = s.trades[tradeId];
  if (!t) throw new SimError("NOT_FOUND", `Unknown trade ${tradeId}`);
  if (t.status !== "reserved") throw new SimError("ALREADY_PROCESSED", `Trade ${tradeId} already ${t.status}.`);
  const viaChain = t.chainStatus !== "simulation_only";
  if (viaChain && outcome === "confirmed" && !txHash) throw new SimError("INVALID_STATE", "A chain-backed purchase cannot be confirmed without a verified transaction hash.");
  const src = viaChain && txHash ? { source: "testnet_transaction" as const, txHash } : {};
  t.settledTick = s.tick;
  if (outcome === "confirmed") {
    transfer(s, ctx, "credits_cc", ACC.escrowTrades, t.sellerId, t.totalCc, "trade_settle_credits", tradeId, viaChain ? txHash : null);
    if (t.item === "diesel") {
      // update buyer fuel cost basis (weighted average)
      if (t.buyerId === ACC.player) {
        const have = bal(s, "fuel_ml", ACC.player);
        s.player.fuelCostBasisCcPerL = Math.round((s.player.fuelCostBasisCcPerL * have + t.unitPriceCc * t.quantity) / Math.max(1, have + t.quantity));
      } else if (t.buyerId === ACC.rival) {
        const have = bal(s, "fuel_ml", ACC.rival);
        s.rival.fuelCostBasisCcPerL = Math.round((s.rival.fuelCostBasisCcPerL * have + t.unitPriceCc * t.quantity) / Math.max(1, have + t.quantity));
      }
      transfer(s, ctx, "fuel_ml", ACC.escrowTrades, t.buyerId, t.quantity, "trade_settle_fuel", tradeId, viaChain ? txHash : null);
      if (viaChain && t.buyerId === ACC.player) s.player.chainBackedFuelMl = (s.player.chainBackedFuelMl ?? 0) + t.quantity;
      if (t.buyerId === ACC.player) s.player.exchangeEligibleFuelMl = (s.player.exchangeEligibleFuelMl ?? 0) + t.quantity;
    } else {
      transfer(s, ctx, "permit_mg", ACC.escrowTrades, t.buyerId, t.quantity * PERMIT_MG, "trade_settle_permits", tradeId);
      s.regulator.permitsSoldToday += t.quantity;
      s.regulator.permitsSoldTotal += t.quantity;
      emit(s, ctx, "PERMITS_PURCHASED", [t.buyerId, ACC.regulator], `${t.buyerId === ACC.player ? "You" : "VoltLine"} bought ${t.quantity} permits (${t.quantity * 10} kg CO2 allowance) for ${cr(t.totalCc)} credits.`, { tradeId, quantity: t.quantity, totalCc: t.totalCc });
    }
    t.status = "settled";
    if (viaChain) t.chainStatus = "confirmed";
    if (t.buyerId === ACC.player && t.item === "diesel") s.totals.dieselPurchases = (s.totals.dieselPurchases ?? 0) + 1;
    t.txHash = txHash;
    if (t.buyerId === ACC.player) s.dayStats.spendCc += t.totalCc;
    emit(s, ctx, "TRADE_CONFIRMED", [t.buyerId, t.sellerId], viaChain ? `Testnet transfer confirmed for trade ${tradeId}: ${t.item === "diesel" ? `${L(t.quantity)} L` : `${t.quantity} permits`} delivered.` : `Trade ${tradeId} settled in the game ledger: ${t.item === "diesel" ? `${L(t.quantity)} L` : `${t.quantity} permits`} delivered.`, {
      tradeId,
      item: t.item,
      quantity: t.quantity,
      totalCc: t.totalCc,
      chainStatus: t.chainStatus,
    }, src);
  } else {
    // compensation: exactly once, both legs back to their owners
    transfer(s, ctx, "credits_cc", ACC.escrowTrades, t.buyerId, t.totalCc, "trade_compensate_credits", tradeId);
    if (t.item === "diesel") {
      transfer(s, ctx, "fuel_ml", ACC.escrowTrades, t.sellerId, t.quantity, "trade_compensate_stock", tradeId);
      const m = sellerMerchant(s, t.sellerId);
      m.salesTodayMl = Math.max(0, m.salesTodayMl - t.quantity);
      repriceMerchant(s, ctx, m, "failed trade returned stock");
    } else {
      transfer(s, ctx, "permit_mg", ACC.escrowTrades, ACC.regulator, t.quantity * PERMIT_MG, "trade_compensate_permits", tradeId);
    }
    t.status = "compensated";
    t.chainStatus = viaChain ? "failed" : t.chainStatus;
    t.error = error ?? "failed";
    t.txHash = txHash;
    emit(s, ctx, "TRADE_FAILED", [t.buyerId, t.sellerId], `Trade ${tradeId} failed (${t.error}); ${cr(t.totalCc)} credits refunded and stock returned.`, { tradeId, error: t.error }, src);
  }
  return t;
}

export function expireQuotes(s: SimState, ctx: Ctx): void {
  for (const q of Object.values(s.quotes)) {
    if (q.status === "open" && s.tick >= q.expiresTick) {
      q.status = "expired";
      emit(s, ctx, "QUOTE_EXPIRED", [q.buyerId, q.sellerId], `Quote ${q.quoteId} expired.`, { quoteId: q.quoteId });
    }
  }
}

/** Morning: restock deliveries arrive, then everyone reprices on the new oil index. */
export function merchantsMorning(s: SimState, ctx: Ctx): void {
  for (const m of Object.values(s.merchants)) {
    if (m.pendingRestockMl > 0 && m.restockArrivesDay !== null && m.restockArrivesDay <= s.day) {
      const qty = m.pendingRestockMl;
      transfer(s, ctx, "fuel_ml", ACC.importer, ACC.merchant(m.merchantId), qty, "restock_delivery", m.merchantId);
      m.pendingRestockMl = 0;
      m.restockArrivesDay = null;
      if (m.status === "closed") {
        m.status = "open";
        emit(s, ctx, "MERCHANT_REOPENED", [ACC.merchant(m.merchantId)], `${m.name} reopened after a ${L(qty)} L delivery.`, { merchantId: m.merchantId });
      }
      emit(s, ctx, "MERCHANT_RESTOCK_DELIVERED", [ACC.merchant(m.merchantId), ACC.importer], `${m.name} received ${L(qty)} L from the importer.`, { merchantId: m.merchantId, quantityMl: qty });
    }
    repriceMerchant(s, ctx, m, `new day: oil index ${(s.world.oilIndexCenti / 100).toFixed(2)}`);
  }
}

/** Settlement: overhead, reorder decisions bounded by cash/upstream capacity, insolvency. */
export function merchantsSettlement(s: SimState, ctx: Ctx): void {
  const mods = worldModifiers(s);
  // town merchants restock from the exchange traders: their scarcity premium is part of the import cost
  const importCost = importCostCcPerL(BASE_REFERENCE_CC_PER_L, s.world.oilIndexCenti, s.world.referenceIndexCenti, mods.logisticsCostBps + (s.world.exchangePremiumBps ?? 0));
  for (const m of Object.values(s.merchants)) {
    const policy = MERCHANT_POLICIES[m.policyId];
    // World Events change the INPUTS of this policy: how much the importer can ship, how long it takes,
    // and how much safety stock this merchant now wants. Each merchant still decides from its own cash/stock.
    const capacity = Math.max(0, Math.floor((m.upstreamCapacityMlPerDay * (10_000 + mods.importCapacityBps)) / 10_000 / 1000) * 1000);
    const target = Math.round((m.targetStockMl * (10_000 + mods.cautionBps)) / 10_000);
    const leadTime = m.leadTimeDays + mods.leadTimeDays;
    m.lastDaySalesMl = m.salesTodayMl;
    m.salesTodayMl = 0;
    if (m.status === "open") transferUpTo(s, ctx, "credits_cc", ACC.merchant(m.merchantId), ACC.landlords, m.overheadCcPerDay, "merchant_overhead", m.merchantId);
    const stock = merchantStock(s, m);
    const cash = merchantCash(s, m);
    const reorderPoint = Math.floor((target * policy.reorderPointBps) / 10_000);
    const falling = oilTrend(s) === "down";
    const defer = falling && policy.deferOnFallingAboveBps !== null && stock > Math.floor((m.targetStockMl * policy.deferOnFallingAboveBps) / 10_000);
    if (stock + m.pendingRestockMl < reorderPoint && !defer) {
      const want = target - stock - m.pendingRestockMl;
      const affordableMl = Math.max(0, Math.floor(((cash - m.operatingReserveCc) * 1000) / importCost / 1000) * 1000);
      const qty = Math.min(want, capacity, affordableMl);
      if (qty >= 1000) {
        const cost = Math.ceil((qty * importCost) / 1000);
        transfer(s, ctx, "credits_cc", ACC.merchant(m.merchantId), ACC.importer, cost, "restock_order", m.merchantId);
        m.pendingRestockMl += qty;
        m.restockArrivesDay = s.day + leadTime;
        emit(s, ctx, "MERCHANT_RESTOCK_ORDERED", [ACC.merchant(m.merchantId), ACC.importer], `${m.name} ordered ${L(qty)} L at import cost ${cr(importCost)}/L (${cr(cost)} credits); arrives day ${m.restockArrivesDay}. Limited by ${qty === want ? "target stock" : qty === capacity ? `upstream capacity (${L(capacity)} L/day${mods.importCapacityBps ? `, ${mods.importCapacityBps > 0 ? "+" : ""}${(mods.importCapacityBps / 100).toFixed(0)}% from world events` : ""})` : "cash after operating reserve"}.`, {
          upstreamCapacityMl: capacity,
          merchantId: m.merchantId,
          quantityMl: qty,
          costCc: cost,
          importCostCcPerL: importCost,
          arrivesDay: m.restockArrivesDay,
        });
      } else if (capacity === 0 && qty === 0) {
        emit(s, ctx, "MERCHANT_RESTOCK_ORDERED", [ACC.merchant(m.merchantId), ACC.importer], `${m.name} could not order fuel today: the importer has no capacity for it.`, { merchantId: m.merchantId, quantityMl: 0, upstreamCapacityMl: 0 });
      } else if (stock === 0 && m.pendingRestockMl === 0 && m.status === "open") {
        m.status = "closed";
        emit(s, ctx, "MERCHANT_CLOSED", [ACC.merchant(m.merchantId)], `${m.name} closed: empty tanks and ${cr(cash)} credits cannot fund a minimum 1 L order at ${cr(importCost)}/L above its ${cr(m.operatingReserveCc)} reserve. It reopens if cheaper oil makes an order affordable.`, { merchantId: m.merchantId, cashCc: cash });
      }
    } else if (defer) {
      emit(s, ctx, "MERCHANT_REPRICED", [ACC.merchant(m.merchantId)], `${m.name} is deferring its restock while oil falls (stock ${L(stock)} L).`, { merchantId: m.merchantId, deferred: true, oldPriceCcPerL: m.quoteCcPerL, newPriceCcPerL: m.quoteCcPerL, cause: "deferred restock", reasons: m.reasons });
    }
  }
}

/** Carbon permit allowance used per mL of diesel (mg). */
export const co2ForFuel = (ml: number) => ml * CO2_MG_PER_ML;
