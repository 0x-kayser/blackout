/**
 * The autonomous economy (§8, §12): businesses and households with balance sheets, fuel suppliers, banks, VoltLine,
 * the regulator's reliability tenders, whole-asset sales and the steel → construction-cost link. Each actor follows
 * its own explained rule; nobody is bailed out.
 */
import type { FuelId, LoadBid, NodeId } from "@blackout/shared";
import { rngInt } from "../prng.ts";
import { SimError } from "../state.ts";
import { ACTORS, BANKS, BATTERY_EFF_BPS, HOUSEHOLD_SPEND, INTERVALS_PER_DAY, NODES, OWNERS, REGIONAL_FUEL_ENDOWMENT, regionalReserveAvailable, regionalReserveSealed, SUPPLIERS, TECHS, WAGE_SHARE_BPS, WAGE_SPLIT, intervalCc } from "./config.ts";
import { addPlant, assetIdOf, transferPlant } from "./engine.ts";
import { actorQuote, close, cooled, cr, emit, mw, open, openKeys, supplierQuote } from "./events.ts";
import type { ClearingResult } from "./market.ts";
import { burnPerKwInterval, clockOf, coolingBps, marginalCost, profileBps, worldFuelCc } from "./physics.ts";
import { RACC, fuelAsset, rbal, rtransfer, rtransferUpTo, type RCtx, type RPlant, type RegionState } from "./state.ts";

const ACTOR = Object.fromEntries(ACTORS.map((a) => [a.actorId, a]));
const HOUSEHOLDS = ACTORS.filter((a) => a.kind === "households").map((a) => a.actorId);

/** Baseline wages each household actor receives per interval with everyone employed. */
const BASE_WAGES: Record<string, number> = (() => {
  const total = ACTORS.reduce((a, x) => a + (x.fixedCcPerInterval * WAGE_SHARE_BPS) / 10_000, 0);
  return Object.fromEntries(HOUSEHOLDS.map((h) => [h, Math.round((total * (WAGE_SPLIT[h] ?? 0)) / 10_000)]));
})();

/* ------------------------------------------------------------------------------------------------ demand */

export function actorBids(s: RegionState, minuteOfDay: number): LoadBid[] {
  const bids: LoadBid[] = [];
  for (const cfg of ACTORS) {
    const a = s.actors[cfg.actorId];
    if (a.state === "closed") {
      a.demandKw = a.flexKw = a.essentialKw = 0;
      continue;
    }
    let bps = profileBps(cfg.profile, minuteOfDay) + coolingBps(cfg.profile, s.weather.tempC);
    if (cfg.employees > 0) bps = Math.round((bps * (5_000 + (5_000 * a.employees) / cfg.employees)) / 10_000);
    if (a.state === "strained") bps = Math.round(bps * 0.96);
    if (a.state === "distressed") bps = Math.round(bps * 0.88);
    const demand = Math.round((cfg.baseKw * bps) / 10_000);
    const flex = Math.round((demand * cfg.flexBps) / 10_000);
    a.demandKw = demand;
    a.flexKw = flex;
    a.essentialKw = demand - flex;
    const priority = cfg.priority;
    if (a.essentialKw > 0) bids.push({ loadId: `${cfg.actorId}:ess`, nodeId: cfg.nodeId, requestedMW: a.essentialKw / 1000, willingnessToPayPerMWh: cfg.essentialWtp, priorityClass: priority });
    if (flex > 0) bids.push({ loadId: `${cfg.actorId}:flex`, nodeId: cfg.nodeId, requestedMW: flex / 1000, willingnessToPayPerMWh: cfg.flexWtp, priorityClass: "flexible" });
  }
  return bids;
}

/* ---------------------------------------------------------------------------------------------- businesses */

