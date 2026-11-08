/**
 * ============================================================================
 *  EXCHANGE TRADER POLICY: the single, readable rule file for the NPC traders
 *  on the shared Vesper Fuel Exchange. Each trader has its own Testnet account,
 *  finite on-chain diesel and a finite credit budget. Every tick it calls
 *  `decideTrader` and acts on the result; the UI tooltip shows exactly the
 *  `reasons` returned here. Nothing else influences a trader.
 * ============================================================================
 *
 *  Inputs (integers): its stock (own balance + its unsold ask), fuel already on
 *  order, spendable cash, today's import cost per litre (from the oil index), and
 *  yesterday's exchange flow (litres it sold vs bought).
 *
 *  Formula:
 *    replacement = import cost per litre
 *    scarcity    = clamp((target - (stock + onOrder)) / target, -1, +1)
 *    pressure    = clamp((soldYesterday - boughtYesterday) / baselineFlow, -1, +1)
 *    mid         = replacement * (1 + scarcityWeight*scarcity + demandWeight*pressure)
 *    ask         = max(mid * (1 + spread/2), replacement * (1 + minMargin))   never sells below cost + margin
 *    bid         = min(mid * (1 - spread/2), replacement * (1 - bidDiscount)) never pays more than it could import for
 *
 *  Constraints:
 *    - it never sells below its reserve floor (rationing: no ask when stock <= floor);
 *    - it bids only with cash above its operating reserve and only for stockroom room;
 *    - it reorders when stock + on-order falls below its reorder point, limited by cash,
 *      its daily import cap and a lead time; with no spendable cash it cannot restock
 *      and stops bidding until sales rebuild its cash.
 */

export interface TraderParams {
  traderId: string;
  name: string;
  blurb: string;
  /** The person who runs the wallet (shown in the People panel). */
  person: string;
  face: string;
  startStockMl: number;
  startCashCc: number;
  targetStockMl: number;
  reserveFloorMl: number;
  operatingReserveCc: number;
  /** Litres per day of net selling that counts as "normal" demand pressure. */
  baselineFlowMl: number;
  spreadBps: number;
  scarcityWeightBps: number;
  demandWeightBps: number;
  minMarginBps: number;
  bidDiscountBps: number;
  reorderPointBps: number;
  leadTimeTicks: number;
  maxImportPerDayMl: number;
  maxAskMl: number;
  /** Bids may fill stock up to target * (1 + overfill). */
  overfillBps: number;
  /** A new ask replaces the old one only when the price moves at least this much. */
  repriceThresholdBps: number;
}

