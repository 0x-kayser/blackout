import { describe, expect, it } from "vitest";
import { GameStatePublicSchema, PERMIT_MG, co2MgForFuelMl, fuelMlForWh } from "@blackout/shared";
import { applyAction, createInitialState, nextState, tick } from "../src/engine.ts";
import { toPublic } from "../src/view.ts";
import { ACC, bal, sumAsset, transfer } from "../src/ledger.ts";
import { TIMING } from "../src/config.ts";
import { newCtx, SimError } from "../src/state.ts";
import { act, newRun, openRequests, ticks, until } from "./helpers.ts";

describe("starting state", () => {
  it("matches the starting kit", () => {
    const { s } = newRun();
    expect(bal(s, "credits_cc", ACC.player)).toBe(100_000);
    expect(bal(s, "fuel_ml", ACC.player)).toBe(20_000);
    expect(s.player.tankCapacityMl).toBe(60_000);
    expect(bal(s, "permit_mg", ACC.player)).toBe(6 * PERMIT_MG);
    expect(s.generators.gen_1.ratedW).toBe(5_000);
    expect(s.player.unlockedDistrictIds).toEqual(["market_quarter"]);
    const mq = Object.values(s.businesses).filter((b) => b.districtId === "market_quarter");
    expect(mq).toHaveLength(8);
    expect(mq.reduce((a, b) => a + b.demandW, 0)).toBe(6_900); // more than one 5 kW set and the 6 kW feeder can carry
    expect(s.phase).toBe("operating"); // Day 1 skips the morning market
  });

  it("public projection validates and hides RNG/internal state", () => {
    const { s } = newRun();
    const pub = toPublic(s);
    expect(() => GameStatePublicSchema.parse(pub)).not.toThrow();
    const json = JSON.stringify(pub);
    expect(json).not.toContain('"rng"');
    expect(json).not.toContain("balances");
  });
});

describe("unit math", () => {
  it("0.30 L/kWh and 2.68 kg CO2/L: 4 kW x 8 h = 32 kWh -> 9.6 L -> 25.728 kg", () => {
    const wh = 4_000 * 8;
    expect(fuelMlForWh(wh)).toBe(9_600);
    expect(co2MgForFuelMl(9_600)).toBe(25_728_000);
  });
});

describe("first 30 seconds: Cold Room tutorial", () => {
  it("first outage within 10 s, accept + assign lights the Cold Room and accounts exactly", () => {
    const { s } = newRun();
    const evs = ticks(s, 1);
    const req = openRequests(s)[0];
    expect(evs.find((e) => e.type === "OUTAGE_STARTED")!.tick).toBeLessThanOrEqual(10);
    expect(req.businessId).toBe("cold_room");
    expect(req.requestedW).toBe(1_500);
    expect(req.durationHours).toBe(2);
    expect(req.offerRateCcPerKwh).toBe(800);
    expect(req.deadlineTick).toBeNull(); // tutorial: no timer

    const fuel0 = bal(s, "fuel_ml", ACC.player);
    const cash0 = bal(s, "credits_cc", ACC.player);
    const { result } = act(s, { type: "ACCEPT_REQUEST", requestId: req.requestId });
    const contractId = result.contractId as string;
    expect(s.contracts[contractId].escrowCc).toBe(2_400); // 3 kWh x 8 credits
    expect(s.businesses.cold_room.powerSource).toBe("none"); // accepting alone does not restore power
    const assign = act(s, { type: "ASSIGN_CONTRACT", contractId, generatorId: "gen_1" });
    expect(assign.events.some((e) => e.type === "SERVICE_STARTED")).toBe(false); // only the sim tick confirms service
    const next = ticks(s, 1);
    expect(next.some((e) => e.type === "SERVICE_STARTED")).toBe(true);
    expect(s.businesses.cold_room.powerSource).toBe("player");
    ticks(s, 19);
    const c = s.contracts[contractId];
    expect(c.status).toBe("completed");
    expect(c.deliveredWh).toBe(3_000);
    expect(c.billedCc).toBe(2_400);
    expect(c.fuelUsedMl).toBe(900);
    expect(c.co2Mg).toBe(2_412_000);
    expect(fuel0 - bal(s, "fuel_ml", ACC.player)).toBe(900);
    expect(bal(s, "credits_cc", ACC.player) - cash0).toBe(2_400);
    expect(bal(s, "permit_mg", ACC.player)).toBe(60 * 1e6 - 2_412_000);
  });
});

