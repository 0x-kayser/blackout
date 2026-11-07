/**
 * Canonical runtime schemas for BLACKOUT public DTOs (contract freeze v1).
 * Shared by apps/api (validation of everything it sends) and apps/web (parsing).
 * All quantities are integers in the units documented in ./units.ts.
 */
import { z } from "zod";

const int = () => z.number().int();
const nonNeg = () => z.number().int().nonnegative();
const id = () => z.string().min(1).max(120);

// ---------------------------------------------------------------- enums
export const RunModeSchema = z.enum(["play", "replay", "guest_demo"]);
export const PhaseSchema = z.enum(["morning", "operating", "settlement", "finished"]);
export const EventSourceSchema = z.enum(["simulated_game", "testnet_transaction", "replay_simulation"]);
export const ChainModeSchema = z.enum(["disabled", "testnet"]);
export const TradeChainStatusSchema = z.enum([
  "simulation_only", // no chain leg: game-ledger trade only (guest/replay or chain disabled)
  "pending", // reserved in DB, chain leg not yet submitted
  "submitted", // transaction broadcast, awaiting final receipt
  "confirmed", // RPC reported a successful final outcome
  "failed", // RPC reported a definitive failure; reservation compensated
  "timeout", // could not determine outcome yet; reconciling via contract view, never retried blindly
]);
export const TradeStatusSchema = z.enum(["reserved", "settled", "compensated"]);
export const BusinessStatusSchema = z.enum(["operating", "struggling", "closed", "reopening"]);
export const PowerSourceSchema = z.enum(["grid", "player", "rival", "none"]);
export const ProviderSchema = z.enum(["player", "rival"]);
export const RequestStatusSchema = z.enum([
  "open",
  "customer_countered",
  "accepted",
  "declined",
  "rejected_by_customer",
  "expired",
  "lost_to_rival",
]);
export const ContractStatusSchema = z.enum([
  "pending_assignment",
  "active",
  "completed",
  "failed",
  "cancelled",
  "expired",
]);
export const WaveStatusSchema = z.enum([
  "scheduled",
  "outage_started",
  "requests_open",
  "offers_pending",
  "service_active",
  "completed",
]);
export const GeneratorTypeSchema = z.enum(["diesel", "solar"]);
export const GeneratorStatusSchema = z.enum(["online", "broken", "maintenance"]);
export const MarketItemSchema = z.enum(["diesel", "permit"]);
export const MoodSchema = z.enum(["happy", "neutral", "worried", "angry"]);
export const TrendSchema = z.enum(["up", "down", "flat"]);
export const UpgradeIdSchema = z.enum(["solar_2kw", "battery_10kwh", "diesel_5kw"]);

// ---------------------------------------------------------------- clock / run
export const ClockSchema = z.object({
  day: int().min(1),
  campaignDays: int().min(1),
  phase: PhaseSchema,
  tick: nonNeg(), // global authoritative tick count since run start
  phaseTick: nonNeg(), // ticks elapsed in current phase
  phaseDurationTicks: nonNeg(),
  /** Game clock for the operating day, minutes since 00:00 (starts 06:00). Null outside operating. */
  gameMinuteOfDay: int().nullable(),
  gameHourIndex: int().min(0).max(24).nullable(),
  /** True while the server real-time driver is not advancing this run. */
  paused: z.boolean(),
  pauseReason: z.enum(["none", "no_clients", "player", "finished"]),
  tutorial: z.boolean(),
  nextWaveTick: nonNeg().nullable(),
});

export const RunSchema = z.object({
  runId: id(),
  ownerId: id(),
  seed: int(),
  scenarioId: z.string(),
  scenarioVersion: z.string(),
  mode: RunModeSchema,
  /** Increments on every accepted player/system action and phase change; ticks do not bump it. */
  stateVersion: nonNeg(),
  chainMode: ChainModeSchema,
});

// ---------------------------------------------------------------- entities
export const PlayerSchema = z.object({
  creditsCc: int(),
  reputationBps: int(),
  districtTrustBps: z.record(z.string(), int()),
  fuelMl: nonNeg(),
  /** Fuel committed to remaining hours of active contracts (cannot be double-spent). */
  fuelReservedMl: nonNeg(),
  tankCapacityMl: nonNeg(),
  /** Remaining carbon allowance, mg CO2 (1 permit = 10,000,000 mg). */
  permitAllowanceMg: nonNeg(),
  permitReservedMg: nonNeg(),
  co2TodayMg: nonNeg(),
  co2TotalMg: nonNeg(),
  tariffsCcPerKwh: z.record(z.string(), int()),
  generatorIds: z.array(id()),
  batteryId: id().nullable(),
  unlockedDistrictIds: z.array(id()),
  upgradesOwned: z.array(UpgradeIdSchema),
  pendingFuelMl: nonNeg(), // bought, awaiting chain confirmation
});

