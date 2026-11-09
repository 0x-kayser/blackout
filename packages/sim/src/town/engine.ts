/**
 * Vesper Market engine. Pure and deterministic: (seed, world inputs, trades) → identical town.
 *
 * Every credit and every item sits in a double-entry ledger. Merchants hold real balances; everything outside the
 * town (importers, outside customers, players' own inventories, which live in their regions) is an `ext:` account.
 *
 * One tick (5 town minutes): each open merchant imports what it's short of, sells to outside customers, buys from
 * outside producers, pays its fixed costs, and closes if its cash runs out. Once a town day it pays dividends to the
 * people who invested in it. Prices always come from merchantPricing.ts.
 */
import type { ItemId, MerchantView, TownEvent, TownTrade, TownView, WorldSnapshot } from "@blackout/shared";
import { ITEMS } from "@blackout/shared";
import { rngInt, seedRng, type RngState } from "../prng.ts";
import { SimError } from "../state.ts";
import { canonical, sha256 } from "../region/settlement.ts";
import { CLOSE_BELOW_DAY_BPS, DIVIDEND_BPS, EPOCH_TICKS, MERCHANTS, REOPEN_DAYS, RESCUE_AFTER_DAYS, TICKS_PER_DAY, WAREHOUSE_FULL_X, referenceCc, type MerchantConfig, type MerchantItemConfig } from "./config.ts";
import { priceItem, rationLimit, type Quote } from "./merchantPricing.ts";

export type TAsset = "cc" | ItemId;

export interface MerchantState {
  open: boolean;
  closedSince: number;
  closedReason: string | null;
  recentNet: Partial<Record<ItemId, number>>;
  history: Partial<Record<ItemId, number[]>>;
  investors: { playerId: string; name: string; investedCc: number; npc?: boolean }[];
  cashAtDayStart: number;
  inflowToday: number;
  lastTradeAt: number;
}

export interface TownEpoch {
  epochNo: number;
  epochId: string;
  fromTick: number;
  toTick: number;
  tokens: { token: string; transfers: { account: string; delta: number }[] }[];
  hash: string;
}

export interface TownState {
  version: 1;
  seed: number;
  rng: RngState;
  tick: number;
  world: { gasUsdPerMMBtu: number; brentUsdPerBbl: number; carbonUsdPerT: number };
  /** Steel deliveries follow the players' steel mills (10,000 = normal). */
  steelSupplyBps: number;
  merchants: Record<string, MerchantState>;
  balances: Record<string, Record<string, number>>;
  trades: TownTrade[];
  tradeSeq: number;
  events: TownEvent[];
  eventSeq: number;
  /** Dividends earned by players, waiting to be paid into their regions. */
  owed: Record<string, number>;
  dividendsTotal: Record<string, number>;
  names: Record<string, string>;
  epochs: TownEpoch[];
  epochStart: { tick: number; balances: Record<string, Record<string, number>> };
}

export interface TCtx {
  events: TownEvent[];
  trades: TownTrade[];
}
export const newTCtx = (): TCtx => ({ events: [], trades: [] });

const CFG: Record<string, MerchantConfig> = Object.fromEntries(MERCHANTS.map((m) => [m.merchantId, m]));
export const merchantConfig = (id: string) => CFG[id];
export const MACC = (id: string) => `merchant:${id}`;
export const PACC = (playerId: string) => `ext:player:${playerId}`;
const isExt = (a: string) => a.startsWith("ext:");
const cr = (cc: number) => `₡${Math.round(cc / 100).toLocaleString("en-US")}`;
const PLURAL: Record<ItemId, string> = { "fuel:natural-gas": "natural gas", "fuel:diesel": "diesel", "permit:carbon": "carbon permits", "certificate:renewable": "renewable certificates", "material:steel": "steel", "part:turbine": "turbine parts" };

export function tbal(t: TownState, asset: TAsset, acct: string): number {
  return t.balances[asset]?.[acct] ?? 0;
}

