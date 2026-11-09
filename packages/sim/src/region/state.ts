/**
 * Region state and its double-entry ledger. Every credit, unit of gas and litre of diesel sits in exactly one
 * account. Accounts named `ext:*` are the outside world (exports, imports, contractors, burned fuel) and may go
 * negative; every other account is floored at zero. Invariant (tested): each asset sums to zero across accounts.
 */
import type { BatteryMode, FuelId, NodeId, OfferStrategy, RegionEvent, RegionHistoryPoint, TechId, WorldSnapshot } from "@blackout/shared";
import type { RngState } from "../prng.ts";
import { SimError } from "../state.ts";

/** permit kg CO2 · cert kWh · steel t · parts kits */
export type RAsset = "cc" | "gas" | "diesel" | "permit" | "cert" | "steel" | "parts";
export const R_ASSETS: RAsset[] = ["cc", "gas", "diesel", "permit", "cert", "steel", "parts"];

export interface RPlant {
  plantId: string;
  assetNo: number;
  name: string;
  tech: TechId;
  nodeId: NodeId;
  ownerId: string;
  capacityKw: number;
  energyKwh: number;
  status: "building" | "offline" | "starting" | "online" | "tripped" | "mothballed";
  buildRemaining: number;
  buildTotal: number;
  startRemaining: number;
  /** Owner's commitment: keep it running. */
  online: boolean;
  strategy: OfferStrategy;
  markupPct: number;
  batteryMode: BatteryMode;
  socKwh: number;
  healthBps: number;
  cycles: number;
  outputKw: number;
  /** Last interval's dispatch, for ramp limits. */
  prevOutputKw: number;
  /** Batteries: charging kW this interval. */
  chargeKw: number;
  lastAvailKw: number;
  tripUntil: number;
  tripReason: string | null;
  forcedPpm: number;
  capexCc: number;
  lifetimeKwh: number;
  lifetimeRevenueCc: number;
  revenueCcToday: number;
  costCcToday: number;
  fuelLimited: boolean;
  offerCc: number;
  mitigated: boolean;
}

export interface RCorridor {
  corridorId: string;
  baseLimitKw: number;
  upgrades: { ownerId: string; kw: number }[];
  building: { ownerId: string; kw: number; remaining: number } | null;
  flowKw: number;
  congested: boolean;
  rentCcToday: number;
  playerRentCcToday: number;
}

export interface RNode {
  nodeId: NodeId;
  demandKw: number;
  servedKw: number;
  curtailedKw: number;
  shedKw: number;
  generationKw: number;
  priceCc: number;
  marginal: { kind: "plant" | "load" | "cap" | "none"; id: string | null };
  /** Last 12 intervals: 1 if load was shed. */
  shedWindow: number[];
  priceWindow: number[];
  cumulativeShedKwh: number;
}

export interface RActor {
  actorId: string;
  demandKw: number;
  servedKw: number;
  flexKw: number;
  essentialKw: number;
  productionBps: number;
  healthBps: number;
  state: "operating" | "strained" | "distressed" | "closed";
  employees: number;
  inventoryDays: number;
  closedSince: number;
  energyCostCcToday: number;
  profitCcToday: number;
  /** Rolling income index for households and commerce (bps of normal). */
  incomeIndexBps: number;
  lastQuote: string;
  shedStreak: number;
}

export interface RSupplier {
  supplierId: string;
  stock: number;
  priceCc: number;
  rationing: boolean;
  importPerInterval: number;
  /** Units sold to each buyer this interval (ration bookkeeping). */
  soldThisInterval: Record<string, number>;
  disruptionUntil: number;
}

export interface RLoan {
  loanId: string;
  bankId: string;
  borrower: string;
  principalCc: number;
  rateBps: number;
}

export interface RListing {
  plantId: string;
  seller: string;
  askCc: number;
  bids: { bidId: string; bidder: string; amountCc: number; reason: string }[];
  listedAt: number;
}

export interface RTender {
  tenderId: string;
  nodeId: NodeId;
  needKw: number;
  payCc: number;
  windowStart: number;
  windowEnd: number;
  okIntervals: number;
  status: "open" | "met" | "missed";
  progressKw: number;
}

export interface REpoch {
  epochNo: number;
  epochId: string;
  fromInterval: number;
  toInterval: number;
  /** Net credit change per chain identity (sums to zero). */
  transfers: { account: string; deltaCc: number }[];
  plants: { assetId: string; ownerId: string; lifetimeKwh: number; lifetimeRevenueCc: number; status: string }[];
  stateDigest: string;
  hash: string;
}