describe("continuous world clock", () => {
  it("days roll over every 240 s without pausing play; 8 waves per day, forever", () => {
    const { s } = newRun();
    const log = { events: [] as any[], ledger: [] as any[] };
    ticks(s, 240, log);
    expect(s.day).toBe(2);
    expect(s.phase).toBe("operating"); // no morning market, no settlement screen
    const waves1 = log.events.filter((e) => e.type === "WAVE_STARTED" && e.day === 1);
    expect(waves1.map((e) => e.tick)).toEqual([0, 30, 60, 90, 120, 150, 180, 210]);
    expect(log.events.some((e) => e.type === "DAY_SETTLED" && e.day === 1)).toBe(true);
    ticks(s, 240 * 3, log);
    expect(s.day).toBe(5);
    expect(s.phase).toBe("operating");
    expect(s.finished).toBe(false);
    const waves4 = log.events.filter((e) => e.type === "WAVE_STARTED" && e.day === 4);
    expect(waves4.map((e) => e.tick - waves4[0].tick)).toEqual([0, 30, 60, 90, 120, 150, 180, 210]);
    expect(s.wavesTotal).toBe(32);
  });

  it("contracts carry across the daily rollover instead of being cut", () => {
    const { s } = newRun();
    ticks(s, 225);
    s.requests.req_mid = { requestId: "req_mid", waveId: "w", businessId: "bakery", districtId: "market_quarter", requestedW: 1_000, durationHours: 3, offerRateCcPerKwh: 800, counterCount: 0, maxCounters: 2, lastPlayerCounterCcPerKwh: null, status: "open", createdTick: s.tick, deadlineTick: null, day: s.day, message: "", resolutionReason: null };
    s.businesses.bakery.activeContractId = null;
    s.businesses.bakery.outageUntilTick = null;
    const id = act(s, { type: "ACCEPT_REQUEST", requestId: "req_mid", generatorId: "gen_1" }).result.contractId as string;
    ticks(s, 30);
    expect(s.day).toBe(2);
    const c = s.contracts[id];
    expect(c.status).toBe("completed");
    expect(c.deliveredWh).toBe(3_000);
    expect(c.failureReason).toBeNull();
  });

  it("market, upgrades and servicing are available mid-day; the world keeps running", () => {
    const { s } = newRun();
    ticks(s, 50);
    const q = act(s, { type: "REQUEST_QUOTE", sellerId: "merchant:ember", item: "diesel", quantity: 5_000 }).result.quoteId as string;
    act(s, { type: "BUY", quoteId: q, quantity: 5_000 });
    expect(s.phase).toBe("operating");
    expect(() => act(s, { type: "READY" })).toThrowError(expect.objectContaining({ code: "INVALID_PHASE" }));
    const before = s.tick;
    ticks(s, 1);
    expect(s.tick).toBe(before + 1);
  });

  it("tutorial customers wait (no timer) beyond their outage length, then service ends the outage", () => {
    const { s } = newRun();
    ticks(s, 1);
    const req = openRequests(s)[0];
    ticks(s, 40); // 4 game hours: a timed 2 h outage would already be over
    expect(s.businesses.cold_room.powerSource).toBe("none");
    expect(s.requests[req.requestId].status).toBe("open");
    const id = act(s, { type: "ACCEPT_REQUEST", requestId: req.requestId, generatorId: "gen_1" }).result.contractId as string;
    ticks(s, 21);
    expect(s.contracts[id].status).toBe("completed");
    ticks(s, 1);
    expect(s.businesses.cold_room.powerSource).toBe("grid");
  });

  it("an ignored tutorial request lapses when the grid returns (bounded patience)", () => {
    const { s } = newRun();
    ticks(s, 1);
    const req = openRequests(s)[0];
    ticks(s, 65);
    expect(s.requests[req.requestId].status).toBe("expired");
    expect(s.businesses.cold_room.powerSource).toBe("grid");
  });

  it("difficulty grows with progress: tutorial waves have one untimed request", () => {
    const { s } = newRun();
    const log = { events: [] as any[], ledger: [] as any[] };
    ticks(s, 91, log);
    const req = log.events.filter((e) => e.type === "CUSTOMER_REQUESTED");
    const first3 = req.filter((e) => e.tick < 90);
    expect(first3.every((e) => e.data.deadlineTick === null)).toBe(true);
    expect(new Set(first3.map((e) => e.tick)).size).toBe(first3.length); // one per wave
  });
});

