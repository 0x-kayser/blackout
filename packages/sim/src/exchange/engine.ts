/**
 * Shared Vesper Fuel Exchange engine. Pure and deterministic: the same starting
 * state plus the same sequence of calls always produces the same state, events
 * and effects (no clocks, no randomness).
 *
 * Every change that also lives on NEAR is two-phase: the engine reserves it and
 * returns a ChainEffect; the server submits it and calls the matching settle
 * function with the verified outcome. City-side consequences (credits, fuel
 * delivered home, fees) are returned as CityEffects for the server to apply to
 * that player's save exactly once.
 *
 * Double-entry ledger: `world:*` accounts are the only faucets/sinks and may go
 * negative; every other account is floored at 0; each asset sums to 0.
 */
import { BASE_REFERENCE_CC_PER_L } from "../config.ts";
import { EXCHANGE_TRADERS, decideTrader, type TraderParams } from "../policies/exchangeTraders.ts";
import { importCostCcPerL } from "../policies/merchantPricing.ts";
import { SimError } from "../state.ts";
import type {
  ChainEffect,
  ExchangeAsset,
  ExchangeConfig,
  ExchangeCtx,
  ExchangeEventType,
  ExchangeFill,
  ExchangeOrder,
  ExchangeState,
  OwnerRef,
  TraderState,
} from "./types.ts";

export const XACC = {
  warehouse: (playerId: string) => `warehouse:${playerId}`,
  trader: (traderId: string) => `trader:${traderId}`,
  asks: "escrow:asks",
  fills: "escrow:fills",
  payments: "escrow:payments",
  redeems: "escrow:redeems",
  supplies: "escrow:supplies",
  genesis: "world:genesis",
  cities: "world:cities",
  importer: "world:importer",
  fees: "world:fees",
} as const;

export const DEFAULT_EXCHANGE_CONFIG: ExchangeConfig = {
  ticksPerDay: 48, // one exchange tick every 5 s of wall time = a 4-minute day, like a city
  playerAskLifetimeTicks: 48 * 7,
  priceBandMinBps: 5_000,
  priceBandMaxBps: 30_000,
  storageFeeBps: 100,
  maxDepositPerDayMl: 60_000,
  baseReferenceCcPerL: BASE_REFERENCE_CC_PER_L,
  referenceIndexCenti: 10_000,
};

const LIVE: ExchangeOrder["status"][] = ["placing", "open", "cancelling"];
const TERMINAL: ExchangeOrder["status"][] = ["filled", "cancelled", "rejected"];
const L = (ml: number) => (ml / 1000).toFixed(1);
const cr = (cc: number) => (cc / 100).toFixed(2);
const floor100 = (ml: number) => Math.max(0, Math.floor(ml / 100) * 100);

export const ownerAcct = (o: OwnerRef) => (o.kind === "player" ? XACC.warehouse(o.id) : XACC.trader(o.id));
export const ownerTag = (o: OwnerRef) => `${o.kind}:${o.id}`;
const sameOwner = (a: OwnerRef, b: OwnerRef) => a.kind === b.kind && a.id === b.id;
export const fillCostCc = (ml: number, unitPriceCcPerL: number) => Math.ceil((ml * unitPriceCcPerL) / 1000);
export const availableMl = (o: ExchangeOrder) => o.quantityMl - o.filledMl - o.reservedMl;
export const replacementCcPerL = (s: ExchangeState) => importCostCcPerL(s.config.baseReferenceCcPerL, s.oilIndexCenti, s.config.referenceIndexCenti);
const ownerName = (s: ExchangeState, o: OwnerRef) => (o.kind === "trader" ? (s.traders[o.id]?.params.name ?? o.id) : "a player");

// ------------------------------------------------------------------ ledger + events

export function xbal(s: ExchangeState, asset: ExchangeAsset, acct: string): number {
  return s.balances[asset][acct] ?? 0;
}

function move(s: ExchangeState, ctx: ExchangeCtx, asset: ExchangeAsset, from: string, to: string, amount: number, reason: string, refId: string | null = null): void {
  if (!Number.isInteger(amount) || amount < 0) throw new SimError("INTERNAL", `exchange amount must be a non-negative integer, got ${amount}`);
  if (amount === 0) return;
  if (from === to) throw new SimError("INTERNAL", "self transfer");
  const fb = xbal(s, asset, from);
  if (!from.startsWith("world:") && fb < amount) {
    throw new SimError(asset === "fuel_ml" ? "INSUFFICIENT_FUEL" : "INSUFFICIENT_CREDITS", `${from} has ${fb} ${asset}, needs ${amount}`, { asset, from, have: fb, need: amount });
  }
  const book = s.balances[asset];
  book[from] = fb - amount;
  book[to] = xbal(s, asset, to) + amount;
  s.ledgerSeq += 1;
  ctx.ledger.push({ seq: s.ledgerSeq, tick: s.tick, asset, from, to, amount, reason, refId });
}

function emit(s: ExchangeState, ctx: ExchangeCtx, type: ExchangeEventType, actors: string[], explanation: string, data: Record<string, unknown> = {}): void {
  s.eventSeq += 1;
  ctx.events.push({ seq: s.eventSeq, tick: s.tick, day: s.day, type, actors, explanation, data });
}

function assertMl(ml: number): void {
  if (!Number.isInteger(ml) || ml < 100 || ml % 100 !== 0) throw new SimError("VALIDATION_FAILED", "Fuel moves in whole 100 mL units.");
}

function assertNewId(id: string, taken: boolean): void {
  if (!id || id.length > 120) throw new SimError("VALIDATION_FAILED", "Bad id.");
  if (taken) throw new SimError("ALREADY_PROCESSED", `${id} has already been used.`);
}

// ------------------------------------------------------------------ setup

export function createExchange(opts: { oilIndexCenti?: number; traders?: TraderParams[]; config?: Partial<ExchangeConfig> } = {}): ExchangeState {
  const s: ExchangeState = {
    version: 1,
    tick: 0,
    day: 1,
    oilIndexCenti: opts.oilIndexCenti ?? 10_000,
    config: { ...DEFAULT_EXCHANGE_CONFIG, ...opts.config },
    balances: { fuel_ml: {}, credits_cc: {} },
    orders: {},
    fills: {},
    ops: {},
    traders: {},
    depositsToday: {},
    today: { volumeMl: 0, valueCc: 0, lastPriceCcPerL: null },
    history: [],
    seq: 0,
    ledgerSeq: 0,
    eventSeq: 0,
  };
  for (const p of opts.traders ?? EXCHANGE_TRADERS) {
    s.traders[p.traderId] = {
      traderId: p.traderId,
      params: p,
      status: "normal",
      decision: null,
      askOrderId: null,
      pendingImportId: null,
      soldTodayMl: 0,
      boughtTodayMl: 0,
      soldYesterdayMl: 0,
      boughtYesterdayMl: 0,
      importedTodayMl: 0,
    };
    const acct = XACC.trader(p.traderId);
    s.balances.fuel_ml[acct] = p.startStockMl;
    s.balances.fuel_ml[XACC.genesis] = (s.balances.fuel_ml[XACC.genesis] ?? 0) - p.startStockMl;
    s.balances.credits_cc[acct] = p.startCashCc;
    s.balances.credits_cc[XACC.genesis] = (s.balances.credits_cc[XACC.genesis] ?? 0) - p.startCashCc;
  }
  return s;
}

