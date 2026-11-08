/**
 * Customer businesses: outages, requests, negotiation, escrowed contracts and
 * the per-tick business P&L that makes power prices matter.
 *
 * Money in: outside shoppers (world:shoppers) pay a business only while it is powered,
 * bounded by the district's outside demand. Money out: wages & stock, grid power,
 * your power bill (from escrow), and daily rent. Cash can never go negative:
 * a business pays costs only up to its cash and records the rest as unpaid.
 */
import { ccForEnergy, whPerTick } from "@blackout/shared";
import { CUSTOMER_RULES, GRID, RIVAL, TIMING } from "./config.ts";
import { ACC, bal, transfer, transferUpTo } from "./ledger.ts";
import { validateAssignment } from "./electricity.ts";
import { worldModifiers } from "./world-events/engine.ts";
import { SimError, cr, emit, kW, newId, type BusinessState, type ContractState, type Ctx, type RequestState, type SimState, type WaveState } from "./state.ts";

export const businessCash = (s: SimState, b: BusinessState) => bal(s, "credits_cc", ACC.business(b.businessId));

/** Highest tariff (cc/kWh) at which one powered hour still breaks even. Cold Room: 2000*1000/1500 = 1333. */
export const breakEvenRate = (b: BusinessState) =>
  Math.floor(((b.revenueCcPerPoweredHour - b.variableCostCcPerPoweredHour) * 1000) / b.demandW);

/** Customer's profit per powered hour at a given rate (before rent). Cold Room @800: 4000-2000-1200 = +800. */
export const profitPerHourAt = (b: BusinessState, rateCcPerKwh: number) =>
  b.revenueCcPerPoweredHour - b.variableCostCcPerPoweredHour - Math.floor((b.demandW * rateCcPerKwh) / 1000);

export function rivalCanServe(s: SimState, w: number, hours: number): boolean {
  if (s.day < RIVAL.activeFromDay) return false;
  const assigned = Object.values(s.contracts).filter((c) => c.provider === "rival" && c.status === "active").reduce((a, c) => a + c.allottedW, 0);
  if (assigned + w > Math.floor((s.rival.ratedW * 9) / 10)) return false;
  const fuel = (w * hours * 3) / 10;
  return bal(s, "fuel_ml", ACC.rival) >= fuel && bal(s, "permit_mg", ACC.rival) >= fuel * 2680;
}

/**
 * The most a customer will agree to pay per kWh. Derived from its own margin,
 * loyalty, cash urgency, district behaviour and the rival's posted tariff.
 */
export function acceptCeiling(s: SimState, b: BusinessState, w = b.demandW, hours = 1): { ceiling: number; why: string } {
  if (b.fixedTariffCcPerKwh !== null) return { ceiling: b.fixedTariffCcPerKwh, why: "fixed public tariff; never haggles" };
  const be = breakEvenRate(b);
  let ceiling = Math.floor((be * (CUSTOMER_RULES.baseAcceptBps + Math.floor((CUSTOMER_RULES.loyaltyAcceptBonusBps * b.loyaltyBps) / 10_000))) / 10_000);
  const parts = [`break-even ${cr(be)}/kWh`, `loyalty ${(b.loyaltyBps / 100).toFixed(0)}%`];
  if (businessCash(s, b) < b.fixedCostCcPerDay) {
    ceiling = Math.floor((ceiling * 9) / 10);
    parts.push("cash is tight (-10%)");
  }
  const district = s.districts[b.districtId];
  if (district.payBehaviour === "price_sensitive") {
    ceiling = Math.floor((ceiling * 85) / 100);
    parts.push("price-sensitive district (-15%)");
  }
  if (rivalCanServe(s, w, hours) && s.rival.tariffCcPerKwh + 100 < ceiling) {
    ceiling = s.rival.tariffCcPerKwh + 100;
    parts.push(`rival offers ${cr(s.rival.tariffCcPerKwh)}/kWh`);
  }
  return { ceiling: Math.max(100, Math.floor(ceiling / 10) * 10), why: parts.join(", ") };
}

