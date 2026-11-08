/**
 * GameStatePublic projection. Strips RNG state, ledger internals and anything
 * that would reveal the future (there is no pre-rolled schedule to leak: waves are
 * rolled when they start). Every number the UI shows comes from here.
 */
import { CO2_MG_PER_ML, PERMIT_MG, ccForEnergy, type ChainInfo, type GameStatePublic } from "@blackout/shared";
import { BRENT_DATASET, GRID, OWNERS, OIL_PASS_THROUGH_BPS, SCENARIOS, SOLAR_PROFILE_BPS, TIMING, UPGRADES, brentWeekForDay } from "./config.ts";
import { pressureLevel, upgradeCostCc } from "./engine.ts";
import { describeEffects, worldModifiers } from "./world-events/engine.ts";
import type { WorldEventState } from "./world-events/types.ts";
import { CHAPTERS, CHARACTERS } from "./story.ts";
import { ACC, bal } from "./ledger.ts";
import { assignedW, generatorAvailableW, reservedFuelMl, reservedPermitMg } from "./electricity.ts";
import { breakEvenRate, businessCash, moodOf, profitPerHourAt, tutorialHint } from "./customers.ts";
import { merchantCash, merchantStock, oilTrend, pendingFuelFor } from "./market.ts";
import { playerFreeFuelMl, playerListingDecisions } from "./policies/playerMarket.ts";
import { campaignSummary } from "./economy.ts";
import { exchangeDepositableFuelMl } from "./exchangeCity.ts";
import { goalsForView } from "./goals.ts";
import { companyView, districtFeeder, feederLoadW } from "./company.ts";
import type { SimState } from "./state.ts";

export interface ViewOptions {
  paused?: boolean;
  pauseReason?: GameStatePublic["clock"]["pauseReason"];
  chain?: ChainInfo;
  explorerTxBase?: string | null;
  /** Limit history arrays to keep payloads small. */
  maxRequests?: number;
}

const DEFAULT_CHAIN: ChainInfo = {
  mode: "disabled",
  network: null,
  resourceContractId: null,
  vaultAccountId: null,
  note: "This guest city uses the game ledger and is not connected to NEAR.",
};

const pubEvent = (s: SimState, e: WorldEventState) => ({
  eventId: e.eventId,
  flash: !!e.flash,
  templateId: e.templateId,
  category: e.category,
  headline: e.headline,
  explanation: e.explanation,
  assumption: e.assumption,
  sourceType: e.sourceType,
  verification: e.verification,
  sourceTitle: e.sourceTitle,
  sourceUrl: e.sourceUrl,
  publishedAt: e.publishedAt,
  region: e.region,
  effects: { ...e.effects },
  startTick: e.startTick,
  endTick: e.endTick,
  startDay: e.startDay,
  phase: e.phase,
  effectNotes: describeEffects(e.effects, s.scenarioId === "oil_shock_2026"),
});

