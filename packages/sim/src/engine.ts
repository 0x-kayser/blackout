/**
 * BLACKOUT authoritative engine.
 *
 *   createInitialState(opts)                 -> { state, events, ledger }
 *   applyAction(state, action, meta)         -> { state, events, ledger, result }   (pure; throws SimError)
 *   tick(state)                              -> { state, events, ledger }           (pure; one 1-second tick)
 *   nextState(state, actions, meta)          -> actions applied in order, then one tick
 *
 * The RNG state lives in `state.rng`, so seed + scenario version + the ordered
 * (tick, action) log reproduces every event and ledger entry byte-for-byte.
 * The `*Mut` variants mutate in place for the server driver and fast replays.
 */
import { PERMIT_MG, type AnyAction, type ChainMode, type RunMode } from "@blackout/shared";
import {
  BUSINESSES,
  DISTRICTS,
  MERCHANTS,
  PHYSICS,
  REFERENCE_OIL_CENTI,
  RIVAL,
  SCENARIOS,
  SCENARIO_VERSION,
  STARTING_KIT,
  TIMING,
  UPGRADES,
  oilForDay,
} from "./config.ts";
import { ACC, bal, transfer } from "./ledger.ts";
import { seedRng, rngRange, rngShuffle } from "./prng.ts";
import { buy, createQuote, expireQuotes, merchantsMorning, repriceMerchant, settleTrade } from "./market.ts";
import { ensureWorld, initWorld, worldModifiers, worldTick } from "./world-events/engine.ts";
import type { WorldEventState, WorldMode } from "./world-events/types.ts";
import { storyTick } from "./story.ts";
import { activeContractsOn, dispatchTick, heatTick, repairTick, validateAssignment } from "./electricity.ts";
import {
  acceptRequest,
  breakEvenRate,
  businessesTick,
  counterRequest,
  createRequest,
  declineRequest,
  eligibleForOutage,
  resetBusinessDay,
  setTutorial,
} from "./customers.ts";
import { customersChooseProvider, regulatorMorning, repriceRival, resetRivalDay, rivalBid, rivalShop } from "./agents.ts";
import { attachHighlights, campaignSummary, refundEscrow, settleDay } from "./economy.ts";
import { SimError, cr, emit, kW, newCtx, newId, type ContractState, type Ctx, type DayStats, type SimState, type WaveState } from "./state.ts";
import { computeMerchantPrice, MERCHANT_POLICIES } from "./policies/merchantPricing.ts";
import { cancelPlayerListing, createPlayerListing, expirePlayerListing, reserveMarketPurchase, settlePlayerListing } from "./marketplace.ts";

export interface CreateRunOptions {
  runId: string;
  ownerId: string;
  seed: number;
  scenarioId?: string;
  mode?: RunMode;
  chainMode?: ChainMode;
  campaignDays?: number;
  merchantAccounts?: Record<string, string | null>;
  rivalAccountId?: string | null;
  /** World Events mode (default "calm" so plain engine use stays event-free). */
  worldMode?: WorldMode;
  /** Fixed event schedule (Economy Lab condition / weekly challenge). */
  worldPreset?: string | null;
  challengeWeek?: string | null;
  /** Begin the oil series this many game days in (e.g. 12 → week of 2026-03-23 in the Brent replay). */
  oilDayOffset?: number;
}

/** Solar and battery prices follow the renewables supply chain (world events). */
export function upgradeCostCc(s: SimState, upgradeId: string, baseCc: number): number {
  if (upgradeId !== "solar_2kw" && upgradeId !== "battery_10kwh") return baseCc;
  return Math.round((baseCc * (10_000 + worldModifiers(s).solarCostBps)) / 10_000 / 100) * 100;
}

export interface StepResult {
  state: SimState;
  events: Ctx["events"];
  ledger: Ctx["ledger"];
}
export interface ActionOutcome extends StepResult {
  result: Record<string, unknown>;
}
export interface ActionMeta {
  idempotencyKey: string;
  /** True when diesel purchases must settle through the NEAR testnet worker. */
  chainLeg?: boolean;
  tokenId?: string;
}

const clone = <T>(x: T): T => structuredClone(x);

function freshDayStats(s: SimState): DayStats {
  return {
    day: s.day,
    openingCreditsCc: bal(s, "credits_cc", ACC.player),
    revenueCc: 0,
    refundsCc: 0,
    fuelBurnedMl: 0,
    fuelCostCc: 0,
    co2Mg: 0,
    spendCc: 0,
    requestsOffered: 0,
    contractsCompleted: 0,
    contractsFailed: 0,
    lostToRival: 0,
    requestedOutageTicks: 0,
    servedOutageTicks: 0,
    gdpCc: 0,
    closures: [],
    reopenings: [],
    firstEventSeq: s.eventSeq + 1,
    generationWh: { diesel: 0, solar: 0, battery: 0 },
    hourFuelMl: 0,
    hourCo2Mg: 0,
    notable: [],
  };
}

// ------------------------------------------------------------------ creation

