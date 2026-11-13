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
import { CLOSE_BELOW_DAY_BPS, DIVIDEND_BPS, EPOCH_TICKS, MERCHANTS, REOPEN_DAYS, RESOURCE_ENDOWMENT, RESCUE_AFTER_DAYS, TICKS_PER_DAY, WAREHOUSE_FULL_X, referenceCc, reserveAvailableAccount, reserveRemainingAt, reserveSealedAccount, type MerchantConfig, type MerchantItemConfig } from "./config.ts";
import { priceItem, rationLimit, type Quote } from "./merchantPricing.ts";
import { NEWS_EVERY, NEWS_LASTS, NEWS_MAX_ACTIVE, STORIES, effectLabel, storyById, type NewsEffect } from "./news.ts";
import { FACC, FIRMS, FIRM, ensureFirms, firmsTick, minuteOfDay, spendable, type FirmState, type PowerEnv, type PowerOrderState } from "./firms.ts";
import { WINDOW_TICKS, sunBps, type PowerOffer } from "./firmPolicy.ts";

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
  /** Stories running now (news.ts). Optional so towns saved before the news desk load unchanged. */
  news?: { seq: number; storyId: string; from: number; until: number }[];
  newsSeq?: number;
  nextNewsAt?: number;
  /** The news desk's own seeded stream, so stories never shift the market's other random draws. */
  newsRng?: RngState;
  lastStoryId?: string;
  /** NPC companies (firms.ts) and the power desk; optional so older saved towns load and gain them on the next tick. */
  firms?: Record<string, FirmState>;
  power?: { seq: number; orders: PowerOrderState[]; offers: PowerOffer[] };
  sky?: { cloudPct: number };
  /** Credit flows already settled directly on chain (escrowed power payments) since the last epoch, by identity. */
  direct?: Record<string, Record<string, number>>;
  /** Fixed resource endowment metadata. Balances live in reserve:* accounts in the double-entry ledger. */
  resourceLedger?: { totals: Partial<Record<ItemId, number>>; legacy: boolean; noticeBps: Partial<Record<ItemId, number>> };
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

export function resourceReserve(t: TownState, item: ItemId): { total: number; remaining: number; remainingBps: number; legacy: boolean; nextReleaseDay: number | null; nextReleaseQuantity: number } {
  ensureTownResources(t);
  const config = RESOURCE_ENDOWMENT[item];
  const total = t.resourceLedger!.totals[item] ?? 0;
  const remaining = reserveRemainingAt(item, t.balances[item] ?? {});
  const next = config?.deposits.find((d) => d.day > Math.floor(t.tick / TICKS_PER_DAY) && tbal(t, item, reserveSealedAccount(item, d.day)) > 0);
  return { total, remaining, remainingBps: total > 0 ? Math.round((remaining * 10_000) / total) : 0, legacy: t.resourceLedger!.legacy, nextReleaseDay: next?.day ?? null, nextReleaseQuantity: next ? Math.min(next.quantity, tbal(t, item, reserveSealedAccount(item, next.day))) : 0 };
}

function reserveMultiplier(t: TownState, item: ItemId): number {
  const reserve = resourceReserve(t, item);
  if (reserve.total <= 0 || reserve.legacy) return 1;
  const extracted = Math.max(0, 1 - reserve.remaining / reserve.total);
  return Math.round(Math.min(3.5, 1 + extracted * extracted * 2.5) * 100) / 100;
}

