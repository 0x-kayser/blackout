/**
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
 *  HOW VESPER'S NPC COMPANIES DECIDE TO BUY AND SELL ELECTRICITY — every rule, in one file.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Every power window (36 ticks = 3 market hours, about 36 real seconds) each company looks at what it can see —
 * its own cash, its own needs, the weather, the price of gas at Vesper Market, and the offers on the power desk —
 * and decides. Nobody sees another company's strategy, only its posted offer.
 *
 *   Halvard Aluminium (a smelter)
 *     needs        its potlines draw a steady load; every MWh it gets becomes aluminium it sells outside Vesper.
 *     pays up to   85% of what a MWh of aluminium is worth (it keeps a margin or it stops).
 *     can afford   its cash, minus power it has already paid into escrow, minus one day of fixed costs it won't touch.
 *     buys         the cheapest offers first until its need is met, its price limit is reached, or its money runs out.
 *                  Whatever it can't buy, it doesn't produce.
 *
 *   Solara Energy (a solar company)
 *     promised     a steady supply to the Vesper water utility, paid by the kWh, with a penalty for every kWh short.
 *     expects      its panels to keep doing what they're doing now (sun × cloud), for the next window.
 *     buys         the gap between what it promised and what its panels will make, from the cheapest offers, as long
 *                  as buying costs less than the contract price plus the penalty it would otherwise pay.
 *
 *   Northwind Gas Power (a gas plant)
 *     offers       its capacity at  gas price × heat rate × (1 + margin) + running costs,
 *                  where the gas price is the cheapest open ask at Vesper Market right now.
 *     limited by   the gas it can afford to buy: it buys the fuel for every MWh it sells, from the merchants, at
 *                  their price, before it delivers.
 *
 *   Players' companies offer their spare capacity at their own ask (region.ts works it out from their plants).
 *
 * Every decision comes back with the numbers it used, written out, so the game can show exactly why a company did
 * what it did. Nothing here invents a payment: buyers can only spend what they have, and only through escrow.
 */

export interface PowerOffer {
  /** "player:<userId>" or "firm:<firmId>" */
  sellerKey: string;
  sellerName: string;
  kw: number;
  priceCcPerMWh: number;
  /** Why the seller asks what it asks (shown in the desk). */
  why: string;
}

export interface BuyPlan {
  lots: { offer: PowerOffer; kw: number }[];
  why: string;
}

const money = (cc: number) => `₡${Math.round(cc / 100).toLocaleString("en-US")}`;
const mw = (kw: number) => `${(kw / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 })} MW`;
export const WINDOW_TICKS = 36;
export const WINDOW_HOURS = (WINDOW_TICKS * 5) / 60;
/** What a window's worth of `kw` costs at `price` (cc per MWh), rounded up the way the contract escrows it. */
export const escrowCc = (kw: number, priceCcPerMWh: number) => Math.ceil((Math.round(kw * WINDOW_HOURS) * priceCcPerMWh) / 1000);

/** Fill `needKw` from the cheapest offers at or under `maxPrice`, within `budgetCc`. */
function fill(needKw: number, maxPrice: number, budgetCc: number, offers: PowerOffer[], selfKey: string): { lots: BuyPlan["lots"]; spent: number; stoppedBy: "need" | "price" | "money" | "offers" } {
  const lots: BuyPlan["lots"] = [];
  let left = needKw;
  let budget = budgetCc;
  let spent = 0;
  const sorted = offers.filter((o) => o.sellerKey !== selfKey && o.kw > 0).sort((a, b) => a.priceCcPerMWh - b.priceCcPerMWh || a.sellerKey.localeCompare(b.sellerKey));
  for (const o of sorted) {
    if (left <= 0) return { lots, spent, stoppedBy: "need" };
    if (o.priceCcPerMWh > maxPrice) return { lots, spent, stoppedBy: "price" };
    const affordableKw = Math.floor((budget * 1000) / Math.max(1, o.priceCcPerMWh * WINDOW_HOURS));
    const kw = Math.min(left, o.kw, affordableKw);
    // contracts come in whole hundreds of kW
    const lotKw = Math.floor(kw / 100) * 100;
    if (lotKw <= 0) return { lots, spent, stoppedBy: "money" };
    const cost = escrowCc(lotKw, o.priceCcPerMWh);
    lots.push({ offer: o, kw: lotKw });
    left -= lotKw;
    budget -= cost;
    spent += cost;
    if (lotKw < Math.min(left + lotKw, o.kw)) return { lots, spent, stoppedBy: "money" };
  }
  return { lots, spent, stoppedBy: left <= 0 ? "need" : "offers" };
}

function describe(lots: BuyPlan["lots"]): string {
  if (!lots.length) return "";
  return lots.map((l) => `${mw(l.kw)} from ${l.offer.sellerName} at ${money(l.offer.priceCcPerMWh)}/MWh`).join(", ");
}

