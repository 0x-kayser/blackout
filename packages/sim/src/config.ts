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
  /** Legacy capacity requirement (kept 0: districts now open by company stage). */
  unlockRequirementW: number;
  /** Cost to build the district's substation (level 1) and connect its feeder. */
  unlockCostCc: number;
  /** Company stage needed before the district can be connected. */
  requiredStage: number;
  /** Feeder capacity at substation level 1, 2, 3 (W). */
  feederCapacityW: [number, number, number];
  /** Cost to upgrade the substation to level 2 and 3. */
  substationUpgradeCc: [number, number];
  /** Line loss on this feeder: extra diesel burned per kWh delivered (bps). */
  lossBps: number;
  outsideDemandCcPerHour: number;
  payBehaviour: "haggle" | "fixed_low" | "price_sensitive" | "low";
}

export const DISTRICTS: DistrictConfig[] = [
  { districtId: "market_quarter", name: "Market Quarter", unlockedAtStart: true, unlockRequirementW: 0, unlockCostCc: 0, requiredStage: 1, feederCapacityW: [6_000, 12_000, 24_000], substationUpgradeCc: [40_000, 100_000], lossBps: 0, outsideDemandCcPerHour: 21_600, payBehaviour: "haggle" },
  { districtId: "riverside", name: "Riverside Homes", unlockedAtStart: false, unlockRequirementW: 0, unlockCostCc: 25_000, requiredStage: 2, feederCapacityW: [7_000, 14_000, 28_000], substationUpgradeCc: [45_000, 110_000], lossBps: 350, outsideDemandCcPerHour: 29_200, payBehaviour: "low" },
  { districtId: "hospital_row", name: "Hospital Row", unlockedAtStart: false, unlockRequirementW: 0, unlockCostCc: 30_000, requiredStage: 3, feederCapacityW: [8_000, 16_000, 32_000], substationUpgradeCc: [50_000, 120_000], lossBps: 500, outsideDemandCcPerHour: 50_000, payBehaviour: "fixed_low" },
  { districtId: "tech_hub", name: "Tech Hub", unlockedAtStart: false, unlockRequirementW: 0, unlockCostCc: 50_000, requiredStage: 3, feederCapacityW: [10_000, 20_000, 40_000], substationUpgradeCc: [70_000, 160_000], lossBps: 500, outsideDemandCcPerHour: 63_100, payBehaviour: "price_sensitive" },
  { districtId: "port_district", name: "Port District", unlockedAtStart: false, unlockRequirementW: 0, unlockCostCc: 120_000, requiredStage: 3, feederCapacityW: [14_000, 28_000, 56_000], substationUpgradeCc: [150_000, 320_000], lossBps: 700, outsideDemandCcPerHour: 67_800, payBehaviour: "haggle" },
  { districtId: "industrial_park", name: "Industrial Park", unlockedAtStart: false, unlockRequirementW: 0, unlockCostCc: 250_000, requiredStage: 4, feederCapacityW: [22_000, 44_000, 88_000], substationUpgradeCc: [300_000, 600_000], lossBps: 900, outsideDemandCcPerHour: 82_100, payBehaviour: "haggle" },
  { districtId: "downtown", name: "Downtown", unlockedAtStart: false, unlockRequirementW: 0, unlockCostCc: 350_000, requiredStage: 4, feederCapacityW: [26_000, 52_000, 104_000], substationUpgradeCc: [400_000, 800_000], lossBps: 600, outsideDemandCcPerHour: 86_600, payBehaviour: "price_sensitive" },
];