function move(t: TownState, asset: TAsset, from: string, to: string, amount: number): void {
  if (!Number.isInteger(amount) || amount < 0) throw new SimError("INTERNAL", `town amount must be a non-negative integer, got ${amount}`);
  if (amount === 0 || from === to) return;
  const book = (t.balances[asset] ??= {});
  const fb = book[from] ?? 0;
  if (!isExt(from) && fb < amount) throw new SimError(asset === "cc" ? "INSUFFICIENT_CREDITS" : "OUT_OF_STOCK", `${from} has ${fb} ${asset}, needs ${amount}`);
  book[from] = fb - amount;
  book[to] = (book[to] ?? 0) + amount;
}

export function townSum(t: TownState, asset: TAsset): number {
  return Object.values(t.balances[asset] ?? {}).reduce((a, b) => a + b, 0);
}

function emit(t: TownState, ctx: TCtx, e: Omit<TownEvent, "seq" | "tick">): void {
  t.eventSeq += 1;
  const ev = { ...e, seq: t.eventSeq, tick: t.tick };
  t.events.push(ev);
  if (t.events.length > 60) t.events.splice(0, t.events.length - 60);
  ctx.events.push(ev);
}

export function createTown(opts: { seed: number; world?: Pick<WorldSnapshot, "gasUsdPerMMBtu" | "brentUsdPerBbl" | "carbonUsdPerT"> }): TownState {
  const t: TownState = {
    version: 1,
    seed: opts.seed,
    rng: seedRng(opts.seed),
    tick: 0,
    world: { gasUsdPerMMBtu: opts.world?.gasUsdPerMMBtu ?? 3.6, brentUsdPerBbl: opts.world?.brentUsdPerBbl ?? 72, carbonUsdPerT: opts.world?.carbonUsdPerT ?? 32 },
    steelSupplyBps: 10_000,
    merchants: {},
    balances: { cc: {} },
    trades: [],
    tradeSeq: 0,
    events: [],
    eventSeq: 0,
    owed: {},
    dividendsTotal: {},
    names: {},
    epochs: [],
    epochStart: { tick: 0, balances: {} },
  };
  for (const m of MERCHANTS) {
    move(t, "cc", "ext:owners", MACC(m.merchantId), m.cashCc);
    const st: MerchantState = { open: true, closedSince: -1, closedReason: null, recentNet: {}, history: {}, investors: [], cashAtDayStart: m.cashCc, inflowToday: 0, lastTradeAt: -1 };
    t.merchants[m.merchantId] = st;
    for (const it of m.items) {
      move(t, it.item, "ext:imports", MACC(m.merchantId), Math.round((it.target * it.startBps) / 10_000));
      st.recentNet[it.item] = 0;
    }
  }
  for (const m of MERCHANTS) for (const it of m.items) t.merchants[m.merchantId].history[it.item] = [quote(t, m.merchantId, it.item).askCc];
  return t;
}

/* ------------------------------------------------------------------------------------------------- quotes */

function rivalShort(t: TownState, merchantId: string, item: ItemId): boolean {
  return MERCHANTS.some((o) => {
    if (o.merchantId === merchantId) return false;
    const it = o.items.find((x) => x.item === item && x.sells);
    if (!it) return false;
    return !t.merchants[o.merchantId].open || tbal(t, item, MACC(o.merchantId)) < it.target * 0.25;
  });
}

export function quote(t: TownState, merchantId: string, item: ItemId, stockDelta = 0, netDelta = 0): Quote {
  const m = CFG[merchantId];
  const it = m.items.find((x) => x.item === item)!;
  const st = t.merchants[merchantId];
  return priceItem({
    person: m.person,
    traits: m.traits,
    item,
    referenceCc: referenceCc(item, t.world),
    stock: tbal(t, item, MACC(merchantId)) + stockDelta,
    target: it.target,
    recentNet: (st.recentNet[item] ?? 0) + netDelta,
    markupBps: it.markupBps,
    spreadBps: it.spreadBps,
    rivalShort: rivalShort(t, merchantId, item),
  });
}

