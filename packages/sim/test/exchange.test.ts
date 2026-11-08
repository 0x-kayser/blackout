import { describe, expect, it } from "vitest";
import {
  EXCHANGE_TRADERS,
  XACC,
  createExchange,
  exchangeBook,
  exchangeInvariants,
  exchangeTick,
  expectedChainBalances,
  newExchangeCtx,
  placeAsk,
  playerExchangeView,
  quoteBuy,
  requestCancel,
  requestDeposit,
  requestRedeem,
  reserveBuy,
  reserveFill,
  setOilIndex,
  settleAllPending,
  settleChainOp,
  supplyCities,
  cityPricePremiumBps,
  xbal,
  type ExchangeCtx,
  type ExchangeState,
  type TraderParams,
} from "../src/exchange/index.ts";

const PLAYER = (id: string) => ({ kind: "player" as const, id });
const TRADER = (id: string) => ({ kind: "trader" as const, id });

function tick(s: ExchangeState, n = 1): ExchangeCtx {
  const ctx = newExchangeCtx();
  for (let i = 0; i < n; i++) {
    exchangeTick(s, ctx);
    expect(exchangeInvariants(s)).toEqual([]);
  }
  return ctx;
}

function confirmAll(s: ExchangeState): ExchangeCtx {
  const ctx = newExchangeCtx();
  settleAllPending(s, ctx, "confirmed");
  expect(exchangeInvariants(s)).toEqual([]);
  return ctx;
}

function deposit(s: ExchangeState, playerId: string, ml: number, id = `dep-${playerId}-${s.seq}-${ml}`) {
  const ctx = newExchangeCtx();
  requestDeposit(s, ctx, { playerId, quantityMl: ml, depositId: id });
  settleChainOp(s, ctx, { op: "deposit", opId: id }, "confirmed", "hash");
  return ctx;
}

const cityEffects = (ctx: ExchangeCtx) => ctx.effects.filter((e) => e.kind === "city");