export function actorsStep(s: RegionState, ctx: RCtx, r: ClearingResult): void {
  const wagesIn: Record<string, number> = Object.fromEntries(HOUSEHOLDS.map((h) => [h, 0]));
  const householdIndex = HOUSEHOLDS.reduce((a, h) => a + s.actors[h].incomeIndexBps, 0) / HOUSEHOLDS.length;
  const avgPrice24 = avgSpot(s, 288);
  for (const cfg of ACTORS) {
    const a = s.actors[cfg.actorId];
    const node = s.nodes[cfg.nodeId];
    if (a.state === "closed") {
      a.productionBps = 0;
      if (cfg.valuePerMWh > 0 && s.interval - a.closedSince >= INTERVALS_PER_DAY && avgPrice24 < 15_000) reopen(s, ctx, cfg.actorId);
      continue;
    }
    const essServed = Math.round((r.servedMW[`${cfg.actorId}:ess`] ?? 0) * 1000);
    const flexServed = Math.round((r.servedMW[`${cfg.actorId}:flex`] ?? 0) * 1000);
    const essShed = Math.max(0, a.essentialKw - essServed);
    const essShare = a.essentialKw > 0 ? essServed / a.essentialKw : 1;
    const flexShare = a.flexKw > 0 ? flexServed / a.flexKw : 1;
    const prod = Math.round(10_000 * essShare * (1 - cfg.flexBps / 10_000 + (cfg.flexBps / 10_000) * flexShare));
    a.productionBps = cfg.valuePerMWh > 0 ? prod : Math.round(10_000 * essShare);
    let profit = -intervalCc(node.priceCc, essServed + flexServed);
    const acct = RACC.actor(cfg.actorId);

    if (cfg.valuePerMWh > 0) {
      // revenue for what they produced; shops and campuses sell to households, so they track household income
      const demandFactor = cfg.kind === "commerce" ? householdIndex / 10_000 : 1;
      const revenue = Math.round(intervalCc(cfg.valuePerMWh, essServed + flexServed) * demandFactor);
      rtransfer(s, ctx, "cc", RACC.extExports, acct, revenue, "sales");
      profit += revenue;
      const staffRatio = cfg.employees > 0 ? a.employees / cfg.employees : 1;
      const wageBill = Math.round(((cfg.fixedCcPerInterval * WAGE_SHARE_BPS) / 10_000) * staffRatio);
      const overhead = cfg.fixedCcPerInterval - Math.round((cfg.fixedCcPerInterval * WAGE_SHARE_BPS) / 10_000);
      let paidWages = 0;
      for (const h of HOUSEHOLDS) {
        const share = Math.round((wageBill * (WAGE_SPLIT[h] ?? 0)) / 10_000);
        const paid = rtransferUpTo(s, ctx, "cc", acct, RACC.actor(h), share, "wages");
        wagesIn[h] += paid;
        paidWages += share;
      }
      rtransferUpTo(s, ctx, "cc", acct, RACC.extSpending, wageBill - paidWages + overhead, "wages and overheads");
      profit -= wageBill + overhead;
      if (essShed > 0) {
        const damage = intervalCc(Math.round(cfg.essentialWtp * 0.2), essShed);
        rtransferUpTo(s, ctx, "cc", acct, RACC.extSpending, damage, "blackout losses");
        profit -= damage;
      }
    }
    a.profitCcToday += profit;
    a.shedStreak = essShed > 0 ? a.shedStreak + 1 : 0;

    // borrowing before trouble (no bailouts: banks lend only to the healthy enough)
    const daily = Math.max(1, cfg.fixedCcPerInterval * INTERVALS_PER_DAY);
    const cash = rbal(s, "cc", acct);
    if (cfg.valuePerMWh > 0 && cash < cfg.fixedCcPerInterval * 36 && a.healthBps >= 2_000) borrow(s, ctx, acct, Math.round(daily * 0.6), a.healthBps);
    const debt = s.loans.filter((l) => l.borrower === acct).reduce((x, l) => x + l.principalCc, 0);

    // health
    let target: number;
    if (cfg.valuePerMWh > 0) {
      const cashDays = rbal(s, "cc", acct) / daily;
      const debtLoad = debt / (daily * 30);
      target = 3_500 + Math.min(cashDays, 2.4) * 2_500 - debtLoad * 2_500 - (essShed > 0 ? 3_000 : 0) - (a.productionBps < 6_000 ? 1_500 : 0) + (a.profitCcToday >= 0 ? 800 : -800);
    } else {
      const priceStress = Math.max(0, (node.priceCc - 20_000) / 40);
      target = 4_000 + a.incomeIndexBps / 2.2 - (essShed > 0 ? 3_500 : 0) - priceStress;
    }
    target = Math.max(0, Math.min(10_000, Math.round(target)));
    a.healthBps = Math.round(a.healthBps + (target - a.healthBps) / 24);

    if (cfg.valuePerMWh > 0) businessState(s, ctx, cfg.actorId, essShed);

    // demand response and blackout impact, told by the people involved
    const ckey = `curtail:${cfg.actorId}`;
    if (a.flexKw > 0 && flexShare < 0.5 && a.productionBps < 8_500 && !open(s, ckey) && cfg.kind !== "hospital" && cooled(s, ckey, 144)) {
      emit(s, ctx, { type: "DEMAND_RESPONSE", severity: "warn", title: `${cfg.name} cuts back at ${cr(node.priceCc)}/MWh`, detail: `${mw(a.flexKw - flexServed)} switched off because power costs more than it earns them. Output ${Math.round(a.productionBps / 100)}%.`, nodeId: cfg.nodeId, actorId: cfg.actorId, causeKeys: ["spike", `shed:${cfg.nodeId}`, ...openKeys(s, "cong:"), ...openKeys(s, "ration:")], quote: actorQuote(cfg.actorId, "curtail", { priceCc: node.priceCc, productionBps: a.productionBps }) }, ckey);
    } else if (open(s, ckey) && flexShare > 0.9) close(s, ckey);
    const skey = `ashed:${cfg.actorId}`;
    if (essShed > 0 && !open(s, skey) && cooled(s, skey, 36)) {
      const lossCc = intervalCc(Math.round(cfg.essentialWtp * 0.2), essShed);
      emit(s, ctx, { type: "BLACKOUT_IMPACT", severity: "crisis", title: `${cfg.name} loses power`, detail: `${mw(essShed)} dark.`, nodeId: cfg.nodeId, actorId: cfg.actorId, causeKeys: [`shed:${cfg.nodeId}`], quote: actorQuote(cfg.actorId, "shed", { shedKw: essShed, lossCc }) }, skey);
    } else if (essShed === 0 && open(s, skey)) close(s, skey);
  }

  // households: wages in, bills paid above, spending out
  for (const h of HOUSEHOLDS) {
    const a = s.actors[h];
    const base = Math.max(1, BASE_WAGES[h]);
    const ratio = Math.round((wagesIn[h] * 10_000) / base);
    a.incomeIndexBps = Math.round(a.incomeIndexBps + (ratio - a.incomeIndexBps) / 36);
    const spend = Math.round(base * 0.85 * (a.incomeIndexBps / 10_000));
    rtransferUpTo(s, ctx, "cc", RACC.actor(h), RACC.extSpending, spend, "household spending");
    a.profitCcToday += wagesIn[h] - spend;
  }
  void HOUSEHOLD_SPEND;
}

