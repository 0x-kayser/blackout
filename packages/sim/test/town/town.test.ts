import { describe, expect, it } from "vitest";
import { ITEM_IDS } from "@blackout/shared";
import { town } from "../../src/index.ts";

const { createTown, townTick, townTrade, townInvest, newTCtx, quote, townSum, tbal, MACC, fastForwardWeek, verifyTownEpoch, priceItem, toTownView } = town;

describe("merchant pricing (one readable rule)", () => {
  const base = { person: "Kettle", traits: {}, item: "fuel:diesel" as const, referenceCc: 100, target: 1000, recentNet: 0, markupBps: 2000, spreadBps: 2500, rivalShort: false };
  it("running low is dear, overstocked is cheap", () => {
    expect(priceItem({ ...base, stock: 200 }).askCc).toBeGreaterThan(priceItem({ ...base, stock: 1000 }).askCc);
    expect(priceItem({ ...base, stock: 3000 }).askCc).toBeLessThan(priceItem({ ...base, stock: 1000 }).askCc);
  });
  it("recent buying raises it, recent selling (a flood) lowers it", () => {
    expect(priceItem({ ...base, stock: 1000, recentNet: 400 }).askCc).toBeGreaterThan(priceItem({ ...base, stock: 1000 }).askCc);
    expect(priceItem({ ...base, stock: 1000, recentNet: -400 }).askCc).toBeLessThan(priceItem({ ...base, stock: 1000 }).askCc);
  });
  it("explains every factor and buys back under its own price", () => {
    const q = priceItem({ ...base, stock: 400, recentNet: 300 });
    expect(q.bidCc).toBeLessThan(q.askCc);
    expect(q.why.lines.map((l) => l.label).join(" ")).toMatch(/Stock 400 of a 1,000 target.*running low.*Buyers took 300 more/);
    expect(q.why.lines.find((l) => /margin/.test(l.label))!.factor).toBe("+20%");
  });
  it("the hoarder charges a premium when a rival is short", () => {
    const h = { ...base, traits: { hoarder: true }, stock: 1000 };
    expect(priceItem({ ...h, rivalShort: true }).askCc).toBe(Math.round(priceItem(h).askCc * 1.25));
  });
});