export function openingOffer(s: SimState, b: BusinessState, w: number, hours: number): number {
  if (b.fixedTariffCcPerKwh !== null) return b.fixedTariffCcPerKwh;
  const tariff = s.player.tariffs[b.districtId];
  const { ceiling } = acceptCeiling(s, b, w, hours);
  return tariff <= ceiling ? tariff : Math.max(100, Math.floor((ceiling * 9) / 10 / 10) * 10);
}

export function eligibleForOutage(s: SimState, b: BusinessState): boolean {
  if (b.status === "closed") return false;
  if (!s.districts[b.districtId].unlocked) return false;
  if (b.activeContractId !== null) return false;
  if (b.outageUntilTick !== null && b.outageUntilTick > s.tick) return false;
  // no other live request for this business
  return !Object.values(s.requests).some((r) => r.businessId === b.businessId && (r.status === "open" || r.status === "customer_countered"));
}

const MESSAGES: Record<string, (kwText: string, h: number, rate: string) => string> = {
  cold_storage: (k, h, r) => `My freezer's losing power. Need ${k} for ${h} hour${h > 1 ? "s" : ""}. I can pay ${r} credits/kWh.`,
  bakery: (k, h, r) => `Ovens are cold and the dough is rising! ${k} for ${h}h at ${r}/kWh?`,
  pharmacy: (k, h, r) => `Our vaccine fridge needs ${k} for ${h}h. Offering ${r} credits/kWh.`,
  cyber_cafe: (k, h, r) => `Gamers are leaving. I need ${k} for ${h}h at ${r}/kWh.`,
  corner_shop: (k, h, r) => `Lights are out at the shop. Just ${k} for ${h}h, I can do ${r}/kWh.`,
};

export function createRequest(s: SimState, ctx: Ctx, wave: WaveState, b: BusinessState, hours: number, fixture?: { rateCcPerKwh: number }): RequestState | null {
  let h = hours;
  let rate = fixture?.rateCcPerKwh ?? openingOffer(s, b, b.demandW, h);
  // affordability: customer must be able to escrow the full expected payment
  while (h > 1 && ccForEnergy(b.demandW * h, rate) > businessCash(s, b)) h -= 1;
  if (ccForEnergy(b.demandW * h, rate) > businessCash(s, b)) {
    emit(s, ctx, "OUTAGE_STARTED", [`business:${b.businessId}`], `${b.name} lost grid power but cannot afford even 1 hour of emergency power (${cr(businessCash(s, b))} credits). It stays dark.`, { businessId: b.businessId, affordable: false });
    b.outageUntilTick = s.tick + hours * 10;
    return null;
  }
  const req: RequestState = {
    requestId: newId(s, "req"),
    waveId: wave.waveId,
    businessId: b.businessId,
    districtId: b.districtId,
    requestedW: b.demandW,
    durationHours: h,
    offerRateCcPerKwh: rate,
    counterCount: 0,
    maxCounters: b.fixedTariffCcPerKwh !== null ? 0 : CUSTOMER_RULES.maxCounters,
    lastPlayerCounterCcPerKwh: null,
    status: "open",
    createdTick: s.tick,
    deadlineTick: wave.tutorial ? null : s.tick + TIMING.REQUEST_DEADLINE_TICKS,
    day: s.day,
    message: (MESSAGES[b.kind] ?? ((k, hh, r) => `We need ${k} for ${hh}h at ${r}/kWh.`))(`${kW(b.demandW)} kW`, h, cr(rate)),
    resolutionReason: null,
  };
  s.requests[req.requestId] = req;
  wave.requestIds.push(req.requestId);
  s.dayStats.requestsOffered += 1;
  s.dayStats.requestedOutageTicks += h * 10;
  s.totals.requestedOutageTicks += h * 10;
  emit(s, ctx, "CUSTOMER_REQUESTED", [`business:${b.businessId}`], `${b.name} asks for ${kW(b.demandW)} kW for ${h} game hour${h > 1 ? "s" : ""} at ${cr(rate)} credits/kWh (${cr(ccForEnergy(b.demandW * h, rate))} credits total).`, {
    requestId: req.requestId,
    businessId: b.businessId,
    requestedW: b.demandW,
    durationHours: h,
    offerRateCcPerKwh: rate,
    deadlineTick: req.deadlineTick,
  });
  return req;
}

