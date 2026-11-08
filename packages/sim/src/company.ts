/**
 * Company stages: the business grows from a street generator to the city's grid operator.
 * Progress is measured in what the player has built and delivered, never in days:
 * lifetime energy delivered, districts connected and installed capacity.
 */
import { DISTRICTS, RIVAL, STAGES } from "./config.ts";
import { ACC, transfer } from "./ledger.ts";
import { cr, emit, type Ctx, type DistrictState, type SimState } from "./state.ts";

export const playerDeliveredWh = (s: SimState) =>
  s.player.generatorIds.reduce((a, id) => a + (s.generators[id]?.cumulativeWh ?? 0), 0);
export const connectedDistricts = (s: SimState) => Object.values(s.districts).filter((d) => d.unlocked).length;
export const installedCapacityW = (s: SimState) => s.player.generatorIds.reduce((a, id) => a + (s.generators[id]?.ratedW ?? 0), 0);

/** The highest stage whose requirements are all met. */
export function stageReached(s: SimState): number {
  const wh = playerDeliveredWh(s);
  const districts = connectedDistricts(s);
  const cap = installedCapacityW(s);
  let stage = 1;
  for (const st of STAGES) if (wh >= st.needWh && districts >= st.needDistricts && cap >= st.needCapacityW) stage = st.stage;
  return stage;
}

/** Current stage as recorded on the run (stages never go down). */
export const stageOf = (s: SimState) => s.company?.stage ?? 1;

export function companyView(s: SimState) {
  const stage = stageOf(s);
  const cur = STAGES[stage - 1];
  const next = STAGES[stage] ?? null;
  const wh = playerDeliveredWh(s);
  const districts = connectedDistricts(s);
  const cap = installedCapacityW(s);
  const parts = next
    ? [
        { label: "Energy delivered", have: wh, need: next.needWh, unit: "Wh" as const },
        { label: "Districts connected", have: districts, need: next.needDistricts, unit: "count" as const },
        ...(next.needCapacityW ? [{ label: "Installed capacity", have: cap, need: next.needCapacityW, unit: "W" as const }] : []),
      ]
    : [];
  const progressBps = next ? Math.floor(parts.reduce((a, p) => a + Math.min(1, p.have / Math.max(1, p.need)), 0) * 10_000 / parts.length) : 10_000;
  return {
    stage,
    name: cur.name,
    nextStage: next ? { stage: next.stage, name: next.name, unlocks: next.unlocks, rewardCc: next.rewardCc } : null,
    progressBps,
    requirements: parts,
    deliveredWh: wh,
    connectedDistricts: districts,
    installedCapacityW: cap,
    totalDistricts: DISTRICTS.length,
  };
}

/** Promotes the company when it qualifies: a Council grant, and VoltLine grows with the city. */
export function companyTick(s: SimState, ctx: Ctx): void {
  s.company ??= { stage: 1 };
  const reached = stageReached(s);
  while (s.company.stage < reached) {
    s.company.stage += 1;
    const st = STAGES[s.company.stage - 1];
    if (st.rewardCc) transfer(s, ctx, "credits_cc", ACC.council, ACC.player, st.rewardCc, "stage_grant", `stage_${st.stage}`);
    // the rival invests too: competition scales with the city
    s.rival.ratedW = RIVAL.ratedW + 6_000 * (s.company.stage - 1);
    emit(s, ctx, "STAGE_REACHED", ["player"], `You're now a ${st.name}! ${st.unlocks}${st.rewardCc ? ` The City Council grants ${cr(st.rewardCc)} credits.` : ""}`, {
      stage: st.stage, name: st.name, rewardCc: st.rewardCc,
    });
  }
}

/** Feeder capacity the player is already using in a district (active + waiting to connect). */
export function feederLoadW(s: SimState, districtId: string, exceptContractId?: string): number {
  let w = 0;
  for (const c of Object.values(s.contracts)) {
    if (c.provider !== "player" || c.contractId === exceptContractId) continue;
    if (c.status !== "active") continue;
    if (s.businesses[c.businessId]?.districtId === districtId) w += c.allottedW;
  }
  return w;
}

export function districtFeeder(d: DistrictState) {
  const cfg = DISTRICTS.find((x) => x.districtId === d.districtId)!;
  const level = d.substationLevel ?? (d.unlocked ? 1 : 0);
  return {
    level,
    capacityW: level > 0 ? cfg.feederCapacityW[level - 1] : 0,
    lossBps: cfg.lossBps,
    requiredStage: cfg.requiredStage,
    nextUpgradeCostCc: level >= 1 && level < 3 ? cfg.substationUpgradeCc[level - 1] : null,
    nextCapacityW: level >= 1 && level < 3 ? cfg.feederCapacityW[level] : null,
  };
}
