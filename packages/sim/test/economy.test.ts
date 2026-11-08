import { describe, expect, it } from "vitest";
import { PERMIT_MG } from "@blackout/shared";
import { computeMerchantPrice, MERCHANT_POLICIES } from "../src/policies/merchantPricing.ts";
import { breakEvenRate, profitPerHourAt } from "../src/customers.ts";
import { ACC, bal, sumAsset, transfer } from "../src/ledger.ts";
import { merchantsSettlement, merchantsMorning } from "../src/market.ts";
import { rivalBid } from "../src/agents.ts";
import { runReplay } from "../src/replay.ts";
import { newCtx } from "../src/state.ts";
import { act, newRun, ticks, until } from "./helpers.ts";

const base = {
  policy: MERCHANT_POLICIES.efficient_wholesaler,
  oilIndexCenti: 10_000,
  referenceIndexCenti: 10_000,
  baseReferenceCcPerL: 1_000,
  stockMl: 200_000,
  reserveFloorMl: 0,
  targetStockMl: 200_000,
  lastDaySalesMl: 25_000,
  baselineSalesMl: 25_000,
  trend: "flat" as const,
};

describe("Cold Room fixture (design doc)", () => {
  it("+8 credits/hour at 8 credits/kWh, -2.5 at 15, break-even ~13.3", () => {
    const { s } = newRun();
    const cold = s.businesses.cold_room;
    expect(profitPerHourAt(cold, 800)).toBe(800);
    expect(profitPerHourAt(cold, 1_500)).toBe(-250);
    expect(breakEvenRate(cold)).toBe(1_333);
  });

  it("closure depends on cash vs fixed costs over consecutive settlements, never on a fixed day", () => {
    const { s } = newRun();
    // a rich Cold Room never closes even when every outage hour is dark
    until(s, (x) => x.day === 4);
    expect(s.businesses.cold_room.status).not.toBe("closed");

    const r2 = newRun().s;
    // drain the corner shop to just above zero: two struggling settlements -> closed
    transfer(r2, newCtx(r2), "credits_cc", ACC.business("corner_shop"), ACC.landlords, bal(r2, "credits_cc", ACC.business("corner_shop")) - 100, "test_drain");
    until(r2, (x) => x.day === 2);
    expect(["struggling", "operating"]).toContain(r2.businesses.corner_shop.status);
    until(r2, (x) => x.day === 3);
    const h = r2.businesses.corner_shop.history;
    // closed iff cash was below fixed cost at both settlements
    const lowBoth = h.slice(-2).every((d) => d.closingCashCc < r2.businesses.corner_shop.fixedCostCcPerDay);
    expect(r2.businesses.corner_shop.status === "closed").toBe(lowBoth);
  });
});

