/**
 * Internal (authoritative) state. Never sent to clients directly — see view.ts
 * for the GameStatePublic projection, which strips RNG state and internals.
 */
import type {
  BusinessDay,
  BusinessStatus,
  ChainMode,
  ContractStatus,
  DayReport,
  EconomyEvent,
  ErrorCode,
  EventSource,
  EventType,
  GeneratorStatus,
  GeneratorType,
  LedgerEntry,
  MarketItem,
  Phase,
  PowerSource,
  PriceReasons,
  Provider,
  RequestStatus,
  RunMode,
  TradeChainStatus,
  UpgradeId,
  WaveStatus,
} from "@blackout/shared";
import type { RngState } from "./prng.ts";

export type Asset = "credits_cc" | "fuel_ml" | "permit_mg";

export interface GeneratorState {
  generatorId: string;
  name: string;
  type: GeneratorType;
  ownerId: string;
  ratedW: number;
  heatPermille: number;
  wearBps: number;
  status: GeneratorStatus;
  offlineUntilTick: number | null;
  cumulativeWh: number;
  cumulativeFuelMl: number;
  outputW: number;
  heatWarned: boolean;
  nftTokenId: string | null;
}

export interface BatteryState {
  batteryId: string;
  capacityWh: number;
  storedWh: number;
  maxChargeW: number;
  maxDischargeW: number;
  roundTripEfficiencyBps: number;
  chargeW: number;
  dischargeW: number;
  /** Sub-Wh remainder of charge (fixed-point, 1/10 Wh) carried between ticks. */
  chargeRemainderDeciWh: number;
}

export interface DistrictState {
  districtId: string;
  name: string;
  unlocked: boolean;
  unlockRequirementW: number;
  unlockCostCc: number;
  activityIndexBps: number;
  outsideDemandCcPerHour: number;
  payBehaviour: "haggle" | "fixed_low" | "price_sensitive" | "low";
  outageTicksToday: number;
  servedOutageTicksToday: number;
}

export interface BusinessState {
  businessId: string;
  districtId: string;
  name: string;
  kind: string;
  demandW: number;
  revenueCcPerPoweredHour: number;
  variableCostCcPerPoweredHour: number;
  fixedCostCcPerDay: number;
  loyaltyBps: number;
  concessionBps: number;
  fixedTariffCcPerKwh: number | null;
  gougeTolerance: number;
  gougeCount: number;
  status: BusinessStatus;
  provider: Provider;
  powerSource: PowerSource;
  lowCashSettlements: number;
  closedSinceDay: number | null;
  activeContractId: string | null;
  outageUntilTick: number | null;
  /** Accumulators for the current day (reset at day start). */
  today: {
    openingCashCc: number;
    revenueCc: number;
    operatingCostCc: number;
    powerCostCc: number;
    poweredTicks: number;
    darkTicks: number;
    gridWh: number;
    gridBilledCc: number;
    revenueRemainderMilliCc: number;
    costRemainderMilliCc: number;
    unpaidCostCc: number;
    servedByPlayerTicks: number;
    darkOutageTicks: number;
    paidRateSum: number;
    paidRateCount: number;
  };
  history: BusinessDay[];
}

export interface RequestState {
  requestId: string;
  waveId: string;
  businessId: string;
  districtId: string;
  requestedW: number;
  durationHours: number;
  offerRateCcPerKwh: number;
  counterCount: number;
  maxCounters: number;
  lastPlayerCounterCcPerKwh: number | null;
  status: RequestStatus;
  createdTick: number;
  deadlineTick: number | null;
  day: number;
  message: string;
  resolutionReason: string | null;
}

export interface ContractState {
  contractId: string;
  requestId: string;
  businessId: string;
  generatorId: string | null;
  provider: Provider;
  allottedW: number;
  rateCcPerKwh: number;
  durationHours: number;
  totalTicks: number;
  deliveredTicks: number;
  startTick: number | null;
  serviceStartedEmitted: boolean;
  assignDeadlineTick: number | null;
  deliveredWh: number;
  billedCc: number;
  escrowCc: number;
  refundedCc: number;
  fuelUsedMl: number;
  co2Mg: number;
  status: ContractStatus;
  failureReason: string | null;
  day: number;
  /** Per game-hour aggregates for ENERGY_DELIVERED events. */
  hourWh: number;
  hourFuelMl: number;
  hourBilledCc: number;
}