function requireOpen(s: SimState, req: RequestState): void {
  if (s.phase !== "operating") throw new SimError("INVALID_PHASE", "Requests can only be handled during the operating day.");
  if (req.status === "expired") throw new SimError("REQUEST_EXPIRED", "This request expired.");
  if (req.status !== "open" && req.status !== "customer_countered") throw new SimError("ALREADY_PROCESSED", `Request is ${req.status}.`);
  if (req.deadlineTick !== null && s.tick >= req.deadlineTick) throw new SimError("REQUEST_EXPIRED", "This request's timer ran out.");
}

/** Finds a generator that can take this load right now, or throws the most relevant error. */
function viabilityCheck(s: SimState, probe: ContractState): void {
  let firstErr: SimError | null = null;
  for (const gid of s.player.generatorIds) {
    try {
      validateAssignment(s, probe, gid);
      return;
    } catch (e) {
      if (e instanceof SimError) firstErr ??= e;
      else throw e;
    }
  }
  throw firstErr ?? new SimError("CAPACITY_EXCEEDED", "No generator available.");
}

/** Creates an escrowed contract at `rate` (request accepted by both sides). */
export function formContract(s: SimState, ctx: Ctx, req: RequestState, rate: number, provider: "player" | "rival"): ContractState {
  const b = s.businesses[req.businessId];
  const escrow = ccForEnergy(req.requestedW * req.durationHours, rate);
  if (businessCash(s, b) < escrow) {
    throw new SimError("CUSTOMER_CANNOT_PAY", `${b.name} has ${cr(businessCash(s, b))} credits but this contract needs ${cr(escrow)} in escrow.`, { cashCc: businessCash(s, b), escrowCc: escrow });
  }
  const wave = s.waves.find((w) => w.waveId === req.waveId);
  const c: ContractState = {
    contractId: newId(s, "contract"),
    requestId: req.requestId,
    businessId: b.businessId,
    generatorId: provider === "rival" ? "rival_plant" : null,
    provider,
    allottedW: req.requestedW,
    rateCcPerKwh: rate,
    durationHours: req.durationHours,
    totalTicks: req.durationHours * 10,
    deliveredTicks: 0,
    startTick: null,
    serviceStartedEmitted: false,
    assignDeadlineTick: provider === "player" && !wave?.tutorial ? s.tick + TIMING.ASSIGN_DEADLINE_TICKS : null,
    deliveredWh: 0,
    billedCc: 0,
    escrowCc: escrow,
    refundedCc: 0,
    fuelUsedMl: 0,
    co2Mg: 0,
    status: "pending_assignment",
    failureReason: null,
    day: s.day,
    hourWh: 0,
    hourFuelMl: 0,
    hourBilledCc: 0,
    lastDeliveredTick: null,
  };
  if (provider === "player") viabilityCheck(s, c);
  transfer(s, ctx, "credits_cc", ACC.business(b.businessId), ACC.escrowContracts, escrow, "contract_escrow", c.contractId);
  s.contracts[c.contractId] = c;
  b.activeContractId = c.contractId;
  req.status = provider === "player" ? "accepted" : "lost_to_rival";
  req.offerRateCcPerKwh = rate;
  if (provider === "player") {
    if (rate > breakEvenRate(b)) b.gougeCount += 1;
    b.today.paidRateSum += rate;
    b.today.paidRateCount += 1;
  }
  return c;
}

export function acceptRequest(s: SimState, ctx: Ctx, requestId: string): ContractState {
  const req = s.requests[requestId];
  if (!req) throw new SimError("NOT_FOUND", `Unknown request ${requestId}`);
  requireOpen(s, req);
  const c = formContract(s, ctx, req, req.offerRateCcPerKwh, "player");
  const b = s.businesses[req.businessId];
  emit(s, ctx, "CONTRACT_ACCEPTED", [`business:${b.businessId}`, "player"], `Deal: ${kW(c.allottedW)} kW for ${c.durationHours}h at ${cr(c.rateCcPerKwh)}/kWh. ${b.name} escrowed ${cr(c.escrowCc)} credits. Assign a generator to restore power.`, {
    requestId,
    contractId: c.contractId,
    businessId: b.businessId,
    rateCcPerKwh: c.rateCcPerKwh,
    escrowCc: c.escrowCc,
    customerProfitPerHourCc: profitPerHourAt(b, c.rateCcPerKwh),
  });
  if (s.tutorialStep === "accept_first") setTutorial(s, ctx, "assign_first");
  return c;
}

