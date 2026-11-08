import { TIMING } from "./config.ts";
import { ACC, bal, transfer } from "./ledger.ts";
import { tradeTotalCc, repriceMerchant } from "./market.ts";
import { playerFreeFuelMl, playerListingDecision, playerListingDecisions } from "./policies/playerMarket.ts";
import { SimError, cr, emit, type Ctx, type MarketListingState, type SimState } from "./state.ts";

const listingById = (s: SimState, id: string) => {
  const listing = s.marketListings.find((x) => x.listingId === id);
  if (!listing) throw new SimError("NOT_FOUND", `Unknown listing ${id}.`);
  return listing;
};

const chainRequired = (s: SimState) => {
  if (s.mode !== "play" || s.chainMode !== "testnet") throw new SimError("CHAIN_UNAVAILABLE", "Player listings require a registered Testnet city with resource custody enabled.");
};

function queueJob(listing: MarketListingState, kind: "list" | "cancel" | "fill", merchantId: string | null = null) {
  const attempt = kind === "fill" ? listing.fillAttempts : kind === "cancel" ? listing.cancelAttempts : 1;
  return {
    jobId: `${listing.listingId}:${kind}:${attempt}`,
    kind,
    listingId: listing.listingId,
    sellerId: listing.sellerId,
    merchantId,
    amount: String(listing.quantityMl / 100),
    unitPriceCc: String(Math.ceil(listing.unitPriceCcPerL / 10)),
  };
}

export function createPlayerListing(s: SimState, ctx: Ctx, input: { listingId: string; quantityMl: number; unitPriceCcPerL: number }) {
  chainRequired(s);
  if (s.marketListings.some((x) => x.listingId === input.listingId)) throw new SimError("ALREADY_PROCESSED", "That listing id has already been used.");
  if (input.quantityMl % 100 !== 0 || input.quantityMl < 100) throw new SimError("VALIDATION_FAILED", "Fuel must be listed in 100 mL units.");
  const free = Math.min(s.player.chainBackedFuelMl ?? 0, playerFreeFuelMl(s));
  if (input.quantityMl > free) throw new SimError("INSUFFICIENT_FUEL", `Only ${free.toLocaleString()} mL of confirmed, unreserved fuel is available to list.`);
  const listing: MarketListingState = {
    listingId: input.listingId,
    sellerId: s.ownerId,
    quantityMl: input.quantityMl,
    unitPriceCcPerL: input.unitPriceCcPerL,
    totalCc: tradeTotalCc("diesel", input.quantityMl, input.unitPriceCcPerL),
    status: "reserved",
    createdTick: s.tick,
    expiresTick: s.tick + 7 * TIMING.OPERATING_TICKS,
    buyerMerchantId: null,
    decisionReasons: {},
    error: null,
    expireRequested: false,
    fillAttempts: 0,
    cancelAttempts: 0,
  };
  transfer(s, ctx, "fuel_ml", ACC.player, ACC.escrowListings, input.quantityMl, "player_listing_reserve", listing.listingId);
  s.player.chainBackedFuelMl -= input.quantityMl;
  s.marketListings.push(listing);
  const reasons = playerListingDecisions(s, listing);
  listing.decisionReasons = reasons;
  emit(s, ctx, "PLAYER_LISTING_RESERVED", ["player", `listing:${listing.listingId}`], `${(listing.quantityMl / 1000).toFixed(1)} L reserved for your market listing. Delivery is being confirmed.`, {
    listingId: listing.listingId, quantityMl: listing.quantityMl, unitPriceCcPerL: listing.unitPriceCcPerL, totalCc: listing.totalCc, decisionReasons: reasons,
  });
  return { listingId: listing.listingId, status: listing.status, marketJob: queueJob(listing, "list") };
}

