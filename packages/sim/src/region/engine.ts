/**
 * The regional power-system engine. Pure and deterministic: (seed, world inputs, actions) → identical state.
 *
 * One interval:
 *   clock + weather → plants (construction, start-up, trips) → suppliers → NPC commitment → fuel buying
 *   → offers and bids → market clearing (market.ts) → settlement (energy, fuel, carbon, O&M, congestion rent)
 *   → businesses and households → finance → VoltLine, regulator, tenders, asset sales → events → history.
 */
import type { AnyRegionAction, FuelId, GenerationOffer, LoadBid, NodeId, TechId } from "@blackout/shared";
import { NODE_IDS } from "@blackout/shared";
import { rngInt, seedRng } from "../prng.ts";
import { SimError } from "../state.ts";
import {
  ACTORS, BANKS, BATTERY_EFF_BPS, BATTERY_WEAR_BPS_PER_CYCLE, CHALLENGE_DAYS, CHALLENGE_SNAPSHOT, CORRIDORS, DEFAULT_SNAPSHOT, FIXED_OM_CC_PER_KW_DAY,
  FLEET, GENESIS_TREASURY_CC, HISTORY_LEN, INTERVALS_PER_DAY, LICENCES, MITIGATION_FLOOR_CC, NODES, OWNERS, PRICE_CAP_CC, REFERENCE_NODE, STARTER_GRANT_CC,
  SUPPLIERS, TECHS, VOLTLINE_DEBT_CC, VOLTLINE_RATE_BPS, WITHHOLDING_CC_PER_MW_INTERVAL, intervalCc, intervalKwh,
  creditsForCc, steelForCc, PARTS_FOR_REPAIR, NO_PERMIT_PENALTY_BPS, TOWN_UNITS,
} from "./config.ts";
import type { ItemId } from "@blackout/shared";
import { R_ASSETS } from "./state.ts";
import { actorsStep, buyFuel, disruptSupplier, financeStep, fuelMarketCc, listingsStep, regulatorStep, suppliersStep, tendersStep, voltlineStep, steelStep, autoFuelStep, buildCostBps, playerBookValue, actorBids } from "./economy.ts";
import { close, cooled, cr, emit, mw, open, openKeys } from "./events.ts";
import { clearMarket, type ClearingResult } from "./market.ts";
import { burnPerKwInterval, clockOf, co2KgPerMWh, isNewDay, marginalCost, solarFactorBps, stepWeather } from "./physics.ts";
import { maybeCloseEpoch } from "./settlement.ts";
import { RACC, fuelAsset, rbal, rtransfer, rtransferUpTo, type RCtx, type RPlant, type RegionState } from "./state.ts";

export function createRegion(opts: { regionId: string; seed: number; mode?: "live" | "challenge"; snapshot?: import("@blackout/shared").WorldSnapshot }): RegionState {
  const mode = opts.mode ?? "live";
  const input = opts.snapshot ?? (mode === "challenge" ? CHALLENGE_SNAPSHOT : DEFAULT_SNAPSHOT);
  const s: RegionState = {
    version: 1,
    regionId: opts.regionId,
    seed: opts.seed,
    rng: seedRng(opts.seed),
    mode,
    interval: 0,
    stateVersion: 0,
    input,
    weather: { tempC: input.tempC, cloudPct: input.cloudPct, windKph: input.windKph, condition: "clear", heatUntil: 0, stormUntil: 0 },
    nodes: {},
    corridors: CORRIDORS.map((c) => ({ corridorId: c.corridorId, baseLimitKw: c.limitKw, upgrades: [], building: null, flowKw: 0, congested: false, rentCcToday: 0, playerRentCcToday: 0 })),
    plants: [],
    nextAssetNo: 1,
    actors: {},
    suppliers: {},
    loans: [],
    nextLoanNo: 1,
    listings: [],
    nextBidNo: 1,
    tenders: [],
    nextTenderNo: 1,
    voltline: { marginBps: 1_500, state: "healthy", investCooldown: INTERVALS_PER_DAY, distressSince: -1 },
    regulator: { carbonCcPerT: Math.round(input.carbonUsdPerT * 100), warnings: 0, lastNote: "Watching for withheld capacity and price gouging during shortages." },
    player: { autoFuel: { gas: true, diesel: true }, licence: 1, deliveredKwh: 0, emissionsKg: 0, servedShareWindow: [], profitCcToday: 0, revenueCcToday: 0, profitCcTotal: 0, starterGrantCc: STARTER_GRANT_CC },
    economy: { steelIndexBps: 10_000, steelWindow: [] },
    balances: { cc: {}, gas: {}, diesel: {}, permit: {}, cert: {}, steel: {}, parts: {} },
    ledgerSeq: 0,
    events: [],
    eventSeq: 0,
    causes: {},
    cooldowns: {},
    history: [],
    pulse: { demandKw: 0, availableKw: 0, shedKw: 0, curtailedKw: 0, spotCc: 0 },
    onboarding: { step: 0, done: false },
    stats: { unservedKwh: 0, regionOutputBpsSum: 0, intervalsCounted: 0 },
    epochs: [],
    epochStart: { interval: 0, balances: {} },
    scripted: { firstTripDone: false },
    ended: false,
  };
  s.weather.condition = input.tempC >= 34 ? "heatwave" : input.cloudPct >= 80 ? "rain" : input.cloudPct >= 45 ? "cloudy" : "clear";
  const ctx: RCtx = { journal: [], events: [], journalCap: 50 };
  for (const n of NODES) s.nodes[n.nodeId] = { nodeId: n.nodeId, demandKw: 0, servedKw: 0, curtailedKw: 0, shedKw: 0, generationKw: 0, priceCc: 0, marginal: { kind: "none", id: null }, shedWindow: [], priceWindow: [], cumulativeShedKwh: 0 };
  // the genesis treasury, then everyone's opening balances (§13)
  rtransfer(s, ctx, "cc", RACC.extGenesis, RACC.treasury, GENESIS_TREASURY_CC, "genesis treasury");
  for (const o of OWNERS) rtransfer(s, ctx, "cc", RACC.extGenesis, RACC.owner(o.ownerId), o.cashCc, "opening balance");
  for (const a of ACTORS) {
    // businesses open with about a day and a half of costs in the bank; households with their savings
    rtransfer(s, ctx, "cc", RACC.extGenesis, RACC.actor(a.actorId), a.fixedCcPerInterval > 0 ? Math.max(a.cashCc, Math.round(a.fixedCcPerInterval * INTERVALS_PER_DAY * 1.6)) : a.cashCc, "opening balance");
    s.actors[a.actorId] = { actorId: a.actorId, demandKw: 0, servedKw: 0, flexKw: 0, essentialKw: 0, productionBps: 10_000, healthBps: 8_000, state: "operating", employees: a.employees, inventoryDays: 6, closedSince: -1, energyCostCcToday: 0, profitCcToday: 0, incomeIndexBps: 10_000, lastQuote: "", shedStreak: 0 };
    if (a.debtCc > 0) s.loans.push({ loanId: `L${s.nextLoanNo++}`, bankId: a.kind === "industry" ? "meridian" : "vesper_savings", borrower: RACC.actor(a.actorId), principalCc: a.debtCc, rateBps: 30 });
  }
  for (const sp of SUPPLIERS) {
    rtransfer(s, ctx, "cc", RACC.extGenesis, RACC.supplier(sp.supplierId), sp.cashCc, "opening balance");
    const stock = Math.round((sp.capacity * sp.stockBps) / 10_000);
    rtransfer(s, ctx, fuelAsset(sp.fuel), RACC.extImports, RACC.supplier(sp.supplierId), stock, "opening stock");
    s.suppliers[sp.supplierId] = { supplierId: sp.supplierId, stock, priceCc: 0, rationing: false, importPerInterval: sp.importPerInterval, soldThisInterval: {}, disruptionUntil: 0 };
  }
  for (const b of BANKS) rtransfer(s, ctx, "cc", RACC.extGenesis, RACC.bank(b.bankId), b.cashCc, "opening balance");
  s.loans.push({ loanId: `L${s.nextLoanNo++}`, bankId: "meridian", borrower: RACC.owner("voltline"), principalCc: VOLTLINE_DEBT_CC, rateBps: VOLTLINE_RATE_BPS });
  // the one-time starter grant comes out of the treasury, not from nowhere (§14)
  rtransfer(s, ctx, "cc", RACC.treasury, RACC.player, STARTER_GRANT_CC, "starter grant");
  for (const p of FLEET) addPlant(s, { ...p, built: true });
  // opening fuel: about four hours at full output for every thermal owner
  const need: Record<string, { gas: number; diesel: number }> = {};
  for (const p of s.plants) {
    const fuel = TECHS[p.tech].fuel;
    if (!fuel) continue;
    const acct = RACC.owner(p.ownerId);
    need[acct] ??= { gas: 0, diesel: 0 };
    need[acct][fuel] += Math.round(p.capacityKw * burnPerKwInterval(p) * 48);
  }
  for (const [acct, q] of Object.entries(need)) {
    rtransfer(s, ctx, "gas", RACC.extImports, acct, q.gas, "opening fuel");
    rtransfer(s, ctx, "diesel", RACC.extImports, acct, q.diesel, "opening fuel");
  }
  suppliersStep(s, ctx, true);
  // the first settlement epoch carries the genesis distribution (treasury → everyone, starter grant included),
  // so on-chain balances start from the treasury's minted supply and never from nothing
  s.epochStart = { interval: 0, balances: {} };
  // clear one interval so a brand-new region opens on a real market, never on zeros
  regionTick(s, ctx);
  return s;
}

