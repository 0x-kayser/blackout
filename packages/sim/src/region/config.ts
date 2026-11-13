/**
 * The Vesper region: every number the regional power game runs on. Engine units (see shared/region.ts):
 * kW, cc (1 credit = 100 cc), cc per MWh, gas in milli-MMBtu, diesel in mL. One interval = 5 game minutes.
 */
import type { FuelId, NodeId, TechId, WorldSnapshot } from "@blackout/shared";

export const INTERVALS_PER_DAY = 288;
export const MINUTES_PER_INTERVAL = 5;
/** The session opens at 18:30 on day 1: dusk, lights coming on, the evening peak building. */
export const START_MINUTE = 18 * 60 + 30;
export const EPOCH_INTERVALS = 36;
export const HISTORY_LEN = 288;
export const CHALLENGE_DAYS = 3;

/** cc per MWh → cc for `kw` over one interval. */
export const intervalCc = (ccPerMWh: number, kw: number): number => Math.round((ccPerMWh * kw) / 12_000);
/** kWh in one interval at `kw`. */
export const intervalKwh = (kw: number): number => kw / 12;

export interface NodeConfig {
  nodeId: NodeId;
  name: string;
  x: number;
  z: number;
  blurb: string;
}

export const NODES: readonly NodeConfig[] = [
  { nodeId: "north_solar", name: "North Solar Belt", x: 0, z: -78, blurb: "Farmland and solar fields. Cheap power at noon, nothing at night, and one line to the city." },
  { nodeId: "central_city", name: "Central City", x: 0, z: 0, blurb: "Shops, offices and flats. The hub every line runs through." },
  { nodeId: "industrial_south", name: "Industrial South", x: -14, z: 62, blurb: "Ivanova Steel and Delta Components. Big, price-sensitive loads." },
  { nodeId: "port", name: "Port", x: -84, z: 70, blurb: "The container port, the cold chain and the harbour power plants." },
  { nodeId: "tech_corridor", name: "Tech Corridor", x: 82, z: -26, blurb: "Halcyon Data Center runs flat out, day and night." },
  { nodeId: "hospital", name: "Hospital District", x: 40, z: 36, blurb: "St. Aurelia General. The last place that may go dark." },
  { nodeId: "residential_east", name: "Residential East", x: 92, z: 44, blurb: "Homes on one thin line. Evening peaks and air-conditioning." },
];
export const REFERENCE_NODE: NodeId = "central_city";

export interface CorridorConfig {
  corridorId: string;
  name: string;
  from: NodeId;
  to: NodeId;
  limitKw: number;
  upgradeKw: number;
  upgradeCc: number;
  upgradeIntervals: number;
}

export const CORRIDORS: readonly CorridorConfig[] = [
  { corridorId: "c_north", name: "North Belt 220 kV", from: "north_solar", to: "central_city", limitKw: 250_000, upgradeKw: 100_000, upgradeCc: 13_000_000, upgradeIntervals: 96 },
  { corridorId: "c_south", name: "Southern Trunk 400 kV", from: "industrial_south", to: "central_city", limitKw: 500_000, upgradeKw: 150_000, upgradeCc: 16_000_000, upgradeIntervals: 96 },
  { corridorId: "c_port", name: "Harbor Line 400 kV", from: "port", to: "industrial_south", limitKw: 450_000, upgradeKw: 150_000, upgradeCc: 14_000_000, upgradeIntervals: 96 },
  { corridorId: "c_tech", name: "Tech Ring 220 kV", from: "tech_corridor", to: "central_city", limitKw: 250_000, upgradeKw: 100_000, upgradeCc: 11_000_000, upgradeIntervals: 84 },
  { corridorId: "c_hosp", name: "Hospital Feeder 132 kV", from: "hospital", to: "central_city", limitKw: 120_000, upgradeKw: 60_000, upgradeCc: 6_000_000, upgradeIntervals: 60 },
  { corridorId: "c_east", name: "Eastside Line 132 kV", from: "residential_east", to: "central_city", limitKw: 120_000, upgradeKw: 100_000, upgradeCc: 9_000_000, upgradeIntervals: 72 },
];

