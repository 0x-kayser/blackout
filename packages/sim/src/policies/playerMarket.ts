import type { MarketListingState, MerchantState, SimState } from "../state.ts";
import { ACC, bal } from "../ledger.ts";
import { merchantCash, merchantStock } from "../market.ts";
import { reservedFuelMl } from "../electricity.ts";

export interface ListingDecision {
  accepted: boolean;
  reason: string;
}

/** The NPC buy rule reads the same inventory, cash and replacement-cost state shown by the sim. */
export function decidePlayerListing(s: SimState, listing: MarketListingState, merchant: MerchantState): ListingDecision {
  if (merchant.status !== "open") return { accepted: false, reason: `${merchant.name} is closed.` };
  const stock = merchantStock(s, merchant);
  const room = Math.max(0, merchant.targetStockMl - stock - merchant.pendingRestockMl);
  if (room < listing.quantityMl) return { accepted: false, reason: `Needs ${listing.quantityMl.toLocaleString()} mL of space; only ${room.toLocaleString()} mL is open before restock.` };

  const liquidCash = Math.max(0, merchantCash(s, merchant) - merchant.operatingReserveCc);
  if (liquidCash < listing.totalCc) return { accepted: false, reason: `Can spend ${liquidCash} credits above its operating reserve; this listing costs ${listing.totalCc}.` };

  const replacement = merchant.reasons.baseReplacementCcPerL;
  if (listing.unitPriceCcPerL > replacement) return { accepted: false, reason: `The ask is ${listing.unitPriceCcPerL} credits/L; replacement cost is ${replacement} credits/L.` };

  const expectedDemand = Math.max(merchant.baselineSalesMl, merchant.lastDaySalesMl);
  const demandCapacity = Math.max(100, Math.min(merchant.targetStockMl - merchant.reserveFloorMl, expectedDemand * 2));
  if (listing.quantityMl > demandCapacity) return { accepted: false, reason: `Recent demand supports up to ${demandCapacity.toLocaleString()} mL in one purchase.` };

  return {
    accepted: true,
    reason: `Fits ${room.toLocaleString()} mL of stockroom space, costs ${listing.totalCc} credits from ${liquidCash} spendable credits, and is at or below ${replacement} credits/L replacement cost.`,
  };
}

export function playerListingDecisions(s: SimState, listing: MarketListingState): Record<string, string> {
  return Object.fromEntries(Object.values(s.merchants).map((m) => [m.merchantId, decidePlayerListing(s, listing, m).reason]));
}

export function playerListingDecision(s: SimState, listing: MarketListingState): { merchantId: string | null; reasons: Record<string, string> } {
  const merchants = Object.values(s.merchants).sort((a, b) => a.merchantId.localeCompare(b.merchantId));
  const reasons = playerListingDecisions(s, listing);
  const accepted = merchants.find((m) => decidePlayerListing(s, listing, m).accepted);
  return { merchantId: accepted?.merchantId ?? null, reasons };
}

/** Fuel already committed to player contracts is not available for listing. */
export function playerFreeFuelMl(s: SimState): number {
  return Math.max(0, bal(s, "fuel_ml", ACC.player) - reservedFuelMl(s, "player"));
}