export function addPlant(s: RegionState, p: { plantId: string; name: string; tech: TechId; nodeId: NodeId; ownerId: string; capacityKw: number; energyKwh?: number; online: boolean; socBps?: number; forcedPpm?: number; healthBps?: number; built: boolean; buildIntervals?: number; capexCc?: number }): RPlant {
  const t = TECHS[p.tech];
  const energy = p.energyKwh ?? 0;
  const sizeCost = t.sizes.find((z) => z.capacityKw === p.capacityKw)?.costCc ?? Math.round((t.sizes[0].costCc / t.sizes[0].capacityKw) * p.capacityKw);
  const plant: RPlant = {
    plantId: p.plantId,
    assetNo: s.nextAssetNo++,
    name: p.name,
    tech: p.tech,
    nodeId: p.nodeId,
    ownerId: p.ownerId,
    capacityKw: p.capacityKw,
    energyKwh: energy,
    status: p.built ? (p.online ? "online" : "offline") : "building",
    buildRemaining: p.built ? 0 : (p.buildIntervals ?? 0),
    buildTotal: p.built ? 0 : (p.buildIntervals ?? 0),
    startRemaining: 0,
    online: p.online,
    strategy: "cost",
    markupPct: 20,
    batteryMode: p.tech === "battery" && p.ownerId === "player" ? "hold" : "auto",
    socKwh: Math.round((energy * (p.socBps ?? 5_000)) / 10_000),
    healthBps: p.healthBps ?? 10_000,
    cycles: 0,
    outputKw: p.built && p.online && t.fuel ? Math.round(p.capacityKw * 0.8) : 0,
    prevOutputKw: 0,
    chargeKw: 0,
    lastAvailKw: p.online ? p.capacityKw : 0,
    tripUntil: 0,
    tripReason: null,
    forcedPpm: p.forcedPpm ?? t.forcedPpm,
    capexCc: p.capexCc ?? sizeCost,
    lifetimeKwh: 0,
    lifetimeRevenueCc: 0,
    revenueCcToday: 0,
    costCcToday: 0,
    fuelLimited: false,
    offerCc: 0,
    mitigated: false,
  };
  s.plants.push(plant);
  return plant;
}

/** Older saves predate market items: give them the new (empty) accounts. */
export function ensureRegion(s: RegionState): RegionState {
  for (const a of R_ASSETS) s.balances[a] ??= {};
  return s;
}

export const assetIdOf = (n: number) => `p${String(n).padStart(5, "0")}`;
export const corridorLimitKw = (s: RegionState, cid: string) => {
  const c = s.corridors.find((x) => x.corridorId === cid)!;
  return c.baseLimitKw + c.upgrades.reduce((a, u) => a + u.kw, 0);
};

function plantOf(s: RegionState, plantId: string): RPlant {
  const p = s.plants.find((x) => x.plantId === plantId);
  if (!p) throw new SimError("NOT_FOUND", "No such plant.");
  return p;
}
function myPlant(s: RegionState, plantId: string): RPlant {
  const p = plantOf(s, plantId);
  if (p.ownerId !== "player") throw new SimError("FORBIDDEN", `${p.name} isn't yours.`);
  return p;
}

/* ------------------------------------------------------------------------------------------------- actions */