export interface TechConfig {
  tech: TechId;
  name: string;
  fuel: FuelId | null;
  /** gas: MMBtu per MWh; diesel: litres per MWh. */
  heatRate: number;
  vomCcPerMWh: number;
  startIntervals: number;
  rampBps: number;
  minBps: number;
  /** Forced outages per million intervals. */
  forcedPpm: number;
  sizes: { capacityKw: number; energyKwh: number; costCc: number; intervals: number; licence: number }[];
  blurb: string;
}

export const TECHS: Record<TechId, TechConfig> = {
  diesel: {
    tech: "diesel", name: "Diesel peaker", fuel: "diesel", heatRate: 265, vomCcPerMWh: 800, startIntervals: 1, rampBps: 10_000, minBps: 0, forcedPpm: 300,
    sizes: [
      { capacityKw: 20_000, energyKwh: 0, costCc: 3_200_000, intervals: 18, licence: 1 },
      { capacityKw: 40_000, energyKwh: 0, costCc: 6_000_000, intervals: 24, licence: 1 },
    ],
    blurb: "Fast and dear. Starts in five minutes, burns ₡200+ a megawatt-hour of diesel. Built in two game hours.",
  },
  ocgt: {
    tech: "ocgt", name: "Open-cycle gas turbine", fuel: "gas", heatRate: 10.4, vomCcPerMWh: 500, startIntervals: 2, rampBps: 5_000, minBps: 2_000, forcedPpm: 220,
    sizes: [
      { capacityKw: 60_000, energyKwh: 0, costCc: 15_000_000, intervals: 48, licence: 1 },
      { capacityKw: 120_000, energyKwh: 0, costCc: 28_000_000, intervals: 60, licence: 2 },
    ],
    blurb: "The workhorse peaker: ten-minute start, mid-cost gas. Sets the price on most evenings.",
  },
  ccgt: {
    tech: "ccgt", name: "Combined-cycle gas", fuel: "gas", heatRate: 6.9, vomCcPerMWh: 300, startIntervals: 12, rampBps: 1_500, minBps: 4_000, forcedPpm: 180,
    sizes: [
      { capacityKw: 250_000, energyKwh: 0, costCc: 92_000_000, intervals: 150, licence: 2 },
      { capacityKw: 400_000, energyKwh: 0, costCc: 140_000_000, intervals: 180, licence: 3 },
    ],
    blurb: "Cheapest gas power, but slow: an hour to start and 40% minimum load. Wins on fuel, loses money committed at noon.",
  },
  solar: {
    tech: "solar", name: "Solar farm", fuel: null, heatRate: 0, vomCcPerMWh: 0, startIntervals: 0, rampBps: 10_000, minBps: 0, forcedPpm: 20,
    sizes: [
      { capacityKw: 50_000, energyKwh: 0, costCc: 9_000_000, intervals: 60, licence: 1 },
      { capacityKw: 100_000, energyKwh: 0, costCc: 17_000_000, intervals: 72, licence: 1 },
      { capacityKw: 200_000, energyKwh: 0, costCc: 32_000_000, intervals: 96, licence: 2 },
    ],
    blurb: "Free fuel when the sun is up, nothing at night, less under cloud. Floods the noon market.",
  },
  battery: {
    tech: "battery", name: "Battery storage", fuel: null, heatRate: 0, vomCcPerMWh: 100, startIntervals: 0, rampBps: 10_000, minBps: 0, forcedPpm: 30,
    sizes: [
      { capacityKw: 50_000, energyKwh: 100_000, costCc: 11_500_000, intervals: 36, licence: 1 },
      { capacityKw: 100_000, energyKwh: 200_000, costCc: 22_000_000, intervals: 42, licence: 1 },
      { capacityKw: 200_000, energyKwh: 400_000, costCc: 42_000_000, intervals: 54, licence: 3 },
    ],
    blurb: "Buys power cheap, sells it at the peak. 88% round trip, wears a little every cycle.",
  },
};

