import { describe, expect, it } from "vitest";
import { region } from "../../src/index.ts";
import type { AnyRegionAction } from "@blackout/shared";

const { createRegion, regionAct, regionTick, toRegionView, newRCtx, rsum, rbal, RACC, verifyEpoch, canonical, sha256, runRegionLab } = region;

function run(seed: number, ticks: number, script: Record<number, AnyRegionAction[]> = {}) {
  const s = createRegion({ regionId: `t${seed}`, seed });
  const ctx = newRCtx();
  for (let i = 0; i < ticks; i++) {
    for (const a of script[i] ?? []) regionAct(s, ctx, a);
    regionTick(s, ctx);
  }
  return { s, ctx };
}

// engine-only tests receive steel as if bought in Vesper Market (the market itself is tested in town.test.ts)
const STEEL: AnyRegionAction = { type: "TOWN_SETTLE", ref: "steel", reason: "steel", items: { "material:steel": 800 } };
const ONBOARD: Record<number, AnyRegionAction[]> = {
  0: [STEEL, { type: "SET_BATTERY_MODE", plantId: "eastside", mode: "auto" }, { type: "SET_PLANT_ONLINE", plantId: "kestrel", online: true }],
  2: [{ type: "BUILD_PLANT", tech: "diesel", nodeId: "residential_east", size: 1 }],
  5: [{ type: "UPGRADE_CORRIDOR", corridorId: "c_east" }],
};