function businessState(s: RegionState, ctx: RCtx, actorId: string, essShed: number): void {
  const cfg = ACTOR[actorId];
  const a = s.actors[actorId];
  const acct = RACC.actor(actorId);
  const prev = a.state;
  const cash = rbal(s, "cc", acct);
  const causes = [`curtail:${actorId}`, `ashed:${actorId}`, `shed:${cfg.nodeId}`, "spike", `distress:${actorId}`];
  if (cash <= cfg.fixedCcPerInterval * 6 && a.healthBps < 2_000) {
    const lost = a.employees;
    a.state = "closed";
    a.closedSince = s.interval;
    a.employees = 0;
    a.productionBps = 0;
    // the banks write off what they lent
    s.loans = s.loans.filter((l) => l.borrower !== acct);
    emit(s, ctx, { type: "BUSINESS_CLOSED", severity: "crisis", title: `${cfg.name} closes`, detail: `${lost.toLocaleString("en-US")} jobs lost and ${mw(cfg.baseKw)} of demand gone. Their banks wrote off the loans.`, nodeId: cfg.nodeId, actorId, causeKeys: causes, quote: actorQuote(actorId, "closed", { lost }) }, `closed:${actorId}`);
    close(s, `distress:${actorId}`);
    return;
  }
  a.state = a.healthBps < 2_500 ? "distressed" : a.healthBps < 4_500 ? "strained" : "operating";
  if (a.state === "distressed" && prev !== "distressed") {
    emit(s, ctx, { type: "BUSINESS_DISTRESS", severity: "warn", title: `${cfg.name} is in trouble`, detail: `Health ${Math.round(a.healthBps / 100)}%, ${cr(cash)} in the bank. Layoffs follow if power stays dear.`, nodeId: cfg.nodeId, actorId, causeKeys: causes, quote: actorQuote(actorId, "distressed", { employees: a.employees }) }, `distress:${actorId}`);
  } else if (a.state === "strained" && prev === "operating" && cooled(s, `strained:${actorId}`, 288)) {
    emit(s, ctx, { type: "BUSINESS_STRAINED", severity: "info", title: `${cfg.name} freezes hiring`, detail: `Health ${Math.round(a.healthBps / 100)}%.`, nodeId: cfg.nodeId, actorId, causeKeys: causes, quote: actorQuote(actorId, "strained", {}) });
  } else if (a.state === "operating" && prev !== "operating" && prev !== "strained") {
    emit(s, ctx, { type: "BUSINESS_RECOVERED", severity: "good", title: `${cfg.name} is back on its feet`, detail: `Health ${Math.round(a.healthBps / 100)}%.`, nodeId: cfg.nodeId, actorId, quote: actorQuote(actorId, "recovered", {}) });
    close(s, `distress:${actorId}`);
  }
  if (s.interval % 12 === 0 && cfg.employees > 0) {
    if (a.state === "distressed" && a.employees > cfg.employees * 0.4) {
      const lost = Math.max(1, Math.round(a.employees * 0.04));
      a.employees -= lost;
      if (s.interval % 36 === 0 || !open(s, `layoff:${actorId}`)) emit(s, ctx, { type: "LAYOFFS", severity: "warn", title: `${cfg.name} lays off ${lost.toLocaleString("en-US")}`, detail: `${a.employees.toLocaleString("en-US")} of ${cfg.employees.toLocaleString("en-US")} jobs left. Household incomes fall, and so does spending in the shops.`, nodeId: cfg.nodeId, actorId, causeKeys: [`distress:${actorId}`], quote: actorQuote(actorId, "layoffs", { lost }) }, `layoff:${actorId}`);
    } else if (a.state === "operating" && a.healthBps > 7_500 && a.employees < cfg.employees) {
      a.employees = Math.min(cfg.employees, a.employees + Math.max(1, Math.round(cfg.employees * 0.02)));
      close(s, `layoff:${actorId}`);
    }
  }
  void essShed;
}

function reopen(s: RegionState, ctx: RCtx, actorId: string): void {
  const cfg = ACTOR[actorId];
  const a = s.actors[actorId];
  const capital = cfg.fixedCcPerInterval * INTERVALS_PER_DAY * 2;
  rtransfer(s, ctx, "cc", RACC.extInvestors, RACC.actor(actorId), capital, "new owners' capital");
  a.state = "operating";
  a.healthBps = 6_000;
  a.employees = Math.round(cfg.employees * 0.6);
  a.closedSince = -1;
  close(s, `closed:${actorId}`);
  emit(s, ctx, { type: "BUSINESS_REOPENED", severity: "good", title: `${cfg.name} reopens under new owners`, detail: `${cr(capital)} of outside investment because power is affordable again. ${a.employees.toLocaleString("en-US")} jobs back.`, nodeId: cfg.nodeId, actorId, quote: actorQuote(actorId, "reopened", { employees: a.employees }) });
}

function borrow(s: RegionState, ctx: RCtx, borrower: string, amount: number, healthBps: number): number {
  for (const b of BANKS) {
    const bankCash = rbal(s, "cc", RACC.bank(b.bankId));
    const existing = s.loans.filter((l) => l.borrower === borrower).reduce((x, l) => x + l.principalCc, 0);
    // cautious banks need healthier borrowers
    if (healthBps < (b.maxLeverageBps <= 5_000 ? 4_000 : 2_000)) continue;
    if (existing > amount * 12) continue;
    const amt = Math.min(amount, Math.floor(bankCash / 4));
    if (amt <= 0) continue;
    rtransfer(s, ctx, "cc", RACC.bank(b.bankId), borrower, amt, "credit line");
    const rate = b.baseRateBps + Math.round((10_000 - healthBps) / 400);
    const loan = s.loans.find((l) => l.borrower === borrower && l.bankId === b.bankId);
    if (loan) {
      loan.rateBps = Math.round((loan.rateBps * loan.principalCc + rate * amt) / (loan.principalCc + amt));
      loan.principalCc += amt;
    } else s.loans.push({ loanId: `L${s.nextLoanNo++}`, bankId: b.bankId, borrower, principalCc: amt, rateBps: rate });
    return amt;
  }
  return 0;
}

/* -------------------------------------------------------------------------------------------------- finance */