export function createInitialState(opts: CreateRunOptions): StepResult {
  const scenario = SCENARIOS[opts.scenarioId ?? "starter"];
  if (!scenario) throw new SimError("VALIDATION_FAILED", `unknown scenario ${opts.scenarioId}`);
  const mode = opts.mode ?? "guest_demo";
  const placeholderReasons = computeMerchantPrice({
    policy: MERCHANT_POLICIES.efficient_wholesaler,
    oilIndexCenti: REFERENCE_OIL_CENTI,
    referenceIndexCenti: REFERENCE_OIL_CENTI,
    baseReferenceCcPerL: 1000,
    stockMl: 0,
    reserveFloorMl: 0,
    targetStockMl: 1,
    lastDaySalesMl: 0,
    baselineSalesMl: 1,
    trend: "flat",
  });
  const s: SimState = {
    schema: "blackout.sim.v1",
    runId: opts.runId,
    ownerId: opts.ownerId,
    seed: opts.seed >>> 0,
    scenarioId: scenario.scenarioId,
    scenarioVersion: SCENARIO_VERSION,
    mode,
    chainMode: opts.chainMode ?? "disabled",
    campaignDays: opts.campaignDays ?? 0, // 0 = continuous, never ends
    stateVersion: 0,
    rng: seedRng(opts.seed >>> 0),
    tick: 0,
    day: 1,
    phase: "operating",
    phaseStartTick: 0,
    phaseTick: 0,
    waveIndex: 0,
    wavesTotal: 0,
    nextId: 0,
    eventSeq: 0,
    ledgerSeq: 0,
    marketVersion: 0,
    balances: { credits_cc: {}, fuel_ml: {}, permit_mg: {} },
    player: {
      reputationBps: STARTING_KIT.reputationBps,
      districtTrustBps: Object.fromEntries(DISTRICTS.map((d) => [d.districtId, 5_000])),
      tankCapacityMl: STARTING_KIT.tankCapacityMl,
      tariffs: Object.fromEntries(DISTRICTS.map((d) => [d.districtId, STARTING_KIT.defaultTariffCcPerKwh])),
      generatorIds: ["gen_1"],
      batteryId: null,
      unlockedDistrictIds: DISTRICTS.filter((d) => d.unlockedAtStart).map((d) => d.districtId),
      upgradesOwned: [],
      co2TodayMg: 0,
      co2TotalMg: 0,
      fuelCostBasisCcPerL: 1_000,
      chainBackedFuelMl: 0,
    },
    generators: {
      gen_1: {
        generatorId: "gen_1",
        name: STARTING_KIT.generator.name,
        type: "diesel",
        ownerId: "player",
        ratedW: STARTING_KIT.generator.ratedW,
        heatPermille: 0,
        wearBps: 0,
        status: "online",
        offlineUntilTick: null,
        cumulativeWh: 0,
        cumulativeFuelMl: 0,
        outputW: 0,
        heatWarned: false,
        nftTokenId: null,
        whSinceService: 0,
        maintenanceTicks: 0,
      },
    },
    battery: null,
    districts: Object.fromEntries(
      DISTRICTS.map((d) => [
        d.districtId,
        {
          districtId: d.districtId,
          name: d.name,
          unlocked: d.unlockedAtStart,
          unlockRequirementW: d.unlockRequirementW,
          unlockCostCc: d.unlockCostCc,
          activityIndexBps: 10_000,
          outsideDemandCcPerHour: d.outsideDemandCcPerHour,
          payBehaviour: d.payBehaviour,
          outageTicksToday: 0,
          servedOutageTicksToday: 0,
        },
      ]),
    ),
    businesses: {},
    requests: {},
    contracts: {},
    merchants: {},
    rival: {
      rivalId: RIVAL.rivalId,
      name: RIVAL.name,
      accountId: opts.rivalAccountId ?? null,
      ratedW: RIVAL.ratedW,
      tankCapacityMl: RIVAL.tankCapacityMl,
      fuelCostBasisCcPerL: 1_000,
      tariffCcPerKwh: 0,
      marginBps: RIVAL.baseMarginBps,
      tariffReasons: { fuelCostCcPerKwh: 0, carbonCostCcPerKwh: 0, unitCostCcPerKwh: 0, marginBps: 0, finalCcPerKwh: 0, explanation: "" },
      contractsWon: 0,
      contractsDeclined: 0,
      wonToday: 0,
      declinedToday: 0,
      customersServedToday: 0,
      reputationBps: 5_000,
      lastAction: "Opened for business",
      boughtToday: true,
      solarW: 0,
      stockpileDays: 0,
    },
    regulator: {
      permitPriceCc: 0,
      dailyCapPermits: 8,
      permitsSoldToday: 0,
      permitsSoldTotal: 0,
      emissionsTodayMg: 0,
      emissionsYesterdayMg: 8 * PERMIT_MG,
      priceReason: "",
      notices: [],
    },
    world: { oilIndexCenti: oilForDay(scenario, 1 + (opts.oilDayOffset ?? 0)), prevOilIndexCenti: oilForDay(scenario, 1 + (opts.oilDayOffset ?? 0)), referenceIndexCenti: REFERENCE_OIL_CENTI, oilDayOffset: opts.oilDayOffset ?? 0 },
    waves: [],
    quotes: {},
    trades: {},
    marketListings: [],
    dayStats: undefined as unknown as DayStats,
    dayReports: [],
    totals: { requestedOutageTicks: 0, servedOutageTicks: 0, gdpCc: 0, closures: 0, servicesStarted: 0, contractsCompleted: 0, contractsDuringEvents: 0, solarContractsCompleted: 0, dieselPurchases: 0 },
    worldEvents: initWorld(opts.seed >>> 0, opts.worldMode ?? "calm", opts.worldPreset ?? null),
    story: { completed: [] },
    challengeWeek: opts.challengeWeek ?? null,
    tutorialStep: "accept_first",
    finished: false,
  };
  s.dayStats = freshDayStats(s);
  for (const b of BUSINESSES) {
    s.businesses[b.businessId] = {
      businessId: b.businessId,
      districtId: b.districtId,
      name: b.name,
      kind: b.kind,
      demandW: b.demandW,
      revenueCcPerPoweredHour: b.revenueCcPerPoweredHour,
      variableCostCcPerPoweredHour: b.variableCostCcPerPoweredHour,
      fixedCostCcPerDay: b.fixedCostCcPerDay,
      loyaltyBps: b.loyaltyBps,
      concessionBps: b.concessionBps,
      fixedTariffCcPerKwh: b.fixedTariffCcPerKwh ?? null,
      gougeTolerance: b.gougeTolerance,
      gougeCount: 0,
      status: "operating",
      provider: "player",
      powerSource: "grid",
      lowCashSettlements: 0,
      closedSinceDay: null,
      activeContractId: null,
      outageUntilTick: null,
      today: undefined as never,
      history: [],
    };
  }
  for (const m of MERCHANTS) {
    s.merchants[m.merchantId] = {
      merchantId: m.merchantId,
      name: m.name,
      style: m.style,
      policyId: m.policyId,
      accountId: opts.merchantAccounts?.[m.merchantId] ?? null,
      status: "open",
      targetStockMl: m.targetStockMl,
      reserveFloorMl: m.reserveFloorMl,
      operatingReserveCc: m.operatingReserveCc,
      upstreamCapacityMlPerDay: m.upstreamCapacityMlPerDay,
      leadTimeDays: m.leadTimeDays,
      overheadCcPerDay: m.overheadCcPerDay,
      baselineSalesMl: m.baselineSalesMl,
      pendingRestockMl: 0,
      restockArrivesDay: null,
      salesTodayMl: 0,
      lastDaySalesMl: m.baselineSalesMl,
      quoteCcPerL: 0,
      reasons: placeholderReasons,
      priceHistory: [],
    };
  }
  const ctx = newCtx(s);
  emit(s, ctx, "RUN_STARTED", ["player"], `New ${scenario.name} run (seed ${s.seed}, scenario ${s.scenarioVersion}). The world runs continuously; your supplies are pre-stocked.`, {
    seed: s.seed,
    scenarioId: s.scenarioId,
    scenarioVersion: s.scenarioVersion,
    mode,
    oilSourceLabel: scenario.oilSourceLabel,
  });
  // genesis endowments (the only time assets appear without a counter-party in play)
  transfer(s, ctx, "credits_cc", ACC.genesis, ACC.player, STARTING_KIT.creditsCc, "starting_credits");
  transfer(s, ctx, "fuel_ml", ACC.genesis, ACC.player, STARTING_KIT.fuelMl, "starting_fuel");
  transfer(s, ctx, "permit_mg", ACC.genesis, ACC.player, STARTING_KIT.permits * PERMIT_MG, "starting_permits");
  for (const b of BUSINESSES) transfer(s, ctx, "credits_cc", ACC.genesis, ACC.business(b.businessId), b.startCashCc, "starting_cash", b.businessId);
  for (const m of MERCHANTS) {
    transfer(s, ctx, "credits_cc", ACC.genesis, ACC.merchant(m.merchantId), m.startCashCc, "starting_cash", m.merchantId);
    transfer(s, ctx, "fuel_ml", ACC.genesis, ACC.merchant(m.merchantId), m.startStockMl, "starting_stock", m.merchantId);
  }
  transfer(s, ctx, "credits_cc", ACC.genesis, ACC.rival, RIVAL.startCashCc, "starting_cash");
  transfer(s, ctx, "fuel_ml", ACC.genesis, ACC.rival, RIVAL.startFuelMl, "starting_fuel");
  transfer(s, ctx, "permit_mg", ACC.genesis, ACC.rival, RIVAL.startPermits * PERMIT_MG, "starting_permits");
  resetBusinessDay(s);
  emit(s, ctx, "DAY_STARTED", ["player"], `Day 1. Oil index ${(s.world.oilIndexCenti / 100).toFixed(2)} (${scenario.oilSourceLabel}).`, { day: 1, oilIndexCenti: s.world.oilIndexCenti });
  regulatorMorning(s, ctx);
  merchantsMorning(s, ctx);
  repriceRival(s, ctx, "opening");
  beginOperating(s, ctx, true);
  setTutorial(s, ctx, "accept_first");
  s.tutorialStep = "accept_first";
  return { state: s, events: ctx.events, ledger: ctx.ledger };
}

