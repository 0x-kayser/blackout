/**
 * RegionState → RegionView: everything the 3D client shows, already explained in words.
 */
import type { ActorView, CorridorView, NodeView, PlantView, PriceComponent, RegionView, SettlementEpochView, TechView } from "@blackout/shared";
import { TECH_IDS } from "@blackout/shared";
import { ACTORS, BANKS, BATTERY_EFF_BPS, CORRIDORS, EPOCH_INTERVALS, LICENCES, NODES, OWNERS, PARTS_FOR_REPAIR, PRICE_CAP_CC, REFERENCE_NODE, SUPPLIERS, TECHS, creditsForCc, steelForCc } from "./config.ts";
import { batteryThresholds, corridorLimitKw, loanOffer, ONBOARDING, regionOutputBps, regionScore, reliabilityBps, assetIdOf, marginalName } from "./engine.ts";
import { bookValue, buildCostBps, fuelMarketCc, playerBookValue } from "./economy.ts";
import { cr, mw } from "./events.ts";
import { burnPerKwInterval, clockOf, marginalCost, solarFactorBps, sunElevation } from "./physics.ts";
import { RACC, fuelAsset, rbal, type RPlant, type RegionState } from "./state.ts";

const ownerName = (id: string) => (id === "player" ? "You" : (OWNERS.find((o) => o.ownerId === id)?.name ?? id));
const nodeName = (id: string) => NODES.find((n) => n.nodeId === id)!.name;
const gw = (kw: number) => (kw >= 1_000_000 ? `${(kw / 1_000_000).toFixed(2)} GW` : mw(kw));

export interface ViewOptions {
  paused?: boolean;
  epochStatus?: Record<string, { status: SettlementEpochView["status"]; txHash: string | null }>;
}

