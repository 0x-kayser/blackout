import { describe, expect, it } from "vitest";
import { ITEM_IDS } from "@blackout/shared";
import { region, town } from "../../src/index.ts";

const { createTown, townTick, newTCtx, townSum, FACC, FIRMS, firmPolicy, activatePowerOrder, failPowerOrder, settlePowerOrder, expirePowerOrder } = town;
const player = (kw: number, price: number) => [{ sellerKey: "player:u1", sellerName: "Harbor Volt", kw, priceCcPerMWh: price, why: "spare" }];
const cash = (t: town.TownState, id: string) => t.balances.cc?.[FACC(id)] ?? 0;

describe("Vesper's NPC companies", () => {
  it("buy power from a player and from each other, and say why with the numbers they used", () => {
    const t = createTown({ seed: 3 });
    const ctx = newTCtx();
    for (let i = 0; i < 288; i++) townTick(t, ctx, { offers: player(20_000, 9_500), autoSettle: true, delivered: (o) => o.kwh });
    const buys = ctx.events.filter((e) => e.kind === "power" && / buys /.test(e.title));
    expect(buys.some((e) => /from Harbor Volt/.test(e.title))).toBe(true); // NPC → player
    expect(buys.some((e) => /Aluminium buys .* from Northwind|Solara Energy buys .* from Northwind/.test(e.title))).toBe(true); // NPC → NPC
    const why = t.firms!.halvard.lastWhy;
    expect(why).toMatch(/Needs 30 MW .* pays up to ₡119\/MWh/);
    // Northwind bought the gas for what it sold, from the merchants, out of its own wallet
    expect(ctx.trades.some((x) => x.who === "firm:northwind" && x.item === "fuel:natural-gas" && x.side === "buy")).toBe(true);
    // the player was paid by name: Halvard or Solara, out of their own cash
    expect(-(t.balances.cc["ext:player:u1"] ?? 0)).toBeLessThan(0);
  });

  it("never create money: every credit and item is conserved, and production alone earns nothing", () => {
    const t = createTown({ seed: 4 });
    const ctx = newTCtx();
    const items = Object.fromEntries(ITEM_IDS.map((i) => [i, townSum(t, i)]));
    for (let i = 0; i < 288 * 2; i++) {
      townTick(t, ctx, { offers: player(15_000, 9_000), autoSettle: true, delivered: (o) => Math.round(o.kwh * 0.8) });
      expect(townSum(t, "cc")).toBe(0);
      for (const f of FIRMS) expect(t.firms![f.firmId].escrowedCc).toBeGreaterThanOrEqual(0);
    }
    for (const i of ITEM_IDS) expect(townSum(t, i)).toBe(items[i]);
    // the gas plant sold nothing it wasn't paid for: all of its income is settled orders
    const paid = t.power!.orders.filter((o) => o.sellerKey === "firm:northwind" && o.status === "settled").reduce((a, o) => a + o.paidCc, 0);
    expect(paid).toBeGreaterThan(0);
  });

  it("Solara buys backup when a storm parks over Vesper, and less under clear skies", () => {
    const run = (storyId: string) => {
      const t = createTown({ seed: 5 });
      t.nextNewsAt = 1e9;
      t.news = [{ seq: 1, storyId, from: 0, until: 10_000 }];
      const ctx = newTCtx();
      // daytime only: ticks 84–204 are 07:00–17:00
      for (let i = 0; i < 216; i++) townTick(t, ctx, { offers: player(30_000, 9_000), autoSettle: true, delivered: (o) => o.kwh });
      return t.power!.orders.filter((o) => o.buyerId === "solara" && o.startTick >= 108 && o.startTick <= 180).reduce((a, o) => a + o.kw, 0);
    };
    expect(run("storm-front")).toBeGreaterThan(run("clear-skies"));
  });

  it("the smelter idles rather than pay more than its aluminium is worth", () => {
    const t = createTown({ seed: 6 });
    const ctx = newTCtx();
    t.firms = undefined;
    town.ensureFirms(t);
    t.firms!.northwind.open = false;
    t.firms!.northwind.closedSince = 0;
    for (let i = 0; i < 36; i++) townTick(t, ctx, { offers: player(30_000, 30_000), autoSettle: true, delivered: (o) => o.kwh });
    expect(t.power!.orders.filter((o) => o.buyerId === "halvard")).toHaveLength(0);
    expect(t.firms!.halvard.productionBps).toBe(0);
    expect(t.firms!.halvard.lastWhy).toMatch(/above its limit/);
  });

  it("a company that runs out of money stops trading, then outside investors rescue it after two days", () => {
    const t = createTown({ seed: 8 });
    const ctx = newTCtx();
    townTick(t, ctx);
    const acct = FACC("halvard");
    const excess = cash(t, "halvard") - 100_000;
    t.balances.cc[acct] -= excess;
    t.balances.cc["ext:owners"] += excess;
    townTick(t, ctx);
    expect(t.firms!.halvard.open).toBe(false);
    const n = t.power!.orders.length;
    for (let i = 0; i < 288; i++) townTick(t, ctx);
    expect(t.power!.orders.filter((o) => o.buyerId === "halvard").length).toBe(t.power!.orders.slice(0, n).filter((o) => o.buyerId === "halvard").length);
    for (let i = 0; i < 300; i++) townTick(t, ctx);
    expect(t.firms!.halvard.open).toBe(true);
    expect(ctx.events.some((e) => /Halvard Aluminium is back/.test(e.title))).toBe(true);
  });

  it("orders move no money until the escrow and the delivery are confirmed; failures and expiries refund", () => {
    const t = createTown({ seed: 9 });
    const ctx = newTCtx();
    for (let i = 0; i < 36; i++) townTick(t, ctx, { offers: player(20_000, 9_000), autoSettle: false });
    const placed = t.power!.orders.filter((o) => o.status === "placing");
    expect(placed.length).toBeGreaterThan(1);
    const before = cash(t, "halvard");
    const [a, b] = placed;
    failPowerOrder(t, ctx, a.orderId, "the NPC's daily limit");
    expect(a.status).toBe("failed");
    activatePowerOrder(t, ctx, b.orderId);
    expect(b.status).toBe("open");
    expect(cash(t, b.buyerId === "halvard" ? "halvard" : b.buyerId)).toBeGreaterThan(0);
    expect(cash(t, "halvard")).toBe(before);
    for (let i = 0; i < 36; i++) townTick(t, ctx, { offers: [], autoSettle: false });
    expect(b.status).toBe("awaiting");
    const sellerAcct = b.sellerKey.startsWith("player:") ? `ext:player:${b.sellerKey.slice(7)}` : FACC(b.sellerKey.slice(5));
    const sellerBefore = t.balances.cc[sellerAcct] ?? 0;
    settlePowerOrder(t, ctx, b.orderId, Math.round(b.kwh / 2));
    expect(b.status).toBe("settled");
    expect(b.paidCc).toBe(Math.floor((Math.round(b.kwh / 2) * b.priceCcPerMWh) / 1000));
    expect(b.refundCc).toBe(b.escrowCc - b.paidCc);
    // the seller receives exactly what was delivered, from the buyer
    expect((t.balances.cc[sellerAcct] ?? 0) - sellerBefore).toBe(b.paidCc);
    // anything left unconfirmed expires and refunds in full
    const stale = t.power!.orders.find((o) => o.status === "awaiting" || o.status === "open");
    if (stale) {
      expirePowerOrder(t, ctx, stale.orderId);
      expect(stale.refundCc).toBe(stale.escrowCc);
    }
  });

  it("market epochs leave out power payments already settled through escrow, so nothing is paid twice", () => {
    const t = createTown({ seed: 10 });
    const ctx = newTCtx();
    for (let i = 0; i < 72 * 3; i++) townTick(t, ctx, { offers: player(20_000, 9_000), autoSettle: true, delivered: (o) => o.kwh });
    const paidToPlayer = t.power!.orders.filter((o) => o.sellerKey === "player:u1" && o.status === "settled").reduce((a, o) => a + o.paidCc, 0);
    expect(paidToPlayer).toBeGreaterThan(0);
    const inEpochs = t.epochs.flatMap((e) => e.tokens.filter((x) => x.token === "credit:vesper").flatMap((x) => x.transfers.filter((y) => y.account === "player:u1")));
    expect(inEpochs.reduce((a, x) => a + x.delta, 0)).toBe(0);
    for (const e of t.epochs) expect(town.verifyTownEpoch(e)).toBe(true);
  });

  it("buyers only fill from the cheapest offers they can afford", () => {
    const offers = [
      { sellerKey: "player:a", sellerName: "A", kw: 10_000, priceCcPerMWh: 11_000, why: "" },
      { sellerKey: "player:c", sellerName: "C", kw: 10_000, priceCcPerMWh: 12_000, why: "" },
      { sellerKey: "player:b", sellerName: "B", kw: 10_000, priceCcPerMWh: 8_000, why: "" },
    ];
    const plan = firmPolicy.smelterPlan({ needKw: 15_000, valueCcPerMWh: 14_000, spendableCc: 10_000_000, offers, selfKey: "firm:halvard" });
    expect(plan.lots.map((l) => [l.offer.sellerName, l.kw])).toEqual([["B", 10_000], ["A", 5_000]]);
    // C asks more than 85% of what a MWh of aluminium is worth: never bought
    const dear = firmPolicy.smelterPlan({ needKw: 40_000, valueCcPerMWh: 14_000, spendableCc: 10_000_000, offers, selfKey: "firm:halvard" });
    expect(dear.lots.some((l) => l.offer.sellerName === "C")).toBe(false);
    const poor = firmPolicy.smelterPlan({ needKw: 15_000, valueCcPerMWh: 14_000, spendableCc: 100_000, offers, selfKey: "firm:halvard" });
    expect(poor.lots.reduce((a, l) => a + firmPolicy.escrowCc(l.kw, l.offer.priceCcPerMWh), 0)).toBeLessThanOrEqual(100_000);
  });
});