/** Halvard Aluminium. */
export function smelterPlan(p: { needKw: number; valueCcPerMWh: number; spendableCc: number; offers: PowerOffer[]; selfKey: string }): BuyPlan {
  const maxPrice = Math.floor(p.valueCcPerMWh * 0.85);
  const f = fill(p.needKw, maxPrice, p.spendableCc, p.offers, p.selfKey);
  const head = `Needs ${mw(p.needKw)} for its potlines. A MWh of power makes ${money(p.valueCcPerMWh)} of aluminium, so it pays up to ${money(maxPrice)}/MWh; it can spend ${money(p.spendableCc)}.`;
  const got = f.lots.reduce((a, l) => a + l.kw, 0);
  const tail =
    f.lots.length === 0
      ? f.stoppedBy === "price"
        ? " Every offer is above its limit, so it's idling the potlines."
        : f.stoppedBy === "money"
          ? " It can't afford any of it, so it's idling the potlines."
          : " Nobody is offering power, so it's idling the potlines."
      : ` Bought ${describe(f.lots)}.${got < p.needKw ? ` The other ${mw(p.needKw - got)} goes unpowered: ${f.stoppedBy === "price" ? "the rest is too dear" : f.stoppedBy === "money" ? "it ran out of money" : "nobody offered more"}.` : ""}`;
  return { lots: f.lots, why: head + tail };
}

/** Solara Energy. */
export function solarPlan(p: { solarKw: number; sunBps: number; commitKw: number; contractCcPerMWh: number; penaltyBps: number; spendableCc: number; offers: PowerOffer[]; selfKey: string; cloudPct: number; daylight: boolean }): BuyPlan {
  const expectKw = Math.round((p.solarKw * p.sunBps) / 10_000);
  const gap = Math.max(0, p.commitKw - expectKw);
  const maxPrice = Math.floor(p.contractCcPerMWh * (1 + p.penaltyBps / 10_000));
  const sky = !p.daylight ? "It's dark" : p.cloudPct >= 60 ? `Clouds at ${p.cloudPct}%` : `Sun with ${p.cloudPct}% cloud`;
  const head = `${sky}: its panels make about ${mw(expectKw)} (${Math.round(p.sunBps / 100)}% of ${mw(p.solarKw)}). It promised the water utility ${mw(p.commitKw)}.`;
  if (gap < 100) return { lots: [], why: `${head} Its own panels cover it; no backup needed.` };
  const f = fill(gap, maxPrice, p.spendableCc, p.offers, p.selfKey);
  const got = f.lots.reduce((a, l) => a + l.kw, 0);
  const tail = f.lots.length
    ? ` Short ${mw(gap)}: buying ${describe(f.lots)}, cheaper than the ${money(maxPrice)}/MWh a missed kWh costs it.${got < gap ? ` ${mw(gap - got)} stays short.` : ""}`
    : ` Short ${mw(gap)}, but ${f.stoppedBy === "price" ? "every offer costs more than the penalty, so it takes the penalty" : f.stoppedBy === "money" ? "it can't afford backup" : "nobody is offering"}.`;
  return { lots: f.lots, why: head + tail };
}

/** Northwind Gas Power's offer for the next window. */
export function gasOffer(p: { capacityKw: number; heatRate: number; gasAskCc: number | null; marginBps: number; vomCcPerMWh: number; spendableCc: number; name: string; key: string }): PowerOffer | null {
  if (p.gasAskCc === null) return null;
  const fuelPerMWh = Math.round(p.heatRate * p.gasAskCc);
  const price = Math.round(fuelPerMWh * (1 + p.marginBps / 10_000) + p.vomCcPerMWh);
  // it must buy the gas before it can sell the power
  const affordKw = Math.floor((p.spendableCc * 1000) / Math.max(1, fuelPerMWh * WINDOW_HOURS));
  const kw = Math.floor(Math.min(p.capacityKw, affordKw) / 100) * 100;
  if (kw <= 0) return null;
  return { sellerKey: p.key, sellerName: p.name, kw, priceCcPerMWh: price, why: `Gas at ${money(p.gasAskCc)}/MMBtu × ${p.heatRate} MMBtu/MWh = ${money(fuelPerMWh)}/MWh of fuel, plus ${Math.round(p.marginBps / 100)}% margin and running costs.` };
}

/** The sun right now: 0 at night, a smooth arc by day, cut by cloud. */
export function sunBps(minuteOfDay: number, cloudPct: number): number {
  const h = minuteOfDay / 60;
  if (h < 6 || h > 18) return 0;
  const arc = Math.sin(((h - 6) / 12) * Math.PI);
  return Math.round(10_000 * arc * (1 - 0.75 * (cloudPct / 100)));
}