export function regionAct(s: RegionState, ctx: RCtx, action: AnyRegionAction): { message: string } {
  if (s.ended && action.type !== "WORLD_INPUT") throw new SimError("RUN_FINISHED", "This challenge has finished.");
  s.stateVersion += 1;
  switch (action.type) {
    case "WORLD_INPUT": {
      if (s.mode === "challenge") return { message: "Challenge worlds keep their fixed inputs." };
      s.input = action.snapshot;
      s.regulator.carbonCcPerT = Math.round(action.snapshot.carbonUsdPerT * 100);
      return { message: "World inputs updated." };
    }
    case "TOWN_SETTLE": {
      // apply debits first so a short balance changes nothing
      const legs: { asset: import("./state.ts").RAsset; amount: number }[] = [];
      if (action.cc) legs.push({ asset: "cc", amount: action.cc });
      for (const [item, q] of Object.entries(action.items ?? {})) {
        const u = TOWN_UNITS[item as ItemId];
        if (u && q) legs.push({ asset: u.asset, amount: q * u.per });
      }
      for (const l of legs.filter((x) => x.amount < 0)) if (rbal(s, l.asset, RACC.player) < -l.amount) throw new SimError(l.asset === "cc" ? "INSUFFICIENT_CREDITS" : "REQUIREMENT_NOT_MET", "Not enough to settle that trade.");
      for (const l of legs) {
        if (l.amount < 0) rtransfer(s, ctx, l.asset, RACC.player, "ext:town", -l.amount, action.reason);
        else rtransfer(s, ctx, l.asset, "ext:town", RACC.player, l.amount, action.reason);
      }
      if (action.income && action.cc && action.cc > 0) {
        s.player.profitCcToday += action.cc;
        s.player.profitCcTotal += action.cc;
        s.player.revenueCcToday += action.cc;
      }
      return { message: action.reason };
    }
    case "POWER_EXPORT": {
      if (action.kw <= 0 || action.intervals <= 0) throw new SimError("VALIDATION_FAILED", "Nothing to deliver.");
      s.exports ??= [];
      if (s.exports.some((x) => x.orderId === action.orderId)) return { message: "Already delivering." };
      // the contract is served from the node of the player's biggest working plant
      const mine = s.plants.filter((p) => p.ownerId === "player" && p.status !== "building" && p.status !== "mothballed").sort((a, b) => b.capacityKw - a.capacityKw)[0];
      if (!mine) throw new SimError("REQUIREMENT_NOT_MET", "No plant to deliver from.");
      s.exports.push({ orderId: action.orderId, buyerName: action.buyerName, kw: action.kw, nodeId: mine.nodeId, untilInterval: s.interval + action.intervals, deliveredKwh: 0, priceCcPerMWh: action.priceCcPerMWh });
      return { message: `${action.buyerName} bought ${Math.round(action.kw / 1000)} MW from you.` };
    }
    case "POWER_PAID": {
      if (action.cc > 0) {
        rtransfer(s, ctx, "cc", "ext:contracts", RACC.player, action.cc, `power sold to ${action.buyerName}`);
        s.player.profitCcToday += action.cc;
        s.player.profitCcTotal += action.cc;
        s.player.revenueCcToday += action.cc;
      }
      return { message: `${action.buyerName} paid you.` };
    }
    case "PLANT_PAYMENT": {
      // the price moves through `ext:contracts`, which region epochs leave out: on NEAR it moves in the sale itself
      if (action.hold) {
        if (rbal(s, "cc", RACC.player) < action.cc) throw new SimError("INSUFFICIENT_CREDITS", "Not enough cash for that plant.");
        rtransfer(s, ctx, "cc", RACC.player, "ext:contracts", action.cc, `buying a plant from ${action.sellerName}`);
      } else rtransfer(s, ctx, "cc", "ext:contracts", RACC.player, action.cc, `purchase from ${action.sellerName} cancelled`);
      return { message: action.hold ? "Payment held." : "Payment returned." };
    }
    case "CASH_OUT": {
      // through `ext:contracts`, which region epochs leave out: on NEAR the money is already the player's
      if (action.out) {
        if (rbal(s, "cc", RACC.player) < action.cc) throw new SimError("INSUFFICIENT_CREDITS", "Not that much cash.");
        rtransfer(s, ctx, "cc", RACC.player, "ext:contracts", action.cc, "withdrawn to your own wallet");
      } else rtransfer(s, ctx, "cc", "ext:contracts", RACC.player, action.cc, "withdrawal cancelled");
      return { message: action.out ? "Withdrawn to your wallet." : "Withdrawal returned." };
    }
    case "PLANT_LOCK": {
      const p = s.plants.find((x) => x.plantId === action.plantId && x.ownerId === "player");
      if (!p) throw new SimError("NOT_FOUND", "That plant isn't yours.");
      if (action.locked && s.listings.some((l) => l.plantId === p.plantId)) throw new SimError("INVALID_STATE", "It's already listed for VoltLine's bids; withdraw that first.");
      p.saleLocked = action.locked || undefined;
      return { message: action.locked ? "Listed for other companies." : "Listing withdrawn." };
    }
    case "PLANT_OUT": {
      const p = s.plants.find((x) => x.plantId === action.plantId && x.ownerId === "player");
      if (!p) throw new SimError("NOT_FOUND", "That plant isn't yours any more.");
      s.plants = s.plants.filter((x) => x !== p);
      s.listings = s.listings.filter((l) => l.plantId !== p.plantId);
      rtransfer(s, ctx, "cc", "ext:contracts", RACC.player, action.priceCc, `sold ${p.name} to ${action.buyerName}`);
      s.player.profitCcToday += action.priceCc;
      s.player.profitCcTotal += action.priceCc;
      emit(s, ctx, { type: "PLANT_SOLD", severity: "good", title: `You sold ${p.name} to ${action.buyerName} for ${cr(action.priceCc)}`, detail: "It has left your grid and runs on theirs now.", nodeId: p.nodeId });
      return { message: `Sold ${p.name}.` };
    }
    case "PLANT_IN": {
      const q = action.plant;
      const p = addPlant(s, { plantId: `bought-${action.saleId}`.slice(0, 40), name: q.name, tech: q.tech, nodeId: q.nodeId, ownerId: "player", capacityKw: q.capacityKw, energyKwh: q.energyKwh, online: false, healthBps: q.healthBps, built: true });
      p.socKwh = Math.min(q.socKwh, p.energyKwh);
      p.cycles = q.cycles;
      if (q.chainTokenId) p.chainTokenId = q.chainTokenId;
      emit(s, ctx, { type: "PLANT_BOUGHT", severity: "good", title: `${q.name} is yours: bought from ${action.sellerName} for ${cr(action.priceCc)}`, detail: "It stands where it stood; start it from DISPATCH.", nodeId: q.nodeId });
      return { message: `Bought ${q.name}.` };
    }
    case "TOWN_PRICES": {
      s.townPrices = { gas: action.gas, diesel: action.diesel };
      return { message: "Market prices updated." };
    }
    case "REPAIR_PLANT": {
      const p = myPlant(s, action.plantId);
      if (p.status !== "tripped") throw new SimError("INVALID_STATE", `${p.name} isn't broken.`);
      const need = PARTS_FOR_REPAIR[p.tech];
      if (rbal(s, "parts", RACC.player) < need) throw new SimError("REQUIREMENT_NOT_MET", `Repairing ${p.name} takes ${need} turbine kit${need > 1 ? "s" : ""}; you have ${rbal(s, "parts", RACC.player)}.`);
      rtransfer(s, ctx, "parts", RACC.player, RACC.extOm, need, `repair ${p.name}`);
      p.tripUntil = s.interval;
      p.status = p.online && TECHS[p.tech].fuel ? "starting" : p.tech === "solar" || p.tech === "battery" ? "online" : "offline";
      p.startRemaining = TECHS[p.tech].startIntervals;
      p.tripReason = null;
      close(s, `trip:${p.plantId}`);
      emit(s, ctx, { type: "PLANT_REPAIRED", severity: "good", title: `${p.name} repaired with ${need} turbine kit${need > 1 ? "s" : ""}`, detail: "Back in service without waiting for the crews.", nodeId: p.nodeId });
      return { message: `${p.name} is repaired.` };
    }
    case "SET_PLANT_ONLINE": {
      const p = myPlant(s, action.plantId);
      if (p.tech === "solar" || p.tech === "battery") throw new SimError("INVALID_STATE", `${TECHS[p.tech].name}s don't need starting: they follow the sun or their battery mode.`);
      if (p.status === "building") throw new SimError("INVALID_STATE", `${p.name} is still under construction.`);
      if (p.status === "tripped") throw new SimError("GENERATOR_OFFLINE", `${p.name} tripped and is being repaired.`);
      p.online = action.online;
      if (action.online && p.status === "offline") {
        p.status = "starting";
        p.startRemaining = TECHS[p.tech].startIntervals;
        if (p.startRemaining === 0) p.status = "online";
        return { message: `${p.name} is starting: online in ${p.startRemaining * 5} minutes.` };
      }
      if (!action.online && (p.status === "online" || p.status === "starting")) {
        p.status = "offline";
        p.outputKw = 0;
        p.lastAvailKw = 0;
        return { message: `${p.name} is shutting down.` };
      }
      return { message: "No change." };
    }
    case "SET_OFFER": {
      const p = myPlant(s, action.plantId);
      p.strategy = action.strategy;
      if (action.markupPct !== undefined) p.markupPct = action.markupPct;
      return { message: `${p.name} now offers ${action.strategy === "cost" ? "at marginal cost" : action.strategy === "markup" ? `at cost + ${p.markupPct}%` : "only into scarcity (₡600+)"}.` };
    }
    case "SET_BATTERY_MODE": {
      const p = myPlant(s, action.plantId);
      if (p.tech !== "battery") throw new SimError("INVALID_STATE", "Only batteries have a mode.");
      p.batteryMode = action.mode;
      return { message: `${p.name}: ${action.mode === "auto" ? "trading on price (charge cheap, sell dear)" : action.mode}.` };
    }
    case "BUILD_PLANT": {
      const t = TECHS[action.tech];
      const size = t.sizes[action.size];
      if (!size) throw new SimError("VALIDATION_FAILED", "No such size.");
      if (size.licence > s.player.licence) throw new SimError("REQUIREMENT_NOT_MET", `Needs the ${LICENCES[size.licence - 1].name} licence.`);
      const cost = creditsForCc(size.costCc);
      const steel = steelForCc(size.costCc);
      if (rbal(s, "cc", RACC.player) < cost) throw new SimError("INSUFFICIENT_CREDITS", `Costs ${cr(cost)}; you have ${cr(rbal(s, "cc", RACC.player))}. Borrow from a bank in PORTFOLIO.`);
      if (rbal(s, "steel", RACC.player) < steel) throw new SimError("REQUIREMENT_NOT_MET", `Needs ${steel} t of steel; you have ${rbal(s, "steel", RACC.player)} t. Buy it at Ivanov Steel Yard.`);
      rtransfer(s, ctx, "cc", RACC.player, RACC.extConstruction, cost, `build ${t.name}`);
      rtransfer(s, ctx, "steel", RACC.player, RACC.extConstruction, steel, `steel for ${t.name}`);
      const node = NODES.find((n) => n.nodeId === action.nodeId)!;
      const count = s.plants.filter((p) => p.ownerId === "player").length + 1;
      const p = addPlant(s, {
        plantId: `b${s.nextAssetNo}`,
        name: `${node.name.split(" ")[0]} ${t.tech === "battery" ? "Battery" : t.tech === "solar" ? "Solar" : t.tech === "diesel" ? "Diesel" : t.tech.toUpperCase()} ${count}`,
        tech: action.tech,
        nodeId: action.nodeId,
        ownerId: "player",
        capacityKw: size.capacityKw,
        energyKwh: size.energyKwh,
        online: t.fuel !== null,
        socBps: 2_000,
        built: false,
        buildIntervals: size.intervals,
        capexCc: cost,
      });
      p.batteryMode = "auto";
      emit(s, ctx, { type: "BUILD_STARTED", severity: "good", title: `You broke ground on ${p.name}`, detail: `${mw(size.capacityKw)} ${t.name} in ${node.name}: ${cr(cost)} and ${steel} t of steel. Online in ${Math.round((size.intervals * 5) / 60 * 10) / 10} game hours.`, nodeId: action.nodeId });
      return { message: `${p.name} is under construction.` };
    }
    case "UPGRADE_CORRIDOR": {
      const cfg = CORRIDORS.find((c) => c.corridorId === action.corridorId);
      if (!cfg) throw new SimError("NOT_FOUND", "No such line.");
      const c = s.corridors.find((x) => x.corridorId === action.corridorId)!;
      if (c.building) throw new SimError("INVALID_STATE", `${cfg.name} is already being upgraded.`);
      const cost = creditsForCc(cfg.upgradeCc);
      const steel = steelForCc(cfg.upgradeCc);
      if (rbal(s, "cc", RACC.player) < cost) throw new SimError("INSUFFICIENT_CREDITS", `The upgrade costs ${cr(cost)}; you have ${cr(rbal(s, "cc", RACC.player))}.`);
      if (rbal(s, "steel", RACC.player) < steel) throw new SimError("REQUIREMENT_NOT_MET", `Needs ${steel} t of steel; you have ${rbal(s, "steel", RACC.player)} t.`);
      rtransfer(s, ctx, "cc", RACC.player, RACC.extConstruction, cost, `upgrade ${cfg.name}`);
      rtransfer(s, ctx, "steel", RACC.player, RACC.extConstruction, steel, `steel for ${cfg.name}`);
      c.building = { ownerId: "player", kw: cfg.upgradeKw, remaining: cfg.upgradeIntervals };
      emit(s, ctx, { type: "LINE_UPGRADE_STARTED", severity: "good", title: `Crews are restringing ${cfg.name}`, detail: `+${mw(cfg.upgradeKw)} for ${cr(cost)}. You'll earn the congestion rent on the new capacity.`, nodeId: cfg.from });
      return { message: `${cfg.name} upgrade started.` };
    }
    case "BUY_FUEL": {
      const got = buyFuel(s, ctx, RACC.player, action.supplierId, action.quantity, true);
      const sp = SUPPLIERS.find((x) => x.supplierId === action.supplierId)!;
      return { message: `Bought ${sp.fuel === "gas" ? `${Math.round(got / 1000).toLocaleString("en-US")} MMBtu of gas` : `${Math.round(got / 1000).toLocaleString("en-US")} L of diesel`} from ${sp.person}.` };
    }
    case "SET_AUTO_FUEL": {
      s.player.autoFuel[action.fuel] = action.enabled;
      return { message: `Automatic ${action.fuel} buying ${action.enabled ? "on" : "off"}.` };
    }
    case "TAKE_LOAN": {
      const bank = BANKS.find((b) => b.bankId === action.bankId);
      if (!bank) throw new SimError("NOT_FOUND", "No such bank.");
      const offer = loanOffer(s, bank.bankId);
      if (action.amountCc > offer.maxCc) throw new SimError("REQUIREMENT_NOT_MET", offer.maxCc > 0 ? `${bank.name} will lend at most ${cr(offer.maxCc)} right now.` : `${bank.name} won't lend more: your debt is already ${Math.round(offer.leverageBps / 100)}% of your assets.`);
      rtransfer(s, ctx, "cc", RACC.bank(bank.bankId), RACC.player, action.amountCc, "loan");
      const existing = s.loans.find((l) => l.borrower === RACC.player && l.bankId === bank.bankId);
      if (existing) {
        existing.rateBps = Math.round((existing.rateBps * existing.principalCc + offer.rateBps * action.amountCc) / (existing.principalCc + action.amountCc));
        existing.principalCc += action.amountCc;
      } else s.loans.push({ loanId: `L${s.nextLoanNo++}`, bankId: bank.bankId, borrower: RACC.player, principalCc: action.amountCc, rateBps: offer.rateBps });
      return { message: `${bank.name} lent you ${cr(action.amountCc)} at ${(offer.rateBps / 100).toFixed(2)}% a day.` };
    }
    case "REPAY_LOAN": {
      const loan = s.loans.find((l) => l.loanId === action.loanId && l.borrower === RACC.player);
      if (!loan) throw new SimError("NOT_FOUND", "No such loan.");
      const amt = Math.min(action.amountCc, loan.principalCc);
      rtransfer(s, ctx, "cc", RACC.player, RACC.bank(loan.bankId), amt, "loan repayment");
      loan.principalCc -= amt;
      if (loan.principalCc <= 0) s.loans = s.loans.filter((l) => l !== loan);
      return { message: `Repaid ${cr(amt)}.` };
    }
    case "LIST_PLANT": {
      const p = myPlant(s, action.plantId);
      if (p.status === "building") throw new SimError("INVALID_STATE", "Finish building it first.");
      if (s.listings.some((l) => l.plantId === p.plantId)) throw new SimError("INVALID_STATE", "Already listed.");
      if (p.saleLocked) throw new SimError("INVALID_STATE", "It's listed for other companies; withdraw that listing first.");
      s.listings.push({ plantId: p.plantId, seller: "player", askCc: action.askCc, bids: [], listedAt: s.interval });
      listingsStep(s, ctx, true);
      return { message: `${p.name} (${assetIdOf(p.assetNo)}) is listed for ${cr(action.askCc)}.` };
    }
    case "CANCEL_LISTING": {
      const l = s.listings.find((x) => x.plantId === action.plantId && x.seller === "player");
      if (!l) throw new SimError("NOT_FOUND", "Not listed.");
      s.listings = s.listings.filter((x) => x !== l);
      return { message: "Listing withdrawn." };
    }
    case "ACCEPT_BID": {
      const l = s.listings.find((x) => x.plantId === action.plantId && x.seller === "player");
      if (!l) throw new SimError("NOT_FOUND", "Not listed.");
      const b = l.bids.find((x) => x.bidId === action.bidId);
      if (!b) throw new SimError("NOT_FOUND", "That bid has expired.");
      const p = plantOf(s, l.plantId);
      rtransfer(s, ctx, "cc", RACC.owner(b.bidder), RACC.player, b.amountCc, `bought ${assetIdOf(p.assetNo)}`);
      transferPlant(s, ctx, p, b.bidder, b.amountCc);
      return { message: `Sold ${p.name} for ${cr(b.amountCc)}.` };
    }
    case "BUY_LISTED_PLANT": {
      const l = s.listings.find((x) => x.plantId === action.plantId && x.seller !== "player");
      if (!l) throw new SimError("NOT_FOUND", "That plant isn't for sale any more.");
      const p = plantOf(s, l.plantId);
      rtransfer(s, ctx, "cc", RACC.player, RACC.owner(l.seller), l.askCc, `bought ${assetIdOf(p.assetNo)}`);
      transferPlant(s, ctx, p, "player", l.askCc);
      return { message: `${p.name} is yours.` };
    }
    case "PAUSE":
    case "RESUME":
      return { message: "ok" };
  }
}

