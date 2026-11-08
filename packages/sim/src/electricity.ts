/**
 * Physical layer: generator availability, capacity checks, per-tick dispatch,
 * fuel burn, permit retirement, heat/wear, solar + battery.
 *
 * Conservation rules enforced here:
 *  - energy delivered per tick = allotted W / 10 Wh, only while the source can supply it;
 *  - diesel fuel burned = Wh * 0.3 mL, debited from the operator's tank in the ledger;
 *  - CO2 = fuel mL * 2680 mg, retired from the operator's permit allowance (hard cap);
 *  - billed cc = floor(cumulative Wh * rate / 1000) <= delivered energy value.
 */
import { CO2_MG_PER_ML, ccForEnergy, fuelMlForWh, whPerTick } from "@blackout/shared";
import { PHYSICS, SOLAR_PROFILE_BPS } from "./config.ts";
import { ACC, bal, transfer } from "./ledger.ts";
import { L, SimError, clockHour, emit, kW, type ContractState, type Ctx, type GeneratorState, type SimState } from "./state.ts";
import { districtFeeder, feederLoadW, stageOf } from "./company.ts";

export const providerAcct = (c: ContractState) => (c.provider === "player" ? ACC.player : ACC.rival);

export function generatorAvailableW(s: SimState, g: GeneratorState): number {
  if (g.status !== "online") return 0;
  if (g.type === "diesel") return g.ratedW;
  const h = clockHour(s);
  const bps = h === null ? 0 : SOLAR_PROFILE_BPS[h];
  return Math.floor((g.ratedW * bps) / 10_000 / 100) * 100;
}

export function activeContractsOn(s: SimState, generatorId: string): ContractState[] {
  return Object.values(s.contracts).filter((c) => c.generatorId === generatorId && c.status === "active");
}

export const assignedW = (s: SimState, generatorId: string) => activeContractsOn(s, generatorId).reduce((a, c) => a + c.allottedW, 0);

export const remainingTicks = (c: ContractState) => c.totalTicks - c.deliveredTicks;
export const contractFuelPerTick = (c: ContractState) => fuelMlForWh(whPerTick(c.allottedW));
/** Player diesel burned per tick including the feeder's line loss into the customer's district. */
export function fuelPerTick(s: SimState, c: ContractState): number {
  const base = contractFuelPerTick(c);
  if (c.provider !== "player") return base;
  const d = s.districts[s.businesses[c.businessId]?.districtId ?? ""];
  const loss = d ? districtFeeder(d).lossBps : 0;
  return loss ? Math.ceil((base * (10_000 + loss)) / 10_000) : base;
}
export const contractEnergyWh = (w: number, hours: number) => w * hours;

function isDieselContract(s: SimState, c: ContractState): boolean {
  if (c.provider === "rival") return true;
  return c.generatorId !== null && s.generators[c.generatorId]?.type === "diesel";
}

/** Fuel already committed to the remaining ticks of active diesel contracts (no double spend). */
export function reservedFuelMl(s: SimState, provider: "player" | "rival", exceptContractId?: string): number {
  let r = 0;
  for (const c of Object.values(s.contracts)) {
    if (c.provider !== provider || c.status !== "active" || c.contractId === exceptContractId) continue;
    if (!isDieselContract(s, c)) continue;
    r += remainingTicks(c) * fuelPerTick(s, c);
  }
  return r;
}
export const reservedPermitMg = (s: SimState, provider: "player" | "rival", exceptContractId?: string) =>
  reservedFuelMl(s, provider, exceptContractId) * CO2_MG_PER_ML;

/** Distribution: the district's feeder must carry this load on top of what it already carries. */
export function assertFeederRoom(s: SimState, c: ContractState): void {
  const district = s.districts[s.businesses[c.businessId]?.districtId ?? ""];
  if (!district) return;
  const f = districtFeeder(district);
  const carrying = feederLoadW(s, district.districtId, c.contractId);
  if (carrying + c.allottedW > f.capacityW) {
    throw new SimError("CAPACITY_EXCEEDED", `The ${district.name} feeder carries ${kW(carrying)} of ${kW(f.capacityW)} kW; this load needs ${kW(c.allottedW)} kW more. Upgrade its substation.`, {
      districtId: district.districtId, feederCapacityW: f.capacityW, feederLoadW: carrying, requestedW: c.allottedW,
    });
  }
}