/** Adds traders that joined the game after this exchange was created, with their starting wallets. Returns how many. */
export function ensureTraders(s: ExchangeState, traders: TraderParams[] = EXCHANGE_TRADERS): number {
  let added = 0;
  for (const p of traders) {
    if (s.traders[p.traderId]) continue;
    s.traders[p.traderId] = { traderId: p.traderId, params: p, status: "normal", decision: null, askOrderId: null, pendingImportId: null, soldTodayMl: 0, boughtTodayMl: 0, soldYesterdayMl: 0, boughtYesterdayMl: 0, importedTodayMl: 0 };
    const acct = XACC.trader(p.traderId);
    s.balances.fuel_ml[acct] = (s.balances.fuel_ml[acct] ?? 0) + p.startStockMl;
    s.balances.fuel_ml[XACC.genesis] = (s.balances.fuel_ml[XACC.genesis] ?? 0) - p.startStockMl;
    s.balances.credits_cc[acct] = (s.balances.credits_cc[acct] ?? 0) + p.startCashCc;
    s.balances.credits_cc[XACC.genesis] = (s.balances.credits_cc[XACC.genesis] ?? 0) - p.startCashCc;
    added += 1;
  }
  // existing traders pick up persona fields added later
  for (const p of traders) if (s.traders[p.traderId]) s.traders[p.traderId].params = p;
  return added;
}

export function setOilIndex(s: ExchangeState, ctx: ExchangeCtx, oilIndexCenti: number): void {
  if (!Number.isInteger(oilIndexCenti) || oilIndexCenti <= 0) throw new SimError("VALIDATION_FAILED", "Oil index must be a positive integer.");
  if (oilIndexCenti === s.oilIndexCenti) return;
  const prev = s.oilIndexCenti;
  s.oilIndexCenti = oilIndexCenti;
  emit(s, ctx, "OIL_UPDATED", [], `Oil index ${(prev / 100).toFixed(2)} → ${(oilIndexCenti / 100).toFixed(2)}; exchange import cost is now ${cr(replacementCcPerL(s))}/L.`, { prev, oilIndexCenti });
}

// ------------------------------------------------------------------ city tank <-> warehouse

/** The server has already taken `quantityMl` out of the player's city tank. */
export function requestDeposit(s: ExchangeState, ctx: ExchangeCtx, input: { playerId: string; quantityMl: number; depositId: string }): void {
  assertMl(input.quantityMl);
  assertNewId(input.depositId, !!s.ops[input.depositId]);
  const today = s.depositsToday[input.playerId] ?? 0;
  if (today + input.quantityMl > s.config.maxDepositPerDayMl) {
    throw new SimError("VALIDATION_FAILED", `You can move up to ${L(s.config.maxDepositPerDayMl)} L to the exchange per day; ${L(Math.max(0, s.config.maxDepositPerDayMl - today))} L left today.`);
  }
  s.depositsToday[input.playerId] = today + input.quantityMl;
  const owner: OwnerRef = { kind: "player", id: input.playerId };
  s.ops[input.depositId] = { opId: input.depositId, kind: "deposit", owner, quantityMl: input.quantityMl, costCc: 0, status: "pending", createdTick: s.tick, arrivesTick: null, txHash: null, error: null };
  ctx.effects.push({ kind: "chain", op: "deposit", opId: input.depositId, playerId: input.playerId, amountMl: input.quantityMl });
  emit(s, ctx, "DEPOSIT_REQUESTED", [ownerTag(owner)], `${L(input.quantityMl)} L is on its way from your tank to your exchange warehouse.`, { depositId: input.depositId, quantityMl: input.quantityMl });
}

export function settleDeposit(s: ExchangeState, ctx: ExchangeCtx, depositId: string, outcome: "confirmed" | "failed", txHash: string | null = null, error: string | null = null): void {
  const op = pendingOp(s, depositId, "deposit");
  const playerId = op.owner.id;
  op.txHash = txHash;
  if (outcome === "confirmed") {
    move(s, ctx, "fuel_ml", XACC.cities, XACC.warehouse(playerId), op.quantityMl, "deposit", depositId);
    op.status = "settled";
    emit(s, ctx, "DEPOSITED", [ownerTag(op.owner)], `${L(op.quantityMl)} L arrived in your exchange warehouse.`, { depositId, quantityMl: op.quantityMl, txHash });
  } else {
    op.status = "failed";
    op.error = error ?? "The deposit could not be confirmed.";
    s.depositsToday[playerId] = Math.max(0, (s.depositsToday[playerId] ?? 0) - op.quantityMl);
    ctx.effects.push({ kind: "city", op: "refund_fuel", effectId: `refund:${depositId}`, playerId, amountMl: op.quantityMl, depositId });
    emit(s, ctx, "DEPOSIT_FAILED", [ownerTag(op.owner)], `The move to your warehouse failed; ${L(op.quantityMl)} L goes back to your tank.`, { depositId, error: op.error });
  }
}

/** Starts bringing warehouse fuel home. The city receives it only after the burn confirms. */
export function requestRedeem(s: ExchangeState, ctx: ExchangeCtx, input: { playerId: string; quantityMl: number; redeemId: string }): void {
  assertMl(input.quantityMl);
  assertNewId(input.redeemId, !!s.ops[input.redeemId]);
  const owner: OwnerRef = { kind: "player", id: input.playerId };
  move(s, ctx, "fuel_ml", XACC.warehouse(input.playerId), XACC.redeems, input.quantityMl, "redeem_reserve", input.redeemId);
  s.ops[input.redeemId] = { opId: input.redeemId, kind: "redeem", owner, quantityMl: input.quantityMl, costCc: 0, status: "pending", createdTick: s.tick, arrivesTick: null, txHash: null, error: null };
  ctx.effects.push({ kind: "chain", op: "redeem", opId: input.redeemId, playerId: input.playerId, amountMl: input.quantityMl });
  emit(s, ctx, "REDEEM_REQUESTED", [ownerTag(owner)], `${L(input.quantityMl)} L is being delivered from your warehouse to your tank.`, { redeemId: input.redeemId, quantityMl: input.quantityMl });
}