export function transferPlant(s: RegionState, ctx: RCtx, p: RPlant, to: string, priceCc: number): void {
  const from = p.ownerId;
  p.ownerId = to;
  p.strategy = "cost";
  if (p.status === "mothballed") {
    p.status = "offline";
    p.online = false;
  }
  if (to !== "player" && TECHS[p.tech].fuel) p.online = true;
  if (p.tech === "battery") p.batteryMode = "auto";
  s.listings = s.listings.filter((l) => l.plantId !== p.plantId);
  const name = (id: string) => (id === "player" ? "you" : (OWNERS.find((o) => o.ownerId === id)?.name ?? id));
  emit(s, ctx, { type: "PLANT_SOLD", severity: to === "player" ? "good" : "info", title: `${p.name} (${assetIdOf(p.assetNo)}) changed hands`, detail: `${name(from)} → ${name(to)} for ${cr(priceCc)}. Control of the plant, its account and its history moved with it.`, nodeId: p.nodeId, causeKeys: ["voltline_distress"] });
}

export function loanOffer(s: RegionState, bankId: string): { maxCc: number; rateBps: number; leverageBps: number } {
  const bank = BANKS.find((b) => b.bankId === bankId)!;
  const assets = playerBookValue(s) + rbal(s, "cc", RACC.player);
  const debt = s.loans.filter((l) => l.borrower === RACC.player).reduce((a, l) => a + l.principalCc, 0);
  const leverageBps = assets > 0 ? Math.round((debt * 10_000) / assets) : 10_000;
  const room = Math.max(0, Math.round((assets * bank.maxLeverageBps) / 10_000) - debt);
  const maxCc = Math.max(0, Math.min(room, rbal(s, "cc", RACC.bank(bankId))));
  const rateBps = bank.baseRateBps + Math.round(leverageBps / 400);
  return { maxCc: Math.floor(maxCc / 100_000) * 100_000, rateBps, leverageBps };
}

/* -------------------------------------------------------------------------------------------------- incidents */

const INCIDENTS = new Set(["HEATWAVE", "STORM", "PLANT_TRIPPED", "SUPPLY_DISRUPTION"]);
/** Intervals (≈ real seconds) the region may go without an incident once the first minute is over. */
export const INCIDENT_GAP = 150;

/**
 * Something happens at least every INCIDENT_GAP intervals once you're playing, so a session never goes quiet: a storm
 * front, a heatwave, a breakdown at a rival's plant, or a cut to a fuel supplier's imports. Each one moves the
 * market through the same physics as a random one (less solar, more demand, less supply, dearer fuel). Seeded, so
 * every player of the weekly challenge lives through the same story.
 */