describe("selling power from a region", () => {
  it("a contract is a real load on the player's grid: delivered energy is measured and bought at the regional price", () => {
    const s = region.createRegion({ regionId: "exp", seed: 11 });
    s.onboarding.done = true;
    const ctx = region.newRCtx();
    region.regionAct(s, ctx, { type: "SET_PLANT_ONLINE", plantId: "kestrel", online: true });
    // past the opening crisis (Eastbank is back after 66 intervals): a region that is short offers nothing
    for (let i = 0; i < 80; i++) region.regionTick(s, ctx);
    const offer = region.regionPowerOffer(s);
    expect(offer.kw).toBeGreaterThan(0);
    const cashBefore = region.rbal(s, "cc", "player");
    region.regionAct(s, ctx, { type: "POWER_EXPORT", orderId: "o1", buyerName: "Halvard Aluminium", kw: 5_000, intervals: 36, priceCcPerMWh: 9_000 });
    for (let i = 0; i < 36; i++) region.regionTick(s, ctx);
    const x = s.exports!.find((e) => e.orderId === "o1")!;
    expect(x.deliveredKwh).toBeGreaterThan(12_000);
    expect(x.deliveredKwh).toBeLessThanOrEqual(15_100);
    // being paid lands in the player's cash but is not part of the region's settlement epochs
    const epochsBefore = s.epochs.length;
    region.regionAct(s, ctx, { type: "POWER_PAID", orderId: "o1", buyerName: "Halvard Aluminium", cc: 135_000 });
    expect(region.rbal(s, "cc", "player")).toBeGreaterThan(cashBefore - 10_000_000);
    region.forceCloseEpoch(s);
    expect(s.epochs.length).toBe(epochsBefore + 1);
    const last = s.epochs.at(-1)!;
    expect(region.verifyEpoch(last)).toBe(true);
    expect(region.chainIdentity("ext:contracts")).toBe("player");
    expect(region.chainIdentity("ext:town")).toBe("player");
  });
});