export const GeneratorSchema = z.object({
  generatorId: id(),
  name: z.string(),
  type: GeneratorTypeSchema,
  ownerId: id(),
  ratedW: nonNeg(),
  /** Output available right now (solar varies with hour; 0 when offline). */
  availableW: nonNeg(),
  assignedW: nonNeg(),
  outputW: nonNeg(),
  loadBps: nonNeg(),
  heatPermille: nonNeg(),
  wearBps: nonNeg(),
  status: GeneratorStatusSchema,
  offlineUntilTick: nonNeg().nullable(),
  cumulativeWh: nonNeg(),
  cumulativeFuelMl: nonNeg(),
  /** Optional NEP-171 token id. Null unless actually minted on testnet. */
  nftTokenId: z.string().nullable(),
});

export const BatterySchema = z.object({
  batteryId: id(),
  capacityWh: nonNeg(),
  storedWh: nonNeg(),
  maxChargeW: nonNeg(),
  maxDischargeW: nonNeg(),
  roundTripEfficiencyBps: nonNeg(),
  chargingFrom: z.enum(["solar", "none"]),
  dischargeW: nonNeg(),
  chargeW: nonNeg(),
});

export const DistrictSchema = z.object({
  districtId: id(),
  name: z.string(),
  unlocked: z.boolean(),
  unlockRequirementW: nonNeg(),
  unlockCostCc: nonNeg(),
  activityIndexBps: nonNeg(),
  outsideDemandCcPerHour: nonNeg(),
  poweredBps: nonNeg(),
  reliabilityTodayBps: nonNeg(),
  businessIds: z.array(id()),
  payBehaviour: z.enum(["haggle", "fixed_low", "price_sensitive", "low"]),
});

export const BusinessDaySchema = z.object({
  day: int(),
  openingCashCc: int(),
  closingCashCc: int(),
  revenueCc: nonNeg(),
  operatingCostCc: nonNeg(),
  powerCostCc: nonNeg(),
  poweredHours: nonNeg(),
  darkHours: nonNeg(),
});

export const BusinessSchema = z.object({
  businessId: id(),
  districtId: id(),
  name: z.string(),
  kind: z.string(),
  demandW: nonNeg(),
  cashCc: nonNeg(),
  revenueCcPerPoweredHour: nonNeg(),
  variableCostCcPerPoweredHour: nonNeg(),
  fixedCostCcPerDay: nonNeg(),
  /** (revenue - variable cost) / kW: highest tariff at which a powered hour still breaks even. */
  breakEvenRateCcPerKwh: nonNeg(),
  loyaltyBps: nonNeg(),
  status: BusinessStatusSchema,
  powerSource: PowerSourceSchema,
  provider: ProviderSchema,
  lowCashSettlements: nonNeg(),
  mood: MoodSchema,
  activeContractId: id().nullable(),
  outageUntilTick: nonNeg().nullable(),
  gougeCount: nonNeg(),
  history: z.array(BusinessDaySchema),
});

export const RequestSchema = z.object({
  requestId: id(),
  waveId: id(),
  businessId: id(),
  districtId: id(),
  requestedW: nonNeg(),
  durationHours: int().min(1),
  offerRateCcPerKwh: nonNeg(),
  counterCount: nonNeg(),
  maxCounters: nonNeg(),
  lastPlayerCounterCcPerKwh: nonNeg().nullable(),
  status: RequestStatusSchema,
  createdTick: nonNeg(),
  /** Null during tutorial waves (no timer). */
  deadlineTick: nonNeg().nullable(),
  expectedEnergyWh: nonNeg(),
  expectedPaymentCc: nonNeg(),
  estimatedFuelMl: nonNeg(),
  estimatedCo2Mg: nonNeg(),
  /** Fuel valued at the player's average acquisition cost; server-computed. */
  estimatedFuelCostCc: nonNeg(),
  estimatedMarginCc: int(),
  /** Customer's profit per powered hour at the current offer (can be negative). */
  customerProfitPerHourCc: int(),
  message: z.string(),
  resolutionReason: z.string().nullable(),
});

