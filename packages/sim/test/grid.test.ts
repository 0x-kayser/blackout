import { describe, expect, it } from "vitest";
import { companyTick, districtFeeder, stageOf, stageReached } from "../src/company.ts";
import { fuelPerTick } from "../src/electricity.ts";
import { ACC, sumAsset, transfer } from "../src/ledger.ts";
import { newCtx } from "../src/state.ts";
import { toPublic } from "../src/view.ts";
import { act, newRun } from "./helpers.ts";

const grant = (s: ReturnType<typeof newRun>["s"], cc: number) => transfer(s, newCtx(s), "credits_cc", ACC.genesis, ACC.player, cc, "test_grant");

describe("company stages replace days", () => {
  it("grows by energy delivered and districts connected, pays a Council grant once, and never shows a day number as progress", () => {
    const { s } = newRun(7, { mode: "play" });
    expect(stageReached(s)).toBe(1);
    s.generators.gen_1.cumulativeWh = 25_000;
    const ctx = newCtx(s);
    const cash = s.balances.credits_cc.player;
    companyTick(s, ctx);
    expect(stageOf(s)).toBe(2);
    expect(s.balances.credits_cc.player).toBe(cash + 10_000);
    expect(ctx.events.find((e) => e.type === "STAGE_REACHED")?.explanation).toMatch(/Neighbourhood Utility/);
    companyTick(s, ctx);
    expect(ctx.events.filter((e) => e.type === "STAGE_REACHED")).toHaveLength(1);
    // VoltLine grows with the city
    expect(s.rival.ratedW).toBe(14_000);
    expect(toPublic(s).company).toMatchObject({ stage: 2, name: "Neighbourhood Utility", nextStage: { stage: 3 } });
    expect(sumAsset(s, "credits_cc")).toBe(0);
  });

  it("opens districts by stage, not by date", () => {
    const { s } = newRun(8, { mode: "play" });
    grant(s, 2_000_000);
    expect(() => act(s, { type: "UNLOCK_DISTRICT", districtId: "riverside" })).toThrow(/Neighbourhood Utility \(stage 2\)/);
    s.company = { stage: 2 };
    act(s, { type: "UNLOCK_DISTRICT", districtId: "riverside" });
    expect(s.districts.riverside).toMatchObject({ unlocked: true, substationLevel: 1 });
    expect(() => act(s, { type: "UNLOCK_DISTRICT", districtId: "downtown" })).toThrow(/stage 4/);
    expect(() => act(s, { type: "BUY_UPGRADE", upgradeId: "diesel_20kw" })).toThrow(/stage 3/);
  });
});

describe("distribution: substations, feeders and line losses", () => {
  it("a feeder caps the load you can carry into a district until its substation is upgraded", () => {
    const { s } = newRun(9, { mode: "play" });
    grant(s, 2_000_000);
    act(s, { type: "BUY_UPGRADE", upgradeId: "diesel_5kw" });
    const mq = s.districts.market_quarter;
    expect(districtFeeder(mq)).toMatchObject({ level: 1, capacityW: 6_000, nextCapacityW: 12_000 });
    // two big contracts into the Market Quarter: 5 kW + 5 kW on a 6 kW feeder
    const mk = (id: string, biz: string) => {
      s.requests[id] = { requestId: id, waveId: "w", businessId: biz, districtId: "market_quarter", requestedW: 5_000, durationHours: 1, offerRateCcPerKwh: 800, counterCount: 0, maxCounters: 2, lastPlayerCounterCcPerKwh: null, status: "open", createdTick: s.tick, deadlineTick: null, day: s.day, message: "", resolutionReason: null };
      s.businesses[biz].activeContractId = null;
      s.businesses[biz].outageUntilTick = s.tick + 100;
      return act(s, { type: "ACCEPT_REQUEST", requestId: id }).result.contractId as string;
    };
    const c1 = mk("r1", "cold_room");
    if (s.contracts[c1].status === "pending_assignment") act(s, { type: "ASSIGN_CONTRACT", contractId: c1, generatorId: "gen_1" });
    expect(s.contracts[c1].status).toBe("active");
    // you can't even take the call: the feeder is the limit, not the generator
    expect(() => mk("r2", "bakery")).toThrow(/Market Quarter feeder carries 5.0 of 6.0 kW/);
    act(s, { type: "UPGRADE_SUBSTATION", districtId: "market_quarter" });
    expect(districtFeeder(mq).capacityW).toBe(12_000);
    s.requests.r2.status = "open";
    const c2 = act(s, { type: "ACCEPT_REQUEST", requestId: "r2" }).result.contractId as string;
    act(s, { type: "ASSIGN_CONTRACT", contractId: c2, generatorId: "gen_2" });
    expect(toPublic(s).districts.find((d) => d.districtId === "market_quarter")).toMatchObject({ feederLoadW: 10_000, feederCapacityW: 12_000, substationLevel: 2 });
  });

  it("longer feeders lose energy: the same load burns more diesel in a distant district", () => {
    const { s } = newRun(10, { mode: "play" });
    const base = { contractId: "c", requestId: "r", generatorId: "gen_1", provider: "player" as const, allottedW: 4_000 } as never;
    const near = fuelPerTick(s, { ...(base as object), businessId: "cold_room" } as never);
    const far = fuelPerTick(s, { ...(base as object), businessId: "textile_mill" } as never);
    expect(far).toBeGreaterThan(near);
    expect(far).toBe(Math.ceil((near * 10_900) / 10_000)); // Industrial Park: 9% line loss
  });
});

describe("a big, busy city", () => {
  it("has dozens of buildings to power, each run by a named person", () => {
    const { s } = newRun(11, { mode: "play" });
    const view = toPublic(s);
    expect(view.businesses.length).toBeGreaterThanOrEqual(44);
    expect(view.businesses.every((b) => b.owner && b.owner.name.length > 1)).toBe(true);
    expect(view.districts.reduce((a, d) => a + d.totalDemandW, 0)).toBeGreaterThan(150_000);
  });

  it("market flashes hit every few seconds in a living city, and merchants reprice in response", async () => {
    const { ticks } = await import("./helpers.ts");
    const { s } = newRun(12, { mode: "play", worldMode: "living" });
    const events = ticks(s, 480);
    const flashes = events.filter((e) => e.type === "WORLD_EVENT_STARTED" && s.worldEvents!.history.concat(s.worldEvents!.active).some((w) => w.eventId === e.data.worldEventId && w.flash));
    expect(flashes.length).toBeGreaterThanOrEqual(6);
    // flashes are short: none outlives two and a half minutes
    for (const w of s.worldEvents!.history.filter((x) => x.flash)) expect(w.endTick - w.startTick).toBeLessThanOrEqual(150);
    expect(events.filter((e) => e.type === "MERCHANT_REPRICED").length).toBeGreaterThan(flashes.length);
  });
});