describe("Vesper Market", () => {
  it("flooding a merchant makes the item cheap for everyone, buying makes it dear", () => {
    const t = createTown({ seed: 1 });
    const ctx = newTCtx();
    const before = quote(t, "lena", "certificate:renewable").bidCc;
    townTrade(t, ctx, { playerId: "a", name: "Alice", merchantId: "lena", item: "certificate:renewable", side: "sell", quantity: 1_500 });
    // another player sees the lower price
    expect(quote(t, "lena", "certificate:renewable").bidCc).toBeLessThan(before * 0.8);
    const gas = quote(t, "ingrid", "fuel:natural-gas").askCc;
    townTrade(t, ctx, { playerId: "b", name: "Bola", merchantId: "ingrid", item: "fuel:natural-gas", side: "buy", quantity: 20_000 });
    expect(quote(t, "ingrid", "fuel:natural-gas").askCc).toBeGreaterThan(gas * 1.2);
  });

  it("big orders pay the average of the price before and after", () => {
    const t = createTown({ seed: 2 });
    const now = quote(t, "kettle", "fuel:diesel").askCc;
    const tr = townTrade(t, newTCtx(), { playerId: "a", name: "A", merchantId: "kettle", item: "fuel:diesel", side: "buy", quantity: 40_000 });
    expect(tr.priceCc).toBeGreaterThan(now);
    expect(tr.totalCc).toBe(tr.priceCc * 40_000);
  });

  it("a broke merchant closes until someone invests, then pays that investor", () => {
    const t = createTown({ seed: 3 });
    const ctx = newTCtx();
    // flood the green desk until it can't pay its rent
    for (let i = 0; i < 400 && t.merchants.lena.open; i++) {
      try {
        townTrade(t, ctx, { playerId: "flooder", name: "Flooder", merchantId: "lena", item: "certificate:renewable", side: "sell", quantity: 200 });
      } catch {
        /* warehouse full or out of cash */
      }
      townTick(t, ctx);
    }
    expect(t.merchants.lena.open).toBe(false);
    expect(ctx.events.some((e) => e.title === "Greenline Desk has closed")).toBe(true);
    expect(() => townTrade(t, ctx, { playerId: "x", name: "X", merchantId: "lena", item: "certificate:renewable", side: "sell", quantity: 1 })).toThrow(/closed.*Invest to reopen/);
    const need = town.reopenCc("lena");
    expect(() => townInvest(t, ctx, { playerId: "me", name: "Me", merchantId: "lena", amountCc: need - 1 })).toThrow(/takes at least/);
    const r = townInvest(t, ctx, { playerId: "me", name: "Me", merchantId: "lena", amountCc: need * 4 });
    expect(r.reopened).toBe(true);
    expect(t.merchants.lena.open).toBe(true);
    expect(r.shareBps).toBeGreaterThan(0);
    // stop flooding: she recovers and pays dividends to the investor
    for (let i = 0; i < 288 * 3; i++) townTick(t, ctx);
    expect(t.dividendsTotal.me ?? 0).toBeGreaterThan(0);
    expect(town.takeOwed(t, "me")).toBe(t.dividendsTotal.me);
  });

  it("refuses what merchants can't do, with reasons", () => {
    const t = createTown({ seed: 4 });
    const c = newTCtx();
    expect(() => townTrade(t, c, { playerId: "a", name: "A", merchantId: "bayo", item: "fuel:natural-gas", side: "sell", quantity: 10 })).toThrow(/doesn't buy/);
    expect(() => townTrade(t, c, { playerId: "a", name: "A", merchantId: "kettle", item: "material:steel", side: "buy", quantity: 1 })).toThrow(/doesn't trade/);
    expect(() => townTrade(t, c, { playerId: "a", name: "A", merchantId: "nkechi", item: "part:turbine", side: "buy", quantity: 10_000 })).toThrow(/only/);
  });

  it("conserves credits and every item, and settles in zero-sum epochs", () => {
    const t = createTown({ seed: 5 });
    const ctx = newTCtx();
    for (let i = 0; i < 400; i++) {
      if (i % 7 === 0) townTrade(t, ctx, { playerId: "p", name: "P", merchantId: "dayo", item: "fuel:diesel", side: "buy", quantity: 500 });
      townTick(t, ctx);
    }
    for (const a of ["cc", ...ITEM_IDS]) expect(townSum(t, a as never)).toBe(0);
    for (const m of Object.keys(t.merchants)) expect(tbal(t, "cc", MACC(m))).toBeGreaterThanOrEqual(0);
    expect(t.epochs.length).toBeGreaterThanOrEqual(5);
    for (const e of t.epochs) expect(verifyTownEpoch(e)).toBe(true);
    expect(t.epochs[0].tokens.some((x) => x.token === "credit:vesper")).toBe(true);
    expect(t.epochs[0].tokens.some((x) => x.token === "fuel:diesel")).toBe(true);
  });

  it("the view shows wallets, stock, and why each price is what it is", () => {
    const t = createTown({ seed: 6 });
    const v = toTownView(t, "me");
    expect(v.merchants).toHaveLength(9);
    const lena = v.merchants.find((m) => m.merchantId === "lena")!;
    expect(lena.items[0].askCc).toBeGreaterThan(lena.items[0].bidCc!);
    expect(lena.items[0].why.lines.length).toBeGreaterThanOrEqual(4);
    expect(v.merchants.find((m) => m.merchantId === "bayo")!.items[0].bidCc).toBeNull();
  });

  it("does not enqueue a second credit or resource settlement for an externally settled listing fill", () => {
    const t = createTown({ seed: 7 });
    townTrade(t, newTCtx(), { playerId: "seller", name: "Seller", merchantId: "kettle", item: "fuel:diesel", side: "buy", quantity: 5 });
    t.tick += 1;
    town.forceCloseTownEpoch(t);
    const priceCc = 100;
    const totalCc = priceCc * 5;
    town.reserveListingCash(t, "listing-1", "kettle", totalCc);
    town.settleListingCash(t, "listing-1", "kettle", "seller", "Seller", totalCc, "fuel:diesel", 5, priceCc);
    t.tick += town.townConfig.EPOCH_TICKS;
    town.forceCloseTownEpoch(t);
    expect(t.epochs.at(-1)?.tokens).toEqual([]);
    expect(t.trades.filter((trade) => trade.listingId === "listing-1")).toHaveLength(1);
  });
});

describe("watch a week", () => {
  it("simulates seven market days with bots, deterministically, and shows a closure and a rescue", () => {
    const a = fastForwardWeek(42);
    expect(a.frames).toHaveLength(60);
    expect(fastForwardWeek(42).traceHash).toBe(a.traceHash);
    expect(a.events.some((e) => /has closed/.test(e.title))).toBe(true);
    expect(a.events.some((e) => /reopens/.test(e.title))).toBe(true);
    const gas = a.frames.map((f) => f.merchants.find((m) => m.merchantId === "ingrid")!.prices["fuel:natural-gas"]!);
    expect(Math.max(...gas)).toBeGreaterThan(Math.min(...gas) * 1.5);
  });
});

describe("market news", () => {
  const { STORIES } = town;
  it("breaks a story within a minute of play and keeps the news coming", () => {
    const t = createTown({ seed: 5 });
    const ctx = newTCtx();
    for (let i = 0; i < 600; i++) townTick(t, ctx);
    const headlines = new Set(STORIES.map((s) => s.headline));
    const broke = ctx.events.filter((e) => headlines.has(e.title));
    expect(broke[0].tick).toBeLessThanOrEqual(60);
    expect(broke.length).toBeGreaterThanOrEqual(6);
    expect(toTownView(t, null).news!.length).toBeGreaterThan(0);
  });
  it("a delayed tanker drains Ingrid's tanks, her gas gets dearer and the tooltip says why", () => {
    const run = (withStory: boolean) => {
      const t = createTown({ seed: 9 });
      t.nextNewsAt = 1e9; // no random stories: only the one under test
      if (withStory) t.news = [{ seq: 1, storyId: "tanker-delayed", from: 0, until: 500 }];
      const ctx = newTCtx();
      for (let i = 0; i < 120; i++) townTick(t, ctx);
      return { stock: tbal(t, "fuel:natural-gas", MACC("ingrid")), q: quote(t, "ingrid", "fuel:natural-gas") };
    };
    const calm = run(false);
    const news = run(true);
    expect(news.stock).toBeLessThan(calm.stock * 0.8);
    expect(news.q.askCc).toBeGreaterThan(calm.q.askCc * 1.1);
    expect(news.q.why.lines.map((l) => l.label).join(" ")).toMatch(/News: Hormuz rerouting/);
  });
  it("an outside-price story moves every seller of that item at once", () => {
    const t = createTown({ seed: 9 });
    t.nextNewsAt = 1e9;
    const before = [quote(t, "ingrid", "fuel:natural-gas").askCc, quote(t, "bayo", "fuel:natural-gas").askCc];
    t.news = [{ seq: 1, storyId: "henry-hub-jump", from: 0, until: 500 }];
    const after = [quote(t, "ingrid", "fuel:natural-gas").askCc, quote(t, "bayo", "fuel:natural-gas").askCc];
    expect(after[0] / before[0]).toBeCloseTo(1.18, 1);
    expect(after[1] / before[1]).toBeCloseTo(1.18, 1);
  });
  it("keeps conserving every item while stories run", () => {
    const t = createTown({ seed: 12 });
    const ctx = newTCtx();
    const start = Object.fromEntries(ITEM_IDS.map((i) => [i, townSum(t, i)]));
    for (let i = 0; i < 400; i++) townTick(t, ctx);
    for (const i of ITEM_IDS) expect(townSum(t, i)).toBe(start[i]);
    expect(townSum(t, "cc")).toBe(0);
  });
});