/** What a trade of `qty` would cost/pay: the average of the price before and after it (bigger orders move price). */
export function tradePrice(t: TownState, merchantId: string, item: ItemId, side: "buy" | "sell", qty: number): { unitCc: number; totalCc: number } {
  const now = quote(t, merchantId, item);
  const after = side === "buy" ? quote(t, merchantId, item, -qty, qty) : quote(t, merchantId, item, qty, -qty);
  const unitCc = side === "buy" ? Math.round((now.askCc + after.askCc) / 2) : Math.round((now.bidCc + after.bidCc) / 2);
  return { unitCc, totalCc: unitCc * qty };
}

/* ------------------------------------------------------------------------------------------------- trades */

export interface TradeInput {
  playerId: string;
  name: string;
  kind?: "player" | "bot";
  merchantId: string;
  item: ItemId;
  side: "buy" | "sell";
  quantity: number;
}

/** A player (or bot) buys from or sells to a merchant. Throws a SimError with a friendly reason if it can't. */
export function townTrade(t: TownState, ctx: TCtx, inp: TradeInput): TownTrade {
  const m = CFG[inp.merchantId];
  if (!m) throw new SimError("NOT_FOUND", "No such merchant.");
  const st = t.merchants[inp.merchantId];
  if (!st.open) throw new SimError("MERCHANT_CLOSED", `${m.name} is closed${st.closedReason ? `: ${st.closedReason}` : ""}. Invest to reopen it.`);
  const it = m.items.find((x) => x.item === inp.item);
  if (!it) throw new SimError("VALIDATION_FAILED", `${m.person} doesn't trade ${ITEMS[inp.item].name.toLowerCase()}.`);
  const qty = inp.quantity;
  const acct = MACC(inp.merchantId);
  const stock = tbal(t, inp.item, acct);
  const unit = ITEMS[inp.item].units;
  if (inp.side === "buy") {
    if (!it.sells) throw new SimError("VALIDATION_FAILED", `${m.person} only buys ${ITEMS[inp.item].name.toLowerCase()}.`);
    if (qty > stock) throw new SimError("OUT_OF_STOCK", `${m.person} has only ${stock.toLocaleString("en-US")} ${unit} left.`);
    const lim = rationLimit({ traits: m.traits, stock, target: it.target });
    if (lim !== null && qty > lim) throw new SimError("RATION_LIMIT", `${m.person} is rationing: at most ${lim.toLocaleString("en-US")} ${unit} per order.`);
  } else {
    if (!it.buys) throw new SimError("VALIDATION_FAILED", `${m.person} doesn't buy ${ITEMS[inp.item].name.toLowerCase()}.`);
    const room = it.target * WAREHOUSE_FULL_X - stock;
    if (room <= 0) throw new SimError("INVALID_STATE", `${m.person}'s warehouse is full of ${PLURAL[inp.item]}. Try another merchant or wait.`);
    if (qty > room) throw new SimError("INVALID_STATE", `${m.person} has room for only ${room.toLocaleString("en-US")} more ${unit}.`);
  }
  const { unitCc, totalCc } = tradePrice(t, inp.merchantId, inp.item, inp.side, qty);
  const pacc = PACC(inp.playerId);
  if (inp.side === "buy") {
    move(t, inp.item, acct, pacc, qty);
    move(t, "cc", pacc, acct, totalCc);
    st.inflowToday += 0;
  } else {
    const cash = tbal(t, "cc", acct);
    if (cash < totalCc) throw new SimError("INSUFFICIENT_CREDITS", `${m.person} has only ${cr(cash)} to spend: sell ${Math.max(0, Math.floor(cash / Math.max(1, unitCc))).toLocaleString("en-US")} or fewer.`);
    move(t, inp.item, pacc, acct, qty);
    move(t, "cc", acct, pacc, totalCc);
  }
  st.recentNet[inp.item] = (st.recentNet[inp.item] ?? 0) + (inp.side === "buy" ? qty : -qty);
  st.lastTradeAt = t.tick;
  t.names[inp.playerId] = inp.name;
  return record(t, ctx, { label: inp.name, merchantId: inp.merchantId, who: inp.playerId, whoKind: inp.kind ?? "player", item: inp.item, side: inp.side, quantity: qty, priceCc: unitCc, totalCc });
}