// ------------------------------------------------------------------ continuous world clock
//
// There are no blocking phases. The world runs one continuous operating clock:
// 240 ticks = one 24-hour game day (environmental: daylight, evening peak).
// At each midnight-equivalent rollover (every 240 ticks, at 06:00 game time) the
// background economy settles WITHOUT interrupting play: rent, loyalty, merchant
// restocking, regulator permits/price, rival shopping, oil index step, a daily
// summary event. Contracts and requests carry across the rollover.

function beginOperating(s: SimState, ctx: Ctx, initial = false): void {
  s.phase = "operating";
  s.phaseStartTick = s.tick;
  s.phaseTick = 0;
  s.waveIndex = 0;
  s.waves = s.waves.filter((w) => w.status !== "completed");
  if (!initial) customersChooseProvider(s, ctx);
  s.stateVersion += 1;
  emit(s, ctx, "PHASE_CHANGED", ["player"], initial ? "The city is running. Outages arrive every 30 seconds." : `Day ${s.day} begins (06:00).`, { phase: "operating", day: s.day, durationTicks: TIMING.OPERATING_TICKS });
}

/** Non-blocking daily rollover: settle yesterday in the background, start today. */
function rolloverDay(s: SimState, ctx: Ctx): void {
  const report = settleDay(s, ctx, { continuous: true });
  attachHighlights(s, report, s.dayStats.notable);
  if (s.dayReports.length > 14) s.dayReports.splice(0, s.dayReports.length - 14);
  if (s.campaignDays > 0 && s.day >= s.campaignDays) {
    finishCampaign(s, ctx);
    return;
  }
  const scenario = SCENARIOS[s.scenarioId];
  s.day += 1;
  s.world.prevOilIndexCenti = s.world.oilIndexCenti;
  s.world.oilIndexCenti = oilForDay(scenario, s.day + (s.world.oilDayOffset ?? 0));
  s.player.co2TodayMg = 0;
  s.dayStats = freshDayStats(s);
  resetBusinessDay(s);
  resetRivalDay(s);
  emit(s, ctx, "DAY_STARTED", ["player"], `Day ${s.day}. The economy settled overnight; play continues.`, { day: s.day });
  const delta = s.world.oilIndexCenti - s.world.prevOilIndexCenti;
  emit(s, ctx, "OIL_INDEX_UPDATED", ["world"], `Oil index ${delta >= 0 ? "up" : "down"} ${Math.abs(delta / 100).toFixed(2)} to ${(s.world.oilIndexCenti / 100).toFixed(2)} (${scenario.oilSourceLabel}).`, {
    oilIndexCenti: s.world.oilIndexCenti,
    prevOilIndexCenti: s.world.prevOilIndexCenti,
    sourceLabel: scenario.oilSourceLabel,
  });
  regulatorMorning(s, ctx);
  merchantsMorning(s, ctx);
  beginOperating(s, ctx);
}

function finishCampaign(s: SimState, ctx: Ctx): void {
  s.phase = "finished";
  s.phaseStartTick = s.tick;
  s.phaseTick = 0;
  s.finished = true;
  s.stateVersion += 1;
  const sum = campaignSummary(s);
  emit(s, ctx, "CAMPAIGN_FINISHED", ["player"], `Simulation ended after ${s.dayReports.length} days. Net worth ${cr(sum.netWorthCc)}, reliability ${(sum.reliabilityBps / 100).toFixed(0)}%, city GDP ${cr(sum.cityGdpCc)}. Score ${sum.score}.`, { summary: sum });
}