export function settleRedeem(s: ExchangeState, ctx: ExchangeCtx, redeemId: string, outcome: "confirmed" | "failed", txHash: string | null = null, error: string | null = null): void {
  const op = pendingOp(s, redeemId, "redeem");
  const playerId = op.owner.id;
  op.txHash = txHash;
  if (outcome === "confirmed") {
    move(s, ctx, "fuel_ml", XACC.redeems, XACC.cities, op.quantityMl, "redeem", redeemId);
    op.status = "settled";
    ctx.effects.push({ kind: "city", op: "deliver_fuel", effectId: `deliver:${redeemId}`, playerId, amountMl: op.quantityMl, redeemId });
    emit(s, ctx, "REDEEMED", [ownerTag(op.owner)], `${L(op.quantityMl)} L delivered to your tank.`, { redeemId, quantityMl: op.quantityMl, txHash });
  } else {
    move(s, ctx, "fuel_ml", XACC.redeems, XACC.warehouse(playerId), op.quantityMl, "redeem_failed", redeemId);
    op.status = "failed";
    op.error = error ?? "The delivery could not be confirmed.";
    emit(s, ctx, "REDEEM_FAILED", [ownerTag(op.owner)], `Delivery failed; ${L(op.quantityMl)} L stays in your warehouse.`, { redeemId, error: op.error });
  }
}

function pendingOp(s: ExchangeState, opId: string, kind: "deposit" | "redeem" | "import" | "supply") {
  const op = s.ops[opId];
  if (!op || op.kind !== kind) throw new SimError("NOT_FOUND", `Unknown ${kind} ${opId}.`);
  if (op.status !== "pending") throw new SimError("ALREADY_PROCESSED", `${kind} ${opId} is ${op.status}.`);
  return op;
}

// ------------------------------------------------------------------ asks

export function placeAsk(s: ExchangeState, ctx: ExchangeCtx, input: { owner: OwnerRef; quantityMl: number; unitPriceCcPerL: number; orderId: string }): ExchangeOrder {
  assertMl(input.quantityMl);
  assertNewId(input.orderId, !!s.orders[input.orderId]);
  if (!Number.isInteger(input.unitPriceCcPerL) || input.unitPriceCcPerL < 1) throw new SimError("VALIDATION_FAILED", "Price must be a positive whole number of cc per litre.");
  if (input.owner.kind === "trader" && !s.traders[input.owner.id]) throw new SimError("NOT_FOUND", `Unknown trader ${input.owner.id}.`);
  if (input.owner.kind === "player") {
    const rc = replacementCcPerL(s);
    const lo = Math.ceil((rc * s.config.priceBandMinBps) / 10_000);
    const hi = Math.floor((rc * s.config.priceBandMaxBps) / 10_000);
    if (input.unitPriceCcPerL < lo || input.unitPriceCcPerL > hi) {
      throw new SimError("VALIDATION_FAILED", `Asks must be between ${cr(lo)} and ${cr(hi)} credits per litre today (import cost ${cr(rc)}/L).`, { min: lo, max: hi });
    }
  }
  move(s, ctx, "fuel_ml", ownerAcct(input.owner), XACC.asks, input.quantityMl, "ask_escrow", input.orderId);
  s.seq += 1;
  const order: ExchangeOrder = {
    orderId: input.orderId,
    owner: input.owner,
    quantityMl: input.quantityMl,
    filledMl: 0,
    reservedMl: 0,
    unitPriceCcPerL: input.unitPriceCcPerL,
    status: "placing",
    createdTick: s.tick,
    expiresTick: input.owner.kind === "player" ? s.tick + s.config.playerAskLifetimeTicks : null,
    cancelReason: null,
    seq: s.seq,
    error: null,
  };
  s.orders[order.orderId] = order;
  ctx.effects.push({ kind: "chain", op: "ask", opId: order.orderId, owner: order.owner, amountMl: order.quantityMl, unitPriceCcPerL: order.unitPriceCcPerL });
  emit(s, ctx, "ASK_PLACED", [ownerTag(order.owner), `order:${order.orderId}`], `${ownerName(s, order.owner)} offers ${L(order.quantityMl)} L at ${cr(order.unitPriceCcPerL)}/L.`, { orderId: order.orderId, quantityMl: order.quantityMl, unitPriceCcPerL: order.unitPriceCcPerL });
  return order;
}

export function settleAsk(s: ExchangeState, ctx: ExchangeCtx, orderId: string, outcome: "confirmed" | "failed", txHash: string | null = null, error: string | null = null): void {
  const o = orderById(s, orderId);
  if (o.status !== "placing") throw new SimError("ALREADY_PROCESSED", `Order ${orderId} is ${o.status}.`);
  if (outcome === "confirmed") {
    o.status = "open";
    emit(s, ctx, "ASK_OPENED", [ownerTag(o.owner), `order:${orderId}`], `${L(o.quantityMl)} L at ${cr(o.unitPriceCcPerL)}/L is now on the exchange.`, { orderId, txHash });
  } else {
    move(s, ctx, "fuel_ml", XACC.asks, ownerAcct(o.owner), o.quantityMl, "ask_rejected", orderId);
    o.status = "rejected";
    o.error = error ?? "The ask could not be confirmed.";
    emit(s, ctx, "ASK_REJECTED", [ownerTag(o.owner), `order:${orderId}`], `The ask could not be placed; ${L(o.quantityMl)} L returned.`, { orderId, error: o.error });
  }
}

export function requestCancel(s: ExchangeState, ctx: ExchangeCtx, orderId: string, reason: "owner" | "expired" | "reprice", by: OwnerRef | null = null): void {
  const o = orderById(s, orderId);
  if (by && !sameOwner(by, o.owner)) throw new SimError("FORBIDDEN", "This order belongs to someone else.");
  if (o.status !== "open") throw new SimError("ALREADY_PROCESSED", `Order ${orderId} is ${o.status} and cannot be cancelled now.`);
  if (o.reservedMl > 0) throw new SimError("INVALID_STATE", "A purchase from this order is settling; try again in a moment.");
  o.status = "cancelling";
  o.cancelReason = reason;
  ctx.effects.push({ kind: "chain", op: "cancel", opId: orderId, owner: o.owner });
  emit(s, ctx, "CANCEL_REQUESTED", [ownerTag(o.owner), `order:${orderId}`], reason === "expired" ? `Ask expired; ${L(availableMl(o))} L is being returned.` : `Cancelling ${L(availableMl(o))} L at ${cr(o.unitPriceCcPerL)}/L.`, { orderId, reason });
}

export function settleCancel(s: ExchangeState, ctx: ExchangeCtx, orderId: string, outcome: "confirmed" | "failed", txHash: string | null = null, error: string | null = null): void {
  const o = orderById(s, orderId);
  if (o.status !== "cancelling") throw new SimError("ALREADY_PROCESSED", `Order ${orderId} is ${o.status}.`);
  if (outcome === "confirmed") {
    const left = availableMl(o);
    move(s, ctx, "fuel_ml", XACC.asks, ownerAcct(o.owner), left, "ask_cancelled", orderId);
    o.status = "cancelled";
    emit(s, ctx, "ORDER_CANCELLED", [ownerTag(o.owner), `order:${orderId}`], `${L(left)} L returned to ${o.owner.kind === "player" ? "your warehouse" : ownerName(s, o.owner)}.`, { orderId, returnedMl: left, reason: o.cancelReason, txHash });
  } else {
    o.status = "open";
    o.error = error ?? "Cancellation failed; the ask stays open.";
    emit(s, ctx, "CANCEL_FAILED", [ownerTag(o.owner), `order:${orderId}`], "Cancellation could not be confirmed; the ask stays open.", { orderId, error: o.error });
  }
}