function record(t: TownState, ctx: TCtx, tr: Omit<TownTrade, "seq" | "tick">): TownTrade {
  t.tradeSeq += 1;
  const full: TownTrade = { ...tr, seq: t.tradeSeq, tick: t.tick };
  t.trades.push(full);
  if (t.trades.length > 80) t.trades.splice(0, t.trades.length - 80);
  ctx.trades.push(full);
  return full;
}

export const reopenCc = (merchantId: string) => CFG[merchantId].fixedCcPerDay * REOPEN_DAYS;

/** Invest credits in a merchant. A closed shop reopens once the investment covers three days of its costs. */
export function townInvest(t: TownState, ctx: TCtx, inp: { playerId: string; name: string; merchantId: string; amountCc: number; npc?: boolean }): { reopened: boolean; shareBps: number } {
  const m = CFG[inp.merchantId];
  if (!m) throw new SimError("NOT_FOUND", "No such merchant.");
  const st = t.merchants[inp.merchantId];
  const need = reopenCc(inp.merchantId);
  if (!st.open && inp.amountCc < need) throw new SimError("REQUIREMENT_NOT_MET", `Reopening ${m.name} takes at least ${cr(need)}: three days of its costs.`);
  move(t, "cc", inp.npc ? "ext:investors" : PACC(inp.playerId), MACC(inp.merchantId), inp.amountCc);
  const existing = st.investors.find((x) => x.playerId === inp.playerId);
  if (existing) existing.investedCc += inp.amountCc;
  else st.investors.push({ playerId: inp.playerId, name: inp.name, investedCc: inp.amountCc, ...(inp.npc ? { npc: true } : {}) });
  st.cashAtDayStart += inp.amountCc;
  t.names[inp.playerId] = inp.name;
  let reopened = false;
  if (!st.open) {
    st.open = true;
    st.closedSince = -1;
    st.closedReason = null;
    reopened = true;
    emit(t, ctx, { severity: "good", title: `${m.name} reopens`, detail: `${inp.name} invested ${cr(inp.amountCc)} and now owns ${(shareOf(inp.merchantId, st, inp.playerId) / 100).toFixed(1)}% of ${m.person}'s profits.`, merchantId: inp.merchantId });
  } else {
    emit(t, ctx, { severity: "info", title: `${inp.name} invests in ${m.name}`, detail: `${cr(inp.amountCc)} for ${(shareOf(inp.merchantId, st, inp.playerId) / 100).toFixed(1)}% of future profits.`, merchantId: inp.merchantId });
  }
  return { reopened, shareBps: shareOf(inp.merchantId, st, inp.playerId) };
}

function shareOf(merchantId: string, st: MerchantState, playerId: string): number {
  const total = st.investors.reduce((a, x) => a + x.investedCc, 0) + CFG[merchantId].cashCc;
  const mine = st.investors.find((x) => x.playerId === playerId)?.investedCc ?? 0;
  return Math.round((mine * 10_000) / Math.max(1, total));
}

/* ---------------------------------------------------------------------------------------------------- tick */

function perTick(t: TownState, perDay: number): number {
  const base = Math.floor(perDay / TICKS_PER_DAY);
  const frac = perDay % TICKS_PER_DAY;
  return base + (rngInt(t.rng, TICKS_PER_DAY) < frac ? 1 : 0);
}

const DECAY = Math.pow(0.5, 1 / 36);