export function financeStep(s: RegionState, ctx: RCtx): void {
  for (const l of [...s.loans]) {
    const interest = Math.round((l.principalCc * l.rateBps) / 10_000 / INTERVALS_PER_DAY);
    if (interest <= 0) continue;
    const paid = rtransferUpTo(s, ctx, "cc", l.borrower, RACC.bank(l.bankId), interest, "interest");
    if (paid < interest) l.principalCc += interest - paid;
    if (l.borrower === RACC.player) {
      s.player.profitCcToday -= paid;
      s.player.profitCcTotal -= paid;
    }
  }
  // player default: the bank forces a sale of the most valuable plant. No bailouts.
  if (s.interval % 12 === 0) {
    const debt = s.loans.filter((l) => l.borrower === RACC.player).reduce((a, l) => a + l.principalCc, 0);
    const assets = playerBookValue(s) + rbal(s, "cc", RACC.player);
    if (debt > 0 && debt > assets * 0.95) {
      const victim = s.plants.filter((p) => p.ownerId === "player" && p.status !== "building").sort((a, b) => b.capexCc - a.capexCc)[0];
      if (victim) {
        const price = Math.round(bookValue(victim) * 0.7);
        rtransfer(s, ctx, "cc", RACC.extInvestors, RACC.player, price, "forced sale proceeds");
        let left = price;
        for (const l of s.loans.filter((x) => x.borrower === RACC.player)) {
          const pay = Math.min(left, l.principalCc, rbal(s, "cc", RACC.player));
          rtransfer(s, ctx, "cc", RACC.player, RACC.bank(l.bankId), pay, "forced repayment");
          l.principalCc -= pay;
          left -= pay;
        }
        s.loans = s.loans.filter((l) => l.principalCc > 0);
        const buyer = "eastbank";
        transferPlant(s, ctx, victim, buyer, price);
        emit(s, ctx, { type: "FORECLOSURE", severity: "crisis", title: `Your bank forced the sale of ${victim.name}`, detail: `Debt passed 95% of your assets. ${cr(price)} went to the bank first.` });
      }
    }
  }
}

export function bookValue(p: RPlant): number {
  if (p.status === "building") return Math.round(p.capexCc * 0.9);
  return Math.round(((p.capexCc * p.healthBps) / 10_000) * 0.85);
}

export function playerBookValue(s: RegionState): number {
  return s.plants.filter((p) => p.ownerId === "player").reduce((a, p) => a + bookValue(p), 0);
}

/* ------------------------------------------------------------------------------------------------- suppliers */

export function fuelMarketCc(s: RegionState, fuel: FuelId): number {
  // once Vesper Market has spoken, its cheapest open price is the fuel price in the region
  const town = s.townPrices?.[fuel];
  if (town) return town;
  let best = Infinity;
  let worst = 0;
  for (const c of SUPPLIERS) {
    if (c.fuel !== fuel) continue;
    const sp = s.suppliers[c.supplierId];
    worst = Math.max(worst, sp.priceCc);
    if (sp.stock > 0) best = Math.min(best, sp.priceCc);
  }
  return best === Infinity ? Math.round(worst * 1.5) : best;
}

/** Cuts one fuel supplier's imports to a fifth for a few game hours. False if it was already disrupted. */
export function disruptSupplier(s: RegionState, ctx: RCtx, supplierId: string): boolean {
  const pick = SUPPLIERS.find((x) => x.supplierId === supplierId)!;
  const sp = s.suppliers[pick.supplierId];
  if (s.interval < sp.disruptionUntil) return false;
  sp.disruptionUntil = s.interval + 96 + rngInt(s.rng, 96);
  const why = pick.fuel === "gas" ? (pick.supplierId === "northline" ? "pipeline compressor maintenance" : "a delayed tanker") : "a tanker drivers' strike";
  emit(s, ctx, { type: "SUPPLY_DISRUPTION", severity: "warn", title: `${pick.name}: imports cut by ${why}`, detail: `${pick.person}'s ${pick.fuel} imports drop to a fifth for about ${Math.round(((sp.disruptionUntil - s.interval) * 5) / 60)} game hours.`, quote: supplierQuote(pick.supplierId, "disrupted", {}) }, `supply:${pick.supplierId}`);
  return true;
}