/** Difficulty grows with progress (waves seen, capacity, served contracts), never with a forced day count. */
export function pressureLevel(s: SimState): 0 | 1 | 2 | 3 {
  if (s.wavesTotal <= TIMING.TUTORIAL_WAVES) return 0;
  const capacity = s.player.generatorIds.reduce((a, id) => a + s.generators[id].ratedW, 0);
  if (capacity >= 10_000 || s.day >= 3) return 3;
  if (s.day >= 2) return 2;
  return 1;
}

// ------------------------------------------------------------------ waves

function startWave(s: SimState, ctx: Ctx): void {
  s.waveIndex += 1;
  s.wavesTotal += 1;
  const idx = s.waveIndex;
  const tutorial = s.wavesTotal <= TIMING.TUTORIAL_WAVES;
  const evening = idx === 5 || idx === 6; // 18:00 and 21:00
  const pressure = pressureLevel(s);
  const wave: WaveState = {
    waveId: `wave_${s.wavesTotal}`,
    day: s.day,
    index: idx,
    startTick: s.tick,
    status: "outage_started",
    requestIds: [],
    tutorial,
    label: tutorial ? "tutorial" : evening ? "evening_peak" : "outage",
  };
  s.waves.push(wave);
  if (s.wavesTotal === TIMING.TUTORIAL_WAVES + 1 && s.tutorialStep !== "done") setTutorial(s, ctx, "done");
  const want = tutorial ? 1 : pressure >= 3 ? 3 : 2;
  const eligible = Object.values(s.businesses)
    .filter((b) => eligibleForOutage(s, b))
    .sort((a, b) => a.businessId.localeCompare(b.businessId));
  let picks: { id: string; hours: number; fixture?: { rateCcPerKwh: number } }[] = [];
  if (s.wavesTotal === 1 && s.businesses.cold_room && eligibleForOutage(s, s.businesses.cold_room)) {
    picks = [{ id: "cold_room", hours: 2, fixture: { rateCcPerKwh: 800 } }]; // design-doc fixture
  } else {
    const order = rngShuffle(s.rng, eligible.map((b) => b.businessId));
    for (const id of order.slice(0, want)) {
      let hours = tutorial ? rngRange(s.rng, 1, 2) : evening ? rngRange(s.rng, 2, 3) : rngRange(s.rng, 1, 3);
      if (evening && pressure >= 2) hours = Math.min(3, hours + 1);
      hours = Math.min(4, hours + worldModifiers(s).gridStressHours); // heatwave: outages last longer
      picks.push({ id, hours });
    }
  }
  emit(s, ctx, "WAVE_STARTED", ["world"], `Wave ${idx}/${TIMING.WAVES_PER_DAY}${evening ? " (evening peak)" : ""}: ${picks.length ? picks.map((p) => s.businesses[p.id].name).join(", ") : "no business"} lost grid power.`, {
    waveId: wave.waveId,
    index: idx,
    tutorial,
    businessIds: picks.map((p) => p.id),
  });
  for (const p of picks) {
    const b = s.businesses[p.id];
    // Tutorial customers are patient (no visible timer): the shop stays dark for up to 6 game hours
    // waiting for the player, then the grid returns and the request lapses. Bounded so that ignoring
    // the tutorial can never bankrupt a shop.
    b.outageUntilTick = s.tick + (tutorial ? Math.max(p.hours * 10, TIMING.TUTORIAL_PATIENCE_TICKS) : p.hours * 10);
    b.powerSource = "none";
    emit(s, ctx, "OUTAGE_STARTED", [`business:${b.businessId}`], `${b.name} went dark (grid outage for ${p.hours} game hour${p.hours > 1 ? "s" : ""}).`, { businessId: b.businessId, hours: p.hours, waveId: wave.waveId });
    const req = createRequest(s, ctx, wave, b, p.hours, p.fixture);
    if (req && b.provider === "rival" && s.day >= RIVAL.activeFromDay) {
      req.status = "lost_to_rival";
      rivalBid(s, ctx, req, "routed to its chosen provider");
      if (req.status === "lost_to_rival" && b.activeContractId) {
        s.dayStats.requestsOffered -= 1;
        s.dayStats.requestedOutageTicks -= req.durationHours * 10;
        s.totals.requestedOutageTicks -= req.durationHours * 10;
      } else {
        req.status = "open"; // rival could not serve: falls back to you
      }
    }
  }
  updateWaves(s, ctx);
}

function updateWaves(s: SimState, ctx: Ctx): void {
  for (const w of s.waves) {
    if (w.status === "completed") continue;
    const reqs = w.requestIds.map((id) => s.requests[id]);
    const contracts = Object.values(s.contracts).filter((c) => w.requestIds.includes(c.requestId) && c.provider === "player");
    let status: WaveState["status"];
    if (reqs.some((r) => r.status === "open")) status = "requests_open";
    else if (reqs.some((r) => r.status === "customer_countered") || contracts.some((c) => c.status === "pending_assignment")) status = "offers_pending";
    else if (contracts.some((c) => c.status === "active")) status = "service_active";
    else status = "completed";
    if (status !== w.status) {
      w.status = status;
      if (status === "completed") {
        const done = contracts.filter((c) => c.status === "completed").length;
        emit(s, ctx, "WAVE_COMPLETED", ["world"], `Wave ${w.index} resolved: ${done}/${reqs.length} request(s) served by you.`, { waveId: w.waveId, served: done, requests: reqs.length });
      }
    }
  }
}

// ------------------------------------------------------------------ contract lifecycle

/** A completed contract means the outage was served: the grid takes over again now. */
function endOutageOnCompletion(s: SimState, businessId: string): void {
  const b = s.businesses[businessId];
  if (b.outageUntilTick !== null && b.outageUntilTick > s.tick) b.outageUntilTick = s.tick;
}