export const ContractSchema = z.object({
  contractId: id(),
  requestId: id(),
  businessId: id(),
  generatorId: id().nullable(),
  provider: ProviderSchema,
  allottedW: nonNeg(),
  rateCcPerKwh: nonNeg(),
  durationHours: int().min(1),
  totalTicks: nonNeg(),
  deliveredTicks: nonNeg(),
  startTick: nonNeg().nullable(),
  assignDeadlineTick: nonNeg().nullable(),
  deliveredWh: nonNeg(),
  billedCc: nonNeg(),
  escrowCc: nonNeg(),
  refundedCc: nonNeg(),
  fuelUsedMl: nonNeg(),
  co2Mg: nonNeg(),
  status: ContractStatusSchema,
  failureReason: z.string().nullable(),
  remainingGameHours: z.number().nonnegative(),
});

export const PriceReasonsSchema = z.object({
  oilIndexCenti: nonNeg(),
  referenceIndexCenti: nonNeg(),
  baseReferenceCcPerL: nonNeg(),
  baseReplacementCcPerL: nonNeg(),
  scarcityBps: int(),
  demandDeltaBps: int(),
  markupBps: int(),
  rawPriceCcPerL: int(),
  floorCcPerL: nonNeg(),
  maxCcPerL: nonNeg(),
  finalPriceCcPerL: nonNeg(),
  stockMl: nonNeg(),
  targetStockMl: nonNeg(),
  lastDaySalesMl: nonNeg(),
  baselineSalesMl: nonNeg(),
  trend: TrendSchema,
  rationLimitMl: nonNeg().nullable(),
  explanation: z.string(),
});

export const MerchantSchema = z.object({
  merchantId: id(),
  name: z.string(),
  style: z.string(),
  policyId: z.string(),
  /** Real NEAR testnet account id when chain mode is configured; otherwise null. */
  accountId: z.string().nullable(),
  status: z.enum(["open", "closed"]),
  stockMl: nonNeg(),
  reservedMl: nonNeg(),
  targetStockMl: nonNeg(),
  cashCc: nonNeg(),
  pendingRestockMl: nonNeg(),
  restockArrivesDay: int().nullable(),
  salesTodayMl: nonNeg(),
  lastDaySalesMl: nonNeg(),
  quoteCcPerL: nonNeg(),
  reasons: PriceReasonsSchema,
  priceHistory: z.array(z.object({ day: int(), tick: nonNeg(), priceCcPerL: nonNeg(), cause: z.string() })),
});

export const QuoteSchema = z.object({
  quoteId: id(),
  sellerId: id(),
  item: MarketItemSchema,
  /** Diesel: cc per litre. Permit: cc per permit. */
  unitPriceCc: nonNeg(),
  /** Diesel: mL. Permit: whole permits. */
  maxQuantity: nonNeg(),
  createdTick: nonNeg(),
  expiresTick: nonNeg(),
  marketVersion: nonNeg(),
  status: z.enum(["open", "used", "expired"]),
  reasons: PriceReasonsSchema.nullable(),
});

export const TradeSchema = z.object({
  tradeId: id(),
  quoteId: id(),
  idempotencyKey: z.string(),
  buyerId: id(),
  sellerId: id(),
  item: MarketItemSchema,
  quantity: nonNeg(),
  unitPriceCc: nonNeg(),
  totalCc: nonNeg(),
  status: TradeStatusSchema,
  chainStatus: TradeChainStatusSchema,
  /** NEP-245 token id and U128 string amount when there is a chain leg. */
  tokenId: z.string().nullable(),
  tokenAmount: z.string().nullable(),
  /** Only ever set from a verified RPC response. */
  txHash: z.string().nullable(),
  explorerUrl: z.string().nullable(),
  error: z.string().nullable(),
  createdTick: nonNeg(),
  settledTick: nonNeg().nullable(),
});

export const RivalSchema = z.object({
  rivalId: id(),
  name: z.string(),
  accountId: z.string().nullable(),
  ratedW: nonNeg(),
  assignedW: nonNeg(),
  fuelMl: nonNeg(),
  permitAllowanceMg: nonNeg(),
  cashCc: nonNeg(),
  tariffCcPerKwh: nonNeg(),
  tariffReasons: z.object({
    fuelCostCcPerKwh: nonNeg(),
    carbonCostCcPerKwh: nonNeg(),
    unitCostCcPerKwh: nonNeg(),
    marginBps: int(),
    finalCcPerKwh: nonNeg(),
    explanation: z.string(),
  }),
  activeContractIds: z.array(id()),
  customersServedToday: nonNeg(),
  contractsWon: nonNeg(),
  contractsDeclined: nonNeg(),
  reputationBps: nonNeg(),
  lastAction: z.string(),
});