export function counterRequest(s: SimState, ctx: Ctx, requestId: string, rate: number): { accepted: boolean; contract?: ContractState; customerOffer?: number; rejected?: boolean } {
  const req = s.requests[requestId];
  if (!req) throw new SimError("NOT_FOUND", `Unknown request ${requestId}`);
  requireOpen(s, req);
  const b = s.businesses[req.businessId];
  if (req.counterCount >= req.maxCounters) {
    throw new SimError("MAX_COUNTERS_REACHED", b.fixedTariffCcPerKwh !== null ? `${b.name} pays a fixed tariff and never haggles.` : `Already countered ${req.counterCount} times; accept or decline.`);
  }
  req.lastPlayerCounterCcPerKwh = rate;
  emit(s, ctx, "PLAYER_COUNTERED", ["player", `business:${b.businessId}`], `You proposed ${cr(rate)}/kWh to ${b.name} (they offered ${cr(req.offerRateCcPerKwh)}).`, { requestId, rateCcPerKwh: rate, round: req.counterCount + 1 });
  const { ceiling, why } = acceptCeiling(s, b, req.requestedW, req.durationHours);
  if (rate <= req.offerRateCcPerKwh || rate <= ceiling) {
    const c = formContract(s, ctx, req, rate, "player");
    emit(s, ctx, "CONTRACT_ACCEPTED", [`business:${b.businessId}`, "player"], `${b.name} accepted ${cr(rate)}/kWh (their limit: ${why}). Escrowed ${cr(c.escrowCc)} credits.`, {
      requestId,
      contractId: c.contractId,
      businessId: b.businessId,
      rateCcPerKwh: rate,
      escrowCc: c.escrowCc,
      customerProfitPerHourCc: profitPerHourAt(b, rate),
      viaCounter: true,
    });
    if (s.tutorialStep === "accept_first") setTutorial(s, ctx, "assign_first");
    return { accepted: true, contract: c };
  }
  req.counterCount += 1;
  if (req.counterCount >= req.maxCounters) {
    req.status = "rejected_by_customer";
    req.resolutionReason = `walked away after ${req.counterCount} counters; your ${cr(rate)}/kWh exceeds what it will pay (${why})`;
    b.loyaltyBps = Math.max(0, b.loyaltyBps - 300);
    emit(s, ctx, "CUSTOMER_REJECTED_COUNTER", [`business:${b.businessId}`], `${b.name} walked away: ${cr(rate)}/kWh is above what it will pay (${why}).`, { requestId, rateCcPerKwh: rate });
    return { accepted: false, rejected: true };
  }
  const target = Math.min(rate, ceiling);
  const offer = Math.max(req.offerRateCcPerKwh, Math.floor((req.offerRateCcPerKwh + Math.floor(((target - req.offerRateCcPerKwh) * b.concessionBps) / 10_000)) / 10) * 10);
  req.offerRateCcPerKwh = Math.min(offer, ceiling);
  req.status = "customer_countered";
  if (req.deadlineTick !== null) req.deadlineTick = s.tick + TIMING.REQUEST_DEADLINE_TICKS;
  emit(s, ctx, "CUSTOMER_COUNTERED", [`business:${b.businessId}`], `${b.name} counters at ${cr(req.offerRateCcPerKwh)}/kWh (round ${req.counterCount}/${req.maxCounters}). Profit for them at that price: ${cr(profitPerHourAt(b, req.offerRateCcPerKwh))}/hour.`, {
    requestId,
    offerRateCcPerKwh: req.offerRateCcPerKwh,
    round: req.counterCount,
  });
  return { accepted: false, customerOffer: req.offerRateCcPerKwh };
}