export function cancelPlayerListing(s: SimState, ctx: Ctx, listingId: string) {
  chainRequired(s);
  const listing = listingById(s, listingId);
  if (listing.sellerId !== s.ownerId) throw new SimError("FORBIDDEN", "This listing belongs to another player.");
  if (listing.status !== "active") throw new SimError("ALREADY_PROCESSED", `This listing is ${listing.status} and cannot be cancelled now.`);
  listing.status = "cancel_pending";
  listing.expireRequested = false;
  listing.cancelAttempts += 1;
  emit(s, ctx, "PLAYER_LISTING_RESERVED", ["player", `listing:${listingId}`], "Your cancellation is being confirmed; the listed fuel stays reserved until then.", { listingId, operation: "cancel" });
  return { listingId, status: listing.status, marketJob: queueJob(listing, "cancel") };
}

export function expirePlayerListing(s: SimState, ctx: Ctx, listingId: string) {
  const listing = listingById(s, listingId);
  if (listing.status !== "active" || s.tick < listing.expiresTick) throw new SimError("ALREADY_PROCESSED", "This listing is not ready to expire.");
  listing.status = "cancel_pending";
  listing.expireRequested = true;
  listing.cancelAttempts += 1;
  emit(s, ctx, "PLAYER_LISTING_RESERVED", ["player", `listing:${listingId}`], "The listing period ended; return of the reserved fuel is being confirmed.", { listingId, operation: "expire" });
  return { listingId, status: listing.status, marketJob: queueJob(listing, "cancel") };
}

export function reserveMarketPurchase(s: SimState, ctx: Ctx, listingId: string, merchantId: string) {
  const listing = listingById(s, listingId);
  if (listing.status !== "active") throw new SimError("ALREADY_PROCESSED", `This listing is ${listing.status}.`);
  const decision = playerListingDecision(s, listing);
  const merchant = s.merchants[merchantId];
  if (!merchant || !decision.merchantId) throw new SimError("INVALID_STATE", "No merchant currently qualifies for this listing.", { decisionReasons: decision.reasons });
  if (decision.merchantId !== merchantId) throw new SimError("INVALID_STATE", "The selected merchant does not meet the listing policy.", { decisionReasons: decision.reasons });
  listing.decisionReasons = decision.reasons;
  transfer(s, ctx, "credits_cc", ACC.merchant(merchantId), ACC.escrowMarket, listing.totalCc, "player_listing_reserve_payment", listingId);
  listing.status = "purchase_pending";
  listing.buyerMerchantId = merchantId;
  listing.fillAttempts += 1;
  emit(s, ctx, "PLAYER_LISTING_DECISION", [`merchant:${merchantId}`, `listing:${listingId}`], `${merchant.name} accepted the listing: ${decision.reasons[merchantId]}`, { listingId, merchantId, accepted: true, reason: decision.reasons[merchantId], quantityMl: listing.quantityMl, totalCc: listing.totalCc });
  return { listingId, status: listing.status, merchantId, marketJob: queueJob(listing, "fill", merchantId), decisionReasons: decision.reasons };
}

