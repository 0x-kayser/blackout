/**
 * Vesper's NPC companies and the power desk where they buy electricity.
 *
 * Three companies share the market with the players: a smelter (Halvard Aluminium), a solar company (Solara Energy)
 * and a gas plant (Northwind Gas Power). Each has its own wallet in the town ledger (and its own NEAR account on
 * testnet), real costs, and real customers outside Vesper. Every power window they decide what to buy or offer
 * (firmPolicy.ts), and the decisions become power orders:
 *
 *   placing → open      the buyer has paid the full price into escrow (on NEAR: `power_order_place`, signed by the
 *                       buyer's own key; locally: at once)
 *   open → awaiting     the window has run; the seller's grid measured what it actually delivered
 *   awaiting → settled  the grid operator confirmed delivery: the seller is paid for what arrived, the buyer gets the
 *                       rest back (`power_order_confirm`). Only now does the money move in the ledger.
 *   placing → failed    the escrow never happened (no money, a limit, a switch, the chain refused): nothing moves
 *   open → expired      nobody confirmed in time: the buyer is refunded in full
 *
 * Money only moves when an order settles, and only from the buyer to the seller. Producing electricity creates no
 * money; a company earns only when a named counterparty pays it: a power buyer, the water utility, or the outside
 * buyers of aluminium.
 */
import type { TownEvent } from "@blackout/shared";
import { SimError } from "../state.ts";
import { WINDOW_TICKS, escrowCc, gasOffer, smelterPlan, solarPlan, sunBps, type PowerOffer } from "./firmPolicy.ts";
import { TICKS_PER_DAY } from "./config.ts";
import type { TCtx, TownState } from "./engine.ts";

export interface FirmConfig {
  firmId: string;
  name: string;
  person: string;
  face: string;
  chainName: string;
  kind: "smelter" | "solar" | "gas";
  blurb: string;
  cashCc: number;
  fixedCcPerDay: number;
  needKw?: number;
  valueCcPerMWh?: number;
  solarKw?: number;
  commitKw?: number;
  contractCcPerMWh?: number;
  penaltyBps?: number;
  capacityKw?: number;
  heatRate?: number;
  marginBps?: number;
  vomCcPerMWh?: number;
}

export const FIRMS: readonly FirmConfig[] = [
  { firmId: "halvard", name: "Halvard Aluminium", person: "Sigrun Halvard", face: "👩🏼‍🏭", chainName: "halvard", kind: "smelter", blurb: "A smelter: every MWh it buys becomes aluminium it sells outside Vesper.", cashCc: 40_000_000, fixedCcPerDay: 4_000_000, needKw: 30_000, valueCcPerMWh: 14_000 },
  { firmId: "solara", name: "Solara Energy", person: "Kwame Asante", face: "👨🏿‍💼", chainName: "solara", kind: "solar", blurb: "40 MW of solar with a promise to keep the water utility's pumps running.", cashCc: 25_000_000, fixedCcPerDay: 1_500_000, solarKw: 40_000, commitKw: 20_000, contractCcPerMWh: 11_000, penaltyBps: 5_000 },
  { firmId: "northwind", name: "Northwind Gas Power", person: "Callum Reid", face: "🧔🏻", chainName: "northwind", kind: "gas", blurb: "25 MW of gas turbines; buys its gas at Vesper Market.", cashCc: 30_000_000, fixedCcPerDay: 900_000, capacityKw: 25_000, heatRate: 9, marginBps: 3_500, vomCcPerMWh: 300 },
];
export const FIRM = (id: string) => FIRMS.find((f) => f.firmId === id)!;
export const FACC = (id: string) => `firm:${id}`;
const GAS = "fuel:natural-gas" as const;
/** Player offers are capped so one company can't swamp the desk. */
export const MAX_PLAYER_OFFER_KW = 30_000;
/** Orders that wait longer than this for confirmation expire (in ticks after their window). */
export const CONFIRM_DEADLINE_TICKS = 900;

export interface FirmState {
  open: boolean;
  closedSince: number;
  escrowedCc: number;
  solarKwhWindow: number;
  productionBps: number;
  lastWhy: string;
  boughtKwh: number;
  soldKwh: number;
  revenueCcToday: number;
  cashAtDayStart: number;
}