describe("capacity and resources", () => {
  function contractFor(s: any, businessId: string, w: number, hours: number) {
    // inject a request directly to test dispatch rules in isolation
    const req = {
      requestId: `req_t_${businessId}`,
      waveId: "wave_test",
      businessId,
      districtId: "market_quarter",
      requestedW: w,
      durationHours: hours,
      offerRateCcPerKwh: 800,
      counterCount: 0,
      maxCounters: 2,
      lastPlayerCounterCcPerKwh: null,
      status: "open" as const,
      createdTick: s.tick,
      deadlineTick: null,
      day: s.day,
      message: "",
      resolutionReason: null,
    };
    s.requests[req.requestId] = req;
    return req;
  }

  it("overlapping contracts: capacity counts ALL active assignments; rejection burns no fuel", () => {
    const { s } = newRun();
    ticks(s, 1);
    const a = contractFor(s, "bakery", 3_000, 3);
    const c1 = act(s, { type: "ACCEPT_REQUEST", requestId: a.requestId, generatorId: "gen_1" }).result.contractId;
    expect(s.contracts[c1 as string].status).toBe("active");
    const b = contractFor(s, "pharmacy", 2_500, 2);
    const fuel = bal(s, "fuel_ml", ACC.player);
    expect(() => act(s, { type: "ACCEPT_REQUEST", requestId: b.requestId })).toThrowError(expect.objectContaining({ code: "CAPACITY_EXCEEDED" }));
    expect(bal(s, "fuel_ml", ACC.player)).toBe(fuel);
    expect(s.requests[b.requestId].status).toBe("open");
  });

  it("fuel reserved by active contracts cannot be promised twice", () => {
    const { s } = newRun();
    ticks(s, 1);
    // leave 1.5 L in the tank
    const ctx = newCtx(s);
    transfer(s, ctx, "fuel_ml", ACC.player, ACC.fuelBurned, bal(s, "fuel_ml", ACC.player) - 1_500, "test_drain");
    const a = contractFor(s, "bakery", 1_000, 3); // needs 0.9 L
    act(s, { type: "ACCEPT_REQUEST", requestId: a.requestId, generatorId: "gen_1" });
    const b = contractFor(s, "pharmacy", 1_000, 3); // needs 0.9 L, only 0.6 L free
    expect(() => act(s, { type: "ACCEPT_REQUEST", requestId: b.requestId })).toThrowError(expect.objectContaining({ code: "INSUFFICIENT_FUEL" }));
  });

  it("permit allowance is a hard cap: no assignment without allowance, delivery stops when it runs out", () => {
    const { s } = newRun();
    ticks(s, 1);
    const ctx = newCtx(s);
    transfer(s, ctx, "permit_mg", ACC.player, ACC.permitsRetired, bal(s, "permit_mg", ACC.player) - 1_000_000, "test_drain");
    const a = contractFor(s, "bakery", 1_000, 1); // needs 0.3 L -> 0.804 kg OK
    const id = act(s, { type: "ACCEPT_REQUEST", requestId: a.requestId, generatorId: "gen_1" }).result.contractId as string;
    const b = contractFor(s, "pharmacy", 1_000, 1); // another 0.804 kg: not available
    expect(() => act(s, { type: "ACCEPT_REQUEST", requestId: b.requestId })).toThrowError(expect.objectContaining({ code: "INSUFFICIENT_PERMITS" }));
    // now drain allowance mid-contract: service must drop and refund only the unserved part
    ticks(s, 3);
    transfer(s, newCtx(s), "permit_mg", ACC.player, ACC.permitsRetired, bal(s, "permit_mg", ACC.player), "test_drain");
    const evs = ticks(s, 1);
    const c = s.contracts[id];
    expect(c.status).toBe("failed");
    expect(c.failureReason).toBe("INSUFFICIENT_PERMITS");
    expect(evs.some((e) => e.type === "CONTRACT_FAILED")).toBe(true);
    expect(c.billedCc + c.refundedCc).toBe(800); // 1 kWh x 8 credits escrow fully accounted
    expect(c.billedCc).toBe(Math.floor((c.deliveredWh * 800) / 1000));
    expect(bal(s, "permit_mg", ACC.player)).toBe(0); // never negative
  });

  it("cancel refunds only unearned escrow", () => {
    const { s } = newRun();
    ticks(s, 1);
    const req = openRequests(s)[0];
    const id = act(s, { type: "ACCEPT_REQUEST", requestId: req.requestId, generatorId: "gen_1" }).result.contractId as string;
    ticks(s, 5);
    act(s, { type: "CANCEL_CONTRACT", contractId: id });
    const c = s.contracts[id];
    expect(c.deliveredWh).toBe(750);
    expect(c.billedCc).toBe(600);
    expect(c.refundedCc).toBe(1_800);
    expect(s.businesses.cold_room.activeContractId).toBeNull();
  });
});