function incidentDesk(s: RegionState, ctx: RCtx): void {
  if (!s.onboarding.done || s.interval % 6 !== 0) return;
  if (s.cooldowns.incident === undefined) {
    // the first one comes about a minute and a half after the first minute
    s.cooldowns.incident = s.interval - (INCIDENT_GAP - 90);
    return;
  }
  let last = s.cooldowns.incident;
  for (const e of s.events) if (INCIDENTS.has(e.type) && e.interval > 1) last = Math.max(last, e.interval);
  if (s.interval - last < INCIDENT_GAP) return;
  s.cooldowns.incident = s.interval;
  const w = s.weather;
  const calmSky = s.interval >= w.heatUntil && s.interval >= w.stormUntil;
  const rivals = s.plants.filter((p) => p.ownerId !== "player" && p.status === "online" && TECHS[p.tech].fuel);
  const options: ("storm" | "heatwave" | "trip" | "supply")[] = [...(calmSky ? (["storm", "heatwave"] as const) : []), ...(rivals.length ? (["trip", "trip"] as const) : []), "supply"];
  const pick = options[rngInt(s.rng, options.length)];
  if (pick === "storm") {
    w.stormUntil = s.interval + 30 + rngInt(s.rng, 30);
    emit(s, ctx, { type: "STORM", severity: "warn", title: "Storm front over the region", detail: "Cloud kills solar output for a few game hours and wind strains the lines. Fuelled plants earn more while it lasts.", causeKeys: [] }, "storm");
  } else if (pick === "heatwave") {
    w.heatUntil = s.interval + 96 + rngInt(s.rng, 48);
    emit(s, ctx, { type: "HEATWAVE", severity: "warn", title: "Heatwave: air-conditioners everywhere", detail: "About 6°C hotter for the next day. Homes and offices draw more, thermal plants lose output, solar panels run hot.", causeKeys: [] }, "heat");
  } else if (pick === "trip") {
    const p = rivals.sort((a, b) => b.capacityKw - a.capacityKw)[rngInt(s.rng, Math.min(3, rivals.length))];
    const dur = 40 + rngInt(s.rng, 60);
    const reasons = ["a boiler-feed pump failed", "a transformer fault", "a turbine vibration alarm", "a fuel-valve failure"];
    p.status = "tripped";
    p.tripUntil = s.interval + dur;
    p.tripReason = reasons[rngInt(s.rng, reasons.length)];
    p.outputKw = 0;
    const owner = `${OWNERS.find((o) => o.ownerId === p.ownerId)?.name ?? p.ownerId}'s`;
    emit(s, ctx, { type: "PLANT_TRIPPED", severity: "crisis", title: `${owner} ${p.name} tripped: ${mw(p.capacityKw)} lost`, detail: `Cause: ${p.tripReason}. Back in about ${Math.round((dur * 5) / 60)} game hours. Everyone still running earns the higher price.`, nodeId: p.nodeId, causeKeys: ["heat", "storm"] }, `trip:${p.plantId}`);
  } else {
    const order = SUPPLIERS.map((x) => x.supplierId);
    const start = rngInt(s.rng, order.length);
    for (let k = 0; k < order.length && !disruptSupplier(s, ctx, order[(start + k) % order.length]); k++);
  }
}

/* -------------------------------------------------------------------------------------------------- tick */

interface OfferMeta {
  plant: RPlant;
  kind: "gen" | "discharge";
}

export function regionTick(s: RegionState, ctx: RCtx): void {
  if (s.ended) return;
  ensureRegion(s);
  s.interval += 1;
  s.stateVersion += 1;
  const clk = clockOf(s.interval);
  if (isNewDay(s.interval)) newDay(s, ctx);
  const wx = stepWeather(s);
  if (wx.started === "heatwave") emit(s, ctx, { type: "HEATWAVE", severity: "warn", title: "Heatwave: air-conditioners everywhere", detail: `${Math.round(s.weather.tempC)}°C and rising. Homes and offices draw more, thermal plants lose output, solar panels run hot.`, causeKeys: [] }, "heat");
  if (wx.ended === "heatwave") close(s, "heat");
  if (wx.started === "storm") emit(s, ctx, { type: "STORM", severity: "warn", title: "Storm front over the region", detail: "Cloud kills solar output and wind threatens the lines.", causeKeys: [] }, "storm");
  if (wx.ended === "storm") close(s, "storm");
  incidentDesk(s, ctx);

  plantsStep(s, ctx);
  suppliersStep(s, ctx, false);
  npcCommitStep(s);
  autoFuelStep(s, ctx);

  const minute = clk.minuteOfDay;
  const solarBps = solarFactorBps(s, minute);
  const offers: GenerationOffer[] = [];
  const meta: OfferMeta[] = [];
  const bids: LoadBid[] = [];
  const batteryBids = new Map<string, RPlant>();
  const shortLastInterval = s.pulse.shedKw > 0;
  let availableKw = 0;
  for (const p of s.plants) {
    p.outputKw = 0;
    p.chargeKw = 0;
    p.fuelLimited = false;
    p.mitigated = false;
    const t = TECHS[p.tech];
    if (p.status !== "online") {
      p.lastAvailKw = 0;
      continue;
    }
    if (p.tech === "battery") {
      const usable = Math.round((p.energyKwh * p.healthBps) / 10_000);
      const dischargeKw = Math.min(p.capacityKw, Math.floor(((p.socKwh * BATTERY_EFF_BPS) / 10_000) * 12));
      const chargeKw = Math.min(p.capacityKw, Math.floor((((usable - p.socKwh) * 10_000) / BATTERY_EFF_BPS) * 12));
      const { lo, hi } = batteryThresholds(s, p.nodeId);
      const mode = p.ownerId === "player" ? p.batteryMode : "auto";
      if ((mode === "auto" || mode === "discharge") && dischargeKw > 0) {
        const price = mode === "discharge" ? 0 : hi;
        offers.push({ plantId: p.plantId, nodeId: p.nodeId, availableMW: dischargeKw / 1000, minimumMW: 0, offerPricePerMWh: price, marginalCostPerMWh: t.vomCcPerMWh, rampMWPerInterval: p.capacityKw / 1000 });
        meta.push({ plant: p, kind: "discharge" });
        p.offerCc = price;
        availableKw += dischargeKw;
      }
      if ((mode === "auto" || mode === "charge") && chargeKw > 0) {
        bids.push({ loadId: `bess:${p.plantId}`, nodeId: p.nodeId, requestedMW: chargeKw / 1000, willingnessToPayPerMWh: mode === "charge" ? 30_000 : lo, priorityClass: "storage" });
        batteryBids.set(`bess:${p.plantId}`, p);
      }
      p.lastAvailKw = dischargeKw;
      continue;
    }
    let avail = Math.round((p.capacityKw * p.healthBps) / 10_000);
    if (p.tech === "solar") avail = Math.round((avail * solarBps) / 10_000);
    else if (s.weather.tempC > 30) avail = Math.round(avail * (1 - (s.weather.tempC - 30) * 0.006));
    let min = Math.round((p.capacityKw * t.minBps) / 10_000);
    if (t.fuel) {
      // ramp up from where it was; committed plants can always reach their minimum
      const ramp = Math.round((p.capacityKw * t.rampBps) / 10_000);
      avail = Math.min(avail, Math.max(min, p.prevOutputKw + ramp));
      const fuelHave = rbal(s, fuelAsset(t.fuel), RACC.owner(p.ownerId));
      const fuelMaxKw = Math.floor(fuelHave / burnPerKwInterval(p));
      if (fuelMaxKw < avail) {
        avail = Math.max(0, fuelMaxKw);
        p.fuelLimited = true;
      }
      min = Math.min(min, avail);
    }
    const mc = marginalCost(s, p, t.fuel ? fuelMarketCc(s, t.fuel) : 0).totalCc;
    let price = offerPrice(s, p, mc);
    if (shortLastInterval && price > Math.max(mc * 2, MITIGATION_FLOOR_CC)) {
      price = Math.max(mc * 2, MITIGATION_FLOOR_CC);
      p.mitigated = true;
    }
    p.offerCc = price;
    p.lastAvailKw = avail;
    if (avail <= 0) continue;
    availableKw += avail;
    offers.push({ plantId: p.plantId, nodeId: p.nodeId, availableMW: avail / 1000, minimumMW: min / 1000, offerPricePerMWh: Math.min(price, PRICE_CAP_CC), marginalCostPerMWh: mc, rampMWPerInterval: (p.capacityKw * t.rampBps) / 10_000 / 1000 });
    meta.push({ plant: p, kind: "gen" });
  }
  const loadBids = actorBids(s, minute);
  bids.push(...loadBids);
  // power sold to Vesper's companies: served like a firm customer at the player's node; if the grid is short, these
  // go first (they are "flexible"), and the buyer pays only for what arrived
  for (const x of s.exports ?? []) {
    if (s.interval > x.untilInterval) continue;
    bids.push({ loadId: `export:${x.orderId}`, nodeId: x.nodeId as NodeId, requestedMW: x.kw / 1000, willingnessToPayPerMWh: Math.max(x.priceCcPerMWh * 2, 50_000), priorityClass: "flexible" });
  }
  let demandKw = 0;
  for (const b of loadBids) demandKw += Math.round(b.requestedMW * 1000);

  const r = clearMarket({
    nodes: NODE_IDS,
    corridors: s.corridors.map((c) => {
      const cfg = CORRIDORS.find((x) => x.corridorId === c.corridorId)!;
      return { corridorId: c.corridorId, from: cfg.from, to: cfg.to, limitMW: corridorLimitKw(s, c.corridorId) / 1000 };
    }),
    offers,
    bids,
    priceCapPerMWh: PRICE_CAP_CC,
    referenceNode: REFERENCE_NODE,
  });

  settle(s, ctx, r, meta, batteryBids);
  actorsStep(s, ctx, r);
  financeStep(s, ctx);
  voltlineStep(s, ctx);
  regulatorStep(s, ctx, r);
  tendersStep(s, ctx);
  listingsStep(s, ctx, false);
  steelStep(s, ctx);

  // pulse + history
  let shedKw = 0;
  let curtailedKw = 0;
  let servedKw = 0;
  for (const n of NODE_IDS) {
    shedKw += s.nodes[n].shedKw;
    curtailedKw += s.nodes[n].curtailedKw;
    servedKw += s.nodes[n].servedKw;
  }
  s.pulse = { demandKw, availableKw, shedKw, curtailedKw, spotCc: r.systemPrice };
  const playerKw = s.plants.filter((p) => p.ownerId === "player").reduce((a, p) => a + p.outputKw, 0);
  s.history.push({ interval: s.interval, demandKw, availableKw, servedKw, shedKw, priceCcPerMWh: r.systemPrice, playerKw });
  if (s.history.length > HISTORY_LEN) s.history.splice(0, s.history.length - HISTORY_LEN);
  const essential = Math.max(1, demandKw - Object.values(s.actors).reduce((a, x) => a + x.flexKw, 0));
  s.player.servedShareWindow.push(Math.round(10_000 * (1 - shedKw / essential)));
  if (s.player.servedShareWindow.length > INTERVALS_PER_DAY) s.player.servedShareWindow.shift();
  s.stats.unservedKwh += intervalKwh(shedKw);
  s.stats.regionOutputBpsSum += regionOutputBps(s);
  s.stats.intervalsCounted += 1;

  detectGridEvents(s, ctx, r);
  licenceStep(s, ctx);
  onboardingStep(s, ctx);
  maybeCloseEpoch(s);
  // keep finished power contracts long enough for the server to read what was delivered
  if (s.exports?.length) s.exports = s.exports.filter((x) => s.interval - x.untilInterval < 300);
  if (s.mode === "challenge" && clk.day > CHALLENGE_DAYS) {
    s.ended = true;
    emit(s, ctx, { type: "CHALLENGE_ENDED", severity: "good", title: "Challenge complete", detail: `Score ${regionScore(s).score.toLocaleString("en-US")}. Your result is on the weekly leaderboard.` });
  }
}