function orderById(s: ExchangeState, orderId: string): ExchangeOrder {
  const o = s.orders[orderId];
  if (!o) throw new SimError("NOT_FOUND", `Unknown order ${orderId}.`);
  return o;
}

// ------------------------------------------------------------------ fills

/**
 * Reserves part of an open ask for a buyer. A trader buyer's credits are moved into
 * escrow here; a player buyer's credits must already be reserved in their city.
 */
export function reserveFill(s: ExchangeState, ctx: ExchangeCtx, input: { orderId: string; buyer: OwnerRef; quantityMl: number; fillId: string }): ExchangeFill {
  assertMl(input.quantityMl);
  assertNewId(input.fillId, !!s.fills[input.fillId]);
  const o = orderById(s, input.orderId);
  if (o.status !== "open") throw new SimError("ALREADY_PROCESSED", `Order ${o.orderId} is ${o.status}.`);
  if (sameOwner(o.owner, input.buyer)) throw new SimError("VALIDATION_FAILED", "You cannot buy your own order.");
  if (o.owner.kind === "trader" && input.buyer.kind === "trader") throw new SimError("VALIDATION_FAILED", "Traders do not trade with each other.");
  if (input.quantityMl > availableMl(o)) throw new SimError("OUT_OF_STOCK", `Only ${L(availableMl(o))} L is left on this order.`);
  const totalCc = fillCostCc(input.quantityMl, o.unitPriceCcPerL);
  if (input.buyer.kind === "trader") move(s, ctx, "credits_cc", XACC.trader(input.buyer.id), XACC.payments, totalCc, "fill_payment_reserve", input.fillId);
  move(s, ctx, "fuel_ml", XACC.asks, XACC.fills, input.quantityMl, "fill_reserve", input.fillId);
  o.reservedMl += input.quantityMl;
  const fill: ExchangeFill = {
    fillId: input.fillId,
    orderId: o.orderId,
    seller: o.owner,
    buyer: input.buyer,
    quantityMl: input.quantityMl,
    unitPriceCcPerL: o.unitPriceCcPerL,
    totalCc,
    status: "pending",
    reservedTick: s.tick,
    settledTick: null,
    txHash: null,
    error: null,
  };
  s.fills[fill.fillId] = fill;
  ctx.effects.push({ kind: "chain", op: "fill", opId: fill.fillId, orderId: o.orderId, buyer: input.buyer, amountMl: input.quantityMl });
  emit(s, ctx, "FILL_RESERVED", [ownerTag(input.buyer), ownerTag(o.owner), `order:${o.orderId}`, `fill:${fill.fillId}`], `${ownerName(s, input.buyer)} is buying ${L(input.quantityMl)} L from ${ownerName(s, o.owner)} at ${cr(o.unitPriceCcPerL)}/L (${cr(totalCc)} credits).`, {
    fillId: fill.fillId, orderId: o.orderId, quantityMl: input.quantityMl, unitPriceCcPerL: o.unitPriceCcPerL, totalCc,
  });
  return fill;
}

export function settleFill(s: ExchangeState, ctx: ExchangeCtx, fillId: string, outcome: "confirmed" | "failed", txHash: string | null = null, error: string | null = null): void {
  const f = s.fills[fillId];
  if (!f) throw new SimError("NOT_FOUND", `Unknown fill ${fillId}.`);
  if (f.status !== "pending") throw new SimError("ALREADY_PROCESSED", `Fill ${fillId} is ${f.status}.`);
  const o = orderById(s, f.orderId);
  f.txHash = txHash;
  f.settledTick = s.tick;
  o.reservedMl -= f.quantityMl;
  const actors = [ownerTag(f.buyer), ownerTag(f.seller), `order:${o.orderId}`, `fill:${fillId}`];
  if (outcome === "confirmed") {
    move(s, ctx, "fuel_ml", XACC.fills, ownerAcct(f.buyer), f.quantityMl, "fill", fillId);
    o.filledMl += f.quantityMl;
    if (o.filledMl === o.quantityMl && o.status === "open") o.status = "filled";
    // payment: credits never touch the chain
    if (f.buyer.kind === "trader") {
      move(s, ctx, "credits_cc", XACC.payments, XACC.cities, f.totalCc, "fill_payment", fillId);
      ctx.effects.push({ kind: "city", op: "credit", effectId: `credit:${fillId}`, playerId: f.seller.id, amountCc: f.totalCc, fillId });
    } else {
      ctx.effects.push({ kind: "city", op: "capture_payment", effectId: `capture:${fillId}`, playerId: f.buyer.id, amountCc: f.totalCc, fillId });
      if (f.seller.kind === "trader") move(s, ctx, "credits_cc", XACC.cities, XACC.trader(f.seller.id), f.totalCc, "fill_payment", fillId);
      else ctx.effects.push({ kind: "city", op: "credit", effectId: `credit:${fillId}`, playerId: f.seller.id, amountCc: f.totalCc, fillId });
    }
    if (f.seller.kind === "trader") s.traders[f.seller.id].soldTodayMl += f.quantityMl;
    if (f.buyer.kind === "trader") s.traders[f.buyer.id].boughtTodayMl += f.quantityMl;
    s.today.volumeMl += f.quantityMl;
    s.today.valueCc += f.totalCc;
    s.today.lastPriceCcPerL = f.unitPriceCcPerL;
    f.status = "settled";
    emit(s, ctx, "FILL_SETTLED", actors, `${ownerName(s, f.buyer)} bought ${L(f.quantityMl)} L from ${ownerName(s, f.seller)} for ${cr(f.totalCc)} credits.`, {
      fillId, orderId: o.orderId, quantityMl: f.quantityMl, unitPriceCcPerL: f.unitPriceCcPerL, totalCc: f.totalCc, txHash,
    });
  } else {
    move(s, ctx, "fuel_ml", XACC.fills, XACC.asks, f.quantityMl, "fill_failed", fillId);
    if (f.buyer.kind === "trader") move(s, ctx, "credits_cc", XACC.payments, XACC.trader(f.buyer.id), f.totalCc, "fill_payment_refund", fillId);
    else ctx.effects.push({ kind: "city", op: "release_payment", effectId: `release:${fillId}`, playerId: f.buyer.id, amountCc: f.totalCc, fillId });
    f.status = "failed";
    f.error = error ?? "The transfer could not be confirmed.";
    emit(s, ctx, "FILL_FAILED", actors, `The purchase of ${L(f.quantityMl)} L failed; the fuel is back on the order and the payment was released.`, { fillId, error: f.error });
  }
}

