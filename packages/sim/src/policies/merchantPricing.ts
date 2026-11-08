/**
 * ============================================================================
 *  MERCHANT PRICING POLICY — the single authoritative, readable pricing file.
 *  Every fuel merchant (and the rival when it estimates fuel costs) imports
 *  this module. The UI's "Explain price" tooltip shows exactly the `reasons`
 *  object returned below; nothing else influences a merchant's price.
 * ============================================================================
 *
 *  Inputs (all integers):
 *    oilIndexCenti        today's oil index x100 (scenario input; 10000 = 100.00)
 *    referenceIndexCenti  10000
 *    baseReferenceCcPerL  1000 cc (10 credits) per litre at the reference index
 *    availableMl          stock the merchant is willing to sell (stock - reserve floor)
 *    targetStockMl        stock the merchant wants to hold
 *    lastDaySalesMl       litres sold yesterday
 *    baselineSalesMl      "normal" daily sales for this merchant
 *    trend                oil today vs yesterday: up / down / flat
 *    logisticsCostBps     World Events: shipping/refinery premium on import cost (0 when oil prices are historical)
 *    cautionBps           World Events: extra safety stock the merchant wants to hold (raises its effective target)
 *
 *  Formula:
 *    baseReplacement = baseReferenceCcPerL * oilIndex / referenceIndex * (1 + logistics)   (= importer cost per L)
 *    target'         = target * (1 + caution)
 *    scarcity        = clamp((target' - available) / target', -1, +1)
 *    demandDelta     = clamp((lastDaySales - baselineSales) / max(1, baselineSales), -1, +1)
 *    multiplier      = 1 + scarcityWeight*scarcity + demandWeight*demandDelta + markup (+ hoardPremium if trend up)
 *    raw             = baseReplacement * multiplier
 *    final           = round10(clamp(raw, floor, max))
 *        floor = baseReplacement * (1 + minMargin)   -> a merchant never sells below import cost
 *        max   = baseReplacement * maxMultiple
 *
 *  Rationing: if the policy hoards on a rising trend and stock is below target,
 *  a single trade is limited to `rationShareBps` of available stock.
 *
 *  Prices go DOWN when stock is above target (negative scarcity) or yesterday's
 *  sales were below baseline, and when the oil index falls. They go UP on the
 *  opposite. There is no hard-coded upward drift.
 */
import type { PriceReasons, Trend } from "@blackout/shared";

export interface MerchantPolicyParams {
  policyId: "efficient_wholesaler" | "low_stock_boutique" | "reserve_cooperative";
  scarcityWeightBps: number; // suggested 4500 (= 0.45)
  demandWeightBps: number; // suggested 2000 (= 0.20)
  markupBps: number;
  minMarginBps: number;
  maxMultipleBps: number;
  hoardPremiumBps: number; // extra markup on rising oil (0 = never hoards)
  rationShareBps: number | null; // per-trade cap on rising oil, share of available stock
  /** Restock behaviour: reorder when stock+pending falls below this share of target. */
  reorderPointBps: number;
  /** Defer restocking while oil is falling (wait for cheaper imports) if stock above this share. */
  deferOnFallingAboveBps: number | null;
}

/** Bounded per-seller variations of the one formula. */
export const MERCHANT_POLICIES: Record<MerchantPolicyParams["policyId"], MerchantPolicyParams> = {
  efficient_wholesaler: {
    policyId: "efficient_wholesaler",
    scarcityWeightBps: 4_500,
    demandWeightBps: 2_000,
    markupBps: 200,
    minMarginBps: 0, // will sell surplus at import cost
    maxMultipleBps: 30_000,
    hoardPremiumBps: 0,
    rationShareBps: null,
    reorderPointBps: 6_000,
    deferOnFallingAboveBps: 4_000,
  },
  low_stock_boutique: {
    policyId: "low_stock_boutique",
    scarcityWeightBps: 6_000, // very sensitive to its own stock
    demandWeightBps: 2_000,
    markupBps: 400,
    minMarginBps: 100,
    maxMultipleBps: 30_000,
    hoardPremiumBps: 0,
    rationShareBps: null,
    reorderPointBps: 7_000,
    deferOnFallingAboveBps: null,
  },
  reserve_cooperative: {
    policyId: "reserve_cooperative",
    scarcityWeightBps: 4_500,
    demandWeightBps: 2_000,
    markupBps: 800,
    minMarginBps: 500,
    maxMultipleBps: 30_000,
    hoardPremiumBps: 1_000, // hoards when oil trends up
    rationShareBps: 2_500, // and sells at most 25% of available per trade
    reorderPointBps: 8_000,
    deferOnFallingAboveBps: null,
  },
};

