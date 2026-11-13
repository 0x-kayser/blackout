/**
 * Market replay: seven days or one year of Vesper Market with four bot companies trading by visible rules. Same seed,
 * endowment and policy → same replay trace.
 */
import type { FastForwardResult, ItemId, TownEvent } from "@blackout/shared";
import { canonical, sha256 } from "../region/settlement.ts";
import { BOTS, MERCHANTS, TICKS_PER_DAY, referenceCc } from "./config.ts";
import { bestMerchant, createTown, MACC, newTCtx, quote, reopenCc, resourceReserve, tbal, townClock, townInvest, townTick, townTrade, tradePrice, type TCtx, type TownState } from "./engine.ts";
import { FACC, FIRMS, ensureFirms } from "./firms.ts";
import { WINDOW_TICKS, type PowerOffer } from "./firmPolicy.ts";

/** Your company in the week: its real spare capacity and ask, held for the week (a projection, not a promise). */
export interface FastForwardYou {
  name: string;
  kw: number;
  priceCcPerMWh: number;
}

interface Bot {
  botId: string;
  name: string;
  strategy: string;
  cashCc: number;
  inv: Partial<Record<ItemId, number>>;
}

function tryTrade(t: TownState, ctx: TCtx, b: Bot, merchantId: string | null, item: ItemId, side: "buy" | "sell", qty: number): boolean {
  if (!merchantId || qty <= 0) return false;
  if (side === "buy" && tradePrice(t, merchantId, item, "buy", qty).totalCc > b.cashCc) return false;
  try {
    const tr = townTrade(t, ctx, { playerId: `bot:${b.botId}`, name: b.name, kind: "bot", merchantId, item, side, quantity: qty });
    b.cashCc += side === "buy" ? -tr.totalCc : tr.totalCc;
    b.inv[item] = (b.inv[item] ?? 0) + (side === "buy" ? qty : -qty);
    return true;
  } catch {
    return false;
  }
}

function botStep(t: TownState, ctx: TCtx, bots: Bot[]): void {
  const [green, pemberton, ndlovu, lakeside] = bots;
  // Greenfield gathers ~7,000 certificates a day from its solar farms and dumps them on the green desk from day 2
  if (t.tick >= TICKS_PER_DAY && t.tick % 6 === 0) {
    green.inv["certificate:renewable"] = (green.inv["certificate:renewable"] ?? 0) + 150;
    tryTrade(t, ctx, green, "lena", "certificate:renewable", "sell", 150);
  }
  // Pemberton corners gas for three days (watch the price climb), waits, then dumps it (watch it fall)
  if (t.tick % 6 === 3) {
    const day = Math.floor(t.tick / TICKS_PER_DAY);
    if (day < 3) tryTrade(t, ctx, pemberton, bestMerchant(t, "fuel:natural-gas", "buy", 1_500), "fuel:natural-gas", "buy", 1_500);
    else if (day >= 4 && (pemberton.inv["fuel:natural-gas"] ?? 0) >= 2_000) tryTrade(t, ctx, pemberton, "ingrid", "fuel:natural-gas", "sell", 2_000);
  }
  void quote;
  // Ndlovu builds twice a day and rescues shops that have been closed for a day
  if (t.tick % (TICKS_PER_DAY / 2) === 40) {
    tryTrade(t, ctx, ndlovu, "pavel", "material:steel", "buy", 120);
    tryTrade(t, ctx, ndlovu, "nkechi", "part:turbine", "buy", 3);
  }
  if (t.tick % 12 === 5)
    for (const m of MERCHANTS) {
      const st = t.merchants[m.merchantId];
      if (!st.open && t.tick - st.closedSince >= TICKS_PER_DAY && ndlovu.cashCc > reopenCc(m.merchantId) * 1.5) {
        townInvest(t, ctx, { playerId: `bot:${ndlovu.botId}`, name: ndlovu.name, merchantId: m.merchantId, amountCc: reopenCc(m.merchantId) });
        ndlovu.cashCc -= reopenCc(m.merchantId);
      }
    }
  // Lakeside buys what a diesel utility burns, every hour
  if (t.tick % 12 === 7) {
    tryTrade(t, ctx, lakeside, bestMerchant(t, "fuel:diesel", "buy", 4_000), "fuel:diesel", "buy", 4_000);
    tryTrade(t, ctx, lakeside, "ruth", "permit:carbon", "buy", 40);
  }
}

/**
 * The power desk in the week: Lakeside (a diesel utility bot) offers 15 MW, and your company offers what it has spare.
 * A storm front parks over Vesper on day 2 (a fixed weather event so every run of a seed is the same); how the
 * companies respond to it is entirely their own rules.
 */