export const BATTERY_EFF_BPS = 9_380; // per direction: 0.938² ≈ 88% round trip
export const BATTERY_WEAR_BPS_PER_CYCLE = 5;
export const GAS_KG_CO2_PER_MMBTU = 53.1;
export const DIESEL_KG_CO2_PER_L = 2.68;
export const FIXED_OM_CC_PER_KW_DAY = 8;

export interface OwnerConfig {
  ownerId: string;
  name: string;
  person: string;
  face: string;
  cashCc: number;
  /** Offer markup over marginal cost (bps). VoltLine adapts its own. */
  markupBps: number;
}

export const OWNERS: readonly OwnerConfig[] = [
  { ownerId: "voltline", name: "VoltLine Energy", person: "Victor Lane", face: "🧑🏼‍💼", cashCc: 90_000_000, markupBps: 1_500 },
  { ownerId: "northwind", name: "Northwind Co-op", person: "Hanna Lindqvist", face: "👩🏼‍🌾", cashCc: 8_000_000, markupBps: 0 },
  { ownerId: "eastbank", name: "Eastbank Energy", person: "Omar Haddad", face: "👨🏽‍💼", cashCc: 12_000_000, markupBps: 1_000 },
  { ownerId: "harbor_diesel", name: "Harbor Diesel Peakers", person: "Gus Moreau", face: "👨🏻‍🔧", cashCc: 5_000_000, markupBps: 1_500 },
];

export interface PlantConfig {
  plantId: string;
  name: string;
  tech: TechId;
  nodeId: NodeId;
  ownerId: string;
  capacityKw: number;
  energyKwh?: number;
  online: boolean;
  socBps?: number;
  forcedPpm?: number;
  healthBps?: number;
}

export const FLEET: readonly PlantConfig[] = [
  { plantId: "kestrel", name: "Kestrel Peaker", tech: "ocgt", nodeId: "industrial_south", ownerId: "player", capacityKw: 120_000, online: false },
  { plantId: "eastside", name: "Eastside Battery", tech: "battery", nodeId: "residential_east", ownerId: "player", capacityKw: 80_000, energyKwh: 160_000, online: true, socBps: 8_000 },
  { plantId: "harbor_ccgt", name: "Harbor CCGT", tech: "ccgt", nodeId: "port", ownerId: "voltline", capacityKw: 420_000, online: true },
  { plantId: "southgate", name: "Southgate CCGT", tech: "ccgt", nodeId: "industrial_south", ownerId: "voltline", capacityKw: 260_000, online: true, forcedPpm: 600, healthBps: 8_600 },
  { plantId: "ridge", name: "Ridge OCGT", tech: "ocgt", nodeId: "tech_corridor", ownerId: "voltline", capacityKw: 140_000, online: true },
  { plantId: "cityline", name: "Cityline OCGT", tech: "ocgt", nodeId: "central_city", ownerId: "voltline", capacityKw: 130_000, online: true },
  { plantId: "volt_solar", name: "VoltLine Solar Belt", tech: "solar", nodeId: "north_solar", ownerId: "voltline", capacityKw: 180_000, online: true },
  { plantId: "northwind", name: "Northwind Co-op Solar", tech: "solar", nodeId: "north_solar", ownerId: "northwind", capacityKw: 150_000, online: true },
  { plantId: "eastbank", name: "Eastbank Gas Engines", tech: "ocgt", nodeId: "residential_east", ownerId: "eastbank", capacityKw: 140_000, online: true },
  { plantId: "harbor_diesel", name: "Harbor Diesel Peakers", tech: "diesel", nodeId: "port", ownerId: "harbor_diesel", capacityKw: 80_000, online: true },
];