describe("merchant pricing policy", () => {
  it("rises on scarcity, falls on surplus, follows oil both ways", () => {
    const flat = computeMerchantPrice(base);
    const scarce = computeMerchantPrice({ ...base, stockMl: 50_000 });
    const surplus = computeMerchantPrice({ ...base, stockMl: 400_000 });
    const oilUp = computeMerchantPrice({ ...base, oilIndexCenti: 12_000 });
    const oilDown = computeMerchantPrice({ ...base, oilIndexCenti: 8_000 });
    expect(scarce.finalPriceCcPerL).toBeGreaterThan(flat.finalPriceCcPerL);
    expect(surplus.finalPriceCcPerL).toBeLessThan(flat.finalPriceCcPerL);
    expect(oilUp.finalPriceCcPerL).toBeGreaterThan(flat.finalPriceCcPerL);
    expect(oilDown.finalPriceCcPerL).toBeLessThan(flat.finalPriceCcPerL);
    expect(surplus.finalPriceCcPerL).toBeGreaterThanOrEqual(surplus.floorCcPerL); // never below import cost + margin
  });

  it("demand above baseline raises price; below lowers it", () => {
    const hot = computeMerchantPrice({ ...base, lastDaySalesMl: 50_000 });
    const cold = computeMerchantPrice({ ...base, stockMl: 150_000, lastDaySalesMl: 0 });
    const mid = computeMerchantPrice({ ...base, stockMl: 150_000 });
    expect(hot.demandDeltaBps).toBe(10_000);
    expect(hot.finalPriceCcPerL).toBeGreaterThan(computeMerchantPrice(base).finalPriceCcPerL);
    expect(cold.finalPriceCcPerL).toBeLessThan(mid.finalPriceCcPerL);
  });

  it("explanation numbers equal the actual inputs and formula", () => {
    const r = computeMerchantPrice({ ...base, stockMl: 100_000, oilIndexCenti: 11_000, lastDaySalesMl: 30_000 });
    expect(r.baseReplacementCcPerL).toBe(1_100);
    expect(r.scarcityBps).toBe(5_000);
    expect(r.demandDeltaBps).toBe(2_000);
    const mult = 10_000 + Math.trunc((4_500 * 5_000) / 10_000) + Math.trunc((2_000 * 2_000) / 10_000) + 200;
    expect(r.rawPriceCcPerL).toBe(Math.trunc((1_100 * mult) / 10_000));
    expect(r.explanation).toContain("11.00/L");
    expect(r.explanation).toContain("+50.0%");
  });

  it("the co-op hoards and rations on rising oil", () => {
    const coop = { ...base, policy: MERCHANT_POLICIES.reserve_cooperative, reserveFloorMl: 120_000, stockMl: 180_000 };
    const up = computeMerchantPrice({ ...coop, trend: "up" });
    const flat = computeMerchantPrice({ ...coop, trend: "flat" });
    expect(up.finalPriceCcPerL).toBeGreaterThan(flat.finalPriceCcPerL);
    expect(up.rationLimitMl).toBe(15_000);
    expect(flat.rationLimitMl).toBeNull();
  });
});