function offerPrice(s: RegionState, p: RPlant, mc: number): number {
  if (p.tech === "solar") return 0;
  if (p.ownerId === "player") {
    if (p.strategy === "markup") return Math.round(mc * (1 + p.markupPct / 100));
    if (p.strategy === "scarcity") return Math.max(Math.round(mc * 1.5), 60_000);
    return mc;
  }
  if (p.ownerId === "voltline") return Math.round((mc * (10_000 + s.voltline.marginBps)) / 10_000);
  const o = OWNERS.find((x) => x.ownerId === p.ownerId);
  return Math.round((mc * (10_000 + (o?.markupBps ?? 1_000))) / 10_000);
}

/** Battery auto-trading thresholds from the node's recent prices: buy in the cheapest quarter, sell in the dearest. */
export function batteryThresholds(s: RegionState, nodeId: string): { lo: number; hi: number } {
  const w = s.nodes[nodeId].priceWindow;
  if (w.length < 24) return { lo: 4_500, hi: 14_000 };
  const sorted = [...w].sort((a, b) => a - b);
  const lo = Math.min(sorted[Math.floor(sorted.length * 0.3)], 9_000);
  const hi = Math.max(sorted[Math.floor(sorted.length * 0.75)], Math.round((lo * 10_000 * 10_000) / (BATTERY_EFF_BPS * BATTERY_EFF_BPS)) + 2_500);
  return { lo, hi };
}

function plantsStep(s: RegionState, ctx: RCtx): void {
  for (const p of s.plants) {
    p.prevOutputKw = p.outputKw;
    if (p.status === "building") {
      p.buildRemaining -= 1;
      if (p.buildRemaining <= 0) {
        p.status = TECHS[p.tech].fuel ? (p.online ? "starting" : "offline") : "online";
        p.startRemaining = TECHS[p.tech].startIntervals;
        emit(s, ctx, { type: "PLANT_COMMISSIONED", severity: "good", title: `${p.name} is commissioned`, detail: `${mw(p.capacityKw)} of new ${TECHS[p.tech].name.toLowerCase()} in ${NODES.find((n) => n.nodeId === p.nodeId)!.name}. Plant Asset ${assetIdOf(p.assetNo)} is registered to ${p.ownerId === "player" ? "you" : p.ownerId}.`, nodeId: p.nodeId });
      }
      continue;
    }
    if (p.status === "starting") {
      p.startRemaining -= 1;
      if (p.startRemaining <= 0) p.status = "online";
      continue;
    }
    if (p.status === "tripped") {
      if (s.interval >= p.tripUntil) {
        p.status = p.online ? "starting" : "offline";
        p.startRemaining = TECHS[p.tech].startIntervals;
        p.tripReason = null;
        if (open(s, `trip:${p.plantId}`)) {
          emit(s, ctx, { type: "PLANT_RETURNED", severity: "good", title: `${p.name} is repaired`, detail: `${mw(p.capacityKw)} returning to the market.`, nodeId: p.nodeId });
          close(s, `trip:${p.plantId}`);
        }
      }
      continue;
    }
    if (p.status !== "online") continue;
    // scripted first-minute crisis (§56), then seeded forced outages
    // the opening crisis happens in the very first interval, so the player arrives to it: Eastbank's engines trip
    // and Residential East, at the end of a full line, goes dark
    const scripted = !s.scripted.firstTripDone && s.interval === 1 && p.plantId === "eastbank";
    if (scripted || (s.interval > 36 && rngInt(s.rng, 1_000_000) < p.forcedPpm)) {
      const dur = scripted ? 66 : 30 + rngInt(s.rng, 110);
      const reasons = ["a boiler-feed pump failed", "a transformer fault", "a turbine vibration alarm", "a fuel-valve failure", "a lightning strike on the switchyard"];
      p.status = "tripped";
      p.tripUntil = s.interval + dur;
      p.tripReason = scripted ? "a transformer fault" : reasons[rngInt(s.rng, reasons.length)];
      p.outputKw = 0;
      const owner = p.ownerId === "player" ? "Your" : `${OWNERS.find((o) => o.ownerId === p.ownerId)?.name ?? p.ownerId}'s`;
      emit(s, ctx, { type: "PLANT_TRIPPED", severity: "crisis", title: `${owner} ${p.name} tripped: ${mw(p.capacityKw)} lost`, detail: `Cause: ${p.tripReason}. Back in about ${Math.round((dur * 5) / 60)} game hours.`, nodeId: p.nodeId, causeKeys: ["heat", "storm"] }, `trip:${p.plantId}`);
    }
  }
  if (s.interval === 1) s.scripted.firstTripDone = true;
  for (const c of s.corridors) {
    if (!c.building) continue;
    c.building.remaining -= 1;
    if (c.building.remaining <= 0) {
      c.upgrades.push({ ownerId: c.building.ownerId, kw: c.building.kw });
      const cfg = CORRIDORS.find((x) => x.corridorId === c.corridorId)!;
      emit(s, ctx, { type: "LINE_UPGRADED", severity: "good", title: `${cfg.name} upgraded`, detail: `Now carries ${mw(corridorLimitKw(s, c.corridorId))}.`, nodeId: cfg.to });
      c.building = null;
    }
  }
}

/** NPC generators decide whether to keep their plants committed (simple, explained rules). */
function npcCommitStep(s: RegionState): void {
  const tight = s.pulse.demandKw > 0 && s.pulse.availableKw < s.pulse.demandKw * 1.08;
  for (const p of s.plants) {
    if (p.ownerId === "player" || !TECHS[p.tech].fuel) continue;
    if (p.status === "mothballed" || p.status === "tripped" || p.status === "building") continue;
    const t = TECHS[p.tech];
    let want = true;
    if (p.tech !== "ccgt") {
      const mc = marginalCost(s, p, fuelMarketCc(s, t.fuel!)).totalCc;
      const w = s.nodes[p.nodeId].priceWindow.slice(-12);
      const avg = w.length ? w.reduce((a, b) => a + b, 0) / w.length : mc;
      want = tight || avg > mc * 0.9 || s.pulse.shedKw > 0;
    }
    if (want && p.status === "offline") {
      p.online = true;
      p.status = "starting";
      p.startRemaining = t.startIntervals;
    } else if (!want && p.status === "online") {
      p.online = false;
      p.status = "offline";
    }
  }
}