export interface RegionState {
  version: 1;
  regionId: string;
  seed: number;
  rng: RngState;
  mode: "live" | "challenge";
  interval: number;
  stateVersion: number;
  input: WorldSnapshot;
  weather: { tempC: number; cloudPct: number; windKph: number; condition: "clear" | "cloudy" | "rain" | "storm" | "heatwave"; heatUntil: number; stormUntil: number };
  nodes: Record<string, RNode>;
  corridors: RCorridor[];
  plants: RPlant[];
  nextAssetNo: number;
  actors: Record<string, RActor>;
  suppliers: Record<string, RSupplier>;
  loans: RLoan[];
  nextLoanNo: number;
  listings: RListing[];
  nextBidNo: number;
  tenders: RTender[];
  nextTenderNo: number;
  voltline: { marginBps: number; state: "healthy" | "strained" | "distressed"; investCooldown: number; distressSince: number };
  regulator: { carbonCcPerT: number; warnings: number; lastNote: string };
  player: { autoFuel: { gas: boolean; diesel: boolean }; licence: number; deliveredKwh: number; emissionsKg: number; servedShareWindow: number[]; profitCcToday: number; revenueCcToday: number; profitCcTotal: number; starterGrantCc: number };
  economy: { steelIndexBps: number; steelWindow: number[] };
  balances: Record<RAsset, Record<string, number>>;
  ledgerSeq: number;
  events: RegionEvent[];
  eventSeq: number;
  /** Open conditions → the event that started them, for causal links. */
  causes: Record<string, number>;
  /** Last interval an event family fired, to keep the feed readable. */
  cooldowns: Record<string, number>;
  /** Power the player sold to Vesper's NPC companies: firm loads served from the player's own node (power desk). */
  exports?: { orderId: string; buyerName: string; kw: number; nodeId: string; untilInterval: number; deliveredKwh: number; priceCcPerMWh: number }[];
  history: RegionHistoryPoint[];
  pulse: { demandKw: number; availableKw: number; shedKw: number; curtailedKw: number; spotCc: number };
  onboarding: { step: number; done: boolean };
  stats: { unservedKwh: number; regionOutputBpsSum: number; intervalsCounted: number };
  epochs: REpoch[];
  epochStart: { interval: number; balances: Record<string, number> };
  scripted: { firstTripDone: boolean };
  /** The market's fuel prices (cc per MMBtu / L), set by TOWN_PRICES. */
  townPrices?: { gas: number | null; diesel: number | null };
  ended: boolean;
}

export interface RJournal {
  seq: number;
  interval: number;
  asset: RAsset;
  from: string;
  to: string;
  amount: number;
  reason: string;
}

export interface RCtx {
  journal: RJournal[];
  events: RegionEvent[];
  /** Keep only the last N journal lines (the engine moves money many times per interval). */
  journalCap: number;
}

export const newRCtx = (journalCap = 400): RCtx => ({ journal: [], events: [], journalCap });

export const RACC = {
  player: "player",
  treasury: "treasury",
  market: "market",
  grid: "grid",
  regulator: "regulator",
  owner: (id: string) => (id === "player" ? "player" : `owner:${id}`),
  actor: (id: string) => `actor:${id}`,
  supplier: (id: string) => `supplier:${id}`,
  bank: (id: string) => `bank:${id}`,
  extGenesis: "ext:genesis",
  extExports: "ext:exports",
  extSpending: "ext:spending",
  extImports: "ext:imports",
  extConstruction: "ext:construction",
  extOm: "ext:om",
  extBurned: "ext:burned",
  extInvestors: "ext:investors",
} as const;

const isExt = (a: string) => a.startsWith("ext:");

export function rbal(s: RegionState, asset: RAsset, acct: string): number {
  return s.balances[asset]?.[acct] ?? 0;
}

const INSUFFICIENT: Record<RAsset, "INSUFFICIENT_CREDITS" | "INSUFFICIENT_FUEL" | "REQUIREMENT_NOT_MET"> = { cc: "INSUFFICIENT_CREDITS", gas: "INSUFFICIENT_FUEL", diesel: "INSUFFICIENT_FUEL", permit: "REQUIREMENT_NOT_MET", cert: "REQUIREMENT_NOT_MET", steel: "REQUIREMENT_NOT_MET", parts: "REQUIREMENT_NOT_MET" };

export function rtransfer(s: RegionState, ctx: RCtx, asset: RAsset, from: string, to: string, amount: number, reason: string): void {
  if (!Number.isInteger(amount) || amount < 0) throw new SimError("INTERNAL", `ledger amount must be a non-negative integer, got ${amount}`);
  if (amount === 0) return;
  if (from === to) return;
  const fb = rbal(s, asset, from);
  if (!isExt(from) && fb < amount) throw new SimError(INSUFFICIENT[asset], `${from} has ${fb} ${asset}, needs ${amount}`, { asset, from, have: fb, need: amount });
  s.balances[asset] ??= {};
  s.balances[asset][from] = fb - amount;
  s.balances[asset][to] = rbal(s, asset, to) + amount;
  s.ledgerSeq += 1;
  ctx.journal.push({ seq: s.ledgerSeq, interval: s.interval, asset, from, to, amount, reason });
  if (ctx.journal.length > ctx.journalCap) ctx.journal.splice(0, ctx.journal.length - ctx.journalCap);
}

/** Moves min(amount, available) and returns what moved. */
export function rtransferUpTo(s: RegionState, ctx: RCtx, asset: RAsset, from: string, to: string, amount: number, reason: string): number {
  const avail = isExt(from) ? amount : Math.max(0, Math.min(amount, rbal(s, asset, from)));
  rtransfer(s, ctx, asset, from, to, avail, reason);
  return avail;
}

export function rsum(s: RegionState, asset: RAsset): number {
  return Object.values(s.balances[asset] ?? {}).reduce((a, b) => a + b, 0);
}

export const fuelAsset = (f: FuelId): RAsset => (f === "gas" ? "gas" : "diesel");