export function toRegionView(s: RegionState, opts: ViewOptions = {}): RegionView {
  const clk = clockOf(s.interval);
  const sun = sunElevation(clk.minuteOfDay);
  const solarBps = solarFactorBps(s, clk.minuteOfDay);
  const ref = s.nodes[REFERENCE_NODE].priceCc;

  const plantMc = (p: RPlant) => marginalCost(s, p, TECHS[p.tech].fuel ? fuelMarketCc(s, TECHS[p.tech].fuel!) : 0);

  const nodes: NodeView[] = NODES.map((n) => {
    const st = s.nodes[n.nodeId];
    const m = st.marginal;
    let buildUp: PriceComponent[] = [];
    if (m.kind === "plant") {
      const p = s.plants.find((x) => x.plantId === m.id);
      if (p) {
        const mc = plantMc(p);
        buildUp = [...mc.parts];
        const extra = st.priceCc - mc.totalCc;
        if (p.tech === "battery") buildUp = [{ label: `${p.name} sells stored energy at`, ccPerMWh: st.priceCc }];
        else if (p.tech === "solar") buildUp = [{ label: "Solar: no fuel cost", ccPerMWh: st.priceCc }];
        else if (extra !== 0) buildUp.push({ label: p.mitigated ? "Offer above cost (capped by regulator)" : p.ownerId === "player" ? "Your offer above cost" : `${ownerName(p.ownerId)} markup`, ccPerMWh: extra });
      }
    } else if (m.kind === "load") buildUp = [{ label: `Scarcity: ${marginalName(s, m)} sets the price`, ccPerMWh: st.priceCc }];
    else if (m.kind === "cap") buildUp = [{ label: "Regulator price cap: not enough power can reach here", ccPerMWh: PRICE_CAP_CC }];
    else buildUp = [{ label: "No trade", ccPerMWh: st.priceCc }];
    const w = st.priceWindow;
    return {
      nodeId: n.nodeId,
      name: n.name,
      x: n.x,
      z: n.z,
      demandKw: st.demandKw,
      servedKw: st.servedKw,
      curtailedKw: st.curtailedKw,
      shedKw: st.shedKw,
      priceCcPerMWh: st.priceCc,
      marginal: { kind: m.kind, id: m.id, name: marginalName(s, m) },
      decomposition: [
        { label: "System energy (Central City)", ccPerMWh: ref },
        { label: st.priceCc >= ref ? "Congestion: lines into here are full" : "Congestion: power is trapped here", ccPerMWh: st.priceCc - ref },
        { label: "Losses (lossless DC model)", ccPerMWh: 0 },
      ],
      buildUp,
      generationKw: st.generationKw,
      stress: st.shedWindow.reduce((a, b) => a + b, 0) / Math.max(1, st.shedWindow.length),
      avgPriceCcPerMWh: w.length ? Math.round(w.reduce((a, b) => a + b, 0) / w.length) : st.priceCc,
      dark: st.shedKw > 0 && st.shedKw >= st.demandKw * 0.15,
    };
  });

  const bc = buildCostBps(s);
  const corridors: CorridorView[] = CORRIDORS.map((cfg) => {
    const c = s.corridors.find((x) => x.corridorId === cfg.corridorId)!;
    return {
      corridorId: cfg.corridorId,
      from: cfg.from,
      to: cfg.to,
      name: cfg.name,
      limitKw: corridorLimitKw(s, cfg.corridorId),
      flowKw: c.flowKw,
      congested: c.congested,
      spreadCcPerMWh: s.nodes[cfg.to].priceCc - s.nodes[cfg.from].priceCc,
      playerKw: c.upgrades.filter((u) => u.ownerId === "player").reduce((a, u) => a + u.kw, 0),
      upgrade: { addKw: cfg.upgradeKw, costCc: creditsForCc(cfg.upgradeCc), steelT: steelForCc(cfg.upgradeCc), intervals: cfg.upgradeIntervals, building: c.building?.remaining ?? null },
      rentCcToday: c.rentCcToday,
      playerRentCcToday: c.playerRentCcToday,
    };
  });

  const plants: PlantView[] = s.plants.map((p) => {
    const t = TECHS[p.tech];
    const mc = plantMc(p);
    const price = s.nodes[p.nodeId].priceCc;
    const fuelHave = t.fuel ? rbal(s, fuelAsset(t.fuel), RACC.owner(p.ownerId)) : 0;
    const burn = t.fuel ? p.capacityKw * burnPerKwInterval(p) : 0;
    const listing = s.listings.find((l) => l.plantId === p.plantId);
    const usable = Math.round((p.energyKwh * p.healthBps) / 10_000);
    return {
      plantId: p.plantId,
      assetNo: p.assetNo,
      assetId: assetIdOf(p.assetNo),
      name: p.name,
      tech: p.tech,
      nodeId: p.nodeId,
      ownerId: p.ownerId,
      ownerName: ownerName(p.ownerId),
      mine: p.ownerId === "player",
      capacityKw: p.capacityKw,
      outputKw: p.outputKw,
      netKw: p.outputKw - p.chargeKw,
      status: p.status,
      buildRemaining: p.buildRemaining,
      buildTotal: p.buildTotal,
      startRemaining: p.startRemaining,
      online: p.online,
      strategy: p.strategy,
      markupPct: p.markupPct,
      batteryMode: p.batteryMode,
      socKwh: p.socKwh,
      energyKwh: usable,
      healthBps: Math.round(p.healthBps),
      cycles: Math.round(p.cycles * 10) / 10,
      marginalCostCcPerMWh: mc.totalCc,
      offerCcPerMWh: p.offerCc,
      costBreakdown: mc.parts,
      fuel: t.fuel,
      fuelIntervalsLeft: t.fuel ? (burn > 0 ? Math.floor(fuelHave / burn) : null) : null,
      fuelLimited: p.fuelLimited,
      revenueCcToday: p.revenueCcToday,
      marginCcToday: p.revenueCcToday - p.costCcToday,
      lifetimeMWh: Math.round(p.lifetimeKwh / 1000),
      lifetimeRevenueCc: p.lifetimeRevenueCc,
      bookValueCc: bookValue(p),
      listing: listing ? { askCc: listing.askCc, bids: listing.bids.map((b) => ({ ...b, bidderName: ownerName(b.bidder) })) } : null,
      tripReason: p.tripReason,
      repairParts: PARTS_FOR_REPAIR[p.tech],
      why: plantWhy(s, p, price, mc.totalCc, solarBps, usable),
    };
  });

  const actors: ActorView[] = ACTORS.map((cfg) => {
    const a = s.actors[cfg.actorId];
    const acct = RACC.actor(cfg.actorId);
    const lastQuote = [...s.events].reverse().find((e) => e.actorId === cfg.actorId && e.quote)?.quote?.text;
    const price = s.nodes[cfg.nodeId].priceCc;
    return {
      actorId: cfg.actorId,
      name: cfg.name,
      kind: cfg.kind,
      nodeId: cfg.nodeId,
      person: cfg.person,
      face: cfg.face,
      role: cfg.role,
      cashCc: rbal(s, "cc", acct),
      debtCc: s.loans.filter((l) => l.borrower === acct).reduce((x, l) => x + l.principalCc, 0),
      employees: a.employees,
      baseEmployees: cfg.employees,
      inventoryDays: a.inventoryDays,
      demandKw: a.demandKw,
      servedKw: a.servedKw,
      productionBps: a.productionBps,
      healthBps: a.healthBps,
      state: a.state,
      wtpCcPerMWh: cfg.essentialWtp,
      flexCcPerMWh: cfg.flexWtp,
      energyCostCcToday: a.energyCostCcToday,
      profitCcToday: a.profitCcToday,
      quote:
        lastQuote ??
        (a.state === "closed"
          ? "Closed."
          : price > cfg.flexWtp && cfg.flexBps > 0
            ? `At ${cr(price)} we're holding back ${Math.round(cfg.flexBps / 100)}% of our load.`
            : `Power at ${cr(price)}/MWh: we can live with that.`),
    };
  });

  const debt = s.loans.filter((l) => l.borrower === RACC.player).reduce((a, l) => a + l.principalCc, 0);
  const cash = rbal(s, "cc", RACC.player);
  const next = LICENCES.find((l) => l.level === s.player.licence + 1) ?? null;
  const demand = s.pulse.demandKw;
  const avail = s.pulse.availableKw;
  const reserve = avail - demand;
  const shortfall = Math.max(0, -reserve);
  const status = s.pulse.shedKw > 0 ? "blackout" : shortfall > 0 ? "shortfall" : reserve < demand * 0.08 ? "tight" : "normal";
  const affected = nodes.filter((n) => n.shedKw > 0).sort((a, b) => b.shedKw - a.shedKw);
  const darkDistricts = affected.filter((n) => n.dark);
  const namedPlaces = (darkDistricts.length ? darkDistricts : affected).map((n) => n.name);
  const placeList = namedPlaces.length < 2
    ? namedPlaces[0] ?? "Vesper"
    : `${namedPlaces.slice(0, -1).join(", ")} and ${namedPlaces.at(-1)}`;
  const question =
    status === "blackout"
      ? darkDistricts.length
        ? `The lights are out in ${placeList}. ${mw(s.pulse.shedKw)} of demand is going unserved.`
        : `Power is being cut in ${placeList}. ${mw(s.pulse.shedKw)} is going unserved.`
      : status === "shortfall"
        ? `Vesper is short ${mw(shortfall)}. Customers are pulling back as power reaches ${cr(s.pulse.spotCc)}/MWh.`
        : status === "tight"
          ? `Every district is lit, but only ${mw(reserve)} spare. One setback could darken the city.`
          : `Vesper is holding. Every district is lit, with ${mw(reserve)} spare for the next surge.`;

  const techs: TechView[] = TECH_IDS.map((tech) => {
    const t = TECHS[tech];
    return {
      tech,
      name: t.name,
      fuel: t.fuel,
      blurb: t.blurb,
      requiredLicence: Math.min(...t.sizes.map((z) => z.licence)),
      marginalCostCcPerMWh: marginalCost(s, { tech }, t.fuel ? fuelMarketCc(s, t.fuel) : 0).totalCc,
      sizes: t.sizes.map((z) => ({ capacityKw: z.capacityKw, energyKwh: z.energyKwh, costCc: creditsForCc(z.costCc), steelT: steelForCc(z.costCc), intervals: z.intervals })),
    };
  });

  const employment = ACTORS.reduce((a, c) => a + s.actors[c.actorId].employees, 0);
  const baseEmployment = ACTORS.reduce((a, c) => a + c.employees, 0);
  const hh = ACTORS.filter((a) => a.kind === "households");
  const ob = ONBOARDING[Math.min(s.onboarding.step, ONBOARDING.length - 1)];

  return {
    regionId: s.regionId,
    version: s.stateVersion,
    interval: s.interval,
    mode: s.mode,
    paused: opts.paused ?? false,
    clock: { day: clk.day, minuteOfDay: clk.minuteOfDay, label: clk.label, sunElevation: Math.round(sun * 1000) / 1000, isNight: sun <= 0.02 },
    weather: { tempC: s.weather.tempC, cloudPct: s.weather.cloudPct, windKph: s.weather.windKph, condition: s.weather.condition, solarFactorBps: solarBps, label: `${Math.round(s.weather.tempC)}°C · ${s.weather.condition === "heatwave" ? "heatwave" : s.weather.condition} · cloud ${s.weather.cloudPct}%` },
    pulse: { demandKw: demand, availableKw: avail, reserveKw: reserve, shortfallKw: shortfall, shedKw: s.pulse.shedKw, spotCcPerMWh: s.pulse.spotCc, cashCc: cash, status },
    question,
    nodes,
    corridors,
    plants,
    actors,
    suppliers: SUPPLIERS.map((c) => {
      const sp = s.suppliers[c.supplierId];
      return { supplierId: c.supplierId, name: c.name, person: c.person, face: c.face, fuel: c.fuel, stock: Math.round(sp.stock / 1000), capacity: Math.round(c.capacity / 1000), priceCcPerUnit: sp.priceCc, rationing: sp.rationing, importPerInterval: Math.round(sp.importPerInterval / 1000), cashCc: rbal(s, "cc", RACC.supplier(c.supplierId)), note: s.interval < sp.disruptionUntil ? `Imports disrupted for ${Math.round(((sp.disruptionUntil - s.interval) * 5) / 60)} more game hours.` : c.note };
    }),
    banks: BANKS.map((b) => {
      const o = loanOffer(s, b.bankId);
      return { bankId: b.bankId, name: b.name, person: b.person, cashCc: rbal(s, "cc", RACC.bank(b.bankId)), rateBps: o.rateBps, offerToPlayerCc: o.maxCc, stance: b.maxLeverageBps <= 5_000 ? "Cautious: lends up to half your assets." : "Aggressive: lends up to 70% of your assets, at a price." };
    }),
    loans: s.loans.filter((l) => l.borrower === RACC.player).map((l) => ({ loanId: l.loanId, bankId: l.bankId, principalCc: l.principalCc, rateBps: l.rateBps, interestCcPerDay: Math.round((l.principalCc * l.rateBps) / 10_000) })),
    techs,
    tenders: s.tenders.slice(-6).map((t) => ({ tenderId: t.tenderId, nodeId: t.nodeId, needKw: t.needKw, payCc: t.payCc, windowStart: t.windowStart, windowEnd: t.windowEnd, deadlineLabel: `${clockOf(t.windowStart).label} – 21:00`, status: t.status, progressKw: t.progressKw })),
    voltline: {
      cashCc: rbal(s, "cc", RACC.owner("voltline")),
      debtCc: s.loans.filter((l) => l.borrower === RACC.owner("voltline")).reduce((a, l) => a + l.principalCc, 0),
      marginPct: Math.round(s.voltline.marginBps / 100),
      state: s.voltline.state,
      capacityKw: s.plants.filter((p) => p.ownerId === "voltline" && p.status !== "mothballed").reduce((a, p) => a + p.capacityKw, 0),
      person: "Victor Lane",
      note: s.voltline.state === "distressed" ? "Selling assets to cover its debt." : s.voltline.state === "strained" ? "Cash is thin; margins rising." : `Offers at cost + ${Math.round(s.voltline.marginBps / 100)}%, more when the system is tight.`,
    },
    regulator: { priceCapCcPerMWh: PRICE_CAP_CC, carbonCcPerT: s.regulator.carbonCcPerT, fundCc: rbal(s, "cc", RACC.regulator), warnings: s.regulator.warnings, note: s.regulator.lastNote },
    player: {
      cashCc: cash,
      debtCc: debt,
      netWorthCc: cash + playerBookValue(s) - debt,
      gas: Math.round(rbal(s, "gas", RACC.player) / 1000),
      diesel: Math.round(rbal(s, "diesel", RACC.player) / 1000),
      permitsT: Math.floor(rbal(s, "permit", RACC.player) / 1000),
      certificates: Math.floor(rbal(s, "cert", RACC.player) / 1000),
      steelT: rbal(s, "steel", RACC.player),
      parts: rbal(s, "parts", RACC.player),
      autoFuel: { ...s.player.autoFuel },
      licence: s.player.licence,
      licenceName: LICENCES[s.player.licence - 1].name,
      nextLicence: next ? { name: next.name, needMWh: next.needMWh, haveMWh: Math.round(s.player.deliveredKwh / 1000), needReliabilityBps: next.needReliabilityBps } : null,
      deliveredMWh: Math.round(s.player.deliveredKwh / 1000),
      profitCcToday: s.player.profitCcToday,
      revenueCcToday: s.player.revenueCcToday,
      emissionsT: Math.round(s.player.emissionsKg / 1000),
      reliabilityBps: reliabilityBps(s),
      starterGrantCc: s.player.starterGrantCc,
    },
    economy: { steelIndexBps: s.economy.steelIndexBps, buildCostBps: bc, regionOutputBps: regionOutputBps(s), employment, baseEmployment, householdHealthBps: Math.round(hh.reduce((a, h) => a + s.actors[h.actorId].healthBps, 0) / hh.length) },
    world: s.input,
    events: s.events.slice(-40),
    history: s.history,
    onboarding: { step: s.onboarding.step, title: ob.title, hint: ob.hint, target: s.onboarding.done ? null : ob.target, done: s.onboarding.done },
    scores: regionScore(s),
    settlement: {
      epochs: s.epochs.slice(-8).map((e) => ({ epochId: e.epochId, fromInterval: e.fromInterval, toInterval: e.toInterval, hash: e.hash, status: opts.epochStatus?.[e.epochId]?.status ?? "local", txHash: opts.epochStatus?.[e.epochId]?.txHash ?? null, transfers: e.transfers.length })),
      nextEpochAt: s.epochStart.interval + EPOCH_INTERVALS,
    },
    ended: s.ended,
  };
}