export function townTick(t: TownState, ctx: TCtx): void {
  t.tick += 1;
  for (const m of MERCHANTS) {
    const st = t.merchants[m.merchantId];
    const acct = MACC(m.merchantId);
    if (!st.open) {
      if (t.tick - st.closedSince >= RESCUE_AFTER_DAYS * TICKS_PER_DAY) townInvest(t, ctx, { playerId: "vesper-holdings", name: "Vesper Holdings", merchantId: m.merchantId, amountCc: reopenCc(m.merchantId), npc: true });
      continue;
    }
    for (const it of m.items) flows(t, m, it);
    // fixed costs: rent, wages, insurance
    const cost = Math.floor(m.fixedCcPerDay / TICKS_PER_DAY);
    const cash = tbal(t, "cc", acct);
    move(t, "cc", acct, "ext:costs", Math.min(cost, cash));
    for (const it of m.items) st.recentNet[it.item] = (st.recentNet[it.item] ?? 0) * DECAY;
    if (t.tick % 12 === 0)
      for (const it of m.items) {
        const h = (st.history[it.item] ??= []);
        h.push(quote(t, m.merchantId, it.item).askCc);
        if (h.length > 48) h.shift();
      }
    if (tbal(t, "cc", acct) < (m.fixedCcPerDay * CLOSE_BELOW_DAY_BPS) / 10_000) close(t, ctx, m);
  }
  if (t.tick % TICKS_PER_DAY === 0) payDividends(t, ctx);
  maybeCloseTownEpoch(t);
}

function flows(t: TownState, m: MerchantConfig, it: MerchantItemConfig): void {
  const acct = MACC(m.merchantId);
  const ref = referenceCc(it.item, t.world);
  const stock = tbal(t, it.item, acct);
  // imports when short, at 92% of the outside price, as far as cash allows
  if (it.importPerDay > 0 && stock < it.target) {
    let q = perTick(t, it.importPerDay);
    if (it.item === "material:steel") q = Math.round((q * t.steelSupplyBps) / 10_000);
    const unit = Math.round(ref * 0.92);
    // a merchant keeps a day of costs in reserve: it won't spend the rent on stock
    q = Math.min(q, it.target - stock, Math.floor(Math.max(0, tbal(t, "cc", acct) - m.fixedCcPerDay) / Math.max(1, unit)));
    if (q > 0) {
      move(t, "cc", acct, "ext:imports", q * unit);
      move(t, it.item, "ext:imports", acct, q);
    }
  }
  const qte = quote(t, m.merchantId, it.item);
  // outside customers buy less when it's dear
  if (it.sells && it.npcDemandPerDay > 0) {
    const elastic = Math.max(0.2, Math.min(2, Math.pow(ref / Math.max(1, qte.askCc), 1.5)));
    const q = Math.min(Math.round(perTick(t, it.npcDemandPerDay) * elastic), tbal(t, it.item, acct));
    if (q > 0) {
      move(t, it.item, acct, "ext:npc", q);
      move(t, "cc", "ext:npc", acct, q * qte.askCc);
    }
  }
  // outside producers sell more when the merchant pays well
  if (it.buys && it.npcSupplyPerDay > 0) {
    const room = it.target * WAREHOUSE_FULL_X - tbal(t, it.item, acct);
    const elastic = Math.max(0.2, Math.min(2, qte.bidCc / Math.max(1, ref)));
    const q = Math.min(Math.round(perTick(t, it.npcSupplyPerDay) * elastic), room, Math.floor(tbal(t, "cc", acct) / Math.max(1, qte.bidCc)));
    if (q > 0) {
      move(t, it.item, "ext:npc", acct, q);
      move(t, "cc", acct, "ext:npc", q * qte.bidCc);
    }
  }
}

function close(t: TownState, ctx: TCtx, m: MerchantConfig): void {
  const st = t.merchants[m.merchantId];
  st.open = false;
  st.closedSince = t.tick;
  const glut = m.items.find((it) => tbal(t, it.item, MACC(m.merchantId)) > it.target * 2);
  st.closedReason = glut ? `${m.person} spent everything on ${PLURAL[glut.item]} nobody is buying` : `${m.person}'s sales stopped covering the rent`;
  emit(t, ctx, { severity: "crisis", title: `${m.name} has closed`, detail: `${st.closedReason}. Nobody can trade here until someone invests ${cr(reopenCc(m.merchantId))}.`, merchantId: m.merchantId });
}