export type ActorKind = "industry" | "commerce" | "datacenter" | "port" | "hospital" | "households" | "farms";
export type Profile = "industry" | "commerce" | "flat" | "residential" | "farm" | "hospital";

export interface ActorConfig {
  actorId: string;
  name: string;
  kind: ActorKind;
  nodeId: NodeId;
  person: string;
  face: string;
  role: string;
  baseKw: number;
  /** Share of load that steps back when power costs more than it earns (bps). */
  flexBps: number;
  /** What the essential part is worth to them, cc/MWh (blackout cost). */
  essentialWtp: number;
  /** What the flexible part earns, cc/MWh: above this price they curtail. */
  flexWtp: number;
  /** Revenue per MWh consumed at full production (cc/MWh). */
  valuePerMWh: number;
  fixedCcPerInterval: number;
  employees: number;
  cashCc: number;
  debtCc: number;
  profile: Profile;
  priority: "critical" | "essential" | "industrial" | "commercial" | "residential";
}

export const ACTORS: readonly ActorConfig[] = [
  { actorId: "steel", name: "Ivanova Steel Works", kind: "industry", nodeId: "industrial_south", person: "Marta Ivanova", face: "👩🏻‍🏭", role: "owner, Ivanova Steel", baseKw: 180_000, flexBps: 7_500, essentialWtp: 180_000, flexWtp: 17_000, valuePerMWh: 24_000, fixedCcPerInterval: 220_000, employees: 2_400, cashCc: 60_000_000, debtCc: 40_000_000, profile: "industry", priority: "industrial" },
  { actorId: "delta", name: "Delta Components", kind: "industry", nodeId: "industrial_south", person: "Kofi Mensah", face: "👨🏿‍🔧", role: "plant manager, Delta", baseKw: 90_000, flexBps: 4_000, essentialWtp: 250_000, flexWtp: 30_000, valuePerMWh: 46_000, fixedCcPerInterval: 250_000, employees: 1_800, cashCc: 35_000_000, debtCc: 10_000_000, profile: "industry", priority: "industrial" },
  { actorId: "port", name: "Vesper Container Port", kind: "port", nodeId: "port", person: "Rosa Delgado", face: "👩🏽‍✈️", role: "harbour master", baseKw: 70_000, flexBps: 2_000, essentialWtp: 300_000, flexWtp: 60_000, valuePerMWh: 90_000, fixedCcPerInterval: 420_000, employees: 1_500, cashCc: 40_000_000, debtCc: 15_000_000, profile: "flat", priority: "essential" },
  { actorId: "coldchain", name: "Harbor Cold Chain", kind: "commerce", nodeId: "port", person: "Sven Aalto", face: "🧔🏼", role: "cold-store operator", baseKw: 40_000, flexBps: 1_000, essentialWtp: 220_000, flexWtp: 35_000, valuePerMWh: 60_000, fixedCcPerInterval: 150_000, employees: 400, cashCc: 12_000_000, debtCc: 4_000_000, profile: "flat", priority: "essential" },
  { actorId: "datacenter", name: "Halcyon Data Center", kind: "datacenter", nodeId: "tech_corridor", person: "Priya Raman", face: "👩🏾‍💻", role: "site director, Halcyon", baseKw: 160_000, flexBps: 800, essentialWtp: 600_000, flexWtp: 50_000, valuePerMWh: 160_000, fixedCcPerInterval: 1_850_000, employees: 300, cashCc: 150_000_000, debtCc: 80_000_000, profile: "flat", priority: "essential" },
  { actorId: "campuses", name: "Tech Corridor Campuses", kind: "commerce", nodeId: "tech_corridor", person: "Leo Park", face: "👨🏻‍💼", role: "campus facilities lead", baseKw: 60_000, flexBps: 2_500, essentialWtp: 250_000, flexWtp: 25_000, valuePerMWh: 70_000, fixedCcPerInterval: 170_000, employees: 5_200, cashCc: 25_000_000, debtCc: 5_000_000, profile: "commerce", priority: "commercial" },
  { actorId: "commerce", name: "Central City Commerce", kind: "commerce", nodeId: "central_city", person: "Amara Obi", face: "👩🏿‍💼", role: "chair, Chamber of Commerce", baseKw: 220_000, flexBps: 2_000, essentialWtp: 300_000, flexWtp: 30_000, valuePerMWh: 50_000, fixedCcPerInterval: 430_000, employees: 14_000, cashCc: 70_000_000, debtCc: 20_000_000, profile: "commerce", priority: "commercial" },
  { actorId: "central_homes", name: "Central City Households", kind: "households", nodeId: "central_city", person: "Maureen Halloran", face: "👵🏻", role: "tenant association", baseKw: 140_000, flexBps: 2_000, essentialWtp: 250_000, flexWtp: 35_000, valuePerMWh: 0, fixedCcPerInterval: 0, employees: 0, cashCc: 30_000_000, debtCc: 0, profile: "residential", priority: "residential" },
  { actorId: "hospital", name: "St. Aurelia General Hospital", kind: "hospital", nodeId: "hospital", person: "Dr. Nadia Petrov", face: "👩🏻‍⚕️", role: "chief of medicine", baseKw: 45_000, flexBps: 0, essentialWtp: 2_000_000, flexWtp: 0, valuePerMWh: 400_000, fixedCcPerInterval: 1_200_000, employees: 2_100, cashCc: 40_000_000, debtCc: 0, profile: "hospital", priority: "critical" },
  { actorId: "hosp_homes", name: "Hospital District Homes", kind: "households", nodeId: "hospital", person: "Dr. Samuel Achebe", face: "👨🏾‍⚕️", role: "GP and resident", baseKw: 35_000, flexBps: 1_500, essentialWtp: 260_000, flexWtp: 35_000, valuePerMWh: 0, fixedCcPerInterval: 0, employees: 0, cashCc: 8_000_000, debtCc: 0, profile: "residential", priority: "residential" },
  { actorId: "res_east", name: "Residential East Households", kind: "households", nodeId: "residential_east", person: "Tomás Rivera", face: "👨🏽", role: "neighbourhood association", baseKw: 230_000, flexBps: 2_000, essentialWtp: 250_000, flexWtp: 35_000, valuePerMWh: 0, fixedCcPerInterval: 0, employees: 0, cashCc: 45_000_000, debtCc: 0, profile: "residential", priority: "residential" },
  { actorId: "farms", name: "North Belt Farms & Towns", kind: "farms", nodeId: "north_solar", person: "Joe Whitaker", face: "👨🏼‍🌾", role: "farmer and mayor", baseKw: 40_000, flexBps: 3_000, essentialWtp: 200_000, flexWtp: 20_000, valuePerMWh: 40_000, fixedCcPerInterval: 65_000, employees: 900, cashCc: 10_000_000, debtCc: 3_000_000, profile: "farm", priority: "residential" },
];