describe("regional engine", () => {
  it("is deterministic: same seed and actions give the same state", () => {
    const a = run(11, 400, ONBOARD).s;
    const b = run(11, 400, ONBOARD).s;
    expect(sha256(canonical(a))).toBe(sha256(canonical(b)));
    const c = run(12, 400, ONBOARD).s;
    expect(sha256(canonical(c))).not.toBe(sha256(canonical(a)));
  });

  it("uses deterministic, distinct opening inputs for each regional weekly challenge", () => {
    const fuelA = createRegion({ regionId: "fuel-a", seed: 71, mode: "challenge", snapshot: region.regionChallengeSnapshot("disruption") });
    const fuelB = createRegion({ regionId: "fuel-b", seed: 71, mode: "challenge", snapshot: region.regionChallengeSnapshot("disruption") });
    const heat = createRegion({ regionId: "heat", seed: 71, mode: "challenge", snapshot: region.regionChallengeSnapshot("demand_surge") });
    const carbon = createRegion({ regionId: "carbon", seed: 71, mode: "challenge", snapshot: region.regionChallengeSnapshot("carbon_tightening") });
    expect(fuelA.input).toEqual(fuelB.input);
    expect(fuelA.input.gasUsdPerMMBtu).toBeGreaterThan(region.regionConfig.CHALLENGE_SNAPSHOT.gasUsdPerMMBtu);
    expect(heat.input.tempC).toBe(41);
    expect(carbon.input.carbonUsdPerT).toBeGreaterThan(region.regionConfig.CHALLENGE_SNAPSHOT.carbonUsdPerT);
    expect(new Set([fuelA.input.gasUsdPerMMBtu, heat.input.tempC, carbon.input.carbonUsdPerT]).size).toBe(3);
  });

  it("starts a weekly crisis in the shared scenario without replaying the guest tutorial", () => {
    const s = createRegion({ regionId: "weekly-start", seed: 72, mode: "challenge" });
    expect(s.onboarding).toEqual({ step: 3, done: true });
    expect(toRegionView(s).onboarding).toMatchObject({ done: true, target: null });
  });

  it("conserves every asset: credits, gas and diesel sum to zero across accounts", () => {
    const { s } = run(5, 600, ONBOARD);
    expect(rsum(s, "cc")).toBe(0);
    expect(rsum(s, "gas")).toBe(0);
    expect(rsum(s, "diesel")).toBe(0);
    for (const [acct, v] of Object.entries(s.balances.cc)) if (!acct.startsWith("ext:")) expect(v).toBeGreaterThanOrEqual(0);
  });

  it("opens on a visible blackout and the first minute is three taps", () => {
    const s = createRegion({ regionId: "fm", seed: 3 });
    const ctx = newRCtx();
    const v = toRegionView(s);
    // the player arrives to it: Eastbank has tripped and Residential East is dark
    expect(v.plants.find((p) => p.plantId === "eastbank")!.status).toBe("tripped");
    const re = v.nodes.find((n) => n.nodeId === "residential_east")!;
    expect(re.shedKw).toBeGreaterThan(30_000);
    expect(re.dark).toBe(true);
    expect(v.question).toContain("The lights are out in Residential East");
    expect(v.nodes.filter((n) => n.shedKw > 0).map((n) => n.nodeId)).toEqual(["residential_east"]);
    expect(v.onboarding).toMatchObject({ step: 0, target: "plant:eastside" });
    // tap 1: the battery brings the lights back
    regionAct(s, ctx, { type: "SET_BATTERY_MODE", plantId: "eastside", mode: "auto" });
    regionTick(s, ctx);
    const v1 = toRegionView(s);
    expect(v1.nodes.find((n) => n.nodeId === "residential_east")!.shedKw).toBe(0);
    expect(v1.onboarding).toMatchObject({ step: 1, target: "plant:kestrel" });
    // tap 2: the turbine earns
    regionAct(s, ctx, { type: "SET_PLANT_ONLINE", plantId: "kestrel", online: true });
    for (let i = 0; i < 4; i++) regionTick(s, ctx);
    const v2 = toRegionView(s);
    expect(v2.onboarding).toMatchObject({ step: 2, target: "node:residential_east" });
    expect(v2.plants.find((p) => p.plantId === "kestrel")!.outputKw).toBeGreaterThan(0);
    expect(v2.player.revenueCcToday).toBeGreaterThan(0);
    // tap 3: build where it's needed (with steel from the market)
    regionAct(s, ctx, STEEL);
    regionAct(s, ctx, { type: "BUILD_PLANT", tech: "diesel", nodeId: "residential_east", size: 1 });
    regionTick(s, ctx);
    expect(toRegionView(s).onboarding.done).toBe(true);
  });

  it("starter grant comes out of the genesis treasury, once", () => {
    const s = createRegion({ regionId: "g", seed: 1 });
    expect(rbal(s, "cc", RACC.player)).toBe(region.regionConfig.STARTER_GRANT_CC);
    expect(rbal(s, "cc", RACC.treasury)).toBe(region.regionConfig.GENESIS_TREASURY_CC - region.regionConfig.STARTER_GRANT_CC);
  });

  it("refuses what isn't the player's or can't be paid", () => {
    const s = createRegion({ regionId: "x", seed: 1 });
    const ctx = newRCtx();
    expect(() => regionAct(s, ctx, { type: "SET_PLANT_ONLINE", plantId: "harbor_ccgt", online: false })).toThrow(/isn't yours/);
    expect(() => regionAct(s, ctx, { type: "BUILD_PLANT", tech: "ccgt", nodeId: "port", size: 0 })).toThrow(/licence/);
    expect(() => regionAct(s, ctx, { type: "BUILD_PLANT", tech: "battery", nodeId: "central_city", size: 1 })).toThrow(/steel/);
    regionAct(s, ctx, STEEL);
    regionAct(s, ctx, { type: "BUILD_PLANT", tech: "battery", nodeId: "central_city", size: 1 });
    regionAct(s, ctx, STEEL);
    regionAct(s, ctx, { type: "BUILD_PLANT", tech: "battery", nodeId: "central_city", size: 1 });
    regionAct(s, ctx, STEEL);
    expect(() => regionAct(s, ctx, { type: "BUILD_PLANT", tech: "battery", nodeId: "central_city", size: 1 })).toThrow(/Costs/);
  });

  it("explains every node price: build-up and decomposition both sum to the price", () => {
    const { s } = run(9, 30, ONBOARD);
    const v = toRegionView(s);
    for (const n of v.nodes) {
      expect(n.decomposition.reduce((a, c) => a + c.ccPerMWh, 0)).toBe(n.priceCcPerMWh);
      if (n.marginal.kind === "plant") expect(n.buildUp.reduce((a, c) => a + c.ccPerMWh, 0)).toBe(n.priceCcPerMWh);
    }
  });

  it("congestion splits prices and pays the line's owners", () => {
    // noon on day 2: the North Belt line fills with solar
    const { s } = run(4, 288 + 230, { ...ONBOARD, 200: [{ type: "UPGRADE_CORRIDOR", corridorId: "c_north" }] });
    const hadCongestion = s.events.some((e) => e.type === "CONGESTION") || s.corridors.some((c) => c.rentCcToday > 0);
    expect(hadCongestion).toBe(true);
    const north = s.corridors.find((c) => c.corridorId === "c_north")!;
    expect(north.upgrades.some((u) => u.ownerId === "player")).toBe(true);
  });

  it("closes settlement epochs whose nets sum to zero and verify by hash", () => {
    const { s } = run(2, 200, ONBOARD);
    expect(s.epochs.length).toBeGreaterThanOrEqual(5);
    for (const e of s.epochs) {
      expect(verifyEpoch(e)).toBe(true);
      expect(e.transfers.reduce((a, t) => a + t.deltaCc, 0)).toBe(0);
    }
    expect(new Set(s.epochs.map((e) => e.epochId)).size).toBe(s.epochs.length);
    const tampered = { ...s.epochs[0], transfers: s.epochs[0].transfers.map((t, i) => (i === 0 ? { ...t, deltaCc: t.deltaCc + 1 } : t)) };
    expect(verifyEpoch(tampered)).toBe(false);
  });

  it("selling a Plant Asset moves control and its record to the buyer", () => {
    const s = createRegion({ regionId: "sale", seed: 8 });
    const ctx = newRCtx();
    for (let i = 0; i < 30; i++) regionTick(s, ctx);
    regionAct(s, ctx, { type: "LIST_PLANT", plantId: "eastside", askCc: 20_000_000 });
    const v = toRegionView(s);
    const listing = v.plants.find((p) => p.plantId === "eastside")!.listing!;
    expect(listing.bids.length).toBeGreaterThan(0);
    const bid = listing.bids[0];
    const before = rbal(s, "cc", RACC.player);
    const lifetime = s.plants.find((p) => p.plantId === "eastside")!.lifetimeKwh;
    regionAct(s, ctx, { type: "ACCEPT_BID", plantId: "eastside", bidId: bid.bidId });
    const p = s.plants.find((x) => x.plantId === "eastside")!;
    expect(p.ownerId).toBe(bid.bidder);
    expect(p.lifetimeKwh).toBe(lifetime);
    expect(rbal(s, "cc", RACC.player)).toBe(before + bid.amountCc);
    expect(() => regionAct(s, ctx, { type: "SET_BATTERY_MODE", plantId: "eastside", mode: "hold" })).toThrow(/isn't yours/);
  });

  it("loans come from a bank's own cash and accrue interest", () => {
    const s = createRegion({ regionId: "loan", seed: 1 });
    const ctx = newRCtx();
    const bank0 = rbal(s, "cc", RACC.bank("vesper_savings"));
    regionAct(s, ctx, { type: "TAKE_LOAN", bankId: "vesper_savings", amountCc: 10_000_000 });
    expect(rbal(s, "cc", RACC.bank("vesper_savings"))).toBe(bank0 - 10_000_000);
    for (let i = 0; i < 288; i++) regionTick(s, ctx);
    expect(rbal(s, "cc", RACC.bank("vesper_savings"))).toBeGreaterThan(bank0 - 10_000_000);
    expect(() => regionAct(s, ctx, { type: "TAKE_LOAN", bankId: "vesper_savings", amountCc: 4_000_000_00 })).toThrow(/at most|won't lend/);
  });

  it("market items: solar earns certificates, plants surrender permits, kits repair trips, trades settle both ways", () => {
    const s = createRegion({ regionId: "items", seed: 1 });
    const ctx = newRCtx();
    // a trade lands: credits out, permits and kits in
    regionAct(s, ctx, { type: "TOWN_SETTLE", ref: "t1", reason: "bought permits", cc: -100_000, items: { "permit:carbon": 50, "part:turbine": 4 } });
    expect(toRegionView(s).player).toMatchObject({ permitsT: 50, parts: 4 });
    expect(() => regionAct(s, ctx, { type: "TOWN_SETTLE", ref: "t2", reason: "sell", items: { "fuel:diesel": -10_000_000 } })).toThrow(/Not enough/);
    // the turbine surrenders permits as it runs
    regionAct(s, ctx, { type: "SET_PLANT_ONLINE", plantId: "kestrel", online: true });
    for (let i = 0; i < 6; i++) regionTick(s, ctx);
    expect(toRegionView(s).player.permitsT).toBeLessThan(50);
    // a trip is fixed at once with kits
    const k = s.plants.find((p) => p.plantId === "kestrel")!;
    k.status = "tripped";
    k.tripUntil = s.interval + 100;
    regionAct(s, ctx, { type: "REPAIR_PLANT", plantId: "kestrel" });
    expect(k.status).toBe("starting");
    expect(toRegionView(s).player.parts).toBe(2);
    // market prices become the region's fuel price
    regionAct(s, ctx, { type: "TOWN_PRICES", gas: 900, diesel: 120 });
    expect(toRegionView(s).plants.find((p) => p.plantId === "kestrel")!.costBreakdown[0].ccPerMWh).toBe(Math.round(10.4 * 900));
    for (const a of ["cc", "gas", "diesel", "permit", "cert", "steel", "parts"] as const) expect(rsum(s, a)).toBe(0);
  });

  it("player solar earns renewable certificates", () => {
    const s = createRegion({ regionId: "sol", seed: 2 });
    const ctx = newRCtx();
    regionAct(s, ctx, { type: "TOWN_SETTLE", ref: "st", reason: "steel", cc: -400 * 25_000, items: { "material:steel": 400 } });
    regionAct(s, ctx, { type: "BUILD_PLANT", tech: "solar", nodeId: "north_solar", size: 0 });
    for (let i = 0; i < 288; i++) regionTick(s, ctx);
    expect(toRegionView(s).player.certificates).toBeGreaterThan(20);
  });

  it("challenge worlds ignore live inputs and end after three days", () => {
    const s = createRegion({ regionId: "ch", seed: 77, mode: "challenge" });
    const ctx = newRCtx();
    regionAct(s, ctx, { type: "WORLD_INPUT", snapshot: { ...s.input, source: "live", gasUsdPerMMBtu: 30 } });
    expect(s.input.gasUsdPerMMBtu).toBe(3.6);
    for (let i = 0; i < 288 * 3 + 20 && !s.ended; i++) regionTick(s, ctx);
    expect(s.ended).toBe(true);
    expect(() => regionAct(s, ctx, { type: "SET_AUTO_FUEL", fuel: "gas", enabled: false })).toThrow(/finished/);
  });

  it("Economy Lab compares strategies deterministically", () => {
    const a = runRegionLab("gas_heavy", 5, 2);
    const b = runRegionLab("solar_storage", 5, 2);
    expect(a.frames.length).toBe(60);
    expect(runRegionLab("gas_heavy", 5, 2).traceHash).toBe(a.traceHash);
    expect(a.traceHash).not.toBe(b.traceHash);
    expect(b.emissionsT).toBeLessThan(a.emissionsT);
  });

  it("never goes quiet: once the first minute is done an incident comes at least every INCIDENT_GAP intervals", () => {
    const s = createRegion({ regionId: "news", seed: 21 });
    s.onboarding.done = true;
    const ctx = newRCtx();
    for (let i = 0; i < 700; i++) regionTick(s, ctx);
    const kinds = new Set(["HEATWAVE", "STORM", "PLANT_TRIPPED", "SUPPLY_DISRUPTION"]);
    const at = [0, ...ctx.events.filter((e) => kinds.has(e.type) && e.interval > 1).map((e) => e.interval)];
    expect(at.length).toBeGreaterThanOrEqual(4);
    for (let k = 1; k < at.length; k++) expect(at[k] - at[k - 1]).toBeLessThanOrEqual(region.INCIDENT_GAP + 6);
  });

  it("exposes all four rival generators in Who's Who with live ledger cash and capacity", () => {
    const s = createRegion({ regionId: "rivals", seed: 14 });
    const v = toRegionView(s);
    expect(v.rivals.map((r) => r.ownerId)).toEqual(["voltline", "northwind", "eastbank", "harbor_diesel"]);
    expect(v.rivals.map((r) => r.person)).toEqual(["Victor Lane", "Hanna Lindqvist", "Omar Haddad", "Gus Moreau"]);
    for (const r of v.rivals) {
      expect(r.cashCc).toBe(rbal(s, "cc", RACC.owner(r.ownerId)));
      expect(r.capacityKw).toBeGreaterThan(0);
      expect(r.quote.length).toBeGreaterThan(10);
    }
  });

  it("Hot Desk calls are deterministic, conserve every asset, verify across epochs, and stay out of weekly challenges", () => {
    const script: Record<number, AnyRegionAction[]> = {
      ...ONBOARD,
      20: [{ type: "ANSWER_HOT_DESK", callId: "petrov_stabilizer", choice: "accept" }],
      56: [{ type: "ANSWER_HOT_DESK", callId: "marta_furnace_retainer", choice: "accept" }],
      98: [{ type: "ANSWER_HOT_DESK", callId: "delgado_cold_berth", choice: "accept" }],
      146: [{ type: "ANSWER_HOT_DESK", callId: "obi_night_market", choice: "decline" }],
    };
    const a = run(19, 180, script).s;
    const b = run(19, 180, script).s;
    expect(sha256(canonical(a))).toBe(sha256(canonical(b)));
    expect(a.hotDesk?.resolved).toEqual([
      "petrov_stabilizer",
      "marta_furnace_retainer",
      "delgado_cold_berth",
      "obi_night_market",
    ]);
    for (const asset of ["cc", "gas", "diesel", "permit", "cert", "steel", "parts"] as const) {
      expect(rsum(a, asset)).toBe(0);
    }
    for (const [acct, val] of Object.entries(a.balances.cc)) {
      if (!acct.startsWith("ext:")) expect(val).toBeGreaterThanOrEqual(0);
    }
    for (const e of a.epochs) {
      expect(verifyEpoch(e)).toBe(true);
      expect(e.transfers.reduce((sum, t) => sum + t.deltaCc, 0)).toBe(0);
    }

    // Weekly challenge runs never spawn or accept Hot Desk calls
    const ch = createRegion({ regionId: "ch-hd", seed: 19, mode: "challenge" });
    const ctx = newRCtx();
    for (let i = 0; i < 60; i++) regionTick(ch, ctx);
    expect(toRegionView(ch).hotDesk).toBeNull();
    expect(() => regionAct(ch, ctx, { type: "ANSWER_HOT_DESK", callId: "petrov_stabilizer", choice: "accept" })).toThrow(/disabled/);
  });
});