export function toPublic(s: SimState, opts: ViewOptions = {}): GameStatePublic {
  const phaseDuration = s.phase === "operating" ? TIMING.OPERATING_TICKS : 0;
  const minute = s.phase === "operating" ? (TIMING.DAY_START_MINUTE + s.phaseTick * 6) % 1440 : null;
  const nextWaveTick =
    s.phase !== "operating" ? null : s.waveIndex < TIMING.WAVES_PER_DAY ? s.phaseStartTick + s.waveIndex * TIMING.WAVE_INTERVAL_TICKS : s.phaseStartTick + TIMING.OPERATING_TICKS;
  const scenario = SCENARIOS[s.scenarioId];
  const fuel = bal(s, "fuel_ml", ACC.player);
  const maxReq = opts.maxRequests ?? 40;
  const requests = Object.values(s.requests).filter((r) => r.day === s.day || r.status === "open" || r.status === "customer_countered").slice(-maxReq);
  const contracts = Object.values(s.contracts).filter((c) => c.day === s.day || c.status === "active" || c.status === "pending_assignment").slice(-maxReq);

  return {
    schemaVersion: "blackout.state.v1",
    run: {
      runId: s.runId,
      ownerId: s.ownerId,
      seed: s.seed,
      scenarioId: s.scenarioId,
      scenarioVersion: s.scenarioVersion,
      mode: s.mode,
      stateVersion: s.stateVersion,
      chainMode: s.chainMode,
      challengeWeek: s.challengeWeek ?? null,
    },
    clock: {
      day: s.day,
      campaignDays: s.campaignDays,
      wavesTotal: s.wavesTotal,
      pressureLevel: pressureLevel(s),
      daylightBps: minute === null ? 0 : SOLAR_PROFILE_BPS[Math.floor(minute / 60)],
      phase: s.phase,
      tick: s.tick,
      phaseTick: s.phaseTick,
      phaseDurationTicks: phaseDuration,
      gameMinuteOfDay: minute,
      gameHourIndex: s.phase === "operating" ? Math.floor(s.phaseTick / 10) : null,
      paused: s.phase === "finished" ? true : (opts.paused ?? false),
      pauseReason: s.phase === "finished" ? "finished" : (opts.pauseReason ?? "none"),
      tutorial: s.wavesTotal <= TIMING.TUTORIAL_WAVES && s.phase === "operating",
      nextWaveTick,
    },
    player: {
      creditsCc: bal(s, "credits_cc", ACC.player),
      reputationBps: s.player.reputationBps,
      districtTrustBps: { ...s.player.districtTrustBps },
      fuelMl: fuel,
      fuelReservedMl: reservedFuelMl(s, "player"),
      tankCapacityMl: s.player.tankCapacityMl,
      permitAllowanceMg: bal(s, "permit_mg", ACC.player),
      permitReservedMg: reservedPermitMg(s, "player"),
      co2TodayMg: s.player.co2TodayMg,
      co2TotalMg: s.player.co2TotalMg,
      tariffsCcPerKwh: { ...s.player.tariffs },
      generatorIds: [...s.player.generatorIds],
      batteryId: s.player.batteryId,
      unlockedDistrictIds: [...s.player.unlockedDistrictIds],
      upgradesOwned: [...s.player.upgradesOwned],
      pendingFuelMl: pendingFuelFor(s, ACC.player),
      listableFuelMl: s.chainMode === "testnet" ? Math.floor(Math.min(s.player.chainBackedFuelMl ?? 0, playerFreeFuelMl(s)) / 100) * 100 : 0,
      exchangeDepositableFuelMl: exchangeDepositableFuelMl(s),
      exchangeReservedCc: bal(s, "credits_cc", ACC.escrowExchange),
    },
    generators: s.player.generatorIds.map((id) => {
      const g = s.generators[id];
      const a = assignedW(s, id);
      return {
        generatorId: g.generatorId,
        name: g.name,
        type: g.type,
        ownerId: g.ownerId,
        ratedW: g.ratedW,
        availableW: generatorAvailableW(s, g),
        assignedW: a,
        outputW: g.outputW,
        loadBps: g.ratedW ? Math.floor((a * 10_000) / g.ratedW) : 0,
        heatPermille: g.heatPermille,
        wearBps: g.wearBps,
        status: g.status,
        offlineUntilTick: g.offlineUntilTick,
        cumulativeWh: g.cumulativeWh,
        cumulativeFuelMl: g.cumulativeFuelMl,
        nftTokenId: g.nftTokenId,
      };
    }),
    battery: s.battery
      ? {
          batteryId: s.battery.batteryId,
          capacityWh: s.battery.capacityWh,
          storedWh: s.battery.storedWh,
          maxChargeW: s.battery.maxChargeW,
          maxDischargeW: s.battery.maxDischargeW,
          roundTripEfficiencyBps: s.battery.roundTripEfficiencyBps,
          chargingFrom: s.battery.chargeW > 0 ? "solar" : "none",
          dischargeW: s.battery.dischargeW,
          chargeW: s.battery.chargeW,
        }
      : null,
    districts: Object.values(s.districts).map((d) => {
      const members = Object.values(s.businesses).filter((b) => b.districtId === d.districtId);
      const open = members.filter((b) => b.status !== "closed");
      const powered = open.filter((b) => b.powerSource !== "none").length;
      return {
        districtId: d.districtId,
        name: d.name,
        unlocked: d.unlocked,
        unlockRequirementW: d.unlockRequirementW,
        unlockCostCc: d.unlockCostCc,
        activityIndexBps: d.activityIndexBps,
        outsideDemandCcPerHour: d.outsideDemandCcPerHour,
        poweredBps: open.length ? Math.floor((powered * 10_000) / open.length) : 0,
        reliabilityTodayBps: d.outageTicksToday ? Math.floor((d.servedOutageTicksToday * 10_000) / d.outageTicksToday) : 10_000,
        businessIds: members.map((b) => b.businessId),
        payBehaviour: d.payBehaviour,
        ...(() => {
          const f = districtFeeder(d);
          return {
            substationLevel: f.level,
            feederCapacityW: f.capacityW,
            feederLoadW: feederLoadW(s, d.districtId),
            lossBps: f.lossBps,
            requiredStage: f.requiredStage,
            nextUpgradeCostCc: f.nextUpgradeCostCc,
            nextCapacityW: f.nextCapacityW,
            totalDemandW: members.reduce((a, b) => a + b.demandW, 0),
          };
        })(),
      };
    }),
    businesses: Object.values(s.businesses).map((b) => ({
      businessId: b.businessId,
      districtId: b.districtId,
      name: b.name,
      owner: OWNERS[b.businessId] ?? null,
      kind: b.kind,
      demandW: b.demandW,
      cashCc: businessCash(s, b),
      revenueCcPerPoweredHour: b.revenueCcPerPoweredHour,
      variableCostCcPerPoweredHour: b.variableCostCcPerPoweredHour,
      fixedCostCcPerDay: b.fixedCostCcPerDay,
      breakEvenRateCcPerKwh: breakEvenRate(b),
      loyaltyBps: b.loyaltyBps,
      status: b.status,
      powerSource: b.powerSource,
      provider: b.provider,
      lowCashSettlements: b.lowCashSettlements,
      mood: moodOf(s, b),
      activeContractId: b.activeContractId,
      outageUntilTick: b.outageUntilTick,
      gougeCount: b.gougeCount,
      history: b.history.slice(-7),
    })),
    requests: requests.map((r) => {
      const b = s.businesses[r.businessId];
      const wh = r.requestedW * r.durationHours;
      // line losses on longer feeders burn extra diesel for the same delivered energy
      const fuelMl = Math.ceil(((wh * 3) / 10) * (10_000 + districtFeeder(s.districts[r.districtId]).lossBps) / 10_000);
      const co2 = fuelMl * CO2_MG_PER_ML;
      const pay = ccForEnergy(wh, r.offerRateCcPerKwh);
      const fuelCost = Math.round((fuelMl * s.player.fuelCostBasisCcPerL) / 1000);
      const carbonCost = Math.round((co2 * s.regulator.permitPriceCc) / PERMIT_MG);
      return {
        requestId: r.requestId,
        waveId: r.waveId,
        businessId: r.businessId,
        districtId: r.districtId,
        requestedW: r.requestedW,
        durationHours: r.durationHours,
        offerRateCcPerKwh: r.offerRateCcPerKwh,
        counterCount: r.counterCount,
        maxCounters: r.maxCounters,
        lastPlayerCounterCcPerKwh: r.lastPlayerCounterCcPerKwh,
        status: r.status,
        createdTick: r.createdTick,
        urgency: r.urgency ?? "normal",
        deadlineTick: r.deadlineTick,
        expectedEnergyWh: wh,
        expectedPaymentCc: pay,
        estimatedFuelMl: fuelMl,
        estimatedCo2Mg: co2,
        estimatedFuelCostCc: fuelCost,
        estimatedMarginCc: pay - fuelCost - carbonCost,
        customerProfitPerHourCc: profitPerHourAt(b, r.offerRateCcPerKwh),
        message: r.message,
        resolutionReason: r.resolutionReason,
      };
    }),
    contracts: contracts.map((c) => ({
      contractId: c.contractId,
      requestId: c.requestId,
      businessId: c.businessId,
      generatorId: c.generatorId,
      provider: c.provider,
      allottedW: c.allottedW,
      rateCcPerKwh: c.rateCcPerKwh,
      durationHours: c.durationHours,
      totalTicks: c.totalTicks,
      deliveredTicks: c.deliveredTicks,
      startTick: c.startTick,
      assignDeadlineTick: c.assignDeadlineTick,
      deliveredWh: c.deliveredWh,
      billedCc: c.billedCc,
      escrowCc: c.escrowCc,
      refundedCc: c.refundedCc,
      fuelUsedMl: c.fuelUsedMl,
      co2Mg: c.co2Mg,
      status: c.status,
      failureReason: c.failureReason,
      remainingGameHours: (c.totalTicks - c.deliveredTicks) / 10,
    })),
    merchants: Object.values(s.merchants).map((m) => ({
      merchantId: m.merchantId,
      name: m.name,
      style: m.style,
      policyId: m.policyId,
      accountId: m.accountId,
      status: m.status,
      stockMl: merchantStock(s, m),
      reservedMl: Object.values(s.trades)
        .filter((t) => t.sellerId === ACC.merchant(m.merchantId) && t.status === "reserved")
        .reduce((a, t) => a + t.quantity, 0),
      targetStockMl: m.targetStockMl,
      cashCc: merchantCash(s, m),
      pendingRestockMl: m.pendingRestockMl,
      restockArrivesDay: m.restockArrivesDay,
      salesTodayMl: m.salesTodayMl,
      lastDaySalesMl: m.lastDaySalesMl,
      quoteCcPerL: m.quoteCcPerL,
      reasons: m.reasons,
      priceHistory: m.priceHistory.slice(-30),
    })),
    rival: {
      rivalId: s.rival.rivalId,
      name: s.rival.name,
      accountId: s.rival.accountId,
      ratedW: s.rival.ratedW,
      assignedW: Object.values(s.contracts).filter((c) => c.provider === "rival" && c.status === "active").reduce((a, c) => a + c.allottedW, 0),
      fuelMl: bal(s, "fuel_ml", ACC.rival),
      permitAllowanceMg: bal(s, "permit_mg", ACC.rival),
      cashCc: bal(s, "credits_cc", ACC.rival),
      tariffCcPerKwh: s.rival.tariffCcPerKwh,
      tariffReasons: s.rival.tariffReasons,
      activeContractIds: Object.values(s.contracts).filter((c) => c.provider === "rival" && c.status === "active").map((c) => c.contractId),
      solarW: s.rival.solarW ?? 0,
      stockpileDays: s.rival.stockpileDays ?? 0,
      customersServedToday: s.rival.customersServedToday,
      contractsWon: s.rival.contractsWon,
      contractsDeclined: s.rival.contractsDeclined,
      reputationBps: s.rival.reputationBps,
      lastAction: s.rival.lastAction,
    },
    regulator: {
      permitPriceCc: s.regulator.permitPriceCc,
      permitsForSaleToday: Math.floor(bal(s, "permit_mg", ACC.regulator) / PERMIT_MG),
      dailyCapPermits: s.regulator.dailyCapPermits,
      permitsSoldTotal: s.regulator.permitsSoldTotal,
      emissionsTodayMg: s.regulator.emissionsTodayMg,
      priceReason: s.regulator.priceReason,
      notices: s.regulator.notices.slice(-5),
    },
    world: {
      scenarioId: s.scenarioId,
      scenarioName: scenario.name,
      oilIndexCenti: s.world.oilIndexCenti,
      referenceIndexCenti: s.world.referenceIndexCenti,
      oilTrend: oilTrend(s),
      oilSourceLabel: scenario.oilSourceLabel,
      observedBrent: (() => {
        const w = brentWeekForDay(s.scenarioId, s.day + (s.world.oilDayOffset ?? 0));
        return w ? { weekStart: w.weekStart, usdPerBarrel: w.usdPerBarrel, sourceUrl: BRENT_DATASET.sourceUrl } : null;
      })(),
      oilPassThroughBps: OIL_PASS_THROUGH_BPS,
      gridTariffCcPerKwh: GRID.tariffCcPerKwh,
      eventMode: s.worldEvents?.mode ?? "calm",
      eventPreset: s.worldEvents?.preset ?? null,
      modifiers: worldModifiers(s),
      activeEvents: (s.worldEvents?.active ?? []).map((e) => pubEvent(s, e)),
      eventHistory: (s.worldEvents?.history ?? []).slice(-10).map((e) => pubEvent(s, e)),
      brentWeekly: s.scenarioId === "oil_shock_2026" ? BRENT_DATASET.weekly2026 : [],
    },
    waves: s.waves.map((w) => ({ ...w, requestIds: [...w.requestIds] })),
    quotes: Object.values(s.quotes)
      .filter((q) => q.buyerId === ACC.player)
      .slice(-10)
      .map((q) => ({
        quoteId: q.quoteId,
        sellerId: q.sellerId,
        item: q.item,
        unitPriceCc: q.unitPriceCc,
        maxQuantity: q.maxQuantity,
        createdTick: q.createdTick,
        expiresTick: q.expiresTick,
        marketVersion: q.marketVersion,
        status: q.status === "open" && s.tick >= q.expiresTick ? "expired" : q.status,
        reasons: q.reasons,
      })),
    trades: Object.values(s.trades)
      .filter((t) => t.buyerId === ACC.player)
      .slice(-20)
      .map((t) => ({
        tradeId: t.tradeId,
        quoteId: t.quoteId,
        idempotencyKey: t.idempotencyKey,
        buyerId: t.buyerId,
        sellerId: t.sellerId,
        item: t.item,
        quantity: t.quantity,
        unitPriceCc: t.unitPriceCc,
        totalCc: t.totalCc,
        status: t.status,
        chainStatus: t.chainStatus,
        tokenId: t.tokenId,
        tokenAmount: t.tokenAmount,
        txHash: t.txHash,
        explorerUrl: t.txHash && opts.explorerTxBase ? `${opts.explorerTxBase}${t.txHash}` : null,
        error: t.error,
        createdTick: t.createdTick,
        settledTick: t.settledTick,
      })),
    marketListings: (s.marketListings ?? []).map((listing) => ({
      listingId: listing.listingId,
      tokenId: "DIESEL_100ML" as const,
      quantityMl: listing.quantityMl,
      unitPriceCcPerL: listing.unitPriceCcPerL,
      totalCc: listing.totalCc,
      status: listing.status,
      createdTick: listing.createdTick,
      expiresTick: listing.expiresTick,
      buyerMerchantId: listing.buyerMerchantId,
      decisionReasons: listing.status === "purchase_pending" || listing.status === "filled"
        ? (listing.decisionReasons ?? playerListingDecisions(s, listing))
        : playerListingDecisions(s, listing),
      error: listing.error,
    })),
    dayReports: s.dayReports.map((r) => ({ ...r })),
    campaign: campaignSummary(s),
    tutorial: { active: s.tutorialStep !== "done", step: s.tutorialStep, hint: tutorialHint(s.tutorialStep) },
    story: {
      chapters: CHAPTERS.map((c) => ({
        id: c.id,
        title: c.title,
        goal: c.goal,
        character: CHARACTERS[c.character].name,
        characterRole: CHARACTERS[c.character].role,
        beat: c.beat,
        done: !!s.story?.completed.includes(c.id),
      })),
      currentChapterId: CHAPTERS.find((c) => !s.story?.completed.includes(c.id))?.id ?? null,
    },
    goals: goalsForView(s),
    company: companyView(s),
    chain: opts.chain ?? DEFAULT_CHAIN,
    upgradesCatalog: UPGRADES.map((u) => ({ ...u, baseCostCc: u.costCc, costCc: upgradeCostCc(s, u.upgradeId, u.costCc), owned: s.player.upgradesOwned.includes(u.upgradeId) })),
    lastEventSeq: s.eventSeq,
  };
}
