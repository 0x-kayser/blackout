/**
 * Scripted PLAYER-policy bots for the Observatory / fast-forward replay.
 * They only read GameStatePublic and emit ordinary PlayerActions through the
 * same engine as a human — they script decisions, never outcomes.
 */
import type { GameStatePublic, PlayerAction, ReplayPolicyId } from "@blackout/shared";

type Bot = (s: GameStatePublic) => PlayerAction[];

const FUEL_ML_PER_WH = 0.3;

function freeDiesel(s: GameStatePublic, w: number, hours: number): string | null {
  const needFuel = w * hours * FUEL_ML_PER_WH;
  const freeFuel = s.player.fuelMl - s.player.fuelReservedMl;
  const freePermit = s.player.permitAllowanceMg - s.player.permitReservedMg;
  if (needFuel > freeFuel || needFuel * 2680 > freePermit) return null;
  const g = s.generators.find((g) => g.type === "diesel" && g.status === "online" && g.ratedW - g.assignedW >= w);
  return g?.generatorId ?? null;
}

function freeSolar(s: GameStatePublic, w: number, hours: number): string | null {
  const g = s.generators.find((g) => g.type === "solar" && g.status === "online");
  if (!g) return null;
  const nowFree = g.availableW - g.assignedW;
  const battery = s.battery ? Math.floor((s.battery.storedWh * s.battery.roundTripEfficiencyBps) / 10_000) : 0;
  // conservative: only if the sun covers it now AND (it's before 15:00 or the battery could cover the whole job)
  const minute = s.clock.gameMinuteOfDay ?? 0;
  if (nowFree >= w && (minute + hours * 60 <= 16 * 60 || battery >= w * hours)) return g.generatorId;
  if (battery >= w * hours && g.ratedW - g.assignedW >= w) return g.generatorId;
  return null;
}

function cheapestMerchant(s: GameStatePublic) {
  return s.merchants
    .filter((m) => m.status === "open" && m.stockMl > 1000 && (m.reasons.rationLimitMl ?? 1) > 0)
    .sort((a, b) => a.quoteCcPerL - b.quoteCcPerL || a.merchantId.localeCompare(b.merchantId))[0];
}

/**
 * Daily shopping routine at the start of each game day (the market is always open;
 * bots simply choose to shop at 06:00-06:30): extras, quote -> buy fuel, quote -> buy permits.
 */
function morningShopping(s: GameStatePublic, fuelTargetMl: number, permitTargetMg: number, extras: PlayerAction[]): PlayerAction[] {
  const t = s.clock.phaseTick;
  if (s.clock.day === 1) return [];
  const open = s.quotes.filter((q) => q.status === "open" && q.expiresTick > s.clock.tick);
  if (t === 0) return extras;
  if (t === 1) {
    const want = Math.min(fuelTargetMl - s.player.fuelMl - s.player.pendingFuelMl, s.player.tankCapacityMl - s.player.fuelMl - s.player.pendingFuelMl);
    const m = cheapestMerchant(s);
    if (m && want >= 1000) return [{ type: "REQUEST_QUOTE", sellerId: `merchant:${m.merchantId}`, item: "diesel", quantity: Math.floor(want / 1000) * 1000 }];
    return [];
  }
  if (t === 2) {
    const q = open.find((q) => q.item === "diesel");
    if (!q) return [];
    const qty = Math.floor(q.maxQuantity / 100) * 100;
    const afford = Math.floor((s.player.creditsCc * 1000) / q.unitPriceCc / 100) * 100;
    const n = Math.min(qty, afford);
    return n >= 100 ? [{ type: "BUY", quoteId: q.quoteId, quantity: n }] : [];
  }
  if (t === 3) {
    const need = permitTargetMg - s.player.permitAllowanceMg;
    if (need > 0 && s.regulator.permitsForSaleToday > 0) return [{ type: "REQUEST_QUOTE", sellerId: "regulator", item: "permit", quantity: Math.ceil(need / 10_000_000) }];
    return [];
  }
  if (t === 4) {
    const q = open.find((q) => q.item === "permit");
    if (!q) return [];
    const n = Math.min(q.maxQuantity, Math.floor(s.player.creditsCc / Math.max(1, q.unitPriceCc)));
    return n > 0 ? [{ type: "BUY", quoteId: q.quoteId, quantity: n }] : [];
  }
  return [];
}