function failContract(s: SimState, ctx: Ctx, c: ContractState, reason: string): void {
  if (c.status !== "active" && c.status !== "pending_assignment") return;
  c.status = "failed";
  c.failureReason = reason;
  const b = s.businesses[c.businessId];
  b.activeContractId = null;
  refundEscrow(s, ctx, c, `service dropped: ${reason}`);
  if (c.provider === "player") {
    b.loyaltyBps = Math.max(0, b.loyaltyBps - 1_500);
    s.player.reputationBps = Math.max(0, s.player.reputationBps - 300);
    s.player.districtTrustBps[b.districtId] = Math.max(0, (s.player.districtTrustBps[b.districtId] ?? 5_000) - 500);
    s.dayStats.contractsFailed += 1;
  } else {
    s.rival.reputationBps = Math.max(0, s.rival.reputationBps - 300);
  }
  emit(s, ctx, "CONTRACT_FAILED", [`business:${b.businessId}`, c.provider === "player" ? "player" : "rival"], `${c.provider === "player" ? "Your" : s.rival.name + "'s"} power to ${b.name} dropped (${reason}) after ${(c.deliveredWh / 1000).toFixed(2)} of ${((c.allottedW * c.durationHours) / 1000).toFixed(2)} kWh. Meter stopped; unearned escrow refunded${c.provider === "player" ? "; loyalty -15%, reputation -3%" : ""}.`, {
    contractId: c.contractId,
    reason,
    deliveredWh: c.deliveredWh,
    billedCc: c.billedCc,
    refundedCc: c.refundedCc,
  });
}

function completeContract(s: SimState, ctx: Ctx, c: ContractState): void {
  c.status = "completed";
  const b = s.businesses[c.businessId];
  b.activeContractId = null;
  endOutageOnCompletion(s, c.businessId);
  refundEscrow(s, ctx, c, "rounding remainder");
  if (c.provider === "player") {
    s.dayStats.contractsCompleted += 1;
    s.totals.contractsCompleted = (s.totals.contractsCompleted ?? 0) + 1;
    if (s.worldEvents?.active.length) s.totals.contractsDuringEvents = (s.totals.contractsDuringEvents ?? 0) + 1;
    if (c.generatorId && s.generators[c.generatorId]?.type === "solar") s.totals.solarContractsCompleted = (s.totals.solarContractsCompleted ?? 0) + 1;
    s.player.reputationBps = Math.min(10_000, s.player.reputationBps + 50);
    s.player.districtTrustBps[b.districtId] = Math.min(10_000, (s.player.districtTrustBps[b.districtId] ?? 5_000) + 100);
    if (s.tutorialStep === "watch_service") setTutorial(s, ctx, "done");
  }
  emit(s, ctx, "CONTRACT_COMPLETED", [`business:${b.businessId}`, c.provider === "player" ? "player" : "rival"], `${b.name} contract complete: ${(c.deliveredWh / 1000).toFixed(2)} kWh delivered, ${cr(c.billedCc)} credits billed, ${(c.fuelUsedMl / 1000).toFixed(2)} L burned, ${(c.co2Mg / 1e6).toFixed(2)} kg CO2.`, {
    contractId: c.contractId,
    deliveredWh: c.deliveredWh,
    billedCc: c.billedCc,
    fuelMl: c.fuelUsedMl,
    co2Mg: c.co2Mg,
    customerProfitPerHourCc: b.revenueCcPerPoweredHour - b.variableCostCcPerPoweredHour - Math.floor((b.demandW * c.rateCcPerKwh) / 1000),
  });
}

// ------------------------------------------------------------------ ticks

/** NPC policies re-run when the world changes; they are never overridden with a global price. */
function onWorldChange(s: SimState, ctx: Ctx, kind: "started" | "ended", e: WorldEventState): void {
  if (kind === "started" && e.effects.leadTimeDays) {
    for (const m of Object.values(s.merchants)) {
      if (m.pendingRestockMl > 0 && m.restockArrivesDay !== null) {
        m.restockArrivesDay += e.effects.leadTimeDays;
        emit(s, ctx, "MERCHANT_RESTOCK_ORDERED", [`merchant:${m.merchantId}`], `${m.name}'s ${(m.pendingRestockMl / 1000).toFixed(0)} L delivery slips to day ${m.restockArrivesDay} (${e.headline.replace(/ \(fictional.*\)$/, "")}).`, {
          merchantId: m.merchantId,
          quantityMl: m.pendingRestockMl,
          arrivesDay: m.restockArrivesDay,
          delayedBy: e.eventId,
        });
      }
    }
  }
  for (const m of Object.values(s.merchants)) repriceMerchant(s, ctx, m, `${kind === "started" ? "world event" : "world event ended"}: ${e.headline.replace(/ \(fictional.*\)$/, "")}`);
}

