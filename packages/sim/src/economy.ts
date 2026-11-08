/**
 * Daily background settlement (non-blocking in continuous play): runs business/district/merchant/
 * regulator accounting, builds the day report from events, and the campaign summary.
 */
import { PERMIT_MG, type CampaignSummary, type DayReport } from "@blackout/shared";
import { BASE_REFERENCE_CC_PER_L, UPGRADES } from "./config.ts";
import { ACC, bal, transfer } from "./ledger.ts";
import { businessesSettlement, districtsSettlement } from "./customers.ts";
import { merchantsSettlement } from "./market.ts";
import { regulatorSettlement } from "./agents.ts";
import { cr, emit, type ContractState, type Ctx, type SimState } from "./state.ts";

/** Refunds unearned escrow back to the customer exactly once. */
export function refundEscrow(s: SimState, ctx: Ctx, c: ContractState, why: string): number {
  const amt = c.escrowCc;
  if (amt <= 0) return 0;
  transfer(s, ctx, "credits_cc", ACC.escrowContracts, ACC.business(c.businessId), amt, "contract_refund_unearned", c.contractId);
  c.escrowCc = 0;
  c.refundedCc += amt;
  if (c.provider === "player") s.dayStats.refundsCc += amt;
  emit(s, ctx, "REFUND_ISSUED", [`business:${c.businessId}`, c.provider === "player" ? "player" : "rival"], `${s.businesses[c.businessId].name} got ${cr(amt)} credits of unearned escrow back (${why}). Billed only for ${(c.deliveredWh / 1000).toFixed(2)} kWh actually delivered.`, {
    contractId: c.contractId,
    refundCc: amt,
    deliveredWh: c.deliveredWh,
    billedCc: c.billedCc,
  });
  return amt;
}

export function endOfDayContracts(s: SimState, ctx: Ctx): void {
  for (const c of Object.values(s.contracts)) {
    if (c.status === "active") {
      c.status = c.deliveredTicks >= c.totalTicks ? "completed" : "completed";
      c.failureReason = c.deliveredTicks >= c.totalTicks ? null : "day_end_partial";
      refundEscrow(s, ctx, c, "operating day ended before the full duration");
      s.businesses[c.businessId].activeContractId = null;
      if (c.provider === "player") s.dayStats.contractsCompleted += 1;
      emit(s, ctx, "CONTRACT_COMPLETED", [`business:${c.businessId}`], `Contract ${c.contractId} closed at day end after ${(c.deliveredWh / 1000).toFixed(2)} kWh.`, { contractId: c.contractId, partial: c.deliveredTicks < c.totalTicks });
    } else if (c.status === "pending_assignment") {
      c.status = "expired";
      c.failureReason = "never assigned before day end";
      refundEscrow(s, ctx, c, "never assigned");
      s.businesses[c.businessId].activeContractId = null;
      emit(s, ctx, "CONTRACT_EXPIRED", [`business:${c.businessId}`], `Contract ${c.contractId} was never assigned; escrow returned.`, { contractId: c.contractId });
    }
  }
  for (const r of Object.values(s.requests)) {
    if (r.status === "open" || r.status === "customer_countered") {
      r.status = "expired";
      r.resolutionReason = "day ended";
    }
  }
  for (const b of Object.values(s.businesses)) {
    b.outageUntilTick = null;
    if (b.status !== "closed") b.powerSource = "grid";
  }
}

export function settleDay(s: SimState, ctx: Ctx, opts: { continuous?: boolean } = {}): DayReport {
  // In continuous play contracts, requests and outages carry over midnight.
  if (!opts.continuous) endOfDayContracts(s, ctx);
  businessesSettlement(s, ctx);
  districtsSettlement(s);
  merchantsSettlement(s, ctx);
  regulatorSettlement(s, ctx);

  const st = s.dayStats;
  const prevGdp = s.dayReports.length ? s.dayReports[s.dayReports.length - 1].gdpCc : st.gdpCc;
  // outage hours can straddle midnight, so served ticks may exceed today's requested ticks: clamp
  const reliability = st.requestedOutageTicks ? Math.min(10_000, Math.floor((st.servedOutageTicks * 10_000) / st.requestedOutageTicks)) : 0;
  const credits = bal(s, "credits_cc", ACC.player);
  const prices = Object.values(s.merchants).map((m) => m.quoteCcPerL);
  const report: DayReport = {
    day: s.day,
    revenueCc: st.revenueCc,
    refundsCc: st.refundsCc,
    fuelBurnedMl: st.fuelBurnedMl,
    fuelCostCc: st.fuelCostCc,
    co2Mg: st.co2Mg,
    permitAllowanceLeftMg: bal(s, "permit_mg", ACC.player),
    spendCc: st.spendCc,
    netCashChangeCc: credits - st.openingCreditsCc,
    reliabilityBps: reliability,
    requestsOffered: st.requestsOffered,
    contractsCompleted: st.contractsCompleted,
    contractsFailed: st.contractsFailed,
    customersLostToRival: st.lostToRival,
    closures: [...st.closures],
    reopenings: [...st.reopenings],
    gdpCc: st.gdpCc,
    gdpChangeBps: prevGdp ? Math.trunc(((st.gdpCc - prevGdp) * 10_000) / prevGdp) : 0,
    oilIndexCenti: s.world.oilIndexCenti,
    avgFuelPriceCcPerL: prices.length ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : 0,
    highlights: [],
  };
  s.dayReports.push(report);
  const ev = emit(
    s,
    ctx,
    "DAY_SETTLED",
    ["player"],
    `Day ${s.day} settled: revenue ${cr(report.revenueCc)}, fuel burned ${(report.fuelBurnedMl / 1000).toFixed(1)} L, CO2 ${(report.co2Mg / 1e6).toFixed(2)} kg, reliability ${(reliability / 100).toFixed(0)}%, net cash ${report.netCashChangeCc >= 0 ? "+" : ""}${cr(report.netCashChangeCc)}.`,
    { report },
  );
  void ev;
  return report;
}