export const RegulatorSchema = z.object({
  permitPriceCc: nonNeg(),
  permitsForSaleToday: nonNeg(),
  dailyCapPermits: nonNeg(),
  permitsSoldTotal: nonNeg(),
  emissionsTodayMg: nonNeg(),
  priceReason: z.string(),
  notices: z.array(z.string()),
});

export const WorldSchema = z.object({
  scenarioId: z.string(),
  scenarioName: z.string(),
  oilIndexCenti: nonNeg(),
  referenceIndexCenti: nonNeg(),
  oilTrend: TrendSchema,
  /** Honest provenance label, e.g. "Illustrative sample series — not real Brent data". */
  oilSourceLabel: z.string(),
  gridTariffCcPerKwh: nonNeg(),
});

export const WaveSchema = z.object({
  waveId: id(),
  day: int(),
  index: int().min(1),
  startTick: nonNeg(),
  status: WaveStatusSchema,
  requestIds: z.array(id()),
  tutorial: z.boolean(),
  label: z.string(),
});

export const HighlightSchema = z.object({ eventSeq: nonNeg(), text: z.string() });

export const DayReportSchema = z.object({
  day: int(),
  revenueCc: nonNeg(),
  refundsCc: nonNeg(),
  fuelBurnedMl: nonNeg(),
  fuelCostCc: nonNeg(),
  co2Mg: nonNeg(),
  permitAllowanceLeftMg: nonNeg(),
  spendCc: nonNeg(),
  netCashChangeCc: int(),
  reliabilityBps: nonNeg(),
  requestsOffered: nonNeg(),
  contractsCompleted: nonNeg(),
  contractsFailed: nonNeg(),
  customersLostToRival: nonNeg(),
  closures: z.array(id()),
  reopenings: z.array(id()),
  gdpCc: nonNeg(),
  gdpChangeBps: int(),
  oilIndexCenti: nonNeg(),
  avgFuelPriceCcPerL: nonNeg(),
  highlights: z.array(HighlightSchema),
});

export const CampaignSummarySchema = z.object({
  finished: z.boolean(),
  daysPlayed: nonNeg(),
  netWorthCc: int(),
  reliabilityBps: nonNeg(),
  cityGdpCc: nonNeg(),
  score: int(),
  badges: z.array(z.object({ id: z.string(), label: z.string(), earned: z.boolean(), reason: z.string() })),
  carbonAudit: z.string(),
});

export const TutorialSchema = z.object({
  active: z.boolean(),
  step: z.enum(["accept_first", "assign_first", "watch_service", "done"]),
  hint: z.string(),
});

export const ChainInfoSchema = z.object({
  mode: ChainModeSchema,
  network: z.string().nullable(),
  resourceContractId: z.string().nullable(),
  /** Custodial vault holding this run's resources on testnet, if configured. */
  vaultAccountId: z.string().nullable(),
  note: z.string(),
});

export const GameStatePublicSchema = z.object({
  schemaVersion: z.literal("blackout.state.v1"),
  run: RunSchema,
  clock: ClockSchema,
  player: PlayerSchema,
  generators: z.array(GeneratorSchema),
  battery: BatterySchema.nullable(),
  districts: z.array(DistrictSchema),
  businesses: z.array(BusinessSchema),
  requests: z.array(RequestSchema),
  contracts: z.array(ContractSchema),
  merchants: z.array(MerchantSchema),
  rival: RivalSchema,
  regulator: RegulatorSchema,
  world: WorldSchema,
  waves: z.array(WaveSchema),
  quotes: z.array(QuoteSchema),
  trades: z.array(TradeSchema),
  dayReports: z.array(DayReportSchema),
  campaign: CampaignSummarySchema,
  tutorial: TutorialSchema,
  chain: ChainInfoSchema,
  upgradesCatalog: z.array(
    z.object({ upgradeId: UpgradeIdSchema, name: z.string(), costCc: nonNeg(), description: z.string(), owned: z.boolean() }),
  ),
  lastEventSeq: nonNeg(),
});