export interface MerchantState {
  merchantId: string;
  name: string;
  style: string;
  policyId: "efficient_wholesaler" | "low_stock_boutique" | "reserve_cooperative";
  accountId: string | null;
  status: "open" | "closed";
  targetStockMl: number;
  reserveFloorMl: number;
  operatingReserveCc: number;
  upstreamCapacityMlPerDay: number;
  leadTimeDays: number;
  overheadCcPerDay: number;
  baselineSalesMl: number;
  pendingRestockMl: number;
  restockArrivesDay: number | null;
  salesTodayMl: number;
  lastDaySalesMl: number;
  quoteCcPerL: number;
  reasons: PriceReasons;
  priceHistory: { day: number; tick: number; priceCcPerL: number; cause: string }[];
}

export interface RivalState {
  rivalId: string;
  name: string;
  accountId: string | null;
  ratedW: number;
  tankCapacityMl: number;
  fuelCostBasisCcPerL: number;
  tariffCcPerKwh: number;
  marginBps: number;
  tariffReasons: {
    fuelCostCcPerKwh: number;
    carbonCostCcPerKwh: number;
    unitCostCcPerKwh: number;
    marginBps: number;
    finalCcPerKwh: number;
    explanation: string;
  };
  contractsWon: number;
  contractsDeclined: number;
  wonToday: number;
  declinedToday: number;
  customersServedToday: number;
  reputationBps: number;
  lastAction: string;
  boughtToday: boolean;
}

export interface RegulatorState {
  permitPriceCc: number;
  dailyCapPermits: number;
  permitsSoldToday: number;
  permitsSoldTotal: number;
  emissionsTodayMg: number;
  emissionsYesterdayMg: number;
  priceReason: string;
  notices: string[];
}

export interface QuoteState {
  quoteId: string;
  sellerId: string;
  buyerId: string;
  item: MarketItem;
  unitPriceCc: number;
  maxQuantity: number;
  createdTick: number;
  expiresTick: number;
  marketVersion: number;
  status: "open" | "used" | "expired";
  reasons: PriceReasons | null;
}

export interface TradeState {
  tradeId: string;
  quoteId: string;
  idempotencyKey: string;
  buyerId: string;
  sellerId: string;
  item: MarketItem;
  quantity: number;
  unitPriceCc: number;
  totalCc: number;
  status: "reserved" | "settled" | "compensated";
  chainStatus: TradeChainStatus;
  tokenId: string | null;
  tokenAmount: string | null;
  txHash: string | null;
  explorerUrl: string | null;
  error: string | null;
  createdTick: number;
  settledTick: number | null;
  day: number;
}

export interface WaveState {
  waveId: string;
  day: number;
  index: number;
  startTick: number;
  status: WaveStatus;
  requestIds: string[];
  tutorial: boolean;
  label: string;
}

export interface DayStats {
  day: number;
  openingCreditsCc: number;
  revenueCc: number;
  refundsCc: number;
  fuelBurnedMl: number;
  fuelCostCc: number;
  co2Mg: number;
  spendCc: number;
  requestsOffered: number;
  contractsCompleted: number;
  contractsFailed: number;
  lostToRival: number;
  requestedOutageTicks: number;
  servedOutageTicks: number;
  gdpCc: number;
  closures: string[];
  reopenings: string[];
  firstEventSeq: number;
  generationWh: { diesel: number; solar: number; battery: number };
}