export interface PriceInputs {
  policy: MerchantPolicyParams;
  oilIndexCenti: number;
  referenceIndexCenti: number;
  baseReferenceCcPerL: number;
  stockMl: number;
  reserveFloorMl: number;
  targetStockMl: number;
  lastDaySalesMl: number;
  baselineSalesMl: number;
  trend: Trend;
  /** World Events inputs (bounded upstream; default 0). */
  logisticsCostBps?: number;
  cautionBps?: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export const trendOf = (today: number, yesterday: number): Trend => (today > yesterday ? "up" : today < yesterday ? "down" : "flat");

/** Pure: same inputs always give the same price and the same reasons. */
export function computeMerchantPrice(i: PriceInputs): PriceReasons {
  const p = i.policy;
  const logistics = i.logisticsCostBps ?? 0;
  const caution = i.cautionBps ?? 0;
  const baseReplacement = Math.round((((i.baseReferenceCcPerL * i.oilIndexCenti) / i.referenceIndexCenti) * (10_000 + logistics)) / 10_000);
  const availableMl = Math.max(0, i.stockMl - i.reserveFloorMl);
  const cautiousTarget = Math.round((i.targetStockMl * (10_000 + caution)) / 10_000);
  const sellableTarget = Math.max(1, cautiousTarget - i.reserveFloorMl);
  const scarcityBps = clamp(Math.trunc(((sellableTarget - availableMl) * 10_000) / sellableTarget), -10_000, 10_000);
  const demandDeltaBps = clamp(
    Math.trunc(((i.lastDaySalesMl - i.baselineSalesMl) * 10_000) / Math.max(1, i.baselineSalesMl)),
    -10_000,
    10_000,
  );
  const hoarding = p.hoardPremiumBps > 0 && i.trend === "up" && availableMl < sellableTarget;
  const markupBps = p.markupBps + (hoarding ? p.hoardPremiumBps : 0);
  const multiplierBps =
    10_000 +
    Math.trunc((p.scarcityWeightBps * scarcityBps) / 10_000) +
    Math.trunc((p.demandWeightBps * demandDeltaBps) / 10_000) +
    markupBps;
  const rawPrice = Math.trunc((baseReplacement * multiplierBps) / 10_000);
  const floor = Math.ceil((baseReplacement * (10_000 + p.minMarginBps)) / 10_000);
  const max = Math.trunc((baseReplacement * p.maxMultipleBps) / 10_000);
  const clamped = clamp(rawPrice, floor, max);
  const finalPrice = Math.max(floor, Math.round(clamped / 10) * 10);
  const rationLimitMl =
    hoarding && p.rationShareBps !== null ? Math.floor((availableMl * p.rationShareBps) / 10_000 / 1000) * 1000 : null;

  const pct = (bps: number) => `${bps >= 0 ? "+" : ""}${(bps / 100).toFixed(1)}%`;
  const explanation =
    `Import cost ${(baseReplacement / 100).toFixed(2)}/L (oil ${(i.oilIndexCenti / 100).toFixed(2)} vs ref ${(i.referenceIndexCenti / 100).toFixed(2)}${logistics ? `, shipping/refinery premium ${pct(logistics)} from world events` : ""}). ` +
    `Stock ${(availableMl / 1000).toFixed(1)} L sellable vs target ${(sellableTarget / 1000).toFixed(1)} L${caution ? ` (incl. ${pct(caution)} extra safety stock: world events)` : ""} → scarcity ${pct(scarcityBps)} × ${(p.scarcityWeightBps / 10_000).toFixed(2)}. ` +
    `Yesterday sold ${(i.lastDaySalesMl / 1000).toFixed(1)} L vs normal ${(i.baselineSalesMl / 1000).toFixed(1)} L → demand ${pct(demandDeltaBps)} × ${(p.demandWeightBps / 10_000).toFixed(2)}. ` +
    `Markup ${pct(markupBps)}${hoarding ? " (incl. hoarding premium: oil rising)" : ""}. ` +
    `Raw ${(rawPrice / 100).toFixed(2)} clamped to [${(floor / 100).toFixed(2)}, ${(max / 100).toFixed(2)}] → ${(finalPrice / 100).toFixed(2)} credits/L.` +
    (rationLimitMl !== null ? ` Rationing: max ${(rationLimitMl / 1000).toFixed(0)} L per trade.` : "");

  return {
    oilIndexCenti: i.oilIndexCenti,
    referenceIndexCenti: i.referenceIndexCenti,
    baseReferenceCcPerL: i.baseReferenceCcPerL,
    baseReplacementCcPerL: baseReplacement,
    scarcityBps,
    demandDeltaBps,
    markupBps,
    rawPriceCcPerL: rawPrice,
    floorCcPerL: floor,
    maxCcPerL: max,
    finalPriceCcPerL: finalPrice,
    stockMl: i.stockMl,
    targetStockMl: i.targetStockMl,
    lastDaySalesMl: i.lastDaySalesMl,
    baselineSalesMl: i.baselineSalesMl,
    trend: i.trend,
    rationLimitMl,
    explanation,
  };
}

/** Importer cost per litre (what a merchant pays to restock). Same as baseReplacement. */
export const importCostCcPerL = (baseReferenceCcPerL: number, oilIndexCenti: number, referenceIndexCenti: number, logisticsCostBps = 0): number =>
  Math.round((((baseReferenceCcPerL * oilIndexCenti) / referenceIndexCenti) * (10_000 + logisticsCostBps)) / 10_000);