describe("market trades", () => {
  /** The market is always open; shop on day 2 when the oil index has moved. */
  function morning() {
    const { s } = newRun();
    until(s, (x) => x.day === 2);
    return s;
  }

  it("buying the boutique's cheap stock drops its stock and raises its next quote", () => {
    const s = morning();
    const lantern = s.merchants.lantern;
    const before = lantern.quoteCcPerL;
    const stockBefore = bal(s, "fuel_ml", ACC.merchant("lantern"));
    const q = act(s, { type: "REQUEST_QUOTE", sellerId: "merchant:lantern", item: "diesel", quantity: 20_000 }).result.quoteId as string;
    const { events } = act(s, { type: "BUY", quoteId: q, quantity: 20_000 });
    expect(bal(s, "fuel_ml", ACC.merchant("lantern"))).toBe(stockBefore - 20_000);
    expect(lantern.quoteCcPerL).toBeGreaterThan(before);
    const rep = events.find((e) => e.type === "MERCHANT_REPRICED")!;
    expect(rep.data.oldPriceCcPerL).toBe(before);
    expect(rep.data.newPriceCcPerL).toBe(lantern.quoteCcPerL);
    // credits flowed to the merchant's own account (not printed)
    expect(bal(s, "credits_cc", ACC.merchant("lantern"))).toBeGreaterThan(30_000);
  });

  it("two buyers cannot purchase the same last litre; stale quotes fail", () => {
    const s = morning();
    const avail = bal(s, "fuel_ml", ACC.merchant("lantern"));
    // leave exactly 1 L sellable
    transfer(s, newCtx(s), "fuel_ml", ACC.merchant("lantern"), ACC.fuelBurned, avail - 1_000, "test");
    const q1 = act(s, { type: "REQUEST_QUOTE", sellerId: "merchant:lantern", item: "diesel", quantity: 1_000 }).result.quoteId as string;
    const q2 = act(s, { type: "REQUEST_QUOTE", sellerId: "merchant:lantern", item: "diesel", quantity: 1_000 }).result.quoteId as string;
    act(s, { type: "BUY", quoteId: q1, quantity: 1_000 });
    expect(() => act(s, { type: "BUY", quoteId: q2, quantity: 1_000 })).toThrowError(expect.objectContaining({ code: "OUT_OF_STOCK" }));
    expect(() => act(s, { type: "BUY", quoteId: q1, quantity: 1_000 })).toThrowError(expect.objectContaining({ code: "ALREADY_PROCESSED" }));
    const q3 = act(s, { type: "REQUEST_QUOTE", sellerId: "merchant:ember", item: "diesel", quantity: 1_000 }).result.quoteId as string;
    ticks(s, 16);
    expect(() => act(s, { type: "BUY", quoteId: q3, quantity: 1_000 })).toThrowError(expect.objectContaining({ code: "QUOTE_EXPIRED" }));
  });

  it("chain-leg trades stay pending until settled; failure compensates exactly once", () => {
    const s = morning();
    const cash = bal(s, "credits_cc", ACC.player);
    const fuel = bal(s, "fuel_ml", ACC.player);
    const stock = bal(s, "fuel_ml", ACC.merchant("ember"));
    const q = act(s, { type: "REQUEST_QUOTE", sellerId: "merchant:ember", item: "diesel", quantity: 5_000 }).result.quoteId as string;
    const t = act(s, { type: "BUY", quoteId: q, quantity: 5_000 }, "idem-1", true).result.tradeId as string;
    expect(s.trades[t].chainStatus).toBe("pending");
    expect(bal(s, "fuel_ml", ACC.player)).toBe(fuel); // not delivered before confirmation
    expect(bal(s, "credits_cc", ACC.escrowTrades)).toBe(s.trades[t].totalCc);
    act(s, { type: "SETTLE_TRADE", tradeId: t, outcome: "failed", txHash: null, error: "TX_FAILED" });
    expect(bal(s, "credits_cc", ACC.player)).toBe(cash);
    expect(bal(s, "fuel_ml", ACC.merchant("ember"))).toBe(stock);
    expect(() => act(s, { type: "SETTLE_TRADE", tradeId: t, outcome: "failed", txHash: null, error: "again" })).toThrowError(expect.objectContaining({ code: "ALREADY_PROCESSED" }));
    expect(s.trades[t].chainStatus).toBe("failed");
    expect(s.trades[t].txHash).toBeNull();
  });

  it("tank capacity and credits are enforced", () => {
    const s = morning();
    const q = act(s, { type: "REQUEST_QUOTE", sellerId: "merchant:ember", item: "diesel", quantity: 60_000 }).result.quoteId as string;
    expect(() => act(s, { type: "BUY", quoteId: q, quantity: 60_000 })).toThrowError(expect.objectContaining({ code: "TANK_FULL" }));
    transfer(s, newCtx(s), "credits_cc", ACC.player, ACC.landlords, bal(s, "credits_cc", ACC.player) - 100, "test");
    expect(() => act(s, { type: "BUY", quoteId: q, quantity: 10_000 })).toThrowError(expect.objectContaining({ code: "INSUFFICIENT_CREDITS" }));
  });

  it("permits come from the regulator's finite daily supply", () => {
    const s = morning();
    const forSale = Math.floor(bal(s, "permit_mg", ACC.regulator) / PERMIT_MG);
    const q = act(s, { type: "REQUEST_QUOTE", sellerId: "regulator", item: "permit", quantity: 50 }).result.quoteId as string;
    expect(s.quotes[q].maxQuantity).toBe(forSale);
  });
});