function plantWhy(s: RegionState, p: RPlant, price: number, mc: number, solarBps: number, usable: number): string {
  const t = TECHS[p.tech];
  switch (p.status) {
    case "building":
      return `Under construction: ${Math.round((p.buildRemaining * 5) / 6) / 10} game hours left.`;
    case "tripped":
      return `Tripped (${p.tripReason}). Repairs take about ${Math.max(1, Math.round(((p.tripUntil - s.interval) * 5) / 60))} more game hours.`;
    case "mothballed":
      return "Mothballed by its owner to save money.";
    case "offline":
      return t.fuel ? `Offline. Start it to offer ${mw(p.capacityKw)} at about ${cr(mc)}/MWh.` : "Offline.";
    case "starting":
      return `Starting up: online in ${p.startRemaining * 5} minutes.`;
  }
  if (p.tech === "solar") return solarBps > 0 ? `The sun gives ${Math.round(solarBps / 100)}% of rated output: ${mw(p.outputKw)}.` : "Night: no output until sunrise.";
  if (p.tech === "battery") {
    const soc = Math.round((p.socKwh * 100) / Math.max(1, usable));
    const { lo, hi } = batteryThresholds(s, p.nodeId);
    if (p.outputKw > 0) return `Discharging ${mw(p.outputKw)} at ${cr(price)}/MWh. ${soc}% left.`;
    if (p.chargeKw > 0) return `Charging ${mw(p.chargeKw)} at ${cr(price)}/MWh. ${soc}% full.`;
    if (p.batteryMode === "hold") return `Holding at ${soc}%. Set Auto or Discharge to use it.`;
    if (p.batteryMode === "auto") return `Auto: charges below ${cr(lo)}, sells above ${cr(hi)}. Now ${cr(price)}, ${soc}% full.`;
    return `${p.batteryMode === "discharge" ? "Ready to discharge" : "Ready to charge"} (${soc}%).`;
  }
  if (p.fuelLimited) return `Short of ${t.fuel}: only ${mw(p.lastAvailKw)} available. Buy fuel in MARKET.`;
  if (p.outputKw > 0) return `Running ${mw(p.outputKw)}: the price here (${cr(price)}) covers your offer (${cr(p.offerCc)}).`;
  return `Online but idle: the price here (${cr(price)}) is below your offer (${cr(p.offerCc)}).`;
}

void BATTERY_EFF_BPS;