/** Validates that a pending contract can be served by `generatorId`; throws a coded SimError otherwise. */
export function validateAssignment(s: SimState, c: ContractState, generatorId: string): void {
  const g = s.generators[generatorId];
  if (!g || g.ownerId !== "player") throw new SimError("NOT_FOUND", `Unknown generator ${generatorId}`);
  if (g.status !== "online") {
    throw new SimError("GENERATOR_OFFLINE", `${g.name} is ${g.status}${g.offlineUntilTick !== null ? ` until tick ${g.offlineUntilTick}` : ""}.`, { generatorId, status: g.status });
  }
  const used = assignedW(s, generatorId);
  if (used + c.allottedW > g.ratedW) {
    throw new SimError("CAPACITY_EXCEEDED", `${g.name} has ${kW(g.ratedW - used)} kW free across all active contracts; this load needs ${kW(c.allottedW)} kW.`, {
      generatorId,
      ratedW: g.ratedW,
      assignedW: used,
      requestedW: c.allottedW,
    });
  }
  assertFeederRoom(s, c);
  const totalTicks = c.totalTicks;
  if (g.type === "diesel") {
    const needFuel = totalTicks * fuelPerTick(s, c);
    const freeFuel = bal(s, "fuel_ml", ACC.player) - reservedFuelMl(s, "player");
    if (needFuel > freeFuel) {
      throw new SimError("INSUFFICIENT_FUEL", `Needs ${L(needFuel)} L; ${L(Math.max(0, freeFuel))} L free after fuel reserved for active contracts.`, { needMl: needFuel, freeMl: freeFuel });
    }
    const needCo2 = needFuel * CO2_MG_PER_ML;
    const freePermits = bal(s, "permit_mg", ACC.player) - reservedPermitMg(s, "player");
    if (needCo2 > freePermits) {
      throw new SimError("INSUFFICIENT_PERMITS", `Needs ${(needCo2 / 1e6).toFixed(2)} kg CO2 allowance; ${(Math.max(0, freePermits) / 1e6).toFixed(2)} kg free.`, { needMg: needCo2, freeMg: freePermits });
    }
  } else {
    const avail = generatorAvailableW(s, g) - used;
    const batteryWh = s.battery ? Math.floor((s.battery.storedWh * s.battery.roundTripEfficiencyBps) / 10_000) : 0;
    const needWh = contractEnergyWh(c.allottedW, c.durationHours);
    if (avail < c.allottedW && batteryWh < needWh) {
      throw new SimError("CAPACITY_EXCEEDED", `Solar is producing ${kW(Math.max(0, avail))} kW free right now and the battery holds ${(batteryWh / 1000).toFixed(2)} usable kWh; this load needs ${kW(c.allottedW)} kW.`, {
        generatorId,
        availableW: avail,
        batteryWh,
      });
    }
  }
}

export interface TickDelivery {
  delivered: boolean;
  failReason?: "GENERATOR_OFFLINE" | "INSUFFICIENT_FUEL" | "INSUFFICIENT_PERMITS" | "SOURCE_SHORTFALL";
}

/** Delivers one tick of energy for a diesel-backed contract (player or rival). */
function deliverDieselTick(s: SimState, ctx: Ctx, c: ContractState): TickDelivery {
  const acct = providerAcct(c);
  const wh = whPerTick(c.allottedW);
  const fuel = fuelPerTick(s, c);
  const co2 = fuel * CO2_MG_PER_ML;
  if (bal(s, "fuel_ml", acct) < fuel) return { delivered: false, failReason: "INSUFFICIENT_FUEL" };
  if (bal(s, "permit_mg", acct) < co2) return { delivered: false, failReason: "INSUFFICIENT_PERMITS" };
  transfer(s, ctx, "fuel_ml", acct, ACC.fuelBurned, fuel, "fuel_burn", c.contractId);
  transfer(s, ctx, "permit_mg", acct, ACC.permitsRetired, co2, "co2_retire_permits", c.contractId);
  c.fuelUsedMl += fuel;
  c.co2Mg += co2;
  c.hourFuelMl += fuel;
  s.regulator.emissionsTodayMg += co2;
  if (c.provider === "player") {
    s.player.chainBackedFuelMl = Math.max(0, (s.player.chainBackedFuelMl ?? 0) - fuel);
    s.player.co2TodayMg += co2;
    s.player.co2TotalMg += co2;
    s.dayStats.fuelBurnedMl += fuel;
    s.dayStats.fuelCostCc += Math.round((fuel * s.player.fuelCostBasisCcPerL) / 1000);
    s.dayStats.co2Mg += co2;
    s.dayStats.hourFuelMl += fuel;
    s.dayStats.hourCo2Mg += co2;
    s.dayStats.generationWh.diesel += wh;
    if (c.generatorId) {
      const g = s.generators[c.generatorId];
      g.cumulativeFuelMl += fuel;
    }
  }
  return { delivered: true };
}