const shoppingWindow = (s: GameStatePublic) => s.clock.phase === "operating" && s.clock.day > 1 && s.clock.phaseTick >= 1 && s.clock.phaseTick <= 4;

function operate(s: GameStatePublic, pick: (s: GameStatePublic, w: number, h: number) => string | null, minRate: number, counter?: number): PlayerAction[] {
  const out: PlayerAction[] = [];
  for (const c of s.contracts) {
    if (c.status === "pending_assignment" && c.provider === "player") {
      const gid = pick(s, c.allottedW, c.durationHours);
      if (gid) out.push({ type: "ASSIGN_CONTRACT", contractId: c.contractId, generatorId: gid });
      else out.push({ type: "CANCEL_CONTRACT", contractId: c.contractId });
      return out; // one decision per tick keeps capacity bookkeeping honest
    }
  }
  for (const r of s.requests) {
    if (r.status !== "open" && r.status !== "customer_countered") continue;
    const gid = pick(s, r.requestedW, r.durationHours);
    if (!gid) {
      out.push({ type: "DECLINE_REQUEST", requestId: r.requestId });
    } else if (counter && r.counterCount === 0 && r.status === "open" && r.offerRateCcPerKwh < counter) {
      out.push({ type: "COUNTER_REQUEST", requestId: r.requestId, rateCcPerKwh: counter });
    } else if (r.offerRateCcPerKwh >= minRate) {
      out.push({ type: "ACCEPT_REQUEST", requestId: r.requestId, generatorId: gid });
    } else {
      out.push({ type: "DECLINE_REQUEST", requestId: r.requestId });
    }
    return out;
  }
  return out;
}

const diesel: Bot = (s) => {
  if (s.clock.day === 2 && s.clock.phaseTick === 0 && s.player.tariffsCcPerKwh.market_quarter !== 900) return [{ type: "SET_TARIFF", districtId: "market_quarter", rateCcPerKwh: 900 }];
  if (shoppingWindow(s)) {
    const buy = morningShopping(s, 26_000, 40_000_000, []);
    if (buy.length) return buy;
  }
  if (s.clock.phase === "operating") return operate(s, freeDiesel, 600);
  return [];
};

const diversified: Bot = (s) => {
  if (s.clock.phase === "operating" && s.clock.day > 1 && s.clock.phaseTick === 0) {
    const extras: PlayerAction[] = [];
    if (!s.player.upgradesOwned.includes("solar_2kw") && s.player.creditsCc >= 90_000 + 25_000) extras.push({ type: "BUY_UPGRADE", upgradeId: "solar_2kw" });
    else if (s.player.upgradesOwned.includes("solar_2kw") && !s.player.upgradesOwned.includes("battery_10kwh") && s.player.creditsCc >= 70_000 + 25_000)
      extras.push({ type: "BUY_UPGRADE", upgradeId: "battery_10kwh" });
    if (extras.length) return extras;
  }
  if (shoppingWindow(s)) {
    const buy = morningShopping(s, 14_000, 25_000_000, []);
    if (buy.length) return buy;
  }
  if (s.clock.phase === "operating") return operate(s, (st, w, h) => freeSolar(st, w, h) ?? freeDiesel(st, w, h), 600);
  return [];
};

const gouger: Bot = (s) => {
  if (s.clock.phase === "operating" && s.clock.day === 1 && s.clock.phaseTick === 0 && s.player.tariffsCcPerKwh.market_quarter !== 1_500)
    return [{ type: "SET_TARIFF", districtId: "market_quarter", rateCcPerKwh: 1_500 }];
  if (shoppingWindow(s)) {
    const buy = morningShopping(s, 26_000, 40_000_000, []);
    if (buy.length) return buy;
  }
  if (s.clock.phase === "operating") return operate(s, freeDiesel, 900, 1_500);
  return [];
};

export const PLAYER_POLICIES: Record<ReplayPolicyId, { name: string; description: string; bot: Bot }> = {
  diesel: { name: "Cheap Diesel First", description: "Accepts every feasible request on diesel, buys ~2 days of fuel from the cheapest seller at the start of each game day, never invests.", bot: diesel },
  diversified: { name: "Storage First", description: "Buys solar then a battery as soon as cash allows, routes daytime loads to solar, buys only ~1 day of diesel.", bot: diversified },
  gouger: { name: "Price Gouger", description: "Posts 15 credits/kWh and counters high; shows how overcharging shrinks the town's economy.", bot: gouger },
};
