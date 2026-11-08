/**
 * Immutable scenario configuration. Every tuning value lives here (or in
 * policies/merchantPricing.ts for merchant pricing). Units: see @blackout/shared units.ts.
 */
import type { UpgradeId } from "@blackout/shared";
import brent from "../data/brent.json" with { type: "json" };

export const SCENARIO_VERSION = "2026.11.07-v1";

export const TIMING = {
  MORNING_TICKS: 45,
  OPERATING_TICKS: 240, // 24 game hours x 10 ticks
  SETTLEMENT_TICKS: 15,
  WAVE_INTERVAL_TICKS: 30,
  WAVES_PER_DAY: 8,
  DAY_START_MINUTE: 6 * 60, // operating day clock starts 06:00
  REQUEST_DEADLINE_TICKS: 10, // non-tutorial request timer (10 s)
  ASSIGN_DEADLINE_TICKS: 10, // accepted-but-unassigned contracts expire after 10 s (non-tutorial)
  QUOTE_TTL_TICKS: 15,
  TUTORIAL_WAVES: 3,
  TUTORIAL_PATIENCE_TICKS: 60, // tutorial customers wait up to 6 game hours (1 real minute), no visible timer
  CAMPAIGN_DAYS: 3,
} as const;

export const STARTING_KIT = {
  creditsCc: 100_000, // 1,000 credits
  fuelMl: 20_000, // 20 L
  tankCapacityMl: 60_000, // 60 L
  permits: 6, // 6 x 10 kg = 60 kg
  generator: { name: "Shed Diesel 5kW", ratedW: 5_000 },
  defaultTariffCcPerKwh: 800, // 8 credits/kWh
  reputationBps: 5_000,
} as const;

export const PHYSICS = {
  HEAT_SAFE_LOAD_BPS: 9_000, // above 90% load heat rises
  HEAT_COOL_PER_TICK: 25,
  HEAT_WARN: 700,
  HEAT_BREAK: 1_000,
  WEAR_HEAT_BONUS: 10, // extra heat/tick above 90% when wear > 80%
  REPAIR_TICKS: 30, // breakdown repair: 3 game hours
  SERVICE_COST_CC: 6_000,
  SERVICE_DOWNTIME_TICKS: 120, // half an operating day
  WEAR_FULL_WH: 400_000, // 400 kWh between services
  HEAT_ENABLED_FROM_DAY: 2,
} as const;

export const GRID = { tariffCcPerKwh: 700 } as const;

/** Clock-hour (0..23) solar output in bps of nameplate. Zero at night. */
export const SOLAR_PROFILE_BPS: readonly number[] = [
  0, 0, 0, 0, 0, 0, 500, 1_500, 3_500, 5_500, 7_500, 9_000, 10_000, 10_000, 9_000, 7_500, 5_500, 3_500, 1_500, 300, 0, 0, 0, 0,
];

export interface BusinessConfig {
  businessId: string;
  districtId: string;
  name: string;
  kind: string;
  demandW: number;
  revenueCcPerPoweredHour: number;
  variableCostCcPerPoweredHour: number;
  fixedCostCcPerDay: number;
  startCashCc: number;
  loyaltyBps: number;
  /** How far the customer moves toward the player's counter (bps of the gap). */
  concessionBps: number;
  /** Fixed tariff customers never haggle (Hospital Row). */
  fixedTariffCcPerKwh?: number;
  /** Tech Hub: leaves for the rival after this many gouges. */
  gougeTolerance: number;
}

export interface DistrictConfig {
  districtId: string;
  name: string;
  unlockedAtStart: boolean;
  unlockRequirementW: number;
  unlockCostCc: number;
  outsideDemandCcPerHour: number;
  payBehaviour: "haggle" | "fixed_low" | "price_sensitive" | "low";
}

export const DISTRICTS: DistrictConfig[] = [
  { districtId: "market_quarter", name: "Market Quarter", unlockedAtStart: true, unlockRequirementW: 0, unlockCostCc: 0, outsideDemandCcPerHour: 16_000, payBehaviour: "haggle" },
  { districtId: "hospital_row", name: "Hospital Row", unlockedAtStart: false, unlockRequirementW: 10_000, unlockCostCc: 30_000, outsideDemandCcPerHour: 22_000, payBehaviour: "fixed_low" },
  { districtId: "tech_hub", name: "Tech Hub", unlockedAtStart: false, unlockRequirementW: 15_000, unlockCostCc: 50_000, outsideDemandCcPerHour: 26_000, payBehaviour: "price_sensitive" },
];

