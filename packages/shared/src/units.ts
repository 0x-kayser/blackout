/**
 * BLACKOUT fixed-point units. Every authoritative quantity is an integer.
 *
 * | Quantity          | Unit in code | Display unit | Factor            |
 * |-------------------|--------------|--------------|-------------------|
 * | credits           | cc           | credits (₡)  | 100 cc = 1 credit |
 * | power             | W            | kW           | 1000 W = 1 kW     |
 * | energy            | Wh           | kWh          | 1000 Wh = 1 kWh   |
 * | diesel            | mL           | L            | 1000 mL = 1 L     |
 * | CO2 / permits     | mg           | kg           | 1e6 mg = 1 kg     |
 * | tariff            | cc per kWh   | credits/kWh  |                   |
 * | fuel price        | cc per L     | credits/L    |                   |
 * | ratios            | bps          | %            | 10000 bps = 100%  |
 * | heat              | permille     | %            | 1000 = breakdown  |
 *
 * Time: one authoritative tick = 1 real second = 6 game minutes.
 * 10 ticks = 1 game hour; 240 ticks = one 24-hour operating day.
 *
 * Rounding rule: money derived from energy is billed with a cumulative floor
 * (billedSoFar = floor(totalWh * rate / 1000)), so billed amounts never exceed
 * delivered energy and rounding never drifts. Power is quantised to 100 W so that
 * per-tick fuel (W/10 Wh * 0.3 mL/Wh) is always an exact integer of mL.
 */

export const CC_PER_CREDIT = 100;
export const W_PER_KW = 1000;
export const WH_PER_KWH = 1000;
export const ML_PER_L = 1000;
export const MG_PER_KG = 1_000_000;
export const BPS = 10_000;

export const TICK_MS = 1000;
export const TICKS_PER_GAME_HOUR = 10;
export const GAME_MINUTES_PER_TICK = 6;
export const POWER_QUANTUM_W = 100;

/** 0.30 L of diesel per kWh = 0.3 mL per Wh = 3 mL per 10 Wh. */
export const FUEL_ML_PER_10WH = 3;
/** 2.68 kg CO2 per litre = 2680 mg per mL. */
export const CO2_MG_PER_ML = 2680;
/** One carbon permit covers 10 kg CO2. */
export const PERMIT_MG = 10 * MG_PER_KG;

export const credits = (n: number): number => Math.round(n * CC_PER_CREDIT);
export const kw = (n: number): number => Math.round(n * W_PER_KW);
export const litres = (n: number): number => Math.round(n * ML_PER_L);
export const kg = (n: number): number => Math.round(n * MG_PER_KG);

/** Energy delivered in one tick by a constant load (W). Exact for 100 W quanta. */
export const whPerTick = (watts: number): number => watts / TICKS_PER_GAME_HOUR;
export const fuelMlForWh = (wh: number): number => (wh * FUEL_ML_PER_10WH) / 10;
export const co2MgForFuelMl = (ml: number): number => ml * CO2_MG_PER_ML;

/** Cumulative-floor billing helper: cc owed for `wh` at `rateCcPerKwh`. */
export const ccForEnergy = (wh: number, rateCcPerKwh: number): number =>
  Math.floor((wh * rateCcPerKwh) / WH_PER_KWH);

// ---- display helpers (presentation only; never feed back into game math) ----
export const fmtCredits = (cc: number): string => {
  const sign = cc < 0 ? "-" : "";
  const abs = Math.abs(cc);
  const whole = Math.floor(abs / CC_PER_CREDIT);
  const frac = abs % CC_PER_CREDIT;
  return `${sign}₡${whole.toLocaleString("en-US")}${frac ? "." + String(frac).padStart(2, "0") : ""}`;
};
export const fmtKw = (w: number): string => `${(w / W_PER_KW).toFixed(1)} kW`;
export const fmtKwh = (wh: number): string => `${(wh / WH_PER_KWH).toFixed(2)} kWh`;
export const fmtLitres = (ml: number): string => `${(ml / ML_PER_L).toFixed(1)} L`;
export const fmtKg = (mg: number): string => `${(mg / MG_PER_KG).toFixed(2)} kg`;
export const fmtRate = (ccPerKwh: number): string => `${(ccPerKwh / CC_PER_CREDIT).toFixed(2)} ₡/kWh`;
export const fmtPct = (bps: number): string => `${(bps / 100).toFixed(1)}%`;
/** "HH:MM" for a game clock expressed in minutes since 00:00. */
export const fmtClock = (minuteOfDay: number): string => {
  const m = ((minuteOfDay % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};