export const EXCHANGE_TRADERS: TraderParams[] = [
  {
    traderId: "harbor_terminal",
    name: "Harbor Import Terminal",
    blurb: "The port's bulk terminal: deep tanks, thin spreads, slow ships.",
    person: "Ingrid Halvorsen",
    face: "⚓",
    startStockMl: 300_000,
    startCashCc: 600_000,
    targetStockMl: 400_000,
    reserveFloorMl: 60_000,
    operatingReserveCc: 150_000,
    baselineFlowMl: 80_000,
    spreadBps: 400,
    scarcityWeightBps: 2_500,
    demandWeightBps: 1_000,
    minMarginBps: 300,
    bidDiscountBps: 600,
    reorderPointBps: 6_000,
    leadTimeTicks: 96,
    maxImportPerDayMl: 200_000,
    maxAskMl: 120_000,
    overfillBps: 1_500,
    repriceThresholdBps: 300,
  },
  {
    traderId: "northline",
    name: "Northline Haulage",
    blurb: "Truck fleet with quick deliveries; rations hard when its yard runs low.",
    person: "Bayo Northcott",
    face: "🚚",
    startStockMl: 100_000,
    startCashCc: 200_000,
    targetStockMl: 150_000,
    reserveFloorMl: 45_000,
    operatingReserveCc: 60_000,
    baselineFlowMl: 40_000,
    spreadBps: 800,
    scarcityWeightBps: 4_500,
    demandWeightBps: 2_000,
    minMarginBps: 600,
    bidDiscountBps: 400,
    reorderPointBps: 7_000,
    leadTimeTicks: 24,
    maxImportPerDayMl: 80_000,
    maxAskMl: 40_000,
    overfillBps: 1_000,
    repriceThresholdBps: 300,
  },
  {
    traderId: "kettle",
    name: "Kettle & Sons",
    blurb: "Family reseller: buys cheap from players, sells dear in a squeeze.",
    person: "Old Man Kettle",
    face: "🫖",
    startStockMl: 40_000,
    startCashCc: 120_000,
    targetStockMl: 80_000,
    reserveFloorMl: 10_000,
    operatingReserveCc: 30_000,
    baselineFlowMl: 20_000,
    spreadBps: 1_200,
    scarcityWeightBps: 5_500,
    demandWeightBps: 2_500,
    minMarginBps: 800,
    bidDiscountBps: 200,
    reorderPointBps: 4_000,
    leadTimeTicks: 48,
    maxImportPerDayMl: 30_000,
    maxAskMl: 30_000,
    overfillBps: 4_000,
    repriceThresholdBps: 400,
  },
  {
    traderId: "swift_tankers",
    name: "Swift Tankers",
    blurb: "Small, fast and hungry: restocks in hours and undercuts whoever is slow.",
    person: "Dayo Swift",
    face: "⚡",
    startStockMl: 60_000,
    startCashCc: 150_000,
    targetStockMl: 90_000,
    reserveFloorMl: 10_000,
    operatingReserveCc: 40_000,
    baselineFlowMl: 30_000,
    spreadBps: 1_000,
    scarcityWeightBps: 3_500,
    demandWeightBps: 3_000,
    minMarginBps: 400,
    bidDiscountBps: 800,
    reorderPointBps: 8_000,
    leadTimeTicks: 12,
    maxImportPerDayMl: 40_000,
    maxAskMl: 25_000,
    overfillBps: 1_000,
    repriceThresholdBps: 200,
  },
  {
    traderId: "okafor_daughters",
    name: "Okafor & Daughters",
    blurb: "Patient hoarders: buy every dip, sell only into a squeeze.",
    person: "Chioma Okafor",
    face: "👩🏿‍💼",
    startStockMl: 50_000,
    startCashCc: 250_000,
    targetStockMl: 120_000,
    reserveFloorMl: 20_000,
    operatingReserveCc: 60_000,
    baselineFlowMl: 25_000,
    spreadBps: 1_600,
    scarcityWeightBps: 6_000,
    demandWeightBps: 3_500,
    minMarginBps: 1_500,
    bidDiscountBps: 500,
    reorderPointBps: 3_000,
    leadTimeTicks: 72,
    maxImportPerDayMl: 25_000,
    maxAskMl: 20_000,
    overfillBps: 6_000,
    repriceThresholdBps: 500,
  },
  {
    traderId: "greenline_fund",
    name: "Greenline Fuel Fund",
    blurb: "A slow, cheap, steady fund: sells close to cost and refuses to chase spikes.",
    person: "Professor Lena Brandt",
    face: "🌿",
    startStockMl: 250_000,
    startCashCc: 500_000,
    targetStockMl: 300_000,
    reserveFloorMl: 80_000,
    operatingReserveCc: 150_000,
    baselineFlowMl: 60_000,
    spreadBps: 300,
    scarcityWeightBps: 1_500,
    demandWeightBps: 500,
    minMarginBps: 200,
    bidDiscountBps: 1_000,
    reorderPointBps: 5_000,
    leadTimeTicks: 120,
    maxImportPerDayMl: 120_000,
    maxAskMl: 80_000,
    overfillBps: 500,
    repriceThresholdBps: 400,
  },
];

export type TraderStatus = "normal" | "short" | "cash_strapped" | "overstocked";

export interface TraderInputs {
  stockMl: number;
  onOrderMl: number;
  cashCc: number;
  replacementCcPerL: number;
  soldYesterdayMl: number;
  boughtYesterdayMl: number;
  importedTodayMl: number;
}

export interface TraderReasons {
  replacementCcPerL: number;
  stockMl: number;
  onOrderMl: number;
  targetStockMl: number;
  scarcityBps: number;
  pressureBps: number;
  midCcPerL: number;
  spendableCc: number;
  roomMl: number;
}