export function suppliersStep(s: RegionState, ctx: RCtx, init: boolean): void {
  if (!init) regionalReserveStep(s, ctx);
  // a disruption roughly every few days, never during the first game hours
  if (!init && s.interval > 72 && s.interval % 96 === 48) {
    if (rngInt(s.rng, 1000) < 330) disruptSupplier(s, ctx, SUPPLIERS[rngInt(s.rng, SUPPLIERS.length)].supplierId);
  }
  const anyRationing = Object.values(s.suppliers).some((x) => x.rationing);
  for (const c of SUPPLIERS) {
    const sp = s.suppliers[c.supplierId];
    sp.soldThisInterval = {};
    const disrupted = s.interval < sp.disruptionUntil;
    if (!disrupted && open(s, `supply:${c.supplierId}`)) {
      close(s, `supply:${c.supplierId}`);
      emit(s, ctx, { type: "SUPPLY_RESTORED", severity: "good", title: `${c.name} imports back to normal`, detail: "", quote: supplierQuote(c.supplierId, "recovered", {}) });
    }
    sp.importPerInterval = disrupted ? Math.round(c.importPerInterval * 0.2) : c.importPerInterval;
    const world = worldFuelCc(s, c.fuel);
    if (!init) {
      const room = c.capacity - sp.stock;
      const wantFill = c.supplierId === "okafor" ? 0.95 : 0.85;
      if (sp.stock < c.capacity * wantFill && room > 0) {
        const buyPrice = Math.round(world * 0.92);
        const cashCap = Math.floor((rbal(s, "cc", RACC.supplier(c.supplierId)) * 1000) / Math.max(1, buyPrice));
        const reserve = regionalReserveAvailable(c.fuel);
        const qty = Math.max(0, Math.min(sp.importPerInterval, room, cashCap, rbal(s, fuelAsset(c.fuel), reserve)));
        if (qty > 0) {
          rtransfer(s, ctx, "cc", RACC.supplier(c.supplierId), RACC.extImports, Math.round((qty * buyPrice) / 1000), "fuel imports");
          rtransfer(s, ctx, fuelAsset(c.fuel), reserve, RACC.supplier(c.supplierId), qty, "finite regional fuel reserve");
          sp.stock += qty;
        }
      }
    }
    const fill = sp.stock / c.capacity;
    const scarcity = 1 + (Math.max(0, 0.4 - fill) / 0.4) * 1.2;
    let markup = c.markupBps;
    if (c.supplierId === "okafor" && anyRationing && fill > 0.5) markup += 2_500;
    const totalReserve = s.resourceLedger?.totals[c.fuel] ?? 0;
    const reserveLeft = regionalReserveRemaining(s, c.fuel);
    const extractedBps = totalReserve > 0 ? Math.max(0, 10_000 - Math.round((reserveLeft * 10_000) / totalReserve)) : 0;
    const reservePressure = 1 + (extractedBps / 10_000) ** 2 * 2.5;
    sp.priceCc = Math.round(world * (1 + markup / 10_000) * scarcity * reservePressure);
    const rKey = `ration:${c.supplierId}`;
    const wasRationing = sp.rationing;
    sp.rationing = fill * 10_000 < c.rationBps;
    if (sp.rationing && !wasRationing && !init && cooled(s, rKey, 144)) {
      emit(s, ctx, { type: "RATIONING", severity: "warn", title: `${c.person} is rationing ${c.fuel}`, detail: `${c.name} is down to ${Math.round(fill * 100)}% and sells at most a share per buyer. ${c.fuel === "gas" ? "Gas plants" : "Diesel peakers"} that can't buy elsewhere run short.`, causeKeys: [`supply:${c.supplierId}`, "spike", "heat"], quote: supplierQuote(c.supplierId, "ration", { fillPct: Math.round(fill * 100), priceCc: sp.priceCc }) }, rKey);
    } else if (!sp.rationing && open(s, rKey) && fill * 10_000 > c.rationBps * 2) close(s, rKey);
  }
}

function regionalReserveRemaining(s: RegionState, fuel: FuelId): number {
  const prefix = `reserve:regional:${fuel}:`;
  return Object.entries(s.balances[fuelAsset(fuel)] ?? {}).filter(([account]) => account.startsWith(prefix)).reduce((sum, [, amount]) => sum + amount, 0);
}

function regionalReserveStep(s: RegionState, ctx: RCtx): void {
  const day = Math.floor(s.interval / INTERVALS_PER_DAY);
  for (const fuel of ["gas", "diesel"] as const) {
    const config = REGIONAL_FUEL_ENDOWMENT[fuel];
    for (const deposit of config.deposits) {
      if (deposit.day === 0 || day < deposit.day) continue;
      const sealed = regionalReserveSealed(fuel, deposit.day);
      const quantity = rbal(s, fuelAsset(fuel), sealed);
      if (quantity <= 0) continue;
      rtransfer(s, ctx, fuelAsset(fuel), sealed, regionalReserveAvailable(fuel), quantity, "scheduled finite resource release");
      emit(s, ctx, { type: "RESOURCE_DEPOSIT", severity: "info", title: `${deposit.name} reaches local suppliers`, detail: `${Math.round(quantity / 1000).toLocaleString("en-US")} ${fuel === "gas" ? "MMBtu of gas" : "L of diesel"} released from this region's fixed allotment.`, quote: { person: "Vesper Resource Office", face: "🏛️", text: "This stock was sealed into the city's opening endowment; the release adds none to the world's total." } });
    }
    const total = s.resourceLedger?.totals[fuel] ?? 0;
    if (total <= 0) continue;
    const remaining = regionalReserveRemaining(s, fuel);
    const current = Math.max(0, Math.round((remaining * 10_000) / total));
    const previous = s.resourceLedger!.noticeBps[fuel] ?? 10_000;
    const label = fuel === "gas" ? "natural gas" : "diesel";
    if (previous > 0 && current === 0) emit(s, ctx, { type: "RESOURCE_SCARCITY", severity: "crisis", title: `No unallocated ${label} remains`, detail: `The regional allotment is exhausted; existing supplier and owner inventories are all that remain.`, quote: { person: "Vesper Resource Office", face: "🏛️", text: "Trade and stored fuel are the only remaining sources." } });
    else if (previous > 1_000 && current <= 1_000) emit(s, ctx, { type: "RESOURCE_SCARCITY", severity: "crisis", title: `${label} reserve nearly exhausted`, detail: `Only ${Math.round(remaining / 1000).toLocaleString("en-US")} ${fuel === "gas" ? "MMBtu" : "L"} remain in sealed or market-ready storage.`, quote: { person: "Vesper Resource Office", face: "🏛️", text: "No new fuel will be created. Prepare generation that does not depend on this stock." } });
    else if (previous > 2_500 && current <= 2_500) emit(s, ctx, { type: "RESOURCE_SCARCITY", severity: "warn", title: `${label} reserve below 25%`, detail: `${Math.round(remaining / 1000).toLocaleString("en-US")} ${fuel === "gas" ? "MMBtu" : "L"} remain outside supplier tanks. Your plants may need stored fuel, solar or batteries.`, quote: { person: "Vesper Resource Office", face: "🏛️", text: "Deliveries now depend on the remaining fixed reserve." } });
    s.resourceLedger!.noticeBps[fuel] = Math.min(previous, current);
  }
}

