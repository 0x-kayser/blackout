/**
 * Economy Lab (§31): the same region, the same seed, two strategies, seven game days, in about a second.
 * "gas_heavy" spends on turbines; "solar_storage" spends on panels and batteries. Same world, same events.
 */
import { CHALLENGE_SNAPSHOT, INTERVALS_PER_DAY, TECHS, steelForCc } from "./config.ts";
import { createRegion, regionAct, regionScore, regionTick } from "./engine.ts";
import { canonical, sha256 } from "./settlement.ts";
import { newRCtx, rbal, RACC, type RegionState } from "./state.ts";

export type RegionLabStrategy = "gas_heavy" | "solar_storage";

export interface RegionLabResult {
  strategy: RegionLabStrategy;
  days: number;
  seed: number;
  profitCc: number;
  cashCc: number;
  unservedMWh: number;
  emissionsT: number;
  avgPriceCcPerMWh: number;
  regionOutputBps: number;
  score: number;
  /** 60 frames for a 60-second replay. */
  frames: { interval: number; label: string; demandKw: number; availableKw: number; shedKw: number; priceCcPerMWh: number; playerKw: number; cashCc: number }[];
  events: { interval: number; title: string; severity: string }[];
  traceHash: string;
}

const PLANS: Record<RegionLabStrategy, { tech: "ocgt" | "diesel" | "solar" | "battery"; nodeId: "residential_east" | "central_city" | "north_solar" | "industrial_south"; size: number }[]> = {
  gas_heavy: [
    { tech: "ocgt", nodeId: "central_city", size: 0 },
    { tech: "diesel", nodeId: "residential_east", size: 1 },
    { tech: "ocgt", nodeId: "residential_east", size: 0 },
  ],
  solar_storage: [
    { tech: "battery", nodeId: "residential_east", size: 1 },
    { tech: "solar", nodeId: "central_city", size: 1 },
    { tech: "battery", nodeId: "central_city", size: 0 },
  ],
};

export function runRegionLab(strategy: RegionLabStrategy, seed = 42, days = 7): RegionLabResult {
  const s: RegionState = createRegion({ regionId: `lab-${strategy}-${seed}`, seed, mode: "live", snapshot: CHALLENGE_SNAPSHOT });
  const ctx = newRCtx(10);
  const act = (a: Parameters<typeof regionAct>[2]) => {
    try {
      regionAct(s, ctx, a);
    } catch {
      /* the plan skips what it can't afford */
    }
  };
  act({ type: "SET_PLANT_ONLINE", plantId: "kestrel", online: true });
  act({ type: "SET_BATTERY_MODE", plantId: "eastside", mode: "auto" });
  act({ type: "TAKE_LOAN", bankId: "vesper_savings", amountCc: 30_000_000 });
  // steel for the plan, bought at Vesper Market's outside price
  const steel = PLANS[strategy].reduce((a, p) => a + steelForCc(TECHS[p.tech].sizes[p.size].costCc), 0);
  act({ type: "TOWN_SETTLE", ref: "lab-steel", reason: "steel for the plan", cc: -steel * 25_000, items: { "material:steel": steel } });
  for (const step of PLANS[strategy]) act({ type: "BUILD_PLANT", ...step });
  const total = days * INTERVALS_PER_DAY;
  const every = Math.max(1, Math.floor(total / 60));
  const frames: RegionLabResult["frames"] = [];
  const events: RegionLabResult["events"] = [];
  const h = sha256;
  let trace = "";
  for (let i = 0; i < total; i++) {
    ctx.events.length = 0;
    regionTick(s, ctx);
    for (const e of ctx.events) if (e.severity !== "info") events.push({ interval: e.interval, title: e.title, severity: e.severity });
    const last = s.history[s.history.length - 1];
    if (i % every === 0 && frames.length < 60) {
      const day = Math.floor(i / INTERVALS_PER_DAY) + 1;
      frames.push({ interval: s.interval, label: `Day ${day}`, demandKw: last.demandKw, availableKw: last.availableKw, shedKw: last.shedKw, priceCcPerMWh: last.priceCcPerMWh, playerKw: last.playerKw, cashCc: rbal(s, "cc", RACC.player) });
    }
    if (i % 48 === 0) trace = h(trace + canonical([last, rbal(s, "cc", RACC.player)]));
  }
  const sc = regionScore(s);
  const prices = s.history.map((x) => x.priceCcPerMWh);
  return {
    strategy,
    days,
    seed,
    profitCc: sc.profitCc,
    cashCc: rbal(s, "cc", RACC.player),
    unservedMWh: sc.unservedMWh,
    emissionsT: sc.emissionsT,
    avgPriceCcPerMWh: Math.round(prices.reduce((a, b) => a + b, 0) / Math.max(1, prices.length)),
    regionOutputBps: sc.regionOutputBps,
    score: sc.score,
    frames,
    events: events.slice(-40),
    traceHash: trace,
  };
}