export interface TraderDecision {
  askCcPerL: number | null;
  askQtyMl: number;
  bidCcPerL: number | null;
  bidBudgetCc: number;
  roomMl: number;
  importMl: number;
  status: TraderStatus;
  reasons: TraderReasons;
  explanation: string;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const round10 = (cc: number) => Math.max(10, Math.round(cc / 10) * 10);
const floor100 = (ml: number) => Math.max(0, Math.floor(ml / 100) * 100);
const L = (ml: number) => (ml / 1000).toFixed(1);
const cr = (cc: number) => (cc / 100).toFixed(2);

export function decideTrader(p: TraderParams, i: TraderInputs): TraderDecision {
  const replacement = i.replacementCcPerL;
  const position = i.stockMl + i.onOrderMl;
  const scarcityBps = Math.round(clamp((p.targetStockMl - position) / p.targetStockMl, -1, 1) * 10_000);
  const pressureBps = Math.round(clamp((i.soldYesterdayMl - i.boughtYesterdayMl) / Math.max(1, p.baselineFlowMl), -1, 1) * 10_000);
  const multiplierBps = 10_000 + Math.round((p.scarcityWeightBps * scarcityBps + p.demandWeightBps * pressureBps) / 10_000);
  const mid = Math.round((replacement * multiplierBps) / 10_000);

  const askFloor = Math.ceil((replacement * (10_000 + p.minMarginBps)) / 10_000);
  const ask = round10(Math.max(Math.round((mid * (10_000 + p.spreadBps / 2)) / 10_000), askFloor));
  const bidCap = Math.floor((replacement * (10_000 - p.bidDiscountBps)) / 10_000);
  const bid = round10(Math.min(Math.round((mid * (10_000 - p.spreadBps / 2)) / 10_000), bidCap));

  const sellable = floor100(i.stockMl - p.reserveFloorMl);
  const spendable = Math.max(0, i.cashCc - p.operatingReserveCc);
  const room = floor100(Math.floor((p.targetStockMl * (10_000 + p.overfillBps)) / 10_000) - position);

  let status: TraderStatus = "normal";
  if (i.stockMl <= p.reserveFloorMl) status = "short";
  else if (spendable < replacement) status = "cash_strapped";
  else if (position > p.targetStockMl * 1.5) status = "overstocked";
  const canSpend = spendable >= replacement;

  let importMl = 0;
  if (canSpend && position < (p.targetStockMl * p.reorderPointBps) / 10_000) {
    const want = p.targetStockMl - position;
    const capLeft = Math.max(0, p.maxImportPerDayMl - i.importedTodayMl);
    const affordable = Math.floor((spendable * 1000) / replacement);
    importMl = floor100(Math.min(want, capLeft, affordable));
  }

  const askQtyMl = status === "short" ? 0 : Math.min(sellable, floor100(p.maxAskMl));
  const bidOn = canSpend && room >= 100;

  const reasons: TraderReasons = {
    replacementCcPerL: replacement,
    stockMl: i.stockMl,
    onOrderMl: i.onOrderMl,
    targetStockMl: p.targetStockMl,
    scarcityBps,
    pressureBps,
    midCcPerL: mid,
    spendableCc: spendable,
    roomMl: room,
  };

  const parts = [
    `Import cost ${cr(replacement)}/L.`,
    `Stock ${L(i.stockMl)} L${i.onOrderMl ? ` + ${L(i.onOrderMl)} L on order` : ""} vs target ${L(p.targetStockMl)} L (scarcity ${(scarcityBps / 100).toFixed(0)}%).`,
    `Yesterday it sold ${L(i.soldYesterdayMl)} L and bought ${L(i.boughtYesterdayMl)} L (pressure ${(pressureBps / 100).toFixed(0)}%).`,
    askQtyMl >= 100 ? `Asks ${cr(ask)}/L for up to ${L(askQtyMl)} L.` : `Not selling: stock is at its ${L(p.reserveFloorMl)} L reserve.`,
    bidOn ? `Buys player fuel at up to ${cr(bid)}/L with ${cr(spendable)} spendable credits and ${L(room)} L of room.` : canSpend ? `Not buying: its yard is full.` : `Not buying: only ${cr(spendable)} credits above its ${cr(p.operatingReserveCc)} reserve.`,
    importMl > 0 ? `Ordering ${L(importMl)} L (arrives in ${p.leadTimeTicks} exchange ticks).` : "",
  ];

  return {
    askCcPerL: askQtyMl >= 100 ? ask : null,
    askQtyMl,
    bidCcPerL: bidOn ? bid : null,
    bidBudgetCc: bidOn ? spendable : 0,
    roomMl: Math.max(0, room),
    importMl,
    status,
    reasons,
    explanation: parts.filter(Boolean).join(" "),
  };
}