/** Company stages: how the business grows (replaces counting days). Each needs lifetime energy delivered and districts connected. */
export const STAGES = [
  { stage: 1, name: "Street Generator", needWh: 0, needDistricts: 1, needCapacityW: 0, rewardCc: 0, unlocks: "Sell power to the Market Quarter." },
  { stage: 2, name: "Neighbourhood Utility", needWh: 25_000, needDistricts: 1, needCapacityW: 0, rewardCc: 10_000, unlocks: "Riverside Homes, a fuel terminal and batteries. VoltLine starts competing and Code Red calls begin." },
  { stage: 3, name: "District Utility", needWh: 150_000, needDistricts: 2, needCapacityW: 10_000, rewardCc: 30_000, unlocks: "Hospital Row, Tech Hub, the Port District, a 20 kW diesel plant and a grid battery." },
  { stage: 4, name: "City Utility", needWh: 600_000, needDistricts: 4, needCapacityW: 30_000, rewardCc: 80_000, unlocks: "Industrial Park, Downtown and a 10 kW solar farm." },
  { stage: 5, name: "Grid Operator", needWh: 2_000_000, needDistricts: 7, needCapacityW: 60_000, rewardCc: 200_000, unlocks: "The whole city runs on your grid." },
] as const;

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
  // Riverside Homes: homes and a school; modest loads, tight budgets.
  ...bigCity("riverside", [
    ["riverside_flats", "Riverside Flats", "apartments", 2_000, 4_000, 3_000],
    ["garden_school", "Garden Street School", "school", 2_500, 5_500, 3_500],
    ["laundromat", "Suds Laundromat", "laundry", 1_500, 5_000, 3_000],
  ]),
  // Port District: cold chain and workshops; big steady loads.
  ...bigCity("port_district", [
    ["cold_chain", "Harbour Cold Chain", "warehouse", 5_000, 5_000, 3_500],
    ["shipyard", "Dry Dock Workshop", "workshop", 4_000, 5_000, 3_000],
    ["fish_market", "Dawn Fish Market", "fish_market", 2_500, 5_500, 3_500],
  ]),
  // Industrial Park: factories that run all day.
  ...bigCity("industrial_park", [
    ["textile_mill", "Loomline Textiles", "factory", 8_000, 5_000, 2_500],
    ["recycler", "ReForm Recycling", "recycling", 6_000, 5_000, 3_000],
    ["bottling", "Clearwater Bottling", "factory", 5_000, 5_000, 3_000],
  ]),
  // Downtown: towers, a mall and the arena; they pay well and walk away from gougers.
  ...bigCity("downtown", [
    ["office_tower", "Meridian Tower", "offices", 7_000, 4_500, 2_500, { gouge: 3 }],
    ["mall", "Vesper Mall", "mall", 6_000, 5_000, 2_500, { gouge: 3 }],
    ["arena", "Vesper Arena", "arena", 10_000, 4_500, 2_000, { gouge: 3 }],
    ["city_hall", "Vesper City Hall", "civic", 4_000, 5_500, 1_500, { gouge: 3 }],
    ["grand_hotel", "The Grand Hotel", "hotel", 6_000, 5_000, 2_500, { gouge: 3 }],
    ["cinema", "Starlight Cinemas", "cinema", 3_500, 4_500, 3_000, { gouge: 3 }],
    ["skyline_apts", "Skyline Apartments", "apartments", 5_000, 5_000, 2_500, { gouge: 3 }],
  ]),
  // More of the city: every block has something that needs power.
  ...bigCity("market_quarter", [
    ["tailor", "Stitch & Sons Tailors", "tailor", 700, 5_000, 3_500],
    ["phone_repair", "FixIt Phone Repair", "repair", 500, 4_500, 3_500],
    ["barber", "Sharp Cuts Barbers", "barber", 600, 5_500, 3_500],
  ]),
  ...bigCity("riverside", [
    ["hillview_apts", "Hillview Apartments", "apartments", 2_500, 4_500, 3_000],
    ["freshmart", "FreshMart Grocery", "grocery", 1_800, 5_000, 3_500],
    ["library", "Riverside Library", "library", 1_200, 6_000, 2_000],
    ["daycare", "Little Stars Daycare", "daycare", 1_000, 5_500, 3_000],
  ]),
  ...bigCity("hospital_row", [
    ["dialysis", "Riverbend Dialysis Centre", "clinic", 3_500, 5_000, 0, { fixedTariffCcPerKwh: 700 }],
    ["med_supply", "MedSupply Depot", "warehouse", 2_000, 5_000, 0, { fixedTariffCcPerKwh: 700 }],
    ["ambulance", "Ambulance Station 3", "emergency", 1_500, 6_000, 0, { fixedTariffCcPerKwh: 700 }],
  ]),
  ...bigCity("tech_hub", [
    ["data_vault", "DataVault Colocation", "data_centre", 6_000, 4_000, 2_500, { gouge: 2 }],
    ["gamer_arena", "Respawn Gaming Lounge", "gaming", 2_500, 4_000, 3_000, { gouge: 2 }],
    ["startup_garage", "Garage 42 Startups", "startup", 1_500, 4_500, 3_000, { gouge: 2 }],
  ]),
  ...bigCity("port_district", [
    ["container_terminal", "Vesper Container Terminal", "terminal", 7_000, 5_000, 2_500],
    ["ice_plant", "Polar Ice Plant", "ice_plant", 4_000, 5_000, 3_000],
    ["cannery", "Bluewave Seafood Cannery", "cannery", 3_500, 5_000, 3_000],
  ]),
  ...bigCity("industrial_park", [
    ["steelworks", "Anvil Steel Fabricators", "steel", 10_000, 4_500, 2_000],
    ["bread_factory", "Golden Crust Bread Factory", "factory", 6_000, 5_000, 2_500],
    ["paint_works", "Chroma Paint Works", "factory", 4_000, 5_000, 3_000],
  ]),
];

