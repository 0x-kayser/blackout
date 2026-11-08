/**
 * Fast-forward / Observatory replay. Runs the EXACT same engine as live play
 * with a virtual clock and a scripted player-policy bot. Results depend only on
 * (seed, scenarioId, scenarioVersion, policyId, days): no wall clock, no oil feed,
 * no LLM, no RPC. All trades are game-ledger only (`replay_simulation`).
 */
import { createHash } from "node:crypto";
import type { EconomyEvent, LabCondition, LedgerEntry, PlayerAction, ReplayDay, ReplayPolicyId, ReplaySummary } from "@blackout/shared";
import { worldModifiers } from "./world-events/engine.ts";
import { applyAction, createInitialState, tickMut } from "./engine.ts";
import { toPublic } from "./view.ts";
import { campaignSummary } from "./economy.ts";
import { ACC, bal } from "./ledger.ts";
import { PLAYER_POLICIES } from "./policies/playerBots.ts";
import { newCtx, SimError, type SimState } from "./state.ts";

export interface ReplayInput {
  seed: number;
  scenarioId?: "starter" | "fuel_squeeze" | "oil_shock_2026";
  policyId: ReplayPolicyId;
  days?: number;
  /** World condition: a fixed event schedule, "historical" (EIA-sourced notes) or "calm". */
  condition?: LabCondition;
}

export interface ReplayTrace {
  summary: ReplaySummary;
  events: EconomyEvent[];
  ledger: LedgerEntry[];
  actions: { tick: number; action: PlayerAction; ok: boolean; code?: string }[];
  finalState: SimState;
}

export const replayId = (i: ReplayInput) => `rp_${i.scenarioId ?? "starter"}_${i.condition ?? "calm"}_${i.policyId}_${i.days ?? 7}_${i.seed}`;

function dayRow(s: SimState, generationWh: { diesel: number; solar: number; battery: number }): ReplayDay {
  const r = s.dayReports[s.dayReports.length - 1];
  return {
    day: r.day,
    playerCashCc: bal(s, "credits_cc", ACC.player),
    playerFuelMl: bal(s, "fuel_ml", ACC.player),
    permitAllowanceMg: bal(s, "permit_mg", ACC.player),
    revenueCc: r.revenueCc,
    reliabilityBps: r.reliabilityBps,
    gdpCc: r.gdpCc,
    oilIndexCenti: r.oilIndexCenti,
    merchantPrices: Object.fromEntries(Object.values(s.merchants).map((m) => [m.merchantId, m.quoteCcPerL])),
    merchantStockMl: Object.fromEntries(Object.values(s.merchants).map((m) => [m.merchantId, bal(s, "fuel_ml", ACC.merchant(m.merchantId))])),
    rivalTariffCcPerKwh: s.rival.tariffCcPerKwh,
    rivalCashCc: bal(s, "credits_cc", ACC.rival),
    openBusinesses: Object.values(s.businesses).filter((b) => s.districts[b.districtId].unlocked && b.status !== "closed").length,
    closures: [...r.closures],
    generationMixWh: generationWh,
    businessCashCc: Object.fromEntries(Object.values(s.businesses).filter((b) => s.districts[b.districtId].unlocked).map((b) => [b.businessId, bal(s, "credits_cc", ACC.business(b.businessId))])),
    merchantCashCc: Object.fromEntries(Object.values(s.merchants).map((m) => [m.merchantId, bal(s, "credits_cc", ACC.merchant(m.merchantId))])),
    playerCo2Mg: s.player.co2TotalMg,
    importCapacityBps: worldModifiers(s).importCapacityBps,
    activeWorldEvents: (s.worldEvents?.active ?? []).map((e) => ({ headline: e.headline, verification: e.verification })),
    rivalSolarW: s.rival.solarW ?? 0,
  };
}

/** Stable hash over the normalised trace (serverTime is never part of it). */
export function traceHash(events: EconomyEvent[], ledger: LedgerEntry[]): string {
  const h = createHash("sha256");
  for (const e of events) {
    const { serverTime: _st, ...rest } = e;
    h.update(JSON.stringify(rest));
    h.update("\n");
  }
  for (const l of ledger) {
    h.update(JSON.stringify(l));
    h.update("\n");
  }
  return h.digest("hex");
}

export function runReplay(input: ReplayInput): ReplayTrace {
  const t0 = Date.now();
  const days = input.days ?? 7;
  const scenarioId = input.scenarioId ?? "starter";
  const condition = input.condition ?? "calm";
  const policy = PLAYER_POLICIES[input.policyId];
  if (!policy) throw new SimError("VALIDATION_FAILED", `unknown policy ${input.policyId}`);
  const created = createInitialState({
    runId: replayId({ ...input, scenarioId, days, condition }),
    ownerId: "observatory",
    worldMode: condition === "historical" ? "historical" : condition === "calm" ? "calm" : "scenario",
    worldPreset: condition === "historical" || condition === "calm" ? null : condition,
    // historical window: start at the week of 2026-03-23 so the 7 days include EIA's April 7 outlook
    oilDayOffset: condition === "historical" && scenarioId === "oil_shock_2026" ? 12 : 0,
    seed: input.seed,
    scenarioId,
    mode: "replay",
    chainMode: "disabled",
    campaignDays: days,
  });
  let s = created.state;
  const events: EconomyEvent[] = [...created.events];
  const ledger: LedgerEntry[] = [...created.ledger];
  const actions: ReplayTrace["actions"] = [];
  const daily: ReplayDay[] = [];
  let guard = 0;
  while (s.phase !== "finished" && guard++ < 20_000) {
    const pub = toPublic(s);
    const phaseBefore = `${s.day}:${s.phase}`;
    const wanted = policy.bot(pub);
    for (let i = 0; i < wanted.length; i++) {
      const action = wanted[i];
      try {
        const out = applyAction(s, action, { idempotencyKey: `bot-${s.tick}-${i}`, chainLeg: false });
        s = out.state;
        events.push(...out.events);
        ledger.push(...out.ledger);
        actions.push({ tick: s.tick, action, ok: true });
      } catch (e) {
        if (!(e instanceof SimError)) throw e;
        actions.push({ tick: s.tick, action, ok: false, code: e.code });
      }
    }
    void phaseBefore;
    const reports = s.dayReports.length;
    const lastDay = s.day;
    const gen = { ...s.dayStats.generationWh };
    const ctx = newCtx(s);
    tickMut(s, ctx);
    events.push(...ctx.events);
    ledger.push(...ctx.ledger);
    if (s.dayReports.length > reports || s.day !== lastDay || (s.phase === "finished" && daily.length < days)) daily.push(dayRow(s, gen));
  }
  const sum = campaignSummary(s);
  const summary: ReplaySummary = {
    replayId: replayId({ ...input, scenarioId, days, condition }),
    seed: input.seed,
    scenarioId,
    scenarioVersion: s.scenarioVersion,
    policyId: input.policyId,
    days,
    condition,
    source: "replay_simulation",
    label: "SIMULATED FUTURE SCENARIO — no blockchain settlement",
    eventCount: events.length,
    traceHash: traceHash(events, ledger),
    wallMs: Date.now() - t0,
    daily,
    final: {
      netWorthCc: sum.netWorthCc,
      reliabilityBps: sum.reliabilityBps,
      cityGdpCc: sum.cityGdpCc,
      closures: s.totals.closures,
      score: sum.score,
    },
  };
  return { summary, events, ledger, actions, finalState: s };
}