/** How businesses' wages reach households (bps of the wage bill per household actor; the rest leaves the region). */
export const WAGE_SPLIT: Record<string, number> = { res_east: 4_500, central_homes: 3_500, hosp_homes: 1_000 };
export const WAGE_SHARE_BPS = 6_000;
/** Households spend this share of income in Central City Commerce and the Tech Corridor campuses. */
export const HOUSEHOLD_SPEND: Record<string, number> = { commerce: 4_000, campuses: 1_000 };

export interface SupplierConfig {
  supplierId: string;
  name: string;
  person: string;
  face: string;
  fuel: FuelId;
  /** Units: milli-MMBtu or mL. */
  capacity: number;
  stockBps: number;
  importPerInterval: number;
  markupBps: number;
  /** Below this fill the supplier rations (bps of capacity). */
  rationBps: number;
  cashCc: number;
  /** Chain identity (§22). */
  chainName: string;
  note: string;
}

export const SUPPLIERS: readonly SupplierConfig[] = [
  { supplierId: "harbor_lng", name: "Harbor LNG Terminal", person: "Ingrid Halvorsen", face: "👩🏼‍✈️", fuel: "gas", capacity: 160_000_000, stockBps: 6_500, importPerInterval: 380_000, markupBps: 900, rationBps: 1_000, cashCc: 60_000_000, chainName: "ingrid", note: "Deep tanks, slow ships, thin margins." },
  { supplierId: "northline", name: "Northline Pipeline", person: "Bayo Northcott", face: "👨🏿‍💼", fuel: "gas", capacity: 40_000_000, stockBps: 6_000, importPerInterval: 300_000, markupBps: 500, rationBps: 2_000, cashCc: 25_000_000, chainName: "bayo", note: "Cheapest gas in the region until the pipe is full. Rations hard." },
  { supplierId: "greenline", name: "Greenline Biomethane Fund", person: "Prof. Lena Brandt", face: "👩🏻‍🏫", fuel: "gas", capacity: 20_000_000, stockBps: 8_000, importPerInterval: 90_000, markupBps: 1_800, rationBps: 1_200, cashCc: 20_000_000, chainName: "lena", note: "Steady and a little dearer. Never squeezes a buyer." },
  { supplierId: "kettle", name: "Kettle Fuels", person: "Old Man Kettle", face: "👴🏻", fuel: "diesel", capacity: 900_000_000, stockBps: 6_000, importPerInterval: 2_200_000, markupBps: 2_200, rationBps: 1_500, cashCc: 15_000_000, chainName: "kettle", note: "Buys cheap, sells dear, always has some." },
  { supplierId: "swift", name: "Swift Tankers", person: "Dayo Swift", face: "🧑🏾‍✈️", fuel: "diesel", capacity: 500_000_000, stockBps: 5_000, importPerInterval: 3_500_000, markupBps: 1_200, rationBps: 1_000, cashCc: 12_000_000, chainName: "dayo", note: "Restocks in hours and undercuts everyone." },
  { supplierId: "okafor", name: "Okafor & Daughters", person: "Chioma Okafor", face: "👩🏾‍💼", fuel: "diesel", capacity: 700_000_000, stockBps: 8_000, importPerInterval: 1_200_000, markupBps: 1_000, rationBps: 2_500, cashCc: 18_000_000, chainName: "chioma", note: "Hoards on dips, sells into squeezes." },
];