/** Buys up to `qty` units (milli-MMBtu / mL). `strict` throws on any shortfall (player clicks); NPCs take what they can. */
export function buyFuel(s: RegionState, ctx: RCtx, buyer: string, supplierId: string, qtyWholeOrMilli: number, strict: boolean, milli = !strict): number {
  const c = SUPPLIERS.find((x) => x.supplierId === supplierId);
  if (!c) throw new SimError("NOT_FOUND", "No such supplier.");
  const sp = s.suppliers[supplierId];
  let qty = milli ? qtyWholeOrMilli : qtyWholeOrMilli * 1000;
  const unit = c.fuel === "gas" ? "MMBtu" : "L";
  if (sp.stock <= 0) {
    if (strict) throw new SimError("OUT_OF_STOCK", `${c.person} has no ${c.fuel} left.`);
    return 0;
  }
  if (sp.rationing) {
    const limit = Math.round(c.importPerInterval * 0.4) - (sp.soldThisInterval[buyer] ?? 0);
    if (qty > limit) {
      if (strict && limit <= 0) throw new SimError("RATION_LIMIT", `${c.person} is rationing: you've had your share this interval.`);
      qty = Math.max(0, limit);
    }
  }
  qty = Math.min(qty, sp.stock);
  const cash = rbal(s, "cc", buyer);
  const affordable = Math.floor((cash * 1000) / Math.max(1, sp.priceCc));
  if (qty > affordable) {
    if (strict) throw new SimError("INSUFFICIENT_CREDITS", `${Math.round(qty / 1000).toLocaleString("en-US")} ${unit} costs ${cr(Math.round((qty * sp.priceCc) / 1000))}; you have ${cr(cash)}.`);
    qty = affordable;
  }
  if (qty <= 0) return 0;
  const cost = Math.round((qty * sp.priceCc) / 1000);
  rtransfer(s, ctx, "cc", buyer, RACC.supplier(supplierId), cost, `${c.fuel} purchase`);
  rtransfer(s, ctx, fuelAsset(c.fuel), RACC.supplier(supplierId), buyer, qty, `${c.fuel} purchase`);
  sp.stock -= qty;
  sp.soldThisInterval[buyer] = (sp.soldThisInterval[buyer] ?? 0) + qty;
  return qty;
}

/** Every thermal owner keeps about three hours of fuel for its committed plants. The player can switch this off. */
export function autoFuelStep(s: RegionState, ctx: RCtx): void {
  const owners = new Set(s.plants.filter((p) => TECHS[p.tech].fuel).map((p) => p.ownerId));
  for (const ownerId of owners) {
    for (const fuel of ["gas", "diesel"] as const) {
      // the player's fuel comes from Vesper Market (bought by the server when auto-buy is on)
      if (ownerId === "player") continue;
      const plants = s.plants.filter((p) => p.ownerId === ownerId && TECHS[p.tech].fuel === fuel && (p.status === "online" || p.status === "starting" || (p.online && p.status !== "mothballed")));
      if (!plants.length) continue;
      const target = Math.round(plants.reduce((a, p) => a + p.capacityKw * burnPerKwInterval(p), 0) * 36);
      const acct = RACC.owner(ownerId);
      const have = rbal(s, fuelAsset(fuel), acct);
      if (have >= target * 0.5) continue;
      let need = target - have;
      const order = SUPPLIERS.filter((c) => c.fuel === fuel).sort((a, b) => Number(s.suppliers[a.supplierId].rationing) - Number(s.suppliers[b.supplierId].rationing) || s.suppliers[a.supplierId].priceCc - s.suppliers[b.supplierId].priceCc);
      for (const c of order) {
        if (need <= 0) break;
        need -= buyFuel(s, ctx, acct, c.supplierId, need, false, true);
      }
    }
  }
}

/* ------------------------------------------------------------------------------------------------- VoltLine */

