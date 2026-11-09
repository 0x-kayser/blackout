/**
 * BLACKOUT regional power system: the shared contract between the deterministic engine (packages/sim/src/region),
 * the API and the 3D client.
 *
 * Units (all integers inside the engine, so replays are exact):
 *   power kW · energy kWh · money cc (1 credit = 100 cc) · prices cc per MWh · gas milli-MMBtu · diesel mL.
 * One market interval = 5 game minutes = 1 real second while a session is running. 288 intervals = one game day.
 */
import { z } from "zod";

export const NODE_IDS = ["north_solar", "central_city", "industrial_south", "port", "tech_corridor", "hospital", "residential_east"] as const;
export type NodeId = (typeof NODE_IDS)[number];
export const NodeIdSchema = z.enum(NODE_IDS);

export const TECH_IDS = ["ocgt", "ccgt", "diesel", "solar", "battery"] as const;
export type TechId = (typeof TECH_IDS)[number];
export const TechIdSchema = z.enum(TECH_IDS);

export const FUEL_IDS = ["gas", "diesel"] as const;
export type FuelId = (typeof FUEL_IDS)[number];

export const OFFER_STRATEGIES = ["cost", "markup", "scarcity"] as const;
export type OfferStrategy = (typeof OFFER_STRATEGIES)[number];
export const BATTERY_MODES = ["auto", "charge", "discharge", "hold"] as const;
export type BatteryMode = (typeof BATTERY_MODES)[number];

export const PRIORITY_CLASSES = ["critical", "essential", "industrial", "commercial", "residential", "flexible", "storage"] as const;
export type PriorityClass = (typeof PRIORITY_CLASSES)[number];

/* ------------------------------------------------------------------------------------------------ market types */

/** One generator's offer into one interval (§6). MW values may be fractional; the clearing works in exact kW. */
export interface GenerationOffer {
  plantId: string;
  nodeId: string;
  availableMW: number;
  minimumMW: number;
  offerPricePerMWh: number;
  marginalCostPerMWh: number;
  rampMWPerInterval: number;
}

/** One load segment's bid into one interval (§6). */
export interface LoadBid {
  loadId: string;
  nodeId: string;
  requestedMW: number;
  willingnessToPayPerMWh: number;
  priorityClass: PriorityClass;
}

/* -------------------------------------------------------------------------------------------- world inputs (§10) */

export interface WorldSnapshot {
  /** "live" = fetched now, "fallback" = last good live snapshot, "fixture" = bundled (weekly challenge, tests). */
  source: "live" | "fallback" | "fixture";
  capturedAt: string;
  /** Natural gas, USD per MMBtu (Henry Hub style). */
  gasUsdPerMMBtu: number;
  /** Brent crude, USD per barrel; diesel follows it. */
  brentUsdPerBbl: number;
  /** Carbon, USD per tonne CO2. */
  carbonUsdPerT: number;
  /** Weather at the real reference location. */
  tempC: number;
  cloudPct: number;
  windKph: number;
  /** Labels for the Verify / About screen. */
  sources: { field: string; provider: string; url: string; observedAt: string }[];
}

export const WorldSnapshotSchema = z.object({
  source: z.enum(["live", "fallback", "fixture"]),
  capturedAt: z.string().max(40),
  gasUsdPerMMBtu: z.number().min(0.5).max(80),
  brentUsdPerBbl: z.number().min(10).max(300),
  carbonUsdPerT: z.number().min(0).max(400),
  tempC: z.number().min(-40).max(55),
  cloudPct: z.number().min(0).max(100),
  windKph: z.number().min(0).max(250),
  sources: z.array(z.object({ field: z.string().max(40), provider: z.string().max(80), url: z.string().max(300), observedAt: z.string().max(40) })).max(12),
});

/* ------------------------------------------------------------------------------------------------- actions */

const id = () => z.string().min(1).max(80);