/** Fixed regional fuel allotment for this saved grid. Later lots are sealed from the start and released on schedule. */
export const REGIONAL_FUEL_ENDOWMENT: Record<FuelId, { total: number; deposits: { day: number; quantity: number; name: string }[] }> = {
  gas: { total: 36_000_000, deposits: [{ day: 0, quantity: 16_200_000, name: "Harbor gas caverns" }, { day: 90, quantity: 7_200_000, name: "Eastern gas seam" }, { day: 210, quantity: 12_600_000, name: "Deep Vesper reserve" }] },
  diesel: { total: 60_000_000, deposits: [{ day: 0, quantity: 27_000_000, name: "Port fuel tanks" }, { day: 90, quantity: 12_000_000, name: "Inland depot" }, { day: 210, quantity: 21_000_000, name: "Strategic diesel stock" }] },
};

export const regionalReserveAvailable = (fuel: FuelId) => `reserve:regional:${fuel}:available`;
export const regionalReserveSealed = (fuel: FuelId, day: number) => `reserve:regional:${fuel}:sealed:${day}`;

export interface BankConfig {
  bankId: string;
  name: string;
  person: string;
  cashCc: number;
  /** Interest per game day, bps. */
  baseRateBps: number;
  /** Highest debt / asset value this bank accepts (bps). */
  maxLeverageBps: number;
  chainName: string;
}