export const BUSINESSES: BusinessConfig[] = [
  // Cold Room fixture from the design doc: 1.5 kW, 40 credits/powered hour revenue, 20 credits costs.
  { businessId: "cold_room", districtId: "market_quarter", name: "Cold Room", kind: "cold_storage", demandW: 1_500, revenueCcPerPoweredHour: 4_000, variableCostCcPerPoweredHour: 2_000, fixedCostCcPerDay: 12_000, startCashCc: 15_000, loyaltyBps: 5_000, concessionBps: 3_500, gougeTolerance: 99 },
  { businessId: "bakery", districtId: "market_quarter", name: "Sunrise Bakery", kind: "bakery", demandW: 1_200, revenueCcPerPoweredHour: 3_000, variableCostCcPerPoweredHour: 1_600, fixedCostCcPerDay: 10_000, startCashCc: 12_000, loyaltyBps: 5_000, concessionBps: 3_500, gougeTolerance: 99 },
  { businessId: "pharmacy", districtId: "market_quarter", name: "Corner Pharmacy", kind: "pharmacy", demandW: 800, revenueCcPerPoweredHour: 2_600, variableCostCcPerPoweredHour: 1_400, fixedCostCcPerDay: 9_000, startCashCc: 12_000, loyaltyBps: 5_500, concessionBps: 4_500, gougeTolerance: 99 },
  { businessId: "cyber_cafe", districtId: "market_quarter", name: "Byte Cyber Café", kind: "cyber_cafe", demandW: 1_000, revenueCcPerPoweredHour: 2_800, variableCostCcPerPoweredHour: 1_500, fixedCostCcPerDay: 10_000, startCashCc: 10_000, loyaltyBps: 4_500, concessionBps: 3_000, gougeTolerance: 99 },
  { businessId: "corner_shop", districtId: "market_quarter", name: "Mama Ade's Corner Shop", kind: "corner_shop", demandW: 600, revenueCcPerPoweredHour: 1_600, variableCostCcPerPoweredHour: 900, fixedCostCcPerDay: 5_500, startCashCc: 8_000, loyaltyBps: 5_000, concessionBps: 3_500, gougeTolerance: 99 },
  // Locked districts (unlock needs capacity upgrade).
  { businessId: "night_clinic", districtId: "hospital_row", name: "Night Clinic", kind: "clinic", demandW: 3_000, revenueCcPerPoweredHour: 9_000, variableCostCcPerPoweredHour: 4_000, fixedCostCcPerDay: 40_000, startCashCc: 60_000, loyaltyBps: 5_000, concessionBps: 0, fixedTariffCcPerKwh: 700, gougeTolerance: 99 },
  { businessId: "medical_lab", districtId: "hospital_row", name: "Medical Lab", kind: "lab", demandW: 2_500, revenueCcPerPoweredHour: 7_000, variableCostCcPerPoweredHour: 3_000, fixedCostCcPerDay: 30_000, startCashCc: 50_000, loyaltyBps: 5_000, concessionBps: 0, fixedTariffCcPerKwh: 700, gougeTolerance: 99 },
  { businessId: "cowork", districtId: "tech_hub", name: "Hive Co-working", kind: "coworking", demandW: 4_000, revenueCcPerPoweredHour: 12_000, variableCostCcPerPoweredHour: 5_000, fixedCostCcPerDay: 50_000, startCashCc: 70_000, loyaltyBps: 4_000, concessionBps: 2_500, gougeTolerance: 2 },
  { businessId: "server_closet", districtId: "tech_hub", name: "Server Closet", kind: "server_room", demandW: 3_000, revenueCcPerPoweredHour: 9_000, variableCostCcPerPoweredHour: 3_500, fixedCostCcPerDay: 40_000, startCashCc: 60_000, loyaltyBps: 4_000, concessionBps: 2_500, gougeTolerance: 2 },
];