export interface BuyQuote {
  legs: { orderId: string; quantityMl: number; unitPriceCcPerL: number; totalCc: number }[];
  quantityMl: number;
  totalCc: number;
  averageCcPerL: number | null;
}

/** Walks open asks from the cheapest (oldest first at a price), skipping the buyer's own. */
export function quoteBuy(s: ExchangeState, playerId: string, quantityMl: number, maxPriceCcPerL: number | null = null): BuyQuote {
  assertMl(quantityMl);
  const me: OwnerRef = { kind: "player", id: playerId };
  const asks = Object.values(s.orders)
    .filter((o) => o.status === "open" && !sameOwner(o.owner, me) && availableMl(o) >= 100 && (maxPriceCcPerL === null || o.unitPriceCcPerL <= maxPriceCcPerL))
    .sort((a, b) => a.unitPriceCcPerL - b.unitPriceCcPerL || a.seq - b.seq);
  const legs: BuyQuote["legs"] = [];
  let left = quantityMl;
  for (const o of asks) {
    if (left <= 0) break;
    const take = Math.min(left, availableMl(o));
    legs.push({ orderId: o.orderId, quantityMl: take, unitPriceCcPerL: o.unitPriceCcPerL, totalCc: fillCostCc(take, o.unitPriceCcPerL) });
    left -= take;
  }
  const got = quantityMl - left;
  const totalCc = legs.reduce((a, l) => a + l.totalCc, 0);
  return { legs, quantityMl: got, totalCc, averageCcPerL: got ? Math.round((totalCc * 1000) / got) : null };
}

/** Reserves a full purchase. The caller must first reserve `quote.totalCc` in the buyer's city. */
export function reserveBuy(s: ExchangeState, ctx: ExchangeCtx, input: { playerId: string; quantityMl: number; maxPriceCcPerL: number | null; buyId: string }): { fills: ExchangeFill[]; totalCc: number } {
  const q = quoteBuy(s, input.playerId, input.quantityMl, input.maxPriceCcPerL);
  if (q.quantityMl < input.quantityMl) throw new SimError("OUT_OF_STOCK", `Only ${L(q.quantityMl)} L is on offer${input.maxPriceCcPerL ? ` at or below ${cr(input.maxPriceCcPerL)}/L` : ""}.`, { availableMl: q.quantityMl });
  const buyer: OwnerRef = { kind: "player", id: input.playerId };
  const fills = q.legs.map((leg, i) => reserveFill(s, ctx, { orderId: leg.orderId, buyer, quantityMl: leg.quantityMl, fillId: `${input.buyId}:${i}` }));
  return { fills, totalCc: q.totalCc };
}

// ------------------------------------------------------------------ traders

function traderAsk(s: ExchangeState, t: TraderState): ExchangeOrder | undefined {
  return t.askOrderId ? s.orders[t.askOrderId] : undefined;
}

function runTrader(s: ExchangeState, ctx: ExchangeCtx, t: TraderState): void {
  const p = t.params;
  const acct = XACC.trader(p.traderId);
  const tag = `trader:${p.traderId}`;
  const ask = traderAsk(s, t);
  const askLeft = ask && LIVE.includes(ask.status) ? availableMl(ask) : 0;
  const imp = t.pendingImportId ? s.ops[t.pendingImportId] : undefined;
  const importActive = !!imp && (imp.status === "ordered" || imp.status === "pending");
  const rc = replacementCcPerL(s);
  const d = decideTrader(p, {
    stockMl: xbal(s, "fuel_ml", acct) + askLeft,
    onOrderMl: importActive ? imp!.quantityMl : 0,
    cashCc: xbal(s, "credits_cc", acct),
    replacementCcPerL: rc,
    soldYesterdayMl: t.soldYesterdayMl,
    boughtYesterdayMl: t.boughtYesterdayMl,
    importedTodayMl: t.importedTodayMl,
  });
  t.decision = d;
  if (d.status !== t.status) {
    const what = { normal: "is trading normally again", short: "is down to its reserve and has stopped selling", cash_strapped: "is out of spendable cash: no restocking, no buying", overstocked: "is overstocked and keen to sell" }[d.status];
    emit(s, ctx, "TRADER_STATUS", [tag], `${p.name} ${what}.`, { traderId: p.traderId, from: t.status, to: d.status, reasons: d.reasons });
    t.status = d.status;
  }

  // restock
  if (d.importMl >= 100 && !importActive) {
    const cost = fillCostCc(d.importMl, rc);
    if (cost <= xbal(s, "credits_cc", acct)) {
      s.seq += 1;
      const importId = `${p.traderId}:import:${s.seq}`;
      move(s, ctx, "credits_cc", acct, XACC.importer, cost, "trader_import_order", importId);
      s.ops[importId] = { opId: importId, kind: "import", owner: { kind: "trader", id: p.traderId }, quantityMl: d.importMl, costCc: cost, status: "ordered", createdTick: s.tick, arrivesTick: s.tick + p.leadTimeTicks, txHash: null, error: null };
      t.pendingImportId = importId;
      t.importedTodayMl += d.importMl;
      emit(s, ctx, "TRADER_IMPORT_ORDERED", [tag], `${p.name} ordered ${L(d.importMl)} L at ${cr(rc)}/L (${cr(cost)} credits); it arrives in ${p.leadTimeTicks} ticks.`, { traderId: p.traderId, importId, quantityMl: d.importMl, costCc: cost, arrivesTick: s.tick + p.leadTimeTicks });
    }
  }

  // keep one ask on the book at the policy price
  if (ask && ask.status === "open") {
    const drift = d.askCcPerL === null || Math.abs(ask.unitPriceCcPerL - d.askCcPerL) * 10_000 >= p.repriceThresholdBps * ask.unitPriceCcPerL;
    if (drift && ask.reservedMl === 0) requestCancel(s, ctx, ask.orderId, "reprice");
  } else if (!ask || TERMINAL.includes(ask.status)) {
    const qty = Math.min(d.askQtyMl, floor100(xbal(s, "fuel_ml", acct)));
    if (d.askCcPerL !== null && qty >= 100) {
      s.seq += 1;
      const orderId = `${p.traderId}:ask:${s.seq}`;
      placeAsk(s, ctx, { owner: { kind: "trader", id: p.traderId }, quantityMl: qty, unitPriceCcPerL: d.askCcPerL, orderId });
      t.askOrderId = orderId;
    }
  }

  // discover player asks at or below its bid
  if (d.bidCcPerL !== null) {
    let room = d.roomMl;
    let budget = Math.max(0, xbal(s, "credits_cc", acct) - p.operatingReserveCc);
    const asks = Object.values(s.orders)
      .filter((o) => o.status === "open" && o.owner.kind === "player" && o.unitPriceCcPerL <= d.bidCcPerL! && availableMl(o) >= 100)
      .sort((a, b) => a.unitPriceCcPerL - b.unitPriceCcPerL || a.seq - b.seq);
    for (const o of asks) {
      if (room < 100) break;
      const qty = Math.min(availableMl(o), room, floor100(Math.floor((budget * 1000) / o.unitPriceCcPerL)));
      if (qty < 100) continue;
      s.seq += 1;
      reserveFill(s, ctx, { orderId: o.orderId, buyer: { kind: "trader", id: p.traderId }, quantityMl: qty, fillId: `${p.traderId}:fill:${s.seq}` });
      budget -= fillCostCc(qty, o.unitPriceCcPerL);
      room -= qty;
    }
  }
}

