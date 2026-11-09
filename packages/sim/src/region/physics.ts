/**
 * Clock, sun, weather, demand profiles and generator costs. Pure functions of state.
 */
import type { FuelId, PriceComponent } from "@blackout/shared";
import { rngInt } from "../prng.ts";
import { DIESEL_KG_CO2_PER_L, GAS_KG_CO2_PER_MMBTU, INTERVALS_PER_DAY, MINUTES_PER_INTERVAL, START_MINUTE, TECHS, type Profile } from "./config.ts";
import type { RPlant, RegionState } from "./state.ts";

export function clockOf(interval: number) {
  const total = START_MINUTE + interval * MINUTES_PER_INTERVAL;
  const day = Math.floor(total / 1440) + 1;
  const minuteOfDay = total % 1440;
  const hh = String(Math.floor(minuteOfDay / 60)).padStart(2, "0");
  const mm = String(minuteOfDay % 60).padStart(2, "0");
  return { day, minuteOfDay, label: `Day ${day} · ${hh}:${mm}` };
}

/** Sun elevation 0..1 (sunrise 06:00, sunset 19:30, peak 12:45). */
export function sunElevation(minuteOfDay: number): number {
  const rise = 360;
  const set = 1170;
  if (minuteOfDay <= rise || minuteOfDay >= set) return 0;
  const x = (minuteOfDay - rise) / (set - rise);
  return Math.sin(Math.PI * x);
}

export function solarFactorBps(s: RegionState, minuteOfDay: number): number {
  const sun = sunElevation(minuteOfDay);
  const w = s.weather;
  const cloud = w.condition === "storm" ? 90 : w.condition === "rain" ? Math.max(w.cloudPct, 75) : w.cloudPct;
  const heatLoss = w.tempC > 30 ? (w.tempC - 30) * 0.004 : 0;
  return Math.max(0, Math.round(10_000 * Math.pow(sun, 1.2) * (1 - 0.75 * (cloud / 100)) * (1 - heatLoss)));
}

/** Demand multiplier (bps) by profile and time of day. */
export function profileBps(profile: Profile, minuteOfDay: number): number {
  const h = minuteOfDay / 60;
  const bump = (center: number, width: number) => Math.exp(-((h - center) ** 2) / (2 * width * width));
  switch (profile) {
    case "industry":
      return Math.round(10_000 * (0.9 + 0.08 * bump(11, 4)));
    case "flat":
      return 10_000;
    case "hospital":
      return Math.round(10_000 * (0.85 + 0.15 * bump(13, 5)));
    case "commerce":
      return Math.round(10_000 * (0.42 + 0.58 * Math.max(bump(12.5, 3.2), 0.85 * bump(18.5, 1.6))));
    case "residential":
      return Math.round(10_000 * (0.45 + 0.25 * bump(7.5, 1.3) + 0.15 * bump(13, 3) + 0.55 * bump(19.3, 1.7)));
    case "farm":
      return Math.round(10_000 * (0.55 + 0.35 * bump(10, 3) + 0.2 * bump(19, 1.5)));
  }
}

/** Extra cooling load (bps) when it is hot. */
export function coolingBps(profile: Profile, tempC: number): number {
  if (tempC <= 24) return 0;
  const per = profile === "residential" ? 180 : profile === "commerce" ? 140 : profile === "flat" ? 60 : profile === "hospital" ? 80 : 20;
  return Math.round(per * (tempC - 24));
}

/** World fuel prices in cc per unit (gas per MMBtu; diesel per litre). 1 credit is pegged to US$1 for inputs. */
export function worldFuelCc(s: RegionState, fuel: FuelId): number {
  if (fuel === "gas") return Math.round(s.input.gasUsdPerMMBtu * 100);
  // diesel ≈ Brent per litre × refining crack
  return Math.round((s.input.brentUsdPerBbl / 159) * 1.45 * 100);
}

/** Fuel units (milli-MMBtu or mL) burned per kW per interval. */
export function burnPerKwInterval(plant: { tech: RPlant["tech"] }): number {
  const t = TECHS[plant.tech];
  // MWh per kW per interval = 1/12000; units per MWh = heatRate × 1000 (milli / mL)
  return (t.heatRate * 1000) / 12_000;
}