function payDividends(t: TownState, ctx: TCtx): void {
  for (const m of MERCHANTS) {
    const st = t.merchants[m.merchantId];
    const acct = MACC(m.merchantId);
    const cash = tbal(t, "cc", acct);
    st.cashAtDayStart = cash;
    if (!st.open) continue;
    const excess = cash - m.fixedCcPerDay * REOPEN_DAYS;
    if (excess <= 0) continue;
    const pot = Math.floor((excess * DIVIDEND_BPS) / 10_000);
    const total = st.investors.reduce((a, x) => a + x.investedCc, 0) + m.cashCc;
    let paid = 0;
    for (const inv of st.investors) {
      const share = Math.floor((pot * inv.investedCc) / total);
      if (share <= 0) continue;
      move(t, "cc", acct, inv.npc ? "ext:investors" : PACC(inv.playerId), share);
      if (!inv.npc) {
        t.owed[inv.playerId] = (t.owed[inv.playerId] ?? 0) + share;
        t.dividendsTotal[inv.playerId] = (t.dividendsTotal[inv.playerId] ?? 0) + share;
      }
      paid += share;
    }
    move(t, "cc", acct, "ext:owners", Math.floor((pot * m.cashCc) / total));
    st.cashAtDayStart = tbal(t, "cc", acct);
    if (paid > 0 && st.investors.some((x) => !x.npc)) emit(t, ctx, { severity: "good", title: `${m.name} pays ${cr(paid)} to its investors`, detail: "", merchantId: m.merchantId });
  }
}

/** Dividends owed to a player, collected into their region. */
export function takeOwed(t: TownState, playerId: string): number {
  const n = t.owed[playerId] ?? 0;
  delete t.owed[playerId];
  return n;
}

export function setTownWorld(t: TownState, world: TownState["world"]): void {
  t.world = { ...world };
}

/** Cheapest open asks, which become the fuel price inside every region. */
export function townFuelPrices(t: TownState): { gas: number | null; diesel: number | null } {
  const best = (item: ItemId) => {
    let p: number | null = null;
    for (const m of MERCHANTS) {
      const it = m.items.find((x) => x.item === item && x.sells);
      if (!it || !t.merchants[m.merchantId].open || tbal(t, item, MACC(m.merchantId)) <= 0) continue;
      const a = quote(t, m.merchantId, item).askCc;
      if (p === null || a < p) p = a;
    }
    return p;
  };
  return { gas: best("fuel:natural-gas"), diesel: best("fuel:diesel") };
}

/** The best open merchant to buy (or sell) an item with. */
export function bestMerchant(t: TownState, item: ItemId, side: "buy" | "sell", qty = 1): string | null {
  let best: { id: string; p: number } | null = null;
  for (const m of MERCHANTS) {
    const it = m.items.find((x) => x.item === item && (side === "buy" ? x.sells : x.buys));
    if (!it || !t.merchants[m.merchantId].open) continue;
    const stock = tbal(t, item, MACC(m.merchantId));
    if (side === "buy" && stock < qty) continue;
    if (side === "sell" && stock + qty > it.target * WAREHOUSE_FULL_X) continue;
    const q = quote(t, m.merchantId, item);
    const p = side === "buy" ? q.askCc : -q.bidCc;
    if (!best || p < best.p) best = { id: m.merchantId, p };
  }
  return best?.id ?? null;
}

/* ------------------------------------------------------------------------------------------------- epochs */

const CHAIN = Object.fromEntries(MERCHANTS.map((m) => [MACC(m.merchantId), m.chainName]));

function identityTotals(b: Record<string, Record<string, number>>): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [asset, book] of Object.entries(b)) {
    const o = (out[asset] = {} as Record<string, number>);
    for (const [acct, v] of Object.entries(book)) {
      const id = CHAIN[acct] ?? "operator";
      o[id] = (o[id] ?? 0) + v;
    }
  }
  return out;
}

const TOKEN: Record<string, string> = { cc: "credit:vesper" };