describe("Vesper Fuel Exchange: setup and traders", () => {
  it("starts balanced, and traders put asks on the book from their own stock", () => {
    const s = createExchange();
    expect(exchangeInvariants(s)).toEqual([]);
    const ctx = tick(s);
    const asks = ctx.effects.filter((e) => e.kind === "chain" && e.op === "ask");
    expect(asks).toHaveLength(EXCHANGE_TRADERS.length);
    // asks are not tradeable until the chain confirms the escrow
    expect(exchangeBook(s).asks).toHaveLength(0);
    confirmAll(s);
    const book = exchangeBook(s);
    expect(book.asks.length).toBeGreaterThan(0);
    // traders never ask below import cost plus their minimum margin
    for (const t of book.traders) expect(t.askCcPerL!).toBeGreaterThan(book.replacementCcPerL);
    // every trader explains itself from its real inputs
    for (const t of book.traders) expect(t.explanation).toMatch(/Import cost 10\.00\/L\. Stock /);
  });

  it("a trader buys a cheap player ask with its own budget and the seller is paid in their city", () => {
    const s = createExchange();
    tick(s);
    confirmAll(s);
    deposit(s, "alice", 20_000);
    expect(xbal(s, "fuel_ml", XACC.warehouse("alice"))).toBe(20_000);
    const ctx = newExchangeCtx();
    placeAsk(s, ctx, { owner: PLAYER("alice"), quantityMl: 20_000, unitPriceCcPerL: 950, orderId: "alice-ask-1" });
    confirmAll(s);
    const kettleCashBefore = xbal(s, "credits_cc", XACC.trader("kettle"));
    const t = tick(s);
    const fill = t.events.find((e) => e.type === "FILL_RESERVED");
    expect(fill?.actors).toContain("trader:kettle");
    expect(xbal(s, "credits_cc", XACC.trader("kettle"))).toBe(kettleCashBefore - 19_000);
    const settled = confirmAll(s);
    expect(cityEffects(settled)).toEqual([{ kind: "city", op: "credit", effectId: expect.stringMatching(/^credit:kettle:fill:/), playerId: "alice", amountCc: 19_000, fillId: expect.any(String) }]);
    expect(s.orders["alice-ask-1"].status).toBe("filled");
    expect(xbal(s, "fuel_ml", XACC.warehouse("alice"))).toBe(0);
    expect(s.traders.kettle.boughtTodayMl).toBe(20_000);
  });

  it("asks above every trader's bid stay open; traders never pay more than they could import for", () => {
    const s = createExchange();
    tick(s);
    confirmAll(s);
    deposit(s, "alice", 10_000);
    placeAsk(s, newExchangeCtx(), { owner: PLAYER("alice"), quantityMl: 10_000, unitPriceCcPerL: 1_000, orderId: "alice-dear" });
    confirmAll(s);
    const t = tick(s, 5);
    expect(t.events.some((e) => e.type === "FILL_RESERVED" && e.data.orderId === "alice-dear")).toBe(false);
    for (const tr of exchangeBook(s).traders) if (tr.bidCcPerL !== null) expect(tr.bidCcPerL).toBeLessThan(exchangeBook(s).replacementCcPerL);
  });

  it("an oil shock reprices trader asks upward through cancel and re-place", () => {
    const s = createExchange();
    tick(s);
    confirmAll(s);
    const before = exchangeBook(s).traders.map((t) => t.askCcPerL!);
    setOilIndex(s, newExchangeCtx(), 15_000);
    const t1 = tick(s);
    expect(t1.effects.filter((e) => e.kind === "chain" && e.op === "cancel").length).toBeGreaterThanOrEqual(3);
    confirmAll(s);
    tick(s);
    confirmAll(s);
    const after = exchangeBook(s).traders.map((t) => t.askCcPerL!);
    after.forEach((p, i) => expect(p).toBeGreaterThan(before[i]));
    expect(exchangeBook(s).bestAskCcPerL!).toBeGreaterThan(1_500);
  });
});

