/**
 * Autonomous NPC operators: the rival power company and the carbon regulator.
 * Both obey the same ledger: the rival can only sell power it can physically
 * produce from fuel and permits it actually bought with credits it actually has.
 */
import { PERMIT_MG, ccForEnergy } from "@blackout/shared";
import { REGULATOR, RIVAL } from "./config.ts";
import { ACC, bal, transfer } from "./ledger.ts";
import { buy, createQuote, merchantAvailable, oilTrend } from "./market.ts";
import { acceptCeiling, breakEvenRate, businessCash, formContract, profitPerHourAt, rivalCanServe } from "./customers.ts";
import { L, SimError, cr, emit, kW, type Ctx, type RequestState, type SimState } from "./state.ts";
import { worldModifiers } from "./world-events/engine.ts";

// ------------------------------------------------------------------ rival

/** Rival tariff policy: unit cost (fuel + carbon + maintenance) plus an adaptive margin. */
/** VoltLine starts competing once the player's company has grown past a street generator. */
export const rivalActive = (s: SimState) => (s.company?.stage ?? 1) >= 2;

export function computeRivalTariff(s: SimState): SimState["rival"]["tariffReasons"] {
  const r = s.rival;
  // daytime solar (if the rival built some) covers roughly a quarter of its energy at zero fuel cost
  const solarShareBps = r.solarW ? 2_500 : 0;
  // Replacement-cost pricing: diesel is valued at the higher of what it paid and what it would cost to restock now.
  const open = Object.values(s.merchants).filter((m) => m.status === "open" && m.quoteCcPerL > 0);
  const cheapest = open.length ? Math.min(...open.map((m) => m.quoteCcPerL)) : r.fuelCostBasisCcPerL;
  const fuelRef = Math.max(r.fuelCostBasisCcPerL, cheapest);
  const fuelCost = Math.round((((fuelRef * 3) / 10) * (10_000 - solarShareBps)) / 10_000); // 0.3 L per kWh
  const carbonCost = Math.round((s.regulator.permitPriceCc * 804) / 10_000); // 0.804 kg per kWh / 10 kg per permit
  const unit = fuelCost + carbonCost + RIVAL.maintenanceCcPerKwh;
  const raw = Math.round((unit * (10_000 + r.marginBps)) / 10_000);
  const final = Math.max(RIVAL.minTariffCcPerKwh, Math.min(RIVAL.maxTariffCcPerKwh, Math.round(raw / 10) * 10));
  return {
    fuelCostCcPerKwh: fuelCost,
    carbonCostCcPerKwh: carbonCost,
    unitCostCcPerKwh: unit,
    marginBps: r.marginBps,
    finalCcPerKwh: final,
    explanation: `Fuel at replacement cost ${cr(fuelRef)}/L (paid ${cr(r.fuelCostBasisCcPerL)}, cheapest seller ${cr(cheapest)}) × 0.3 L/kWh${solarShareBps ? " × 75% (own solar covers ~25%)" : ""} = ${cr(fuelCost)}; carbon ${cr(s.regulator.permitPriceCc)}/permit × 0.0804 = ${cr(carbonCost)}; maintenance ${cr(RIVAL.maintenanceCcPerKwh)} → unit cost ${cr(unit)}/kWh, + ${(r.marginBps / 100).toFixed(0)}% margin = ${cr(final)}/kWh.`,
  };
}

export function repriceRival(s: SimState, ctx: Ctx, cause: string): void {
  const r = s.rival;
  // adaptive margin: won lots yesterday -> push margin up; lost bids -> undercut
  if (r.wonToday + r.declinedToday > 0 || cause.startsWith("morning")) {
    const adj = r.wonToday >= 3 ? 500 : r.wonToday === 0 && rivalActive(s) ? -500 : 0;
    r.marginBps = Math.max(RIVAL.minMarginBps, Math.min(RIVAL.maxMarginBps, r.marginBps + adj));
  }
  const old = r.tariffCcPerKwh;
  r.tariffReasons = computeRivalTariff(s);
  r.tariffCcPerKwh = r.tariffReasons.finalCcPerKwh;
  r.lastAction = `Repriced to ${cr(r.tariffCcPerKwh)}/kWh (${cause})`;
  emit(s, ctx, "RIVAL_REPRICED", ["rival"], `${r.name} ${old && old !== r.tariffCcPerKwh ? `moved its tariff from ${cr(old)} to` : "posts a tariff of"} ${cr(r.tariffCcPerKwh)}/kWh. ${r.tariffReasons.explanation}`, {
    oldTariffCcPerKwh: old,
    newTariffCcPerKwh: r.tariffCcPerKwh,
    reasons: r.tariffReasons,
    cause,
  });
}