export function co2KgPerMWh(tech: RPlant["tech"]): number {
  const t = TECHS[tech];
  if (t.fuel === "gas") return t.heatRate * GAS_KG_CO2_PER_MMBTU;
  if (t.fuel === "diesel") return t.heatRate * DIESEL_KG_CO2_PER_L;
  return 0;
}

/** Marginal cost = fuel × heat rate + variable O&M + carbon (§5), with the parts. */
export function marginalCost(s: RegionState, plant: Pick<RPlant, "tech">, fuelPriceCc: number): { totalCc: number; parts: PriceComponent[] } {
  const t = TECHS[plant.tech];
  const fuelCc = t.fuel ? Math.round(t.heatRate * fuelPriceCc) : 0;
  const carbonCc = Math.round((co2KgPerMWh(plant.tech) / 1000) * s.regulator.carbonCcPerT);
  const parts: PriceComponent[] = [];
  if (t.fuel) parts.push({ label: `${t.fuel === "gas" ? "Gas" : "Diesel"} ${t.heatRate} ${t.fuel === "gas" ? "MMBtu" : "L"}/MWh`, ccPerMWh: fuelCc });
  parts.push({ label: "Variable O&M", ccPerMWh: t.vomCcPerMWh });
  if (carbonCc > 0) parts.push({ label: "Carbon", ccPerMWh: carbonCc });
  return { totalCc: fuelCc + t.vomCcPerMWh + carbonCc, parts };
}

/** Weather moves towards the real snapshot with seeded drift; heatwaves and storms come from the snapshot or chance. */
export function stepWeather(s: RegionState): { started: "heatwave" | "storm" | null; ended: "heatwave" | "storm" | null } {
  const w = s.weather;
  const { minuteOfDay } = clockOf(s.interval);
  const h = minuteOfDay / 60;
  // daily temperature swing around the snapshot (snapshot is treated as the afternoon high-ish)
  const swing = 5 * Math.cos(((h - 15) / 24) * 2 * Math.PI);
  const heat = s.interval < w.heatUntil ? 6 : 0;
  const target = s.input.tempC - 2 + swing + heat;
  w.tempC = Math.round((w.tempC + (target - w.tempC) * 0.08) * 10) / 10;
  let cloudTarget = s.input.cloudPct;
  if (s.interval < w.stormUntil) cloudTarget = 95;
  if (s.interval < w.heatUntil) cloudTarget = Math.min(cloudTarget, 10);
  const drift = (rngInt(s.rng, 21) - 10) * 0.6;
  w.cloudPct = Math.max(0, Math.min(100, Math.round(w.cloudPct + (cloudTarget - w.cloudPct) * 0.05 + drift)));
  w.windKph = Math.max(0, Math.round(s.input.windKph + (s.interval < w.stormUntil ? 35 : 0) + (rngInt(s.rng, 9) - 4)));
  let started: "heatwave" | "storm" | null = null;
  let ended: "heatwave" | "storm" | null = null;
  const prev = w.condition;
  // chance of a heatwave (warm snapshot) or a storm, once a day-ish, never in the first game hours
  if (s.interval > 36 && s.interval >= w.heatUntil && s.interval >= w.stormUntil && s.interval % 12 === 0) {
    const roll = rngInt(s.rng, 1000);
    if (s.input.tempC >= 26 && roll < 18) {
      w.heatUntil = s.interval + 96 + rngInt(s.rng, 96);
      started = "heatwave";
    } else if (roll >= 990) {
      w.stormUntil = s.interval + 24 + rngInt(s.rng, 36);
      started = "storm";
    }
  }
  w.condition = s.interval < w.stormUntil ? "storm" : s.interval < w.heatUntil || w.tempC >= 34 ? "heatwave" : w.cloudPct >= 80 ? "rain" : w.cloudPct >= 45 ? "cloudy" : "clear";
  if (prev === "heatwave" && w.condition !== "heatwave" && !started) ended = "heatwave";
  if (prev === "storm" && w.condition !== "storm" && !started) ended = "storm";
  return { started, ended };
}

export const dayIndex = (interval: number) => Math.floor((START_MINUTE + interval * MINUTES_PER_INTERVAL) / 1440);
export const isNewDay = (interval: number) => interval > 0 && dayIndex(interval) !== dayIndex(interval - 1);
export { INTERVALS_PER_DAY };