export const CUSTOMER_RULES = {
  /** At a settlement where cash < fixed daily cost the business is "struggling". */
  closureLowCashSettlements: 2, // two consecutive struggling settlements => closed
  reopenAfterDaysClosed: 1,
  reopenMinActivityBps: 9_000,
  reopenCapitalMultiple: 1, // district pool must fund 1 day of fixed costs
  /** Outside shoppers spend an extra 5% at district stalls which funds the district reinvestment pool. */
  districtPoolShareBps: 500,
  activityMinBps: 7_000,
  activityMaxBps: 13_000,
  maxCounters: 2,
  /** Customers accept a price up to this share of break-even (plus loyalty bonus). */
  baseAcceptBps: 7_500,
  loyaltyAcceptBonusBps: 2_500,
} as const;

export interface MerchantConfig {
  merchantId: string;
  name: string;
  style: string;
  policyId: "efficient_wholesaler" | "low_stock_boutique" | "reserve_cooperative";
  startStockMl: number;
  targetStockMl: number;
  reserveFloorMl: number;
  startCashCc: number;
  operatingReserveCc: number;
  upstreamCapacityMlPerDay: number;
  leadTimeDays: number;
  overheadCcPerDay: number;
  baselineSalesMl: number;
}

export const MERCHANTS: MerchantConfig[] = [
  { merchantId: "ember", name: "Ember Wholesale", style: "Efficient wholesaler: big tanks, thin margins, slow to react.", policyId: "efficient_wholesaler", startStockMl: 150_000, targetStockMl: 200_000, reserveFloorMl: 0, startCashCc: 120_000, operatingReserveCc: 20_000, upstreamCapacityMlPerDay: 120_000, leadTimeDays: 1, overheadCcPerDay: 3_000, baselineSalesMl: 25_000 },
  { merchantId: "lantern", name: "Lantern Corner Fuel", style: "Low-stock boutique: cheap when stocked, jumpy when it runs low.", policyId: "low_stock_boutique", startStockMl: 30_000, targetStockMl: 30_000, reserveFloorMl: 0, startCashCc: 30_000, operatingReserveCc: 5_000, upstreamCapacityMlPerDay: 25_000, leadTimeDays: 1, overheadCcPerDay: 1_500, baselineSalesMl: 10_000 },
  { merchantId: "harbor", name: "Harbor Fuel Co-op", style: "Reserve-focused co-op: keeps a safety reserve and rations on rising oil.", policyId: "reserve_cooperative", startStockMl: 200_000, targetStockMl: 200_000, reserveFloorMl: 120_000, startCashCc: 80_000, operatingReserveCc: 15_000, upstreamCapacityMlPerDay: 80_000, leadTimeDays: 1, overheadCcPerDay: 2_000, baselineSalesMl: 15_000 },
];

export const RIVAL = {
  rivalId: "voltline",
  name: "VoltLine Power Co.",
  ratedW: 8_000,
  startFuelMl: 30_000,
  tankCapacityMl: 80_000,
  startPermits: 8,
  startCashCc: 150_000,
  baseMarginBps: 3_500,
  minMarginBps: 1_000,
  maxMarginBps: 6_000,
  maintenanceCcPerKwh: 50,
  minTariffCcPerKwh: 500,
  maxTariffCcPerKwh: 2_000,
  targetFuelDays: 2,
  estFuelMlPerDay: 12_000,
  buyAtMorningTick: 30, // the rival shops 30 s into the morning market
  activeFromDay: 2,
} as const;

export const REGULATOR = {
  basePermitPriceCc: 2_500, // 25 credits per 10 kg permit
  minPriceBps: 6_000,
  maxPriceBps: 25_000,
  /** Daily permit supply (cap). Day 3 cap cut at dawn. Index = day-1, last value repeats. */
  dailyCapPermits: [8, 8, 6, 6, 5, 5, 4],
  priceSensitivityBps: 5_000,
} as const;