export function tickMut(s: SimState, ctx: Ctx): void {
  if (s.phase === "finished") return;
  ensureWorld(s);
  s.story ??= { completed: [] };
  worldTick(s, ctx, (kind, e) => onWorldChange(s, ctx, kind, e));
  // ---- operating
  const p = s.phaseTick;
  if (p % TIMING.WAVE_INTERVAL_TICKS === 0 && s.waveIndex < TIMING.WAVES_PER_DAY) startWave(s, ctx);

  for (const r of Object.values(s.requests)) {
    if ((r.status === "open" || r.status === "customer_countered") && r.deadlineTick !== null && s.tick >= r.deadlineTick) {
      r.status = "expired";
      r.resolutionReason = "timer ran out";
      const b = s.businesses[r.businessId];
      b.loyaltyBps = Math.max(0, b.loyaltyBps - 200);
      emit(s, ctx, "REQUEST_EXPIRED", [`business:${r.businessId}`], `${b.name}'s request timed out.`, { requestId: r.requestId });
      rivalBid(s, ctx, r, "your timer ran out");
    }
  }
  for (const r of Object.values(s.requests)) {
    if (r.status !== "open" && r.status !== "customer_countered") continue;
    const b = s.businesses[r.businessId];
    if (b.outageUntilTick !== null && s.tick >= b.outageUntilTick && b.activeContractId === null) {
      r.status = "expired";
      r.resolutionReason = "the grid came back before you connected";
      emit(s, ctx, "REQUEST_EXPIRED", [`business:${r.businessId}`], `${b.name} no longer needs you: grid power came back.`, { requestId: r.requestId, reason: "grid_restored" });
    }
  }
  for (const c of Object.values(s.contracts)) {
    if (c.status === "pending_assignment" && c.assignDeadlineTick !== null && s.tick >= c.assignDeadlineTick) {
      c.status = "expired";
      c.failureReason = "not assigned to a generator in time";
      s.businesses[c.businessId].activeContractId = null;
      s.businesses[c.businessId].loyaltyBps = Math.max(0, s.businesses[c.businessId].loyaltyBps - 300);
      refundEscrow(s, ctx, c, "never connected");
      emit(s, ctx, "CONTRACT_EXPIRED", [`business:${c.businessId}`], `You accepted ${s.businesses[c.businessId].name} but never connected a generator; escrow returned.`, { contractId: c.contractId });
    }
  }
  repairTick(s, ctx);

  const failures = dispatchTick(s, ctx);
  for (const f of failures) failContract(s, ctx, f.contract, f.reason);

  const deliveredBy = new Map<string, "player" | "rival">();
  for (const c of Object.values(s.contracts)) {
    if (c.status !== "active" || c.lastDeliveredTick !== s.tick) continue;
    deliveredBy.set(c.businessId, c.provider);
    if (!c.serviceStartedEmitted) {
      c.serviceStartedEmitted = true;
      const b = s.businesses[c.businessId];
      emit(s, ctx, "SERVICE_STARTED", [`business:${b.businessId}`, c.provider === "player" ? `generator:${c.generatorId}` : "rival"], `Power restored at ${b.name}: ${kW(c.allottedW)} kW flowing from ${c.provider === "player" ? s.generators[c.generatorId!].name : s.rival.name}. ${((c.allottedW * c.durationHours) / 1000).toFixed(1)} kWh scheduled.`, {
        contractId: c.contractId,
        businessId: b.businessId,
        generatorId: c.generatorId,
        provider: c.provider,
      });
      if (c.provider === "player") s.totals.servicesStarted = (s.totals.servicesStarted ?? 0) + 1;
      if (c.provider === "player" && s.tutorialStep === "assign_first") setTutorial(s, ctx, "watch_service");
    }
    if (c.provider === "player") {
      s.dayStats.servedOutageTicks += 1;
      s.totals.servedOutageTicks += 1;
    }
    if (c.deliveredTicks >= c.totalTicks) completeContract(s, ctx, c);
  }
  businessesTick(s, ctx, deliveredBy);

  for (const g of heatTick(s, ctx)) {
    for (const c of activeContractsOn(s, g.generatorId)) failContract(s, ctx, c, "GENERATOR_BROKEN");
  }

  if ((p + 1) % 10 === 0) hourlyEvents(s, ctx);
  updateWaves(s, ctx);
  storyTick(s, ctx);
  expireQuotes(s, ctx);
  if (s.phaseTick === RIVAL.buyAtMorningTick) rivalShop(s, ctx); // the rival restocks every morning at 09:00
  s.phaseTick += 1;
  s.tick += 1;
  if (s.phaseTick >= TIMING.OPERATING_TICKS) rolloverDay(s, ctx);
}

function hourlyEvents(s: SimState, ctx: Ctx): void {
  for (const c of Object.values(s.contracts)) {
    if (c.provider !== "player" || c.hourWh === 0) continue;
    emit(s, ctx, "ENERGY_DELIVERED", [`business:${c.businessId}`, `generator:${c.generatorId}`], `${(c.hourWh / 1000).toFixed(2)} kWh to ${s.businesses[c.businessId].name} this hour, billed ${cr(c.hourBilledCc)} credits.`, {
      contractId: c.contractId,
      wh: c.hourWh,
      billedCc: c.hourBilledCc,
      fuelMl: c.hourFuelMl,
      totalDeliveredWh: c.deliveredWh,
    });
    c.hourWh = 0;
    c.hourFuelMl = 0;
    c.hourBilledCc = 0;
  }
  if (s.dayStats.hourFuelMl > 0) {
    emit(s, ctx, "FUEL_CONSUMED", ["player"], `Burned ${(s.dayStats.hourFuelMl / 1000).toFixed(2)} L of diesel this hour (0.3 L per kWh). Tank: ${(bal(s, "fuel_ml", ACC.player) / 1000).toFixed(2)} L.`, {
      fuelMl: s.dayStats.hourFuelMl,
      tankMl: bal(s, "fuel_ml", ACC.player),
    });
    emit(s, ctx, "CO2_EMITTED", ["player"], `Emitted ${(s.dayStats.hourCo2Mg / 1e6).toFixed(3)} kg CO2 (2.68 kg per L), retiring that much permit allowance. ${(bal(s, "permit_mg", ACC.player) / 1e6).toFixed(2)} kg left.`, {
      co2Mg: s.dayStats.hourCo2Mg,
      allowanceLeftMg: bal(s, "permit_mg", ACC.player),
    });
    s.dayStats.hourFuelMl = 0;
    s.dayStats.hourCo2Mg = 0;
  }
  if (s.battery) {
    emit(s, ctx, "BATTERY_UPDATED", ["player"], `Battery at ${(s.battery.storedWh / 1000).toFixed(2)} / ${(s.battery.capacityWh / 1000).toFixed(0)} kWh.`, { storedWh: s.battery.storedWh, capacityWh: s.battery.capacityWh });
  }
}

// ------------------------------------------------------------------ actions

function assignContract(s: SimState, ctx: Ctx, contractId: string, generatorId: string): ContractState {
  if (s.phase !== "operating") throw new SimError("INVALID_PHASE", "Generators can only be assigned during the operating day.");
  const c = s.contracts[contractId];
  if (!c || c.provider !== "player") throw new SimError("NOT_FOUND", `Unknown contract ${contractId}`);
  if (c.status !== "pending_assignment") throw new SimError("ALREADY_PROCESSED", `Contract is ${c.status}.`);
  validateAssignment(s, c, generatorId);
  c.generatorId = generatorId;
  c.status = "active";
  c.startTick = s.tick;
  c.assignDeadlineTick = null;
  const g = s.generators[generatorId];
  emit(s, ctx, "LOAD_ASSIGNED", [`generator:${generatorId}`, `business:${c.businessId}`], `${kW(c.allottedW)} kW of ${s.businesses[c.businessId].name} routed to ${g.name}. Power starts on the next tick.`, {
    contractId,
    generatorId,
    allottedW: c.allottedW,
    generatorAssignedW: activeContractsOn(s, generatorId).reduce((a, x) => a + x.allottedW, 0),
    ratedW: g.ratedW,
  });
  return c;
}

