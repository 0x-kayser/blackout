/**
 * "Watch a week" (fast-forward): seven market days of Vesper Market with four bot companies trading by simple, visible
 * rules, in about a second of compute and a minute of playback. Same seed → same week.
 */
import type { FastForwardResult, ItemId, TownEvent } from "@blackout/shared";
import { canonical, sha256 } from "../region/settlement.ts";
import { BOTS, MERCHANTS, TICKS_PER_DAY, referenceCc } from "./config.ts";
import { bestMerchant, createTown, MACC, newTCtx, quote, reopenCc, tbal, townClock, townInvest, townTick, townTrade, tradePrice, type TCtx, type TownState } from "./engine.ts";

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

export function fastForwardWeek(seed = 42, days = 7, world?: TownState["world"]): FastForwardResult {
  const t = createTown({ seed, world });
  const bots: Bot[] = BOTS.map((b) => ({ ...b, cashCc: 60_000_000, inv: {} }));
  const total = days * TICKS_PER_DAY;
  const every = Math.floor(total / 60);
  const frames: FastForwardResult["frames"] = [];
  const events: TownEvent[] = [];
  let trades = 0;
  for (let i = 1; i <= total; i++) {
    const ctx = newTCtx();
    botStep(t, ctx, bots);
    townTick(t, ctx);
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
      });
  }
  const worth = (b: Bot) => b.cashCc + Object.entries(b.inv).reduce((a, [item, q]) => a + (q ?? 0) * referenceCc(item as ItemId, t.world), 0);
  return {
    seed,
    days,
    frames,
    // the shops' story (closures, rescues, dividends) and the news are kept apart so neither crowds out the other
    events: [...events.filter((e) => e.severity !== "info" && e.kind !== "news").slice(-40), ...events.filter((e) => e.kind === "news" && e.severity !== "info").slice(-20)].sort((a, b) => a.seq - b.seq),
    bots: bots.map((b) => ({ name: b.name, strategy: b.strategy, cashCc: b.cashCc, netWorthCc: worth(b) })),
    trades,
    traceHash: sha256(canonical(frames)),
  };
}