export function voltlineStep(s: RegionState, ctx: RCtx): void {
  if (s.interval % 12 !== 0) return;
  const v = s.voltline;
  const acct = RACC.owner("voltline");
  const tight = s.pulse.availableKw < s.pulse.demandKw * 1.05;
  const peakers = s.plants.filter((p) => p.ownerId === "voltline" && p.tech === "ocgt" && p.status === "online");
  const util = peakers.length ? peakers.reduce((a, p) => a + p.outputKw, 0) / Math.max(1, peakers.reduce((a, p) => a + p.capacityKw, 0)) : 0;
  v.marginBps = Math.max(500, Math.min(6_000, v.marginBps + (tight ? 300 : util < 0.3 ? -200 : 0)));
  const dailyInterest = s.loans.filter((l) => l.borrower === acct).reduce((a, l) => a + (l.principalCc * l.rateBps) / 10_000, 0);
  const cash = rbal(s, "cc", acct);
  const prev = v.state;
  v.state = cash < dailyInterest * 2 ? "distressed" : cash < dailyInterest * 6 ? "strained" : "healthy";
  if (v.state === "distressed" && prev !== "distressed") {
    v.distressSince = s.interval;
    emit(s, ctx, { type: "VOLTLINE_DISTRESS", severity: "warn", title: "VoltLine can barely cover its interest", detail: `${cr(cash)} in cash against ${cr(dailyInterest)} of interest a day. Victor Lane is selling assets.`, causeKeys: openKeys(s, "trip:", "ration:", "spike"), quote: { person: "Victor Lane", face: "🧑🏼‍💼", text: `With gas at ${cr(fuelMarketCc(s, "gas"))} and our units tripping, the bank owns more of VoltLine than I do. Make me an offer.` } }, "voltline_distress");
    const forSale = s.plants.filter((p) => p.ownerId === "voltline" && p.tech !== "ccgt" && p.status !== "building").sort((a, b) => b.capexCc - a.capexCc)[0];
    if (forSale && !s.listings.some((l) => l.plantId === forSale.plantId)) {
      s.listings.push({ plantId: forSale.plantId, seller: "voltline", askCc: Math.round(bookValue(forSale) * 0.8), bids: [], listedAt: s.interval });
      emit(s, ctx, { type: "ASSET_FOR_SALE", severity: "info", title: `VoltLine lists ${forSale.name} (${assetIdOf(forSale.assetNo)}) for sale`, detail: `Asking ${cr(Math.round(bookValue(forSale) * 0.8))}: 80% of book value. Buy it in PORTFOLIO.`, nodeId: forSale.nodeId, causeKeys: ["voltline_distress"] });
    }
  }
  if (v.state === "distressed" && v.distressSince >= 0 && s.interval - v.distressSince >= 96 && !open(s, "voltline_mothball")) {
    const dear = s.plants.filter((p) => p.ownerId === "voltline" && TECHS[p.tech].fuel && p.status !== "mothballed" && p.status !== "building").sort((a, b) => TECHS[b.tech].heatRate - TECHS[a.tech].heatRate || a.capacityKw - b.capacityKw)[0];
    if (dear) {
      dear.status = "mothballed";
      dear.online = false;
      dear.outputKw = 0;
      emit(s, ctx, { type: "VOLTLINE_MOTHBALL", severity: "crisis", title: `VoltLine mothballs ${dear.name}`, detail: `${mw(dear.capacityKw)} leaves the market to save fixed costs. Tomorrow's evening peak just got tighter.`, nodeId: dear.nodeId, causeKeys: ["voltline_distress"] }, "voltline_mothball");
    }
  }
  if (v.state === "healthy" && prev !== "healthy") {
    close(s, "voltline_distress");
    for (const p of s.plants) if (p.ownerId === "voltline" && p.status === "mothballed") {
      p.status = "offline";
      emit(s, ctx, { type: "VOLTLINE_RECOVERS", severity: "good", title: `VoltLine brings ${p.name} back`, detail: "", nodeId: p.nodeId });
    }
    close(s, "voltline_mothball");
    s.listings = s.listings.filter((l) => l.seller !== "voltline");
    v.distressSince = -1;
  }
  // dividends: VoltLine's owners take what isn't needed as a cushion, so a few bad days really hurt
  if (s.interval % 288 === 0) {
    const fixedDaily = s.plants.filter((p) => p.ownerId === "voltline").reduce((a, p) => a + p.capacityKw * 8, 0);
    const cushion = (dailyInterest + fixedDaily) * 4;
    const payout = Math.max(0, Math.round((rbal(s, "cc", acct) - cushion) * 0.6));
    if (payout > 0) rtransfer(s, ctx, "cc", acct, RACC.extInvestors, payout, "VoltLine dividend");
  }
  // investment: build where prices have been high for a day
  v.investCooldown -= 12;
  if (v.investCooldown <= 0 && v.state === "healthy" && s.history.length >= 200) {
    const best = NODES.map((n) => ({ n, avg: avg(s.nodes[n.nodeId].priceWindow) })).sort((a, b) => b.avg - a.avg)[0];
    const size = TECHS.ocgt.sizes[1];
    if (best.avg > 13_000 && cash > size.costCc * 1.5) {
      rtransfer(s, ctx, "cc", acct, RACC.extConstruction, size.costCc, "VoltLine new build");
      const p = addPlant(s, { plantId: `v${s.nextAssetNo}`, name: `VoltLine ${best.n.name.split(" ")[0]} OCGT`, tech: "ocgt", nodeId: best.n.nodeId, ownerId: "voltline", capacityKw: size.capacityKw, online: true, built: false, buildIntervals: size.intervals, capexCc: size.costCc });
      emit(s, ctx, { type: "VOLTLINE_BUILDS", severity: "info", title: `VoltLine breaks ground on ${p.name}`, detail: `${best.n.name} has averaged ${cr(Math.round(best.avg))}/MWh. ${mw(size.capacityKw)} arrives in ${Math.round((size.intervals * 5) / 60)} game hours and will compete with you.`, nodeId: best.n.nodeId, causeKeys: ["spike", ...openKeys(s, "cong:")] });
      v.investCooldown = INTERVALS_PER_DAY * 2;
    } else v.investCooldown = 36;
  }
}

/* --------------------------------------------------------------------------------- regulator, tenders, sales */

export function regulatorStep(s: RegionState, ctx: RCtx, r: ClearingResult): void {
  void ctx;
  void r;
  const shedNodes = NODES.filter((n) => s.nodes[n.nodeId].shedKw > 0).map((n) => n.name);
  s.regulator.lastNote = shedNodes.length
    ? `Load shedding in ${shedNodes.join(", ")}. Offers above max(2× cost, ₡1,000) are capped and idle fuelled capacity is fined.`
    : s.pulse.availableKw < s.pulse.demandKw * 1.1
      ? "Reserve margin under 10%. Tenders open where the lights went out."
      : "System secure. Carbon is priced at the world rate.";
}