/** Bills newly delivered energy from contract escrow to the provider (cumulative floor). */
function billTick(s: SimState, ctx: Ctx, c: ContractState, wh: number): void {
  c.deliveredWh += wh;
  c.deliveredTicks += 1;
  c.lastDeliveredTick = s.tick;
  c.hourWh += wh;
  const owed = ccForEnergy(c.deliveredWh, c.rateCcPerKwh) - c.billedCc;
  if (owed > 0) {
    const amt = Math.min(owed, c.escrowCc);
    transfer(s, ctx, "credits_cc", ACC.escrowContracts, providerAcct(c), amt, "energy_billing", c.contractId);
    c.billedCc += amt;
    c.escrowCc -= amt;
    c.hourBilledCc += amt;
    if (c.provider === "player") s.dayStats.revenueCc += amt;
    const b = s.businesses[c.businessId];
    b.today.powerCostCc += amt;
  }
}

/**
 * One tick of dispatch for every player generator and the rival plant.
 * Returns the contracts that failed this tick (caller handles refunds/trust).
 */
export function dispatchTick(s: SimState, ctx: Ctx): { contract: ContractState; reason: string }[] {
  const failures: { contract: ContractState; reason: string }[] = [];
  const battery = s.battery;
  if (battery) {
    battery.chargeW = 0;
    battery.dischargeW = 0;
  }
  for (const gid of s.player.generatorIds) {
    const g = s.generators[gid];
    const contracts = activeContractsOn(s, gid);
    let output = 0;
    if (g.type === "diesel") {
      for (const c of contracts) {
        if (g.status !== "online") {
          failures.push({ contract: c, reason: "GENERATOR_OFFLINE" });
          continue;
        }
        const r = deliverDieselTick(s, ctx, c);
        if (!r.delivered) {
          failures.push({ contract: c, reason: r.failReason! });
          continue;
        }
        billTick(s, ctx, c, whPerTick(c.allottedW));
        output += c.allottedW;
      }
    } else {
      let supplyW = generatorAvailableW(s, g);
      for (const c of contracts) {
        const w = c.allottedW;
        if (supplyW >= w) {
          supplyW -= w;
          output += w;
          s.dayStats.generationWh.solar += whPerTick(w);
          billTick(s, ctx, c, whPerTick(w));
          continue;
        }
        // shortfall: draw on the battery (efficiency applied on discharge)
        const shortW = w - supplyW;
        const solarPart = supplyW;
        const shortWh = whPerTick(shortW);
        const storedNeed = battery ? Math.ceil((shortWh * 10_000) / battery.roundTripEfficiencyBps) : Infinity;
        if (battery && battery.dischargeW + shortW <= battery.maxDischargeW && battery.storedWh >= storedNeed) {
          battery.storedWh -= storedNeed;
          battery.dischargeW += shortW;
          output += solarPart;
          supplyW = 0;
          s.dayStats.generationWh.solar += whPerTick(solarPart);
          s.dayStats.generationWh.battery += shortWh;
          billTick(s, ctx, c, whPerTick(w));
        } else {
          failures.push({ contract: c, reason: "SOURCE_SHORTFALL" });
        }
      }
      // surplus solar charges the battery
      if (battery && supplyW > 0) {
        const room = battery.capacityWh - battery.storedWh;
        const chargeW = Math.min(supplyW, battery.maxChargeW, room * 10);
        const addWh = Math.floor(chargeW / 10); // W * 0.1 h; exact for 100 W quanta
        battery.storedWh += addWh;
        battery.chargeW = chargeW;
        output += chargeW;
      }
    }
    g.outputW = output;
    g.cumulativeWh += whPerTick(output);
    g.whSinceService += whPerTick(output);
  }
  // rival plant: same fuel/permit physics, no heat (its policy keeps load <= 90%).
  // If the rival built rooftop solar, daylight covers whole contracts first (no fuel, no CO2).
  const h = clockHour(s);
  let rivalSolarW = s.rival.solarW && h !== null ? Math.floor((s.rival.solarW * SOLAR_PROFILE_BPS[h]) / 10_000 / 100) * 100 : 0;
  for (const c of Object.values(s.contracts)) {
    if (c.provider !== "rival" || c.status !== "active") continue;
    if (rivalSolarW >= c.allottedW) {
      rivalSolarW -= c.allottedW;
      billTick(s, ctx, c, whPerTick(c.allottedW));
      continue;
    }
    const r = deliverDieselTick(s, ctx, c);
    if (!r.delivered) {
      failures.push({ contract: c, reason: r.failReason! });
      continue;
    }
    billTick(s, ctx, c, whPerTick(c.allottedW));
  }
  return failures;
}