export const RegionActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("SET_PLANT_ONLINE"), plantId: id(), online: z.boolean() }),
  z.object({ type: z.literal("SET_OFFER"), plantId: id(), strategy: z.enum(OFFER_STRATEGIES), markupPct: z.number().int().min(0).max(400).optional() }),
  z.object({ type: z.literal("SET_BATTERY_MODE"), plantId: id(), mode: z.enum(BATTERY_MODES) }),
  z.object({ type: z.literal("BUILD_PLANT"), tech: TechIdSchema, nodeId: NodeIdSchema, size: z.number().int().min(0).max(3) }),
  z.object({ type: z.literal("UPGRADE_CORRIDOR"), corridorId: id() }),
  z.object({ type: z.literal("BUY_FUEL"), supplierId: id(), quantity: z.number().int().min(1).max(2_000_000_000) }),
  z.object({ type: z.literal("SET_AUTO_FUEL"), fuel: z.enum(FUEL_IDS), enabled: z.boolean() }),
  z.object({ type: z.literal("TAKE_LOAN"), bankId: id(), amountCc: z.number().int().min(1_000_00).max(5_000_000_00) }),
  z.object({ type: z.literal("REPAY_LOAN"), loanId: id(), amountCc: z.number().int().min(1).max(5_000_000_00) }),
  z.object({ type: z.literal("LIST_PLANT"), plantId: id(), askCc: z.number().int().min(1_000_00).max(50_000_000_00) }),
  z.object({ type: z.literal("CANCEL_LISTING"), plantId: id() }),
  z.object({ type: z.literal("ACCEPT_BID"), plantId: id(), bidId: id() }),
  z.object({ type: z.literal("BUY_LISTED_PLANT"), plantId: id() }),
  z.object({ type: z.literal("REPAIR_PLANT"), plantId: id() }),
  z.object({ type: z.literal("PAUSE") }),
  z.object({ type: z.literal("RESUME") }),
]);
export type RegionAction = z.infer<typeof RegionActionSchema>;

/** Actions only the server records (never accepted from a client). */
export type RegionSystemAction =
  | { type: "WORLD_INPUT"; snapshot: WorldSnapshot }
  /** A trade, investment or dividend in Vesper Market, landing in this region: signed deltas for the player. */
  | { type: "TOWN_SETTLE"; ref: string; reason: string; cc?: number; items?: Partial<Record<import("./town.ts").ItemId, number>>; income?: boolean }
  /** The market's current fuel prices (cc per MMBtu / per litre). */
  | { type: "TOWN_PRICES"; gas: number | null; diesel: number | null }
  /** An NPC company bought `kw` from this player for `intervals`: a firm export load the player's grid must serve. */
  | { type: "POWER_EXPORT"; orderId: string; buyerName: string; kw: number; intervals: number; priceCcPerMWh: number }
  /** The buyer's escrow paid the player for a delivered power order (settled on NEAR, or locally). */
  | { type: "POWER_PAID"; orderId: string; buyerName: string; cc: number };
export type AnyRegionAction = RegionAction | RegionSystemAction;

export const RegionActionEnvelopeSchema = z.object({
  action: RegionActionSchema,
  idempotencyKey: z.string().min(8).max(80),
  expectedVersion: z.number().int().min(0).optional(),
});

export const CreateRegionRequestSchema = z.object({
  mode: z.enum(["live", "challenge"]).default("live"),
});

/* --------------------------------------------------------------------------------------------------- view */

export interface PriceComponent {
  label: string;
  ccPerMWh: number;
}