export function settlePlayerListing(s: SimState, ctx: Ctx, input: { listingId: string; operation: "list" | "cancel" | "fill"; outcome: "confirmed" | "failed"; merchantId: string | null; txHash: string | null; error: string | null }) {
  const listing = listingById(s, input.listingId);
  if (input.outcome === "confirmed" && !input.txHash) throw new SimError("INVALID_STATE", "A Testnet listing operation cannot be confirmed without a verified transaction hash.");
  const onChain = input.outcome === "confirmed" && input.txHash ? { source: "testnet_transaction" as const, txHash: input.txHash } : {};
  if (input.operation === "list") {
    if (listing.status !== "reserved") throw new SimError("ALREADY_PROCESSED", `Listing is ${listing.status}.`);
    if (input.outcome === "confirmed") {
      listing.status = "active";
      listing.error = null;
      emit(s, ctx, "PLAYER_LISTING_ACTIVATED", ["player", `listing:${listing.listingId}`], `${(listing.quantityMl / 1000).toFixed(1)} L is now secured in your market listing.`, { listingId: listing.listingId, quantityMl: listing.quantityMl, decisionReasons: playerListingDecisions(s, listing) }, onChain);
    } else {
      transfer(s, ctx, "fuel_ml", ACC.escrowListings, ACC.player, listing.quantityMl, "player_listing_failed_release", listing.listingId);
      s.player.chainBackedFuelMl = (s.player.chainBackedFuelMl ?? 0) + listing.quantityMl;
      listing.status = "failed";
      listing.error = input.error ?? "The listing could not be confirmed.";
      emit(s, ctx, "PLAYER_LISTING_FAILED", ["player", `listing:${listing.listingId}`], `Listing setup failed; ${(listing.quantityMl / 1000).toFixed(1)} L returned to your tank.`, { listingId: listing.listingId, error: listing.error });
    }
  } else if (input.operation === "cancel") {
    if (listing.status !== "cancel_pending") throw new SimError("ALREADY_PROCESSED", `Listing is ${listing.status}.`);
    if (input.outcome === "confirmed") {
      transfer(s, ctx, "fuel_ml", ACC.escrowListings, ACC.player, listing.quantityMl, "player_listing_return", listing.listingId, input.txHash);
      s.player.chainBackedFuelMl = (s.player.chainBackedFuelMl ?? 0) + listing.quantityMl;
      listing.status = listing.expireRequested ? "expired" : "cancelled";
      listing.error = null;
      emit(s, ctx, listing.expireRequested ? "PLAYER_LISTING_EXPIRED" : "PLAYER_LISTING_CANCELLED", ["player", `listing:${listing.listingId}`], `${(listing.quantityMl / 1000).toFixed(1)} L returned to your available fuel.`, { listingId: listing.listingId, quantityMl: listing.quantityMl }, onChain);
    } else {
      listing.status = "active";
      listing.error = input.error ?? "Cancellation failed; the listing remains active.";
      emit(s, ctx, "PLAYER_LISTING_FAILED", ["player", `listing:${listing.listingId}`], "Cancellation could not be confirmed; your listing remains active and its fuel stays reserved.", { listingId: listing.listingId, error: listing.error });
    }
  } else {
    if (listing.status !== "purchase_pending" || listing.buyerMerchantId !== input.merchantId) throw new SimError("ALREADY_PROCESSED", `Listing purchase is no longer pending.`);
    const buyerMerchantId = listing.buyerMerchantId;
    if (!buyerMerchantId) throw new SimError("INTERNAL", "Listing buyer is missing from the run.");
    const merchant = s.merchants[buyerMerchantId];
    if (!merchant) throw new SimError("INTERNAL", "Listing buyer is missing from the run.");
    if (input.outcome === "confirmed") {
      transfer(s, ctx, "credits_cc", ACC.escrowMarket, ACC.player, listing.totalCc, "player_listing_settle_payment", listing.listingId);
      transfer(s, ctx, "fuel_ml", ACC.escrowListings, ACC.merchant(merchant.merchantId), listing.quantityMl, "player_listing_settle_resource", listing.listingId, input.txHash);
      listing.status = "filled";
      listing.error = null;
      repriceMerchant(s, ctx, merchant, `bought ${listing.quantityMl / 1000} L from a player listing`);
      emit(s, ctx, "PLAYER_LISTING_FILLED", ["player", `merchant:${merchant.merchantId}`, `listing:${listing.listingId}`], `${merchant.name} bought ${(listing.quantityMl / 1000).toFixed(1)} L from your listing for ${cr(listing.totalCc)} credits.`, { listingId: listing.listingId, merchantId: merchant.merchantId, quantityMl: listing.quantityMl, totalCc: listing.totalCc, payment: "off-chain game credits" }, onChain);
    } else {
      transfer(s, ctx, "credits_cc", ACC.escrowMarket, ACC.merchant(merchant.merchantId), listing.totalCc, "player_listing_refund_npc", listing.listingId);
      listing.status = "active";
      listing.buyerMerchantId = null;
      listing.error = input.error ?? "The resource transfer failed; the merchant's credits were returned.";
      listing.decisionReasons = playerListingDecisions(s, listing);
      emit(s, ctx, "PLAYER_LISTING_FAILED", ["player", `merchant:${merchant.merchantId}`, `listing:${listing.listingId}`], `${merchant.name}'s purchase failed; its ${cr(listing.totalCc)} credits were returned and your listing is active again.`, { listingId: listing.listingId, merchantId: merchant.merchantId, error: listing.error });
    }
  }
  return { listingId: listing.listingId, status: listing.status };
}