export function tendersStep(s: RegionState, ctx: RCtx): void {
  const { minuteOfDay } = clockOf(s.interval);
  if (s.interval % 12 === 0) {
    for (const n of NODES) {
      const node = s.nodes[n.nodeId];
      const shedCount = node.shedWindow.reduce((a, b) => a + b, 0);
      if (shedCount < 3 || s.tenders.some((t) => t.nodeId === n.nodeId && t.status === "open")) continue;
      const toFive = ((17 * 60 - minuteOfDay + 1440) % 1440) / 5;
      const start = s.interval + (toFive < 24 ? toFive + 288 : toFive);
      const recentShed = s.history.slice(-12).length ? node.shedKw : 0;
      const needKw = Math.max(20_000, Math.round((recentShed * 1.2) / 10_000) * 10_000);
      const payCc = Math.round((needKw / 1000) * 150_000);
      if (rbal(s, "cc", RACC.regulator) < payCc) continue;
      const t = { tenderId: `T${s.nextTenderNo++}`, nodeId: n.nodeId as NodeId, needKw, payCc, windowStart: start, windowEnd: start + 48, okIntervals: 0, status: "open" as const, progressKw: 0 };
      s.tenders.push(t);
      emit(s, ctx, { type: "TENDER_POSTED", severity: "info", title: `Regulator tender: ${mw(needKw)} firm in ${n.name}`, detail: `Have ${mw(needKw)} of your own capacity ready there from 17:00 to 21:00 (${clockOf(start).label.split(" · ")[0]}) and earn ${cr(payCc)}, paid from carbon revenue.`, nodeId: n.nodeId, causeKeys: [`shed:${n.nodeId}`] });
    }
  }
  for (const t of s.tenders) {
    if (t.status !== "open") continue;
    t.progressKw = playerFirmKw(s, t.nodeId);
    if (s.interval >= t.windowStart && s.interval < t.windowEnd && t.progressKw >= t.needKw) t.okIntervals += 1;
    if (s.interval >= t.windowEnd) {
      const name = NODES.find((n) => n.nodeId === t.nodeId)!.name;
      if (t.okIntervals >= 48 * 0.8) {
        t.status = "met";
        const paid = rtransferUpTo(s, ctx, "cc", RACC.regulator, RACC.player, t.payCc, `tender ${t.tenderId}`);
        s.player.profitCcToday += paid;
        s.player.profitCcTotal += paid;
        s.player.revenueCcToday += paid;
        emit(s, ctx, { type: "TENDER_MET", severity: "good", title: `Tender met in ${name}: +${cr(paid)}`, detail: `Your capacity was there for ${t.okIntervals} of 48 intervals.`, nodeId: t.nodeId });
      } else {
        t.status = "missed";
        emit(s, ctx, { type: "TENDER_MISSED", severity: "warn", title: `Tender missed in ${name}`, detail: `Your capacity was there for only ${t.okIntervals} of 48 intervals (needed 39).`, nodeId: t.nodeId });
      }
    }
  }
  if (s.tenders.length > 8) s.tenders = s.tenders.filter((t, i) => t.status === "open" || i >= s.tenders.length - 8);
}

/** What the player could deliver at a node right now: online fuelled plants and charged batteries. */
export function playerFirmKw(s: RegionState, nodeId: string): number {
  let kw = 0;
  for (const p of s.plants) {
    if (p.ownerId !== "player" || p.nodeId !== nodeId) continue;
    if (p.tech === "battery" && p.status === "online") kw += Math.min(p.capacityKw, Math.floor(((p.socKwh * BATTERY_EFF_BPS) / 10_000) * 12));
    else if (TECHS[p.tech].fuel && (p.status === "online" || p.status === "starting")) kw += p.status === "online" ? p.lastAvailKw : 0;
  }
  return kw;
}

export function plantValue(s: RegionState, p: RPlant): number {
  const book = bookValue(p);
  const { minuteOfDay } = clockOf(s.interval);
  const elapsed = Math.max(12, Math.round(((minuteOfDay + 1440 - 17 * 60) % 1440) / 5) || 288);
  const dailyMargin = ((p.revenueCcToday - p.costCcToday) * INTERVALS_PER_DAY) / elapsed;
  const factor = Math.max(0, Math.min(1, (dailyMargin * 15) / Math.max(1, book)));
  return Math.round(book * (0.8 + 0.4 * factor));
}

export function listingsStep(s: RegionState, ctx: RCtx, force: boolean): void {
  if (!force && s.interval % 36 !== 0) return;
  void ctx;
  for (const l of s.listings) {
    if (l.seller !== "player") continue;
    const p = s.plants.find((x) => x.plantId === l.plantId)!;
    const value = plantValue(s, p);
    l.bids = [];
    const vCash = rbal(s, "cc", RACC.owner("voltline"));
    const vBid = Math.round(value * 0.95);
    if (s.voltline.state === "healthy" && vCash > vBid * 1.2) l.bids.push({ bidId: `B${s.nextBidNo++}`, bidder: "voltline", amountCc: vBid, reason: `Victor Lane values ${p.name} at ${cr(value)} on today's margins and wants the market share.` });
    const eCash = rbal(s, "cc", RACC.owner("eastbank"));
    const eBid = Math.round(value * 0.88);
    if (eCash > eBid) l.bids.push({ bidId: `B${s.nextBidNo++}`, bidder: "eastbank", amountCc: eBid, reason: `Omar Haddad pays a little under value: ${cr(eBid)}.` });
  }
}

/* --------------------------------------------------------------------------------------------- steel & costs */

export function steelStep(s: RegionState, ctx: RCtx): void {
  const steel = s.actors.steel;
  s.economy.steelWindow.push(steel.productionBps);
  if (s.economy.steelWindow.length > 36) s.economy.steelWindow.shift();
  const share = avg(s.economy.steelWindow) / 10_000;
  s.economy.steelIndexBps = 10_000 + Math.round((6_000 * Math.max(0, 0.95 - share)) / 0.95);
  if (s.economy.steelIndexBps >= 11_500 && !open(s, "steel")) {
    emit(s, ctx, { type: "STEEL_SHORTAGE", severity: "warn", title: "Steel mill slows: fewer deliveries to Vesper Market", detail: `Ivanova Steel is running at ${Math.round(share * 100)}%. Pavel's steel yard gets less to sell, so steel for new plants gets dearer.`, nodeId: "industrial_south", actorId: "steel", causeKeys: ["curtail:steel", "distress:steel", "closed:steel", "ashed:steel"], quote: actorQuote("steel", "steel", {}) }, "steel");
  } else if (s.economy.steelIndexBps < 10_500 && open(s, "steel")) {
    close(s, "steel");
    emit(s, ctx, { type: "STEEL_EASES", severity: "good", title: "Steel supply recovers", detail: "Construction costs are back to normal.", nodeId: "industrial_south" });
  }
}

/** Steel is ~40% of a plant's cost: build cost moves with the steel index (§8). */
export const buildCostBps = (s: RegionState) => Math.round(6_000 + (s.economy.steelIndexBps * 4_000) / 10_000);

export function avg(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
export function avgSpot(s: RegionState, n: number): number {
  const h = s.history.slice(-n);
  return h.length ? h.reduce((a, x) => a + x.priceCcPerMWh, 0) / h.length : 8_000;
}

export { marginalCost, OWNERS };