export type PowerOrderStatus = "placing" | "open" | "awaiting" | "settled" | "failed" | "expired";
export interface PowerOrderState {
  orderId: string;
  window: number;
  buyerId: string;
  buyerName: string;
  sellerKey: string;
  sellerName: string;
  kw: number;
  kwh: number;
  priceCcPerMWh: number;
  escrowCc: number;
  status: PowerOrderStatus;
  deliveredKwh: number | null;
  paidCc: number;
  refundCc: number;
  why: string;
  createdTick: number;
  startTick: number;
  endTick: number;
  failReason: string | null;
}

export interface PowerEnv {
  /** Players' offers for the next window (their spare capacity and ask). */
  offers?: PowerOffer[];
  /**
   * Local mode and fast-forward: escrow at once and settle each window as it ends, using `delivered` for players'
   * orders. Live chain mode leaves both to the server, which only settles after NEAR confirms.
   */
  autoSettle?: boolean;
  delivered?: (o: PowerOrderState) => number;
}

/* ------------------------------------------------------------------------------------------------ helpers */

function bal(t: TownState, acct: string): number {
  return t.balances.cc?.[acct] ?? 0;
}
function mv(t: TownState, from: string, to: string, amount: number, asset = "cc"): void {
  if (amount <= 0 || from === to) return;
  const book = (t.balances[asset] ??= {});
  const fb = book[from] ?? 0;
  if (!from.startsWith("ext:") && fb < amount) throw new SimError("INSUFFICIENT_CREDITS", `${from} has ${fb}, needs ${amount}`);
  book[from] = fb - amount;
  book[to] = (book[to] ?? 0) + amount;
}
const mvUpTo = (t: TownState, from: string, to: string, amount: number) => {
  const n = Math.max(0, Math.min(amount, bal(t, from)));
  mv(t, from, to, n);
  return n;
};
/** Records a credit flow already settled directly on chain (escrow), so batch epochs don't settle it twice. */
function direct(t: TownState, identity: string, delta: number): void {
  const d = ((t.direct ??= {}).cc ??= {});
  d[identity] = (d[identity] ?? 0) + delta;
}
const identityOfSeller = (key: string) => (key.startsWith("player:") ? key : FIRM(key.slice(5)).chainName);
const sellerAccount = (key: string) => (key.startsWith("player:") ? `ext:player:${key.slice(7)}` : FACC(key.slice(5)));
const cr = (cc: number) => `₡${Math.round(cc / 100).toLocaleString("en-US")}`;
const mw = (kw: number) => `${(kw / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 })} MW`;

function emitPower(t: TownState, ctx: TCtx, e: Omit<TownEvent, "seq" | "tick" | "kind">): void {
  t.eventSeq += 1;
  const ev: TownEvent = { ...e, kind: "power", seq: t.eventSeq, tick: t.tick };
  t.events.push(ev);
  if (t.events.length > 60) t.events.splice(0, t.events.length - 60);
  ctx.events.push(ev);
}

/** Creates the companies the first time a town (new or saved before they existed) needs them. */
export function ensureFirms(t: TownState): void {
  if (t.firms) return;
  t.firms = {};
  for (const f of FIRMS) {
    mv(t, "ext:owners", FACC(f.firmId), f.cashCc);
    t.firms[f.firmId] = { open: true, closedSince: -1, escrowedCc: 0, solarKwhWindow: 0, productionBps: 10_000, lastWhy: "", boughtKwh: 0, soldKwh: 0, revenueCcToday: 0, cashAtDayStart: f.cashCc };
  }
  t.power = { seq: 0, orders: [], offers: [] };
  t.sky = { cloudPct: 30 };
}

export const minuteOfDay = (tick: number) => (tick % TICKS_PER_DAY) * 5;
export const spendable = (t: TownState, firmId: string) => Math.max(0, bal(t, FACC(firmId)) - t.firms![firmId].escrowedCc - FIRM(firmId).fixedCcPerDay);

/* ------------------------------------------------------------------------------------------------ tick */