describe("negotiation", () => {
  it("counter: max two rounds, customer counters from its own margin, then walks", () => {
    const { s } = newRun();
    until(s, (x) => x.day === 1 && x.waveIndex >= 4 && openRequests(x).some((r) => r.deadlineTick !== null));
    const r = openRequests(s).find((r) => r.deadlineTick !== null)!;
    const first = act(s, { type: "COUNTER_REQUEST", requestId: r.requestId, rateCcPerKwh: 2_500 });
    expect(first.result.accepted).toBe(false);
    expect(s.requests[r.requestId].status).toBe("customer_countered");
    const second = act(s, { type: "COUNTER_REQUEST", requestId: r.requestId, rateCcPerKwh: 2_500 });
    expect(second.result.rejected).toBe(true);
    expect(() => act(s, { type: "COUNTER_REQUEST", requestId: r.requestId, rateCcPerKwh: 900 })).toThrow(SimError);
  });

  it("non-tutorial requests expire after 10 s and then cannot be accepted", () => {
    const { s } = newRun();
    until(s, (x) => x.waveIndex >= 4 && openRequests(x).some((r) => r.deadlineTick !== null));
    const r = openRequests(s).find((r) => r.deadlineTick !== null)!;
    expect(r.deadlineTick).toBe(r.createdTick + 10);
    ticks(s, 10);
    expect(s.requests[r.requestId].status).toBe("expired");
    expect(() => act(s, { type: "ACCEPT_REQUEST", requestId: r.requestId })).toThrowError(expect.objectContaining({ code: "REQUEST_EXPIRED" }));
  });
});

describe("heat", () => {
  it("stage 2+: sustained >90% load breaks the set, its contracts fail and refund", () => {
    const { s } = newRun();
    until(s, (x) => x.day === 2 && x.phase === "operating");
    s.company = { stage: 2 }; // generators run hot once the company has grown
    // inject a 5 kW load for 3 h (100% load)
    s.requests.req_heat = { requestId: "req_heat", waveId: "w", businessId: "cold_room", districtId: "market_quarter", requestedW: 5_000, durationHours: 3, offerRateCcPerKwh: 800, counterCount: 0, maxCounters: 2, lastPlayerCounterCcPerKwh: null, status: "open", createdTick: s.tick, deadlineTick: null, day: s.day, message: "", resolutionReason: null };
    s.businesses.cold_room.activeContractId = null;
    s.businesses.cold_room.outageUntilTick = null;
    for (const c of Object.values(s.contracts)) if (c.status === "active" && c.provider === "player") c.status = "completed";
    const id = act(s, { type: "ACCEPT_REQUEST", requestId: "req_heat", generatorId: "gen_1" }).result.contractId as string;
    const evs = ticks(s, 12);
    expect(evs.some((e) => e.type === "OVERHEAT_WARNING")).toBe(true);
    expect(evs.some((e) => e.type === "GENERATOR_BROKEN")).toBe(true);
    expect(s.generators.gen_1.status).toBe("broken");
    expect(s.contracts[id].status).toBe("failed");
    expect(s.contracts[id].refundedCc).toBeGreaterThan(0);
    const fuel = bal(s, "fuel_ml", ACC.player);
    ticks(s, 5);
    expect(bal(s, "fuel_ml", ACC.player)).toBe(fuel); // broken set burns nothing
  });

  it("day 1 has no heat", () => {
    const { s } = newRun();
    ticks(s, 100);
    expect(s.generators.gen_1.heatPermille).toBe(0);
  });
});

describe("purity", () => {
  it("applyAction / tick / nextState never mutate their input", () => {
    const { state } = createInitialState({ runId: "p", ownerId: "o", seed: 7 });
    const snap = JSON.stringify(state);
    tick(state);
    const t = tick(state).state;
    const req = Object.values(t.requests)[0];
    applyAction(t, { type: "ACCEPT_REQUEST", requestId: req.requestId }, { idempotencyKey: "abcdefgh" });
    nextState(state, []);
    expect(JSON.stringify(state)).toBe(snap);
  });

  it("nextState applies actions then one tick and reports failures without applying them", () => {
    const { state } = createInitialState({ runId: "p", ownerId: "o", seed: 7 });
    const t = tick(state).state;
    const req = Object.values(t.requests)[0];
    const out = nextState(t, [
      { action: { type: "ACCEPT_REQUEST", requestId: req.requestId, generatorId: "gen_1" }, meta: { idempotencyKey: "abcdefgh" } },
      { action: { type: "ACCEPT_REQUEST", requestId: req.requestId }, meta: { idempotencyKey: "abcdefgi" } },
    ]);
    expect(out.results[0].ok).toBe(true);
    expect(out.results[1]).toMatchObject({ ok: false, code: "ALREADY_PROCESSED" });
    expect(out.state.tick).toBe(t.tick + 1);
    expect(out.events.some((e) => e.type === "SERVICE_STARTED")).toBe(true);
  });
});

describe("ledger conservation across a full campaign", () => {
  it("sum of every asset stays 0 and no private account goes negative", () => {
    const { s } = newRun(99);
    ticks(s, 240 * 4);
    for (const asset of ["credits_cc", "fuel_ml", "permit_mg"] as const) {
      expect(sumAsset(s, asset)).toBe(0);
      for (const [acct, v] of Object.entries(s.balances[asset])) if (!acct.startsWith("world:")) expect(v).toBeGreaterThanOrEqual(0);
    }
  });
});
