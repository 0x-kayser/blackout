/**
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
 *  HOW EVERY MERCHANT IN VESPER MARKET SETS ITS PRICES — the whole rule, in one file.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
 *
 *   price it SELLS at (ask)  =  reference  ×  stock factor  ×  demand factor  ×  (1 + its margin)  ×  special rule
 *   price it BUYS at  (bid)  =  ask × (1 − its spread)
 *
 *   reference      What the item costs outside Vesper today (gas from Henry Hub, diesel from Brent, permits from the
 *                  carbon price; certificates ₡8, steel ₡250/t, turbine kits ₡2,500).
 *   stock factor   (target ÷ stock) ^ 0.6, kept between ×0.45 and ×2.5.
 *                  Running low → dearer. Overstocked → cheaper. Flood a merchant with iron and iron gets cheap.
 *   demand factor  1 + 0.35 × tanh(4 × recent net buying ÷ target), so between ×0.65 and ×1.35.
 *                  "Recent" decays by half every three town hours. Everyone buying → dearer; everyone selling → cheaper.
 *   margin         Each merchant's own markup (Kettle +22%, Bayo +3%, …).
 *   special rules  Chioma (a hoarder) adds 25% when another merchant of the same item is closed or below a quarter of
 *                  its stock. Bayo rations: below 20% of his target he sells at most a tenth of what's left per order.
 *
 *   A merchant only buys while it has the cash and while it holds less than 4× its target ("warehouse full").
 *   A merchant whose cash falls under a fifth of one day's fixed costs closes until someone invests (engine.ts).
 *
 * Every factor is returned as a readable line, so the game can show exactly why a price is what it is.
 */
import type { ItemId, PriceWhy } from "@blackout/shared";
import { ITEMS } from "@blackout/shared";

export interface PricingInput {
  person: string;
  traits: { hoarder?: boolean; rations?: boolean };
  item: ItemId;
  referenceCc: number;
  stock: number;
  target: number;
  recentNet: number;
  markupBps: number;
  spreadBps: number;
  /** Another merchant of this item is closed or nearly empty. */
  rivalShort: boolean;
  /** Stories in the news moving this item right now (news.ts), already reflected in stock, demand and reference. */
  news?: { label: string; factor: string }[];
}

export interface Quote {
  askCc: number;
  bidCc: number;
  why: PriceWhy;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const times = (f: number) => `×${f.toFixed(2)}`;
const cr = (cc: number) => `₡${(cc / 100).toLocaleString("en-US", { maximumFractionDigits: cc < 10_000 ? 2 : 0 })}`;

export function stockFactor(stock: number, target: number): number {
  return clamp(Math.pow(target / Math.max(1, stock), 0.6), 0.45, 2.5);
}

export function demandFactor(recentNet: number, target: number): number {
  return 1 + 0.35 * Math.tanh((4 * recentNet) / Math.max(1, target));
}

export function priceItem(p: PricingInput): Quote {
  const unit = ITEMS[p.item].unit;
  const sf = stockFactor(p.stock, p.target);
  const df = demandFactor(p.recentNet, p.target);
  const margin = 1 + p.markupBps / 10_000;
  const hoard = p.traits.hoarder && p.rivalShort ? 1.25 : 1;
  const askCc = Math.max(1, Math.round(p.referenceCc * sf * df * margin * hoard));
  const bidCc = Math.max(1, Math.round(askCc * (1 - p.spreadBps / 10_000)));

  const fill = Math.round((p.stock / Math.max(1, p.target)) * 100);
  const lines: PriceWhy["lines"] = [
    { label: `Outside price ${cr(p.referenceCc)}/${unit}`, factor: "base" },
    { label: `Stock ${p.stock.toLocaleString("en-US")} of a ${p.target.toLocaleString("en-US")} target (${fill}%)${fill < 60 ? ": running low" : fill > 140 ? ": overstocked" : ""}`, factor: times(sf) },
    {
      label:
        Math.abs(p.recentNet) < p.target * 0.02
          ? "Buying and selling have been balanced lately"
          : p.recentNet > 0
            ? `Buyers took ${Math.round(p.recentNet).toLocaleString("en-US")} more than sellers brought lately`
            : `Sellers brought ${Math.round(-p.recentNet).toLocaleString("en-US")} more than buyers took lately`,
      factor: times(df),
    },
    { label: `${p.person}'s margin`, factor: `+${Math.round(p.markupBps / 100)}%` },
  ];
  if (hoard > 1) lines.push({ label: "Another seller is short, so she charges a premium", factor: "+25%" });
  for (const n of p.news ?? []) lines.push(n);
  lines.push({ label: `Buys back ${Math.round(p.spreadBps / 100)}% under that`, factor: cr(bidCc) });

  const headline = p.news?.[0]?.label.replace(/^News: /, "");
  const summary =
    sf > 1.3 ? `${p.person} is running low, so it's dear.` : sf < 0.75 ? `${p.person} is overstocked, so it's cheap.` : df > 1.12 ? "Everyone's been buying, so the price is up." : df < 0.88 ? "Everyone's been selling, so the price is down." : headline ? `In the news: ${headline}.` : "A normal price for Vesper.";
  return { askCc, bidCc, why: { lines, summary } };
}

/** Bayo's rationing rule: the most one order can take. */
export function rationLimit(p: Pick<PricingInput, "traits" | "stock" | "target">): number | null {
  if (!p.traits.rations || p.stock >= p.target * 0.2) return null;
  return Math.max(1, Math.floor(p.stock / 10));
}