/** Existing saves already contain finite holdings. Record their historical imports once, then stop creating new stock. */
export function ensureTownResources(t: TownState): void {
  if (t.resourceLedger) return;
  const totals: Partial<Record<ItemId, number>> = {};
  for (const item of Object.keys(RESOURCE_ENDOWMENT) as ItemId[]) totals[item] = Math.max(0, -tbal(t, item, "ext:imports"));
  t.resourceLedger = { totals, legacy: true, noticeBps: {} };
}

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
    resourceLedger: { totals: {}, legacy: false, noticeBps: {} },
  };
  for (const [item, endowment] of Object.entries(RESOURCE_ENDOWMENT) as [ItemId, NonNullable<(typeof RESOURCE_ENDOWMENT)[ItemId]>][]) {
    t.resourceLedger!.totals[item] = endowment.total;
    for (const deposit of endowment.deposits) {
      move(t, item, "ext:genesis", deposit.day === 0 ? reserveAvailableAccount(item) : reserveSealedAccount(item, deposit.day), deposit.quantity);
    }
  }
  for (const m of MERCHANTS) {
    move(t, "cc", "ext:owners", MACC(m.merchantId), m.cashCc);
    const st: MerchantState = { open: true, closedSince: -1, closedReason: null, recentNet: {}, history: {}, investors: [], cashAtDayStart: m.cashCc, inflowToday: 0, lastTradeAt: -1 };
    t.merchants[m.merchantId] = st;
    for (const it of m.items) {
      const start = Math.round((it.target * it.startBps) / 10_000);
      const finite = RESOURCE_ENDOWMENT[it.item] !== undefined;
      move(t, it.item, finite ? reserveAvailableAccount(it.item) : "ext:imports", MACC(m.merchantId), start);
      st.recentNet[it.item] = 0;
    }
  }
  for (const m of MERCHANTS) for (const it of m.items) t.merchants[m.merchantId].history[it.item] = [quote(t, m.merchantId, it.item).askCc];
  return t;
}

/* --------------------------------------------------------------------------------------------------- news */

/** Effects of running stories on one merchant's item. */
function effectsOn(t: TownState, merchantId: string, item: ItemId): { headline: string; e: NewsEffect }[] {
  const out: { headline: string; e: NewsEffect }[] = [];
  for (const n of t.news ?? []) {
    const story = storyById(n.storyId);
    if (!story) continue;
    for (const e of story.effects) if (e.item === item && (!e.merchants || e.merchants.includes(merchantId))) out.push({ headline: story.headline, e });
  }
  return out;
}

function newsMult(t: TownState, merchantId: string, item: ItemId, key: "imports" | "demand" | "supply" | "outside"): number {
  return effectsOn(t, merchantId, item).reduce((a, x) => a * (x.e[key] ?? 1), 1);
}

/** The outside price a merchant starts from today, after any story that moves it. */
function refOf(t: TownState, merchantId: string, item: ItemId): number {
  return Math.round(referenceCc(item, t.world) * newsMult(t, merchantId, item, "outside") * reserveMultiplier(t, item));
}