function maybeCloseTownEpoch(t: TownState): void {
  if (t.tick - t.epochStart.tick < EPOCH_TICKS) return;
  const before = identityTotals(t.epochStart.balances);
  const after = identityTotals(t.balances);
  const tokens = Object.keys(after)
    .sort()
    .map((asset) => {
      const ids = [...new Set([...Object.keys(before[asset] ?? {}), ...Object.keys(after[asset])])].sort();
      return { token: TOKEN[asset] ?? asset, transfers: ids.map((account) => ({ account, delta: (after[asset][account] ?? 0) - (before[asset]?.[account] ?? 0) })).filter((x) => x.delta !== 0) };
    })
    .filter((x) => x.transfers.length);
  const epochNo = (t.epochs.at(-1)?.epochNo ?? 0) + 1;
  const body = { epochId: `town:${epochNo}`, fromTick: t.epochStart.tick, toTick: t.tick, tokens };
  t.epochs.push({ epochNo, ...body, hash: sha256(canonical(body)) });
  if (t.epochs.length > 24) t.epochs.splice(0, t.epochs.length - 24);
  t.epochStart = { tick: t.tick, balances: JSON.parse(JSON.stringify(t.balances)) };
}

export function verifyTownEpoch(e: TownEpoch): boolean {
  const { hash, epochNo, ...body } = e;
  void epochNo;
  return sha256(canonical(body)) === hash && e.tokens.every((tk) => tk.transfers.reduce((a, x) => a + x.delta, 0) === 0);
}

/* --------------------------------------------------------------------------------------------------- view */

export function townClock(tick: number): string {
  const day = Math.floor(tick / TICKS_PER_DAY) + 1;
  const m = (tick % TICKS_PER_DAY) * 5;
  return `Market day ${day} · ${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function toTownView(t: TownState, viewer: string | null, chainAccounts: Record<string, string | null> = {}): TownView {
  const merchants: MerchantView[] = MERCHANTS.map((m) => {
    const st = t.merchants[m.merchantId];
    const acct = MACC(m.merchantId);
    const total = st.investors.reduce((a, x) => a + x.investedCc, 0) + m.cashCc;
    return {
      merchantId: m.merchantId,
      name: m.name,
      person: m.person,
      face: m.face,
      personality: m.personality,
      open: st.open,
      cashCc: tbal(t, "cc", acct),
      reopenCc: reopenCc(m.merchantId),
      fixedCcPerDay: m.fixedCcPerDay,
      profitCcToday: tbal(t, "cc", acct) - st.cashAtDayStart,
      items: m.items.map((it) => {
        const q = quote(t, m.merchantId, it.item);
        const h = st.history[it.item] ?? [];
        return {
          item: it.item,
          stock: tbal(t, it.item, acct),
          target: it.target,
          askCc: it.sells ? q.askCc : null,
          bidCc: it.buys ? q.bidCc : null,
          referenceCc: referenceCc(it.item, t.world),
          why: q.why,
          askAnHourAgoCc: h.length ? h[h.length - 1] : null,
          history: h,
        };
      }),
      investors: st.investors.map((x) => ({ playerId: x.playerId, name: x.name, investedCc: x.investedCc, shareBps: Math.round((x.investedCc * 10_000) / Math.max(1, total)), mine: x.playerId === viewer })),
      closedReason: st.closedReason,
      chainAccount: chainAccounts[m.chainName] ?? null,
      lastTradeAt: st.lastTradeAt,
    };
  });
  const invested = viewer ? MERCHANTS.reduce((a, m) => a + (t.merchants[m.merchantId].investors.find((x) => x.playerId === viewer)?.investedCc ?? 0), 0) : 0;
  return {
    tick: t.tick,
    clock: townClock(t.tick),
    merchants,
    trades: t.trades.slice(-40).map((x) => (viewer && x.who === viewer ? { ...x, whoKind: "you" as const, label: "You" } : x)),
    events: t.events.slice(-30),
    players: Object.keys(t.names).filter((k) => !k.startsWith("bot:") && k !== "vesper-holdings").length,
    you: viewer ? { investedCc: invested, dividendsCcTotal: t.dividendsTotal[viewer] ?? 0, pendingCc: t.owed[viewer] ?? 0 } : null,
    steelSupplyBps: t.steelSupplyBps,
  };
}