export interface NodeView {
  nodeId: NodeId;
  name: string;
  /** Map position in world units (x east, z south). */
  x: number;
  z: number;
  demandKw: number;
  servedKw: number;
  /** Demand that customers chose not to buy at this price (demand response). */
  curtailedKw: number;
  /** Demand that wanted power and did not get it: a blackout. */
  shedKw: number;
  priceCcPerMWh: number;
  /** Who set the price here. */
  marginal: { kind: "plant" | "load" | "cap" | "none"; id: string | null; name: string };
  /** System energy + congestion = the price here. */
  decomposition: PriceComponent[];
  /** How the unit that sets the price got to it (fuel, O&M, carbon, markup — or scarcity). Sums to the price. */
  buildUp: PriceComponent[];
  generationKw: number;
  /** Fraction of the last 12 intervals with load shed (0..1). */
  stress: number;
  avgPriceCcPerMWh: number;
  dark: boolean;
}

export interface CorridorView {
  corridorId: string;
  from: NodeId;
  to: NodeId;
  name: string;
  limitKw: number;
  /** Signed: positive = from → to. */
  flowKw: number;
  congested: boolean;
  /** Price difference across the line (to − from). */
  spreadCcPerMWh: number;
  playerKw: number;
  upgrade: { addKw: number; costCc: number; steelT: number; intervals: number; building: number | null };
  rentCcToday: number;
  playerRentCcToday: number;
}

export interface PlantView {
  plantId: string;
  assetNo: number;
  /** p00042 — the Plant Asset token id. */
  assetId: string;
  name: string;
  tech: TechId;
  nodeId: NodeId;
  ownerId: string;
  ownerName: string;
  mine: boolean;
  capacityKw: number;
  outputKw: number;
  /** Positive = discharging; negative = charging (batteries only). */
  netKw: number;
  status: "building" | "offline" | "starting" | "online" | "tripped" | "mothballed";
  buildRemaining: number;
  buildTotal: number;
  startRemaining: number;
  online: boolean;
  strategy: OfferStrategy;
  markupPct: number;
  batteryMode: BatteryMode;
  socKwh: number;
  energyKwh: number;
  healthBps: number;
  cycles: number;
  marginalCostCcPerMWh: number;
  offerCcPerMWh: number;
  costBreakdown: PriceComponent[];
  fuel: FuelId | null;
  fuelIntervalsLeft: number | null;
  /** Owner's fuel is short: the plant can't run at full output. */
  fuelLimited: boolean;
  revenueCcToday: number;
  marginCcToday: number;
  lifetimeMWh: number;
  lifetimeRevenueCc: number;
  bookValueCc: number;
  listing: { askCc: number; bids: { bidId: string; bidder: string; bidderName: string; amountCc: number; reason: string }[] } | null;
  tripReason: string | null;
  /** Turbine kits that repair it now, if tripped. */
  repairParts: number;
  /** Why it is (not) running, one sentence. */
  why: string;
}

export interface ActorView {
  actorId: string;
  name: string;
  kind: "industry" | "commerce" | "datacenter" | "port" | "hospital" | "households" | "farms";
  nodeId: NodeId;
  person: string;
  face: string;
  role: string;
  cashCc: number;
  debtCc: number;
  employees: number;
  baseEmployees: number;
  inventoryDays: number;
  demandKw: number;
  servedKw: number;
  productionBps: number;
  healthBps: number;
  state: "operating" | "strained" | "distressed" | "closed";
  wtpCcPerMWh: number;
  flexCcPerMWh: number;
  energyCostCcToday: number;
  profitCcToday: number;
  quote: string;
}

export interface SupplierView {
  supplierId: string;
  name: string;
  person: string;
  face: string;
  fuel: FuelId;
  stock: number;
  capacity: number;
  priceCcPerUnit: number;
  rationing: boolean;
  importPerInterval: number;
  cashCc: number;
  note: string;
}

export interface BankView {
  bankId: string;
  name: string;
  person: string;
  cashCc: number;
  rateBps: number;
  offerToPlayerCc: number;
  stance: string;
}

export interface LoanView {
  loanId: string;
  bankId: string;
  principalCc: number;
  rateBps: number;
  interestCcPerDay: number;
}