/** Morning procurement: buys fuel from the cheapest open merchant and permits if short, within cash. */
export function rivalShop(s: SimState, ctx: Ctx): void {
  const r = s.rival;
  if (r.boughtToday) return;
  r.boughtToday = true;
  const actions: string[] = [];
  const fuel = bal(s, "fuel_ml", ACC.rival);
  // The rival reads what it can observe (merchant shelves, posted prices), not the news itself.
  const merchants = Object.values(s.merchants);
  const shelves = merchants.reduce((a, m) => a + merchantAvailable(s, m), 0) / Math.max(1, merchants.reduce((a, m) => a + Math.max(1, m.targetStockMl - m.reserveFloorMl), 0));
  const avgPrice = merchants.reduce((a, m) => a + m.quoteCcPerL, 0) / Math.max(1, merchants.length);
  const prevStockpile = r.stockpileDays ?? 0;
  r.stockpileDays = shelves < 0.5 ? 1 : 0;
  if (r.stockpileDays !== prevStockpile) {
    emit(s, ctx, "RIVAL_STRATEGY_CHANGED", ["rival"], r.stockpileDays ? `${r.name} is stockpiling: merchants' shelves are only ${(shelves * 100).toFixed(0)}% of normal, so it now keeps ${RIVAL.targetFuelDays + 1} days of diesel.` : `${r.name} stops stockpiling: merchant shelves recovered to ${(shelves * 100).toFixed(0)}% of normal.`, { strategy: r.stockpileDays ? "stockpile" : "normal", shelvesBps: Math.round(shelves * 10_000) });
  }
  if (!r.solarW && avgPrice >= 1_250 && bal(s, "credits_cc", ACC.rival) >= 160_000) {
    const cost = Math.round((90_000 * (10_000 + worldModifiers(s).solarCostBps)) / 10_000);
    transfer(s, ctx, "credits_cc", ACC.rival, ACC.equipment, cost, "rival_solar_install", "rival");
    r.solarW = 2_000;
    emit(s, ctx, "RIVAL_STRATEGY_CHANGED", ["rival"], `${r.name} installed 2 kW of rooftop solar for ${cr(cost)} credits: with diesel averaging ${cr(Math.round(avgPrice))}/L, daytime solar is cheaper for it.`, { strategy: "solar", costCc: cost });
    actions.push("installed 2 kW solar");
  }
  const wantFuel = Math.min(r.tankCapacityMl, RIVAL.estFuelMlPerDay * (RIVAL.targetFuelDays + r.stockpileDays)) - fuel;
  if (wantFuel >= 1000) {
    const candidates = Object.values(s.merchants)
      .filter((m) => m.status === "open" && merchantAvailable(s, m) >= 1000)
      .sort((a, b) => a.quoteCcPerL - b.quoteCcPerL || a.merchantId.localeCompare(b.merchantId));
    const m = candidates[0];
    if (m) {
      const cashFor = Math.floor((bal(s, "credits_cc", ACC.rival) * 1000) / m.quoteCcPerL / 1000) * 1000;
      const qty = Math.min(Math.floor(wantFuel / 1000) * 1000, Math.floor(merchantAvailable(s, m) / 1000) * 1000, m.reasons.rationLimitMl ?? Infinity, cashFor);
      if (qty >= 1000) {
        try {
          const q = createQuote(s, ctx, ACC.rival, ACC.merchant(m.merchantId), "diesel", qty);
          buy(s, ctx, ACC.rival, q.quoteId, q.maxQuantity, `rival-${s.day}-fuel`, { chainLeg: false });
          actions.push(`bought ${L(q.maxQuantity)} L from ${m.name} at ${cr(q.unitPriceCc)}/L`);
          emit(s, ctx, "RIVAL_PURCHASED", ["rival", ACC.merchant(m.merchantId)], `${r.name} bought ${L(q.maxQuantity)} L of diesel from ${m.name} at ${cr(q.unitPriceCc)}/L (cheapest open seller).`, { item: "diesel", merchantId: m.merchantId, quantityMl: q.maxQuantity, unitPriceCc: q.unitPriceCc });
        } catch (e) {
          if (!(e instanceof SimError)) throw e;
          actions.push(`fuel purchase failed: ${e.code}`);
        }
      }
    } else actions.push("no merchant had diesel");
  }
  const permitNeed = Math.ceil((RIVAL.estFuelMlPerDay * 2680 * 3) / 2 / PERMIT_MG); // 1.5 days of allowance
  const have = Math.floor(bal(s, "permit_mg", ACC.rival) / PERMIT_MG);
  if (have < permitNeed) {
    const want = permitNeed - have;
    const affordable = Math.floor(bal(s, "credits_cc", ACC.rival) / Math.max(1, s.regulator.permitPriceCc));
    const qty = Math.min(want, affordable, Math.floor(bal(s, "permit_mg", ACC.regulator) / PERMIT_MG));
    if (qty > 0) {
      const q = createQuote(s, ctx, ACC.rival, "regulator", "permit", qty);
      buy(s, ctx, ACC.rival, q.quoteId, q.maxQuantity, `rival-${s.day}-permits`, { chainLeg: false });
      actions.push(`bought ${q.maxQuantity} permits`);
    }
  }
  repriceRival(s, ctx, `morning: fuel basis ${cr(r.fuelCostBasisCcPerL)}/L`);
  r.lastAction = actions.length ? actions.join("; ") : r.lastAction;
}