export const UPGRADES: { upgradeId: UpgradeId; name: string; costCc: number; description: string }[] = [
  { upgradeId: "solar_2kw", name: "2 kW Rooftop Solar", costCc: 90_000, description: "Produces up to 2 kW in daylight. It uses no diesel or CO₂ allowance, and its output follows the sun." },
  { upgradeId: "battery_10kwh", name: "10 kWh Battery", costCc: 70_000, description: "Stores surplus solar at up to 2.5 kW with 90% round-trip efficiency, then helps cover solar contracts after dark." },
  { upgradeId: "diesel_5kw", name: "Second 5 kW Diesel Set", costCc: 120_000, description: "Adds 5 kW of diesel capacity, bringing your diesel fleet to 10 kW and meeting Hospital Row’s capacity requirement." },
];

export interface ScenarioConfig {
  scenarioId: "starter" | "fuel_squeeze" | "oil_shock_2026";
  name: string;
  description: string;
  /** Oil index per game day, x100 (10000 = reference 100.00). */
  oilSeriesCenti: number[];
  oilSourceLabel: string;
}

export const REFERENCE_OIL_CENTI = 10_000;
export const BASE_REFERENCE_CC_PER_L = 1_000; // 10 credits / L at reference oil

/**
 * Observed oil -> simulated diesel import cost. Crude is only part of a litre of diesel's
 * cost (refining, transport, margins), so only OIL_PASS_THROUGH of the relative crude move
 * reaches the merchants' import cost:
 *   index = 100 x (1 + passThrough x (brent / referenceBrent - 1))
 * Merchant retail prices then add their own stock/demand/markup policy on top.
 */
export const OIL_PASS_THROUGH_BPS = 5_000;
export const BRENT_DATASET = brent as {
  series: string;
  source: string;
  sourceUrl: string;
  retrieved: string;
  aggregation: string;
  weekly2026: { weekStart: string; usdPerBarrel: number }[];
};
const brentRef = BRENT_DATASET.weekly2026[0].usdPerBarrel;
export const brentToIndexCenti = (usd: number, refUsd = brentRef): number =>
  Math.round(10_000 + (OIL_PASS_THROUGH_BPS * ((usd - refUsd) / refUsd) * 10_000) / 10_000);

export const SCENARIOS: Record<string, ScenarioConfig> = {
  oil_shock_2026: {
    scenarioId: "oil_shock_2026",
    name: "Brent 2026 Replay",
    description: "Each game day follows one observed week of 2026 Brent crude (weekly mean, EIA via FRED). Half of each crude move reaches simulated diesel import cost. The series repeats after week 45.",
    oilSeriesCenti: BRENT_DATASET.weekly2026.map((w) => brentToIndexCenti(w.usdPerBarrel)),
    oilSourceLabel: `Historical Brent (${BRENT_DATASET.source}), weekly mean, cached ${BRENT_DATASET.retrieved}`,
  },
  starter: {
    scenarioId: "starter",
    name: "Starter District",
    description: "Market Quarter, gentle oil rise then easing. 3-day campaign.",
    oilSeriesCenti: [10_000, 10_350, 10_900, 11_200, 10_800, 10_300, 9_900],
    oilSourceLabel: "Illustrative sample series; not observed Brent data",
  },
  fuel_squeeze: {
    scenarioId: "fuel_squeeze",
    name: "Fuel Squeeze",
    description: "Oil index climbs 38% by day 4 then partially recovers. Only the external input changes; sellers react via policy.",
    oilSeriesCenti: [10_000, 11_000, 12_400, 13_800, 13_100, 12_000, 11_200],
    oilSourceLabel: "Illustrative supply-squeeze scenario; not observed Brent data",
  },
};

/** Continuous play: the series loops; short illustrative series hold their last value. */
export const oilForDay = (scenario: ScenarioConfig, day: number): number =>
  scenario.scenarioId === "oil_shock_2026"
    ? scenario.oilSeriesCenti[(day - 1) % scenario.oilSeriesCenti.length]
    : scenario.oilSeriesCenti[Math.min(day - 1, scenario.oilSeriesCenti.length - 1)];

/** Which observed week a game day maps to (for the HUD ticker), or null for illustrative scenarios. */
export const brentWeekForDay = (scenarioId: string, day: number) =>
  scenarioId === "oil_shock_2026" ? BRENT_DATASET.weekly2026[(day - 1) % BRENT_DATASET.weekly2026.length] : null;