export interface SimState {
  schema: "blackout.sim.v1";
  runId: string;
  ownerId: string;
  seed: number;
  scenarioId: string;
  scenarioVersion: string;
  mode: RunMode;
  chainMode: ChainMode;
  campaignDays: number;
  stateVersion: number;
  rng: RngState;
  tick: number;
  day: number;
  phase: Phase;
  phaseStartTick: number;
  phaseTick: number;
  waveIndex: number; // waves started today
  nextId: number;
  eventSeq: number;
  ledgerSeq: number;
  marketVersion: number;
  balances: Record<Asset, Record<string, number>>;
  player: {
    reputationBps: number;
    districtTrustBps: Record<string, number>;
    tankCapacityMl: number;
    tariffs: Record<string, number>;
    generatorIds: string[];
    batteryId: string | null;
    unlockedDistrictIds: string[];
    upgradesOwned: UpgradeId[];
    co2TodayMg: number;
    co2TotalMg: number;
    /** Weighted average acquisition cost of fuel in the tank, cc per L. */
    fuelCostBasisCcPerL: number;
  };
  generators: Record<string, GeneratorState>;
  battery: BatteryState | null;
  districts: Record<string, DistrictState>;
  businesses: Record<string, BusinessState>;
  requests: Record<string, RequestState>;
  contracts: Record<string, ContractState>;
  merchants: Record<string, MerchantState>;
  rival: RivalState;
  regulator: RegulatorState;
  world: { oilIndexCenti: number; prevOilIndexCenti: number; referenceIndexCenti: number };
  waves: WaveState[];
  quotes: Record<string, QuoteState>;
  trades: Record<string, TradeState>;
  dayStats: DayStats;
  dayReports: DayReport[];
  totals: {
    requestedOutageTicks: number;
    servedOutageTicks: number;
    gdpCc: number;
    closures: number;
  };
  tutorialStep: "accept_first" | "assign_first" | "watch_service" | "done";
  finished: boolean;
}

/** Output collector threaded through every mutation. */
export interface Ctx {
  events: EconomyEvent[];
  ledger: LedgerEntry[];
  source: EventSource;
}

export class SimError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "SimError";
  }
}

export const newCtx = (s: SimState): Ctx => ({
  events: [],
  ledger: [],
  source: s.mode === "replay" ? "replay_simulation" : "simulated_game",
});

export function newId(s: SimState, prefix: string): string {
  s.nextId += 1;
  return `${prefix}_${s.nextId}`;
}

export function clockLabel(s: SimState): string {
  if (s.phase !== "operating") return s.phase;
  const m = 360 + s.phaseTick * 6;
  const mm = m % 1440;
  return `${String(Math.floor(mm / 60)).padStart(2, "0")}:${String(mm % 60).padStart(2, "0")}`;
}

/** Current clock hour (0..23) during operating, else null. */
export function clockHour(s: SimState): number | null {
  if (s.phase !== "operating") return null;
  return Math.floor(((360 + s.phaseTick * 6) % 1440) / 60);
}

export function emit(
  s: SimState,
  ctx: Ctx,
  type: EventType,
  actors: string[],
  explanation: string,
  data: Record<string, unknown> = {},
  opts: { source?: EconomyEvent["source"]; txHash?: string | null } = {},
): EconomyEvent {
  s.eventSeq += 1;
  const ev: EconomyEvent = {
    seq: s.eventSeq,
    eventId: `${s.runId}:${s.eventSeq}`,
    runId: s.runId,
    day: s.day,
    tick: s.tick,
    clock: clockLabel(s),
    type,
    source: opts.source ?? ctx.source,
    actors,
    explanation,
    data,
    txHash: opts.txHash ?? null,
  };
  ctx.events.push(ev);
  return ev;
}

export const cr = (cc: number): string => {
  const sign = cc < 0 ? "-" : "";
  const a = Math.abs(cc);
  return `${sign}${Math.floor(a / 100)}${a % 100 ? "." + String(a % 100).padStart(2, "0") : ""}`;
};
export const L = (ml: number): string => (ml / 1000).toFixed(1);
export const kW = (w: number): string => (w / 1000).toFixed(1);

export type { BusinessDay, DayReport, EconomyEvent, LedgerEntry, PriceReasons, Phase };