/**
 * Called when a player request is missed (expired / declined / walked away).
 * The rival only wins if it can physically supply and the customer accepts its tariff.
 */
export function rivalBid(s: SimState, ctx: Ctx, req: RequestState, why: string): void {
  if (!rivalActive(s)) return;
  const r = s.rival;
  const b = s.businesses[req.businessId];
  const reasons: string[] = [];
  if (!rivalCanServe(s, req.requestedW, req.durationHours)) reasons.push("not enough spare capacity, fuel or permits");
  const { ceiling } = acceptCeiling(s, b, req.requestedW, req.durationHours);
  if (r.tariffCcPerKwh > ceiling + 100) reasons.push(`customer will not pay its ${cr(r.tariffCcPerKwh)}/kWh`);
  if (r.tariffCcPerKwh < r.tariffReasons.unitCostCcPerKwh) reasons.push("unprofitable at its own costs");
  const escrow = ccForEnergy(req.requestedW * req.durationHours, r.tariffCcPerKwh);
  if (businessCash(s, b) < escrow) reasons.push("customer cannot escrow the payment");
  if (reasons.length) {
    r.contractsDeclined += 1;
    r.declinedToday += 1;
    r.lastAction = `Declined ${b.name}: ${reasons.join("; ")}`;
    emit(s, ctx, "RIVAL_DECLINED_CONTRACT", ["rival", `business:${b.businessId}`], `${r.name} passed on ${b.name} (${reasons.join("; ")}). ${b.name} stays dark.`, { requestId: req.requestId, reasons });
    return;
  }
  const prevStatus = req.status;
  const c = formContract(s, ctx, req, r.tariffCcPerKwh, "rival");
  c.status = "active";
  c.startTick = s.tick;
  req.resolutionReason = `${why}; rival served at ${cr(r.tariffCcPerKwh)}/kWh`;
  r.contractsWon += 1;
  r.wonToday += 1;
  r.customersServedToday += 1;
  if (b.provider === "player") s.dayStats.lostToRival += 1;
  b.loyaltyBps = Math.max(0, b.loyaltyBps - 200);
  r.lastAction = `Won ${b.name} at ${cr(r.tariffCcPerKwh)}/kWh`;
  emit(s, ctx, "RIVAL_WON_CONTRACT", ["rival", `business:${b.businessId}`], `${r.name} took ${b.name} after the request was ${prevStatus === "lost_to_rival" ? "routed to it" : why}: ${kW(req.requestedW)} kW × ${req.durationHours}h at ${cr(r.tariffCcPerKwh)}/kWh. Customer margin at that price: ${cr(profitPerHourAt(b, r.tariffCcPerKwh))}/hour.`, {
    requestId: req.requestId,
    contractId: c.contractId,
    businessId: b.businessId,
    rateCcPerKwh: r.tariffCcPerKwh,
  });
}

/** Day 2+: customers re-evaluate their provider from prices, loyalty and gouging history. */
export function customersChooseProvider(s: SimState, ctx: Ctx): void {
  if (!rivalActive(s)) return;
  const r = s.rival;
  for (const b of Object.values(s.businesses)) {
    if (b.status === "closed" || !s.districts[b.districtId].unlocked || b.fixedTariffCcPerKwh !== null) continue;
    const mine = s.player.tariffs[b.districtId];
    let to: "player" | "rival" | null = null;
    let why = "";
    if (b.provider === "player") {
      if (b.gougeCount >= b.gougeTolerance) {
        to = "rival";
        why = `gouged ${b.gougeCount} times (tolerance ${b.gougeTolerance})`;
      } else if (b.loyaltyBps < 3_500 && mine > r.tariffCcPerKwh + 100 && r.tariffCcPerKwh <= breakEvenRate(b)) {
        to = "rival";
        why = `loyalty ${(b.loyaltyBps / 100).toFixed(0)}% and your ${cr(mine)}/kWh vs rival ${cr(r.tariffCcPerKwh)}/kWh`;
      }
    } else if (mine + 100 < r.tariffCcPerKwh || r.declinedToday > 0) {
      to = "player";
      why = r.declinedToday > 0 ? "the rival could not serve everyone yesterday" : `your ${cr(mine)}/kWh beats rival ${cr(r.tariffCcPerKwh)}/kWh`;
    }
    if (to) {
      const from = b.provider;
      b.provider = to;
      emit(s, ctx, "CUSTOMER_SWITCHED_PROVIDER", [`business:${b.businessId}`, to === "rival" ? "rival" : "player"], `${b.name} switched from ${from === "player" ? "you" : r.name} to ${to === "player" ? "you" : r.name}: ${why}.`, { businessId: b.businessId, from, to, reason: why });
    }
  }
}