export function firmsTick(t: TownState, ctx: TCtx, env: PowerEnv, gasAsk: () => { merchantId: string; askCc: number } | null, buyGas: (firmId: string, qty: number) => number, cloudTarget: number): void {
  ensureFirms(t);
  const sky = t.sky!;
  sky.cloudPct = Math.max(0, Math.min(100, Math.round(sky.cloudPct + (cloudTarget - sky.cloudPct) * 0.08)));
  const sun = sunBps(minuteOfDay(t.tick), sky.cloudPct);
  for (const f of FIRMS) {
    const st = t.firms![f.firmId];
    const acct = FACC(f.firmId);
    if (!st.open) {
      if (t.tick - st.closedSince >= 2 * TICKS_PER_DAY) {
        mv(t, "ext:investors", acct, f.fixedCcPerDay * 3);
        st.open = true;
        emitPower(t, ctx, { severity: "good", title: `${f.name} is back in business`, detail: `Vesper Holdings put in ${cr(f.fixedCcPerDay * 3)}.`, merchantId: null, who: `firm:${f.firmId}` });
      }
      continue;
    }
    mvUpTo(t, acct, "ext:costs", Math.floor(f.fixedCcPerDay / TICKS_PER_DAY));
    if (f.kind === "solar") st.solarKwhWindow += Math.round(((f.solarKw! * sun) / 10_000) / 12);
    if (bal(t, acct) - st.escrowedCc < f.fixedCcPerDay * 0.2) {
      st.open = false;
      st.closedSince = t.tick;
      emitPower(t, ctx, { severity: "crisis", title: `${f.name} has stopped trading`, detail: `${f.person} can't cover the bills. It stays shut until someone puts money in.`, merchantId: null, who: `firm:${f.firmId}` });
    }
  }
  if (t.tick % TICKS_PER_DAY === 0) for (const f of FIRMS) {
    t.firms![f.firmId].cashAtDayStart = bal(t, FACC(f.firmId));
    t.firms![f.firmId].revenueCcToday = 0;
  }
  if (t.tick % WINDOW_TICKS !== 0) return;
  closeWindow(t, ctx, env);
  openWindow(t, ctx, env, sun, gasAsk, buyGas);
}

function closeWindow(t: TownState, ctx: TCtx, env: PowerEnv): void {
  const p = t.power!;
  // Solara's own panels: the utility pays for what they covered; a shortfall nobody was hired to fill is penalised
  const solara = FIRM("solara");
  const sst = t.firms!.solara;
  if (sst.open) {
    const commitKwh = Math.round(solara.commitKw! * ((WINDOW_TICKS * 5) / 60));
    const own = Math.min(commitKwh, sst.solarKwhWindow);
    mv(t, "ext:outside", FACC("solara"), Math.round((own * solara.contractCcPerMWh!) / 1000));
    sst.revenueCcToday += Math.round((own * solara.contractCcPerMWh!) / 1000);
    const hired = p.orders.filter((o) => o.buyerId === "solara" && o.endTick === t.tick && (o.status === "open" || o.status === "placing")).reduce((a, o) => a + o.kwh, 0);
    const uncovered = Math.max(0, commitKwh - own - hired);
    if (uncovered > 0) mvUpTo(t, FACC("solara"), "ext:outside", Math.round((uncovered * solara.contractCcPerMWh! * (solara.penaltyBps! / 10_000)) / 1000));
  }
  sst.solarKwhWindow = 0;
  for (const o of p.orders) {
    if (o.status === "open" && o.endTick <= t.tick) {
      o.status = "awaiting";
      // a company seller bought its fuel up front, so it delivers in full
      if (!o.sellerKey.startsWith("player:")) o.deliveredKwh = o.kwh;
      else if (env.delivered) o.deliveredKwh = Math.max(0, Math.min(o.kwh, Math.round(env.delivered(o))));
    }
    if (o.status === "placing" && o.endTick <= t.tick) failPowerOrder(t, ctx, o.orderId, "the escrow never confirmed");
    if (o.status === "awaiting" && t.tick - o.endTick > CONFIRM_DEADLINE_TICKS) expirePowerOrder(t, ctx, o.orderId);
  }
  if (env.autoSettle ?? true) for (const o of p.orders.filter((x) => x.status === "awaiting" && x.deliveredKwh !== null)) settlePowerOrder(t, ctx, o.orderId, o.deliveredKwh!);
  if (p.orders.length > 80) p.orders = p.orders.filter((o) => o.status === "placing" || o.status === "open" || o.status === "awaiting" || t.tick - o.endTick < 6 * WINDOW_TICKS).slice(-80);
}