describe("Vesper Fuel Exchange: player trading", () => {
  const solo = () => createExchange({ traders: [] });

  it("player-to-player: the buyer walks the cheapest asks, pays from a reserved city balance, and both cities settle once", () => {
    const s = solo();
    deposit(s, "alice", 30_000);
    deposit(s, "carol", 30_000);
    placeAsk(s, newExchangeCtx(), { owner: PLAYER("alice"), quantityMl: 20_000, unitPriceCcPerL: 1_200, orderId: "a1" });
    placeAsk(s, newExchangeCtx(), { owner: PLAYER("carol"), quantityMl: 10_000, unitPriceCcPerL: 1_100, orderId: "c1" });
    confirmAll(s);
    const q = quoteBuy(s, "bob", 25_000);
    expect(q.legs.map((l) => [l.orderId, l.quantityMl])).toEqual([["c1", 10_000], ["a1", 15_000]]);
    expect(q.totalCc).toBe(11_000 + 18_000);
    const r = newExchangeCtx();
    reserveBuy(s, r, { playerId: "bob", quantityMl: 25_000, maxPriceCcPerL: null, buyId: "bob-buy-1" });
    expect(s.orders.a1.reservedMl).toBe(15_000);
    // reserved fuel cannot be sold to anyone else
    expect(quoteBuy(s, "dave", 10_000).quantityMl).toBe(5_000);
    const done = confirmAll(s);
    const effects = cityEffects(done).map((e) => [e.op, e.playerId, "amountCc" in e ? e.amountCc : 0]).sort();
    expect(effects).toEqual([["capture_payment", "bob", 11_000], ["capture_payment", "bob", 18_000], ["credit", "alice", 18_000], ["credit", "carol", 11_000]].sort());
    expect(xbal(s, "fuel_ml", XACC.warehouse("bob"))).toBe(25_000);
    expect(s.orders.c1.status).toBe("filled");
    expect(s.orders.a1.status).toBe("open");
    // settling again is rejected; nothing is paid twice
    expect(() => settleChainOp(s, newExchangeCtx(), { op: "fill", opId: "bob-buy-1:0" }, "confirmed")).toThrow(/settled/);
  });

  it("a failed transfer puts the fuel back on the order and releases the buyer's reservation", () => {
    const s = solo();
    deposit(s, "alice", 10_000);
    placeAsk(s, newExchangeCtx(), { owner: PLAYER("alice"), quantityMl: 10_000, unitPriceCcPerL: 1_000, orderId: "a1" });
    confirmAll(s);
    reserveBuy(s, newExchangeCtx(), { playerId: "bob", quantityMl: 4_000, maxPriceCcPerL: 1_000, buyId: "b1" });
    const ctx = newExchangeCtx();
    settleChainOp(s, ctx, { op: "fill", opId: "b1:0" }, "failed", null, "TX_FAILED");
    expect(exchangeInvariants(s)).toEqual([]);
    expect(cityEffects(ctx)).toEqual([{ kind: "city", op: "release_payment", effectId: "release:b1:0", playerId: "bob", amountCc: 4_000, fillId: "b1:0" }]);
    expect(s.orders.a1.reservedMl).toBe(0);
    expect(quoteBuy(s, "bob", 10_000).quantityMl).toBe(10_000);
  });

  it("guards ids, prices, ownership and in-flight orders", () => {
    const s = solo();
    deposit(s, "alice", 10_000, "dep-1");
    expect(() => deposit(s, "alice", 1_000, "dep-1")).toThrow(/already been used/);
    expect(() => deposit(s, "alice", 150, "dep-odd")).toThrow(/100 mL/);
    // price band: 0.5x .. 3x import cost (10.00/L)
    expect(() => placeAsk(s, newExchangeCtx(), { owner: PLAYER("alice"), quantityMl: 1_000, unitPriceCcPerL: 499, orderId: "cheap" })).toThrow(/between 5.00 and 30.00/);
    expect(() => placeAsk(s, newExchangeCtx(), { owner: PLAYER("alice"), quantityMl: 1_000, unitPriceCcPerL: 3_001, orderId: "dear" })).toThrow(/between 5.00 and 30.00/);
    expect(() => placeAsk(s, newExchangeCtx(), { owner: PLAYER("alice"), quantityMl: 20_000, unitPriceCcPerL: 1_000, orderId: "too-much" })).toThrow(/needs 20000/);
    placeAsk(s, newExchangeCtx(), { owner: PLAYER("alice"), quantityMl: 5_000, unitPriceCcPerL: 1_000, orderId: "a1" });
    // not on the book until escrow confirms
    expect(quoteBuy(s, "bob", 1_000).quantityMl).toBe(0);
    expect(() => requestCancel(s, newExchangeCtx(), "a1", "owner", PLAYER("alice"))).toThrow(/placing/);
    confirmAll(s);
    expect(() => requestCancel(s, newExchangeCtx(), "a1", "owner", PLAYER("bob"))).toThrow(/someone else/);
    expect(() => reserveFill(s, newExchangeCtx(), { orderId: "a1", buyer: PLAYER("alice"), quantityMl: 1_000, fillId: "self" })).toThrow(/your own order/);
    expect(() => reserveFill(s, newExchangeCtx(), { orderId: "a1", buyer: PLAYER("bob"), quantityMl: 6_000, fillId: "over" })).toThrow(/Only 5.0 L/);
    reserveFill(s, newExchangeCtx(), { orderId: "a1", buyer: PLAYER("bob"), quantityMl: 1_000, fillId: "f1" });
    expect(() => reserveFill(s, newExchangeCtx(), { orderId: "a1", buyer: PLAYER("carol"), quantityMl: 1_000, fillId: "f1" })).toThrow(/already been used/);
    expect(() => requestCancel(s, newExchangeCtx(), "a1", "owner", PLAYER("alice"))).toThrow(/settling/);
    confirmAll(s);
    const c = newExchangeCtx();
    requestCancel(s, c, "a1", "owner", PLAYER("alice"));
    confirmAll(s);
    expect(s.orders.a1.status).toBe("cancelled");
    expect(xbal(s, "fuel_ml", XACC.warehouse("alice"))).toBe(9_000);
  });

  it("caps deposits per day and refunds a failed deposit to the city", () => {
    const s = solo();
    deposit(s, "alice", 50_000);
    expect(() => deposit(s, "alice", 20_000)).toThrow(/10.0 L left today/);
    const ctx = newExchangeCtx();
    requestDeposit(s, ctx, { playerId: "alice", quantityMl: 10_000, depositId: "d-fail" });
    settleChainOp(s, ctx, { op: "deposit", opId: "d-fail" }, "failed", null, "RPC down");
    expect(cityEffects(ctx)).toEqual([{ kind: "city", op: "refund_fuel", effectId: "refund:d-fail", playerId: "alice", amountMl: 10_000, depositId: "d-fail" }]);
    expect(playerExchangeView(s, "alice").depositLeftTodayMl).toBe(10_000);
    // a new day resets the cap
    tick(s, s.config.ticksPerDay);
    expect(playerExchangeView(s, "alice").depositLeftTodayMl).toBe(60_000);
  });

  it("redeems burn warehouse fuel and deliver it to the city only after confirmation", () => {
    const s = solo();
    deposit(s, "alice", 10_000);
    const ctx = newExchangeCtx();
    requestRedeem(s, ctx, { playerId: "alice", quantityMl: 4_000, redeemId: "r1" });
    expect(playerExchangeView(s, "alice")).toMatchObject({ warehouseMl: 6_000, pendingRedeemMl: 4_000 });
    expect(expectedChainBalances(s).players.alice).toBe(10_000); // not burned on-chain yet
    const done = confirmAll(s);
    expect(cityEffects(done)).toEqual([{ kind: "city", op: "deliver_fuel", effectId: "deliver:r1", playerId: "alice", amountMl: 4_000, redeemId: "r1" }]);
    expect(expectedChainBalances(s).players.alice).toBe(6_000);
    requestRedeem(s, newExchangeCtx(), { playerId: "alice", quantityMl: 6_000, redeemId: "r2" });
    settleChainOp(s, newExchangeCtx(), { op: "redeem", opId: "r2" }, "failed");
    expect(playerExchangeView(s, "alice").warehouseMl).toBe(6_000);
  });

  it("expires stale player asks and charges a daily storage fee on warehouse fuel", () => {
    const s = createExchange({ traders: [], config: { playerAskLifetimeTicks: 10 } });
    deposit(s, "alice", 20_000);
    placeAsk(s, newExchangeCtx(), { owner: PLAYER("alice"), quantityMl: 10_000, unitPriceCcPerL: 2_000, orderId: "a1" });
    confirmAll(s);
    const t = tick(s, 10);
    expect(t.events.find((e) => e.type === "CANCEL_REQUESTED")?.data.reason).toBe("expired");
    confirmAll(s);
    expect(xbal(s, "fuel_ml", XACC.warehouse("alice"))).toBe(20_000);
    const day = tick(s, s.config.ticksPerDay - 10);
    // 20 L x 10.00/L import cost x 1% = 2.00 credits
    expect(cityEffects(day)).toEqual([{ kind: "city", op: "charge_fee", effectId: "fee:alice:1", playerId: "alice", amountCc: 200, day: 1 }]);
  });
});