export function declineRequest(s: SimState, ctx: Ctx, requestId: string): RequestState {
  const req = s.requests[requestId];
  if (!req) throw new SimError("NOT_FOUND", `Unknown request ${requestId}`);
  requireOpen(s, req);
  req.status = "declined";
  req.resolutionReason = "declined by player";
  const b = s.businesses[req.businessId];
  b.loyaltyBps = Math.max(0, b.loyaltyBps - 200);
  emit(s, ctx, "REQUEST_DECLINED", ["player", `business:${b.businessId}`], `You declined ${b.name}. It stays dark unless the rival steps in.`, { requestId, businessId: b.businessId });
  return req;
}

export function setTutorial(s: SimState, ctx: Ctx, step: SimState["tutorialStep"]): void {
  if (s.tutorialStep === step) return;
  s.tutorialStep = step;
  emit(s, ctx, "TUTORIAL_STEP", ["player"], tutorialHint(step), { step });
}

export function tutorialHint(step: SimState["tutorialStep"]): string {
  switch (step) {
    case "accept_first":
      return "The Cold Room is dark. Accept its request: 1.5 kW for 2 hours at 8 credits/kWh.";
    case "assign_first":
      return "Connect the Cold Room to your 5 kW diesel generator to restore power.";
    case "watch_service":
      return "Power restored. 3 kWh scheduled: fuel, CO2 and cash update as each tick of power is delivered.";
    default:
      return "";
  }
}

/** Per-tick business finance. `deliveredBy` maps businessId -> provider that delivered this tick. */
export function businessesTick(s: SimState, ctx: Ctx, deliveredBy: Map<string, "player" | "rival">): void {
  const demandBps = 10_000 + worldModifiers(s).demandBps;
  const byDistrict = new Map<string, { b: BusinessState; milli: number }[]>();
  for (const b of Object.values(s.businesses)) {
    // locked districts are outside the player's market and are not simulated until unlocked
    if (!s.districts[b.districtId].unlocked) continue;
    const inOutage = b.outageUntilTick !== null && s.tick < b.outageUntilTick;
    const provider = deliveredBy.get(b.businessId);
    const prevSource = b.powerSource;
    b.powerSource = b.status === "closed" ? "none" : provider ? provider : inOutage ? "none" : "grid";
    if (b.status !== "closed" && b.outageUntilTick !== null && !inOutage && !provider) {
      b.outageUntilTick = null;
      if (prevSource !== "grid") emit(s, ctx, "OUTAGE_ENDED", [`business:${b.businessId}`], `Grid power is back at ${b.name}.`, { businessId: b.businessId });
    }
    if (b.status === "closed") continue;
    const district = s.districts[b.districtId];
    if (inOutage || provider) {
      district.outageTicksToday += 1;
      if (provider) district.servedOutageTicksToday += 1;
    }
    if (b.powerSource === "none") {
      b.today.darkTicks += 1;
      if (inOutage) b.today.darkOutageTicks += 1;
      continue;
    }
    b.today.poweredTicks += 1;
    if (provider === "player") b.today.servedByPlayerTicks += 1;
    // revenue in milli-cc for this tick: rev/hour / 10 ticks * activity index
    const milli = Math.floor((((b.revenueCcPerPoweredHour * 100 * district.activityIndexBps) / 10_000) * demandBps) / 10_000);
    const list = byDistrict.get(b.districtId) ?? [];
    list.push({ b, milli });
    byDistrict.set(b.districtId, list);
  }
  for (const [districtId, list] of byDistrict) {
    const d = s.districts[districtId];
    const capMilli = Math.floor((((d.outsideDemandCcPerHour * 100 * d.activityIndexBps) / 10_000) * demandBps) / 10_000);
    const want = list.reduce((a, x) => a + x.milli, 0);
    for (const { b, milli } of list) {
      const scaled = want > capMilli ? Math.floor((milli * capMilli) / want) : milli;
      const total = scaled + b.today.revenueRemainderMilliCc;
      const cc = Math.floor(total / 1000);
      b.today.revenueRemainderMilliCc = total % 1000;
      if (cc > 0) {
        transfer(s, ctx, "credits_cc", ACC.shoppers, ACC.business(b.businessId), cc, "shopper_sales", b.businessId);
        b.today.revenueCc += cc;
        s.dayStats.gdpCc += cc;
        s.totals.gdpCc += cc;
        const pool = Math.floor((cc * CUSTOMER_RULES.districtPoolShareBps) / 10_000);
        if (pool > 0) transfer(s, ctx, "credits_cc", ACC.shoppers, ACC.districtPool(districtId), pool, "district_stall_spend", districtId);
      }
      // variable costs while open (wages, stock): rev-independent, per powered tick
      const costMilli = b.variableCostCcPerPoweredHour * 100 + b.today.costRemainderMilliCc;
      const cost = Math.floor(costMilli / 1000);
      b.today.costRemainderMilliCc = costMilli % 1000;
      const paid = transferUpTo(s, ctx, "credits_cc", ACC.business(b.businessId), ACC.wagesSuppliers, cost, "wages_and_stock", b.businessId);
      b.today.operatingCostCc += paid;
      b.today.unpaidCostCc += cost - paid;
      if (b.powerSource === "grid") {
        b.today.gridWh += whPerTick(b.demandW);
        const owed = ccForEnergy(b.today.gridWh, GRID.tariffCcPerKwh) - b.today.gridBilledCc;
        const p = transferUpTo(s, ctx, "credits_cc", ACC.business(b.businessId), ACC.grid, owed, "grid_power", b.businessId);
        b.today.gridBilledCc += owed; // unpaid grid bills are written off by the utility
        b.today.powerCostCc += p;
        b.today.unpaidCostCc += owed - p;
      }
    }
  }
}