export interface RegionEvent {
  seq: number;
  interval: number;
  type: string;
  severity: "info" | "good" | "warn" | "crisis";
  title: string;
  detail: string;
  nodeId: NodeId | null;
  actorId: string | null;
  /** Earlier events that caused this one (§9 causal chains). */
  causes: number[];
  /** A line from the person affected, generated from the simulation. */
  quote: { person: string; face: string; text: string } | null;
}

export interface TechView {
  tech: TechId;
  name: string;
  /** costCc is the credit part; steelT tonnes of steel come from Vesper Market. */
  sizes: { capacityKw: number; energyKwh: number; costCc: number; steelT: number; intervals: number }[];
  marginalCostCcPerMWh: number;
  requiredLicence: number;
  blurb: string;
  fuel: FuelId | null;
}

export interface TenderView {
  tenderId: string;
  nodeId: NodeId;
  needKw: number;
  payCc: number;
  windowStart: number;
  windowEnd: number;
  deadlineLabel: string;
  status: "open" | "met" | "missed";
  progressKw: number;
}

export interface RegionHistoryPoint {
  interval: number;
  demandKw: number;
  availableKw: number;
  servedKw: number;
  shedKw: number;
  priceCcPerMWh: number;
  playerKw: number;
}

export interface SettlementEpochView {
  epochId: string;
  fromInterval: number;
  toInterval: number;
  hash: string;
  status: "local" | "pending" | "submitted" | "confirmed" | "failed";
  txHash: string | null;
  transfers: number;
}

export interface RegionView {
  regionId: string;
  version: number;
  interval: number;
  mode: "live" | "challenge";
  paused: boolean;
  clock: { day: number; minuteOfDay: number; label: string; sunElevation: number; isNight: boolean };
  weather: { tempC: number; cloudPct: number; windKph: number; condition: "clear" | "cloudy" | "rain" | "storm" | "heatwave"; solarFactorBps: number; label: string };
  pulse: { demandKw: number; availableKw: number; reserveKw: number; shortfallKw: number; shedKw: number; spotCcPerMWh: number; cashCc: number; status: "normal" | "tight" | "shortfall" | "blackout" };
  question: string;
  nodes: NodeView[];
  corridors: CorridorView[];
  plants: PlantView[];
  actors: ActorView[];
  suppliers: SupplierView[];
  banks: BankView[];
  loans: LoanView[];
  techs: TechView[];
  tenders: TenderView[];
  voltline: { cashCc: number; debtCc: number; marginPct: number; state: "healthy" | "strained" | "distressed"; capacityKw: number; person: string; note: string };
  regulator: { priceCapCcPerMWh: number; carbonCcPerT: number; fundCc: number; warnings: number; note: string };
  player: {
    cashCc: number;
    debtCc: number;
    netWorthCc: number;
    gas: number;
    diesel: number;
    permitsT: number;
    certificates: number;
    steelT: number;
    parts: number;
    autoFuel: { gas: boolean; diesel: boolean };
    licence: number;
    licenceName: string;
    nextLicence: { name: string; needMWh: number; haveMWh: number; needReliabilityBps: number } | null;
    deliveredMWh: number;
    profitCcToday: number;
    revenueCcToday: number;
    emissionsT: number;
    reliabilityBps: number;
    starterGrantCc: number;
  };
  economy: { steelIndexBps: number; buildCostBps: number; regionOutputBps: number; employment: number; baseEmployment: number; householdHealthBps: number };
  world: WorldSnapshot;
  events: RegionEvent[];
  history: RegionHistoryPoint[];
  onboarding: { step: number; title: string; hint: string; target: string | null; done: boolean };
  scores: { profitCc: number; unservedMWh: number; emissionsT: number; regionOutputBps: number; score: number };
  settlement: { epochs: SettlementEpochView[]; nextEpochAt: number };
  ended: boolean;
}

export interface RegionActionResult {
  ok: boolean;
  version: number;
  message?: string;
  error?: { code: string; message: string };
  view?: RegionView;
  replayed?: boolean;
}