export function applyActionMut(s: SimState, ctx: Ctx, action: AnyAction, meta: ActionMeta): Record<string, unknown> {
  ensureWorld(s);
  if (s.phase === "finished" && action.type !== "SETTLE_TRADE" && action.type !== "MARKET_LISTING_RESULT") throw new SimError("RUN_FINISHED", "This campaign has finished.");
  let result: Record<string, unknown> = {};
  switch (action.type) {
    case "ACCEPT_REQUEST": {
      const c = acceptRequest(s, ctx, action.requestId);
      if (action.generatorId) assignContract(s, ctx, c.contractId, action.generatorId);
      result = { contractId: c.contractId, status: c.status };
      break;
    }
    case "COUNTER_REQUEST": {
      const r = counterRequest(s, ctx, action.requestId, action.rateCcPerKwh);
      if (r.rejected) rivalBid(s, ctx, s.requests[action.requestId], "the customer walked away from your price");
      result = { accepted: r.accepted, contractId: r.contract?.contractId ?? null, customerOfferCcPerKwh: r.customerOffer ?? null, rejected: !!r.rejected };
      break;
    }
    case "DECLINE_REQUEST": {
      const r = declineRequest(s, ctx, action.requestId);
      rivalBid(s, ctx, r, "you declined");
      result = { requestId: r.requestId, status: r.status };
      break;
    }
    case "ASSIGN_CONTRACT": {
      const c = assignContract(s, ctx, action.contractId, action.generatorId);
      result = { contractId: c.contractId, generatorId: c.generatorId };
      break;
    }
    case "CANCEL_CONTRACT": {
      const c = s.contracts[action.contractId];
      if (!c || c.provider !== "player") throw new SimError("NOT_FOUND", `Unknown contract ${action.contractId}`);
      if (c.status !== "active" && c.status !== "pending_assignment") throw new SimError("ALREADY_PROCESSED", `Contract is ${c.status}.`);
      const b = s.businesses[c.businessId];
      c.status = "cancelled";
      c.failureReason = "cancelled by player";
      b.activeContractId = null;
      b.loyaltyBps = Math.max(0, b.loyaltyBps - 1_000);
      refundEscrow(s, ctx, c, "cancelled by you");
      emit(s, ctx, "CONTRACT_CANCELLED", ["player", `business:${b.businessId}`], `You cut power to ${b.name}. It paid only for ${(c.deliveredWh / 1000).toFixed(2)} kWh delivered; loyalty -10%.`, { contractId: c.contractId });
      result = { contractId: c.contractId };
      break;
    }
    case "REQUEST_QUOTE": {
      const q = createQuote(s, ctx, ACC.player, action.sellerId, action.item, action.quantity);
      result = { quoteId: q.quoteId };
      break;
    }
    case "BUY": {
      const q = s.quotes[action.quoteId];
      const t = buy(s, ctx, ACC.player, action.quoteId, action.quantity, meta.idempotencyKey, {
        chainLeg: !!meta.chainLeg && q?.item === "diesel",
        tokenId: meta.tokenId,
      });
      result = { tradeId: t.tradeId, chainStatus: t.chainStatus };
      break;
    }
    case "CREATE_PLAYER_LISTING":
      result = createPlayerListing(s, ctx, action);
      break;
    case "CANCEL_PLAYER_LISTING":
      result = cancelPlayerListing(s, ctx, action.listingId);
      break;
    case "SET_TARIFF": {
      const d = s.districts[action.districtId];
      if (!d || !d.unlocked) throw new SimError("NOT_FOUND", `District ${action.districtId} is not available.`);
      if (action.rateCcPerKwh < 100 || action.rateCcPerKwh > 3_000) throw new SimError("VALIDATION_FAILED", "Tariff must be between 1 and 30 credits/kWh.");
      const old = s.player.tariffs[d.districtId];
      s.player.tariffs[d.districtId] = action.rateCcPerKwh;
      const members = Object.values(s.businesses).filter((b) => b.districtId === d.districtId);
      const hints = members.map((b) => `${b.name} break-even ${cr(breakEvenRate(b))}`).join("; ");
      emit(s, ctx, "TARIFF_SET", ["player"], `${d.name} tariff ${cr(old)} → ${cr(action.rateCcPerKwh)} credits/kWh. Applies to new requests. ${hints}.`, { districtId: d.districtId, oldCcPerKwh: old, newCcPerKwh: action.rateCcPerKwh });
      result = { districtId: d.districtId, rateCcPerKwh: action.rateCcPerKwh };
      break;
    }
    case "SERVICE_GENERATOR": {
      const g = s.generators[action.generatorId];
      if (!g || g.type !== "diesel") throw new SimError("NOT_FOUND", "Only diesel generators need servicing.");
      if (g.status !== "online") throw new SimError("GENERATOR_OFFLINE", `${g.name} is already ${g.status}.`);
      transfer(s, ctx, "credits_cc", ACC.player, ACC.equipment, PHYSICS.SERVICE_COST_CC, "generator_service", g.generatorId);
      s.dayStats.spendCc += PHYSICS.SERVICE_COST_CC;
      if (activeContractsOn(s, g.generatorId).length) throw new SimError("INVALID_STATE", `${g.name} is serving customers; finish or cancel its contracts before servicing.`);
      g.status = "maintenance";
      g.offlineUntilTick = s.tick + PHYSICS.SERVICE_DOWNTIME_TICKS;
      g.whSinceService = 0;
      g.wearBps = 0;
      g.heatPermille = 0;
      emit(s, ctx, "GENERATOR_SERVICED", [`generator:${g.generatorId}`], `${g.name} serviced for ${cr(PHYSICS.SERVICE_COST_CC)} credits: wear reset. Offline for ${PHYSICS.SERVICE_DOWNTIME_TICKS / 10} game hours.`, { generatorId: g.generatorId, costCc: PHYSICS.SERVICE_COST_CC });
      result = { generatorId: g.generatorId };
      break;
    }
    case "BUY_UPGRADE": {
      const base = UPGRADES.find((x) => x.upgradeId === action.upgradeId)!;
      const u = { ...base, costCc: upgradeCostCc(s, base.upgradeId, base.costCc) };
      if (s.player.upgradesOwned.includes(u.upgradeId)) throw new SimError("ALREADY_PROCESSED", `${u.name} already installed.`);
      transfer(s, ctx, "credits_cc", ACC.player, ACC.equipment, u.costCc, "upgrade_purchase", u.upgradeId);
      s.dayStats.spendCc += u.costCc;
      s.player.upgradesOwned.push(u.upgradeId);
      if (u.upgradeId === "solar_2kw") {
        s.generators.solar_1 = { generatorId: "solar_1", name: "Rooftop Solar 2kW", type: "solar", ownerId: "player", ratedW: 2_000, heatPermille: 0, wearBps: 0, status: "online", offlineUntilTick: null, cumulativeWh: 0, cumulativeFuelMl: 0, outputW: 0, heatWarned: false, nftTokenId: null, whSinceService: 0, maintenanceTicks: 0 };
        s.player.generatorIds.push("solar_1");
      } else if (u.upgradeId === "diesel_5kw") {
        s.generators.gen_2 = { generatorId: "gen_2", name: "Second Diesel 5kW", type: "diesel", ownerId: "player", ratedW: 5_000, heatPermille: 0, wearBps: 0, status: "online", offlineUntilTick: null, cumulativeWh: 0, cumulativeFuelMl: 0, outputW: 0, heatWarned: false, nftTokenId: null, whSinceService: 0, maintenanceTicks: 0 };
        s.player.generatorIds.push("gen_2");
      } else {
        s.battery = { batteryId: "battery_1", capacityWh: 10_000, storedWh: 0, maxChargeW: 2_500, maxDischargeW: 2_500, roundTripEfficiencyBps: 9_000, chargeW: 0, dischargeW: 0, chargeRemainderDeciWh: 0 };
        s.player.batteryId = "battery_1";
      }
      emit(s, ctx, "UPGRADE_PURCHASED", ["player", "world:equipment"], `Installed ${u.name} for ${cr(u.costCc)} credits. ${u.description}`, { upgradeId: u.upgradeId, costCc: u.costCc });
      result = { upgradeId: u.upgradeId };
      break;
    }
    case "UNLOCK_DISTRICT": {
      const d = s.districts[action.districtId];
      if (!d) throw new SimError("NOT_FOUND", `Unknown district ${action.districtId}`);
      if (d.unlocked) throw new SimError("ALREADY_PROCESSED", `${d.name} already unlocked.`);
      const cap = s.player.generatorIds.reduce((a, id) => a + s.generators[id].ratedW, 0);
      if (cap < d.unlockRequirementW) throw new SimError("REQUIREMENT_NOT_MET", `${d.name} needs ${kW(d.unlockRequirementW)} kW of capacity; you have ${kW(cap)} kW.`, { requiredW: d.unlockRequirementW, haveW: cap });
      transfer(s, ctx, "credits_cc", ACC.player, ACC.equipment, d.unlockCostCc, "district_unlock", d.districtId);
      s.dayStats.spendCc += d.unlockCostCc;
      d.unlocked = true;
      s.player.unlockedDistrictIds.push(d.districtId);
      emit(s, ctx, "DISTRICT_UNLOCKED", ["player"], `${d.name} unlocked for ${cr(d.unlockCostCc)} credits. Its businesses can now request your power.`, { districtId: d.districtId });
      result = { districtId: d.districtId };
      break;
    }
    case "READY":
      throw new SimError("INVALID_PHASE", "The world runs continuously; there is no phase to skip.");
    case "SETTLE_TRADE": {
      const t = settleTrade(s, ctx, action.tradeId, action.outcome, action.txHash, action.error);
      result = { tradeId: t.tradeId, chainStatus: t.chainStatus };
      break;
    }
    case "RESERVE_MARKET_PURCHASE":
      result = reserveMarketPurchase(s, ctx, action.listingId, action.merchantId);
      break;
    case "EXPIRE_MARKET_LISTING":
      result = expirePlayerListing(s, ctx, action.listingId);
      break;
    case "MARKET_LISTING_RESULT":
      result = settlePlayerListing(s, ctx, action);
      break;
    case "PAUSE":
    case "RESUME":
      throw new SimError("INVALID_STATE", "Pause/resume is handled by the server driver, not the simulation.");
  }
  s.stateVersion += 1;
  updateWavesIfOperating(s, ctx);
  return result;
}