export function moodOf(s: SimState, b: BusinessState): "happy" | "neutral" | "worried" | "angry" {
  if (b.status === "closed") return "angry";
  const cash = businessCash(s, b);
  if (b.status === "struggling" || cash < b.fixedCostCcPerDay / 2) return "worried";
  if (b.loyaltyBps >= 6_500) return "happy";
  if (b.loyaltyBps < 3_000) return "angry";
  return "neutral";
}

/** Day-end business accounting: rent, history, loyalty, struggling/closure/reopening. */
export function businessesSettlement(s: SimState, ctx: Ctx): void {
  for (const b of Object.values(s.businesses)) {
    if (!s.districts[b.districtId].unlocked) continue;
    const acct = ACC.business(b.businessId);
    if (b.status !== "closed") {
      const rent = transferUpTo(s, ctx, "credits_cc", acct, ACC.landlords, b.fixedCostCcPerDay, "rent_and_fixed_costs", b.businessId);
      b.today.operatingCostCc += rent;
      b.today.unpaidCostCc += b.fixedCostCcPerDay - rent;
    }
    const cash = bal(s, "credits_cc", acct);
    b.history.push({
      day: s.day,
      openingCashCc: b.today.openingCashCc,
      closingCashCc: cash,
      revenueCc: b.today.revenueCc,
      operatingCostCc: b.today.operatingCostCc,
      powerCostCc: b.today.powerCostCc,
      poweredHours: Math.floor(b.today.poweredTicks / 10),
      darkHours: Math.floor(b.today.darkTicks / 10),
    });
    // loyalty: +1% per served hour, -0.8% per dark outage hour, -10% if gouged today
    const avgRate = b.today.paidRateCount ? Math.floor(b.today.paidRateSum / b.today.paidRateCount) : 0;
    const gouged = avgRate > breakEvenRate(b);
    const delta = b.today.servedByPlayerTicks * 10 - b.today.darkOutageTicks * 8 - (gouged ? 1_000 : 0);
    b.loyaltyBps = Math.max(0, Math.min(10_000, b.loyaltyBps + delta));

    const prev = b.status;
    if (b.status === "closed") {
      const d = s.districts[b.districtId];
      const poolAcct = ACC.districtPool(b.districtId);
      const capital = b.fixedCostCcPerDay * CUSTOMER_RULES.reopenCapitalMultiple;
      if (
        b.closedSinceDay !== null &&
        s.day - b.closedSinceDay >= CUSTOMER_RULES.reopenAfterDaysClosed &&
        d.activityIndexBps >= CUSTOMER_RULES.reopenMinActivityBps &&
        bal(s, "credits_cc", poolAcct) >= capital
      ) {
        transfer(s, ctx, "credits_cc", poolAcct, acct, capital, "reopening_capital", b.businessId);
        b.status = "reopening";
        b.lowCashSettlements = 0;
        b.closedSinceDay = null;
        b.loyaltyBps = 5_000;
        s.dayStats.reopenings.push(b.businessId);
        emit(s, ctx, "BUSINESS_STATUS_CHANGED", [`business:${b.businessId}`], `${b.name} is reopening: the ${d.name} reinvestment pool funded ${cr(capital)} credits because district activity recovered to ${(d.activityIndexBps / 100).toFixed(0)}%.`, { businessId: b.businessId, from: prev, to: b.status, capitalCc: capital });
      }
    } else {
      b.lowCashSettlements = cash < b.fixedCostCcPerDay ? b.lowCashSettlements + 1 : 0;
      if (b.lowCashSettlements >= CUSTOMER_RULES.closureLowCashSettlements) {
        b.status = "closed";
        b.closedSinceDay = s.day;
        b.powerSource = "none";
        s.dayStats.closures.push(b.businessId);
        s.totals.closures += 1;
      } else if (b.lowCashSettlements >= 1) b.status = "struggling";
      else b.status = "operating";
      if (b.status !== prev) {
        const why =
          b.status === "closed"
            ? `cash ${cr(cash)} was below its daily fixed costs (${cr(b.fixedCostCcPerDay)}) at ${CUSTOMER_RULES.closureLowCashSettlements} consecutive settlements`
            : b.status === "struggling"
              ? `cash ${cr(cash)} cannot cover tomorrow's fixed costs (${cr(b.fixedCostCcPerDay)})`
              : `cash recovered to ${cr(cash)}`;
        emit(s, ctx, "BUSINESS_STATUS_CHANGED", [`business:${b.businessId}`], `${b.name} is now ${b.status}: ${why}. Today: revenue ${cr(b.today.revenueCc)}, costs ${cr(b.today.operatingCostCc)}, power ${cr(b.today.powerCostCc)}.`, {
          businessId: b.businessId,
          from: prev,
          to: b.status,
          cashCc: cash,
        });
      }
    }
  }
}