describe("merchant restocking and insolvency", () => {
  it("restock pays the importer, respects cash and upstream capacity, arrives after lead time", () => {
    const { s } = newRun();
    const ctx = newCtx(s);
    transfer(s, ctx, "fuel_ml", ACC.merchant("lantern"), ACC.fuelBurned, 25_000, "test_sell_off");
    const cash = bal(s, "credits_cc", ACC.merchant("lantern"));
    merchantsSettlement(s, ctx);
    const m = s.merchants.lantern;
    expect(m.pendingRestockMl).toBeGreaterThan(0);
    expect(m.pendingRestockMl).toBeLessThanOrEqual(m.upstreamCapacityMlPerDay);
    expect(bal(s, "credits_cc", ACC.merchant("lantern"))).toBeLessThan(cash - m.overheadCcPerDay);
    const stock = bal(s, "fuel_ml", ACC.merchant("lantern"));
    const pending = m.pendingRestockMl;
    merchantsMorning(s, ctx); // same day: not yet arrived (1-day lead time)
    expect(bal(s, "fuel_ml", ACC.merchant("lantern"))).toBe(stock);
    s.day += 1;
    merchantsMorning(s, ctx);
    expect(bal(s, "fuel_ml", ACC.merchant("lantern"))).toBe(stock + pending);
    expect(m.pendingRestockMl).toBe(0);
  });

  it("a broke merchant with empty tanks closes, then reopens when an order becomes affordable", () => {
    const { s } = newRun();
    const ctx = newCtx(s);
    transfer(s, ctx, "fuel_ml", ACC.merchant("lantern"), ACC.fuelBurned, bal(s, "fuel_ml", ACC.merchant("lantern")), "test");
    transfer(s, ctx, "credits_cc", ACC.merchant("lantern"), ACC.landlords, bal(s, "credits_cc", ACC.merchant("lantern")) - 6_000, "test");
    merchantsSettlement(s, ctx);
    expect(s.merchants.lantern.status).toBe("closed");
    expect(ctx.events.some((e) => e.type === "MERCHANT_CLOSED")).toBe(true);
    // cheaper oil + some cash => can afford a minimum order again
    transfer(s, ctx, "credits_cc", ACC.shoppers, ACC.merchant("lantern"), 20_000, "test_injection");
    s.world.prevOilIndexCenti = s.world.oilIndexCenti;
    s.world.oilIndexCenti = 9_000;
    merchantsSettlement(s, ctx);
    expect(s.merchants.lantern.pendingRestockMl).toBeGreaterThan(0);
    s.day += 1;
    merchantsMorning(s, ctx);
    expect(s.merchants.lantern.status).toBe("open");
  });
});

describe("rival operator", () => {
  it("only wins a missed customer when it can physically supply it", () => {
    const { s } = newRun();
    until(s, (x) => x.day === 2 && x.phase === "operating");
    const req = { requestId: "r1", waveId: "w", businessId: "bakery", districtId: "market_quarter", requestedW: 1_200, durationHours: 2, offerRateCcPerKwh: 800, counterCount: 0, maxCounters: 2, lastPlayerCounterCcPerKwh: null, status: "expired" as const, createdTick: s.tick, deadlineTick: null, day: s.day, message: "", resolutionReason: null };
    s.requests.r1 = { ...req };
    s.businesses.bakery.activeContractId = null;
    const ctx = newCtx(s);
    transfer(s, ctx, "fuel_ml", ACC.rival, ACC.fuelBurned, bal(s, "fuel_ml", ACC.rival), "test_drain");
    rivalBid(s, ctx, s.requests.r1, "test");
    expect(ctx.events.some((e) => e.type === "RIVAL_DECLINED_CONTRACT")).toBe(true);
    expect(Object.values(s.contracts).some((c) => c.provider === "rival" && c.requestId === "r1")).toBe(false);
    transfer(s, ctx, "fuel_ml", ACC.genesis, ACC.rival, 20_000, "test_refill");
    s.requests.r2 = { ...req, requestId: "r2" };
    rivalBid(s, ctx, s.requests.r2, "test");
    expect(ctx.events.some((e) => e.type === "RIVAL_WON_CONTRACT")).toBe(true);
    const c = Object.values(s.contracts).find((c) => c.requestId === "r2")!;
    expect(c.rateCcPerKwh).toBe(s.rival.tariffCcPerKwh);
    expect(c.rateCcPerKwh).toBeGreaterThanOrEqual(s.rival.tariffReasons.unitCostCcPerKwh);
  });

  it("reprices from its own fuel cost next morning", () => {
    const { s } = newRun();
    const t1 = s.rival.tariffCcPerKwh;
    s.rival.fuelCostBasisCcPerL = 2_000; // pretend it bought expensive fuel
    until(s, (x) => x.day === 2 && x.phaseTick > 31); // the rival shops and reprices at 09:00
    expect(s.rival.tariffCcPerKwh).not.toBe(t1);
    expect(s.rival.tariffReasons.fuelCostCcPerKwh).toBe(Math.round((s.rival.fuelCostBasisCcPerL * 3) / 10));
  });
});

