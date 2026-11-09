import { describe, expect, it } from "vitest";
import { clearMarket, type ClearingInput } from "../../src/region/market.ts";

const base = (over: Partial<ClearingInput> = {}): ClearingInput => ({
  nodes: ["a", "b"],
  corridors: [{ corridorId: "ab", from: "a", to: "b", limitMW: 100 }],
  offers: [],
  bids: [],
  priceCapPerMWh: 500_000,
  referenceNode: "a",
  ...over,
});
const offer = (plantId: string, nodeId: string, mw: number, price: number, min = 0) => ({ plantId, nodeId, availableMW: mw, minimumMW: min, offerPricePerMWh: price, marginalCostPerMWh: price, rampMWPerInterval: mw });
const bid = (loadId: string, nodeId: string, mw: number, wtp: number, priorityClass: any = "commerce") => ({ loadId, nodeId, requestedMW: mw, willingnessToPayPerMWh: wtp, priorityClass: priorityClass === "commerce" ? "commercial" : priorityClass });

describe("merit-order clearing", () => {
  it("dispatches cheapest first and the marginal unit sets one uniform price when uncongested", () => {
    const r = clearMarket(base({ offers: [offer("cheap", "a", 50, 3000), offer("mid", "a", 50, 6000), offer("dear", "b", 50, 20000)], bids: [bid("l", "b", 80, 100000)] }));
    expect(r.dispatchMW).toEqual({ cheap: 50, mid: 30, dear: 0 });
    expect(r.priceByNode).toEqual({ a: 6000, b: 6000 });
    expect(r.marginalByNode.b).toEqual({ kind: "plant", id: "mid" });
    expect(r.flowMW.ab).toBe(80);
    expect(r.congested).toEqual([]);
  });

  it("congestion splits prices: the import node pays its local marginal unit", () => {
    const r = clearMarket(base({ corridors: [{ corridorId: "ab", from: "a", to: "b", limitMW: 40 }], offers: [offer("cheap", "a", 200, 3000), offer("dear", "b", 100, 20000)], bids: [bid("la", "a", 10, 100000), bid("lb", "b", 90, 100000)] }));
    expect(r.flowMW.ab).toBe(40);
    expect(r.congested).toEqual(["ab"]);
    expect(r.dispatchMW).toEqual({ cheap: 50, dear: 50 });
    expect(r.priceByNode.a).toBe(3000);
    expect(r.priceByNode.b).toBe(20000);
  });

  it("flexible demand steps back before anyone is shed; then shortage prices at the marginal load's value", () => {
    const r = clearMarket(base({ offers: [offer("g", "a", 100, 5000)], bids: [bid("hh", "b", 70, 250000, "residential"), bid("steel", "b", 60, 45000, "flexible")] }));
    expect(r.servedMW).toEqual({ hh: 70, steel: 30 });
    expect(r.priceByNode.b).toBe(45000); // the steel mill's bid sets the price
    expect(r.curtailedMW.b).toBe(30);
    expect(r.shedMW.b).toBe(0);
    const short = clearMarket(base({ offers: [offer("g", "a", 50, 5000)], bids: [bid("hosp", "b", 20, 2_000_000, "critical"), bid("hh", "b", 70, 250000, "residential")] }));
    expect(short.servedMW).toEqual({ hosp: 20, hh: 30 });
    expect(short.shedMW.b).toBe(40);
    expect(short.priceByNode.b).toBe(250000);
    expect(short.marginalByNode.b).toEqual({ kind: "load", id: "hh" });
  });

  it("price hits the cap when nothing can reach a node", () => {
    const r = clearMarket(base({ corridors: [{ corridorId: "ab", from: "a", to: "b", limitMW: 0 }], offers: [offer("g", "a", 100, 5000)], bids: [bid("lb", "b", 10, 900000, "critical")] }));
    expect(r.priceByNode.b).toBe(500000);
    expect(r.marginalByNode.b.kind).toBe("cap");
    expect(r.shedMW.b).toBe(10);
  });

  it("must-run minimum blocks clear at zero and are always dispatched first", () => {
    const r = clearMarket(base({ offers: [offer("ccgt", "a", 100, 4000, 40), offer("solar", "a", 100, 0)], bids: [bid("l", "a", 90, 100000)] }));
    expect(r.dispatchMW.ccgt).toBeGreaterThanOrEqual(40);
    expect(r.dispatchMW.ccgt + r.dispatchMW.solar).toBe(90);
    expect(r.priceByNode.a).toBe(0);
  });

  it("is deterministic and conserves energy at every node", () => {
    const inp = base({
      nodes: ["a", "b", "c"],
      corridors: [{ corridorId: "ab", from: "a", to: "b", limitMW: 60 }, { corridorId: "bc", from: "b", to: "c", limitMW: 25 }],
      offers: [offer("x", "a", 120, 3500), offer("y", "b", 40, 9000), offer("z", "c", 30, 30000)],
      bids: [bid("la", "a", 20, 200000), bid("lb", "b", 70, 200000), bid("lc", "c", 50, 200000), bid("fc", "c", 20, 40000, "flexible")],
    });
    const r1 = clearMarket(inp);
    expect(clearMarket(inp)).toEqual(r1);
    const net = (n: string) =>
      inp.offers.filter((o) => o.nodeId === n).reduce((s, o) => s + r1.dispatchMW[o.plantId], 0) -
      inp.bids.filter((b) => b.nodeId === n).reduce((s, b) => s + r1.servedMW[b.loadId], 0);
    expect(net("a")).toBeCloseTo(r1.flowMW.ab, 6);
    expect(net("b")).toBeCloseTo(r1.flowMW.bc - r1.flowMW.ab, 6);
    expect(net("c")).toBeCloseTo(-r1.flowMW.bc, 6);
    expect(r1.priceByNode.c).toBeGreaterThan(r1.priceByNode.a);
  });
});