/** Heat & wear for player diesel sets. Returns generators that broke this tick. */
export function heatTick(s: SimState, ctx: Ctx): GeneratorState[] {
  const broken: GeneratorState[] = [];
  const heatOn = stageOf(s) >= 2; // generators start running hot once the company has grown
  for (const gid of s.player.generatorIds) {
    const g = s.generators[gid];
    if (g.type !== "diesel") continue;
    if (g.status !== "online") continue;
    const load = assignedW(s, gid);
    const loadBps = g.ratedW > 0 ? Math.floor((load * 10_000) / g.ratedW) : 0;
    g.wearBps = Math.min(10_000, Math.floor((g.whSinceService * 10_000) / PHYSICS.WEAR_FULL_WH));
    if (!heatOn) {
      g.heatPermille = 0;
      continue;
    }
    if (loadBps > PHYSICS.HEAT_SAFE_LOAD_BPS) {
      g.heatPermille += Math.floor((loadBps - PHYSICS.HEAT_SAFE_LOAD_BPS) / 10) + (g.wearBps > 8_000 ? PHYSICS.WEAR_HEAT_BONUS : 0);
    } else {
      g.heatPermille = Math.max(0, g.heatPermille - PHYSICS.HEAT_COOL_PER_TICK);
    }
    if (g.heatPermille >= PHYSICS.HEAT_WARN && !g.heatWarned) {
      g.heatWarned = true;
      emit(s, ctx, "OVERHEAT_WARNING", [`generator:${gid}`], `${g.name} is running at ${(loadBps / 100).toFixed(0)}% load; heat ${(g.heatPermille / 10).toFixed(0)}%. Above 90% load heat climbs until the set breaks down.`, { generatorId: gid, heatPermille: g.heatPermille, loadBps });
    }
    if (g.heatPermille < PHYSICS.HEAT_WARN - 100) g.heatWarned = false;
    if (g.heatPermille >= PHYSICS.HEAT_BREAK) {
      g.heatPermille = PHYSICS.HEAT_BREAK;
      g.status = "broken";
      g.offlineUntilTick = s.tick + PHYSICS.REPAIR_TICKS;
      g.outputW = 0;
      broken.push(g);
      emit(s, ctx, "GENERATOR_BROKEN", [`generator:${gid}`], `${g.name} overheated and broke down at ${(loadBps / 100).toFixed(0)}% load. Offline for ${PHYSICS.REPAIR_TICKS / 10} game hours; its contracts lose power.`, { generatorId: gid, offlineUntilTick: g.offlineUntilTick });
    }
  }
  return broken;
}

/** Brings repaired/serviced generators back online. */
export function repairTick(s: SimState, ctx: Ctx): void {
  for (const g of Object.values(s.generators)) {
    if (g.status !== "online" && g.offlineUntilTick !== null && s.tick >= g.offlineUntilTick) {
      const was = g.status;
      g.status = "online";
      g.offlineUntilTick = null;
      g.heatPermille = 0;
      g.heatWarned = false;
      emit(s, ctx, "GENERATOR_REPAIRED", [`generator:${g.generatorId}`], `${g.name} is back online after ${was === "broken" ? "repair" : "maintenance"}.`, { generatorId: g.generatorId, after: was });
    }
  }
}