function settle(s: RegionState, ctx: RCtx, r: ClearingResult, meta: OfferMeta[], batteryBids: Map<string, RPlant>): void {
  const priceAt = (n: string) => r.priceByNode[n];
  for (const n of NODE_IDS) {
    const node = s.nodes[n];
    node.priceCc = priceAt(n);
    node.marginal = r.marginalByNode[n];
    node.shedKw = Math.round(r.shedMW[n] * 1000);
    node.curtailedKw = Math.round(r.curtailedMW[n] * 1000);
    node.servedKw = 0;
    node.demandKw = 0;
    node.generationKw = 0;
    node.priceWindow.push(node.priceCc);
    if (node.priceWindow.length > INTERVALS_PER_DAY) node.priceWindow.shift();
    node.shedWindow.push(node.shedKw > 0 ? 1 : 0);
    if (node.shedWindow.length > 12) node.shedWindow.shift();
    node.cumulativeShedKwh += intervalKwh(node.shedKw);
  }
  // loads pay the market
  let collected = 0;
  for (const a of Object.values(s.actors)) {
    a.servedKw = 0;
  }
  for (const [loadId, servedMw] of Object.entries(r.servedMW)) {
    const kw = Math.round(servedMw * 1000);
    if (loadId.startsWith("bess:")) {
      const p = batteryBids.get(loadId)!;
      p.chargeKw = kw;
      const cost = intervalCc(priceAt(p.nodeId), kw);
      collected += rtransferUpTo(s, ctx, "cc", RACC.owner(p.ownerId), RACC.market, cost, "battery charging");
      p.socKwh += Math.round(((kw / 12) * BATTERY_EFF_BPS) / 10_000);
      p.costCcToday += cost;
      s.nodes[p.nodeId].servedKw += kw;
      continue;
    }
    if (loadId.startsWith("export:")) {
      // the player buys this energy from the regional market to deliver it; the buyer pays them the contract price
      const x = (s.exports ?? []).find((e) => `export:${e.orderId}` === loadId);
      if (!x) continue;
      const cost = intervalCc(priceAt(x.nodeId), kw);
      const paid = rtransferUpTo(s, ctx, "cc", RACC.player, RACC.market, cost, `power delivered to ${x.buyerName}`);
      collected += paid;
      s.player.profitCcToday -= paid;
      s.player.profitCcTotal -= paid;
      // if the player can't pay the grid for it, only what they paid for counts as delivered
      x.deliveredKwh += Math.round(intervalKwh(cost > 0 ? Math.floor((kw * paid) / cost) : kw));
      s.nodes[x.nodeId as NodeId].servedKw += kw;
      continue;
    }
    const actorId = loadId.slice(0, loadId.lastIndexOf(":"));
    const a = s.actors[actorId];
    const cfg = ACTORS.find((x) => x.actorId === actorId)!;
    a.servedKw += kw;
    s.nodes[cfg.nodeId].servedKw += kw;
    const cost = intervalCc(priceAt(cfg.nodeId), kw);
    const paid = rtransferUpTo(s, ctx, "cc", RACC.actor(actorId), RACC.market, cost, "electricity");
    collected += paid;
    a.energyCostCcToday += paid;
  }
  for (const a of ACTORS) s.nodes[a.nodeId].demandKw += s.actors[a.actorId].demandKw;
  // generators are paid; if a load defaulted, generators share the haircut pro rata
  const owed: { p: RPlant; cc: number; kw: number }[] = [];
  let owedTotal = 0;
  for (const m of meta) {
    const kw = Math.round((r.dispatchMW[m.plant.plantId] ?? 0) * 1000);
    m.plant.outputKw = kw;
    s.nodes[m.plant.nodeId].generationKw += kw;
    const cc = intervalCc(priceAt(m.plant.nodeId), kw);
    owed.push({ p: m.plant, cc, kw });
    owedTotal += cc;
  }
  const haircut = owedTotal > collected && owedTotal > 0 ? collected / owedTotal : 1;
  for (const o of owed) {
    const { p, kw } = o;
    const pay = Math.floor(o.cc * haircut);
    const acct = RACC.owner(p.ownerId);
    rtransferUpTo(s, ctx, "cc", RACC.market, acct, pay, "energy sales");
    p.revenueCcToday += pay;
    p.lifetimeRevenueCc += pay;
    p.lifetimeKwh += Math.round(intervalKwh(kw));
    const t = TECHS[p.tech];
    let cost = 0;
    if (p.tech === "battery") {
      const drawn = Math.round(((kw / 12) * 10_000) / BATTERY_EFF_BPS);
      p.socKwh = Math.max(0, p.socKwh - drawn);
      const wear = (drawn / Math.max(1, p.energyKwh)) * BATTERY_WEAR_BPS_PER_CYCLE;
      p.cycles += drawn / Math.max(1, p.energyKwh);
      p.healthBps = Math.max(6_000, Math.round((p.healthBps - wear) * 1000) / 1000);
    }
    if (t.fuel && kw > 0) {
      const burn = Math.round(kw * burnPerKwInterval(p));
      rtransferUpTo(s, ctx, fuelAsset(t.fuel), acct, RACC.extBurned, burn, `${p.name} burned fuel`);
      cost += Math.round((burn * fuelMarketCc(s, t.fuel)) / 1000);
      const co2Kg = (co2KgPerMWh(p.tech) * kw) / 12_000;
      let uncoveredKg = co2Kg;
      if (p.ownerId === "player") {
        // the player's plants surrender carbon permits first; what they don't cover the regulator charges at +25%
        const used = rtransferUpTo(s, ctx, "permit", acct, RACC.regulator, Math.round(co2Kg), "permits surrendered");
        uncoveredKg = Math.max(0, co2Kg - used);
        s.player.emissionsKg += co2Kg;
      }
      const rate = p.ownerId === "player" ? Math.round((s.regulator.carbonCcPerT * NO_PERMIT_PENALTY_BPS) / 10_000) : s.regulator.carbonCcPerT;
      const carbonCc = Math.round((uncoveredKg * rate) / 1000);
      rtransferUpTo(s, ctx, "cc", acct, RACC.regulator, carbonCc, "carbon");
      cost += carbonCc;
    }
    // the player's solar earns renewable certificates, one per MWh
    if (p.tech === "solar" && p.ownerId === "player" && kw > 0) rtransfer(s, ctx, "cert", "ext:registry", acct, Math.round(kw / 12), "renewable certificates");
    const vom = intervalCc(t.vomCcPerMWh, kw);
    rtransferUpTo(s, ctx, "cc", acct, RACC.extOm, vom, "variable O&M");
    cost += vom;
    p.costCcToday += cost;
    if (p.ownerId === "player") {
      s.player.deliveredKwh += intervalKwh(kw);
      s.player.revenueCcToday += pay;
      s.player.profitCcToday += pay - cost;
      s.player.profitCcTotal += pay - cost;
    }
  }
  // battery charging cost counts against the player's profit
  for (const p of batteryBids.values()) {
    if (p.ownerId !== "player" || p.chargeKw === 0) continue;
    const c = intervalCc(priceAt(p.nodeId), p.chargeKw);
    s.player.profitCcToday -= c;
    s.player.profitCcTotal -= c;
  }
  // congestion rent: what loads paid beyond what generators earned, owned by whoever owns line capacity
  for (const c of s.corridors) {
    const cfg = CORRIDORS.find((x) => x.corridorId === c.corridorId)!;
    const flow = Math.round((r.flowMW[c.corridorId] ?? 0) * 1000);
    c.flowKw = flow;
    c.congested = r.congested.includes(c.corridorId);
    const spread = Math.abs(priceAt(cfg.to) - priceAt(cfg.from));
    const rent = intervalCc(spread, Math.abs(flow));
    if (rent <= 0) continue;
    const limit = corridorLimitKw(s, c.corridorId);
    const playerKw = c.upgrades.filter((u) => u.ownerId === "player").reduce((a, u) => a + u.kw, 0);
    const playerShare = Math.floor((rent * playerKw) / Math.max(1, limit));
    const pPaid = rtransferUpTo(s, ctx, "cc", RACC.market, RACC.player, playerShare, `congestion rent ${cfg.name}`);
    const gPaid = rtransferUpTo(s, ctx, "cc", RACC.market, RACC.grid, rent - playerShare, `congestion rent ${cfg.name}`);
    c.rentCcToday += pPaid + gPaid;
    c.playerRentCcToday += pPaid;
    if (pPaid > 0) {
      s.player.profitCcToday += pPaid;
      s.player.profitCcTotal += pPaid;
      s.player.revenueCcToday += pPaid;
    }
  }
  // regulator: withholding during load shedding
  if (Object.values(r.shedMW).some((x) => x > 0)) {
    for (const p of s.plants) {
      if (p.status !== "offline" || !TECHS[p.tech].fuel || p.ownerId !== "player") continue;
      const have = rbal(s, fuelAsset(TECHS[p.tech].fuel!), RACC.player) > 0;
      if (!have) continue;
      if (!s.onboarding.done) continue; // the first minute teaches, it doesn't fine
      const fine = Math.round((p.capacityKw / 1000) * WITHHOLDING_CC_PER_MW_INTERVAL);
      const paid = rtransferUpTo(s, ctx, "cc", RACC.player, RACC.regulator, fine, `withholding fine ${p.name}`);
      s.player.profitCcToday -= paid;
      s.player.profitCcTotal -= paid;
      if (!open(s, `withhold:${p.plantId}`)) {
        s.regulator.warnings += 1;
        emit(s, ctx, { type: "REGULATOR_FINE", severity: "warn", title: `Regulator fines you for withholding ${p.name}`, detail: `Homes are dark while ${mw(p.capacityKw)} of your fuelled capacity sits idle: ${cr(fine)} every interval until it runs or the shortage ends.`, nodeId: p.nodeId, causeKeys: openKeys(s, "shed:") }, `withhold:${p.plantId}`);
      }
    }
  } else for (const k of openKeys(s, "withhold:")) close(s, k);
  for (const p of s.plants) if (p.mitigated && p.ownerId === "player" && !open(s, `mitigate:${p.plantId}`)) {
    s.regulator.warnings += 1;
    emit(s, ctx, { type: "REGULATOR_MITIGATION", severity: "warn", title: `Regulator caps your ${p.name} offer`, detail: `During load shedding offers above max(2× cost, ₡1,000) are cut back. Repeated gouging hurts your licence review.`, nodeId: p.nodeId }, `mitigate:${p.plantId}`);
  }
}