export function settleImport(s: ExchangeState, ctx: ExchangeCtx, importId: string, outcome: "confirmed" | "failed", txHash: string | null = null, error: string | null = null): void {
  const op = pendingOp(s, importId, "import");
  const t = s.traders[op.owner.id];
  op.txHash = txHash;
  t.pendingImportId = null;
  if (outcome === "confirmed") {
    move(s, ctx, "fuel_ml", XACC.importer, XACC.trader(t.traderId), op.quantityMl, "trader_import", importId);
    op.status = "settled";
    emit(s, ctx, "TRADER_IMPORT_ARRIVED", [`trader:${t.traderId}`], `${t.params.name} received ${L(op.quantityMl)} L of imported diesel.`, { traderId: t.traderId, importId, quantityMl: op.quantityMl, txHash });
  } else {
    move(s, ctx, "credits_cc", XACC.importer, XACC.trader(t.traderId), op.costCc, "trader_import_refund", importId);
    op.status = "failed";
    op.error = error ?? "The import could not be confirmed.";
    emit(s, ctx, "TRADER_IMPORT_FAILED", [`trader:${t.traderId}`], `${t.params.name}'s import fell through; its ${cr(op.costCc)} credits were refunded.`, { traderId: t.traderId, importId, error: op.error });
  }
}

// ------------------------------------------------------------------ supplying players' cities

/**
 * A city's fuel merchants restock from the exchange traders (NPC wallets), cheapest first. The trader is paid in
 * credits at its own ask, its stock falls, and its next prices reflect the drain, so a busy city anywhere raises
 * fuel prices for everyone. Fuel that cannot be covered by traders above their reserve is simply not supplied.
 */
export function supplyCities(s: ExchangeState, ctx: ExchangeCtx, input: { quantityMl: number; refId: string }): { suppliedMl: number; costCc: number } {
  const want = floor100(input.quantityMl);
  if (want < 100) return { suppliedMl: 0, costCc: 0 };
  let left = want;
  let total = 0;
  const rc = replacementCcPerL(s);
  const traders = Object.values(s.traders)
    .map((t) => ({ t, price: t.decision?.askCcPerL ?? Math.round(rc * 1.08), spare: floor100(xbal(s, "fuel_ml", XACC.trader(t.traderId)) - t.params.reserveFloorMl) }))
    .filter((x) => x.spare >= 100)
    .sort((a, b) => a.price - b.price || a.t.traderId.localeCompare(b.t.traderId));
  for (const { t, price, spare } of traders) {
    if (left < 100) break;
    const qty = Math.min(left, spare);
    s.seq += 1;
    const opId = `${t.traderId}:supply:${s.seq}`;
    if (s.ops[opId]) continue;
    const cost = fillCostCc(qty, price);
    move(s, ctx, "fuel_ml", XACC.trader(t.traderId), XACC.supplies, qty, "city_supply_reserve", opId);
    s.ops[opId] = { opId, kind: "supply", owner: { kind: "trader", id: t.traderId }, quantityMl: qty, costCc: cost, status: "pending", createdTick: s.tick, arrivesTick: null, txHash: null, error: null };
    ctx.effects.push({ kind: "chain", op: "supply", opId, traderId: t.traderId, amountMl: qty });
    left -= qty;
    total += cost;
  }
  return { suppliedMl: want - left, costCc: total };
}

export function settleSupply(s: ExchangeState, ctx: ExchangeCtx, opId: string, outcome: "confirmed" | "failed", txHash: string | null = null, error: string | null = null): void {
  const op = pendingOp(s, opId, "supply");
  const t = s.traders[op.owner.id];
  op.txHash = txHash;
  if (outcome === "confirmed") {
    move(s, ctx, "fuel_ml", XACC.supplies, XACC.cities, op.quantityMl, "city_supply", opId);
    move(s, ctx, "credits_cc", XACC.cities, XACC.trader(t.traderId), op.costCc, "city_supply_payment", opId);
    t.soldTodayMl += op.quantityMl;
    op.status = "settled";
    emit(s, ctx, "CITY_SUPPLIED", [`trader:${t.traderId}`], `${t.params.name} supplied ${L(op.quantityMl)} L to town fuel merchants for ${cr(op.costCc)} credits.`, { traderId: t.traderId, quantityMl: op.quantityMl, costCc: op.costCc, txHash });
  } else {
    move(s, ctx, "fuel_ml", XACC.supplies, XACC.trader(t.traderId), op.quantityMl, "city_supply_failed", opId);
    op.status = "failed";
    op.error = error ?? "The delivery could not be confirmed.";
    emit(s, ctx, "CITY_SUPPLY_FAILED", [`trader:${t.traderId}`], `${t.params.name}'s delivery to the towns fell through; the fuel stays in its yard.`, { traderId: t.traderId, error: op.error });
  }
}

/**
 * What the exchange tells each city's merchants about fuel from outside: how far traders' cheapest ask sits above
 * normal import cost. Traders running short (no ask at all) means a full +50% squeeze.
 */
export function cityPricePremiumBps(s: ExchangeState): number {
  const rc = replacementCcPerL(s);
  const decided = Object.values(s.traders).filter((t) => t.decision);
  // before the traders have priced anything there is no signal yet: neutral, not a squeeze
  if (!decided.length) return 0;
  const asks = decided.map((t) => t.decision!.askCcPerL).filter((x): x is number => typeof x === "number");
  if (!asks.length) return 5_000;
  const best = Math.min(...asks);
  const raw = Math.round(((best - Math.round(rc * 1.05)) * 10_000) / rc);
  return Math.max(-2_000, Math.min(5_000, raw));
}

// ------------------------------------------------------------------ clock

/** Advances one exchange tick: deliveries, expiries, every trader's decision, then the daily close. */
export function exchangeTick(s: ExchangeState, ctx: ExchangeCtx): void {
  s.tick += 1;
  for (const op of Object.values(s.ops).sort((a, b) => a.opId.localeCompare(b.opId))) {
    if (op.kind === "import" && op.status === "ordered" && op.arrivesTick !== null && op.arrivesTick <= s.tick) {
      op.status = "pending";
      ctx.effects.push({ kind: "chain", op: "import", opId: op.opId, traderId: op.owner.id, amountMl: op.quantityMl });
    }
  }
  for (const o of Object.values(s.orders).sort((a, b) => a.seq - b.seq)) {
    if (o.status === "open" && o.owner.kind === "player" && o.expiresTick !== null && o.expiresTick <= s.tick && o.reservedMl === 0) requestCancel(s, ctx, o.orderId, "expired");
  }
  for (const t of Object.values(s.traders).sort((a, b) => a.traderId.localeCompare(b.traderId))) runTrader(s, ctx, t);
  if (s.tick % s.config.ticksPerDay === 0) closeDay(s, ctx);
}