/** Ends stories that have run their course and, every minute or so, breaks a new one. */
function newsStep(t: TownState, ctx: TCtx): void {
  t.news ??= [];
  t.newsRng ??= seedRng((t.seed ^ 0x6e657773) >>> 0);
  t.nextNewsAt ??= t.tick + 20;
  for (const n of t.news.filter((x) => x.until <= t.tick)) {
    const story = storyById(n.storyId);
    if (story) emit(t, ctx, { kind: "news", severity: "info", title: `Over: ${story.headline.charAt(0).toLowerCase()}${story.headline.slice(1)}`, detail: "Flows are back to normal; prices drift back as stock recovers.", merchantId: story.effects[0].merchants?.[0] ?? null });
  }
  t.news = t.news.filter((x) => x.until > t.tick);
  if (t.tick < t.nextNewsAt) return;
  const r = t.newsRng;
  t.nextNewsAt = t.tick + NEWS_EVERY[0] + rngInt(r, NEWS_EVERY[1] - NEWS_EVERY[0] + 1);
  if (t.news.length >= NEWS_MAX_ACTIVE) return;
  // never two stories about the same item at once, and never the story that just ran
  const busy = new Set(t.news.flatMap((n) => storyById(n.storyId)?.effects.map((e) => e.item) ?? []));
  const lastId = t.lastStoryId;
  const pool = STORIES.filter((x) => x.storyId !== lastId && x.effects.every((e) => !busy.has(e.item)) && x.effects.every((e) => !e.merchants || e.merchants.some((m) => t.merchants[m]?.open)));
  if (!pool.length) return;
  const story = pool[rngInt(r, pool.length)];
  t.newsSeq = (t.newsSeq ?? 0) + 1;
  t.news.push({ seq: t.newsSeq, storyId: story.storyId, from: t.tick, until: t.tick + NEWS_LASTS[0] + rngInt(r, NEWS_LASTS[1] - NEWS_LASTS[0] + 1) });
  t.lastStoryId = story.storyId;
  emit(t, ctx, { kind: "news", severity: story.tone === "good" ? "good" : "warn", title: story.headline, detail: story.detail, merchantId: story.effects[0].merchants?.[0] ?? null });
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
    referenceCc: refOf(t, merchantId, item),
    stock: tbal(t, item, MACC(merchantId)) + stockDelta,
    target: it.target,
    recentNet: (st.recentNet[item] ?? 0) + netDelta,
    markupBps: it.markupBps,
    spreadBps: it.spreadBps,
    rivalShort: rivalShort(t, merchantId, item),
    news: [
      ...effectsOn(t, merchantId, item).map((x) => ({ label: `News: ${x.headline}`, factor: effectLabel(x.e) })),
      ...(RESOURCE_ENDOWMENT[item] ? [{ label: `Vesper reserve: ${resourceReserve(t, item).remaining.toLocaleString("en-US")} of ${resourceReserve(t, item).total.toLocaleString("en-US")} remain`, factor: `×${reserveMultiplier(t, item).toFixed(2)}` }] : []),
    ],
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
  kind?: "player" | "bot" | "npc";
  merchantId: string;
  item: ItemId;
  side: "buy" | "sell";
  quantity: number;
  /** Pay from (and deliver to) this ledger account instead of the player's: an NPC company's own wallet. */
  account?: string;
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
  const pacc = inp.account ?? PACC(inp.playerId);
  if (inp.account && inp.side === "buy" && tbal(t, "cc", inp.account) < totalCc) throw new SimError("INSUFFICIENT_CREDITS", `${inp.name} can't afford that.`);
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

export function townTick(t: TownState, ctx: TCtx, env: PowerEnv = {}): void {
  ensureTownResources(t);
  t.tick += 1;
  resourceReserveStep(t, ctx);
  newsStep(t, ctx);
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
  firmsTick(t, ctx, env, () => cheapestGas(t), (firmId, qty) => firmBuysGas(t, ctx, firmId, qty), cloudTarget(t));
  maybeCloseTownEpoch(t);
}

function resourceReserveStep(t: TownState, ctx: TCtx): void {
  const day = Math.floor(t.tick / TICKS_PER_DAY);
  for (const [item, config] of Object.entries(RESOURCE_ENDOWMENT) as [ItemId, NonNullable<(typeof RESOURCE_ENDOWMENT)[ItemId]>][]) {
    for (const deposit of config.deposits) {
      if (deposit.day === 0 || day < deposit.day) continue;
      const sealed = reserveSealedAccount(item, deposit.day);
      const quantity = tbal(t, item, sealed);
      if (quantity <= 0) continue;
      move(t, item, sealed, reserveAvailableAccount(item), quantity);
      emit(t, ctx, { kind: "resource", severity: "info", title: `${deposit.name} enters Vesper's reserve`, detail: `${quantity.toLocaleString("en-US")} ${ITEMS[item].units} released from the world's fixed endowment. No new stock was created.`, merchantId: null });
    }
    const reserve = resourceReserve(t, item);
    if (reserve.total <= 0 || reserve.legacy) continue;
    const previous = t.resourceLedger!.noticeBps[item] ?? 10_000;
    const current = reserve.remainingBps;
    if (previous > 0 && current <= 0) emit(t, ctx, { kind: "resource", severity: "crisis", title: `Vesper's ${ITEMS[item].name.toLowerCase()} reserve is fully allocated`, detail: `No unallocated units remain. The market can only trade resources already held by merchants and players.`, merchantId: null });
    else if (previous > 1_000 && current <= 1_000) emit(t, ctx, { kind: "resource", severity: "crisis", title: `Vesper's ${ITEMS[item].name.toLowerCase()} is nearly exhausted`, detail: `${reserve.remaining.toLocaleString("en-US")} ${ITEMS[item].units} remain in the sealed and market-ready reserve.`, merchantId: null });
    else if (previous > 2_500 && current <= 2_500) emit(t, ctx, { kind: "resource", severity: "warn", title: `${ITEMS[item].name} reserve falls below a quarter`, detail: `Only ${reserve.remaining.toLocaleString("en-US")} ${ITEMS[item].units} remain unreleased. Prices and supplier stock now reflect the tighter world supply.`, merchantId: null });
    t.resourceLedger!.noticeBps[item] = Math.min(previous, current);
  }
}

function flows(t: TownState, m: MerchantConfig, it: MerchantItemConfig): void {
  const acct = MACC(m.merchantId);
  const ref = refOf(t, m.merchantId, it.item);
  const stock = tbal(t, it.item, acct);
  // imports when short, at 92% of the outside price, as far as cash allows
  if (it.importPerDay > 0 && stock < it.target) {
    let q = perTick(t, it.importPerDay);
    if (it.item === "material:steel") q = Math.round((q * t.steelSupplyBps) / 10_000);
    q = Math.round(q * newsMult(t, m.merchantId, it.item, "imports"));
    const unit = Math.round(ref * 0.92);
    // a merchant keeps a day of costs in reserve: it won't spend the rent on stock
    q = Math.min(q, it.target - stock, Math.floor(Math.max(0, tbal(t, "cc", acct) - m.fixedCcPerDay) / Math.max(1, unit)));
    if (RESOURCE_ENDOWMENT[it.item]) q = Math.min(q, tbal(t, it.item, reserveAvailableAccount(it.item)));
    if (q > 0) {
      move(t, "cc", acct, "ext:imports", q * unit);
      const finite = RESOURCE_ENDOWMENT[it.item] !== undefined;
      move(t, it.item, finite ? reserveAvailableAccount(it.item) : "ext:imports", acct, q);
    }
  }
  const qte = quote(t, m.merchantId, it.item);
  // outside customers buy less when it's dear
  if (it.sells && it.npcDemandPerDay > 0) {
    const elastic = Math.max(0.2, Math.min(2, Math.pow(ref / Math.max(1, qte.askCc), 1.5)));
    const q = Math.min(Math.round(perTick(t, it.npcDemandPerDay) * elastic * newsMult(t, m.merchantId, it.item, "demand")), tbal(t, it.item, acct));
    if (q > 0) {
      move(t, it.item, acct, "ext:npc", q);
      move(t, "cc", "ext:npc", acct, q * qte.askCc);
    }
  }
  // outside producers sell more when the merchant pays well
  if (it.buys && it.npcSupplyPerDay > 0) {
    const room = it.target * WAREHOUSE_FULL_X - tbal(t, it.item, acct);
    const elastic = Math.max(0.2, Math.min(2, qte.bidCc / Math.max(1, ref)));
    const q = Math.min(Math.round(perTick(t, it.npcSupplyPerDay) * elastic * newsMult(t, m.merchantId, it.item, "supply")), room, Math.floor(tbal(t, "cc", acct) / Math.max(1, qte.bidCc)));
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

/* ------------------------------------------------------------------------------------------------- firms' needs */

function cheapestGas(t: TownState): { merchantId: string; askCc: number } | null {
  const id = bestMerchant(t, GAS_ID, "buy", 1);
  return id ? { merchantId: id, askCc: quote(t, id, GAS_ID).askCc } : null;
}

/** An NPC company buys gas at Vesper Market from its own wallet, like any customer, and burns it. */
function firmBuysGas(t: TownState, ctx: TCtx, firmId: string, qty: number): number {
  let got = 0;
  for (let tries = 0; tries < 4 && got < qty; tries++) {
    const want = qty - got;
    const id = bestMerchant(t, GAS_ID, "buy", 1);
    if (!id) break;
    const m = CFG[id];
    const stock = tbal(t, GAS_ID, MACC(id));
    const lim = rationLimit({ traits: m.traits, stock, target: m.items.find((x) => x.item === GAS_ID)!.target }) ?? stock;
    const q = Math.min(want, stock, lim);
    if (q <= 0) break;
    try {
      townTrade(t, ctx, { playerId: `firm:${firmId}`, name: FIRM(firmId).name, kind: "npc", merchantId: id, item: GAS_ID, side: "buy", quantity: q, account: FACC(firmId) });
    } catch {
      break;
    }
    move(t, GAS_ID, FACC(firmId), "ext:burned", q);
    got += q;
  }
  return got;
}

const GAS_ID = "fuel:natural-gas" as const;
/** Cloud cover the sky drifts towards: fair weather, unless a story in the news says otherwise. */
function cloudTarget(t: TownState): number {
  let c = 30 + 15 * Math.sin((t.tick / TICKS_PER_DAY) * Math.PI * 2);
  for (const n of t.news ?? []) {
    const story = storyById(n.storyId);
    if (story?.cloudPct !== undefined) c = story.cloudPct;
  }
  return Math.round(c);
}

/* ------------------------------------------------------------------------------------------------- epochs */

const CHAIN: Record<string, string> = { ...Object.fromEntries(MERCHANTS.map((m) => [MACC(m.merchantId), m.chainName])), ...Object.fromEntries(FIRMS.map((f) => [FACC(f.firmId), f.chainName])) };

/**
 * Which on-chain identity holds a ledger account: each merchant and company its own wallet, each player
 * `player:<id>` (their wallet, once they have one), and everything outside Vesper (importers, outside customers,
 * owners, costs) the outside world.
 */
export function townIdentity(acct: string): string {
  if (CHAIN[acct]) return CHAIN[acct];
  if (acct.startsWith("ext:player:")) return `player:${acct.slice(11)}`;
  return "world";
}

function identityTotals(b: Record<string, Record<string, number>>): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [asset, book] of Object.entries(b)) {
    const o = (out[asset] = {} as Record<string, number>);
    for (const [acct, v] of Object.entries(book)) {
      const id = townIdentity(acct);
      o[id] = (o[id] ?? 0) + v;
    }
  }
  return out;
}

const TOKEN: Record<string, string> = { cc: "credit:vesper" };

function maybeCloseTownEpoch(t: TownState, force = false): void {
  if (!force && t.tick - t.epochStart.tick < EPOCH_TICKS) return;
  if (force && t.tick === t.epochStart.tick) return;
  const before = identityTotals(t.epochStart.balances);
  const after = identityTotals(t.balances);
  // flows already settled directly on chain (escrowed power payments) are left out, so nothing settles twice
  const already = t.direct ?? {};
  const tokens = Object.keys(after)
    .sort()
    .map((asset) => {
      const ids = [...new Set([...Object.keys(before[asset] ?? {}), ...Object.keys(after[asset])])].sort();
      return { token: TOKEN[asset] ?? asset, transfers: ids.map((account) => ({ account, delta: (after[asset][account] ?? 0) - (before[asset]?.[account] ?? 0) - (already[asset]?.[account] ?? 0) })).filter((x) => x.delta !== 0) };
    })
    .filter((x) => x.transfers.length);
  const epochNo = (t.epochs.at(-1)?.epochNo ?? 0) + 1;
  const body = { epochId: `town:${epochNo}`, fromTick: t.epochStart.tick, toTick: t.tick, tokens };
  t.epochs.push({ epochNo, ...body, hash: sha256(canonical(body)) });
  if (t.epochs.length > 24) t.epochs.splice(0, t.epochs.length - 24);
  t.epochStart = { tick: t.tick, balances: JSON.parse(JSON.stringify(t.balances)) };
  t.direct = {};
}

/** Closes an epoch now (a wallet opening or chain activation needs a clean boundary). Returns the boundary tick. */
export function forceCloseTownEpoch(t: TownState): number {
  maybeCloseTownEpoch(t, true);
  return t.epochStart.tick;
}

export function verifyTownEpoch(e: TownEpoch): boolean {
  const { hash, epochNo, ...body } = e;
  void epochNo;
  return sha256(canonical(body)) === hash && e.tokens.every((tk) => tk.transfers.reduce((a, x) => a + x.delta, 0) === 0);
}

/* --------------------------------------------------------------------------------------------------- view */

function firmsView(t: TownState, viewer: string | null): TownView["companies"] {
  if (!t.firms || !t.power) return undefined;
  const me = viewer ? `player:${viewer}` : null;
  const sun = sunBps(minuteOfDay(t.tick), t.sky?.cloudPct ?? 30);
  return {
    cloudPct: t.sky?.cloudPct ?? 30,
    sunBps: sun,
    windowTicksLeft: WINDOW_TICKS - (t.tick % WINDOW_TICKS),
    firms: FIRMS.map((f) => {
      const st = t.firms![f.firmId];
      return { firmId: f.firmId, name: f.name, person: f.person, face: f.face, kind: f.kind, blurb: f.blurb, open: st.open, cashCc: tbal(t, "cc", FACC(f.firmId)), escrowedCc: st.escrowedCc, spendableCc: spendable(t, f.firmId), profitCcToday: tbal(t, "cc", FACC(f.firmId)) - st.cashAtDayStart, revenueCcToday: st.revenueCcToday, boughtKwh: st.boughtKwh, soldKwh: st.soldKwh, productionBps: st.productionBps, lastWhy: st.lastWhy, chainAccount: null };
    }),
    offers: t.power.offers.map((o) => ({ ...o, mine: o.sellerKey === me })),
    orders: t.power.orders.slice(-24).map((o) => ({ orderId: o.orderId, buyerId: o.buyerId, buyerName: o.buyerName, sellerName: me && o.sellerKey === me ? "You" : o.sellerName, mine: o.sellerKey === me, kw: o.kw, kwh: o.kwh, priceCcPerMWh: o.priceCcPerMWh, escrowCc: o.escrowCc, status: o.status, deliveredKwh: o.deliveredKwh, paidCc: o.paidCc, refundCc: o.refundCc, why: o.why, startTick: o.startTick, endTick: o.endTick, failReason: o.failReason })),
  };
}

export function townClock(tick: number): string {
  const day = Math.floor(tick / TICKS_PER_DAY) + 1;
  const m = (tick % TICKS_PER_DAY) * 5;
  return `Market day ${day} · ${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function toTownView(t: TownState, viewer: string | null): TownView {
  ensureTownResources(t);
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
          referenceCc: refOf(t, m.merchantId, it.item),
          why: q.why,
          askAnHourAgoCc: h.length ? h[h.length - 1] : null,
          history: h,
        };
      }),
      investors: st.investors.map((x) => ({ playerId: x.playerId, name: x.name, investedCc: x.investedCc, shareBps: Math.round((x.investedCc * 10_000) / Math.max(1, total)), mine: x.playerId === viewer })),
      closedReason: st.closedReason,
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
    players: Object.keys(t.names).filter((k) => !k.startsWith("bot:") && !k.startsWith("firm:") && k !== "vesper-holdings").length,
    you: viewer ? { investedCc: invested, dividendsCcTotal: t.dividendsTotal[viewer] ?? 0, pendingCc: t.owed[viewer] ?? 0 } : null,
    steelSupplyBps: t.steelSupplyBps,
    reserves: (Object.keys(RESOURCE_ENDOWMENT) as ItemId[]).map((item) => ({ item, ...resourceReserve(t, item) })),
    companies: firmsView(t, viewer),
    news: (t.news ?? []).map((n) => {
      const story = storyById(n.storyId)!;
      return { seq: n.seq, headline: story.headline, detail: story.detail, tone: story.tone, items: [...new Set(story.effects.map((e) => e.item))], merchantIds: [...new Set(story.effects.flatMap((e) => e.merchants ?? MERCHANTS.filter((m) => m.items.some((i) => i.item === e.item)).map((m) => m.merchantId)))], effects: story.effects.map(effectLabel), ticksLeft: n.until - t.tick, ageTicks: t.tick - n.from };
    }),
  };
}