function updateWavesIfOperating(s: SimState, ctx: Ctx): void {
  if (s.phase === "operating") updateWaves(s, ctx);
}

// ------------------------------------------------------------------ pure wrappers

export function applyAction(state: SimState, action: AnyAction, meta: ActionMeta): ActionOutcome {
  const s = clone(state);
  const ctx = newCtx(s);
  const result = applyActionMut(s, ctx, action, meta);
  return { state: s, events: ctx.events, ledger: ctx.ledger, result };
}

export function tick(state: SimState): StepResult {
  const s = clone(state);
  const ctx = newCtx(s);
  tickMut(s, ctx);
  return { state: s, events: ctx.events, ledger: ctx.ledger };
}

/**
 * nextState(state, actions): applies each action in order (failed actions are
 * reported, not applied), then advances exactly one tick. Pure.
 */
export function nextState(
  state: SimState,
  actions: { action: AnyAction; meta: ActionMeta }[],
): StepResult & { results: ({ ok: true; result: Record<string, unknown> } | { ok: false; code: string; message: string })[] } {
  const s = clone(state);
  const ctx = newCtx(s);
  const results: ({ ok: true; result: Record<string, unknown> } | { ok: false; code: string; message: string })[] = [];
  for (const a of actions) {
    const snapshot = clone(s);
    const evLen = ctx.events.length;
    const ldLen = ctx.ledger.length;
    try {
      results.push({ ok: true, result: applyActionMut(s, ctx, a.action, a.meta) });
    } catch (e) {
      if (!(e instanceof SimError)) throw e;
      Object.assign(s, snapshot);
      ctx.events.length = evLen;
      ctx.ledger.length = ldLen;
      results.push({ ok: false, code: e.code, message: e.message });
    }
  }
  tickMut(s, ctx);
  return { state: s, events: ctx.events, ledger: ctx.ledger, results };
}

export { newId };