/** Picks 2-3 causal highlights for the report card from the day's own events. */
export function attachHighlights(s: SimState, report: DayReport, dayEvents: { seq: number; type: string; explanation: string; data: Record<string, unknown> }[]): void {
  const pick = (types: string[]) => dayEvents.filter((e) => types.includes(e.type));
  const out: { eventSeq: number; text: string }[] = [];
  const trades = pick(["TRADE_RESERVED"]).filter((e) => typeof e.data.merchantId === "string");
  for (const t of trades) {
    const reprice = dayEvents.find((e) => e.type === "MERCHANT_REPRICED" && e.seq > t.seq && e.data.merchantId === t.data.merchantId);
    if (reprice) {
      out.push({ eventSeq: t.seq, text: `${t.explanation} Then: ${String(reprice.explanation).split(". Import cost")[0]}.` });
      break;
    }
  }
  for (const e of pick(["BUSINESS_STATUS_CHANGED", "RIVAL_WON_CONTRACT", "CONTRACT_FAILED", "GENERATOR_BROKEN", "CUSTOMER_SWITCHED_PROVIDER", "MERCHANT_CLOSED"])) {
    if (out.length >= 3) break;
    out.push({ eventSeq: e.seq, text: e.explanation });
  }
  report.highlights = out.slice(0, 3);
}

export function netWorthCc(s: SimState): number {
  const credits = bal(s, "credits_cc", ACC.player);
  const fuelValue = Math.floor((bal(s, "fuel_ml", ACC.player) * BASE_REFERENCE_CC_PER_L) / 1000);
  const permitValue = Math.floor((bal(s, "permit_mg", ACC.player) * s.regulator.permitPriceCc) / PERMIT_MG);
  const equipment = s.player.upgradesOwned.reduce((a, u) => a + Math.floor((UPGRADES.find((x) => x.upgradeId === u)?.costCc ?? 0) / 2), 0);
  return credits + fuelValue + permitValue + equipment;
}

export function campaignSummary(s: SimState): CampaignSummary {
  const reliability = s.totals.requestedOutageTicks ? Math.min(10_000, Math.floor((s.totals.servedOutageTicks * 10_000) / s.totals.requestedOutageTicks)) : 0;
  const nw = netWorthCc(s);
  const gdp = s.totals.gdpCc;
  const score = Math.floor(nw / 100) + Math.floor(reliability / 10) + Math.floor(gdp / 1_000) - s.totals.closures * 100;
  const open = Object.values(s.businesses).filter((b) => s.districts[b.districtId].unlocked && b.status !== "closed").length;
  const total = Object.values(s.businesses).filter((b) => s.districts[b.districtId].unlocked).length;
  return {
    finished: s.finished,
    daysPlayed: s.dayReports.length,
    netWorthCc: nw,
    reliabilityBps: reliability,
    cityGdpCc: gdp,
    score,
    badges: [
      { id: "net_worth", label: "Solvent Operator", earned: nw >= 110_000, reason: `Net worth ${cr(nw)} (needs 1,100)` },
      { id: "reliability", label: "Keeper of the Lights", earned: reliability >= 7_000, reason: `Served ${(reliability / 100).toFixed(0)}% of requested outage hours (needs 70%)` },
      { id: "gdp", label: "Main Street Ally", earned: open === total && total > 0, reason: `${open}/${total} businesses still open` },
    ],
    carbonAudit: `Emitted ${(s.player.co2TotalMg / 1e6).toFixed(2)} kg CO2; every kg was covered by a retired permit (diesel cannot run without allowance), so no fine is due. ${bal(s, "permit_mg", ACC.player) / 1e6} kg allowance left.`,
  };
}