function openWindow(t: TownState, ctx: TCtx, env: PowerEnv, sun: number, gasAsk: () => { merchantId: string; askCc: number } | null, buyGas: (firmId: string, qty: number) => number): void {
  const p = t.power!;
  const window = t.tick / WINDOW_TICKS;
  const offers: PowerOffer[] = (env.offers ?? []).map((o) => ({ ...o, kw: Math.min(o.kw, MAX_PLAYER_OFFER_KW) }));
  const nw = FIRM("northwind");
  const g = gasAsk();
  if (t.firms!.northwind.open) {
    const o = gasOffer({ capacityKw: nw.capacityKw!, heatRate: nw.heatRate!, gasAskCc: g?.askCc ?? null, marginBps: nw.marginBps!, vomCcPerMWh: nw.vomCcPerMWh!, spendableCc: spendable(t, "northwind"), name: nw.name, key: "firm:northwind" });
    if (o) offers.push(o);
  }
  p.offers = offers;
  const remaining = new Map(offers.map((o) => [o.sellerKey, o.kw]));
  const live = () => offers.map((o) => ({ ...o, kw: remaining.get(o.sellerKey) ?? 0 }));
  // buyers take turns going first, so neither always gets the cheapest power
  const buyers = FIRMS.filter((f) => f.kind !== "gas");
  if (window % 2 === 1) buyers.reverse();
  for (const f of buyers) {
    if (!t.firms![f.firmId].open) continue;
    const st = t.firms![f.firmId];
    const plan =
      f.kind === "smelter"
        ? smelterPlan({ needKw: f.needKw!, valueCcPerMWh: f.valueCcPerMWh!, spendableCc: spendable(t, f.firmId), offers: live(), selfKey: `firm:${f.firmId}` })
        : solarPlan({ solarKw: f.solarKw!, sunBps: sun, commitKw: f.commitKw!, contractCcPerMWh: f.contractCcPerMWh!, penaltyBps: f.penaltyBps!, spendableCc: spendable(t, f.firmId), offers: live(), selfKey: `firm:${f.firmId}`, cloudPct: t.sky!.cloudPct, daylight: sun > 0 });
    st.lastWhy = plan.why;
    if (f.kind === "smelter") st.productionBps = Math.round((plan.lots.reduce((a, l) => a + l.kw, 0) * 10_000) / f.needKw!);
    for (const lot of plan.lots) {
      // the gas plant buys the fuel for what it just sold before it commits
      if (lot.offer.sellerKey === "firm:northwind") {
        const need = Math.ceil((lot.kw * (WINDOW_TICKS * 5) / 60 / 1000) * nw.heatRate!);
        const got = buyGas("northwind", need);
        if (got < need) continue;
      }
      remaining.set(lot.offer.sellerKey, (remaining.get(lot.offer.sellerKey) ?? 0) - lot.kw);
      p.seq += 1;
      const kwh = Math.round(lot.kw * ((WINDOW_TICKS * 5) / 60));
      const o: PowerOrderState = { orderId: `pw-${t.seed}-${t.tick}-${p.seq}`, window, buyerId: f.firmId, buyerName: f.name, sellerKey: lot.offer.sellerKey, sellerName: lot.offer.sellerName, kw: lot.kw, kwh, priceCcPerMWh: lot.offer.priceCcPerMWh, escrowCc: escrowCc(lot.kw, lot.offer.priceCcPerMWh), status: "placing", deliveredKwh: null, paidCc: 0, refundCc: 0, why: plan.why, createdTick: t.tick, startTick: t.tick, endTick: t.tick + WINDOW_TICKS, failReason: null };
      p.orders.push(o);
      st.escrowedCc += o.escrowCc;
      emitPower(t, ctx, { severity: "info", title: `${f.name} buys ${mw(o.kw)} from ${o.sellerName}`, detail: plan.why, merchantId: null, who: o.sellerKey });
      if (env.autoSettle ?? true) activatePowerOrder(t, ctx, o.orderId);
    }
  }
}

/* ------------------------------------------------------------------------------------------------ order transitions */

const order = (t: TownState, id: string) => t.power?.orders.find((o) => o.orderId === id) ?? null;