function closeDay(s: ExchangeState, ctx: ExchangeCtx): void {
  const rc = replacementCcPerL(s);
  const book = exchangeBook(s);
  s.history.push({ day: s.day, oilIndexCenti: s.oilIndexCenti, volumeMl: s.today.volumeMl, valueCc: s.today.valueCc, lastPriceCcPerL: s.today.lastPriceCcPerL, bestAskCcPerL: book.bestAskCcPerL, bestBidCcPerL: book.bestBidCcPerL });
  if (s.history.length > 60) s.history.splice(0, s.history.length - 60);
  for (const [acct, ml] of Object.entries(s.balances.fuel_ml).sort(([a], [b]) => a.localeCompare(b))) {
    if (!acct.startsWith("warehouse:") || ml <= 0) continue;
    const fee = Math.ceil((fillCostCc(ml, rc) * s.config.storageFeeBps) / 10_000);
    if (fee <= 0) continue;
    const playerId = acct.slice("warehouse:".length);
    move(s, ctx, "credits_cc", XACC.cities, XACC.fees, fee, "storage_fee", `${playerId}:${s.day}`);
    ctx.effects.push({ kind: "city", op: "charge_fee", effectId: `fee:${playerId}:${s.day}`, playerId, amountCc: fee, day: s.day });
    emit(s, ctx, "STORAGE_FEE", [`player:${playerId}`], `Warehouse storage for ${L(ml)} L: ${cr(fee)} credits.`, { playerId, storedMl: ml, feeCc: fee });
  }
  for (const t of Object.values(s.traders)) {
    t.soldYesterdayMl = t.soldTodayMl;
    t.boughtYesterdayMl = t.boughtTodayMl;
    t.soldTodayMl = 0;
    t.boughtTodayMl = 0;
    t.importedTodayMl = 0;
  }
  emit(s, ctx, "DAY_CLOSED", [], `Exchange day ${s.day} closed: ${L(s.today.volumeMl)} L traded for ${cr(s.today.valueCc)} credits.`, { day: s.day, volumeMl: s.today.volumeMl, valueCc: s.today.valueCc });
  s.depositsToday = {};
  s.today = { volumeMl: 0, valueCc: 0, lastPriceCcPerL: null };
  s.day += 1;
}

// ------------------------------------------------------------------ settlement helpers

export function settleChainOp(s: ExchangeState, ctx: ExchangeCtx, e: Pick<ChainEffect, "op" | "opId">, outcome: "confirmed" | "failed", txHash: string | null = null, error: string | null = null): void {
  switch (e.op) {
    case "deposit": return settleDeposit(s, ctx, e.opId, outcome, txHash, error);
    case "redeem": return settleRedeem(s, ctx, e.opId, outcome, txHash, error);
    case "ask": return settleAsk(s, ctx, e.opId, outcome, txHash, error);
    case "cancel": return settleCancel(s, ctx, e.opId, outcome, txHash, error);
    case "fill": return settleFill(s, ctx, e.opId, outcome, txHash, error);
    case "import": return settleImport(s, ctx, e.opId, outcome, txHash, error);
    case "supply": return settleSupply(s, ctx, e.opId, outcome, txHash, error);
  }
}

/** Every chain operation still awaiting an outcome, in a stable order. */
export function pendingChainOps(s: ExchangeState): Pick<ChainEffect, "op" | "opId">[] {
  const out: Pick<ChainEffect, "op" | "opId">[] = [];
  for (const op of Object.values(s.ops).sort((a, b) => a.opId.localeCompare(b.opId))) if (op.status === "pending") out.push({ op: op.kind, opId: op.opId });
  for (const o of Object.values(s.orders).sort((a, b) => a.seq - b.seq)) {
    if (o.status === "placing") out.push({ op: "ask", opId: o.orderId });
    else if (o.status === "cancelling") out.push({ op: "cancel", opId: o.orderId });
  }
  for (const f of Object.values(s.fills).sort((a, b) => a.fillId.localeCompare(b.fillId))) if (f.status === "pending") out.push({ op: "fill", opId: f.fillId });
  return out;
}

/**
 * Sandbox mode (no chain) and tests: give every pending chain operation the same outcome.
 * No transaction hash is recorded, because none exists.
 */
export function settleAllPending(s: ExchangeState, ctx: ExchangeCtx, outcome: "confirmed" | "failed" = "confirmed"): number {
  const ops = pendingChainOps(s);
  for (const e of ops) settleChainOp(s, ctx, e, outcome, null, outcome === "failed" ? "sandbox failure" : null);
  return ops.length;
}

/**
 * Drops finished orders, fills and operations older than `keepTicks` so the saved state stays small.
 * Nothing that is still pending (or that a pending item points at) is ever removed.
 */
export function pruneExchange(s: ExchangeState, keepTicks = s.config.ticksPerDay * 2): number {
  const cutoff = s.tick - keepTicks;
  let removed = 0;
  const pendingOrderIds = new Set(Object.values(s.fills).filter((f) => f.status === "pending").map((f) => f.orderId));
  for (const f of Object.values(s.fills)) {
    if (f.status !== "pending" && (f.settledTick ?? f.reservedTick) < cutoff) {
      delete s.fills[f.fillId];
      removed += 1;
    }
  }
  for (const o of Object.values(s.orders)) {
    if (TERMINAL.includes(o.status) && o.createdTick < cutoff && !pendingOrderIds.has(o.orderId)) {
      delete s.orders[o.orderId];
      removed += 1;
    }
  }
  for (const op of Object.values(s.ops)) {
    if ((op.status === "settled" || op.status === "failed") && op.createdTick < cutoff) {
      delete s.ops[op.opId];
      removed += 1;
    }
  }
  return removed;
}

// ------------------------------------------------------------------ views + invariants