export function resetRivalDay(s: SimState): void {
  s.rival.wonToday = 0;
  s.rival.declinedToday = 0;
  s.rival.customersServedToday = 0;
  s.rival.boughtToday = false;
}

// ------------------------------------------------------------------ regulator

/** Dawn: issue today's permit supply (cap) and set the auction price from yesterday's emissions. */
export function regulatorMorning(s: SimState, ctx: Ctx): void {
  const reg = s.regulator;
  // the permit supply grows with the part of the city the grid serves
  const connected = Object.values(s.districts).filter((d) => d.unlocked).length;
  const baseCap = REGULATOR.dailyCapPermits[Math.min(s.day - 1, REGULATOR.dailyCapPermits.length - 1)] * Math.max(1, connected);
  const policyBps = worldModifiers(s).permitSupplyBps;
  const cap = Math.max(1, Math.round((baseCap * (10_000 + policyBps)) / 10_000));
  const prevCap = reg.dailyCapPermits;
  reg.dailyCapPermits = cap;
  reg.permitsSoldToday = 0;
  transfer(s, ctx, "permit_mg", ACC.permitIssuer, ACC.regulator, cap * PERMIT_MG, "daily_permit_issue", `day${s.day}`);
  // price reacts to how much everyone burned vs the cap
  const target = Math.max(1, prevCap * PERMIT_MG);
  const pressureBps = Math.trunc(((reg.emissionsYesterdayMg - target) * REGULATOR.priceSensitivityBps) / target);
  const mult = Math.max(REGULATOR.minPriceBps, Math.min(REGULATOR.maxPriceBps, 10_000 + pressureBps + (cap < prevCap ? 1_500 : 0)));
  const old = reg.permitPriceCc;
  reg.permitPriceCc = Math.round((REGULATOR.basePermitPriceCc * mult) / 10_000 / 10) * 10;
  reg.priceReason = `Base ${cr(REGULATOR.basePermitPriceCc)}; yesterday's emissions ${(reg.emissionsYesterdayMg / 1e6).toFixed(1)} kg vs cap ${(target / 1e6).toFixed(0)} kg (${pressureBps >= 0 ? "+" : ""}${(pressureBps / 100).toFixed(1)}%)${cap < prevCap ? ", cap cut +15%" : ""} → ${cr(reg.permitPriceCc)} per permit.`;
  if (s.day > 1 && cap < prevCap) {
    const note = `Vesper City's regulator cut the daily permit cap from ${prevCap} to ${cap} permits (${cap * 10} kg CO2)${policyBps ? " — fictional local policy event" : ""}.`;
    reg.notices.push(note);
    emit(s, ctx, "REGULATOR_NOTICE", ["regulator"], note, { capPermits: cap, prevCapPermits: prevCap });
  }
  if (old !== reg.permitPriceCc || s.day === 1) {
    emit(s, ctx, "REGULATOR_NOTICE", ["regulator"], `Permit auction price: ${cr(reg.permitPriceCc)} credits per 10 kg. ${reg.priceReason}`, { permitPriceCc: reg.permitPriceCc, oldPriceCc: old, reason: reg.priceReason });
  }
  void oilTrend;
}

/** Night: unsold permits are retired (the cap is a daily cap), emissions roll over for pricing. */
export function regulatorSettlement(s: SimState, ctx: Ctx): void {
  const reg = s.regulator;
  const unsold = bal(s, "permit_mg", ACC.regulator);
  if (unsold > 0) transfer(s, ctx, "permit_mg", ACC.regulator, ACC.permitIssuer, unsold, "unsold_permits_withdrawn", `day${s.day}`);
  reg.emissionsYesterdayMg = reg.emissionsTodayMg;
  reg.emissionsTodayMg = 0;
}