/** The people behind every building: shown on calls, in the inspector and in the People panel. */
export const OWNERS: Record<string, { name: string; face: string; trait: string }> = {
  cold_room: { name: "Tunde", face: "🧔🏾", trait: "owns the Cold Room and its very nervous freezers" },
  bakery: { name: "Rosa", face: "👩🏽‍🍳", trait: "bakes before dawn and hates cold ovens" },
  pharmacy: { name: "Dr. Imani", face: "👩🏾‍⚕️", trait: "keeps vaccines cold at the Corner Pharmacy" },
  cyber_cafe: { name: "Kai", face: "🧑🏻‍💻", trait: "runs the cyber café and hates downtime" },
  corner_shop: { name: "Mama Ade", face: "👵🏿", trait: "runs the corner shop and lent you the generator shed" },
  tailor: { name: "Femi", face: "🧵", trait: "stitches wedding suits to deadlines" },
  phone_repair: { name: "Jin", face: "🔧", trait: "fixes every phone on the block" },
  barber: { name: "Marcus", face: "💈", trait: "knows every rumour in town" },
  riverside_flats: { name: "Aunty Grace", face: "👩🏾‍🦳", trait: "chairs the Riverside tenants' association" },
  garden_school: { name: "Mr. Danjuma", face: "👨🏾‍🏫", trait: "headteacher with exams next week" },
  laundromat: { name: "Lucia", face: "🧺", trait: "runs machines from dawn to midnight" },
  hillview_apts: { name: "Kwame", face: "🧑🏿", trait: "manages 40 flats and 40 complaints" },
  freshmart: { name: "Hassan", face: "🛒", trait: "watches every fridge like a hawk" },
  library: { name: "Ms. Ruth", face: "📚", trait: "keeps the reading room open for students" },
  daycare: { name: "Ngozi", face: "🧸", trait: "has 30 toddlers and zero patience for blackouts" },
  night_clinic: { name: "Nurse Bello", face: "🧑🏾‍⚕️", trait: "runs the night shift on a fixed budget" },
  medical_lab: { name: "Dr. Okafor", face: "👨🏿‍🔬", trait: "runs samples that cannot warm up" },
  dialysis: { name: "Dr. Mensah", face: "🩺", trait: "keeps patients on machines for four hours at a time" },
  med_supply: { name: "Bisi", face: "📦", trait: "stores the city's insulin" },
  ambulance: { name: "Chief Eze", face: "🚑", trait: "needs the radios on, always" },
  cowork: { name: "Priya", face: "👩🏽‍💼", trait: "fills desks with startups that leave if you gouge" },
  server_closet: { name: "Sam", face: "🧑🏼‍🔧", trait: "babysits racks that hate heat" },
  data_vault: { name: "Ada", face: "🖥", trait: "sells uptime by the minute" },
  gamer_arena: { name: "Zee", face: "🎮", trait: "runs tournaments that cannot pause" },
  startup_garage: { name: "Tobi", face: "🚀", trait: "is one pitch away from a big order" },
  cold_chain: { name: "Captain Ama", face: "🧑🏾‍✈️", trait: "moves frozen cargo off the ships" },
  shipyard: { name: "Olu", face: "⚓", trait: "welds hulls to tight tides" },
  fish_market: { name: "Mama Nkechi", face: "🐟", trait: "sells the morning catch before noon" },
  container_terminal: { name: "Ms. Varga", face: "🏗", trait: "runs cranes that cost money every idle minute" },
  ice_plant: { name: "Petr", face: "🧊", trait: "makes ice for half the port" },
  cannery: { name: "Rania", face: "🥫", trait: "runs two shifts of seafood packing" },
  textile_mill: { name: "Mr. Adeyemi", face: "🧶", trait: "runs looms that cannot stop mid-bolt" },
  recycler: { name: "Juno", face: "♻️", trait: "turns the city's trash into pellets" },
  bottling: { name: "Elena", face: "💧", trait: "fills 10,000 bottles an hour" },
  steelworks: { name: "Big Joe", face: "🔥", trait: "runs furnaces that eat power" },
  bread_factory: { name: "Mrs. Oyelaran", face: "🍞", trait: "bakes for every shop in Vesper" },
  paint_works: { name: "Theo", face: "🎨", trait: "mixes colours to order" },
  office_tower: { name: "Ms. Sterling", face: "👩🏼‍💼", trait: "manages 30 floors of tenants" },
  mall: { name: "Raj", face: "🛍", trait: "keeps 120 shops cool" },
  arena: { name: "Coach Lamar", face: "🏟", trait: "has a sold-out match tonight" },
  city_hall: { name: "Mayor Adaeze", face: "🏛", trait: "wants the lights on before the election" },
  grand_hotel: { name: "Monsieur Duval", face: "🛎", trait: "will not let guests sweat" },
  cinema: { name: "Dee", face: "🎬", trait: "sells out the late show" },
  skyline_apts: { name: "Victor Chen", face: "🏙", trait: "runs the city's tallest homes" },
};