describe("solar and battery", () => {
  it("solar is zero at night and the battery never creates energy", () => {
    const { s } = newRun();
    until(s, (x) => x.day === 2);
    transfer(s, newCtx(s), "credits_cc", ACC.genesis, ACC.player, 200_000, "test_grant");
    act(s, { type: "BUY_UPGRADE", upgradeId: "solar_2kw" });
    act(s, { type: "BUY_UPGRADE", upgradeId: "battery_10kwh" }).result;
    let charged = 0;
    let lastStored = 0;
    for (let i = 0; i < 240 && s.phase === "operating"; i++) {
      const hour = Math.floor(((360 + s.phaseTick * 6) % 1440) / 60);
      ticks(s, 1);
      const g = s.generators.solar_1;
      if (hour >= 20 || hour < 6) expect(g.outputW).toBe(0);
      if (s.battery!.storedWh > lastStored) charged += s.battery!.storedWh - lastStored;
      lastStored = s.battery!.storedWh;
      expect(s.battery!.storedWh).toBeLessThanOrEqual(s.battery!.capacityWh);
    }
    expect(charged).toBeGreaterThan(0);
    expect(charged).toBeLessThanOrEqual(s.generators.solar_1.cumulativeWh);
  });
});

describe("determinism and policy divergence (replay)", () => {
  it("same seed + same policy => identical trace; different policy => different outcome", () => {
    const a = runReplay({ seed: 424242, policyId: "diesel", days: 7 });
    const b = runReplay({ seed: 424242, policyId: "diesel", days: 7 });
    const c = runReplay({ seed: 424242, policyId: "diversified", days: 7 });
    expect(a.summary.traceHash).toBe(b.summary.traceHash);
    expect(JSON.stringify(a.ledger)).toBe(JSON.stringify(b.ledger));
    expect(c.summary.traceHash).not.toBe(a.summary.traceHash);
    expect(c.summary.final.netWorthCc).not.toBe(a.summary.final.netWorthCc);
    expect(c.summary.daily.some((d) => d.generationMixWh.solar > 0)).toBe(true);
    expect(a.summary.daily.every((d) => d.generationMixWh.solar === 0)).toBe(true);
    expect(a.summary.wallMs).toBeLessThan(60_000);
    for (const asset of ["credits_cc", "fuel_ml", "permit_mg"] as const) expect(sumAsset(a.finalState, asset)).toBe(0);
    // billed energy never exceeds delivered energy
    for (const k of Object.values(a.finalState.contracts)) expect(k.billedCc).toBeLessThanOrEqual(Math.floor((k.deliveredWh * k.rateCcPerKwh) / 1000));
    // fuel conservation: burned == 0.3 mL per diesel Wh
    const burned = bal(a.finalState, "fuel_ml", ACC.fuelBurned);
    const dieselWh = Object.values(a.finalState.contracts).reduce((x, k) => x + k.deliveredWh, 0);
    expect(burned).toBe((dieselWh * 3) / 10);
  });

  it("the gouging policy loses its customers to the rival", () => {
    const g = runReplay({ seed: 424242, policyId: "gouger", days: 5 });
    const d = runReplay({ seed: 424242, policyId: "diesel", days: 5 });
    expect(g.events.some((e) => e.type === "CUSTOMER_SWITCHED_PROVIDER")).toBe(true);
    expect(g.summary.final.reliabilityBps).toBeLessThan(d.summary.final.reliabilityBps);
  });
});