describe("Vesper Fuel Exchange: an economy that runs itself", () => {
  const tiny: TraderParams = {
    ...EXCHANGE_TRADERS[2],
    traderId: "tiny",
    name: "Tiny Fuel",
    startStockMl: 30_000,
    startCashCc: 30_500,
    operatingReserveCc: 30_000,
    reserveFloorMl: 5_000,
    reorderPointBps: 9_000,
  };

  it("a cash-strapped trader stops restocking and buying, and recovers when players buy its stock", () => {
    const s = createExchange({ traders: [tiny] });
    const first = tick(s);
    expect(s.traders.tiny.status).toBe("cash_strapped");
    expect(first.events.some((e) => e.type === "TRADER_IMPORT_ORDERED")).toBe(false);
    expect(s.traders.tiny.decision!.bidCcPerL).toBeNull();
    expect(s.traders.tiny.decision!.explanation).toMatch(/Not buying: only 5\.00 credits above its 300\.00 reserve/);
    confirmAll(s);
    // a player buys most of its stock; the sale rebuilds its cash
    reserveBuy(s, newExchangeCtx(), { playerId: "bob", quantityMl: 25_000, maxPriceCcPerL: null, buyId: "bob-1" });
    confirmAll(s);
    const after = tick(s);
    expect(s.traders.tiny.status).toBe("short");
    expect(after.events.some((e) => e.type === "TRADER_IMPORT_ORDERED")).toBe(true);
    // the import arrives after its lead time and the trader sells again
    tick(s, tiny.leadTimeTicks);
    confirmAll(s);
    tick(s);
    confirmAll(s);
    expect(s.traders.tiny.status).not.toBe("short");
    expect(s.traders.tiny.decision!.reasons.stockMl).toBeGreaterThan(tiny.reserveFloorMl);
    expect(exchangeBook(s).asks.reduce((a, l) => a + l.quantityMl, 0)).toBeGreaterThan(0);
    expect(s.traders.tiny.decision!.bidCcPerL).not.toBeNull();
  });

  it("rations: a trader at its reserve floor takes its ask off the book", () => {
    const s = createExchange({ traders: [{ ...tiny, startStockMl: 5_000, startCashCc: 5_000_000 }] });
    const ctx = tick(s);
    expect(s.traders.tiny.status).toBe("short");
    expect(ctx.effects.some((e) => e.kind === "chain" && e.op === "ask")).toBe(false);
    expect(s.traders.tiny.decision!.explanation).toMatch(/Not selling: stock is at its 5\.0 L reserve/);
  });

  function week(seed: number) {
    const s = createExchange();
    const log: string[] = [];
    const players = ["alice", "bob", "carol"];
    for (let t = 0; t < s.config.ticksPerDay * 7; t++) {
      // the oil index follows a fixed shock-and-recover path
      const oil = 10_000 + Math.round(4_000 * Math.sin((t + seed) / 40));
      setOilIndex(s, newExchangeCtx(), Math.max(6_000, oil));
      const ctx = tick(s);
      const p = players[t % players.length];
      if (t % 7 === 0 && playerExchangeView(s, p).depositLeftTodayMl >= 5_000) deposit(s, p, 5_000, `dep-${p}-${t}`);
      if (t % 11 === 0 && xbal(s, "fuel_ml", XACC.warehouse(p)) >= 5_000) {
        placeAsk(s, newExchangeCtx(), { owner: PLAYER(p), quantityMl: 5_000, unitPriceCcPerL: Math.round(exchangeBook(s).replacementCcPerL * 0.95), orderId: `ask-${p}-${t}` });
      }
      if (t % 13 === 0 && quoteBuy(s, p, 3_000).quantityMl === 3_000) reserveBuy(s, newExchangeCtx(), { playerId: p, quantityMl: 3_000, maxPriceCcPerL: null, buyId: `buy-${p}-${t}` });
      const settled = confirmAll(s);
      for (const e of [...ctx.events, ...settled.events]) log.push(`${e.tick}:${e.type}:${e.explanation}`);
      const chain = expectedChainBalances(s);
      const tracked = Object.values(chain.players).reduce((a, v) => a + v, 0) + Object.values(chain.traders).reduce((a, v) => a + v, 0) + chain.escrowMl;
      expect(chain.supplyMl).toBe(tracked);
    }
    return { s, log };
  }

  it("runs a week with players and traders: balanced throughout, prices move, and the run is deterministic", () => {
    const a = week(1);
    const b = week(1);
    expect(JSON.stringify(a.s)).toBe(JSON.stringify(b.s));
    expect(a.log).toEqual(b.log);
    expect(a.s.history).toHaveLength(7);
    const asks = a.s.history.map((d) => d.bestAskCcPerL).filter((x): x is number => x !== null);
    expect(new Set(asks).size).toBeGreaterThan(3);
    expect(a.s.history.reduce((acc, d) => acc + d.volumeMl, 0)).toBeGreaterThan(0);
    const kinds = new Set(a.log.map((l) => l.split(":")[1]));
    for (const k of ["FILL_SETTLED", "TRADER_IMPORT_ORDERED", "TRADER_IMPORT_ARRIVED", "STORAGE_FEE", "DAY_CLOSED", "ORDER_CANCELLED"]) expect(kinds).toContain(k);
    expect(JSON.stringify(week(2).s)).not.toBe(JSON.stringify(a.s));
  });
});