export const BANKS: readonly BankConfig[] = [
  { bankId: "vesper_savings", name: "Vesper Savings Bank", person: "Grace Liu", cashCc: 400_000_000, baseRateBps: 25, maxLeverageBps: 5_000, chainName: "vesper-bank" },
  { bankId: "meridian", name: "Meridian Capital", person: "Felix Okoro", cashCc: 300_000_000, baseRateBps: 45, maxLeverageBps: 7_000, chainName: "meridian" },
];

export const VOLTLINE_DEBT_CC = 1_500_000_000;
export const VOLTLINE_RATE_BPS = 40;
export const GENESIS_TREASURY_CC = 1_000_000_000;
export const STARTER_GRANT_CC = 30_000_000;
export const PRICE_CAP_CC = 500_000;
/** Regulator: offers above this during load shedding are mitigated to 2× marginal cost. */
export const MITIGATION_FLOOR_CC = 100_000;
export const WITHHOLDING_CC_PER_MW_INTERVAL = 2_000;

export interface LicenceConfig {
  level: number;
  name: string;
  needMWh: number;
  needReliabilityBps: number;
}

export const LICENCES: readonly LicenceConfig[] = [
  { level: 1, name: "Independent Generator", needMWh: 0, needReliabilityBps: 0 },
  { level: 2, name: "Regional Producer", needMWh: 3_000, needReliabilityBps: 0 },
  { level: 3, name: "System Partner", needMWh: 15_000, needReliabilityBps: 9_700 },
  { level: 4, name: "Grid Anchor", needMWh: 45_000, needReliabilityBps: 9_800 },
];

/** The weekly challenge always uses this snapshot, so every player faces the same world (§11). */
export const CHALLENGE_SNAPSHOT: WorldSnapshot = {
  source: "fixture",
  capturedAt: "2026-07-14T16:00:00Z",
  gasUsdPerMMBtu: 3.6,
  brentUsdPerBbl: 72,
  carbonUsdPerT: 32,
  tempC: 31,
  cloudPct: 20,
  windKph: 14,
  sources: [{ field: "all", provider: "BLACKOUT weekly challenge fixture", url: "", observedAt: "2026-07-14T16:00:00Z" }],
};

/** Used before any live input has ever been fetched. */
export const DEFAULT_SNAPSHOT: WorldSnapshot = { ...CHALLENGE_SNAPSHOT, source: "fixture", tempC: 27, cloudPct: 35, sources: [{ field: "all", provider: "bundled default", url: "", observedAt: "2026-07-14T16:00:00Z" }] };

/** Building: 60% of a plant's cost is paid in credits, the rest is steel bought in Vesper Market (₡250/t outside). */
export const CREDIT_SHARE_BPS = 6_000;
export const steelForCc = (costCc: number) => Math.round((costCc * 0.4) / 25_000);
export const creditsForCc = (costCc: number) => Math.round((costCc * CREDIT_SHARE_BPS) / 10_000);
/** Turbine kits that repair a tripped plant at once. */
export const PARTS_FOR_REPAIR: Record<TechId, number> = { diesel: 1, ocgt: 2, ccgt: 4, solar: 1, battery: 1 };
/** Without permits the regulator charges this much more for each tonne of CO2. */
export const NO_PERMIT_PENALTY_BPS = 12_500;
/** Market item → region asset and how many region units one market unit is. */
export const TOWN_UNITS = {
  "fuel:natural-gas": { asset: "gas", per: 1000 },
  "fuel:diesel": { asset: "diesel", per: 1000 },
  "permit:carbon": { asset: "permit", per: 1000 },
  "certificate:renewable": { asset: "cert", per: 1000 },
  "material:steel": { asset: "steel", per: 1 },
  "part:turbine": { asset: "parts", per: 1 },
} as const;