export function resetBusinessDay(s: SimState): void {
  for (const b of Object.values(s.businesses)) {
    b.today = {
      openingCashCc: businessCash(s, b),
      revenueCc: 0,
      operatingCostCc: 0,
      powerCostCc: 0,
      poweredTicks: 0,
      darkTicks: 0,
      gridWh: 0,
      gridBilledCc: 0,
      revenueRemainderMilliCc: 0,
      costRemainderMilliCc: 0,
      unpaidCostCc: 0,
      servedByPlayerTicks: 0,
      darkOutageTicks: 0,
      paidRateSum: 0,
      paidRateCount: 0,
    };
  }
  for (const d of Object.values(s.districts)) {
    d.outageTicksToday = 0;
    d.servedOutageTicksToday = 0;
  }
}

export function districtsSettlement(s: SimState): void {
  for (const d of Object.values(s.districts)) {
    if (!d.unlocked) continue;
    const reliability = d.outageTicksToday ? Math.floor((d.servedOutageTicksToday * 10_000) / d.outageTicksToday) : 10_000;
    const members = Object.values(s.businesses).filter((b) => b.districtId === d.districtId);
    const gouged = members.filter((b) => b.today.paidRateCount && Math.floor(b.today.paidRateSum / b.today.paidRateCount) > breakEvenRate(b)).length;
    const closedToday = s.dayStats.closures.filter((id) => s.businesses[id].districtId === d.districtId).length;
    const delta = Math.floor((reliability - 5_000) / 5) - gouged * 500 - closedToday * 300;
    d.activityIndexBps = Math.max(CUSTOMER_RULES.activityMinBps, Math.min(CUSTOMER_RULES.activityMaxBps, d.activityIndexBps + delta));
  }
}
