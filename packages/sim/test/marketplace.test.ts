import { describe, expect, it } from "vitest";
import { GameStatePublicSchema } from "@blackout/shared";
import { ACC, bal, transfer } from "../src/ledger.ts";
import { playerListingDecision } from "../src/policies/playerMarket.ts";
import { newCtx } from "../src/state.ts";
import { toPublic } from "../src/view.ts";
import { act, newRun, ticks } from "./helpers.ts";

const HASH = "4ZbV4k1Tcv1oWy1hoxUo4o9b2cUqGgYyU6wF7pK2ZWwz";
const run = () => newRun(123, { mode: "play", chainMode: "testnet", merchantAccounts: { ember: "ember.testnet", lantern: "lantern.testnet", harbor: "harbor.testnet" } });

function buyConfirmedDiesel(s: ReturnType<typeof run>, quantityMl = 5_000) {
  const q = act(s.s, { type: "REQUEST_QUOTE", sellerId: "merchant:ember", item: "diesel", quantity: quantityMl }).result.quoteId as string;
  const bought = act(s.s, { type: "BUY", quoteId: q, quantity: quantityMl }, "buy-chain", true).result.tradeId as string;
  act(s.s, { type: "SETTLE_TRADE", tradeId: bought, outcome: "confirmed", txHash: HASH, error: null });
}

describe("player-owned resource listings", () => {
  it("only exposes confirmed chain-backed fuel and cannot list starter or excess fuel", () => {
    const s = run();
    expect(s.s.player.chainBackedFuelMl).toBe(0);
    expect(() => act(s.s, { type: "CREATE_PLAYER_LISTING", listingId: "unbacked-1", quantityMl: 1_000, unitPriceCcPerL: 900 })).toThrow(/confirmed, unreserved fuel/);
    buyConfirmedDiesel(s);
    expect(s.s.player.chainBackedFuelMl).toBe(5_000);
    expect(() => act(s.s, { type: "CREATE_PLAYER_LISTING", listingId: "backed-too-much", quantityMl: 6_000, unitPriceCcPerL: 900 })).toThrow(/confirmed, unreserved fuel/);
    const view = toPublic(s.s);
    expect(GameStatePublicSchema.parse(view).player.listableFuelMl).toBe(5_000);
  });

  it("keeps active contract fuel reserved from player listings", () => {
    const s = run();
    buyConfirmedDiesel(s);
    const ctx = newCtx(s.s);
    transfer(s.s, ctx, "fuel_ml", ACC.player, ACC.fuelBurned, 20_000, "test_remove_unbacked_starter_fuel");
    ticks(s.s, 1);
    const request = Object.values(s.s.requests).find((r) => r.status === "open")!;
    const contractId = act(s.s, { type: "ACCEPT_REQUEST", requestId: request.requestId }).result.contractId as string;
    act(s.s, { type: "ASSIGN_CONTRACT", contractId, generatorId: "gen_1" });
    ticks(s.s, 1);
    const listable = toPublic(s.s).player.listableFuelMl;
    expect(listable).toBeGreaterThan(0);
    expect(listable).toBeLessThan(5_000);
    expect(() => act(s.s, { type: "CREATE_PLAYER_LISTING", listingId: "reserved-too-much", quantityMl: 5_000, unitPriceCcPerL: 900 })).toThrow(/confirmed, unreserved fuel/);
  });

  it("reserves player fuel and NPC credits, evaluates current economics, then settles an NPC purchase once", () => {
    const s = run();
    buyConfirmedDiesel(s);
    const created = act(s.s, { type: "CREATE_PLAYER_LISTING", listingId: "list-fill-1", quantityMl: 2_000, unitPriceCcPerL: 800 }).result;
    expect(created.marketJob).toMatchObject({ kind: "list", amount: "20", sellerId: "tester" });
    expect(bal(s.s, "fuel_ml", ACC.player)).toBe(23_000);
    expect(bal(s.s, "fuel_ml", ACC.escrowListings)).toBe(2_000);
    expect(s.s.player.chainBackedFuelMl).toBe(3_000);

    act(s.s, { type: "MARKET_LISTING_RESULT", listingId: "list-fill-1", operation: "list", outcome: "confirmed", merchantId: null, txHash: HASH, error: null });
    expect(s.s.marketListings[0].status).toBe("active");
    const decision = playerListingDecision(s.s, s.s.marketListings[0]);
    expect(decision.merchantId).toBe("ember");
    expect(decision.reasons.ember).toMatch(/stockroom space/);

    const buyerCash = bal(s.s, "credits_cc", ACC.merchant("ember"));
    act(s.s, { type: "RESERVE_MARKET_PURCHASE", listingId: "list-fill-1", merchantId: "ember" });
    expect(bal(s.s, "credits_cc", ACC.merchant("ember"))).toBe(buyerCash - 1_600);
    expect(bal(s.s, "credits_cc", ACC.escrowMarket)).toBe(1_600);
    const playerCash = bal(s.s, "credits_cc", ACC.player);
    act(s.s, { type: "MARKET_LISTING_RESULT", listingId: "list-fill-1", operation: "fill", outcome: "confirmed", merchantId: "ember", txHash: HASH, error: null });

    expect(s.s.marketListings[0].status).toBe("filled");
    expect(bal(s.s, "credits_cc", ACC.player)).toBe(playerCash + 1_600);
    expect(bal(s.s, "credits_cc", ACC.escrowMarket)).toBe(0);
    expect(bal(s.s, "fuel_ml", ACC.escrowListings)).toBe(0);
    expect(bal(s.s, "fuel_ml", ACC.merchant("ember"))).toBe(147_000);
    expect(s.s.player.chainBackedFuelMl).toBe(3_000);
    expect(() => act(s.s, { type: "MARKET_LISTING_RESULT", listingId: "list-fill-1", operation: "fill", outcome: "confirmed", merchantId: "ember", txHash: HASH, error: null })).toThrow(/no longer pending/);
  });

  it("returns fuel after a failed listing or confirmed cancellation, and refunds NPC cash after failed fill", () => {
    const s = run();
    buyConfirmedDiesel(s);
    act(s.s, { type: "CREATE_PLAYER_LISTING", listingId: "list-cancel-1", quantityMl: 1_000, unitPriceCcPerL: 800 });
    act(s.s, { type: "MARKET_LISTING_RESULT", listingId: "list-cancel-1", operation: "list", outcome: "confirmed", merchantId: null, txHash: HASH, error: null });
    const cash = bal(s.s, "credits_cc", ACC.merchant("ember"));
    act(s.s, { type: "RESERVE_MARKET_PURCHASE", listingId: "list-cancel-1", merchantId: "ember" });
    act(s.s, { type: "MARKET_LISTING_RESULT", listingId: "list-cancel-1", operation: "fill", outcome: "failed", merchantId: "ember", txHash: HASH, error: "final receipt failed" });
    expect(bal(s.s, "credits_cc", ACC.merchant("ember"))).toBe(cash);
    expect(s.s.marketListings[0].status).toBe("active");

    act(s.s, { type: "CANCEL_PLAYER_LISTING", listingId: "list-cancel-1" });
    act(s.s, { type: "MARKET_LISTING_RESULT", listingId: "list-cancel-1", operation: "cancel", outcome: "confirmed", merchantId: null, txHash: HASH, error: null });
    expect(s.s.marketListings[0].status).toBe("cancelled");
    expect(bal(s.s, "fuel_ml", ACC.escrowListings)).toBe(0);
    expect(s.s.player.chainBackedFuelMl).toBe(5_000);
  });
});