function newDay(s: RegionState, ctx: RCtx): void {
  for (const p of s.plants) {
    // fixed O&M, charged once a day
    if (p.status !== "building") {
      const om = Math.round(p.capacityKw * FIXED_OM_CC_PER_KW_DAY);
      const paid = rtransferUpTo(s, ctx, "cc", RACC.owner(p.ownerId), RACC.extOm, om, `${p.name} fixed O&M`);
      if (p.ownerId === "player") s.player.profitCcTotal -= paid;
    }
    p.revenueCcToday = 0;
    p.costCcToday = 0;
  }
  for (const c of s.corridors) {
    c.rentCcToday = 0;
    c.playerRentCcToday = 0;
  }
  for (const a of Object.values(s.actors)) {
    a.energyCostCcToday = 0;
    a.profitCcToday = 0;
  }
  s.player.profitCcToday = 0;
  s.player.revenueCcToday = 0;
  const { day } = clockOf(s.interval);
  emit(s, ctx, { type: "DAY_STARTED", severity: "info", title: `Day ${day} begins`, detail: `Yesterday the region left ${Math.round(s.stats.unservedKwh / 1000).toLocaleString("en-US")} MWh unserved in total.` });
}

function detectGridEvents(s: RegionState, ctx: RCtx, r: ClearingResult): void {
  const avg = s.history.length > 24 ? s.history.slice(-288).reduce((a, h) => a + h.priceCcPerMWh, 0) / Math.min(288, s.history.length) : 8_000;
  const spot = r.systemPrice;
  if (!open(s, "spike") && spot > Math.max(25_000, avg * 2.5)) {
    emit(s, ctx, { type: "PRICE_SPIKE", severity: "warn", title: `Spot price spikes to ${cr(spot)}/MWh`, detail: `${Math.round(spot / Math.max(1, avg))}× today's average. Set by ${marginalName(s, r.marginalByNode[REFERENCE_NODE])}.`, nodeId: REFERENCE_NODE, causeKeys: openKeys(s, "trip:", "heat", "storm", "ration:", "cong:", "shed:", "voltline_mothball") }, "spike");
  } else if (open(s, "spike") && spot < Math.max(15_000, avg * 1.5)) close(s, "spike");
  for (const c of s.corridors) {
    const cfg = CORRIDORS.find((x) => x.corridorId === c.corridorId)!;
    const key = `cong:${c.corridorId}`;
    const spread = Math.abs(r.priceByNode[cfg.to] - r.priceByNode[cfg.from]);
    if (c.congested && spread >= 2_000 && !open(s, key) && cooled(s, key, 72)) {
      const into = r.priceByNode[cfg.to] > r.priceByNode[cfg.from] ? cfg.to : cfg.from;
      emit(s, ctx, { type: "CONGESTION", severity: "warn", title: `${cfg.name} is full`, detail: `${mw(Math.abs(c.flowKw))} at its limit. Power costs ${cr(spread)}/MWh more in ${NODES.find((n) => n.nodeId === into)!.name}. Build there, store there, or upgrade the line.`, nodeId: into, causeKeys: openKeys(s, "trip:", "heat") }, key);
    } else if (!c.congested && open(s, key)) close(s, key);
  }
  for (const n of NODE_IDS) {
    const node = s.nodes[n];
    const key = `shed:${n}`;
    const name = NODES.find((x) => x.nodeId === n)!.name;
    if (node.shedKw > 0 && !open(s, key)) {
      const corridorKeys = s.corridors.filter((c) => { const cfg = CORRIDORS.find((x) => x.corridorId === c.corridorId)!; return cfg.from === n || cfg.to === n; }).map((c) => `cong:${c.corridorId}`);
      emit(s, ctx, { type: "BLACKOUT", severity: "crisis", title: `Rolling blackout in ${name}: ${mw(node.shedKw)} dark`, detail: `Demand there can't be met at any price. ${node.marginal.kind === "load" ? "The price is set by what customers would pay to keep the lights on." : ""}`, nodeId: n, causeKeys: [...openKeys(s, "trip:", "heat", "storm", "ration:", "voltline_mothball"), ...corridorKeys] }, key);
    } else if (node.shedKw === 0 && open(s, key)) {
      emit(s, ctx, { type: "RESTORED", severity: "good", title: `Power restored in ${name}`, detail: `${Math.round(node.cumulativeShedKwh / 1000).toLocaleString("en-US")} MWh went unserved there so far.`, nodeId: n });
      close(s, key);
    }
  }
}

function marginalName(s: RegionState, m: { kind: string; id: string | null }): string {
  if (m.kind === "plant") return s.plants.find((p) => p.plantId === m.id)?.name ?? "a generator";
  if (m.kind === "load") return `${ACTORS.find((a) => m.id?.startsWith(a.actorId))?.name ?? "a customer"} stepping back`;
  if (m.kind === "cap") return "the price cap";
  return "nothing";
}
export { marginalName };

export function regionOutputBps(s: RegionState): number {
  let base = 0;
  let now = 0;
  for (const a of ACTORS) {
    if (a.valuePerMWh === 0) continue;
    base += a.baseKw;
    now += (a.baseKw * s.actors[a.actorId].productionBps) / 10_000;
  }
  return Math.round((now * 10_000) / Math.max(1, base));
}

export function regionScore(s: RegionState) {
  const profitCc = s.player.profitCcTotal;
  const unservedMWh = Math.round(s.stats.unservedKwh / 1000);
  const emissionsT = Math.round(s.player.emissionsKg / 1000);
  const regionOutputAvg = s.stats.intervalsCounted ? Math.round(s.stats.regionOutputBpsSum / s.stats.intervalsCounted) : 10_000;
  // profit counts, but so do the lights and the region's economy
  const score = Math.round(profitCc / 100 - unservedMWh * 40 - emissionsT * 2 + (regionOutputAvg - 8_000) * 20);
  return { profitCc, unservedMWh, emissionsT, regionOutputBps: regionOutputAvg, score };
}

function licenceStep(s: RegionState, ctx: RCtx): void {
  const next = LICENCES.find((l) => l.level === s.player.licence + 1);
  if (!next) return;
  const rel = reliabilityBps(s);
  if (s.player.deliveredKwh >= next.needMWh * 1000 && rel >= next.needReliabilityBps) {
    s.player.licence = next.level;
    emit(s, ctx, { type: "LICENCE", severity: "good", title: `Operating permit earned: ${next.name}`, detail: next.level === 2 ? "Combined-cycle gas and bigger turbines are open to you." : next.level === 3 ? "The biggest plants and batteries are open to you." : "You are an anchor of the regional grid." });
  }
}

export function reliabilityBps(s: RegionState): number {
  const w = s.player.servedShareWindow;
  return w.length ? Math.round(w.reduce((a, b) => a + b, 0) / w.length) : 10_000;
}

export const ONBOARDING = [
  { title: "Residential East is dark", hint: "Tap ⚡ on your battery to send it power.", target: "plant:eastside" },
  { title: "The region is short of power", hint: "Tap ▶ on your gas turbine to start it. You get paid for every megawatt.", target: "plant:kestrel" },
  { title: "Build more power where it's needed", hint: "Tap + to build a diesel plant in Residential East.", target: "node:residential_east" },
] as const;

function onboardingStep(s: RegionState, ctx: RCtx): void {
  if (s.onboarding.done) return;
  const done = [
    () => s.plants.some((p) => p.plantId === "eastside" && p.batteryMode !== "hold"),
    () => s.plants.some((p) => p.plantId === "kestrel" && p.online),
    () => s.plants.some((p) => p.ownerId === "player" && p.plantId.startsWith("b")),
  ];
  while (s.onboarding.step < done.length && done[s.onboarding.step]()) s.onboarding.step += 1;
  if (s.onboarding.step >= done.length) {
    s.onboarding.done = true;
    emit(s, ctx, { type: "ONBOARDING_DONE", severity: "good", title: "You're running a power company", detail: "Keep every district lit and make money. The next move is always at the bottom of the screen." });
  }
}