export function exchangeBook(s: ExchangeState) {
  const open = Object.values(s.orders).filter((o) => o.status === "open" && availableMl(o) >= 100);
  const levels = new Map<number, { priceCcPerL: number; quantityMl: number; orders: number }>();
  for (const o of open) {
    const l = levels.get(o.unitPriceCcPerL) ?? { priceCcPerL: o.unitPriceCcPerL, quantityMl: 0, orders: 0 };
    l.quantityMl += availableMl(o);
    l.orders += 1;
    levels.set(o.unitPriceCcPerL, l);
  }
  const asks = [...levels.values()].sort((a, b) => a.priceCcPerL - b.priceCcPerL);
  const traders = Object.values(s.traders)
    .sort((a, b) => a.traderId.localeCompare(b.traderId))
    .map((t) => ({
      traderId: t.traderId,
      name: t.params.name,
      blurb: t.params.blurb,
      person: t.params.person,
      face: t.params.face,
      status: t.status,
      stockMl: xbal(s, "fuel_ml", XACC.trader(t.traderId)),
      cashCc: xbal(s, "credits_cc", XACC.trader(t.traderId)),
      askCcPerL: t.decision?.askCcPerL ?? null,
      bidCcPerL: t.decision?.bidCcPerL ?? null,
      bidRoomMl: t.decision?.roomMl ?? 0,
      explanation: t.decision?.explanation ?? "",
      reasons: t.decision?.reasons ?? null,
    }));
  const bids = traders.filter((t) => t.bidCcPerL !== null).map((t) => t.bidCcPerL!) as number[];
  return {
    tick: s.tick,
    day: s.day,
    replacementCcPerL: replacementCcPerL(s),
    asks,
    bestAskCcPerL: asks[0]?.priceCcPerL ?? null,
    bestBidCcPerL: bids.length ? Math.max(...bids) : null,
    lastPriceCcPerL: s.today.lastPriceCcPerL ?? s.history.at(-1)?.lastPriceCcPerL ?? null,
    traders,
    history: s.history,
  };
}

export function playerExchangeView(s: ExchangeState, playerId: string) {
  const me: OwnerRef = { kind: "player", id: playerId };
  const warehouseMl = xbal(s, "fuel_ml", XACC.warehouse(playerId));
  const mine = (o: OwnerRef) => sameOwner(o, me);
  const pending = (kind: "deposit" | "redeem") => Object.values(s.ops).filter((op) => op.kind === kind && op.status === "pending" && mine(op.owner)).reduce((a, op) => a + op.quantityMl, 0);
  return {
    warehouseMl,
    pendingDepositMl: pending("deposit"),
    pendingRedeemMl: pending("redeem"),
    depositLeftTodayMl: Math.max(0, s.config.maxDepositPerDayMl - (s.depositsToday[playerId] ?? 0)),
    estimatedDailyFeeCc: Math.ceil((fillCostCc(warehouseMl, replacementCcPerL(s)) * s.config.storageFeeBps) / 10_000),
    orders: Object.values(s.orders).filter((o) => mine(o.owner)).sort((a, b) => b.seq - a.seq).slice(0, 20),
    fills: Object.values(s.fills).filter((f) => mine(f.buyer) || mine(f.seller)).sort((a, b) => b.reservedTick - a.reservedTick || b.fillId.localeCompare(a.fillId)).slice(0, 20),
  };
}

/** Every rule that must always hold. Returns human-readable violations (empty = healthy). */
export function exchangeInvariants(s: ExchangeState): string[] {
  const bad: string[] = [];
  for (const asset of ["fuel_ml", "credits_cc"] as const) {
    let sum = 0;
    for (const [acct, v] of Object.entries(s.balances[asset])) {
      sum += v;
      if (!acct.startsWith("world:") && v < 0) bad.push(`${acct} has negative ${asset} (${v})`);
    }
    if (sum !== 0) bad.push(`${asset} does not sum to zero (${sum})`);
  }
  const orders = Object.values(s.orders);
  const fills = Object.values(s.fills);
  const live = orders.filter((o) => LIVE.includes(o.status)).reduce((a, o) => a + availableMl(o), 0);
  if (xbal(s, "fuel_ml", XACC.asks) !== live) bad.push(`ask escrow ${xbal(s, "fuel_ml", XACC.asks)} != live asks ${live}`);
  const pendingFills = fills.filter((f) => f.status === "pending");
  const fillMl = pendingFills.reduce((a, f) => a + f.quantityMl, 0);
  if (xbal(s, "fuel_ml", XACC.fills) !== fillMl) bad.push(`fill escrow ${xbal(s, "fuel_ml", XACC.fills)} != pending fills ${fillMl}`);
  const payCc = pendingFills.filter((f) => f.buyer.kind === "trader").reduce((a, f) => a + f.totalCc, 0);
  if (xbal(s, "credits_cc", XACC.payments) !== payCc) bad.push(`payment escrow ${xbal(s, "credits_cc", XACC.payments)} != pending trader payments ${payCc}`);
  const supplyMl = Object.values(s.ops).filter((op) => op.kind === "supply" && op.status === "pending").reduce((a, op) => a + op.quantityMl, 0);
  if (xbal(s, "fuel_ml", XACC.supplies) !== supplyMl) bad.push(`supply escrow ${xbal(s, "fuel_ml", XACC.supplies)} != pending supplies ${supplyMl}`);
  const redeemMl = Object.values(s.ops).filter((op) => op.kind === "redeem" && op.status === "pending").reduce((a, op) => a + op.quantityMl, 0);
  if (xbal(s, "fuel_ml", XACC.redeems) !== redeemMl) bad.push(`redeem escrow ${xbal(s, "fuel_ml", XACC.redeems)} != pending redeems ${redeemMl}`);
  for (const o of orders) {
    const reserved = pendingFills.filter((f) => f.orderId === o.orderId).reduce((a, f) => a + f.quantityMl, 0);
    if (o.reservedMl !== reserved) bad.push(`order ${o.orderId} reserved ${o.reservedMl} != pending fills ${reserved}`);
    if (o.filledMl + o.reservedMl > o.quantityMl) bad.push(`order ${o.orderId} oversold`);
  }
  return bad;
}

/**
 * What the contract should hold if every confirmed operation is on-chain, for the reconciler.
 * Placing asks are still in their owner's balance on-chain; cancelling asks and pending fills are
 * still in contract escrow; pending redeems are not burned yet.
 */
export function expectedChainBalances(s: ExchangeState) {
  const players: Record<string, number> = {};
  const traders: Record<string, number> = {};
  for (const [acct, ml] of Object.entries(s.balances.fuel_ml)) {
    if (acct.startsWith("warehouse:")) players[acct.slice(10)] = (players[acct.slice(10)] ?? 0) + ml;
    if (acct.startsWith("trader:")) traders[acct.slice(7)] = ml;
  }
  for (const op of Object.values(s.ops)) {
    if (op.kind === "redeem" && op.status === "pending") players[op.owner.id] = (players[op.owner.id] ?? 0) + op.quantityMl;
    // not burned on-chain until the supply confirms
    if (op.kind === "supply" && op.status === "pending") traders[op.owner.id] = (traders[op.owner.id] ?? 0) + op.quantityMl;
  }
  let escrowMl = xbal(s, "fuel_ml", XACC.asks) + xbal(s, "fuel_ml", XACC.fills);
  for (const o of Object.values(s.orders)) {
    if (o.status !== "placing") continue;
    escrowMl -= o.quantityMl;
    const bucket = o.owner.kind === "player" ? players : traders;
    bucket[o.owner.id] = (bucket[o.owner.id] ?? 0) + o.quantityMl;
  }
  const supplyMl = Object.values(players).reduce((a, v) => a + v, 0) + Object.values(traders).reduce((a, v) => a + v, 0) + escrowMl;
  return { players, traders, escrowMl, supplyMl };
}