/** Big-city businesses scale with their load: revenue, costs and cash are per kW. */
function bigCity(districtId: string, rows: [string, string, string, number, number, number, { gouge?: number; fixedTariffCcPerKwh?: number }?][]): BusinessConfig[] {
  return rows.map(([businessId, name, kind, demandW, loyaltyBps, concessionBps, opts]) => {
    const kw = demandW / 1_000;
    return {
      businessId, districtId, name, kind, demandW,
      revenueCcPerPoweredHour: Math.round(kw * 2_700),
      variableCostCcPerPoweredHour: Math.round(kw * 1_150),
      fixedCostCcPerDay: Math.round(kw * 7_000),
      startCashCc: Math.round(kw * 14_000),
      loyaltyBps, concessionBps, gougeTolerance: opts?.gouge ?? 99,
      ...(opts?.fixedTariffCcPerKwh ? { fixedTariffCcPerKwh: opts.fixedTariffCcPerKwh } : {}),
    };
  });
}

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

export const UPGRADES: { upgradeId: UpgradeId; name: string; costCc: number; description: string; requiredStage: number }[] = [
  { upgradeId: "solar_2kw", name: "2 kW Rooftop Solar", costCc: 90_000, requiredStage: 1, description: "Produces up to 2 kW in daylight. It uses no diesel or CO₂ allowance, and its output follows the sun." },
  { upgradeId: "diesel_5kw", name: "Second 5 kW Diesel Set", costCc: 120_000, requiredStage: 1, description: "Adds 5 kW of diesel capacity: 10 kW in all, enough for a second district." },
  { upgradeId: "battery_10kwh", name: "10 kWh Battery", costCc: 70_000, requiredStage: 2, description: "Stores surplus solar at up to 2.5 kW with 90% round-trip efficiency, then helps cover solar contracts after dark." },
  { upgradeId: "tank_200l", name: "Fuel Terminal (+200 L)", costCc: 60_000, requiredStage: 2, description: "Adds 200 L of diesel storage so you can buy ahead of a price spike and run bigger plants through the night." },
  { upgradeId: "diesel_20kw", name: "20 kW Diesel Plant", costCc: 400_000, requiredStage: 3, description: "A containerised power plant: 20 kW of firm capacity for the Port District, hospitals and the Tech Hub." },
  { upgradeId: "battery_50kwh", name: "Grid Battery (+50 kWh)", costCc: 300_000, requiredStage: 3, description: "Adds 50 kWh of storage and 10 kW of charge/discharge to your battery bank: soak up solar, cover the evening peak." },
  { upgradeId: "solar_10kw", name: "10 kW Solar Farm", costCc: 500_000, requiredStage: 4, description: "A field of panels on the edge of town: up to 10 kW in daylight with no fuel and no CO₂." },
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