export function fastForwardWeek(seed = 42, days = 7, world?: TownState["world"], you: FastForwardYou | null = null): FastForwardResult {
  const t = createTown({ seed, world });
  ensureFirms(t);
  const startCash = Object.fromEntries(FIRMS.map((f) => [f.firmId, tbal(t, "cc", FACC(f.firmId))]));
  const offers: PowerOffer[] = [{ sellerKey: "player:bot-lakeside", sellerName: "Lakeside Utilities", kw: 15_000, priceCcPerMWh: 9_800, why: "A diesel utility selling its spare hours." }];
  if (you && you.kw > 0) offers.push({ sellerKey: "player:you", sellerName: you.name, kw: you.kw, priceCcPerMWh: you.priceCcPerMWh, why: "Your spare capacity." });
  const bots: Bot[] = BOTS.map((b) => ({ ...b, cashCc: 60_000_000, inv: {} }));
  const total = days * TICKS_PER_DAY;
  const every = Math.floor(total / 60);
  const frames: FastForwardResult["frames"] = [];
  const events: TownEvent[] = [];
  let trades = 0;
  for (let i = 1; i <= total; i++) {
    const ctx = newTCtx();
    botStep(t, ctx, bots);
    if (t.tick + 1 === TICKS_PER_DAY) t.news = [...(t.news ?? []), { seq: 900_000, storyId: "storm-front", from: t.tick + 1, until: t.tick + 1 + 180 }];
    townTick(t, ctx, { offers: (t.tick + 1) % WINDOW_TICKS === 0 ? offers : [], autoSettle: true, delivered: (o) => o.kwh });
    events.push(...ctx.events);
    trades += ctx.trades.length;
    if (i % every === 0 && frames.length < 60)
      frames.push({
        tick: t.tick,
        label: townClock(t.tick),
        merchants: MERCHANTS.map((m) => ({
          merchantId: m.merchantId,
          open: t.merchants[m.merchantId].open,
          cashCc: tbal(t, "cc", MACC(m.merchantId)),
          prices: Object.fromEntries(m.items.map((it) => [it.item, quote(t, m.merchantId, it.item).askCc])),
          stock: Object.fromEntries(m.items.map((it) => [it.item, tbal(t, it.item, MACC(m.merchantId))])),
        })),
        companies: FIRMS.map((f) => ({ firmId: f.firmId, name: f.name, open: t.firms![f.firmId].open, cashCc: tbal(t, "cc", FACC(f.firmId)), productionBps: t.firms![f.firmId].productionBps })),
        cloudPct: t.sky?.cloudPct,
        youEarnedCc: t.balances.cc?.["ext:player:you"] ?? 0,
        reserves: Object.fromEntries((Object.keys(t.resourceLedger?.totals ?? {}) as ItemId[]).map((item) => [item, { remaining: resourceReserve(t, item).remaining, total: resourceReserve(t, item).total }])),
      });
  }
  const allPower = events.filter((e) => e.kind === "power");
  const worth = (b: Bot) => b.cashCc + Object.entries(b.inv).reduce((a, [item, q]) => a + (q ?? 0) * referenceCc(item as ItemId, t.world), 0);
  return {
    seed,
    days,
    frames,
    // the shops' story (closures, rescues, dividends) and the news are kept apart so neither crowds out the other
    events: [...events.filter((e) => e.severity !== "info" && !e.kind).slice(-40), ...events.filter((e) => e.kind === "news" && e.severity !== "info").slice(-20), ...events.filter((e) => e.kind === "power" && e.title.includes(" buys ")).slice(-20), ...events.filter((e) => e.kind === "resource").slice(-40)].sort((a, b) => a.seq - b.seq),
    bots: bots.map((b) => ({ name: b.name, strategy: b.strategy, cashCc: b.cashCc, netWorthCc: worth(b) })),
    companies: FIRMS.map((f) => ({ firmId: f.firmId, name: f.name, startCc: startCash[f.firmId], endCc: tbal(t, "cc", FACC(f.firmId)), boughtMWh: Math.round(t.firms![f.firmId].boughtKwh / 1000), soldMWh: Math.round(t.firms![f.firmId].soldKwh / 1000), open: t.firms![f.firmId].open })),
    you: you && you.kw > 0 ? { ...you, earnedCc: t.balances.cc?.["ext:player:you"] ?? 0, deals: allPower.filter((e) => e.who === "player:you" && / buys /.test(e.title)).length } : null,
    trades,
    traceHash: sha256(canonical(frames)),
    reserves: Object.fromEntries((Object.keys(t.resourceLedger?.totals ?? {}) as ItemId[]).map((item) => [item, { total: resourceReserve(t, item).total, remaining: resourceReserve(t, item).remaining }])),
  };
}