/** The escrow is in place: the seller must now deliver. */
export function activatePowerOrder(t: TownState, _ctx: TCtx, orderId: string): PowerOrderState | null {
  const o = order(t, orderId);
  if (!o || o.status !== "placing") return o;
  o.status = "open";
  return o;
}

/** The escrow never happened: release the buyer's reservation; nothing moves. */
export function failPowerOrder(t: TownState, ctx: TCtx, orderId: string, reason: string): void {
  const o = order(t, orderId);
  if (!o || o.status !== "placing") return;
  o.status = "failed";
  o.failReason = reason;
  t.firms![o.buyerId].escrowedCc -= o.escrowCc;
  emitPower(t, ctx, { severity: "warn", title: `${o.buyerName}'s order from ${o.sellerName} didn't go through`, detail: reason, merchantId: null, who: o.sellerKey });
}

/** Delivery confirmed: pay the seller for what arrived; the rest of the escrow returns to the buyer. */
export function settlePowerOrder(t: TownState, ctx: TCtx, orderId: string, deliveredKwh: number, viaEscrow = true): PowerOrderState | null {
  const o = order(t, orderId);
  if (!o || (o.status !== "awaiting" && o.status !== "open")) return o;
  const d = Math.max(0, Math.min(o.kwh, deliveredKwh));
  const pay = Math.min(o.escrowCc, Math.floor((d * o.priceCcPerMWh) / 1000));
  const buyer = FIRM(o.buyerId);
  const bst = t.firms![o.buyerId];
  bst.escrowedCc -= o.escrowCc;
  mv(t, FACC(o.buyerId), sellerAccount(o.sellerKey), pay);
  // paid through escrow on chain: market epochs leave it out; settled locally: the next epoch carries it
  if (viaEscrow) {
    direct(t, buyer.chainName, -pay);
    direct(t, identityOfSeller(o.sellerKey), pay);
  }
  o.status = "settled";
  o.deliveredKwh = d;
  o.paidCc = pay;
  o.refundCc = o.escrowCc - pay;
  bst.boughtKwh += d;
  if (!o.sellerKey.startsWith("player:")) t.firms![o.sellerKey.slice(5)].soldKwh += d;
  if (!o.sellerKey.startsWith("player:")) t.firms![o.sellerKey.slice(5)].revenueCcToday += pay;
  // what the buyer does with the power earns it money from its own customers outside Vesper
  if (buyer.kind === "smelter") {
    const sale = Math.round((d * buyer.valueCcPerMWh!) / 1000);
    mv(t, "ext:outside", FACC(o.buyerId), sale);
    bst.revenueCcToday += sale;
  } else if (buyer.kind === "solar") {
    mv(t, "ext:outside", FACC(o.buyerId), Math.round((d * buyer.contractCcPerMWh!) / 1000));
    bst.revenueCcToday += Math.round((d * buyer.contractCcPerMWh!) / 1000);
    const short = o.kwh - d;
    if (short > 0) mvUpTo(t, FACC(o.buyerId), "ext:outside", Math.round((short * buyer.contractCcPerMWh! * (buyer.penaltyBps! / 10_000)) / 1000));
  }
  emitPower(t, ctx, { severity: d > 0 ? "good" : "warn", title: `${o.sellerName} delivered ${Math.round(d / 1000).toLocaleString("en-US")} MWh to ${o.buyerName}`, detail: `Paid ${cr(pay)}${o.refundCc > 0 ? `; ${cr(o.refundCc)} back to ${o.buyerName} for what didn't arrive` : ""}.`, merchantId: null, who: o.sellerKey });
  return o;
}

/** Nobody confirmed: the buyer gets everything back. */
export function expirePowerOrder(t: TownState, ctx: TCtx, orderId: string): void {
  const o = order(t, orderId);
  if (!o || (o.status !== "awaiting" && o.status !== "open")) return;
  t.firms![o.buyerId].escrowedCc -= o.escrowCc;
  o.status = "expired";
  o.refundCc = o.escrowCc;
  emitPower(t, ctx, { severity: "warn", title: `${o.buyerName}'s order from ${o.sellerName} expired`, detail: "Delivery was never confirmed, so the buyer was refunded in full.", merchantId: null, who: o.sellerKey });
}

export { type PowerOffer } from "./firmPolicy.ts";
export const GAS_ITEM = GAS;