describe("Vesper Fuel Exchange: trader wallets supply every town", () => {
  it("town merchants restock from the cheapest traders, draining their wallets and raising the premium every town pays", () => {
    const s = createExchange();
    tick(s);
    confirmAll(s);
    const premium0 = cityPricePremiumBps(s);
    const stock0 = Object.values(s.traders).reduce((a, t) => a + xbal(s, "fuel_ml", XACC.trader(t.traderId)), 0);
    const ctx = newExchangeCtx();
    // fuel already on the board (open offers) is never double-sold to towns; 100 L is within spare stock
    const r = supplyCities(s, ctx, { quantityMl: 100_000, refId: "city-a:restock-1" });
    expect(r.suppliedMl).toBe(100_000);
    expect(ctx.effects.filter((e) => e.kind === "chain" && e.op === "supply").length).toBeGreaterThan(0);
    const settled = confirmAll(s);
    expect(settled.events.some((e) => e.type === "CITY_SUPPLIED")).toBe(true);
    const stock1 = Object.values(s.traders).reduce((a, t) => a + xbal(s, "fuel_ml", XACC.trader(t.traderId)), 0);
    expect(stock1).toBe(stock0 - 100_000);
    // drained traders reorder imports: fuel on order shows up in their next decisions
    tick(s);
    expect(Object.values(s.traders).some((t) => t.pendingImportId !== null)).toBe(true);
    // the premium every town pays tracks the traders' cheapest ask against normal import cost
    expect(typeof premium0).toBe("number");
    const rc = exchangeBook(s).replacementCcPerL;
    for (const t of Object.values(s.traders)) t.decision = { ...t.decision!, askCcPerL: Math.round(rc * 1.3) };
    expect(cityPricePremiumBps(s)).toBe(Math.round(((Math.round(rc * 1.3) - Math.round(rc * 1.05)) * 10_000) / rc));
    for (const t of Object.values(s.traders)) t.decision = { ...t.decision!, askCcPerL: null };
    expect(cityPricePremiumBps(s)).toBe(5_000); // nobody selling = full squeeze
    // a demand bigger than every trader's spare stock is only partly met; reserves are never sold
    const big = supplyCities(s, newExchangeCtx(), { quantityMl: 5_000_000, refId: "city-b:restock-1" });
    expect(big.suppliedMl).toBeLessThan(5_000_000);
    confirmAll(s);
    for (const t of Object.values(s.traders)) expect(xbal(s, "fuel_ml", XACC.trader(t.traderId))).toBeGreaterThanOrEqual(0);
    expect(exchangeInvariants(s)).toEqual([]);
  });
});

